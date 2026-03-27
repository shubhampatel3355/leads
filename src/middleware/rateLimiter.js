const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV === 'development';

/** Standard API rate limiter — 100 requests per 15 minutes (higher in dev) */
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 10000 : 100, // 10k in dev to prevent HMR blocks
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

/** Webhook rate limiter — more permissive, 60 per minute */
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests.' },
});

/** Strict limiter for auth endpoints — 10 per 15 minutes */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts.' },
});

module.exports = { apiLimiter, webhookLimiter, authLimiter };
