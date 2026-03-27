const supabase = require('../config/supabase');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/settings
 * Fetch user settings (scoring rules, templates, etc.)
 */
const getSettings = asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('settings')
        .select('*')
        .eq('user_id', req.user.id)
        .single();

    if (error && error.code !== 'PGRST116') { // Not "no rows" error
        throw new Error(`Failed to fetch settings: ${error.message}`);
    }

    // Return defaults if no settings exist
    if (!data) {
        return res.json(getDefaultSettings(req.user.id));
    }

    res.json(data);
});

/**
 * POST /api/settings
 * Update user settings.
 */
const updateSettings = asyncHandler(async (req, res) => {
    const { scoring_rules, whatsapp_template, integrations } = req.body;

    const updates = {
        user_id: req.user.id,
        updated_at: new Date().toISOString(),
    };

    if (scoring_rules) updates.scoring_rules = scoring_rules;
    if (whatsapp_template !== undefined) updates.whatsapp_template = whatsapp_template;
    if (integrations) updates.integrations = integrations;

    // Upsert — insert if not exists, update if exists
    const { data, error } = await supabase
        .from('settings')
        .upsert(updates, { onConflict: 'user_id' })
        .select()
        .single();

    if (error) throw new Error(`Failed to update settings: ${error.message}`);

    res.json({ message: 'Settings updated', data });
});

function getDefaultSettings(userId) {
    return {
        user_id: userId,
        scoring_rules: [
            { property: 'Job Title', condition: 'Contains', value: 'Manager', points: 10 },
            { property: 'Company Size', condition: 'Equals', value: 'Enterprise', points: 25 },
        ],
        whatsapp_template: 'Hi {FirstName},\n\nI noticed that {Company} is currently scaling its sales operations. I\'d love to share how we\'ve helped similar enterprises automate lead qualification.',
        integrations: {
            hubspot: { enabled: false, api_key: null },
            salesforce: { enabled: false, api_key: null },
        },
    };
}

module.exports = { getSettings, updateSettings };
