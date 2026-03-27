const whatsappService = require('../services/whatsappService');
const supabase = require('../config/supabase');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/conversations
 * Fetch conversation history for a lead.
 */
const getConversations = asyncHandler(async (req, res) => {
    const { lead_id } = req.query;

    if (!lead_id) {
        return res.status(400).json({ error: 'lead_id query parameter is required' });
    }

    const messages = await whatsappService.getConversation(lead_id);
    res.json({ lead_id, messages });
});

/**
 * GET /api/conversations/threads
 * List all leads that have conversations, with their latest message.
 * Sorted by most recent message first.
 */
const getThreads = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Get all leads belonging to this user that have at least one conversation
    const { data: leads, error: leadsErr } = await supabase
        .from('leads')
        .select('id, name, email, phone, company, classification, fit_score, intent_score')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

    if (leadsErr) throw new Error(`Failed to fetch leads: ${leadsErr.message}`);
    if (!leads || leads.length === 0) return res.json({ threads: [] });

    // For each lead, get their latest conversation message
    const threads = [];
    for (const lead of leads) {
        const { data: msgs } = await supabase
            .from('conversations')
            .select('id, body, direction, channel, status, created_at')
            .eq('lead_id', lead.id)
            .order('created_at', { ascending: false })
            .limit(1);

        if (msgs && msgs.length > 0) {
            // Also get total message count
            const { count } = await supabase
                .from('conversations')
                .select('id', { count: 'exact', head: true })
                .eq('lead_id', lead.id);

            // Count unread (inbound messages — simplified as messages in last 24h from lead)
            const { count: unread } = await supabase
                .from('conversations')
                .select('id', { count: 'exact', head: true })
                .eq('lead_id', lead.id)
                .eq('direction', 'inbound')
                .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

            threads.push({
                lead,
                lastMessage: msgs[0],
                messageCount: count || 0,
                unread: unread || 0,
            });
        }
    }

    // Sort by latest message time
    threads.sort((a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at));

    res.json({ threads });
});

module.exports = { getConversations, getThreads };
