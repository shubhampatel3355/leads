const supabase = require('../src/config/supabase');

async function main() {
    console.log('Starting verification...');

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
    console.log('Using User ID:', userId);

    // 2. Insert a new lead
    const leadId = '00000000-0000-0000-0000-ffffffffffff'; // Hardcoded UUID for easy cleanup
    const leadData = {
        id: leadId,
        user_id: userId,
        name: 'Verification Test Lead',
        email: 'verify@example.com',
        phone: '+1234567890',
        company: 'Verification Inc',
        classification: 'warm', // Force warm to test Postgres Trigger!
        fit_score: 50,
    };

    // Cleanup first if exists
    await supabase.from('leads').delete().eq('id', leadId);
    await supabase.from('jobs').delete().match({ 'payload->>lead_id': leadId });

    console.log('Inserting lead...');
    const { data: newLead, error: insertErr } = await supabase
        .from('leads')
        .insert(leadData)
        .select()
        .single();

    if (insertErr) {
        console.error('Failed to insert lead:', insertErr);
        process.exit(1);
    }
    console.log('Lead inserted:', newLead.id);

    // 3. Wait 5 seconds for triggers/workers
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. Check jobs table
    console.log('Checking jobs table...');
    const { data: jobs, error: jobsErr } = await supabase
        .from('jobs')
        .select('*')
        .match({ 'payload->>lead_id': leadId });

    if (jobsErr) {
        console.error('Failed to query jobs:', jobsErr);
    } else {
        console.log(`Found ${jobs.length} jobs for this lead.`);
        if (jobs.length > 0) {
            console.log('Job Details:', jobs.map(j => ({ type: j.type, status: j.status })));
            console.log('❌ Verification FAILED: Call was triggered automatically!');
        } else {
            console.log('✅ Verification PASSED: No call triggered automatically.');
        }
    }

    // 5. Cleanup
    console.log('Cleaning up...');
    await supabase.from('leads').delete().eq('id', leadId);
    await supabase.from('jobs').delete().match({ 'payload->>lead_id': leadId });
    console.log('Done.');
}

main().catch(console.error);
