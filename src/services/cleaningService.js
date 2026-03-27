const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { normalizePhone } = require('../utils/phoneNormalizer');

/**
 * Clean and enrich lead data after upload.
 */
async function cleanLeads(leadIds) {
    logger.info(`Cleaning ${leadIds.length} leads`);

    // Fetch leads
    const { data: leads, error } = await supabase
        .from('leads')
        .select('*')
        .in('id', leadIds);

    if (error) throw new Error(`Failed to fetch leads for cleaning: ${error.message}`);

    const updates = [];
    const duplicateIds = [];
    const seenEmails = new Set();

    for (const lead of leads) {
        const update = { id: lead.id };

        // Normalize phone
        if (lead.phone) {
            update.phone = normalizePhone(lead.phone);
        }

        // Standardize name — capitalize
        if (lead.name) {
            update.name = lead.name
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(' ');
        }

        // Standardize email — lowercase
        if (lead.email) {
            const emailLower = lead.email.toLowerCase().trim();
            update.email = emailLower;

            // Check for duplicates within this batch
            if (seenEmails.has(emailLower)) {
                duplicateIds.push(lead.id);
                continue;
            }
            seenEmails.add(emailLower);
        }

        // Standardize company name
        if (lead.company) {
            update.company = lead.company.trim();
        }

        // Standardize job title
        if (lead.job_title) {
            update.job_title = lead.job_title.trim();
        }

        update.cleaned = true;
        updates.push(update);
    }

    // Batch update cleaned leads
    if (updates.length > 0) {
        for (const update of updates) {
            const { error: updateErr } = await supabase
                .from('leads')
                .update(update)
                .eq('id', update.id);

            if (updateErr) {
                logger.error(`Failed to update lead ${update.id}:`, updateErr.message);
            }
        }
    }

    // Mark duplicates
    if (duplicateIds.length > 0) {
        logger.info(`Found ${duplicateIds.length} duplicate leads`);
        await supabase
            .from('leads')
            .update({ status: 'duplicate' })
            .in('id', duplicateIds);
    }

    logger.info(`Cleaned ${updates.length} leads, ${duplicateIds.length} duplicates`);
    return { cleaned: updates.length, duplicates: duplicateIds.length };
}

/**
 * Check for existing leads with same email (cross-batch dedup).
 */
async function deduplicateAgainstExisting(leads, userId) {
    if (!leads.length) return leads;

    const emails = leads
        .filter(l => l.email)
        .map(l => l.email.toLowerCase());

    if (!emails.length) return leads;

    const { data: existing } = await supabase
        .from('leads')
        .select('email')
        .eq('user_id', userId)
        .in('email', emails);

    const existingEmails = new Set((existing || []).map(e => e.email.toLowerCase()));

    return leads.filter(l => {
        if (l.email && existingEmails.has(l.email.toLowerCase())) {
            logger.debug(`Skipping duplicate: ${l.email}`);
            return false;
        }
        return true;
    });
}

module.exports = { cleanLeads, deduplicateAgainstExisting };
