const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const ctrl = require('../controllers/enrichmentController');

// All routes require authentication
router.use(authenticate);

// POST /api/enrichment/start — upload file + start job
router.post('/start', ctrl.upload.single('file'), ctrl.startEnrichment);

// GET /api/enrichment/:jobId — progress
router.get('/:jobId', ctrl.getJobProgress);

// GET /api/enrichment/:jobId/rows — paginated row list
router.get('/:jobId/rows', ctrl.getJobRows);

// GET /api/enrichment/:jobId/download?format=csv|xlsx&min_confidence=0
router.get('/:jobId/download', ctrl.downloadEnrichedFile);

// POST /api/enrichment/:jobId/retry-failed
router.post('/:jobId/retry-failed', ctrl.retryFailed);

module.exports = router;
