-- ═══════════════════════════════════════════════════════════════
-- LeadForge — WhatsApp Conversations Schema Hardening
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Make external_id (twilio_message_sid) UNIQUE to enforce idempotency at DB level
-- This prevents duplicate webhook processing even under race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external_id_unique
    ON conversations(external_id)
    WHERE external_id IS NOT NULL;

-- 2. Add index for lead lookups by phone (used in webhook to find leads)
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)
    WHERE phone IS NOT NULL;
