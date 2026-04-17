-- ═══════════════════════════════════════════════════════════════
-- LeadForge — Advanced Campaigns Schema
-- Adds support for multi-step campaign configuration and meta-data
-- ═══════════════════════════════════════════════════════════════

-- 1. Create Campaigns Table (if not already existing or to ensure columns)
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt_script TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'running', 'paused', 'completed', 'archived')),
    meta JSONB DEFAULT '{}'::jsonb,
    total_leads_targeted INT DEFAULT 0,
    launched_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add campaign_id to leads table to link them
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='campaign_id') THEN
        ALTER TABLE leads ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 3. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_leads_campaign_id ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- 4. Enable RLS
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies
CREATE POLICY "campaigns_select_own" ON campaigns
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "campaigns_insert_own" ON campaigns
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "campaigns_update_own" ON campaigns
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "campaigns_delete_own" ON campaigns
    FOR DELETE USING (user_id = auth.uid());

-- 6. Grant basic permissions (if using custom roles)
-- GRANT ALL ON campaigns TO authenticated;
-- GRANT ALL ON campaigns TO service_role;
