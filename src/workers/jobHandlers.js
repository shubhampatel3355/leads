/**
 * Job Handlers — maps job types to their processing functions.
 * Extracted from old BullMQ workers into pure async functions.
 */
const logger = require('../utils/logger');

// ─── Upload Processing ─────────────────────────────────────────
async function handleUploadProcessing(payload) {
    const { processUploadFromStorage } = require('../services/leadService');
    const { batch_id, file_path, filename, user_id, campaign_id } = payload;

    logger.info(`[handler:upload] Processing batch=${batch_id}, file=${filename}`);
    const result = await processUploadFromStorage(batch_id, file_path, filename, user_id, campaign_id);
    logger.info(`[handler:upload] Done: ${result.inserted} inserted, ${result.duplicates_skipped} deduped`);

    return result;
}

// ─── Intent Analysis ───────────────────────────────────────────
async function handleIntentAnalysis(payload) {
    const supabase = require('../config/supabase');
    const { analyzeIntent } = require('../services/aiService');
    const { calculateIntentScore, calculateFinalScore, calculateFitScore } = require('../services/scoringService');
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

    // Simulate No Messages if history is not available
    // Previously we fetched from getConversation of whatsappService
    const messages = []; // TODO: implement multi-channel conversation fetching 
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

    // Fetch campaign context for better analysis
    let campaignContext = null;
    if (lead.campaign_id) {
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('name, meta')
            .eq('id', lead.campaign_id)
            .single();
        if (campaign) campaignContext = campaign;
    }

    const analysis = await analyzeTranscript(lead, transcript, campaignContext);

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
    const { lead_id, campaign_id, prompt_script: payloadScript } = payload;

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

    // 3. Check if campaign is paused — skip call if campaign is paused
    const effectiveCampaignId = campaign_id || lead.campaign_id;
    if (effectiveCampaignId) {
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('status, prompt_script')
            .eq('id', effectiveCampaignId)
            .single();

        if (campaign?.status === 'paused') {
            logger.info(`[handler:ai-call] Campaign ${effectiveCampaignId} is paused — skipping call for lead ${lead_id}`);
            return { skipped: true, reason: 'campaign_paused' };
        }
    }

    // 4. Duplicate prevention — check if a call already exists
    const callExists = await voiceService.hasExistingCall(lead_id);
    if (callExists) {
        logger.info(`[handler:ai-call] Call already exists for lead ${lead_id}, skipping`);
        return { skipped: true, reason: 'call_already_exists' };
    }

    // 5. Resolve custom prompt (payload > campaign DB > dynamic generator > default)
    let customTask = payloadScript || undefined;
    if (effectiveCampaignId) {
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('prompt_script, meta, name')
            .eq('id', effectiveCampaignId)
            .single();

        if (campaign) {
            const meta = campaign.meta || {};
            
            // Build dynamic persona if internal script is light or missing
            if (!customTask && (campaign.prompt_script?.trim() || Object.keys(meta).length > 0)) {
                const parts = [];
                
                parts.push(`# AI PERSONA & MISSION`);
                parts.push(`You are a highly skilled AI sales representative for the campaign: "${campaign.name}".`);
                
                if (meta.tone) parts.push(`**TONE OF VOICE:** ${meta.tone.toUpperCase()}`);
                if (meta.language) parts.push(`**PRIMARY LANGUAGE:** ${meta.language}`);
                
                parts.push(`\n## 1. CONTEXT & OFFERING`);
                if (meta.selling_context) parts.push(`**What you are selling:**\n${meta.selling_context}`);
                if (meta.key_value_props) parts.push(`**Key Value Propositions:**\n${meta.key_value_props}`);
                if (meta.deal_size) parts.push(`**Target Deal Size:** ${meta.deal_size.toUpperCase()}`);

                parts.push(`\n## 2. CAMPAIGN OBJECTIVES`);
                if (meta.goal) parts.push(`**Your Primary Goal:** ${meta.goal.replace(/_/g, ' ')}`);
                if (meta.objective) parts.push(`**Campaign Objective:** ${meta.objective.replace(/_/g, ' ')}`);
                if (meta.conversion_goal) parts.push(`**Conversion Event:** ${meta.conversion_goal.replace(/_/g, ' ')}`);

                parts.push(`\n## 3. PROSPECT INTELLIGENCE (ICP)`);
                if (meta.icp_details) parts.push(`**Ideal Customer Profile:**\n${meta.icp_details}`);
                if (meta.lead_warmth) parts.push(`**Lead Warmth Level:** ${meta.lead_warmth.toUpperCase()}`);
                if (meta.buying_triggers) parts.push(`**Buying Triggers to watch for:**\n${meta.buying_triggers}`);
                
                if (meta.objection_tags && meta.objection_tags.length > 0) {
                    parts.push(`\n## 4. OBJECTION HANDLING`);
                    parts.push(`Be prepared to handle these specific objections:\n- ${meta.objection_tags.join('\n- ')}`);
                }

                parts.push(`\n## 5. BEHAVIORAL GUARDRAILS`);
                if (meta.guardrails) parts.push(`**Strict Constraints:**\n${meta.guardrails}`);
                if (meta.escalation_conditions) parts.push(`**Escalate/End call if:**\n${meta.escalation_conditions}`);
                if (meta.stop_conditions) parts.push(`**Stop calling this lead if:** ${meta.stop_conditions.replace(/_/g, ' ')}`);

                if (campaign.prompt_script) {
                    parts.push(`\n## 6. SPECIFIC SCRIPT & INSTRUCTIONS`);
                    parts.push(campaign.prompt_script);
                }

                customTask = parts.join('\n');
                logger.info(`[handler:ai-call] Generated comprehensive dynamic persona for campaign ${effectiveCampaignId}`);
            }
        }
    }

    // 6. Define dynamic opening sentence based on context
    let firstSentence = payload.first_sentence || undefined;
    if (!firstSentence && effectiveCampaignId) {
        const { data: campaign } = await supabase.from('campaigns').select('meta').eq('id', effectiveCampaignId).single();
        const meta = campaign?.meta || {};
        
        if (meta.opening_context === 'standard' || !meta.opening_context) {
            firstSentence = `Hi ${lead.name}, I'm reaching out regarding your business at ${lead.company || 'your company'}. Do you have a quick moment?`;
        } else if (meta.opening_context === 'urgent') {
            firstSentence = `Hi ${lead.name}, I'm calling with a quick update for ${lead.company || 'your business'}. Is now a good time?`;
        }
        // ... add more context-based openings here
    }

    // 7. Initiate call via OmniDimension
    const result = await voiceService.initiateCall(lead, {
        task: customTask,
        firstSentence: firstSentence,
    });

    // 7. Store conversation entry for the initiated call
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
