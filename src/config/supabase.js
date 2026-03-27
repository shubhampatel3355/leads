const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Service-role client — full admin access, backend only
const supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

module.exports = supabase;
