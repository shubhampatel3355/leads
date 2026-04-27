const supabase = require('../config/supabase');
const { parseFile, validateLeadRow } = require('../utils/parser');
const { calculateFitScore } = require('./scoringService');
const { deduplicateAgainstExisting } = require('./cleaningService');
const { normalizePhone } = require('../utils/phoneNormalizer');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');

/**
 * Download file from Supabase Storage and process it into leads.
 */
async function processUploadFromStorage(batchId, filePath, filename, userId, campaignId = null) {
    const updateBatch = async (fields) => {
        await supabase.from('batch_uploads').update(fields).eq('id', batchId);
    };

    try {
        const { data: fileData, error: downloadErr } = await supabase.storage
            .from('lead_uploads')
            .download(filePath);

        if (downloadErr || !fileData) {
            throw new Error(`Failed to download file: ${downloadErr?.message || 'No data'}`);
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        const rawRows = parseFile(buffer, filename);
        await updateBatch({ total_rows: rawRows.length });

        if (rawRows.length === 0) {
            await updateBatch({ status: 'completed', valid_rows: 0, inserted_rows: 0 });
            return { total_parsed: 0, valid: 0, duplicates_skipped: 0, inserted: 0 };
        }

        const validRows = rawRows.map(validateLeadRow).filter(Boolean);
        await updateBatch({ valid_rows: validRows.length });

        const seenEmails = new Set();
        const internalDeduped = [];
        for (const row of validRows) {
            if (row.email) {
                const emailLower = row.email.toLowerCase().trim();
                if (seenEmails.has(emailLower)) continue;
                seenEmails.add(emailLower);
            }
            internalDeduped.push(row);
        }

        logger.info(`[service:lead] Upserting ${internalDeduped.length} leads for campaign: ${campaignId}`);

        const leadsToPersist = internalDeduped.map(row => {
            const email = row.email ? row.email.toLowerCase().trim() : null;
            const phone = row.phone ? normalizePhone(row.phone) : null;
            const name = row.name ? row.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Unknown';
            const fitScore = calculateFitScore({ ...row, email, phone, name });

            return {
                ...row, 
                email, 
                phone, 
                name,
                user_id: userId,
                campaign_id: campaignId, // Keep for backward compat, but we rely on join table
                fit_score: fitScore,
                intent_score: 0,
                final_score: fitScore,
                classification: fitScore >= 40 ? 'warm' : 'cold',
                status: 'new',
                cleaned: true,
                source: row.source || 'csv_upload',
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(), 
            };
        });

        let persistedCount = 0;
        const batchSize = 100; // Smaller batches for better error tracking
        for (let i = 0; i < leadsToPersist.length; i += batchSize) {
            const batch = leadsToPersist.slice(i, i + batchSize);
            const { data, error } = await supabase
                .from('leads')
                .upsert(batch, { 
                    onConflict: 'email,user_id', 
                    ignoreDuplicates: false
                })
                .select('id');

            if (error) {
                logger.error(`[service:lead] Upsert batch error: ${error.message}`);
                continue;
            }



            persistedCount += (data?.length || 0);
        }

        await updateBatch({ status: 'completed', inserted_rows: persistedCount });
        return { total_parsed: rawRows.length, inserted: persistedCount, reassigned: persistedCount };
    } catch (err) {
        await updateBatch({ status: 'failed' });
        throw err;
    }
}

/**
 * Fetch paginated leads with explicit campaign join.
 */
async function getLeads(userId, { page = 1, limit = 20, classification, search, campaign_id } = {}) {
    // Note: Using explicit relationship name 'fk_leads_campaign' to resolve ambiguity
    let query = supabase
        .from('leads')
        .select('*, campaigns!fk_leads_campaign(name)', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

    if (classification) query = query.eq('classification', classification);
    if (campaign_id) {
        query = query.eq('campaign_id', campaign_id);
    }
    if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to fetch leads: ${error.message}`);

    const leads = (data || []).map(l => {
        // PostgREST returns joined data under the table name regardless of '!' specification
        const c = l.campaigns;
        let cName = 'No Campaign';
        if (c) {
            if (Array.isArray(c)) {
                if (c.length > 0) cName = c[0].name;
            } else {
                cName = c.name;
            }
        }
        return { ...l, campaign_name: cName };
    });

    return {
        leads,
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
    };
}

/**
 * Fetch a single lead by ID with explicit campaign join.
 */
async function getLeadById(leadId, userId) {
    const { data, error } = await supabase
        .from('leads')
        .select('*, campaigns!fk_leads_campaign(name)')
        .eq('id', leadId)
        .eq('user_id', userId)
        .single();

    if (error || !data) {
        const err = new Error('Lead not found');
        err.status = 404;
        throw err;
    }

    let cName = 'No Campaign';
    const c = data.campaigns;
    if (c) {
        if (Array.isArray(c)) {
            if (c.length > 0) cName = c[0].name;
        } else {
            cName = c.name;
        }
    }

    return { ...data, campaign_name: cName };
}

async function getLeadByPhone(phone) {
    if (!phone) return null;
    const normalized = normalizePhone(phone);
    const { data } = await supabase.from('leads').select('*').eq('phone', normalized).limit(1).maybeSingle();
    return data;
}

async function updateLeadScores(leadId, scores) {
    const { error } = await supabase
        .from('leads')
        .update({
            fit_score: scores.fit_score,
            intent_score: scores.intent_score,
            final_score: scores.final_score,
            classification: scores.classification,
            scored_at: new Date().toISOString(),
        })
        .eq('id', leadId);
    if (error) throw new Error(error.message);
}

module.exports = { 
    processUploadFromStorage, getLeads, getLeadById, getLeadByPhone, updateLeadScores 
};
