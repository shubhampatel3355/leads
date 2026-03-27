const whatsappService = require('../services/whatsappService');
const leadService = require('../services/leadService');
const { enqueue } = require('../config/jobQueue');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * POST /api/whatsapp/send
 * Send a WhatsApp message to a lead.
 * Protected by JWT auth — only the lead owner can send.
 */
const sendMessage = asyncHandler(async (req, res) => {
    const { lead_id, message } = req.body;

    if (!lead_id || !message) {
        return res.status(400).json({ error: 'lead_id and message are required' });
    }

    // Fetch lead (throws 404 if not found or not owned by user)
    const lead = await leadService.getLeadById(lead_id, req.user.id);

    if (!lead.phone) {
        return res.status(400).json({ error: 'Lead has no phone number' });
    }

    // Send directly via Twilio (stores outbound message in conversations table)
    const result = await whatsappService.sendMessage(lead.id, lead.phone, message);

    res.json({
        message: 'WhatsApp message sent',
        lead_id: lead.id,
        sid: result.sid,
        status: result.status,
    });
});

/**
 * POST /webhook/whatsapp
 * Receive inbound WhatsApp messages from Twilio.
 * 
 * CRITICAL REQUIREMENTS:
 * 1. Twilio signature is validated BEFORE this handler (webhookValidator middleware)
 * 2. Must respond 200 within 15 seconds (Twilio timeout)
 * 3. Must prevent duplicate processing (idempotency via MessageSid)
 * 4. Must NOT block on AI processing
 * 5. Must NOT leak internal errors to Twilio
 */
const webhookHandler = async (req, res) => {
    // Always respond 200 with empty TwiML — Twilio expects this
    const respond = () => res.type('text/xml').status(200).send('<Response></Response>');

    try {
        const { MessageSid, From, Body, To, NumMedia } = req.body;

        if (!MessageSid) {
            logger.warn('[webhook:whatsapp] Missing MessageSid, returning 200');
            return respond();
        }

        logger.info(`[webhook:whatsapp] Inbound from ${From}: "${Body?.substring(0, 80)}..." (sid: ${MessageSid})`);

        // ─── Idempotency Check ────────────────────────────────
        const alreadyProcessed = await whatsappService.isMessageProcessed(MessageSid);
        if (alreadyProcessed) {
            logger.warn(`[webhook:whatsapp] Duplicate MessageSid: ${MessageSid}, skipping`);
            return respond();
        }

        // ─── Identify Lead ────────────────────────────────────
        const phone = From?.replace('whatsapp:', '') || null;

        const supabase = require('../config/supabase');
        const { data: leads } = await supabase
            .from('leads')
            .select('id, user_id')
            .eq('phone', phone)
            .limit(1);

        const lead = leads?.[0] || null;
        const leadId = lead?.id || null;

        if (!leadId) {
            logger.warn(`[webhook:whatsapp] No lead found for phone ${phone}, storing as unmatched`);
        }

        // ─── Store Inbound Message ────────────────────────────
        await whatsappService.storeMessage({
            lead_id: leadId,
            direction: 'inbound',
            channel: 'whatsapp',
            body: Body,
            external_id: MessageSid,
            status: 'received',
            metadata: {
                from: From,
                to: To,
                num_media: NumMedia || '0',
                received_at: new Date().toISOString(),
            },
        });

        // ─── Queue Intent Analysis (non-blocking) ─────────────
        if (leadId) {
            try {
                await enqueue('intent-analysis', {
                    lead_id: leadId,
                    trigger: 'whatsapp_inbound',
                });
                logger.info(`[webhook:whatsapp] Queued intent-analysis for lead ${leadId}`);
            } catch (err) {
                logger.warn('[webhook:whatsapp] Failed to queue intent analysis:', err.message);
                // Non-critical — don't fail the webhook
            }
        }

        return respond();
    } catch (err) {
        // CRITICAL: Always return 200 to Twilio even on error.
        // Twilio retries on non-2xx, causing duplicate processing.
        logger.error('[webhook:whatsapp] Handler error:', err.message, err.stack);
        return respond();
    }
};

/**
 * POST /webhook/whatsapp/status
 * Handle real-time status updates (sent, delivered, read, failed) from Twilio.
 */
const statusCallbackHandler = async (req, res) => {
    // Always respond 200 within 15s to Twilio
    const respond = () => res.status(200).send();

    try {
        const { MessageSid, MessageStatus, ErrorCode } = req.body;

        if (!MessageSid || !MessageStatus) {
            logger.warn('[webhook:whatsapp:status] Missing SID or Status, returning 200');
            return respond();
        }

        logger.info(`[webhook:whatsapp:status] SID: ${MessageSid}, Status: ${MessageStatus}${ErrorCode ? ` (Error: ${ErrorCode})` : ''}`);

        // Update the conversation status in Supabase
        const supabase = require('../config/supabase');
        const { error } = await supabase
            .from('conversations')
            .update({
                status: MessageStatus,
                // Update metadata if there's an error
                ...(ErrorCode ? {
                    metadata: {
                        error_code: ErrorCode,
                        updated_at: new Date().toISOString()
                    }
                } : {})
            })
            .eq('external_id', MessageSid);

        if (error) {
            logger.error(`[webhook:whatsapp:status] Failed to update status for ${MessageSid}:`, error.message);
        }

        return respond();
    } catch (err) {
        logger.error('[webhook:whatsapp:status] Handler error:', err.message);
        return respond();
    }
};

module.exports = { sendMessage, webhookHandler, statusCallbackHandler };
