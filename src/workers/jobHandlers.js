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
    logger.info(`[handler:upload] Done: ${result.inserted} total, ${result.reassigned || 0} reassigned`);

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
    // 8. Auto-trigger AI voice calls has been removed to ensure manual campaign control.
    // Leads will only be called when the user explicitly clicks "Launch Campaign".

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
    const { lead_id, campaign_id, prompt_script: payloadScript, bypassDuplicateCheck } = payload;

    logger.info(`[handler:ai-call] Processing initiation for lead ${lead_id}${bypassDuplicateCheck ? ' (BYPASS ACTIVE)' : ''}`);

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

    // 2b. Check if lead is assigned to a campaign
    const effectiveCampaignId = campaign_id || lead.campaign_id;
    if (!effectiveCampaignId) {
        logger.info(`[handler:ai-call] Lead ${lead_id} is not assigned to any campaign, skipping call`);
        return { skipped: true, reason: 'no_campaign_assigned' };
    }

    // 3. Fetch campaign once — includes status, script, meta, and name (single DB call)
    const { data: campaign } = await supabase
        .from('campaigns')
        .select('status, prompt_script, meta, name')
        .eq('id', effectiveCampaignId)
        .single();

    if (!campaign || campaign.status !== 'running') {
        logger.info(`[handler:ai-call] Campaign ${effectiveCampaignId} is not running (status: ${campaign?.status || 'unknown'}) — skipping call for lead ${lead_id}`);
        return { skipped: true, reason: 'campaign_not_running' };
    }

    // 4. Duplicate prevention — skip check if bypass flag is present (manual triggers)
    const bypass = (payload.bypassDuplicateCheck === true || payload.bypassDuplicateCheck === 'true');
    if (!bypass) {
        const callExists = await voiceService.hasExistingCall(lead_id, effectiveCampaignId);
        if (callExists) {
            logger.info(`[handler:ai-call] Call already exists for lead ${lead_id} in campaign ${effectiveCampaignId || 'global'}, skipping`);
            return { skipped: true, reason: 'call_already_exists' };
        }
    } else {
        logger.info(`[handler:ai-call] Bypassing duplicate check for manual retry on lead ${lead_id} (Campaign: ${effectiveCampaignId || 'none'})`);
    }

    // 5. Resolve custom prompt (payload > campaign DB > dynamic generator > default)
    let customTask = payloadScript || undefined;
    const { adaptLeadScript } = require('../services/aiService');
    let personalizedScript = payloadScript || '';
    let scriptPersonalized = false;

    if (effectiveCampaignId) {
        // Use the campaign already fetched above — no second DB call needed
        if (campaign) {
            const meta = campaign.meta || {};
            personalizedScript = payloadScript || campaign.prompt_script || '';

            // Apply LinkedIn personalization if data is available
            if (lead.linkedin_url || lead.linkedin_data_summary) {
                try {
                    logger.info(`[handler:ai-call] Personalizing script for lead ${lead_id} using LinkedIn data`);
                    const adapted = await adaptLeadScript({
                        default_script: personalizedScript,
                        lead_name: lead.name,
                        linkedin_url: lead.linkedin_url,
                        linkedin_data_summary: lead.linkedin_data_summary,
                        job_title: lead.job_title,
                        notes: lead.notes,
                        company: lead.company
                    });
                    
                    if (adapted && adapted !== personalizedScript) {
                        personalizedScript = adapted;
                        scriptPersonalized = true;
                        logger.info(`[handler:ai-call] Script personalized successfully`);
                    }
                } catch (err) {
                    logger.warn(`[handler:ai-call] LinkedIn script personalization failed: ${err.message}. Using default.`);
                }
            }
            
            // Build the final prompt — campaign script is ALWAYS the primary instruction.
            // Universal speaking rules are a thin overlay. No industry-specific content is injected.
            if (personalizedScript?.trim() || Object.keys(meta).length > 0) {
                const parts = [];

                // ── 1. CAMPAIGN SCRIPT (PRIMARY — must come first and dominates all behaviour) ──
                if (personalizedScript?.trim()) {
                    parts.push(`## YOUR SCRIPT & INSTRUCTIONS (follow this exactly)`);
                    parts.push(personalizedScript.trim());
                }

                // ── 2. LEAD CONTEXT (who you are calling) ─────────────────────────────────
                parts.push(`\n## LEAD CONTEXT`);
                parts.push(
                    `Name: ${lead.name || 'the prospect'}\n` +
                    (lead.company   ? `Company: ${lead.company}\n`   : '') +
                    (lead.job_title ? `Role: ${lead.job_title}\n`    : '') +
                    (lead.location  ? `Location: ${lead.location}\n` : '') +
                    `Use the lead's name naturally throughout the conversation.`
                );

                // ── 3. CAMPAIGN GOAL (what success looks like) ───────────────────────────
                const hasGoal = meta.conversion_goal || meta.goal || meta.campaign_goal;
                if (hasGoal) {
                    parts.push(`\n## GOAL FOR THIS CALL`);
                    if (meta.conversion_goal) parts.push(`Your primary objective: ${meta.conversion_goal.replace(/_/g, ' ')}`);
                    else if (meta.goal)       parts.push(`Your primary objective: ${meta.goal.replace(/_/g, ' ')}`);
                    else if (meta.campaign_goal) parts.push(`Your primary objective: ${meta.campaign_goal.replace(/_/g, ' ')}`);
                    if (meta.post_conversion_action) parts.push(`After success: ${meta.post_conversion_action.replace(/_/g, ' ')}`);
                }

                // ── 4. LEAD INTELLIGENCE (optional, only if configured) ──────────────────
                const hasIntel = meta.lead_warmth || meta.lead_source || meta.buying_triggers || meta.icp_details;
                if (hasIntel) {
                    parts.push(`\n## PROSPECT INTELLIGENCE`);
                    if (meta.lead_warmth) {
                        const warmthGuide = {
                            hot:  'HIGH INTENT — close quickly, skip lengthy education.',
                            warm: 'MEDIUM INTENT — build on existing interest, then close.',
                            cold: 'LOW INTENT — earn curiosity first, do not pitch hard on first call.',
                        };
                        parts.push(`Lead temperature: ${meta.lead_warmth.toUpperCase()} — ${warmthGuide[meta.lead_warmth] || ''}`);
                    }
                    if (meta.lead_source) parts.push(`Lead came from: ${meta.lead_source.replace(/_/g, ' ')}`);
                    if (meta.icp_details) parts.push(`Ideal prospect profile: ${meta.icp_details}`);
                    if (meta.buying_triggers) parts.push(`Buying signals to listen for: ${meta.buying_triggers}`);
                }

                // ── 5. OBJECTION HANDLING (only campaign-configured objections) ───────────
                if (meta.objection_tags && meta.objection_tags.length > 0) {
                    parts.push(`\n## OBJECTION HANDLING`);
                    parts.push(`Be prepared to handle these objections:\n${meta.objection_tags.map(o => `- ${o}`).join('\n')}`);
                }

                // ── 6. GUARDRAILS (only campaign-configured constraints) ──────────────────
                const hasGuardrails = meta.guardrails || meta.ai_must_not_say || meta.escalation_conditions || meta.stop_conditions;
                if (hasGuardrails) {
                    parts.push(`\n## CONSTRAINTS`);
                    if (meta.ai_must_not_say)       parts.push(`NEVER say or mention: ${meta.ai_must_not_say}`);
                    if (meta.guardrails)             parts.push(meta.guardrails);
                    if (meta.escalation_conditions)  parts.push(`Escalate to a human if: ${meta.escalation_conditions}`);
                    if (meta.stop_conditions)        parts.push(`End the call if: ${meta.stop_conditions.replace(/_/g, ' ')}`);
                }

                // ── 7. UNIVERSAL SPEAKING RULES (thin wrapper — applies to every campaign) ──
                parts.push(`\n## SPEAKING RULES (always apply)`);
                parts.push(
                    (meta.language
                        ? `Language: Speak in ${meta.language}. If the prospect replies in a different language, switch to match them immediately.`
                        : `Language: Match the prospect's language from their very first sentence — English, Hindi, Hinglish, or any regional language. Switch mid-call if they switch.`
                    ) + `\n` +
                    `Tone: ${meta.tone ? meta.tone : 'conversational, confident, and natural — never robotic or scripted-sounding'}.` + `\n` +
                    `- Speak in short sentences (1–2 at a time), then pause and listen.\n` +
                    `- No filler words: never say "umm", "uh", "you know", "basically", "so like".\n` +
                    `- No dead air: bridge pauses with "Good question —" or "Right, so —".\n` +
                    `- Mirror the prospect's energy — formal if they're formal, relaxed if they're casual.\n` +
                    `- If asked "Are you AI?": answer honestly — "Yes, I'm an AI assistant. Happy to answer any questions you have."\n` +
                    `- Never repeat the same close more than twice. If they decline twice, end gracefully.`
                );

                customTask = parts.join('\n');
                logger.info(`[handler:ai-call] Built campaign-specific prompt for "${campaign.name}" (campaign ${effectiveCampaignId})`);
            }
        }
    }

    // 6. Replace template variables in customTask with actual lead data
    if (customTask) {
        const replacements = {
            '{{lead_name}}':    lead.name    || '',
            '[lead_name]':      lead.name    || '',
            '{lead_name}':      lead.name    || '',
            '{{name}}':         lead.name    || '',
            '[name]':           lead.name    || '',
            '{name}':           lead.name    || '',
            '{{company}}':      lead.company || '',
            '[company]':        lead.company || '',
            '{company}':        lead.company || '',
            '{{phone}}':        lead.phone   || '',
            '[phone]':          lead.phone   || '',
            '{{job_title}}':    lead.job_title || '',
            '[job_title]':      lead.job_title || '',
            '{{location}}':     lead.location  || '',
            '[location]':       lead.location  || '',
        };
        for (const [token, value] of Object.entries(replacements)) {
            customTask = customTask.split(token).join(value);
        }
    }

    // 7. Build a short, natural opening greeting (NOT the full script)
    let firstSentence = payload.first_sentence;
    if (!firstSentence) {
        const leadFirstName = (lead.name || '').split(' ')[0] || lead.name || 'there';
        // Use personalizedScript only if it's already a short opener (≤ 200 chars)
        if (personalizedScript && personalizedScript.trim().length <= 200) {
            firstSentence = personalizedScript.trim();
        } else {
            // Build a clean greeting from available context
            firstSentence = `Hi ${leadFirstName}!`;
        }
        logger.info(`[handler:ai-call] Opening greeting set: "${firstSentence}"`);
    }

    // 8. Initiate call via OmniDimension
    const result = await voiceService.initiateCall(lead, {
        task: customTask,
        firstSentence: firstSentence,
        campaignId: effectiveCampaignId,
    });

    // 9. Store conversation entry for the initiated call
    try {
        await voiceService.storeCallConversation(lead_id, result.call_id, 'initiated', {}, effectiveCampaignId);
    } catch (err) {
        logger.warn(`[handler:ai-call] Failed to store call conversation:`, err.message);
    }

    logger.info(`[handler:ai-call] AI call initiated for lead ${lead_id}, call_id: ${result.call_id}`);
    return { call_id: result.call_id, lead_id };
}

// ─── Enrichment Row ───────────────────────────────────────────
async function handleEnrichmentRow(payload) {
    const supabase = require('../config/supabase');
    const { enrichRow } = require('../services/enrichmentService');
    const { job_id, row_id, company_name, domain, city, person_name, designation } = payload;

    logger.info(`[handler:enrich] Processing row ${row_id} — company: "${company_name}"${person_name ? `, person: "${person_name}"` : ''}`);

    // Mark as processing
    await supabase.from('enrichment_rows')
        .update({ status: 'processing' })
        .eq('id', row_id);

    try {
        const result = await enrichRow({ company_name, domain, city, person_name, designation });

        await supabase.from('enrichment_rows').update({
            status: 'success',
            person_name:      person_name || null,
            designation:      designation || null,
            entity_type:      result.entity_type,
            domain:           result.domain,
            linkedin_url:     result.linkedin_url,
            instagram_url:    result.instagram_url,
            x_url:            result.x_url,
            youtube_url:      result.youtube_url,
            facebook_url:     result.facebook_url,
            confidence_score: result.confidence_score,
            source:           result.source,
        }).eq('id', row_id);

        logger.info(`[handler:enrich] ✓ Row ${row_id} done (score: ${result.confidence_score})`);
        return { row_id, status: 'success', confidence_score: result.confidence_score };
    } catch (err) {
        await supabase.from('enrichment_rows').update({
            status: 'failed',
            error_message: err.message,
        }).eq('id', row_id);
        throw err;
    }
}

// ─── Handler Registry ──────────────────────────────────────────
const handlers = {
    'upload-processing': handleUploadProcessing,
    'intent-analysis': handleIntentAnalysis,
    'transcript-analysis': handleTranscriptAnalysis,
    'notification-dispatch': handleNotificationDispatch,
    'ai-call-initiate': handleAiCallInitiate,
    'enrichment-row': handleEnrichmentRow,
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
