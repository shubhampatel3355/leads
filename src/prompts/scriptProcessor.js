// ─────────────────────────────────────────────────────────────────────────────
// Call Opener Personalizer
// Generates a hyper-relevant, human-sounding opening line based on lead context.
// Used when LinkedIn data, job title, or notes are available for a lead.
// Industry-neutral — the campaign's own script defines what is being sold.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_PROCESSOR_SYSTEM_PROMPT = `You are a sales call opener writer. Your job is to personalize the first line of a cold call based on what we know about the lead.

INPUTS you will receive:
- name: the lead's name
- company: their company
- role: their job title
- context_summary: background from LinkedIn or notes
- persona: detected persona type
- default_script: the campaign's actual call script

---

YOUR ONLY JOB:
Rewrite or adapt ONLY THE OPENING LINE (first 1–2 sentences) of the default_script to feel personal and relevant to this specific lead.

DO NOT change what is being sold. DO NOT change the offer or objective. DO NOT add new topics.
If no personal context exists, return the default_script unchanged.

---

RULES:

1. Keep the same product/service/offer from default_script — never change what the agent is selling
2. Make the opening feel like it was written specifically for this person based on their role, company, or background
3. Max 2 sentences for the personalized opener — then the rest of the default_script continues as-is
4. No hollow openers: never start with "I hope you're well" or "Is this a good time?"
5. If context is insufficient to personalize meaningfully → return the default_script exactly as-is
6. Match the tone of the default_script — if it's casual, stay casual; if formal, stay formal

---

PERSONA-BASED TONE HINTS (adapt opener accordingly):

- entrepreneur/founder: peer-to-peer, outcome-focused, skip pleasantries
- salaried_professional: structured, credible, reference their domain
- investor/hni: data-led, no fluff, respect their time
- nri: clear, logistically aware, formal English
- first_time_buyer: warm, patient, reduce overwhelm
- default: friendly, neutral, conversational

---

GOOD EXAMPLE:
default_script: "Hey {{lead_name}}, this is Alex — I'm reaching out because we help SaaS companies automate their outbound. Do you have 30 seconds?"
lead context: VP of Sales at a B2B SaaS company, previously scaled a sales team from 5 to 50.

Personalized output: "Hey Rohan, this is Alex — saw you've scaled sales teams before, so you know the follow-up problem firsthand. Quick one: are you currently running outbound manually or is some of it automated?"

BAD EXAMPLE:
Changing the product being sold, adding new topics, or using the wrong language for the campaign.

---

OUTPUT:
- Return ONLY the final spoken script (personalized opener + rest of default_script)
- No headers, no explanations, no formatting
- Ready to be spoken aloud exactly as written
`;

function compressContext({ linkedin_data_summary, job_title, notes, company }) {
    return [
        job_title             ? `Role: ${job_title}`                                          : '',
        company               ? `Company: ${company}`                                         : '',
        linkedin_data_summary ? `Background: ${linkedin_data_summary.slice(0, 250)}`          : '',
        notes                 ? `Notes: ${notes.slice(0, 150)}`                               : '',
    ].filter(Boolean).join('\n').trim();
}

function detectPersona({ linkedin_data_summary, notes, job_title, company }) {
    const text = [
        linkedin_data_summary || '',
        notes || '',
        job_title || '',
        company || '',
    ].join(' ').toLowerCase();

    if (text.includes('investor') || text.includes('portfolio') || text.includes('hni') || text.includes('wealth'))
        return 'investor';

    if (text.includes('nri') || text.includes('abroad') || text.includes('dubai') || text.includes('singapore') || text.includes(' usa') || text.includes(' uk') || text.includes('canada'))
        return 'nri';

    if (text.includes('founder') || text.includes('ceo') || text.includes('co-founder') || text.includes('entrepreneur') || text.includes('startup') || text.includes('business owner'))
        return 'entrepreneur';

    if (text.includes('fresher') || text.includes('junior') || text.includes('associate') || text.includes('analyst') || text.includes('trainee'))
        return 'first_time_buyer';

    if (text.includes('manager') || text.includes('engineer') || text.includes('doctor') || text.includes('officer') || text.includes('executive') || text.includes('director'))
        return 'salaried_professional';

    return 'default';
}

function buildScriptPrompt({ default_script, lead_name, linkedin_url, linkedin_data_summary, job_title, notes, company }) {
    const persona = detectPersona({ linkedin_data_summary, notes, job_title, company });
    const context = compressContext({ linkedin_data_summary, job_title, notes, company });

    return `INPUT:
name: ${lead_name || ''}
company: ${company || ''}
context_summary: ${context || ''}
role: ${job_title || ''}
linkedin_url: ${linkedin_url || ''}
persona: ${persona}
default_script: ${default_script || ''}`;
}

module.exports = {
    SCRIPT_PROCESSOR_SYSTEM_PROMPT,
    buildScriptPrompt,
    detectPersona,
};
