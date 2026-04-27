require('dotenv').config();
const supabase = require('./src/config/supabase');

async function checkJobs() {
    const { data, error } = await supabase.auth.admin.updateUserById(
        'ace29861-f74e-4c24-be0a-cd05d2be1342',
        { password: 'pointvision24' }
    );
        
    if (error) {
        console.error('Error updating user:', error);
        return;
    }
    
    console.log('Password reset successfully for pointvision24@gmail.com');
}

checkJobs();
