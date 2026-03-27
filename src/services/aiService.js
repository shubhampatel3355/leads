/**
 * AI Service — production intent analysis via OpenAI.
 *
 * Flow: GPT-4o (primary) → GPT-4o-mini (fallback) → conservative defaults.
 * All calls go directly to OpenAI.
 *
 * Features:
 *   • 30-second timeout via AbortController
 *   • Token usage logging
 *   • Required-field validation on AI output
 *   • Automatic GPT-4o-mini fallback on GPT-4o failure
 *   • Robust JSON extraction (direct, code-fence, brace-match)
 */

const OpenAI = require('openai');
const env = require('../config/env');
const logger = require('../utils/logger');
const { SYSTEM_PROMPT, buildIntentPrompt, buildTranscriptPrompt } = require('../prompts/intentAnalysis');

// ─── OpenAI Client (singleton) ────────────────────────────────
let openaiClient = null;

function getClient() {
    if (!openaiClient) {
        if (!env.openai.apiKey) {
            throw new Error('OPENAI_API_KEY is not configured');
        }
        openaiClient = new OpenAI({
            apiKey: env.openai.apiKey,
        });
        logger.info('[ai] OpenAI client initialized');
    }
    return openaiClient;
}

// ─── Required Fields ──────────────────────────────────────────────
const REQUIRED_FIELDS = [
    'intent_score',
    'timeline_score',
    'budget_score',
    'authority_score',
    'pain_score',
    'total_score',
    'classification',
    'recommended_next_step',
    'summary',
];

const VALID_VALUES = {
    classification: ['hot', 'warm', 'cold'],
};

// ─── Core API Call ────────────────────────────────────────────────

/**
 * Call a model via OpenAI with timeout.
 * @param {string} model   – OpenAI model identifier
 * @param {string} prompt  – user prompt content
 * @param {number} timeoutMs – timeout in milliseconds (default 30s)
 * @returns {{ text: string, usage: object, model: string }}
 */
async function callModel(model, prompt, timeoutMs = 30000) {
    const client = getClient();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await client.chat.completions.create(
            {
                model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 1024,
                temperature: 0.1,  // Low temperature for consistent structured output
            },
            { signal: controller.signal }
        );

        const text = response.choices?.[0]?.message?.content || '';
        const usage = response.usage || {};

        logger.info(
            '[ai] API response — model: ' + (response.model || model) +
            ', input_tokens: ' + (usage.prompt_tokens || '?') +
            ', output_tokens: ' + (usage.completion_tokens || '?') +
            ', total_tokens: ' + (usage.total_tokens || '?')
        );

        return { text, usage, model: response.model || model };
    } finally {
        clearTimeout(timer);
    }
}

// ─── JSON Parsing ─────────────────────────────────────────────────

/**
 * Parse AI response safely — extract JSON from potentially wrapped text.
 */
function parseAIResponse(text) {
    // 1. Direct parse
    try {
        return JSON.parse(text);
    } catch { /* continue */ }

    // 2. Extract from markdown code fence
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }

    // 3. Extract first { ... } block
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
    }

    return null; // Could not parse
}

// ─── Field Validation ─────────────────────────────────────────────

/**
 * Validate that the parsed JSON has all required fields with valid enum values.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAnalysis(analysis) {
    if (!analysis || typeof analysis !== 'object') {
        return { valid: false, errors: ['Response is not an object'] };
    }

    const errors = [];

    for (const field of REQUIRED_FIELDS) {
        if (!(field in analysis)) {
            errors.push('Missing field: ' + field);
        }
    }

    for (const [field, allowed] of Object.entries(VALID_VALUES)) {
        if (analysis[field] && !allowed.includes(analysis[field])) {
            errors.push('Invalid value for ' + field + ': ' + analysis[field] + ' (allowed: ' + allowed.join(', ') + ')');
        }
    }

    return { valid: errors.length === 0, errors };
}

// ─── Conservative Default ─────────────────────────────────────────

function getDefaultAnalysis() {
    return {
        intent_score: 0,
        timeline_score: 0,
        budget_score: 0,
        authority_score: 0,
        pain_score: 0,
        total_score: 0,
        classification: 'cold',
        recommended_next_step: 'Manual review required — AI analysis was inconclusive.',
        summary: 'AI analysis was unable to determine intent. Manual review recommended.',
        _fallback: true,
    };
}

// ─── Main Entry Points ───────────────────────────────────────────

/**
 * Analyze conversation messages for intent.
 * Pipeline: GPT-4o → (retry) → GPT-4o-mini → default.
 */
async function analyzeIntent(lead, messages) {
    const prompt = buildIntentPrompt(lead, messages);
    return runAnalysisPipeline(prompt, lead.id);
}

/**
 * Analyze a voice call transcript for intent.
 */
async function analyzeTranscript(lead, transcript) {
    const prompt = buildTranscriptPrompt(lead, transcript);
    return runAnalysisPipeline(prompt, lead.id);
}

/**
 * Run the full analysis pipeline with retry + fallback.
 * 1. Call GPT-4o (primary) — up to 2 attempts
 * 2. Call GPT-4o-mini (fallback) — 1 attempt
 * 3. Return conservative defaults if everything fails
 */
async function runAnalysisPipeline(prompt, leadId) {
    const primaryModel = env.openai.primaryModel;
    const fallbackModel = env.openai.fallbackModel;

    // ── Attempt 1: GPT-4o (primary) ──────────────────────
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            logger.info('[ai] Attempt ' + attempt + '/2 with ' + primaryModel + ' for lead ' + leadId);
            const { text } = await callModel(primaryModel, prompt);

            const parsed = parseAIResponse(text);
            const { valid, errors } = validateAnalysis(parsed);

            if (valid) {
                parsed._model = primaryModel;
                parsed._attempt = attempt;
                return parsed;
            }

            logger.warn('[ai] Validation failed on attempt ' + attempt + ': ' + errors.join('; '));

            // On first failed validation, retry — the model might self-correct
            if (attempt < 2) {
                await sleep(1000);
            }
        } catch (err) {
            const errMsg = err.name === 'AbortError' ? 'Timeout (30s)' : err.message;
            logger.error('[ai] Attempt ' + attempt + '/2 with ' + primaryModel + ' failed: ' + errMsg);

            if (attempt < 2) {
                await sleep(Math.pow(2, attempt) * 1000);
            }
        }
    }

    // ── Attempt 3: GPT-4o-mini (fallback) ────────────────
    try {
        logger.warn('[ai] Primary model failed. Falling back to ' + fallbackModel + ' for lead ' + leadId);
        const { text } = await callModel(fallbackModel, prompt);

        const parsed = parseAIResponse(text);
        const { valid, errors } = validateAnalysis(parsed);

        if (valid) {
            parsed._model = fallbackModel;
            parsed._fallback_used = true;
            return parsed;
        }

        logger.error('[ai] Fallback model also returned invalid JSON: ' + errors.join('; '));
    } catch (err) {
        logger.error('[ai] Fallback model ' + fallbackModel + ' failed: ' + err.message);
    }

    // ── All failed — return safe defaults ────────────────
    logger.error('[ai] All AI attempts exhausted for lead ' + leadId + ', returning defaults');
    return getDefaultAnalysis();
}

// ─── Helpers ──────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    analyzeIntent,
    analyzeTranscript,
    parseAIResponse,
    validateAnalysis,
    getDefaultAnalysis,
    callModel,
};
