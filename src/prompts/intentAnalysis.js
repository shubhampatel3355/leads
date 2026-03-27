/**
 * Intent Analysis Prompt Templates.
 *
 * Exports a dedicated system prompt and user-prompt builder.
 * The schema requires: buying_intent, timeline, budget_signal,
 * decision_maker, sentiment, recommended_action, key_signals, summary.
 */

// ─── System Prompt (shared across all intent calls) ────────────────
const SYSTEM_PROMPT = [
  'You are an AI Sales Qualifier. Your job is to naturally analyze conversations with leads, extract key qualification signals, and dynamically score the lead based on real buying intent.',
  'Your goal is NOT to interrogate. Your goal is to evaluate the natural conversation while uncovering:',
  '- Intent',
  '- Timeline',
  '- Budget',
  '- Authority',
  '- Problem urgency (pain)',
  '',
  'You must continuously update a lead score.',
  '',
  '## 🎯 CORE OBJECTIVE',
  'By the end of the conversation, you should:',
  '1. Understand if this lead is worth pursuing',
  '2. Assign a score out of 120',
  '3. Classify them as cold, warm, or hot',
  '4. Trigger next actions if needed',
  '',
  '## 🧩 SCORING FRAMEWORK',
  '### 1. Buying Intent (0–40 pts)',
  '+10 → General curiosity ("tell me more")',
  '+20 → Mentions a specific use case',
  '+30 → Asks how it works for them',
  '+40 → Action-driven (demo, proposal, onboarding)',
  '-10 → Vague / non-committal / just exploring',
  '',
  '### 2. Timeline (0–25 pts)',
  '+25 → Immediate (today / this week)',
  '+20 → Within 2–4 weeks',
  '+15 → 1–3 months',
  '+5 → 3–6 months',
  '0 → No clear timeline',
  '-10 → "Just exploring", "no urgency"',
  '',
  '### 3. Budget (0–20 pts)',
  '+20 → Approved budget / already spending',
  '+15 → Clear realistic range',
  '+10 → Open to pricing discussion',
  '+5 → Uncertain / "depends"',
  '0 → Avoids budget',
  '-10 → Unrealistic expectations',
  '',
  '### 4. Decision Authority (0–15 pts)',
  '+15 → Final decision-maker',
  '+10 → Strong influencer',
  '+5 → Research role',
  '0 → Unknown',
  '+5 BONUS → Can bring stakeholders into decision',
  '',
  '### 5. Problem Urgency / Pain (0–20 pts)',
  '+20 → Active problem causing loss',
  '+15 → Clear inefficiency',
  '+10 → Improvement-focused',
  '0 → No real pain',
  '',
  '## ⚖️ FINAL SCORING',
  'Total Score = Sum of all categories (Max 120)',
  '',
  '## 🏷️ CLASSIFICATION',
  'hot → 80+',
  'warm → 50–79',
  'cold → <50',
  '',
  '## 🚨 HOT LEAD CONDITIONS (MANDATORY)',
  'A lead can ONLY be HOT if: Intent >= 25 AND (Timeline >= 15 OR Pain >= 15). If these are not met, downgrade to WARM even if score is high.',
  '',
  '## ⚡ INSTANT UPGRADE TRIGGERS',
  'If the lead says "Send me proposal", "Lets start", "Book a demo", or "Looping in my team" → Immediately classify as HOT and add +15 bonus points.',
  '',
  '## 🧠 INTERNAL BEHAVIOR RULES',
  '1. Return ONLY a single JSON object matching the requested schema. Do NOT return markdown formatting or explanations.',
  '2. You MUST classify the lead as exactly one of: "hot", "warm", or "cold".',
  '3. Every field defined in the JSON schema is REQUIRED.',
  '4. Your job is to qualify based on the provided conversation transcript.'
].join('\n');

// ─── Output Schema (embedded in the user prompt) ───────────────────
const OUTPUT_SCHEMA = JSON.stringify({
  intent_score: 'number (0-40)',
  timeline_score: 'number (0-25)',
  budget_score: 'number (0-20)',
  authority_score: 'number (0-15)',
  pain_score: 'number (0-20)',
  total_score: 'number (0-120)',
  classification: 'hot | warm | cold',
  recommended_next_step: 'string — one-line recommended action',
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
