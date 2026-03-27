const rateLimit = require('express-rate-limit');

// Rate limiting disabled by user request (infinite requests allowed)
const apiLimiter = (req, res, next) => next();
const webhookLimiter = (req, res, next) => next();
const authLimiter = (req, res, next) => next();

module.exports = { apiLimiter, webhookLimiter, authLimiter };
