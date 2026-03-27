const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const path = require('path');
const logger = require('./logger');

/**
 * Parse a CSV or XLSX buffer into an array of row objects.
 * @param {Buffer} buffer - File contents
 * @param {string} filename - Original file name (used to detect format)
 * @returns {Array<Object>} Parsed rows
 */
function parseFile(buffer, filename) {
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.csv') {
        return parseCsv(buffer);
    } else if (ext === '.xlsx' || ext === '.xls') {
        return parseExcel(buffer);
    } else {
        throw new Error(`Unsupported file format: ${ext}. Use CSV, XLS, or XLSX.`);
    }
}

function parseCsv(buffer) {
    const records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
    });
    logger.info(`Parsed ${records.length} rows from CSV`);
    return records;
}

function parseExcel(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    logger.info(`Parsed ${records.length} rows from Excel sheet "${sheetName}"`);
    return records;
}

/**
 * Validate and normalize a row of lead data. Returns null if invalid.
 */
function validateLeadRow(row) {
    // Normalize keys to lowercase
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[key.toLowerCase().trim().replace(/\s+/g, '_')] = typeof value === 'string' ? value.trim() : value;
    }

    // Must have at least a name or email
    const name = normalized.name || normalized.full_name || normalized.first_name || '';
    const email = normalized.email || normalized.email_address || '';

    if (!name && !email) return null;

    return {
        name: name || 'Unknown',
        email: email || null,
        phone: normalized.phone || normalized.phone_number || normalized.mobile || null,
        company: normalized.company || normalized.company_name || normalized.organization || null,
        job_title: normalized.job_title || normalized.title || normalized.position || null,
        industry: normalized.industry || normalized.sector || null,
        location: normalized.location || normalized.city || normalized.country || null,
        source: normalized.source || normalized.lead_source || 'csv_upload',
        notes: normalized.notes || null,
    };
}

module.exports = { parseFile, validateLeadRow };
