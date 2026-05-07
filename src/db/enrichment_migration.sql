-- ─── Enrichment Tables Migration ─────────────────────────────────────────────
-- Run this in Supabase SQL Editor once.

-- enrichment_jobs: tracks an entire enrichment batch
CREATE TABLE IF NOT EXISTS enrichment_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID,
    filename        TEXT NOT NULL,
    total_rows      INTEGER NOT NULL DEFAULT 0,
    processed_rows  INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed')),
    column_map      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- enrichment_rows: one record per company row in the uploaded file
CREATE TABLE IF NOT EXISTS enrichment_rows (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
    row_index        INTEGER NOT NULL,
    company_name     TEXT,
    domain           TEXT,
    person_name      TEXT,
    designation      TEXT,
    entity_type      TEXT,
    linkedin_url     TEXT,
    instagram_url    TEXT,
    x_url            TEXT,
    youtube_url      TEXT,
    facebook_url     TEXT,
    confidence_score INTEGER DEFAULT 0,
    source           TEXT,   -- 'footer_scrape' | 'serp' | 'ai_validated'
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','success','failed')),
    error_message    TEXT,
    original_data    JSONB,  -- preserve all original columns from CSV
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_enrichment_rows_job_id ON enrichment_rows(job_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_rows_status  ON enrichment_rows(job_id, status);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_user    ON enrichment_jobs(user_id);

-- Updated_at trigger helper (reuse if already exists from another table)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_enrichment_jobs_updated_at
    BEFORE UPDATE ON enrichment_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_enrichment_rows_updated_at
    BEFORE UPDATE ON enrichment_rows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
