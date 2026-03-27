const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Notify when a lead becomes "hot".
 * Stores notification in DB and logs it.
 */
async function notifyHotLead(lead, previousClassification) {
    if (lead.classification !== 'hot') return;
    if (previousClassification === 'hot') return; // Already was hot

    logger.info(`🔥 HOT LEAD ALERT: ${lead.name} (${lead.company}) — final_score: ${lead.final_score}`);

    try {
        await supabase.from('notifications').insert({
            user_id: lead.user_id,
            type: 'hot_lead',
            title: `New Hot Lead: ${lead.name}`,
            body: `${lead.name} from ${lead.company || 'Unknown'} has been classified as HOT with a score of ${lead.final_score}.`,
            lead_id: lead.id,
            read: false,
            created_at: new Date().toISOString(),
        });
    } catch (err) {
        logger.error('Failed to create notification:', err.message);
        // Don't throw — notification failure shouldn't break the pipeline
    }
}

/**
 * Get notifications for a user.
 */
async function getNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
    let query = supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (unreadOnly) {
        query = query.eq('read', false);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch notifications: ${error.message}`);
    return data || [];
}

/**
 * Mark notification as read.
 */
async function markAsRead(notificationId) {
    await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notificationId);
}

module.exports = { notifyHotLead, getNotifications, markAsRead };
