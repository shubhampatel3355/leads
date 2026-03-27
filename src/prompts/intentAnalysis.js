/**
 * Intent Analysis Prompt Templates.
 *
 * Exports a dedicated system prompt and user-prompt builder.
 * The schema requires: buying_intent, timeline, budget_signal,
 * decision_maker, sentiment, recommended_action, key_signals, summary.
 */

// ─── System Prompt (shared across all intent calls) ────────────────
const SYSTEM_PROMPT = [
  'You are an expert B2B sales qualification AI.',
  'Your job is to analyse conversations between a sales agent and a prospect, then return a structured JSON assessment of the prospect\'s buying intent.',
  '',
  'Rules:',
  '1. Return ONLY a single JSON object — no markdown, no explanation, no code fences.',
  '2. Be conservative: if the signal is ambiguous, score it lower rather than higher.',
  '3. Every field listed in the output schema is REQUIRED. Do not omit any.',
  '4. Use ONLY the enum values specified for each field.',
].join('\n');

// ─── Output Schema (embedded in the user prompt) ───────────────────
const OUTPUT_SCHEMA = JSON.stringify({
  buying_intent: 'high | medium | low | none',
  timeline: 'immediate | 1-3_months | 3-6_months | no_timeline',
  budget_signal: 'strong | moderate | weak | none',
  decision_maker: 'yes | influencer | no | unknown',
  sentiment: 'positive | neutral | negative',
  recommended_action: 'string — one-line recommended next step',
  key_signals: ['signal1', 'signal2'],
  summary: 'string — brief summary of the prospect situation',
}, null, 2);

// ─── User Prompt Builder ───────────────────────────────────────────

/**
 * Build the user prompt for WhatsApp conversation analysis.
 * @param {object} lead        – lead record from DB
 * @param {object[]} messages  – conversation rows, ordered asc
 * @returns {string}
 */
function buildIntentPrompt(lead, messages) {
  const transcript = messages
    .map(m => {
      const role = m.direction === 'inbound' ? 'Inbound' : 'Outbound';
      return role + ': ' + m.body;
    })
    .join('\n');

  return [
    '## Business Context',
    'You are qualifying leads for a B2B SaaS company. The Ideal Customer Profile (ICP) is mid-to-senior decision-makers at companies actively evaluating software solutions.',
    '',
    '## Lead Information',
    '- Name: ' + (lead.name || 'Unknown'),
    '- Company: ' + (lead.company || 'Unknown'),
    '- Job Title: ' + (lead.job_title || 'Unknown'),
    '- Industry: ' + (lead.industry || 'Unknown'),
    '',
    '## Conversation Transcript',
    transcript || '(no messages yet)',
    '',
    '## Required Output',
    'Analyse the conversation above and return the following JSON. Use ONLY the specified enum values. Return the JSON object only, nothing else.',
    '',
    OUTPUT_SCHEMA,
  ].join('\n');
}

/**
 * Build the user prompt for voice-call transcripts.
 */
function buildTranscriptPrompt(lead, transcript) {
  return [
    '## Business Context',
    'You are qualifying leads for a B2B SaaS company.',
    '',
    '## Lead Information',
    '- Name: ' + (lead.name || 'Unknown'),
    '- Company: ' + (lead.company || 'Unknown'),
    '- Job Title: ' + (lead.job_title || 'Unknown'),
    '',
    '## Call Transcript',
    transcript,
    '',
    '## Required Output',
    'Analyse the transcript above and return the following JSON. Use ONLY the specified enum values. Return the JSON object only, nothing else.',
    '',
    OUTPUT_SCHEMA,
  ].join('\n');
}

module.exports = { SYSTEM_PROMPT, buildIntentPrompt, buildTranscriptPrompt };
