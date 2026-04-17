const env = require('../config/env');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Initiate a voice call via OmniDimension AI.
 */
async function initiateCall(lead, { task, voice = 'maya', firstSentence } = {}) {
    if (!lead.phone) {
        throw Object.assign(new Error('Lead has no phone number'), { status: 400 });
    }

    if (!env.omniDimension.agentId) {
        throw new Error('OmniDimension Agent ID is not configured (OMNIDIMENSION_AGENT_ID)');
    }

    const payload = {
        agent_id: parseInt(env.omniDimension.agentId, 10) || env.omniDimension.agentId,
        to_number: lead.phone,
        ...(env.omniDimension.fromNumberId && { from_number_id: parseInt(env.omniDimension.fromNumberId, 10) || env.omniDimension.fromNumberId }),
        call_context: {
            lead_id: lead.id,
            name: lead.name,
            company: lead.company,
            task: task || `You are a highly skilled sales development representative from Mavixy, a company that helps businesses grow through branding, website development, and performance marketing.

Your goal is to cold call business owners and decision-makers like ${lead.name} from ${lead.company || 'their company'} to understand their current digital presence and identify opportunities where Mavixy can help.

You must behave like a real human salesperson — not robotic. Speak naturally, confidently, and conversationally. Listen carefully to the user's responses and adapt your conversation accordingly.

Key Responsibilities:
- Start with a friendly introduction and ask if it's a good time to talk
- Ask open-ended questions to understand their business, current website, and marketing efforts
- Identify pain points such as lack of leads, poor website, low online visibility, or no marketing strategy
- Based on their responses, suggest relevant services (website development, branding, performance marketing, SEO, ads, etc.)
- Keep responses short, clear, and conversational (avoid long monologues)
- Handle objections naturally (e.g., "not interested", "already working with someone", "no budget")
- If the lead is interested, try to book a follow-up call or meeting

Conversation Style:
- Be polite, friendly, and slightly persuasive
- Sound like a real human thinking, not scripted
- Use simple English (avoid jargon unless needed)
- Ask follow-up questions based on what the customer says
- Do not interrupt the user — let them finish speaking

Important:
- Never sound like an AI
- Never read from a fixed script
- Adapt dynamically to each conversation
- Focus on understanding first, selling second

Goal:
Qualify the lead and move them toward a meeting/demo with Mavixy.`,
            first_sentence: firstSentence || `Hi ${lead.name}, this is Mavixy reaching out. Do you have a quick moment?`
        }
    };

    try {
        const response = await fetch('https://backend.omnidim.io/api/v1/calls/dispatch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.omniDimension.apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`OmniDimension AI call failed (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        // Assuming OmniDimension returns { call_id: '...' } or { id: '...' }
        const returnedCallId = data.call_id || data.id || data.callLogId;
        logger.info(`OmniDimension AI call initiated for lead ${lead.id}, call_id: ${returnedCallId}`);

        // Store call record
        await supabase.from('calls').insert({
            lead_id: lead.id,
            external_call_id: returnedCallId,
            status: 'initiated',
            created_at: new Date().toISOString(),
        });

        return { call_id: returnedCallId, status: data.status || 'initiated' };
    } catch (err) {
        logger.error(`Voice call failed for lead ${lead.id}:`, err.message);
        throw err;
    }
}

/**
 * Store a call transcript from webhook.
 */
async function storeTranscript(callId, transcript, concatenatedTranscript) {
    const { error } = await supabase
        .from('calls')
        .update({
            transcript: transcript,
            concatenated_transcript: concatenatedTranscript,
            status: 'completed',
            completed_at: new Date().toISOString(),
        })
        .eq('external_call_id', callId);

    if (error) {
        logger.error(`Failed to store transcript for call ${callId}:`, error.message);
        throw error;
    }

    logger.info(`Transcript stored for call ${callId}`);
}

/**
 * Check if a call has already been processed (idempotency).
 */
async function isCallProcessed(callId) {
    if (!callId) return false;

    const { data } = await supabase
        .from('calls')
        .select('id, status')
        .eq('external_call_id', callId)
        .limit(1);

    return data && data.length > 0 && data[0].status === 'completed';
}

/**
 * Get the lead_id for a call.
 */
async function getLeadIdForCall(callId) {
    const { data } = await supabase
        .from('calls')
        .select('lead_id')
        .eq('external_call_id', callId)
        .single();

    return data?.lead_id || null;
}

/**
 * Check if a call already exists for a lead (duplicate prevention).
 * Returns true if any call record (initiated or completed) exists.
 */
async function hasExistingCall(leadId) {
    const { data } = await supabase
        .from('calls')
        .select('id')
        .eq('lead_id', leadId)
        .limit(1);

    return data && data.length > 0;
}

/**
 * Store a conversation entry for an AI call event.
 * @param {string} leadId
 * @param {string} callId - OmniDimension call_id
 * @param {string} status - 'initiated' | 'completed'
 * @param {object} [extra] - Additional metadata (recording_url, call_length, transcript body)
 */
async function storeCallConversation(leadId, callId, status, extra = {}) {
    const record = {
        lead_id: leadId,
        direction: 'outbound',
        channel: 'call',
        body: extra.body || null,
        external_id: callId,
        status,
        metadata: {
            call_id: callId,
            status,
            ...(extra.recording_url ? { recording_url: extra.recording_url } : {}),
            ...(extra.call_length ? { call_length: extra.call_length } : {}),
            stored_at: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from('conversations')
        .insert(record)
        .select('id')
        .single();

    if (error) {
        logger.error(`[voice] Failed to store call conversation for ${callId}:`, error.message);
        throw error;
    }

    logger.info(`[voice] Stored call conversation ${data.id} for call ${callId} (status: ${status})`);
    return data;
}

/**
 * Update an existing call conversation entry with the completed transcript.
 * Finds the 'initiated' conversation by external_id (call_id) and updates it.
 */
async function updateCallConversationWithTranscript(callId, extra = {}) {
    const updateData = {
        body: extra.body || null,
        status: 'completed',
        metadata: {
            call_id: callId,
            status: 'completed',
            ...(extra.recording_url ? { recording_url: extra.recording_url } : {}),
            ...(extra.call_length ? { call_length: extra.call_length } : {}),
            completed_at: new Date().toISOString(),
        },
    };

    const { data, error } = await supabase
        .from('conversations')
        .update(updateData)
        .eq('external_id', callId)
        .eq('channel', 'call')
        .select('id')
        .single();

    if (error) {
        logger.warn(`[voice] Failed to update call conversation for ${callId}: ${error.message}`);
        // Fallback: the row might not exist, that's okay
        return null;
    }

    logger.info(`[voice] Updated call conversation ${data.id} with transcript for call ${callId}`);
    return data;
}

module.exports = { initiateCall, storeTranscript, isCallProcessed, getLeadIdForCall, hasExistingCall, storeCallConversation, updateCallConversationWithTranscript };
