const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/voiceController');
const { webhookLimiter } = require('../middleware/rateLimiter');

// POST /api/calls/initiate — authenticated
router.post('/initiate', auth, ctrl.initiateCall);

// POST /webhook/call-ended — Bland AI webhook
router.post('/call-ended', webhookLimiter, ctrl.callEndedWebhook);

module.exports = router;
