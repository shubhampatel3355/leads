const twilio = require('twilio');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Validate Twilio webhook signature.
 * Uses Twilio's official validateRequest() method.
 * Prevents forged/replayed webhook requests.
 * 
 * In production: ALWAYS validates. Rejects with 403 on failure.
 * In development: Skips only if TWILIO_AUTH_TOKEN is not set.
 */
function validateTwilioWebhook(req, res, next) {
    // Skip in dev if no auth token (sandbox testing)
    if (env.nodeEnv === 'development' && !env.twilio.authToken) {
        logger.warn('[webhook-validator] Twilio validation SKIPPED (dev mode, no auth token)');
        return next();
    }

    if (!env.twilio.authToken) {
        logger.error('[webhook-validator] TWILIO_AUTH_TOKEN not configured — cannot validate webhooks');
        return res.status(500).json({ error: 'Webhook validation not configured' });
    }

    // Twilio sends this header with every webhook request
    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
        logger.warn('[webhook-validator] Missing x-twilio-signature header');
        return res.status(403).json({ error: 'Missing webhook signature' });
    }

    // Build the full URL Twilio used to sign the request.
    let baseUrl = env.twilio.webhookUrl || env.webhookBaseUrl || `${req.protocol}://${req.headers.host}`;
    
    // If the user pasted the full endpoint in .env, strip it down to the base
    baseUrl = baseUrl.replace(/\/webhook\/whatsapp\/?$/, '');

    // In production behind a proxy like Coolify, force HTTPS to match what Twilio actually hit
    if (env.nodeEnv === 'production' && baseUrl.startsWith('http://')) {
        baseUrl = baseUrl.replace('http://', 'https://');
    }

    const url = `${baseUrl}${req.originalUrl}`;

    // Twilio signs over the POST body parameters
    const params = req.body || {};

    const isValid = twilio.validateRequest(
        env.twilio.authToken,
        signature,
        url,
        params
    );

    if (!isValid) {
        logger.warn(`[webhook-validator] Invalid Twilio signature for URL: ${url}`);
        return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    logger.debug('[webhook-validator] Twilio signature valid');
    next();
}

module.exports = { validateTwilioWebhook };
