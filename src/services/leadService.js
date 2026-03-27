const supabase = require('../config/supabase');
const { parseFile, validateLeadRow } = require('../utils/parser');
const { calculateFitScore } = require('./scoringService');
const { deduplicateAgainstExisting } = require('./cleaningService');
const { normalizePhone } = require('../utils/phoneNormalizer');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');

/**
 * Download file from Supabase Storage and process it into leads.
 * Called by the upload worker (or synchronous fallback).
 */
async function processUploadFromStorage(batchId, filePath, filename, userId) {
    const updateBatch = async (fields) => {
        await supabase.from('batch_uploads').update(fields).eq('id', batchId);
    };

    try {
        // 1. Download file from Supabase Storage
        logger.info(`[lead-service] Downloading file: ${filePath}`);
        const { data: fileData, error: downloadErr } = await supabase.storage
            .from('lead_uploads')
            .download(filePath);

        if (downloadErr || !fileData) {
            throw new Error(`Failed to download file: ${downloadErr?.message || 'No data'}`);
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        logger.info(`[lead-service] Downloaded ${buffer.length} bytes`);

        // 2. Parse file
        const rawRows = parseFile(buffer, filename);
        logger.info(`[lead-service] Parsed ${rawRows.length} rows from "${filename}"`);

        await updateBatch({ total_rows: rawRows.length });

        if (rawRows.length === 0) {
            await updateBatch({ status: 'completed', valid_rows: 0, inserted_rows: 0 });
            return { total_parsed: 0, valid: 0, duplicates_skipped: 0, inserted: 0 };
        }

        // 3. Validate rows
        const validRows = rawRows.map(validateLeadRow).filter(Boolean);
        logger.info(`[lead-service] ${validRows.length} valid rows out of ${rawRows.length}`);

        await updateBatch({ valid_rows: validRows.length });

        if (validRows.length === 0) {
            await updateBatch({ status: 'completed', inserted_rows: 0 });
            return { total_parsed: rawRows.length, valid: 0, duplicates_skipped: 0, inserted: 0 };
        }

        // 4. Deduplicate within file
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

        // 5. Deduplicate against existing leads in DB
        const uniqueRows = await deduplicateAgainstExisting(internalDeduped, userId);
        const duplicateCount = validRows.length - uniqueRows.length;
        logger.info(`[lead-service] ${uniqueRows.length} unique leads (${duplicateCount} duplicates skipped)`);

        if (uniqueRows.length === 0) {
            await updateBatch({ status: 'completed', inserted_rows: 0, duplicate_count: duplicateCount });
            return { total_parsed: rawRows.length, valid: validRows.length, duplicates_skipped: duplicateCount, inserted: 0 };
        }

        // 6. Normalize + calculate fit scores + prepare for insert
        const leadsToInsert = uniqueRows.map(row => {
            // Normalize
            const email = row.email ? row.email.toLowerCase().trim() : null;
            const phone = row.phone ? normalizePhone(row.phone) : null;
            const name = row.name ? row.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Unknown';

            const normalized = { ...row, email, phone, name };
            const fitScore = calculateFitScore(normalized);

            return {
                ...normalized,
                user_id: userId,
                fit_score: fitScore,
                intent_score: 0,
                final_score: fitScore,
                classification: fitScore >= 40 ? 'warm' : 'cold',
                status: 'new',
                cleaned: true,
                source: row.source || 'csv_upload',
                created_at: new Date().toISOString(),
            };
        });

        // 7. Bulk insert in batches of 500
        let insertedCount = 0;
        const insertedLeadIds = [];
        const batchSize = 500;

        for (let i = 0; i < leadsToInsert.length; i += batchSize) {
            const batch = leadsToInsert.slice(i, i + batchSize);
            const { data, error } = await supabase
                .from('leads')
                .upsert(batch, {
                    onConflict: 'email,user_id',
                    ignoreDuplicates: true,
                })
                .select('id');

            if (error) {
                logger.error(`Batch insert error at offset ${i}:`, error.message);
                continue;
            }

            insertedCount += (data?.length || 0);
            if (data) insertedLeadIds.push(...data.map(d => d.id));
            logger.debug(`Inserted batch ${Math.floor(i / batchSize) + 1}: ${data?.length || 0} leads`);
        }

        // 8. Update batch status
        await updateBatch({
            status: 'completed',
            inserted_rows: insertedCount,
            duplicate_count: duplicateCount,
        });

        logger.info(`[lead-service] Upload complete: ${insertedCount} inserted, ${duplicateCount} duplicates`);

        // 9. Auto-send WhatsApp welcome message to leads with phone numbers
        if (insertedLeadIds.length > 0) {
            try {
                const { data: leadsWithPhones } = await supabase
                    .from('leads')
                    .select('id, phone, name')
                    .in('id', insertedLeadIds)
                    .not('phone', 'is', null);

                const sendCount = leadsWithPhones?.length || 0;
                if (sendCount > 0) {
                    logger.info(`[lead-service] Queuing WhatsApp welcome for ${sendCount} leads`);
                }

                for (const lead of (leadsWithPhones || [])) {
                    await enqueue('whatsapp-sending', {
                        lead_id: lead.id,
                        phone: lead.phone,
                        message: `Hi ${lead.name || 'there'}, thanks for connecting with us! We'd love to learn more about your needs. How can we help you today?`,
                    });
                }
            } catch (err) {
                // Non-critical — don't fail the upload if WhatsApp queueing fails
                logger.warn(`[lead-service] Failed to queue WhatsApp auto-send:`, err.message);
            }
        }

        return {
            total_parsed: rawRows.length,
            valid: validRows.length,
            duplicates_skipped: duplicateCount,
            inserted: insertedCount,
        };
    } catch (err) {
        logger.error(`[lead-service] Upload processing failed:`, err.message);
        await updateBatch({ status: 'failed' });
        throw err;
    }
}

/**
 * Fetch paginated leads for a user.
 */
async function getLeads(userId, { page = 1, limit = 20, classification, search } = {}) {
    let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

    if (classification) {
        query = query.eq('classification', classification);
    }

    if (search) {
        query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) throw new Error(`Failed to fetch leads: ${error.message}`);

    return {
        leads: data,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
    };
}

/**
 * Fetch a single lead by ID.
 */
async function getLeadById(leadId, userId) {
    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .eq('user_id', userId)
        .single();

    if (error || !data) {
        const err = new Error('Lead not found');
        err.status = 404;
        throw err;
    }

    return data;
}

/**
 * Update lead scores in the database.
 */
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

    if (error) throw new Error(`Failed to update lead scores: ${error.message}`);
}

module.exports = { processUploadFromStorage, getLeads, getLeadById, updateLeadScores };
