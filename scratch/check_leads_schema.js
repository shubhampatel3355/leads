const supabase = require('../src/config/supabase');
require('dotenv').config();

async function checkLeadsSchema() {
    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .limit(1);
    
    if (error) {
        console.error('Error:', error.message);
    } else {
        console.log('Leads Columns:', Object.keys(data[0] || {}));
        console.log('Sample Lead:', data[0]);
    }
}

checkLeadsSchema().catch(console.error);
