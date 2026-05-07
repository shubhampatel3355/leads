/**
 * Enrichment Controller — Find Company Social Profiles
 */

const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = file.originalname.split('.').pop().toLowerCase();
        if (['csv', 'xlsx', 'xls'].includes(ext)) cb(null, true);
        else cb(new Error('Only CSV and XLSX files are supported'));
    },
});

function parseFileBuffer(buffer, originalname) {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function autoDetectColumns(headers) {
    const map = {};
    const MATCHERS = {
        company_name: /company[_\s]?name|company|org|organisation|organization|^name$/i,
        domain:       /website|domain|url|web|site/i,
        city:         /city|location|region|area/i,
        person_name:  /person[_\s]?name|person|name|contact|full[_\s]?name|lead[_\s]?name/i,
        designation:  /designation|title|job[_\s]?title|role|position/i,
    };
    for (const header of headers) {
        for (const [field, pattern] of Object.entries(MATCHERS)) {
            if (!map[field] && pattern.test(header)) map[field] = header;
        }
    }
    return map;
}

async function startEnrichment(req, res) {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const rows = parseFileBuffer(req.file.buffer, req.file.originalname);
        if (!rows.length) return res.status(400).json({ error: 'File is empty' });

        const headers = Object.keys(rows[0]);
        let columnMap;
        try {
            columnMap = req.body.column_map ? JSON.parse(req.body.column_map) : autoDetectColumns(headers);
        } catch { columnMap = autoDetectColumns(headers); }

        if (req.body.detect_only === 'true') {
            return res.json({ headers, column_map: columnMap, preview: rows.slice(0, 20), total_rows: rows.length });
        }

        const jobId = uuidv4();
        const { error: jobErr } = await supabase.from('enrichment_jobs').insert({
            id: jobId,
            user_id: req.user?.id || null,
            filename: req.file.originalname,
            total_rows: rows.length,
            status: 'processing',
            column_map: columnMap,
        });
        if (jobErr) throw new Error(jobErr.message);

        const rowRecords = rows.map((row, idx) => ({
            id: uuidv4(),
            job_id: jobId,
            row_index: idx,
            company_name: String(row[columnMap.company_name] || '').trim(),
            domain: String(row[columnMap.domain] || '').trim(),
            person_name: String(row[columnMap.person_name] || '').trim(),
            designation: String(row[columnMap.designation] || '').trim(),
            status: 'pending',
            original_data: row,
        }));

        for (let i = 0; i < rowRecords.length; i += 500) {
            const { error } = await supabase.from('enrichment_rows').insert(rowRecords.slice(i, i + 500));
            if (error) throw new Error(error.message);
        }

        for (const record of rowRecords) {
            await enqueue('enrichment-row', {
                job_id: jobId,
                row_id: record.id,
                company_name: record.company_name,
                domain: record.domain,
                city: String(rows[record.row_index]?.[columnMap.city] || '').trim(),
                person_name: record.person_name,
                designation: record.designation,
            }, { maxRetries: 2 });
        }

        logger.info(`[enrichment] Job ${jobId}: ${rows.length} rows queued`);
        res.json({ job_id: jobId, total_rows: rows.length, status: 'processing' });

    } catch (err) {
        logger.error('[enrichment] startEnrichment:', err.message);
        res.status(500).json({ error: err.message });
    }
}

async function getJobProgress(req, res) {
    try {
        const { jobId } = req.params;
        const { data: job, error } = await supabase.from('enrichment_jobs').select('*').eq('id', jobId).single();
        if (error || !job) return res.status(404).json({ error: 'Job not found' });

        const { data: counts } = await supabase.from('enrichment_rows').select('status').eq('job_id', jobId);
        const sc = { pending: 0, processing: 0, success: 0, failed: 0 };
        for (const r of (counts || [])) sc[r.status] = (sc[r.status] || 0) + 1;

        const processed = sc.success + sc.failed;
        const pct = job.total_rows > 0 ? Math.round((processed / job.total_rows) * 100) : 0;
        const elapsedSec = (Date.now() - new Date(job.created_at).getTime()) / 1000;
        const rowsPerSec = processed > 0 ? processed / elapsedSec : 0;
        const eta = rowsPerSec > 0 ? Math.ceil((job.total_rows - processed) / rowsPerSec) : null;

        if (processed >= job.total_rows && job.status === 'processing') {
            await supabase.from('enrichment_jobs').update({
                status: 'completed', processed_rows: processed,
                success_count: sc.success, failed_count: sc.failed,
            }).eq('id', jobId);
        }

        res.json({
            job_id: jobId, filename: job.filename,
            status: processed >= job.total_rows ? 'completed' : job.status,
            total_rows: job.total_rows, processed_rows: processed,
            success_count: sc.success, failed_count: sc.failed, pending_count: sc.pending,
            percent: pct, rows_per_sec: Math.round(rowsPerSec * 10) / 10,
            eta_seconds: eta, created_at: job.created_at,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function downloadEnrichedFile(req, res) {
    try {
        const { jobId } = req.params;
        const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
        const minConf = parseInt(req.query.min_confidence || '0', 10);

        const { data: job } = await supabase.from('enrichment_jobs').select('filename').eq('id', jobId).single();
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const { data: rows, error } = await supabase.from('enrichment_rows')
            .select('*').eq('job_id', jobId).gte('confidence_score', minConf).order('row_index');
        if (error) throw new Error(error.message);

        const outputRows = (rows || []).map(row => ({
            ...(row.original_data || {}),
            ENTITY_TYPE: row.entity_type || '',
            PERSON_NAME: row.person_name || '',
            DESIGNATION: row.designation || '',
            LINKEDIN: row.linkedin_url || '',
            INSTAGRAM: row.instagram_url || '',
            X: row.x_url || '',
            YOUTUBE: row.youtube_url || '',
            FACEBOOK: row.facebook_url || '',
            CONFIDENCE_SCORE: row.confidence_score || 0,
            ENRICHMENT_SOURCE: row.source || '',
            ENRICHMENT_STATUS: row.status || '',
        }));

        const ws = XLSX.utils.json_to_sheet(outputRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Enriched');
        const base = job.filename.replace(/\.(csv|xlsx?)$/i, '');

        if (format === 'xlsx') {
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', `attachment; filename="${base}_enriched.xlsx"`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            return res.send(buf);
        }
        const csv = XLSX.utils.sheet_to_csv(ws);
        res.setHeader('Content-Disposition', `attachment; filename="${base}_enriched.csv"`);
        res.setHeader('Content-Type', 'text/csv');
        return res.send(csv);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function retryFailed(req, res) {
    try {
        const { jobId } = req.params;
        const { data: failedRows } = await supabase.from('enrichment_rows')
            .select('id,company_name,domain,original_data').eq('job_id', jobId).eq('status', 'failed');

        if (!failedRows?.length) return res.json({ message: 'No failed rows', retried: 0 });

        await supabase.from('enrichment_rows').update({ status: 'pending', error_message: null })
            .eq('job_id', jobId).eq('status', 'failed');

        const { data: job } = await supabase.from('enrichment_jobs').select('column_map').eq('id', jobId).single();
        const colMap = job?.column_map || {};

        for (const row of failedRows) {
            await enqueue('enrichment-row', {
                job_id: jobId, row_id: row.id,
                company_name: row.company_name, domain: row.domain,
                city: row.original_data?.[colMap.city] || '',
                person_name: row.original_data?.[colMap.person_name] || '',
                designation: row.original_data?.[colMap.designation] || '',
            }, { maxRetries: 2 });
        }

        res.json({ retried: failedRows.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function getJobRows(req, res) {
    try {
        const { jobId } = req.params;
        const status = req.query.status || null;
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = 50;
        const offset = (page - 1) * limit;

        let query = supabase.from('enrichment_rows')
            .select('id,row_index,company_name,domain,person_name,designation,entity_type,linkedin_url,instagram_url,x_url,youtube_url,facebook_url,confidence_score,source,status,error_message', { count: 'exact' })
            .eq('job_id', jobId).order('row_index').range(offset, offset + limit - 1);

        if (status) query = query.eq('status', status);
        const { data, error, count } = await query;
        if (error) throw new Error(error.message);
        res.json({ rows: data || [], total: count, page, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { upload, startEnrichment, getJobProgress, downloadEnrichedFile, retryFailed, getJobRows };
