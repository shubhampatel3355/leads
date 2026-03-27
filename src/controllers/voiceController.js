const voiceService = require('../services/voiceService');
const leadService = require('../services/leadService');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * POST /api/calls/initiate
 * Start a Bland AI voice call for a lead.
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
 * Receive call transcript from Bland AI.
 */
const callEndedWebhook = asyncHandler(async (req, res) => {
    const { call_id, transcript, concatenated_transcript, status, recording_url, call_length, summary } = req.body;

    logger.info(`Call ended webhook for call_id: ${call_id}, status: ${status}`);

    if (!call_id) {
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
