/**
 * Budget Governor — The Auditing Engine
 *
 * Every API call gets scored for:
 * 1. Necessity (is this call actually needed?)
 * 2. Budget compliance (is the user over their limit?)
 * 3. Rate compliance (too many calls per hour?)
 */

const budgets = new Map();  // apiKey → budget config
const usage = new Map();    // apiKey → usage tracking
const blockedLog = [];      // Recent blocked requests (capped at 100)
const MAX_BLOCKED_LOG = 100;

const MODEL_COSTS = {
    'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
    'claude-3-5-haiku': { input: 0.25, output: 1.25 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

const DEFAULT_BUDGET = {
    maxDollars: 50,
    maxTokens: 10_000_000,
    maxRequestsPerHour: 200,
    alertThreshold: 0.8, // 80% = warning
};

function setBudget(apiKey, config) {
    budgets.set(keyHash(apiKey), { ...DEFAULT_BUDGET, ...config });
}

function auditRequest(apiKey, body) {
    const hash = keyHash(apiKey);
    const budget = budgets.get(hash) || DEFAULT_BUDGET;
    let track = usage.get(hash);

    if (!track) {
        track = { totalDollars: 0, totalTokens: 0, requests: [], startedAt: Date.now() };
        usage.set(hash, track);
    }

    // Estimate cost
    const model = body?.model || 'gpt-4o';
    const costs = MODEL_COSTS[model] || MODEL_COSTS['gpt-4o'];
    const estimatedInputTokens = Math.ceil(JSON.stringify(body?.messages || body || '').length / 4);
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 0.3); // Assume 30% output ratio
    const estimatedCost = (estimatedInputTokens * costs.input / 1_000_000)
        + (estimatedOutputTokens * costs.output / 1_000_000);

    // Score necessity (0-10)
    const necessityScore = scoreNecessity(body, track);

    // Check budget limits
    const projectedTotal = track.totalDollars + estimatedCost;

    // Rate limit check
    const recentRequests = track.requests.filter(t => Date.now() - t < 3600_000);
    track.requests = recentRequests; // Clean old entries

    const result = {
        estimatedCost,
        estimatedTokens: estimatedInputTokens + estimatedOutputTokens,
        necessityScore,
        projectedTotal,
        budgetRemaining: budget.maxDollars - projectedTotal,
        requestsThisHour: recentRequests.length,
        blocked: false,
        warning: null,
        reason: null,
    };

    // Block if over budget
    if (projectedTotal > budget.maxDollars) {
        result.blocked = true;
        result.reason = `Budget exceeded: $${projectedTotal.toFixed(2)} > $${budget.maxDollars} limit`;
        logBlocked(hash, result);
        return result;
    }

    // Block if rate limit exceeded
    if (recentRequests.length >= budget.maxRequestsPerHour) {
        result.blocked = true;
        result.reason = `Rate limit: ${recentRequests.length} requests this hour (max: ${budget.maxRequestsPerHour})`;
        logBlocked(hash, result);
        return result;
    }

    // Block if necessity score is critically low (likely a waste loop)
    if (necessityScore <= 1 && track.requests.length > 10) {
        result.blocked = true;
        result.reason = `Low necessity score (${necessityScore}/10) — likely a waste loop`;
        logBlocked(hash, result);
        return result;
    }

    // Warn if approaching threshold
    if (projectedTotal > budget.maxDollars * budget.alertThreshold) {
        result.warning = `Approaching budget: $${projectedTotal.toFixed(2)} / $${budget.maxDollars} (${Math.round(projectedTotal / budget.maxDollars * 100)}%)`;
    }

    // Record usage
    track.totalDollars += estimatedCost;
    track.totalTokens += estimatedInputTokens + estimatedOutputTokens;
    track.requests.push(Date.now());

    return result;
}

function logBlocked(agentHash, result) {
    blockedLog.unshift({
        timestamp: new Date().toISOString(),
        agent: agentHash,
        reason: result.reason,
        estimatedCost: result.estimatedCost,
        necessityScore: result.necessityScore,
    });
    if (blockedLog.length > MAX_BLOCKED_LOG) blockedLog.length = MAX_BLOCKED_LOG;
}

/**
 * Score how "necessary" this API call is (0-10).
 * Low scores indicate wasteful calls.
 */
function scoreNecessity(body, track) {
    let score = 7; // Default: probably necessary

    const content = JSON.stringify(body?.messages || body || '');

    // Penalize very short messages (likely ping/status checks on expensive models)
    if (content.length < 200) score -= 2;

    // Penalize if this looks identical to recent requests
    if (track._lastPayloadHash === simpleHash(content)) {
        score -= 4; // Exact duplicate
    }
    track._lastPayloadHash = simpleHash(content);

    // Penalize high-frequency calls (more than 1 per second)
    const lastRequest = track.requests[track.requests.length - 1];
    if (lastRequest && Date.now() - lastRequest < 1000) {
        score -= 2;
    }

    // Bonus for tool-use calls (usually productive)
    if (content.includes('tool_use') || content.includes('function_call')) {
        score += 1;
    }

    return Math.max(0, Math.min(10, score));
}

function getBudgetStatus() {
    const status = {};
    for (const [hash, track] of usage.entries()) {
        const budget = budgets.get(hash) || DEFAULT_BUDGET;
        const recentRequests = track.requests.filter(t => Date.now() - t < 3600_000);
        status[hash] = {
            spent: track.totalDollars,
            budget: budget.maxDollars,
            remaining: budget.maxDollars - track.totalDollars,
            percentUsed: Math.round((track.totalDollars / budget.maxDollars) * 100),
            totalTokens: track.totalTokens,
            totalRequests: track.requests.length,
            maxTokens: budget.maxTokens,
            maxRequestsPerHour: budget.maxRequestsPerHour,
            requestsThisHour: recentRequests.length,
            alertThreshold: budget.alertThreshold,
        };
    }
    return { agents: status, updatedAt: new Date().toISOString() };
}

function getBlockedLog() {
    return blockedLog;
}

function resetBudgets() {
    usage.clear();
    blockedLog.length = 0;
}

function keyHash(key) {
    return key ? key.slice(-8) : 'unknown';
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < Math.min(str.length, 500); i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(36);
}

module.exports = { auditRequest, setBudget, getBudgetStatus, getBlockedLog, resetBudgets };
