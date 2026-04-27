const supabase = require('../config/supabase');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/dashboard/stats
 * comprehensive stats for the dashboard:
 * - Metrics (total, hot, response rate, conversion rate)
 * - Recent Activity Feed (mixed stream)
 * - Recent Qualified Leads
 * - 7-Day Trend Chart Data (Calls & Interactions)
 */
/**
 * GET /api/dashboard/stats
 * comprehensive stats for the dashboard
 */
/**
 * GET /api/dashboard/stats
 * comprehensive stats for the dashboard
 */
const getStats = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    // Client-side persistence fallback: Accept clearAt as a query param
    const clearAt = req.query.clearAt || '1970-01-01T00:00:00Z';

    // Parallel fetch for metrics
    const [
        { count: totalLeads },
        { count: hotLeads },
        { count: warmLeads },
    ] = await Promise.all([
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('classification', 'hot'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('classification', 'warm'),
    ]);

    // Fetch recent qualified leads (unfiltered)
    const { data: recentQualified } = await supabase
        .from('leads')
        .select('id, name, company, job_title, fit_score, intent_score, final_score, status:classification, updated_at')
        .eq('user_id', userId)
        .in('classification', ['hot', 'warm'])
        .order('updated_at', { ascending: false })
        .limit(8);

    // Activity Feed Aggregation (FILTERED by clearAt)
    const [
        { data: newLeads },
        { data: inboundMessages },
        { data: analyses }
    ] = await Promise.all([
        supabase.from('leads').select('id, name, created_at').eq('user_id', userId).gt('created_at', clearAt).order('created_at', { ascending: false }).limit(5),
        supabase.from('conversations').select('id, lead_id, body, created_at, leads!inner(name, user_id)').eq('leads.user_id', userId).eq('direction', 'inbound').gt('created_at', clearAt).order('created_at', { ascending: false }).limit(5),
        supabase.from('lead_analyses').select('id, lead_id, result, created_at, leads!inner(name, user_id)').eq('leads.user_id', userId).gt('created_at', clearAt).order('created_at', { ascending: false }).limit(5)
    ]);

    const activities = [
        ...(newLeads || []).map(l => ({
            type: 'new_lead',
            text: `New lead created: ${l.name}`,
            time: l.created_at,
            lead_id: l.id
        })),
        ...(inboundMessages || []).map(m => ({
            type: 'reply',
            text: `${m.leads.name} replied: "${m.body.substring(0, 30)}${m.body.length > 30 ? '...' : ''}"`,
            time: m.created_at,
            lead_id: m.lead_id
        })),
        ...(analyses || []).map(a => ({
            type: 'analysis',
            text: `AI analyzed ${a.leads.name}`,
            time: a.created_at,
            lead_id: a.lead_id
        }))
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8);

    // Rate calculations
    const total = totalLeads || 0;
    const hot = hotLeads || 0;
    const warm = warmLeads || 0;
    const conversionRate = total > 0 ? ((hot / total) * 100).toFixed(1) : '0.0';
    const qualificationRate = total > 0 ? (((hot + warm) / total) * 100).toFixed(1) : '0.0';

    // Chart Trend Logic
    const chartData = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().split('T')[0];
        chartData.push({
            date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            fullDate: dayStr,
            calls: 0,
            interactions: 0
        });
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
        { data: trendCalls },
        { data: trendConvos }
    ] = await Promise.all([
        supabase.from('calls').select('created_at, leads!inner(user_id)').eq('leads.user_id', userId).gte('created_at', sevenDaysAgo.toISOString()),
        supabase.from('conversations').select('created_at, leads!inner(user_id)').eq('leads.user_id', userId).gte('created_at', sevenDaysAgo.toISOString())
    ]);

    (trendCalls || []).forEach(c => {
        const day = c.created_at.split('T')[0];
        const slot = chartData.find(s => s.fullDate === day);
        if (slot) slot.calls++;
    });
    (trendConvos || []).forEach(c => {
        const day = c.created_at.split('T')[0];
        const slot = chartData.find(s => s.fullDate === day);
        if (slot) slot.interactions++;
    });

    res.json({
        metrics: {
            totalLeads: total,
            hotLeads: hot,
            conversionRate: `${conversionRate}%`,
            responseRate: `${qualificationRate}%`
        },
        recentQualified: recentQualified || [],
        activities,
        chartData
    });
});

/**
 * POST /api/dashboard/clear
 * Dummy endpoint for success (persistence is handled by client localStorage).
 */
const clearActivities = asyncHandler(async (req, res) => {
    res.json({ message: 'Clear requested', clearedAt: new Date().toISOString() });
});

module.exports = { getStats, clearActivities };

