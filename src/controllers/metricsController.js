const supabase = require('../config/supabase');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/metrics
 * Dashboard metrics: lead counts, classification breakdown, response rate.
 */
const getMetrics = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Total leads
    const { count: totalLeads } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

    // Classification breakdown
    const { count: hotLeads } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('classification', 'hot');

    const { count: warmLeads } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('classification', 'warm');

    const { count: coldLeads } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('classification', 'cold');

    // Total messages sent
    const { count: messagesSent } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('direction', 'outbound');

    // Total replies received
    const { count: repliesReceived } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('direction', 'inbound');

    const responseRate = messagesSent > 0
        ? ((repliesReceived / messagesSent) * 100).toFixed(1)
        : 0;

    // Average score
    const { data: scoreData } = await supabase
        .from('leads')
        .select('final_score')
        .eq('user_id', userId)
        .not('final_score', 'is', null);

    const avgScore = scoreData?.length > 0
        ? (scoreData.reduce((sum, l) => sum + l.final_score, 0) / scoreData.length).toFixed(1)
        : 0;

    res.json({
        total_leads: totalLeads || 0,
        hot_leads: hotLeads || 0,
        warm_leads: warmLeads || 0,
        cold_leads: coldLeads || 0,
        messages_sent: messagesSent || 0,
        replies_received: repliesReceived || 0,
        response_rate: parseFloat(responseRate),
        average_score: parseFloat(avgScore),
    });
});

module.exports = { getMetrics };
