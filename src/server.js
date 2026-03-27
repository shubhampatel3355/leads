const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const { getJobStats } = require('./config/jobQueue');

// ─── Route Imports ────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const leadsRoutes = require('./routes/leads');
const conversationsRoutes = require('./routes/conversations');
const whatsappRoutes = require('./routes/whatsapp');
const voiceRoutes = require('./routes/voice');
const metricsRoutes = require('./routes/metrics');
const settingsRoutes = require('./routes/settings');

// ─── Express App ──────────────────────────────────────────────
const app = express();

// ─── Global Middleware ────────────────────────────────────────
app.set('trust proxy', 1); // Trust first proxy (ngrok, load balancer, etc.)

// Enable CORS before other middleware that might set security headers
app.use(cors({
    origin: env.nodeEnv === 'production' ? [env.frontendUrl] : true,
    credentials: true,
}));

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
logger.info(`CORS allowed origins: ${process.env.FRONTEND_URL || 'http://localhost:5173'}, http://127.0.0.1:5173`);
app.use(morgan('short'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ────────────────────────────────────────────
app.use('/api/', apiLimiter);

// ─── Health Check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
    try {
        const supabase = require('./config/supabase');
        // Verify DB connectivity
        const { error: dbErr } = await supabase.from('leads').select('id').limit(1);

        // Get job queue stats
        const jobStats = await getJobStats();

        res.json({
            status: dbErr ? 'degraded' : 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            env: env.nodeEnv,
            database: dbErr ? 'error' : 'connected',
            jobQueue: jobStats,
        });
    } catch (err) {
        res.status(503).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: err.message,
        });
    }
});

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/calls', voiceRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', require('./routes/dashboard'));

// ─── Admin Routes ─────────────────────────────────────────────
const { getFailedJobs } = require('./config/jobQueue');

app.get('/api/admin/jobs/failed', async (req, res) => {
    try {
        const jobs = await getFailedJobs(parseInt(req.query.limit) || 50);
        res.json({ failed_jobs: jobs, count: jobs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/jobs/stats', async (req, res) => {
    try {
        const stats = await getJobStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Webhook Routes (no auth, validated by signature) ─────────
const whatsappWebhook = require('./controllers/whatsappController');
const voiceWebhook = require('./controllers/voiceController');
const { webhookLimiter } = require('./middleware/rateLimiter');
const { validateTwilioWebhook } = require('./middleware/webhookValidator');

app.post('/webhook/whatsapp', webhookLimiter, validateTwilioWebhook, whatsappWebhook.webhookHandler);
app.post('/webhook/whatsapp/status', webhookLimiter, validateTwilioWebhook, whatsappWebhook.statusCallbackHandler);
app.post('/webhook/call-ended', webhookLimiter, voiceWebhook.callEndedWebhook);

// ─── 404 Handler ──────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ─── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────
const server = app.listen(env.port, "0.0.0.0", () => {
    logger.info(`LeadForge backend running on port ${env.port} (${env.nodeEnv})`);
    logger.info(`Health: http://localhost:${env.port}/health`);
    logger.info(`Worker: run "node src/worker.js" in a separate terminal`);
});

// ─── Graceful Shutdown ────────────────────────────────────────
function shutdown(signal) {
    logger.info(`${signal} received. Shutting down gracefully...`);

    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });

    setTimeout(() => {
        logger.warn('Forced shutdown');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err.message, err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
});

module.exports = app;
