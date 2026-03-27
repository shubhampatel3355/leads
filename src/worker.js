/**
 * LeadForge — Standalone Worker Process
 * 
 * Polls the Postgres `jobs` table every 2 seconds.
 * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrency.
 * Run separately from the API server:
 * 
 *   node src/worker.js
 * 
 * Can run multiple instances safely.
 */
require('dotenv').config();

const env = require('./config/env');
const logger = require('./utils/logger');
const { dequeue, completeJob, failJob } = require('./config/jobQueue');
const { dispatch } = require('./workers/jobHandlers');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ────────────────────────────────────────────
const POLL_INTERVAL_MS = env.worker.pollMs;
const CONCURRENCY = env.worker.concurrency;
const WORKER_ID = `worker-${process.pid}-${uuidv4().slice(0, 8)}`;

let running = true;
let activeJobs = 0;

// ─── Process One Job ──────────────────────────────────────────
async function processOneJob() {
    if (activeJobs >= CONCURRENCY) return false;

    let job;
    try {
        job = await dequeue(WORKER_ID);
    } catch (err) {
        logger.error(`[worker] Dequeue error:`, err.message);
        return false;
    }

    if (!job) return false;

    activeJobs++;
    logger.info(`[worker] Processing job ${job.id} (type: ${job.type}, attempt: ${job.retry_count + 1}/${job.max_retries})`);

    try {
        const result = await dispatch(job.type, job.payload);
        await completeJob(job.id, result);
        logger.info(`[worker] ✓ Job ${job.id} completed`);
    } catch (err) {
        logger.error(`[worker] ✗ Job ${job.id} failed:`, err.message);
        await failJob(job.id, err.message, job.retry_count, job.max_retries);
    } finally {
        activeJobs--;
    }

    return true;
}

// ─── Poll Loop ────────────────────────────────────────────────
async function pollLoop() {
    while (running) {
        try {
            // Try to fill up to CONCURRENCY slots
            const promises = [];
            for (let i = 0; i < CONCURRENCY - activeJobs; i++) {
                promises.push(processOneJob());
            }
            const results = await Promise.all(promises);

            // If any job was processed, immediately try again (batch burst)
            const anyProcessed = results.some(r => r === true);
            if (anyProcessed) continue;
        } catch (err) {
            logger.error(`[worker] Poll loop error:`, err.message);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

// ─── Startup ──────────────────────────────────────────────────
logger.info(`═══════════════════════════════════════════════════`);
logger.info(`[worker] LeadForge Worker started`);
logger.info(`[worker] ID: ${WORKER_ID}`);
logger.info(`[worker] Poll interval: ${POLL_INTERVAL_MS}ms`);
logger.info(`[worker] Concurrency: ${CONCURRENCY}`);
logger.info(`═══════════════════════════════════════════════════`);

pollLoop().catch(err => {
    logger.error('[worker] Fatal error:', err);
    process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────
function shutdown(signal) {
    logger.info(`[worker] ${signal} received. Stopping...`);
    running = false;

    // Give active jobs 10 seconds to finish
    const timeout = setTimeout(() => {
        logger.warn('[worker] Forced shutdown');
        process.exit(1);
    }, 10000);

    const waitForJobs = setInterval(() => {
        if (activeJobs === 0) {
            clearInterval(waitForJobs);
            clearTimeout(timeout);
            logger.info('[worker] All jobs finished. Exiting.');
            process.exit(0);
        }
    }, 200);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger.error('[worker] Uncaught exception:', err.message, err.stack);
    // Don't crash — the poll loop continues
});
process.on('unhandledRejection', (reason) => {
    logger.error('[worker] Unhandled rejection:', reason);
});
