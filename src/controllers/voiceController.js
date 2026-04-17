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
    // Log the entire payload for debugging (Essential for new integration)
    logger.info(`[voice:webhook] Incoming OmniDimension payload:`, JSON.stringify(req.body));

    // Standard OmniDimension payload properties (as per user's JSON example)
    const call_id = req.body.call_id || req.body.id;
    const status = req.body.call_status || req.body.status || 'completed';
    
    // OmniDimension nests details in call_report
    const call_report = req.body.call_report || {};
    const transcriptText = call_report.full_conversation || req.body.transcript || '';
    
    // Handle formatting (convert string to JSON-like array if needed for UI, or keep as string)
    const concatenated_transcript = transcriptText;
    const transcript = [{ role: 'system', content: transcriptText }]; // Wrap string for DB JSONB format
    
    const recording_url = req.body.recording_url || call_report.recording_url || req.body.recording;
    const call_length = req.body.call_duration || req.body.call_length || req.body.duration || call_report.duration;
    const summary = call_report.summary || req.body.summary || req.body.call_summary;

    logger.info(`OmniDimension Webhook processed — ID: ${call_id}, status: ${status}`);

    if (!call_id) {
        logger.warn('[voice:webhook] Received webhook without a valid call_id.');
        return res.status(400).json({ error: 'call_id is required' });
    }

    // Idempotency check
    const alreadyProcessed = await voiceService.isCallProcessed(call_id);
    if (alreadyProcessed) {
        logger.warn(`Duplicate call webhook for ${call_id}, skipping`);
        return res.status(200).json({ message: 'Already processed' });
    }

    // Store transcript
    await voiceService.storeTranscript(call_id, transcript, concatenated_transcript);

    // Get associated lead
    const leadId = await voiceService.getLeadIdForCall(call_id);

    // Update existing conversation entry with transcript, or create one
    if (leadId) {
        try {
            await voiceService.updateCallConversationWithTranscript(call_id, {
                body: summary || 'Call completed',
                recording_url: recording_url || null,
                call_length: call_length || null,
                summary: summary || null,
            });
        } catch (err) {
            logger.warn(`[webhook:call-ended] Failed to update call conversation:`, err.message);
        }
    }

    if (leadId && concatenated_transcript) {
        // Queue transcript analysis (Postgres job queue)
        try {
            await enqueue('transcript-analysis', {
                lead_id: leadId,
                call_id,
                transcript: concatenated_transcript,
            });
        } catch (err) {
            logger.warn('Failed to queue transcript analysis:', err.message);
        }
    }

    res.json({ message: 'Transcript received', call_id });
});

module.exports = { initiateCall, callEndedWebhook };
