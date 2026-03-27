-- ═══════════════════════════════════════════════════════════════
-- LeadForge — Postgres Job Queue Table
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- Jobs table (replaces Redis + BullMQ)
CREATE TABLE IF NOT EXISTS jobs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    run_at TIMESTAMPTZ DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    error_message TEXT,
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs(run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);

-- RLS
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, but add a policy for admin queries
CREATE POLICY "jobs_service_role_all" ON jobs
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ─── DEQUEUE FUNCTION (FOR UPDATE SKIP LOCKED) ────────────────
-- This is the core of the Postgres job queue.
-- Safe for concurrent workers — each gets a different row.
CREATE OR REPLACE FUNCTION dequeue_job(worker_id TEXT)
RETURNS SETOF jobs
LANGUAGE plpgsql
AS $$
DECLARE
    job_row jobs%ROWTYPE;
BEGIN
    SELECT * INTO job_row
    FROM jobs
    WHERE status = 'pending'
      AND run_at <= NOW()
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE jobs
    SET status = 'processing',
        locked_at = NOW(),
        locked_by = worker_id,
        updated_at = NOW()
    WHERE id = job_row.id;

    job_row.status := 'processing';
    job_row.locked_at := NOW();
    job_row.locked_by := worker_id;

    RETURN NEXT job_row;
END;
$$;
