const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/dashboardController');

// GET /api/dashboard/stats — comprehensive dashboard stats
router.get('/stats', auth, ctrl.getStats);

// POST /api/dashboard/clear — clear activity feed
router.post('/clear', auth, ctrl.clearActivities);

module.exports = router;
