const supabase = require('./src/config/supabase');

async function main() {
    const { data, error } = await supabase
        .from('leads')
        .select('id, name, fit_score, intent_score, final_score, classification')
        .eq('name', 'The Gardiose')
        .single();
        
    if (error) {
        console.error('Error fetching lead:', error);
    } else {
        console.log('Lead DB Record:', data);
    }
}

main();
