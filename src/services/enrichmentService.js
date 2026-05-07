/**
 * Enrichment Service — Find Company Social Profiles
 *
 * Pipeline per row:
 *  1. Normalize domain (if provided)
 *  2. Find domain via SERP if missing
 *  3. Scrape website footer / contact / about pages
 *  4. SERP fallback for any still-missing platforms
 *  5. AI validates matches + returns confidence score
 */

const logger = require('../utils/logger');
const env = require('../config/env');

// ─── Domain Normalization ──────────────────────────────────────────────────

/**
 * Strips protocol, www, paths, query params.
 * "https://www.xyz.com/about?ref=1" → "xyz.com"
 */
function normalizeDomain(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().toLowerCase();
    // Add protocol if missing so URL parser works
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
        const u = new URL(s);
        return u.hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

// ─── SERP Helpers ──────────────────────────────────────────────────────────

async function serpSearch(query) {
    const apiKey = env.serper?.apiKey;
    if (!apiKey) {
        logger.warn('[enrich] SERPER_API_KEY not set — skipping SERP step');
        return [];
    }
    try {
        const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ q: query, num: 5 }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json.organic || [];
    } catch (err) {
        logger.warn(`[enrich] SERP request failed: ${err.message}`);
        return [];
    }
}

/**
 * Find the official company domain via SERP when none is provided.
 */
async function findDomainViaSERP(companyName, city) {
    const query = `${companyName}${city ? ' ' + city : ''} official website`;
    const results = await serpSearch(query);
    for (const r of results) {
        if (!r.link) continue;
        const domain = normalizeDomain(r.link);
        if (!domain) continue;
        // Skip aggregator/directory sites
        const skipList = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com',
            'x.com', 'youtube.com', 'crunchbase.com', 'glassdoor.com',
            'justdial.com', 'indiamart.com', 'yelp.com', 'wikipedia.org'];
        if (skipList.some(s => domain.includes(s))) continue;
        return domain;
    }
    return null;
}

// ─── Social URL Extractors ─────────────────────────────────────────────────

const SOCIAL_PATTERNS = {
    linkedin:  /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[a-zA-Z0-9\-_%]+\/?/gi,
    instagram: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9\-_.]+\/?/gi,
    x:         /https?:\/\/(www\.)?(x\.com|twitter\.com)\/[a-zA-Z0-9_]+\/?/gi,
    youtube:   /https?:\/\/(www\.)?youtube\.com\/(channel|c|@)[a-zA-Z0-9\-_]+\/?/gi,
    facebook:  /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9\-_.]+\/?/gi,
};

function extractSocialsFromHTML(html) {
    const socials = {};
    for (const [platform, pattern] of Object.entries(SOCIAL_PATTERNS)) {
        const matches = [...html.matchAll(pattern)];
        if (matches.length > 0) {
            // Pick shortest URL (most likely the main page, not a post)
            const urls = matches.map(m => m[0].replace(/\/$/, ''));
            urls.sort((a, b) => a.length - b.length);
            socials[platform] = urls[0];
        }
    }
    return socials;
}

/**
 * Fetch a URL and return its HTML text (with timeout + error handling).
 */
async function fetchPage(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; LeadForge-Enrichment/1.0)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('html')) return null;
        return await res.text();
    } catch {
        return null;
    }
}

/**
 * Scrape the company website (homepage + /contact + /about) for social links.
 */
async function scrapeWebsiteForSocials(domain) {
    const pages = [
        `https://${domain}`,
        `https://${domain}/contact`,
        `https://${domain}/about`,
        `https://${domain}/contact-us`,
    ];

    const merged = {};
    const sources = [];

    for (const url of pages) {
        const html = await fetchPage(url);
        if (!html) continue;
        const found = extractSocialsFromHTML(html);
        let anyNew = false;
        for (const [platform, url_] of Object.entries(found)) {
            if (!merged[platform]) {
                merged[platform] = url_;
                anyNew = true;
            }
        }
        if (anyNew) sources.push('footer_scrape');

        // Stop early if we have all 5 major platforms
        if (Object.keys(merged).length >= 5) break;
    }

    return { socials: merged, sources: [...new Set(sources)] };
}

// ─── SERP Social Fallback ──────────────────────────────────────────────────

const SERP_PLATFORM_QUERIES = {
    linkedin:  (name) => `site:linkedin.com/company "${name}"`,
    instagram: (name) => `site:instagram.com "${name}"`,
    x:         (name) => `site:x.com "${name}"`,
    youtube:   (name) => `site:youtube.com "${name}"`,
    facebook:  (name) => `site:facebook.com "${name}"`,
};

const PERSON_SERP_QUERIES = {
    linkedin:  (name, company) => `"${name}" "${company}" site:linkedin.com/in`,
    instagram: (name, company) => `"${name}" "${company}" site:instagram.com`,
    x:         (name, company) => `"${name}" "${company}" site:x.com OR site:twitter.com`,
    facebook:  (name, company) => `"${name}" "${company}" site:facebook.com`,
    youtube:   (name, company) => `"${name}" "${company}" site:youtube.com`,
};

/**
 * Use SERP to find a specific social profile for platforms missed by scraping.
 */
async function searchSocialsViaSERP(companyName, missingPlatforms, personName = null) {
    const found = {};
    for (const platform of missingPlatforms) {
        const query = personName 
            ? PERSON_SERP_QUERIES[platform]?.(personName, companyName)
            : SERP_PLATFORM_QUERIES[platform]?.(companyName);
        if (!query) continue;
        const results = await serpSearch(query);
        
        let pattern = SOCIAL_PATTERNS[platform];
        // If it's a person linkedin search, we need a custom pattern to match /in/ instead of /company/
        if (personName && platform === 'linkedin') {
            pattern = /https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+\/?/gi;
        }

        const first = results.find(r => r.link && pattern.test(r.link));
        if (first) {
            // Reset lastIndex since patterns are global
            pattern.lastIndex = 0;
            found[platform] = first.link;
        }
    }
    // Reset all pattern lastIndex
    for (const p of Object.values(SOCIAL_PATTERNS)) p.lastIndex = 0;
    return found;
}

// ─── AI Validation ─────────────────────────────────────────────────────────

async function validateWithAI(companyName, domain, city, socials, personName = null, designation = null) {
    const { callModel } = require('./aiService');

    const socialsText = Object.entries(socials)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

    if (!socialsText) return { confidence_score: 0, validated: {} };

    const targetDescription = personName 
        ? `Person: "${personName}"\nDesignation: ${designation || 'unknown'}\nCompany: "${companyName}"`
        : `Company: "${companyName}"`;

    const instructions = personName
        ? `1. Does the profile name/handle match the person's name?
2. Is the company name or domain mentioned in the bio/description/experience?
3. Does the location match (if city is known)?
4. Is it a personal professional profile (not a company page)?`
        : `1. Does the profile name/handle match the company name?
2. Is the company domain mentioned in the bio/description?
3. Does the location match (if city is known)?
4. Is it an official company page (not a person's page)?`;

    const prompt = `You are validating social media profiles found for a ${personName ? 'person' : 'company'}.

${targetDescription}
Domain: ${domain || 'unknown'}
City: ${city || 'unknown'}

Found social profiles:
${socialsText}

For each profile, check:
${instructions}

Respond ONLY with JSON:
{
  "confidence_score": <0-100>,
  "validated": {
    "linkedin": <true|false|null>,
    "instagram": <true|false|null>,
    "x": <true|false|null>,
    "youtube": <true|false|null>,
    "facebook": <true|false|null>
  },
  "reason": "<brief explanation>"
}`;

    try {
        const { text } = await callModel(
            env.openai.fallbackModel, // Use mini for cost efficiency
            prompt,
            15000
        );
        // Extract JSON
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            const result = JSON.parse(match[0]);
            return result;
        }
    } catch (err) {
        logger.warn(`[enrich] AI validation failed: ${err.message}`);
    }
    // Default: moderate confidence if we found socials via scraping
    return { confidence_score: 70, validated: {}, reason: 'AI validation unavailable' };
}

// ─── Main Enrichment Pipeline ──────────────────────────────────────────────

/**
 * Normalizes a given social URL.
 * Removes query parameters, ensures standard formats (e.g. x.com -> twitter.com if preferred).
 */
function normalizeSocialUrl(url) {
    if (!url) return null;
    try {
        let u = new URL(url.toLowerCase());
        u.search = ''; // remove query params
        // standardize x.com to twitter.com or vice-versa
        if (u.hostname === 'twitter.com' || u.hostname === 'www.twitter.com') {
            u.hostname = 'x.com';
        }
        return u.toString().replace(/\/$/, ''); // remove trailing slash
    } catch {
        return url;
    }
}

/**
 * Deduplicate socials by value to prevent multiple platforms resolving to same generic link
 */
function deduplicateSocials(socials) {
    const seen = new Set();
    const result = {};
    for (const [platform, url] of Object.entries(socials)) {
        if (!url) continue;
        const norm = normalizeSocialUrl(url);
        if (!seen.has(norm)) {
            seen.add(norm);
            result[platform] = norm;
        }
    }
    return result;
}

/**
 * Run person enrichment logic.
 */
async function runPersonEnrichment(company_name, domain, city, person_name, designation) {
    let socials = {};
    const sourcesUsed = [];
    const allPlatforms = ['linkedin', 'instagram', 'x', 'youtube', 'facebook'];
    
    // Primary: SERP search for person
    const serpSocials = await searchSocialsViaSERP(company_name, allPlatforms, person_name);
    if (Object.keys(serpSocials).length > 0) {
        Object.assign(socials, serpSocials);
        sourcesUsed.push('serp');
        logger.info(`[enrich] SERP found ${Object.keys(serpSocials).length} person socials for "${person_name}"`);
    }

    socials = deduplicateSocials(socials);

    let confidence_score = 0;
    if (Object.keys(socials).length > 0) {
        const validation = await validateWithAI(company_name, domain, city, socials, person_name, designation);
        confidence_score = validation.confidence_score || 0;

        // Bonus scoring
        if (socials.linkedin) confidence_score = Math.min(100, confidence_score + 15);
        if (designation) confidence_score = Math.min(100, confidence_score + 5);

        if (validation.validated) {
            for (const [platform, valid] of Object.entries(validation.validated)) {
                if (valid === false && socials[platform]) {
                    delete socials[platform];
                }
            }
        }
        sourcesUsed.push('ai_validated');
    }

    return { socials, confidence_score, sourcesUsed, entity_type: 'person' };
}

/**
 * Run company enrichment logic.
 */
async function runCompanyEnrichment(company_name, domain, city) {
    let socials = {};
    const sourcesUsed = [];

    // Scrape website
    if (domain) {
        const { socials: scraped, sources } = await scrapeWebsiteForSocials(domain);
        Object.assign(socials, scraped);
        sourcesUsed.push(...sources);
        logger.info(`[enrich] Scraped ${Object.keys(scraped).length} company socials from ${domain}`);
    }

    // SERP fallback
    const allPlatforms = ['linkedin', 'instagram', 'x', 'youtube', 'facebook'];
    const missingPlatforms = allPlatforms.filter(p => !socials[p]);

    if (missingPlatforms.length > 0 && company_name) {
        const serpSocials = await searchSocialsViaSERP(company_name, missingPlatforms, null);
        if (Object.keys(serpSocials).length > 0) {
            Object.assign(socials, serpSocials);
            sourcesUsed.push('serp');
            logger.info(`[enrich] SERP found ${Object.keys(serpSocials).length} more for company "${company_name}"`);
        }
    }

    socials = deduplicateSocials(socials);

    let confidence_score = 0;
    if (Object.keys(socials).length > 0) {
        const validation = await validateWithAI(company_name, domain, city, socials, null, null);
        confidence_score = validation.confidence_score || 0;

        if (validation.validated) {
            for (const [platform, valid] of Object.entries(validation.validated)) {
                if (valid === false && socials[platform]) {
                    delete socials[platform];
                }
            }
        }
        sourcesUsed.push('ai_validated');
    }

    return { socials, confidence_score, sourcesUsed, entity_type: 'company' };
}

/**
 * Enrich a single company or person row.
 * @param {object} row - { company_name, domain, city, person_name, designation, ...original_data }
 * @returns {object} enrichment result
 */
async function enrichRow(row) {
    const { company_name, city, person_name, designation } = row;
    let domain = row.domain || row.website || row.Website || row.WEBSITE || null;

    // Step 1: Normalize domain
    if (domain) {
        domain = normalizeDomain(domain);
    }

    // Step 2: Find domain via SERP if still missing
    if (!domain && company_name) {
        logger.info(`[enrich] No domain for "${company_name}", searching via SERP`);
        domain = await findDomainViaSERP(company_name, city);
        if (domain) logger.info(`[enrich] Found domain: ${domain}`);
    }

    let result;

    if (person_name) {
        logger.info(`[enrich] Attempting PERSON enrichment for "${person_name}"`);
        result = await runPersonEnrichment(company_name, domain, city, person_name, designation);
        
        // Fallback to company if person confidence is low (< 40) or no profiles found
        if (result.confidence_score < 40 || Object.keys(result.socials).length === 0) {
            logger.info(`[enrich] Person enrichment failed/low confidence (${result.confidence_score}). Falling back to COMPANY enrichment.`);
            result = await runCompanyEnrichment(company_name, domain, city);
        }
    } else {
        logger.info(`[enrich] Running COMPANY enrichment for "${company_name}"`);
        result = await runCompanyEnrichment(company_name, domain, city);
    }

    return {
        domain,
        entity_type:    result.entity_type,
        linkedin_url:   result.socials.linkedin   || null,
        instagram_url:  result.socials.instagram  || null,
        x_url:          result.socials.x          || null,
        youtube_url:    result.socials.youtube    || null,
        facebook_url:   result.socials.facebook   || null,
        confidence_score: result.confidence_score,
        source: [...new Set(result.sourcesUsed)].join('|') || 'none',
    };
}

module.exports = {
    normalizeDomain,
    findDomainViaSERP,
    scrapeWebsiteForSocials,
    searchSocialsViaSERP,
    validateWithAI,
    enrichRow,
};
