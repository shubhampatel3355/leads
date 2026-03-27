/**
 * Normalize phone numbers to E.164 format.
 * Handles common formats: +1 (555) 234-5678, 555-234-5678, etc.
 */
function normalizePhone(phone) {
    if (!phone) return null;

    // Strip everything except digits and leading +
    let cleaned = String(phone).replace(/[^\d+]/g, '');

    // Remove leading + for processing
    const hasPlus = cleaned.startsWith('+');
    if (hasPlus) cleaned = cleaned.slice(1);

    // If no country code and looks like Indian number (10 digits)
    if (cleaned.length === 10) {
        cleaned = '91' + cleaned;
    }

    // Must have at least 10 digits
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null; // Invalid
    }

    return '+' + cleaned;
}

/**
 * Check if a phone number is valid (basic check).
 */
function isValidPhone(phone) {
    return normalizePhone(phone) !== null;
}

/**
 * Format phone for WhatsApp (whatsapp:+1234567890)
 */
function toWhatsAppFormat(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    return `whatsapp:${normalized}`;
}

module.exports = { normalizePhone, isValidPhone, toWhatsAppFormat };
