const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/settingsController');

// GET /api/settings
router.get('/', auth, ctrl.getSettings);

// POST /api/settings
router.post('/', auth, ctrl.updateSettings);

module.exports = router;
