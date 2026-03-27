/**
 * Job Handlers — maps job types to their processing functions.
 * Extracted from old BullMQ workers into pure async functions.
 */
const logger = require('../utils/logger');

// ─── Upload Processing ─────────────────────────────────────────
async function handleUploadProcessing(payload) {
    const { processUploadFromStorage } = require('../services/leadService');
    const { batch_id, file_path, filename, user_id } = payload;

    logger.info(`[handler:upload] Processing batch=${batch_id}, file=${filename}`);
    const result = await processUploadFromStorage(batch_id, file_path, filename, user_id);
    logger.info(`[handler:upload] Done: ${result.inserted} inserted, ${result.duplicates_skipped} deduped`);

    return result;
}

// ─── WhatsApp Sending ──────────────────────────────────────────
async function handleWhatsappSending(payload) {
    const whatsappService = require('../services/whatsappService');
    const { lead_id, phone, message } = payload;

    logger.info(`[handler:whatsapp] Sending to lead ${lead_id}`);
    const result = await whatsappService.sendMessage(lead_id, phone, message);
    logger.info(`[handler:whatsapp] Sent: ${result.sid}`);

    return { sid: result.sid, status: result.status };
}

// ─── Intent Analysis ───────────────────────────────────────────
async function handleIntentAnalysis(payload) {
    const supabase = require('../config/supabase');
    const { analyzeIntent } = require('../services/aiService');
    const { calculateIntentScore, calculateFinalScore, calculateFitScore } = require('../services/scoringService');
    const { getConversation } = require('../services/whatsappService');
    const leadService = require('../services/leadService');
    const { notifyHotLead } = require('../services/notificationService');
    const { enqueue } = require('../config/jobQueue');

    const { lead_id, trigger } = payload;
    logger.info(`[handler:intent] Analyzing lead ${lead_id} (trigger: ${trigger})`);

    // 1. Fetch lead
    const { data: lead, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', lead_id)
        .single();

    if (error || !lead) {
        throw new Error(`Lead ${lead_id} not found: ${error?.message}`);
    }

    const previousClassification = lead.classification;

    // 2. Fetch conversation history
    const messages = await getConversation(lead_id);
    if (!messages || messages.length === 0) {
        logger.info(`[handler:intent] No messages for lead ${lead_id}, skipping`);
        return { skipped: true, reason: 'no_messages' };
    }

    // 3. AI analysis
    const analysis = await analyzeIntent(lead, messages);

    // 4. Calculate scores
    const fitScore = calculateFitScore(lead);
    const intentScore = calculateIntentScore(analysis);
    const { finalScore, classification } = calculateFinalScore(fitScore, intentScore, analysis);

    // 5. Update lead scores
    await leadService.updateLeadScores(lead_id, {
        fit_score: fitScore,
        intent_score: intentScore,
        final_score: finalScore,
        classification,
    });

    // 6. Store analysis
    await supabase.from('lead_analyses').insert({
        lead_id,
        analysis_type: trigger || 'manual',
        result: analysis,
        fit_score: fitScore,
        intent_score: intentScore,
        final_score: finalScore,
        classification,
        created_at: new Date().toISOString(),
    });

    // 7. Notification if newly hot
    if (classification === 'hot' && previousClassification !== 'hot') {
        try {
            await enqueue('notification-dispatch', {
                lead_id,
                lead_name: lead.name,
                company: lead.company,
                final_score: finalScore,
                user_id: lead.user_id,
                previous_classification: previousClassification,
            });
        } catch {
            await notifyHotLead(
                { ...lead, final_score: finalScore, classification },
                previousClassification
            );
        }
    }

    // 8. Auto-trigger AI call when classification changes cold → warm
    if (previousClassification === 'cold' && classification === 'warm' && lead.phone) {
        try {
            const { hasExistingCall } = require('../services/voiceService');
            const callExists = await hasExistingCall(lead_id);
            if (!callExists) {
                await enqueue('ai-call-initiate', { lead_id, phone: lead.phone });
                logger.info(`[handler:intent] Queued ai-call-initiate for lead ${lead_id} (cold → warm)`);
            } else {
                logger.info(`[handler:intent] Skipping ai-call-initiate for lead ${lead_id}, call already exists`);
            }
        } catch (err) {
            logger.warn(`[handler:intent] Failed to queue ai-call-initiate:`, err.message);
        }
    }

    logger.info(`[handler:intent] Lead ${lead_id}: ${previousClassification} → ${classification} (score: ${finalScore})`);
    return { lead_id, classification, final_score: finalScore };
}

// ─── Transcript Analysis ───────────────────────────────────────
async function handleTranscriptAnalysis(payload) {
    const supabase = require('../config/supabase');
    const { analyzeTranscript } = require('../services/aiService');
    const { calculateIntentScore, calculateFinalScore, calculateFitScore } = require('../services/scoringService');
    const leadService = require('../services/leadService');
    const { notifyHotLead } = require('../services/notificationService');
    const { enqueue } = require('../config/jobQueue');

    const { lead_id, call_id, transcript } = payload;
    logger.info(`[handler:transcript] Analyzing transcript for lead ${lead_id}, call ${call_id}`);

    const { data: lead, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', lead_id)
        .single();

    if (error || !lead) {
        throw new Error(`Lead ${lead_id} not found`);
    }

    const previousClassification = lead.classification;
    const analysis = await analyzeTranscript(lead, transcript);

    const fitScore = calculateFitScore(lead);
    const intentScore = calculateIntentScore(analysis);
    const { finalScore, classification } = calculateFinalScore(fitScore, intentScore, analysis);

    await leadService.updateLeadScores(lead_id, {
        fit_score: fitScore,
        intent_score: intentScore,
        final_score: finalScore,
        classification,
    });

    await supabase.from('lead_analyses').insert({
        lead_id,
        analysis_type: 'voice_transcript',
        result: analysis,
        fit_score: fitScore,
        intent_score: intentScore,
        final_score: finalScore,
        classification,
        metadata: { call_id },
        created_at: new Date().toISOString(),
    });

    if (classification === 'hot' && previousClassification !== 'hot') {
        try {
            await enqueue('notification-dispatch', {
                lead_id,
                lead_name: lead.name,
                company: lead.company,
                final_score: finalScore,
                user_id: lead.user_id,
                previous_classification: previousClassification,
            });
        } catch {
            await notifyHotLead(
                { ...lead, final_score: finalScore, classification },
                previousClassification
            );
        }
    }

    // Auto-trigger AI call when classification changes cold → warm
    if (previousClassification === 'cold' && classification === 'warm' && lead.phone) {
        try {
            const { hasExistingCall } = require('../services/voiceService');
            const callExists = await hasExistingCall(lead_id);
            if (!callExists) {
                await enqueue('ai-call-initiate', { lead_id, phone: lead.phone });
                logger.info(`[handler:transcript] Queued ai-call-initiate for lead ${lead_id} (cold → warm)`);
            } else {
                logger.info(`[handler:transcript] Skipping ai-call-initiate for lead ${lead_id}, call already exists`);
            }
        } catch (err) {
            logger.warn(`[handler:transcript] Failed to queue ai-call-initiate:`, err.message);
        }
    }

    logger.info(`[handler:transcript] Lead ${lead_id}: ${previousClassification} → ${classification}`);
    return { lead_id, classification, final_score: finalScore };
}

// ─── Notification Dispatch ─────────────────────────────────────
async function handleNotificationDispatch(payload) {
    const { notifyHotLead } = require('../services/notificationService');
    const { lead_id, lead_name, company, final_score, user_id, previous_classification } = payload;

    logger.info(`[handler:notification] Dispatching hot lead notification for ${lead_name}`);

    await notifyHotLead(
        { id: lead_id, name: lead_name, company, final_score, classification: 'hot', user_id },
        previous_classification
    );

    return { notified: true, lead_id };
}

// ─── AI Call Initiation ────────────────────────────────────────
async function handleAiCallInitiate(payload) {
    const supabase = require('../config/supabase');
    const voiceService = require('../services/voiceService');
    const { lead_id } = payload;

    logger.info(`[handler:ai-call] Initiating AI call for lead ${lead_id}`);

    // 1. Fetch lead
    const { data: lead, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', lead_id)
        .single();

    if (error || !lead) {
        throw new Error(`Lead ${lead_id} not found: ${error?.message}`);
    }

    // 2. Validate phone
    if (!lead.phone) {
        logger.warn(`[handler:ai-call] Lead ${lead_id} has no phone number, skipping call`);
        return { skipped: true, reason: 'no_phone' };
    }

    // 3. Duplicate prevention — check if a call already exists
    const callExists = await voiceService.hasExistingCall(lead_id);
    if (callExists) {
        logger.info(`[handler:ai-call] Call already exists for lead ${lead_id}, skipping`);
        return { skipped: true, reason: 'call_already_exists' };
    }

    // 4. Initiate call via Bland AI
    const result = await voiceService.initiateCall(lead, {
        task: `You are calling ${lead.name || 'a potential customer'}${lead.company ? ' from ' + lead.company : ''}. Your goal is to qualify their interest in improving lead qualification with AI. Ask about their current process, timeline, and budget. Be professional, friendly, and concise. Do not be pushy.`,
        voice: 'maya',
        firstSentence: `Hi ${lead.name || 'there'}, this is a quick follow-up call about your recent inquiry. Do you have a moment to chat?`,
    });

    // 5. Store conversation entry for the initiated call
    try {
        await voiceService.storeCallConversation(lead_id, result.call_id, 'initiated');
    } catch (err) {
        logger.warn(`[handler:ai-call] Failed to store call conversation:`, err.message);
    }

    logger.info(`[handler:ai-call] AI call initiated for lead ${lead_id}, call_id: ${result.call_id}`);
    return { call_id: result.call_id, lead_id };
}

// ─── Handler Registry ──────────────────────────────────────────
const handlers = {
    'upload-processing': handleUploadProcessing,
    'whatsapp-sending': handleWhatsappSending,
    'intent-analysis': handleIntentAnalysis,
    'transcript-analysis': handleTranscriptAnalysis,
    'notification-dispatch': handleNotificationDispatch,
    'ai-call-initiate': handleAiCallInitiate,
};

/**
 * Dispatch a job to its handler.
 * @param {string} type
 * @param {object} payload
 * @returns {object} result
 */
async function dispatch(type, payload) {
    const handler = handlers[type];
    if (!handler) {
        throw new Error(`Unknown job type: ${type}`);
    }
    return handler(payload);
}

module.exports = { dispatch, handlers };
