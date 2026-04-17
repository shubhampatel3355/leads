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

    // Standard OmniDimension payload properties
    const call_id = req.body.call_id || req.body.id;
    const status = req.body.call_status || req.body.status || 'completed';
    const phone_number = req.body.to_number || req.body.phone_number; // The lead's phone
    
    // OmniDimension nests details in call_report
    const call_report = req.body.call_report || {};
    const transcriptText = call_report.full_conversation || req.body.transcript || '';
    
    // Formatting
    const concatenated_transcript = transcriptText;
    const transcript = [{ role: 'system', content: transcriptText }];
    
    const recording_url = req.body.recording_url || call_report.recording_url || req.body.recording;
    const call_length = req.body.call_duration || req.body.call_length || req.body.duration || call_report.duration;
    const summary = call_report.summary || req.body.summary || req.body.call_summary;

    if (!call_id) {
        logger.warn('[voice:webhook] Received webhook without a valid call_id.');
        return res.status(400).json({ error: 'call_id is required' });
    }

    // 1. Try to find the lead by Call ID first
    let leadId = await voiceService.getLeadIdForCall(call_id);
    let matchMethod = 'ID';

    // 2. FALLBACK: If not found by ID, try looking up by phone number
    if (!leadId && phone_number) {
        logger.info(`[voice:webhook] Match NOT found by ID (${call_id}). Searching by phone: ${phone_number}...`);
        leadId = await voiceService.getLeadIdByPhone(phone_number);
        
        if (leadId) {
            matchMethod = 'Phone';
            logger.info(`[voice:webhook] Found lead ${leadId} by phone number fallback. Repairing record...`);
            // Repair the record so future lookups by ID work
            await voiceService.createCallRecord(leadId, call_id);
        }
    }

    if (leadId) {
        logger.info(`[voice:webhook] Processing transcript for lead ${leadId} (Matched by: ${matchMethod})`);

        // Check if already processed
        const alreadyProcessed = await voiceService.isCallProcessed(call_id);
        if (alreadyProcessed) {
            logger.info(`[voice:webhook] Call ${call_id} already processed, skipping.`);
            return res.json({ message: 'Already processed', call_id });
        }

        // Store transcript and update call status
        await voiceService.storeTranscript(call_id, transcript, concatenated_transcript);

        // Update/Store conversation history
        try {
            await voiceService.updateCallConversationWithTranscript(call_id, {
                body: concatenated_transcript,
                recording_url,
                call_length
            });
        } catch (err) {
            // Fallback: if no initiation record existed in conversations, store a new one
            await voiceService.storeCallConversation(leadId, call_id, 'completed', {
                body: concatenated_transcript,
                recording_url,
                call_length
            });
        }

        // Queue transcript analysis job
        await enqueue('transcript-analysis', {
            lead_id: leadId,
            call_id,
            transcript: concatenated_transcript,
        });
    } else {
        logger.warn(`[voice:webhook] Could not associate call ${call_id} with any lead by ID or phone (${phone_number}).`);
    }

    res.json({ message: 'Transcript received', call_id });
});

module.exports = { initiateCall, callEndedWebhook };
