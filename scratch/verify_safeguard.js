const supabase = require('../src/config/supabase');
const { handlers } = require('../src/workers/jobHandlers');

async function main() {
    console.log('Starting campaign status safeguard verification...');

    // 1. Get a valid user_id from an existing lead
    const { data: existingLeads, error: leadErr } = await supabase
        .from('leads')
        .select('user_id')
        .limit(1);

    if (leadErr || !existingLeads || existingLeads.length === 0) {
        console.error('Failed to find an existing lead for user_id:', leadErr);
        process.exit(1);
    }
    const userId = existingLeads[0].user_id;

    // 2. Create a test campaign (status: active)
    const campaignId = '00000000-0000-0000-0000-cccccccccccc';
    await supabase.from('campaigns').delete().eq('id', campaignId);
    
    const { data: campaign, error: campErr } = await supabase
        .from('campaigns')
        .insert({
            id: campaignId,
            user_id: userId,
            name: 'Safeguard Test Campaign',
            status: 'active', // NOT running
        })
        .select()
        .single();

    if (campErr) {
        console.error('Failed to create campaign:', campErr);
        process.exit(1);
    }
    console.log('Campaign created.');

    // 3. Insert a new lead assigned to this campaign
    const leadId = '00000000-0000-0000-0000-dddddddddddd';
    const leadData = {
        id: leadId,
        user_id: userId,
        name: 'Direct Safeguard Test Lead',
        phone: '+1234567890',
        campaign_id: campaignId,
    };

    await supabase.from('leads').delete().eq('id', leadId);
    await supabase.from('leads').insert(leadData);
    console.log('Lead inserted.');

    // 4. Call handler directly
    console.log('Calling handleAiCallInitiate directly...');
    try {
        const result = await handlers['ai-call-initiate']({ lead_id: leadId, phone: leadData.phone });
        console.log('Result:', result);
        
        if (result.skipped === true && result.reason === 'campaign_not_running') {
            console.log('✅ Verification PASSED: Call skipped because campaign not running.');
        } else {
            console.log('❌ Verification FAILED: Call not skipped as expected!');
        }
    } catch (err) {
        console.error('Error calling handler:', err.message);
    }

    // 5. Cleanup
    await supabase.from('leads').delete().eq('id', leadId);
    await supabase.from('campaigns').delete().eq('id', campaignId);
    console.log('Done.');
}

main().catch(console.error);
