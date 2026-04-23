const env = require('../config/env');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Normalize phone numbers to ensure consistent lookups.
 * Removes non-numeric characters and ensures a leading '+' if missing.
 */
function normalizePhone(phone) {
    if (!phone) return null;
    // Remove all non-numeric characters
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) return null;
    // OmniDimension and most VoIP providers require leading + for international dialling
    return `+${digits}`;
}

/**
 * Initiate a voice call via OmniDimension AI.
 */
async function initiateCall(lead, { task, voice = 'maya', firstSentence, campaignId } = {}) {
    if (!lead.phone) {
        throw Object.assign(new Error('Lead has no phone number'), { status: 400 });
    }

    if (!env.omniDimension.agentId) {
        throw new Error('OmniDimension Agent ID is not configured (OMNIDIMENSION_AGENT_ID)');
    }

    // Prepare override payload via call_context variables
    // IMPORTANT: Dashboard must have placeholders like [welcome_message] and [custom_script]
    const formattedPhone = normalizePhone(lead.phone);
    
    // Prepare override payload via call_context variables
    const payload = {
        agent_id: parseInt(env.omniDimension.agentId, 10) || env.omniDimension.agentId,
        to_number: formattedPhone, 
        phone_number: formattedPhone,
        webhook_url: env.omniDimension.webhookUrl,
        ...(env.omniDimension.fromNumberId && { from_number_id: parseInt(env.omniDimension.fromNumberId, 10) || env.omniDimension.fromNumberId }),
        call_context: {
            lead_id: lead.id,
            name: lead.name,
            company: lead.company,
            welcome_message: firstSentence || '', 
            custom_script: task || '',
        }
    };

    if (!payload.call_context.custom_script) {
        logger.warn(`[voice] No dynamic task provided for lead ${lead.id}. AI will fall back to static dashboard instructions.`);
    }

    logger.info(`[voice] Dispatching call for lead ${lead.id} to: ${formattedPhone}`);
    logger.debug(`[voice:payload] SENDING:`, JSON.stringify({ ...payload, to_number: '***' })); // Redacting phone in debug if needed, but logging structure
    
    try {
        const response = await fetch('https://backend.omnidim.io/api/v1/calls/dispatch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.omniDimension.apiKey}`,
            },
            body: JSON.stringify(payload),
        }).catch(err => {
            // Native fetch error (network level)
            const isFetchError = err.message?.toLowerCase().includes('fetch failed');
            logger.error(`[voice:network_error] Failed to reach OmniDimension API: ${err.message}${isFetchError ? ' (Likely DNS or Network issue)' : ''}`);
            throw new Error(`Connection to OmniDimension failed: ${err.message}`);
        });

        if (!response.ok) {
            const errBody = await response.text();
            logger.error(`[voice:error] OmniDimension API rejected call (Status: ${response.status}):`, errBody);
            throw new Error(`OmniDimension AI call failed (${response.status}): ${errBody}`);
        }

        const data = await response.json().catch(() => ({}));
        
        // Handle OmniDimension's potentially varied response structure
        const returnedCallId = data.call_id || data.id || data.callLogId || data.dispatch_id || data.requestId ||
                             (data.data && (data.data.id || data.data.call_id || data.data.dispatch_id || data.data.requestId));
        
        if (!returnedCallId) {
            logger.error(`[voice:initiate] OmniDimension responded successfully but no call_id was found. Response:`, JSON.stringify(data));
            throw new Error('Failed to retrieve call_id from OmniDimension response');
        }

        logger.info(`OmniDimension AI call initiated for lead ${lead.id}, External ID: ${returnedCallId}`);

        // Store call record
        const { error: insertErr } = await supabase.from('calls').insert({
            lead_id: lead.id,
            external_call_id: String(returnedCallId),
            campaign_id: campaignId || lead.campaign_id || null, 
            status: 'initiated',
            created_at: new Date().toISOString(),
        });

        if (insertErr) {
            logger.error(`[voice:initiate] Failed to insert initial call record for ${returnedCallId}:`, insertErr.message);
        }

        return { call_id: returnedCallId, status: data.status || 'initiated', campaign_id: campaignId || lead.campaign_id };
    } catch (err) {
        logger.error(`Voice call failed for lead ${lead.id}:`, err.message);
        throw err;
    }
}

/**
 * Store a call transcript from webhook.
 */
async function storeTranscript(callId, transcript, concatenatedTranscript, status = 'completed') {
    const { error } = await supabase
        .from('calls')
        .update({
            transcript: transcript,
            concatenated_transcript: concatenatedTranscript,
            status: status,
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
 * Get the lead_id and campaign_id for a call.
 */
async function getLeadIdForCall(callId) {
    const { data } = await supabase
        .from('calls')
        .select('lead_id, campaign_id')
        .eq('external_call_id', callId)
        .single();

    return { lead_id: data?.lead_id || null, campaign_id: data?.campaign_id || null };
}

/**
 * Find internal lead ID by normalized phone number.
 */
async function getLeadIdByPhone(phone) {
    if (!phone) return null;
    const { getLeadByPhone } = require('./leadService');
    
    // 1. Try exact match
    let lead = await getLeadByPhone(phone);
    if (lead) return lead.id;

    // 2. Try normalized numeric match (strip +, spaces, etc.)
    const cleaned = normalizePhone(phone);
    const { data: leads } = await supabase
        .from('leads')
        .select('id, phone');
    
    // Search for a match ignoring non-numeric chars
    const match = leads?.find(l => normalizePhone(l.phone) === cleaned);
    return match?.id || null;
}

/**
 * Manually create a call record (used by webhook fallback).
 */
async function createCallRecord(leadId, callId, campaignId = null) {
    const { error } = await supabase.from('calls').insert({
        lead_id: leadId,
        external_call_id: String(callId),
        campaign_id: campaignId,
        status: 'initiated',
        created_at: new Date().toISOString(),
    });
    
    if (error) {
        logger.error(`[voice:service] Failed to create fallback call record:`, error.message);
    }
}

/**
 * Check if a call already exists for a lead (duplicate prevention).
 * Optionally scope to a specific campaign to allow multiple campaigns to call the same lead.
 */
async function hasExistingCall(leadId, campaignId = null) {
    let query = supabase
        .from('calls')
        .select('id')
        .eq('lead_id', leadId);

    if (campaignId) {
        query = query.eq('campaign_id', campaignId);
    }

    const { data } = await query.limit(1);

    return data && data.length > 0;
}

/**
 * Store a conversation entry for an AI call event.
 */
async function storeCallConversation(leadId, callId, status, extra = {}, campaignId = null) {
    const record = {
        lead_id: leadId,
        campaign_id: campaignId,
        direction: 'outbound',
        channel: 'call',
        body: extra.body || 'Outbound AI voice call initiated.',
        external_id: String(callId), // Force string for DB matching
        status,
        metadata: {
            call_id: String(callId),
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
 */
async function updateCallConversationWithTranscript(callId, extra = {}, status = 'completed') {
    const updateData = {
        body: extra.body || null,
        status: status,
        metadata: {
            call_id: callId,
            status: status,
            ...(extra.recording_url ? { recording_url: extra.recording_url } : {}),
            ...(extra.call_length ? { call_length: extra.call_length } : {}),
            completed_at: new Date().toISOString(),
        },
    };

    const { data, error } = await supabase
        .from('conversations')
        .update(updateData)
        .eq('external_id', String(callId)) // Force string for lookup
        .eq('channel', 'call')
        .select('id')
        .single();

    if (error) {
        logger.warn(`[voice] Failed to update call conversation for ${callId}: ${error.message}`);
        return null;
    }

    logger.info(`[voice] Updated call conversation ${data.id} with transcript for call ${callId}`);
    return data;
}

/**
 * Recover the most recent outbound call campaign ID for a lead
 * Useful when the call ID changes between initiation and the webhook
 */
async function getLatestCampaignIdForLead(leadId) {
    if (!leadId) return null;
    const { data } = await supabase
        .from('conversations')
        .select('campaign_id')
        .eq('lead_id', leadId)
        .eq('direction', 'outbound')
        .eq('channel', 'call')
        .not('campaign_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data?.campaign_id || null;
}

module.exports = { initiateCall, storeTranscript, isCallProcessed, getLeadIdForCall, hasExistingCall, storeCallConversation, updateCallConversationWithTranscript, getLeadIdByPhone, createCallRecord, getLatestCampaignIdForLead };
