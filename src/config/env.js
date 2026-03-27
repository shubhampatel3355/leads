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

    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
        webhookUrl: process.env.TWILIO_WEBHOOK_URL || '',
    },

    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY,
        primaryModel: process.env.OPENROUTER_PRIMARY_MODEL || 'anthropic/claude-sonnet-4',
        fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'openai/gpt-4o-mini',
    },

    bland: {
        apiKey: process.env.BLAND_API_KEY,
        webhookUrl: process.env.BLAND_WEBHOOK_URL,
    },

    worker: {
        pollMs: parseInt(process.env.WORKER_POLL_MS, 10) || 2000,
        concurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 3,
    },

    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    logLevel: process.env.LOG_LEVEL || 'info',
};
