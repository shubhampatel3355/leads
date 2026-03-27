const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/metricsController');

// GET /api/metrics
router.get('/', auth, ctrl.getMetrics);

module.exports = router;
