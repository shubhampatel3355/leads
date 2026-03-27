const twilio = require('twilio');
const env = require('../config/env');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toWhatsAppFormat, normalizePhone } = require('../utils/phoneNormalizer');

let twilioClient = null;

/**
 * Get or create the Twilio client (singleton).
 */
function getClient() {
    if (!twilioClient) {
        if (!env.twilio.accountSid || !env.twilio.authToken) {
            throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
        }
        twilioClient = twilio(env.twilio.accountSid, env.twilio.authToken);
        logger.info('[whatsapp] Twilio client initialized');
    }
    return twilioClient;
}

/**
 * Send a WhatsApp message via Twilio.
 * Stores the outbound message in the conversations table.
 * @returns {{ sid: string, status: string }}
 */
async function sendMessage(leadId, phone, body) {
    const to = toWhatsAppFormat(phone);
    if (!to) {
        throw Object.assign(
            new Error(`Invalid phone number for lead ${leadId}: ${phone}`),
            { status: 400 }
        );
    }

    try {
        const client = getClient();

        // Construct status callback URL if possible
        const statusCallback = env.twilio.webhookUrl ? `${env.twilio.webhookUrl.replace(/\/webhook\/whatsapp\/?$/, '')}/webhook/whatsapp/status` : null;

        const message = await client.messages.create({
            from: env.twilio.whatsappFrom,
            to,
            body,
            statusCallback,
        });

        logger.info(`[whatsapp] Sent to ${to} (sid: ${message.sid}, status: ${message.status}, callback: ${statusCallback || 'none'})`);

        // Store outbound message
        await storeMessage({
            lead_id: leadId,
            direction: 'outbound',
            channel: 'whatsapp',
            body,
            external_id: message.sid,
            status: message.status,
            metadata: {
                from: env.twilio.whatsappFrom,
                to,
                sent_at: new Date().toISOString(),
            },
        });

        return { sid: message.sid, status: message.status };
    } catch (err) {
        // Log Twilio-specific error details
        if (err.code) {
            logger.error(`[whatsapp] Twilio error ${err.code} (${err.status}): ${err.message}`);
            logger.error(`[whatsapp] More info: ${err.moreInfo || 'N/A'}`);
        } else {
            logger.error(`[whatsapp] Send failed for lead ${leadId}:`, err.message);
        }
        throw err;
    }
}

/**
 * Store a conversation message (inbound or outbound).
 * Uses UPSERT semantics on external_id to prevent duplicates.
 */
async function storeMessage({ lead_id, direction, channel, body, external_id, status, metadata }) {
    // If external_id exists, check for duplicate first (belt + suspenders with UNIQUE index)
    if (external_id) {
        const existing = await isMessageProcessed(external_id);
        if (existing) {
            logger.warn(`[whatsapp] Message ${external_id} already stored, skipping insert`);
            return { id: null, duplicate: true };
        }
    }

    const { data, error } = await supabase
        .from('conversations')
        .insert({
            lead_id,
            direction,
            channel: channel || 'whatsapp',
            body,
            external_id: external_id || null,
            status: status || 'delivered',
            metadata: metadata || null,
            created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

    if (error) {
        logger.error('[whatsapp] Failed to store message:', error.message);
        throw error;
    }

    logger.info(`[whatsapp] Stored ${direction} message ${data.id} (external: ${external_id || 'none'})`);
    return data;
}

/**
 * Get full conversation history for a lead (ordered chronologically).
 */
async function getConversation(leadId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to fetch conversation: ${error.message}`);
    return data || [];
}

/**
 * Check if a message has already been processed (idempotency guard).
 * @param {string} externalId - The Twilio MessageSid
 * @returns {boolean}
 */
async function isMessageProcessed(externalId) {
    if (!externalId) return false;

    const { data } = await supabase
        .from('conversations')
        .select('id')
        .eq('external_id', externalId)
        .limit(1);

    return data && data.length > 0;
}

module.exports = { sendMessage, storeMessage, getConversation, isMessageProcessed, getClient };
