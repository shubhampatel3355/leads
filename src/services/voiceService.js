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

    // Prepare override payload
    // task and first_sentence MUST be at the top level to override dashboard settings
    const payload = {
        agent_id: parseInt(env.omniDimension.agentId, 10) || env.omniDimension.agentId,
        phone_number: lead.phone,
        webhook_url: env.omniDimension.webhookUrl,
        task: task || '', 
        first_sentence: firstSentence || '',
        ...(env.omniDimension.fromNumberId && { from_number_id: parseInt(env.omniDimension.fromNumberId, 10) || env.omniDimension.fromNumberId }),
        call_context: {
            lead_id: lead.id,
            name: lead.name,
            company: lead.company,
        }
    };

    if (!payload.task) {
        logger.warn(`[voice] No dynamic task provided for lead ${lead.id}. OmniDimension will use default dashboard settings.`);
    }

    logger.info(`[voice] Dispatching call via OmniDimension to lead ${lead.id} (${lead.phone})`);
    
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
        
        // Handle OmniDimension's potentially varied response structure
        const returnedCallId = data.call_id || data.id || data.callLogId || data.dispatch_id || (data.data && (data.data.id || data.data.call_id));
        
        // CRITICAL DEBUG: Log the full data to see what we are getting
        logger.info(`[voice:DEBUG] Full response from OmniDimension dispatch:`, JSON.stringify(data));

        if (!returnedCallId) {
            logger.error(`[voice:initiate] OmniDimension responded successfully but no call_id was found in payload. SEE DEBUG LOG ABOVE.`);
            throw new Error('Failed to retrieve call_id from OmniDimension response');
        }

        logger.info(`OmniDimension AI call initiated for lead ${lead.id}, ID: ${returnedCallId}`);

        // Store call record
        const { error: insertErr } = await supabase.from('calls').insert({
            lead_id: lead.id,
            external_call_id: String(returnedCallId), // Ensure it's a string for DB
            status: 'initiated',
            created_at: new Date().toISOString(),
        });

        if (insertErr) {
            logger.error(`[voice:initiate] Failed to insert initial call record for ${returnedCallId}:`, insertErr.message);
            // We still return the call_id as the call was actually placed
        }

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
 * Find internal lead ID by normalized phone number.
 */
async function getLeadIdByPhone(phone) {
    const { getLeadByPhone } = require('./leadService');
    const lead = await getLeadByPhone(phone);
    return lead?.id || null;
}

/**
 * Manually create a call record (used by webhook fallback).
 */
async function createCallRecord(leadId, callId) {
    const { error } = await supabase.from('calls').insert({
        lead_id: leadId,
        external_call_id: String(callId),
        status: 'initiated',
        created_at: new Date().toISOString(),
    });
    
    if (error) {
        logger.error(`[voice:service] Failed to create fallback call record:`, error.message);
    }
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

module.exports = { initiateCall, storeTranscript, isCallProcessed, getLeadIdForCall, hasExistingCall, storeCallConversation, updateCallConversationWithTranscript, getLeadIdByPhone, createCallRecord };
