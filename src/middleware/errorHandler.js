const logger = require('../utils/logger');

/**
 * Global error handling middleware.
 * Must be registered LAST with app.use().
 */
function errorHandler(err, req, res, _next) {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    logger.error(`[${req.method}] ${req.originalUrl} — ${status}: ${message}`, {
        stack: err.stack,
        body: req.body,
    });

    res.status(status).json({
        error: {
            message,
            status,
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
        },
    });
}

/**
 * Wrap async route handlers to catch thrown errors.
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = { errorHandler, asyncHandler };
