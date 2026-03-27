const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/conversationsController');

// GET /api/conversations/threads — list all conversation threads
router.get('/threads', auth, ctrl.getThreads);

// GET /api/conversations?lead_id=xxx
router.get('/', auth, ctrl.getConversations);

module.exports = router;
