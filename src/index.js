const express = require('express');
const path = require('path');
const { auditRequest, getBudgetStatus, getBlockedLog, resetBudgets, setBudget } = require('./governor');

const app = express();
const PORT = process.env.PORT || 4020;

app.use(express.json({ limit: '50mb' }));

// ── Static files ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Root → Dashboard ────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ── Health check ────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── Dashboard API ───────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
    res.json(getBudgetStatus());
});

// ── Blocked requests log ────────────────────────────────
app.get('/api/blocked', (req, res) => {
    res.json(getBlockedLog());
});

// ── Reset budgets ───────────────────────────────────────
app.post('/api/reset', (req, res) => {
    resetBudgets();
    res.json({ status: 'ok', message: 'All budgets reset' });
});

// ── Set budget for an API key ───────────────────────────
app.post('/api/budget', (req, res) => {
    const { apiKey, maxDollars, maxTokens, maxRequestsPerHour, alertThreshold } = req.body;

    if (!apiKey) {
        return res.status(400).json({ error: { message: 'apiKey is required', type: 'validation_error' } });
    }

    setBudget(apiKey, {
        maxDollars: maxDollars || 50,
        maxTokens: maxTokens || 10_000_000,
        maxRequestsPerHour: maxRequestsPerHour || 100,
        alertThreshold: alertThreshold || 0.8,
    });

    res.json({ status: 'ok', message: `Budget set for key ...${apiKey.slice(-8)}` });
});

// ── Proxy endpoint — intercept and audit ────────────────
app.all('/v1/*path', async (req, res) => {
    const apiKey = req.headers['authorization']?.replace('Bearer ', '')
        || req.headers['x-api-key']
        || 'unknown';

    const audit = auditRequest(apiKey, req.body);

    if (audit.blocked) {
        console.log(`[CFO] 🚫 BLOCKED: ${audit.reason} (key: ...${apiKey.slice(-8)})`);
        return res.status(429).json({
            error: {
                message: `Agentic CFO blocked this request: ${audit.reason}`,
                type: 'budget_exceeded',
                details: audit,
            },
        });
    }

    if (audit.warning) {
        console.log(`[CFO] ⚠️  WARNING: ${audit.warning} (key: ...${apiKey.slice(-8)})`);
        // Let it through but add a warning header
        res.setHeader('X-CFO-Warning', audit.warning);
    }

    console.log(`[CFO] ✅ ALLOWED: $${audit.estimatedCost.toFixed(4)} (${audit.necessityScore}/10 necessity) — key: ...${apiKey.slice(-8)}`);

    // Forward to the actual API (simplified — in production, pipe through)
    const https = require('https');
    const targetHost = req.headers['x-api-key'] ? 'api.anthropic.com' : 'api.openai.com';

    const options = {
        hostname: targetHost,
        port: 443,
        path: req.path,
        method: req.method,
        headers: { ...req.headers, host: targetHost },
    };

    delete options.headers['connection'];
    const payload = JSON.stringify(req.body);
    options.headers['content-length'] = Buffer.byteLength(payload);

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
    });

    proxyReq.setTimeout(30 * 60 * 1000);
    proxyReq.write(payload);
    proxyReq.end();
});

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║  💰 Agentic CFO — Running on port ${PORT}               ║
║  Budget governance for every AI agent API call        ║
║  Dashboard: http://localhost:${PORT}                      ║
╚═══════════════════════════════════════════════════════╝
  `);
});

