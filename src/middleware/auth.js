const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Authentication middleware — validates Supabase JWT.
 * Attaches user info to req.user.
 */
async function auth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
            });
        }

        const token = authHeader.split(' ')[1];

        // Create a temporary client to validate the token
        const supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            logger.warn('Auth failed:', error?.message || 'No user found');
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid or expired token',
            });
        }

        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
        };

        next();
    } catch (err) {
        logger.error('Auth middleware error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = auth;
