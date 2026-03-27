const { v4: uuidv4 } = require('uuid');
const leadService = require('../services/leadService');
const { fullScore, calculateFitScore } = require('../services/scoringService');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * POST /api/leads/upload
 * Receives a file_path (already uploaded to Supabase Storage by frontend).
 * Creates a batch record and queues a processing job.
 * Returns immediately — no parsing in request lifecycle.
 */
const uploadLeads = asyncHandler(async (req, res) => {
    const { file_path, filename } = req.body;

    if (!file_path) {
        return res.status(400).json({ error: 'file_path is required' });
    }

    const batch_id = uuidv4();
    const userId = req.user.id;

    // Create batch_uploads record
    const supabase = require('../config/supabase');
    const { error: batchErr } = await supabase
        .from('batch_uploads')
        .insert({
            id: batch_id,
            user_id: userId,
            filename: filename || file_path.split('/').pop(),
            total_rows: 0,
            valid_rows: 0,
            inserted_rows: 0,
            duplicate_count: 0,
            status: 'processing',
        });

    if (batchErr) {
        logger.error('Failed to create batch record:', batchErr.message);
        return res.status(500).json({ error: 'Failed to create upload batch' });
    }

    // Queue the processing job (Postgres-based)
    await enqueue('upload-processing', {
        batch_id,
        file_path,
        filename: filename || file_path.split('/').pop(),
        user_id: userId,
    });

    logger.info(`Queued upload job: batch=${batch_id}, file=${file_path}`);

    res.status(202).json({
        status: 'processing',
        batch_id,
        message: 'Upload queued for processing',
    });
});

/**
 * GET /api/leads/uploads
 * Fetch batch upload history for the authenticated user.
 */
const getUploadHistory = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');
    const { data, error } = await supabase
        .from('batch_uploads')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) throw new Error(`Failed to fetch uploads: ${error.message}`);

    res.json({ uploads: data || [] });
});

/**
 * GET /api/leads/uploads/:id
 * Get status of a specific batch upload.
 */
const getUploadStatus = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');
    const { data, error } = await supabase
        .from('batch_uploads')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(data);
});

/**
 * GET /api/leads
 * Fetch paginated leads.
 */
const getLeads = asyncHandler(async (req, res) => {
    const { page, limit, classification, search } = req.query;

    const result = await leadService.getLeads(req.user.id, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        classification,
        search,
    });

    res.json(result);
});

/**
 * GET /api/leads/:id
 * Fetch single lead.
 */
const getLeadById = asyncHandler(async (req, res) => {
    const lead = await leadService.getLeadById(req.params.id, req.user.id);
    res.json(lead);
});

/**
 * POST /api/leads/:id/rescore
 * Trigger re-scoring for a lead.
 */
const rescoreLead = asyncHandler(async (req, res) => {
    const lead = await leadService.getLeadById(req.params.id, req.user.id);

    const fitScore = calculateFitScore(lead);

    // Queue intent analysis job
    await enqueue('intent-analysis', {
        lead_id: lead.id,
        trigger: 'manual_rescore',
        fit_score: fitScore,
    });

    res.json({ message: 'Re-scoring queued', lead_id: lead.id });
});

/**
 * DELETE /api/leads/uploads/:id
 * Delete a batch upload record + its file from Supabase Storage.
 */
const deleteUpload = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');

    // 1. Fetch the batch record
    const { data: batch, error: fetchErr } = await supabase
        .from('batch_uploads')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

    if (fetchErr || !batch) {
        return res.status(404).json({ error: 'Batch not found' });
    }

    // 2. Try to delete the file from Storage (best-effort)
    if (batch.filename) {
        const { data: files } = await supabase.storage
            .from('lead_uploads')
            .list('', { search: batch.filename });

        if (files && files.length > 0) {
            const paths = files.map(f => f.name);
            await supabase.storage.from('lead_uploads').remove(paths);
            logger.info(`Deleted ${paths.length} file(s) from Storage for batch ${batch.id}`);
        }
    }

    // 3. Delete the batch record
    const { error: deleteErr } = await supabase
        .from('batch_uploads')
        .delete()
        .eq('id', req.params.id);

    if (deleteErr) {
        throw new Error(`Failed to delete batch: ${deleteErr.message}`);
    }

    res.json({ message: 'Upload deleted successfully' });
});

/**
 * GET /api/leads/:id/analysis
 * Fetch the latest AI analysis for a lead.
 */
const getLeadAnalysis = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');

    // Verify lead belongs to user
    await leadService.getLeadById(req.params.id, req.user.id);

    const { data, error } = await supabase
        .from('lead_analyses')
        .select('*')
        .eq('lead_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Failed to fetch analysis: ${error.message}`);

    res.json({ analysis: data || null });
});

/**
 * DELETE /api/leads/:id
 * Delete a lead and all related data.
 */
const deleteLead = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');
    const leadId = req.params.id;

    // Verify lead belongs to user
    await leadService.getLeadById(leadId, req.user.id);

    // Cascade delete related data (best-effort)
    await supabase.from('lead_analyses').delete().eq('lead_id', leadId);
    await supabase.from('conversations').delete().eq('lead_id', leadId);
    await supabase.from('job_queue').delete().match({ 'payload->>lead_id': leadId });

    // Delete the lead itself
    const { error } = await supabase
        .from('leads')
        .delete()
        .eq('id', leadId)
        .eq('user_id', req.user.id);

    if (error) throw new Error(`Failed to delete lead: ${error.message}`);

    logger.info(`Deleted lead ${leadId} and related data`);
    res.json({ message: 'Lead deleted successfully' });
});

/**
 * PUT /api/leads/:id
 * Update editable lead fields.
 */
const updateLead = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');
    const leadId = req.params.id;

    // Verify lead belongs to user
    await leadService.getLeadById(leadId, req.user.id);

    // Whitelist editable fields
    const allowed = ['name', 'email', 'phone', 'company', 'industry', 'title', 'location', 'source'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('leads')
        .update(updates)
        .eq('id', leadId)
        .eq('user_id', req.user.id)
        .select()
        .single();

    if (error) throw new Error(`Failed to update lead: ${error.message}`);

    res.json(data);
});

/**
 * POST /api/leads
 * Manually create a single lead.
 */
const createLead = asyncHandler(async (req, res) => {
    const supabase = require('../config/supabase');
    const { name, email, phone, company, industry, title, location, source } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'name is required' });
    }

    const leadData = {
        id: uuidv4(),
        user_id: req.user.id,
        name,
        email: email || null,
        phone: phone || null,
        company: company || null,
        industry: industry || null,
        title: title || null,
        location: location || null,
        source: source || 'manual',
        classification: 'cold',
        fit_score: 0,
        intent_score: 0,
        final_score: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };

    // Calculate fit score
    leadData.fit_score = calculateFitScore(leadData);
    const { finalScore, classification } = fullScore(leadData.fit_score, 0);
    leadData.final_score = finalScore;
    leadData.classification = classification;

    const { data, error } = await supabase
        .from('leads')
        .insert(leadData)
        .select()
        .single();

    if (error) throw new Error(`Failed to create lead: ${error.message}`);

    logger.info(`Created lead ${data.id} (${name}) with fit_score=${leadData.fit_score}`);
    res.status(201).json(data);
});

module.exports = {
    uploadLeads, getUploadHistory, getUploadStatus, deleteUpload,
    getLeads, getLeadById, rescoreLead,
    getLeadAnalysis, deleteLead, updateLead, createLead,
};
