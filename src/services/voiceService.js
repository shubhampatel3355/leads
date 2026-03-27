const env = require('../config/env');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Initiate a voice call via Bland AI.
 */
async function initiateCall(lead, { task, voice = 'maya', firstSentence } = {}) {
    if (!lead.phone) {
        throw Object.assign(new Error('Lead has no phone number'), { status: 400 });
    }

    const payload = {
        phone_number: lead.phone,
        task: task || `You are calling ${lead.name} from ${lead.company || 'their company'}. Have a professional sales discovery conversation. Understand their needs, timeline, and budget.`,
        voice: voice,
        first_sentence: firstSentence || `Hi ${lead.name}, this is a quick call to follow up on our recent conversation. Do you have a moment?`,
        record: true,
        webhook: env.bland.webhookUrl,
        metadata: {
            lead_id: lead.id,
        },
    };

    try {
        const response = await fetch('https://api.bland.ai/v1/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': env.bland.apiKey,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Bland AI call failed (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        logger.info(`Bland AI call initiated for lead ${lead.id}, call_id: ${data.call_id}`);

        // Store call record
        await supabase.from('calls').insert({
            lead_id: lead.id,
            external_call_id: data.call_id,
            status: 'initiated',
            created_at: new Date().toISOString(),
        });

        return { call_id: data.call_id, status: data.status };
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
 * @param {string} callId - Bland AI call_id
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
