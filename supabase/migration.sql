-- ═══════════════════════════════════════════════════════════════
-- LeadForge — Supabase Schema + Row Level Security (RLS)
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. TABLES ────────────────────────────────────────────────

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Unknown',
    email TEXT,
    phone TEXT,
    company TEXT,
    job_title TEXT,
    industry TEXT,
    location TEXT,
    source TEXT DEFAULT 'csv_upload',
    notes TEXT,
    status TEXT DEFAULT 'new',
    cleaned BOOLEAN DEFAULT FALSE,
    fit_score INT DEFAULT 0,
    intent_score INT DEFAULT 0,
    final_score INT DEFAULT 0,
    classification TEXT DEFAULT 'cold',
    scored_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(email, user_id)
);

-- Conversations table (WhatsApp messages)
CREATE TABLE IF NOT EXISTS conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    channel TEXT DEFAULT 'whatsapp',
    body TEXT,
    external_id TEXT,
    status TEXT DEFAULT 'delivered',
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Calls table (Bland AI voice calls)
CREATE TABLE IF NOT EXISTS calls (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    external_call_id TEXT UNIQUE,
    status TEXT DEFAULT 'initiated',
    transcript JSONB,
    concatenated_transcript TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead analyses (AI intent results)
CREATE TABLE IF NOT EXISTS lead_analyses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    analysis_type TEXT,
    result JSONB,
    fit_score INT,
    intent_score INT,
    final_score INT,
    classification TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT,
    title TEXT,
    body TEXT,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings (per-user)
CREATE TABLE IF NOT EXISTS settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    scoring_rules JSONB,
    whatsapp_template TEXT,
    integrations JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Batch uploads tracking
CREATE TABLE IF NOT EXISTS batch_uploads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename TEXT,
    total_rows INT DEFAULT 0,
    valid_rows INT DEFAULT 0,
    inserted_rows INT DEFAULT 0,
    duplicate_count INT DEFAULT 0,
    status TEXT DEFAULT 'processing',
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ─── 2. INDEXES ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_classification ON leads(classification);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_external_id ON conversations(external_id);
CREATE INDEX IF NOT EXISTS idx_calls_external_call_id ON calls(external_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_analyses_lead_id ON lead_analyses(lead_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_batch_uploads_user_id ON batch_uploads(user_id);


-- ─── 3. ENABLE ROW LEVEL SECURITY ────────────────────────────

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_uploads ENABLE ROW LEVEL SECURITY;


-- ─── 4. RLS POLICIES ─────────────────────────────────────────
-- Each user can ONLY see/modify their own data.
-- user_id = auth.uid() enforces multi-user isolation.
-- service_role key bypasses RLS (used by backend).

-- ── LEADS ──
CREATE POLICY "leads_select_own" ON leads
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "leads_insert_own" ON leads
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "leads_update_own" ON leads
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "leads_delete_own" ON leads
    FOR DELETE USING (user_id = auth.uid());

-- ── CONVERSATIONS ──
-- Conversations are linked to leads; access via lead ownership
CREATE POLICY "conversations_select_via_lead" ON conversations
    FOR SELECT USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "conversations_insert_via_lead" ON conversations
    FOR INSERT WITH CHECK (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "conversations_update_via_lead" ON conversations
    FOR UPDATE USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "conversations_delete_via_lead" ON conversations
    FOR DELETE USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

-- ── CALLS ──
CREATE POLICY "calls_select_via_lead" ON calls
    FOR SELECT USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "calls_insert_via_lead" ON calls
    FOR INSERT WITH CHECK (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "calls_update_via_lead" ON calls
    FOR UPDATE USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

-- ── LEAD ANALYSES ──
CREATE POLICY "analyses_select_via_lead" ON lead_analyses
    FOR SELECT USING (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

CREATE POLICY "analyses_insert_via_lead" ON lead_analyses
    FOR INSERT WITH CHECK (
        lead_id IN (SELECT id FROM leads WHERE user_id = auth.uid())
    );

-- ── NOTIFICATIONS ──
CREATE POLICY "notifications_select_own" ON notifications
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "notifications_insert_own" ON notifications
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "notifications_update_own" ON notifications
    FOR UPDATE USING (user_id = auth.uid());

-- ── SETTINGS ──
CREATE POLICY "settings_select_own" ON settings
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "settings_insert_own" ON settings
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "settings_update_own" ON settings
    FOR UPDATE USING (user_id = auth.uid());

-- ── BATCH UPLOADS ──
CREATE POLICY "batch_uploads_select_own" ON batch_uploads
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "batch_uploads_insert_own" ON batch_uploads
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "batch_uploads_update_own" ON batch_uploads
    FOR UPDATE USING (user_id = auth.uid());


-- ─── 5. SUPABASE STORAGE SETUP ────────────────────────────────
-- Run this AFTER creating the "lead_uploads" bucket in Supabase Dashboard:
-- Dashboard → Storage → Create new bucket → Name: "lead_uploads" → Private
--
-- Then create a policy for authenticated uploads:
INSERT INTO storage.buckets (id, name, public)
VALUES ('lead_uploads', 'lead_uploads', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "users_upload_files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'lead_uploads');

CREATE POLICY "service_role_download" ON storage.objects
  FOR SELECT TO service_role
  USING (bucket_id = 'lead_uploads');

-- ═══════════════════════════════════════════════════════════════
-- DONE.
-- Backend uses service_role key which bypasses RLS for admin ops.
-- Frontend/client queries respect RLS via auth.uid().
-- Supabase Storage: frontend uploads, backend downloads via service key.
-- ═══════════════════════════════════════════════════════════════
