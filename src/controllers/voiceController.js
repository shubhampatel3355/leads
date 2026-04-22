const voiceService = require('../services/voiceService');
const leadService = require('../services/leadService');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * POST /api/calls/initiate
 * Start an OmniDimension AI voice call for a lead.
 */
const initiateCall = asyncHandler(async (req, res) => {
    const { lead_id, task, voice, first_sentence } = req.body;

    if (!lead_id) {
        return res.status(400).json({ error: 'lead_id is required' });
    }

    const lead = await leadService.getLeadById(lead_id, req.user.id);

    const result = await voiceService.initiateCall(lead, {
        task,
        voice,
        firstSentence: first_sentence,
    });

    // Insert conversation timeline entry so webhook can attach the transcript later
    try {
        await voiceService.storeCallConversation(lead.id, result.call_id, 'initiated', {
            body: 'Outbound AI voice call initiated.',
        });
    } catch (err) {
        logger.warn(`[controller:calls] Failed to store call conversation: ${err.message}`);
    }

    res.json({
        message: 'Call initiated',
        lead_id: lead.id,
        call_id: result.call_id,
    });
});

/**
 * POST /webhook/call-ended
 * Receive call transcript from OmniDimension AI.
 */
const callEndedWebhook = asyncHandler(async (req, res) => {
    // Log the entire payload for debugging (Essential for local testing/fixing)
    logger.info(`[voice:webhook] Incoming OmniDimension payload:`, JSON.stringify(req.body));

    // 1. Extract Call ID (Very aggressive search)
    const call_id = req.body.call_id || 
                    req.body.id || 
                    req.body.requestId || 
                    req.body.dispatch_id || 
                    (req.body.data && (req.body.data.id || req.body.data.call_id || req.body.data.requestId)) ||
                    (req.body.call_report && (req.body.call_report.id || req.body.call_report.call_id)) ||
                    req.body.sid;

    // 2. Extract Status (Very aggressive search)
    const call_report = req.body.call_report || req.body.conversation_details || {};
    const rawStatus = String(
        req.body.call_status || 
        req.body.status || 
        call_report.status || 
        (req.body.data && req.body.data.status) || 
        'completed'
    ).toLowerCase();

    // 3. Extract Transcript
    const transcriptText = call_report.full_conversation || 
                           call_report.transcript || 
                           req.body.transcript || 
                           req.body.text || 
                           '';

    const phone_number = req.body.to_number || req.body.phone_number || req.body.customer_number || req.body.recipient; 
    
    // Map OmniDimension statuses to our internal set
    let internalStatus = 'completed';
    
    // Check for 'not_picked' indicators
    if (rawStatus.includes('no-answer') || 
        rawStatus.includes('no_answer') || 
        rawStatus.includes('busy') || 
        rawStatus.includes('canceled') || 
        rawStatus.includes('no answer')) {
        internalStatus = 'not_picked';
    } else if (rawStatus.includes('failed') || rawStatus.includes('error')) {
        internalStatus = 'failed';
    } else if (rawStatus.includes('completed') || rawStatus.includes('answered') || rawStatus.includes('success')) {
        internalStatus = 'completed';
    } else {
        // Fallback: If no transcript, it's likely not picked
        internalStatus = transcriptText ? 'completed' : 'not_picked';
    }

    logger.info(`[voice:webhook] ID: ${call_id}, Raw Status: ${rawStatus}, Internal: ${internalStatus}, Has Transcript: ${!!transcriptText}`);
    
    // Aggressive Sanitization
    let cleanTranscript = Array.isArray(transcriptText) 
        ? transcriptText.join('\n') 
        : String(transcriptText);

    // Remove leading/trailing brackets and quotes if they were stringified as a whole
    cleanTranscript = cleanTranscript.trim()
        .replace(/^\[['"]?/, '')    // Remove starting [' or [" or [
        .replace(/['"]?\]$/, '')    // Remove ending '] or "] or ]
        .replace(/\\n/g, '\n');     // Convert literal \n to real newlines

    const concatenated_transcript = cleanTranscript;
    const transcript = [{ role: 'system', content: cleanTranscript }];
    
    const recording_url = req.body.recording_url || call_report.recording_url || req.body.recording || req.body.audio_url || req.body.recording_link;
    const call_length = req.body.call_duration || req.body.call_length || req.body.duration || call_report.duration || call_report.call_duration;

    if (!call_id) {
        logger.warn('[voice:webhook] Received webhook without a valid call_id. Payload Keys:', Object.keys(req.body).join(', '));
        return res.status(400).json({ error: 'call_id is required' });
    }

    // 1. Try to find the lead by Call ID first (Exact match)
    let { lead_id: leadId, campaign_id: campaignId } = await voiceService.getLeadIdForCall(call_id);
    let matchMethod = 'ID';

    // 2. FALLBACK: If not found by ID, try looking up by phone number
    if (!leadId && phone_number) {
        logger.info(`[voice:webhook] Match NOT found by ID (${call_id}). Searching by phone: ${phone_number}...`);
        
        leadId = await voiceService.getLeadIdByPhone(phone_number);
        
        if (leadId) {
            matchMethod = 'Phone';
            logger.info(`[voice:webhook] Found lead ${leadId} by phone number fallback. Repairing record for ID: ${call_id}...`);
            const recentCampaignId = await voiceService.getLatestCampaignIdForLead(leadId);
            if (recentCampaignId) campaignId = recentCampaignId;
            await voiceService.createCallRecord(leadId, call_id, campaignId);
        }
    }

    if (leadId) {
        logger.info(`[voice:webhook] Processing status for lead ${leadId} (Matched by: ${matchMethod})`);

        // Check if already processed
        const alreadyProcessed = await voiceService.isCallProcessed(call_id);
        if (alreadyProcessed) {
            logger.info(`[voice:webhook] Call ${call_id} already processed, skipping.`);
            return res.json({ message: 'Already processed', call_id });
        }

        // Store transcript and update call status
        await voiceService.storeTranscript(call_id, transcript, concatenated_transcript, internalStatus);

        // Update/Store conversation history
        try {
            const updatedConvo = await voiceService.updateCallConversationWithTranscript(call_id, {
                body: concatenated_transcript || (internalStatus === 'not_picked' ? 'Call not picked up.' : ''),
                recording_url,
                call_length
            }, internalStatus);
            
            if (!updatedConvo) {
                logger.info(`[voice:webhook] Timeline update returned no result for ${call_id}. Attempting fallback creation...`);
                await voiceService.storeCallConversation(leadId, call_id, internalStatus, {
                    body: concatenated_transcript || (internalStatus === 'not_picked' ? 'Call not picked up.' : ''),
                    recording_url,
                    call_length
                }, campaignId);
            } else {
                logger.info(`[voice:webhook] Successfully updated conversation timeline for ${call_id}.`);
            }
        } catch (err) {
            logger.warn(`[voice:webhook] Timeline update failed, falling back to new record creation: ${err.message}`);
            await voiceService.storeCallConversation(leadId, call_id, internalStatus, {
                body: concatenated_transcript || (internalStatus === 'not_picked' ? 'Call not picked up.' : ''),
                recording_url,
                call_length
            }, campaignId);
        }

        // Queue transcript analysis job ONLY if we have content and it was completed
        if (concatenated_transcript && internalStatus === 'completed') {
            await enqueue('transcript-analysis', {
                lead_id: leadId,
                call_id,
                transcript: concatenated_transcript,
            });
        }
    }
 else {
        logger.warn(`[voice:webhook] Could not associate call ${call_id} with any lead by ID or phone (${phone_number}).`);
    }

    res.json({ message: 'Transcript received', call_id });
});

module.exports = { initiateCall, callEndedWebhook };
