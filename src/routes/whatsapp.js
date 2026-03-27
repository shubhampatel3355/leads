const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/whatsappController');
const { validateTwilioWebhook } = require('../middleware/webhookValidator');
const { webhookLimiter } = require('../middleware/rateLimiter');

// POST /api/whatsapp/send — authenticated send
router.post('/send', auth, ctrl.sendMessage);

// POST /webhook/whatsapp — Twilio inbound message webhook
router.post('/whatsapp', webhookLimiter, validateTwilioWebhook, ctrl.webhookHandler);

// POST /webhook/whatsapp/status — Twilio status callback webhook
router.post('/whatsapp/status', webhookLimiter, validateTwilioWebhook, ctrl.statusCallbackHandler);

module.exports = router;
