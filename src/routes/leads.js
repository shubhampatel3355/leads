const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/leadsController');

// POST /api/leads/upload — queue lead processing from Supabase Storage path
router.post('/upload', auth, ctrl.uploadLeads);

// GET /api/leads/uploads — batch upload history
router.get('/uploads', auth, ctrl.getUploadHistory);

// GET /api/leads/uploads/:id — single batch status
router.get('/uploads/:id', auth, ctrl.getUploadStatus);

// DELETE /api/leads/uploads/:id — delete batch + storage file
router.delete('/uploads/:id', auth, ctrl.deleteUpload);

// POST /api/leads — manually create a single lead
router.post('/', auth, ctrl.createLead);

// GET /api/leads — paginated list
router.get('/', auth, ctrl.getLeads);

// GET /api/leads/:id — single lead
router.get('/:id', auth, ctrl.getLeadById);

// GET /api/leads/:id/analysis — latest AI analysis
router.get('/:id/analysis', auth, ctrl.getLeadAnalysis);

// POST /api/leads/:id/rescore — re-score a lead
router.post('/:id/rescore', auth, ctrl.rescoreLead);

// PUT /api/leads/:id — update lead fields
router.put('/:id', auth, ctrl.updateLead);

// DELETE /api/leads/:id — delete a lead
router.delete('/:id', auth, ctrl.deleteLead);

module.exports = router;
