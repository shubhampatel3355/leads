require('dotenv').config();
const { adaptLeadScript } = require('../src/services/aiService');

async function test() {
    const default_script = "Hi [Name], I saw your company is growing. Are you interested in our software? We help teams move faster and scale without the usual growing pains. Let me know if you have 5 minutes to chat.";

    console.log("=== Path A: No LinkedIn Data ===");
    const resultA = await adaptLeadScript({
        default_script,
        lead_name: "Sarah",
        linkedin_url: null,
        linkedin_data_summary: null
    });
    console.log(resultA);
    console.log("\n--------------------------------------------------\n");

    console.log("=== Path B: LinkedIn Data Available ===");
    const resultB = await adaptLeadScript({
        default_script,
        lead_name: "Alex",
        linkedin_url: "https://linkedin.com/in/alex",
        linkedin_data_summary: "Alex was recently promoted to VP of Engineering at TechCorp after successfully leading their enterprise cloud migration strategy over the past 2 years."
    });
    console.log(resultB);
    console.log("\n--------------------------------------------------\n");
}

test().catch(console.error);
