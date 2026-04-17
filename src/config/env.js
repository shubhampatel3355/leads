require('dotenv').config();

const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_JWT_SECRET',
];

for (const key of required) {
    if (!process.env[key]) {
        console.warn(`⚠ Missing required env var: ${key}`);
    }
}

module.exports = {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    supabase: {
        url: process.env.SUPABASE_URL,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        jwtSecret: process.env.SUPABASE_JWT_SECRET,
    },


    openai: {
        apiKey: process.env.OPENAI_API_KEY,
        primaryModel: process.env.OPENAI_PRIMARY_MODEL || 'gpt-4o',
        fallbackModel: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini',
    },

    omniDimension: {
        apiKey: process.env.OMNIDIMENSION_API_KEY,
        agentId: process.env.OMNIDIMENSION_AGENT_ID,
        fromNumberId: process.env.OMNIDIMENSION_FROM_NUMBER_ID,
        webhookUrl: process.env.OMNIDIMENSION_WEBHOOK_URL,
    },

    worker: {
        pollMs: parseInt(process.env.WORKER_POLL_MS, 10) || 2000,
        concurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 3,
    },

    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    logLevel: process.env.LOG_LEVEL || 'info',
};
