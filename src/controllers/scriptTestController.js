const { adaptLeadScript } = require('../services/aiService');

exports.testScriptProcessor = async (req, res) => {
    try {
        const { default_script, lead_name, linkedin_url, linkedin_data_summary } = req.body;
        const result = await adaptLeadScript({ default_script, lead_name, linkedin_url, linkedin_data_summary });
        res.json({ result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
