require('dotenv').config({ path: './.env' });
const supabase = require('./src/config/supabase');

async function cleanupStuckCalls() {
    console.log(`Cleaning up ALL stuck 'initiated' records across all campaigns...`);
    
    // 1. Delete from calls table
    const { data: callsData, error: callsError } = await supabase
        .from('calls')
        .delete()
        .eq('status', 'initiated');
    
    if (callsError) {
        console.error('Error deleting from calls:', callsError.message);
    } else {
        console.log('Successfully cleared stuck records from calls table.');
    }

    // 2. Delete from conversations table (the ones showing in your UI)
    const { data: convData, error: convError } = await supabase
        .from('conversations')
        .delete()
        .eq('status', 'initiated')
        .eq('channel', 'call');
    
    if (convError) {
        console.error('Error deleting from conversations:', convError.message);
    } else {
        console.log('Successfully cleared stuck records from conversations table.');
    }

    console.log('\n--- NEXT STEPS ---');
    console.log('1. Ensure your production server (mavixy.com) is redeployed with the latest code.');
    console.log('2. Refresh your dashboard; the status should now show "Queued" instead of "Calling".');
    console.log('3. Click "Launch Campaign" again to re-run with the fixed webhook logic.');
}

cleanupStuckCalls();
