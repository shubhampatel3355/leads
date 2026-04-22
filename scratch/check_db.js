const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    console.log('Checking database counts for campaigns...');
    
    const { data: camps, error: campErr } = await supabase.from('campaigns').select('id, name');
    if (campErr) return console.error('Camp error:', campErr);
    
    for (const c of camps) {
        console.log(`\n--- Campaign: ${c.name} (${c.id}) ---`);
        
        // Count from leads mapping (join table)
        const { count: leadsMappingCount } = await supabase
            .from('campaign_leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', c.id);
        console.log(`Leads in campaign_leads: ${leadsMappingCount}`);

        // Count directly from leads table
        const { count: leadsTableCount } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', c.id);
        console.log(`Leads in leads table (campaign_id col): ${leadsTableCount}`);
        
        // Count calls
        const { count: callsCount } = await supabase
            .from('conversations')
            .select('*', { count: 'exact', head: true })
            .eq('channel', 'call')
            .eq('campaign_id', c.id);
        console.log(`Calls in conversations: ${callsCount}`);
        
        // Count calls (no campaign_id)
        const { count: totalCalls } = await supabase
            .from('conversations')
            .select('*', { count: 'exact', head: true })
            .eq('channel', 'call');
        console.log(`Global total calls: ${totalCalls}`);
    }
}

check();
