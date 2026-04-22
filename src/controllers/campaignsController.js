const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { enqueue } = require('../config/jobQueue');

// GET /api/campaigns
async function getCampaigns(req, res) {
    try {
        const { data: campaigns, error } = await supabase
            .from('campaigns')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Fetch stats for all campaigns in parallel
        const enriched = await Promise.all((campaigns || []).map(async (camp) => {
            try {
                // Get lead counts directly from leads table using campaign_id column
                const { data: leads } = await supabase
                    .from('leads')
                    .select('id, classification')
                    .eq('campaign_id', camp.id)
                    .eq('user_id', req.user.id);
                
                // Get call entries to count unique leads and total dials
                const { data: conversations, error: convErr } = await supabase
                    .from('conversations')
                    .select('id, lead_id')
                    .eq('channel', 'call')
                    .eq('campaign_id', camp.id);
                
                if (convErr) logger.error(`Conversations fetch error for ${camp.id}:`, convErr);

                const totalCalls = conversations?.length || 0;
                const uniqueLeadsCalled = conversations?.length > 0 
                  ? new Set(conversations.map(c => c.lead_id).filter(id => !!id)).size 
                  : 0;

                const { count: callsCompleted } = await supabase
                    .from('conversations')
                    .select('*', { count: 'exact', head: true })
                    .eq('channel', 'call')
                    .eq('campaign_id', camp.id)
                    .eq('status', 'completed');

                // Get last call time
                const { data: lastCall } = await supabase
                    .from('conversations')
                    .select('created_at')
                    .eq('channel', 'call')
                    .eq('campaign_id', camp.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                const convertedLeads = (leads || []).filter(l => l.classification === 'hot' || l.classification === 'warm').length;

                return {
                    ...camp,
                    stats: {
                        total_leads: leads?.length || 0,
                        calls_made: totalCalls,
                        leads_called: uniqueLeadsCalled || (totalCalls > 0 ? 1 : 0), // Fallback to 1 if calls exist but ID mapping failed
                        calls_completed: callsCompleted || 0,
                        converted: convertedLeads,
                        conversion_rate: (leads?.length || 0) > 0 ? Math.round((convertedLeads / leads.length) * 100) : 0,
                        last_call_at: lastCall?.created_at || null
                    }
                };
            } catch (err) {
                logger.warn(`Failed to fetch stats for campaign ${camp.id}: ${err.message}`);
                return camp;
            }
        }));

        res.json({ campaigns: enriched });
    } catch (err) {
        logger.error(`Error fetching campaigns: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// GET /api/campaigns/:id
async function getCampaign(req, res) {
    try {
        const { id } = req.params;
        const { data: campaign, error } = await supabase
            .from('campaigns')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .single();

        if (error || !campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        // Fetch stats if needed
        const { count: leadsCount } = await supabase
            .from('leads')
            .select('*, campaign_leads!inner(campaign_id)', { count: 'exact', head: true })
            .eq('campaign_leads.campaign_id', id);

        res.json({ campaign, stats: { leadsCount } });
    } catch (err) {
        logger.error(`Error fetching campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// POST /api/campaigns
async function createCampaign(req, res) {
    try {
        const { name, prompt_script, status, meta } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Campaign name is required' });
        }

        const payload = {
            user_id: req.user.id,
            name,
            prompt_script: prompt_script || '',
            status: status || 'active',
        };

        // Include meta if the column exists (added via migration)
        if (meta !== undefined) payload.meta = meta;

        const { data, error } = await supabase
            .from('campaigns')
            .insert(payload)
            .select()
            .single();

        if (error) {
            // If meta column doesn't exist yet, retry without it
            if (error.code === '42703' && meta !== undefined) {
                logger.warn('meta column not found, inserting without meta. Run migration to add it.');
                delete payload.meta;
                const { data: data2, error: err2 } = await supabase
                    .from('campaigns')
                    .insert(payload)
                    .select()
                    .single();
                if (err2) throw err2;
                logger.info(`Created campaign (no meta): ${data2.id}`);
                return res.status(201).json({ campaign: data2 });
            }
            throw error;
        }
        
        logger.info(`Created campaign: ${data.id}`);
        res.status(201).json({ campaign: data });
    } catch (err) {
        logger.error(`Error creating campaign: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// PUT /api/campaigns/:id
async function updateCampaign(req, res) {
    try {
        const { id } = req.params;
        const { name, prompt_script, status, meta } = req.body;
        
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (prompt_script !== undefined) updates.prompt_script = prompt_script;
        if (status !== undefined) updates.status = status;
        if (meta !== undefined) updates.meta = meta;
        updates.updated_at = new Date().toISOString();

        const { data, error } = await supabase
            .from('campaigns')
            .update(updates)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) {
            // If meta column doesn't exist yet, retry without it
            if (error.code === '42703' && meta !== undefined) {
                logger.warn('meta column not found, updating without meta.');
                delete updates.meta;
                const { data: data2, error: err2 } = await supabase
                    .from('campaigns')
                    .update(updates)
                    .eq('id', id)
                    .eq('user_id', req.user.id)
                    .select()
                    .single();
                if (err2) throw err2;
                return res.json({ campaign: data2 });
            }
            throw error;
        }
        res.json({ campaign: data });
    } catch (err) {
        logger.error(`Error updating campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// DELETE /api/campaigns/:id
async function deleteCampaign(req, res) {
    try {
        const { id } = req.params;
        
        const { error } = await supabase
            .from('campaigns')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        logger.error(`Error deleting campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getCampaigns,
    getCampaign,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    launchCampaign,
    pauseCampaign,
    resumeCampaign,
    getCampaignLeads,
    getCampaignCalls,
    getCampaignAnalytics,
    initiateBulkCalls,
};

// ─── POST /api/campaigns/:id/launch ───────────────────────────
async function launchCampaign(req, res) {
    try {
        const { id } = req.params;

        // Verify ownership
        const { data: campaign, error: campErr } = await supabase
            .from('campaigns')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .single();

        if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });
        
        // Allowed to launch even if already 'running' to handle recoveries or re-queuing
        // Only error if it's truly not found

        // Fetch all leads assigned to this campaign that have a phone number
        const { data: leads, error: leadsErr } = await supabase
            .from('leads')
            .select('id, name, phone, company, campaign_leads!inner(campaign_id)')
            .eq('campaign_leads.campaign_id', id)
            .eq('user_id', req.user.id)
            .not('phone', 'is', null);

        if (leadsErr) throw leadsErr;

        if (!leads || leads.length === 0) {
            return res.status(400).json({ error: 'No leads with phone numbers assigned to this campaign. Assign leads first.' });
        }

        // Queue one ai-call-initiate job per lead
        let queued = 0;
        for (const lead of leads) {
            try {
                await enqueue('ai-call-initiate', {
                    lead_id: lead.id,
                    phone: lead.phone,
                    campaign_id: id,
                    prompt_script: campaign.prompt_script || null,
                    bypassDuplicateCheck: true,
                });
                queued++;
            } catch (qErr) {
                logger.warn(`Failed to queue call for lead ${lead.id}: ${qErr.message}`);
            }
        }

        // Update campaign status and reset launch timestamp
        const now = new Date().toISOString();
        const { error: updateErr } = await supabase
            .from('campaigns')
            .update({
                status: 'running',
                launched_at: now,
                total_leads_targeted: leads.length,
                updated_at: now,
            })
            .eq('id', id);

        if (updateErr) logger.warn('Failed to update campaign status to running:', updateErr.message);

        logger.info(`Campaign ${id} launched: ${queued}/${leads.length} jobs queued`);
        res.json({
            success: true,
            message: `Campaign launched. ${queued} calls queued.`,
            leads_targeted: leads.length,
            jobs_queued: queued,
        });
    } catch (err) {
        logger.error(`Error launching campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── POST /api/campaigns/:id/pause ────────────────────────────
async function pauseCampaign(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('campaigns')
            .update({ status: 'paused', paused_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        logger.info(`Campaign ${id} paused`);
        res.json({ success: true, status: 'paused' });
    } catch (err) {
        logger.error(`Error pausing campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── POST /api/campaigns/:id/resume ───────────────────────────
async function resumeCampaign(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('campaigns')
            .update({ status: 'running', paused_at: null, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        logger.info(`Campaign ${id} resumed`);
        res.json({ success: true, status: 'running' });
    } catch (err) {
        logger.error(`Error resuming campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── GET /api/campaigns/:id/leads ─────────────────
async function getCampaignLeads(req, res) {
    try {
        const { id } = req.params;
        // Fetch campaign to get launch time for filtering stale call data
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('launched_at')
            .eq('id', id)
            .single();

        const { data: leads, error } = await supabase
            .from('leads')
            .select('id, name, phone, company, industry, classification, fit_score, intent_score, final_score, status, created_at, campaign_leads!inner(campaign_id)')
            .eq('campaign_leads.campaign_id', id)
            .eq('user_id', req.user.id)
            .order('final_score', { ascending: false });

        if (error) throw error;

        // For each lead, get latest call status from conversations, but only after campaign launch
        const leadIds = (leads || []).map(l => l.id);
        let callMap = {};
        if (leadIds.length > 0 && campaign?.launched_at) {
            // Strict isolation: ONLY show calls explicitly tagged with this campaign_id
            const { data: convos } = await supabase
                .from('conversations')
                .select('lead_id, status, created_at, metadata, campaign_id')
                .eq('channel', 'call')
                .in('lead_id', leadIds)
                .eq('campaign_id', id)
                .order('created_at', { ascending: false });

            if (convos) {
                for (const c of convos) {
                    if (!callMap[c.lead_id]) callMap[c.lead_id] = c;
                }
            }
        }

        const enriched = (leads || []).map(lead => ({
            ...lead,
            call_status: callMap[lead.id]?.status || 'not_called',
            last_called_at: callMap[lead.id]?.created_at || null,
        }));

        res.json({ leads: enriched, total: enriched.length });
    } catch (err) {
        logger.error(`Error fetching campaign leads ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── GET /api/campaigns/:id/calls ─────────────────────────────
async function getCampaignCalls(req, res) {
    try {
        const { id } = req.params;

        // Get all leads in campaign, then their conversations
        const { data: leads, error: leadsErr } = await supabase
            .from('leads')
            .select('id, name, phone, company, classification, campaign_leads!inner(campaign_id)')
            .eq('campaign_leads.campaign_id', id)
            .eq('user_id', req.user.id);

        if (leadsErr) throw leadsErr;

        if (!leads || leads.length === 0) return res.json({ calls: [] });

        const leadIds = leads.map(l => l.id);
        const leadMap = Object.fromEntries(leads.map(l => [l.id, l]));

        // Fetch campaign to get launch time
        const { data: campaign } = await supabase.from('campaigns').select('launched_at').eq('id', id).single();

        let query = supabase
            .from('conversations')
            .select('*')
            .eq('channel', 'call')
            .in('lead_id', leadIds);
        
        if (campaign?.launched_at) {
            // Strict isolation: ONLY show calls explicitly tagged with this campaign_id
            query = query.eq('campaign_id', id);
        } else {
             // If not launched, show no calls
            return res.json({ calls: [], total: 0 });
        }

        const { data: convos, error: convosErr } = await query.order('created_at', { ascending: false });

        if (convosErr) throw convosErr;

        const calls = (convos || []).map(c => ({
            ...c,
            lead_name: leadMap[c.lead_id]?.name || 'Unknown',
            lead_phone: leadMap[c.lead_id]?.phone || '',
            lead_company: leadMap[c.lead_id]?.company || '',
            lead_classification: leadMap[c.lead_id]?.classification || 'cold',
        }));

        res.json({ calls, total: calls.length });
    } catch (err) {
        logger.error(`Error fetching campaign calls ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── GET /api/campaigns/:id/analytics ─────────────────────────
async function getCampaignAnalytics(req, res) {
    try {
        const { id } = req.params;

        const { data: campaign } = await supabase
            .from('campaigns')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .single();

        const { data: leads } = await supabase
            .from('leads')
            .select('id, classification, fit_score, intent_score, final_score, campaign_leads!inner(campaign_id)')
            .eq('campaign_leads.campaign_id', id)
            .eq('user_id', req.user.id);

        const leadIds = (leads || []).map(l => l.id);

        const { data: convos } = await supabase
            .from('conversations')
            .select('lead_id, status, metadata, created_at')
            .eq('channel', 'call')
            .in('lead_id', leadIds.length > 0 ? leadIds : ['00000000-0000-0000-0000-000000000000']);

        const { data: analyses } = await supabase
            .from('lead_analyses')
            .select('lead_id, result')
            .in('lead_id', leadIds.length > 0 ? leadIds : ['00000000-0000-0000-0000-000000000000']);

        const totalLeads = (leads || []).length;
        const callsMade = (convos || []).length;
        const callsCompleted = (convos || []).filter(c => c.status === 'completed').length;

        // Classification breakdown
        const classBreakdown = { hot: 0, warm: 0, cold: 0 };
        (leads || []).forEach(l => { if (classBreakdown[l.classification] !== undefined) classBreakdown[l.classification]++; });

        // Intent from analyses
        const intentBreakdown = { interested: 0, not_interested: 0, callback: 0, unknown: 0 };
        (analyses || []).forEach(a => {
            try {
                const result = typeof a.result === 'string' ? JSON.parse(a.result) : a.result;
                const intent = (result?.buying_intent || '').toLowerCase();
                if (intent.includes('high') || intent.includes('interested')) intentBreakdown.interested++;
                else if (intent.includes('low') || intent.includes('not')) intentBreakdown.not_interested++;
                else if (intent.includes('medium') || intent.includes('callback')) intentBreakdown.callback++;
                else intentBreakdown.unknown++;
            } catch { intentBreakdown.unknown++; }
        });

        // Score distribution
        const avgFit = leads?.length ? Math.round(leads.reduce((s, l) => s + (l.fit_score || 0), 0) / leads.length) : 0;
        const avgIntent = leads?.length ? Math.round(leads.reduce((s, l) => s + (l.intent_score || 0), 0) / leads.length) : 0;
        const avgFinal = leads?.length ? Math.round(leads.reduce((s, l) => s + (l.final_score || 0), 0) / leads.length) : 0;

        res.json({
            campaign: { id, name: campaign?.name, status: campaign?.status, launched_at: campaign?.launched_at },
            summary: {
                total_leads: totalLeads,
                calls_made: callsMade,
                calls_completed: callsCompleted,
                pick_up_rate: callsMade > 0 ? Math.round((callsCompleted / callsMade) * 100) : 0,
                converted: classBreakdown.hot,
                conversion_rate: totalLeads > 0 ? Math.round((classBreakdown.hot / totalLeads) * 100) : 0,
            },
            classification_breakdown: classBreakdown,
            intent_breakdown: intentBreakdown,
            avg_scores: { fit: avgFit, intent: avgIntent, final: avgFinal },
        });
    } catch (err) {
        logger.error(`Error fetching campaign analytics ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

// ─── POST /api/campaigns/:id/initiate-calls ──────────────────
async function initiateBulkCalls(req, res) {
    try {
        const { id } = req.params;
        const { leadIds } = req.body;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ error: 'No leadIds provided' });
        }

        // Verify ownership
        const { data: campaign, error: campErr } = await supabase
            .from('campaigns')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .single();

        if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

        // Fetch selected leads assigned to this campaign
        const { data: leads, error: leadsErr } = await supabase
            .from('leads')
            .select('id, name, phone, company, campaign_leads!inner(campaign_id)')
            .eq('campaign_leads.campaign_id', id)
            .eq('user_id', req.user.id)
            .in('id', leadIds)
            .not('phone', 'is', null);

        if (leadsErr) throw leadsErr;

        if (!leads || leads.length === 0) {
            return res.status(400).json({ error: 'Selected leads not found or have no phone numbers.' });
        }

        // Queue one ai-call-initiate job per selected lead
        let queued = 0;
        for (const lead of leads) {
            try {
                await enqueue('ai-call-initiate', {
                    lead_id: lead.id,
                    phone: lead.phone,
                    campaign_id: id,
                    prompt_script: campaign.prompt_script || null,
                    bypassDuplicateCheck: true,
                });
                queued++;
            } catch (qErr) {
                logger.warn(`Failed to queue callback for lead ${lead.id}: ${qErr.message}`);
            }
        }

        // Update campaign status to running and ensure launched_at is set
        const campUpdates = { status: 'running', updated_at: new Date().toISOString() };
        if (!campaign.launched_at) {
            campUpdates.launched_at = new Date().toISOString();
        }

        await supabase
            .from('campaigns')
            .update(campUpdates)
            .eq('id', id);

        logger.info(`Manual callback initiated for ${queued} leads in campaign ${id}`);
        res.json({
            success: true,
            message: `${queued} callbacks queued successfully.`,
            jobs_queued: queued,
        });
    } catch (err) {
        logger.error(`Error initiating callbacks for campaign ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}
