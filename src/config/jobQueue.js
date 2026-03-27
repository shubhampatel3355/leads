/**
 * Postgres-based Job Queue
 * Replaces Redis + BullMQ entirely.
 * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent processing.
 */
const supabase = require('./supabase');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Enqueue a new job.
 * @param {string} type - Job type (upload-processing, whatsapp-sending, etc.)
 * @param {object} payload - Job data
 * @param {object} [opts] - Options { maxRetries, runAt }
 * @returns {object} The created job record
 */
async function enqueue(type, payload, opts = {}) {
    const job = {
        id: uuidv4(),
        type,
        payload,
        status: 'pending',
        max_retries: opts.maxRetries ?? 3,
        run_at: opts.runAt || new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from('jobs')
        .insert(job)
        .select()
        .single();

    if (error) {
        logger.error(`[job-queue] Failed to enqueue ${type}:`, error.message);
        throw new Error(`Failed to enqueue job: ${error.message}`);
    }

    logger.info(`[job-queue] Enqueued ${type} job: ${data.id}`);
    return data;
}

/**
 * Dequeue one job using FOR UPDATE SKIP LOCKED (safe concurrent access).
 * @param {string} workerId - Unique worker identifier
 * @returns {object|null} The locked job, or null if none available
 */
async function dequeue(workerId) {
    // Use raw SQL for FOR UPDATE SKIP LOCKED — not supported by Supabase client
    const { data, error } = await supabase.rpc('dequeue_job', {
        worker_id: workerId,
    });

    if (error) {
        // If RPC doesn't exist yet, log and return null
        if (error.message.includes('dequeue_job')) {
            logger.error('[job-queue] dequeue_job RPC not found. Run the jobs migration SQL.');
        } else {
            logger.error('[job-queue] Dequeue error:', error.message);
        }
        return null;
    }

    // rpc returns an array; take first
    const job = Array.isArray(data) ? data[0] : data;
    return job || null;
}

/**
 * Mark a job as completed.
 */
async function completeJob(jobId, result = null) {
    const { error } = await supabase
        .from('jobs')
        .update({
            status: 'completed',
            result: result ? JSON.parse(JSON.stringify(result)) : null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

    if (error) {
        logger.error(`[job-queue] Failed to complete job ${jobId}:`, error.message);
    }
}

/**
 * Mark a job as failed — retries with exponential backoff or marks permanently failed.
 */
async function failJob(jobId, errorMessage, retryCount, maxRetries) {
    if (retryCount < maxRetries) {
        // Exponential backoff: 2^retry seconds (2s, 4s, 8s, 16s...)
        const delaySec = Math.pow(2, retryCount);
        const runAt = new Date(Date.now() + delaySec * 1000).toISOString();

        const { error } = await supabase
            .from('jobs')
            .update({
                status: 'pending',
                retry_count: retryCount + 1,
                run_at: runAt,
                locked_at: null,
                locked_by: null,
                error_message: errorMessage,
                updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);

        if (error) {
            logger.error(`[job-queue] Failed to retry job ${jobId}:`, error.message);
        } else {
            logger.info(`[job-queue] Job ${jobId} will retry in ${delaySec}s (attempt ${retryCount + 1}/${maxRetries})`);
        }
    } else {
        // Permanently failed
        const { error } = await supabase
            .from('jobs')
            .update({
                status: 'failed',
                error_message: errorMessage,
                updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);

        if (error) {
            logger.error(`[job-queue] Failed to mark job ${jobId} as failed:`, error.message);
        } else {
            logger.warn(`[job-queue] Job ${jobId} permanently failed after ${maxRetries} attempts: ${errorMessage}`);
        }
    }
}

/**
 * Get pending/failed job counts for health checks.
 */
async function getJobStats() {
    const { data, error } = await supabase
        .from('jobs')
        .select('status')
        .in('status', ['pending', 'processing', 'failed']);

    if (error) {
        return { pending: -1, processing: -1, failed: -1, error: error.message };
    }

    const stats = { pending: 0, processing: 0, failed: 0 };
    for (const row of (data || [])) {
        stats[row.status] = (stats[row.status] || 0) + 1;
    }
    return stats;
}

/**
 * Get failed jobs for admin monitoring.
 */
async function getFailedJobs(limit = 50) {
    const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('status', 'failed')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (error) throw new Error(`Failed to fetch failed jobs: ${error.message}`);
    return data || [];
}

module.exports = { enqueue, dequeue, completeJob, failJob, getJobStats, getFailedJobs };
