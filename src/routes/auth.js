const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile from the JWT.
 * Used by the frontend to verify session validity.
 */
router.get('/me', auth, asyncHandler(async (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            email: req.user.email,
            role: req.user.role,
        },
    });
}));

module.exports = router;
