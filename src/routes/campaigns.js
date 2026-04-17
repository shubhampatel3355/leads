const express = require('express');
const router = express.Router();
const campaignsController = require('../controllers/campaignsController');
const auth = require('../middleware/auth');

router.use(auth);

// CRUD
router.get('/', campaignsController.getCampaigns);
router.post('/', campaignsController.createCampaign);
router.get('/:id', campaignsController.getCampaign);
router.put('/:id', campaignsController.updateCampaign);
router.delete('/:id', campaignsController.deleteCampaign);

// Actions
router.post('/:id/launch', campaignsController.launchCampaign);
router.post('/:id/pause', campaignsController.pauseCampaign);
router.post('/:id/resume', campaignsController.resumeCampaign);

// Data views
router.get('/:id/leads', campaignsController.getCampaignLeads);
router.get('/:id/calls', campaignsController.getCampaignCalls);
router.get('/:id/analytics', campaignsController.getCampaignAnalytics);

module.exports = router;
