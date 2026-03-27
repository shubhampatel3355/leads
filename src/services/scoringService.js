const logger = require('../utils/logger');

/**
 * Scoring engine — calculates fit, intent, final scores and classification.
 * Follows the blueprint scoring matrix exactly.
 */

// ─── Fit Scoring ──────────────────────────────────────────────

/**
 * Calculate fit score from lead profile data.
 * Business email → +15, Company present → +10, ICP match → +20
 */
function calculateFitScore(lead) {
    let score = 0;

    // Business email (not gmail, hotmail, yahoo, etc.)
    if (lead.email) {
        const domain = lead.email.split('@')[1]?.toLowerCase() || '';
        const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'mail.com', 'protonmail.com'];
        if (!freeProviders.includes(domain)) {
            score += 15;
        }
    }

    // Company present
    if (lead.company && lead.company.trim().length > 0) {
        score += 10;
    }

    // Job title present and indicates seniority (ICP match proxy)
    if (lead.job_title) {
        const title = lead.job_title.toLowerCase();
        const seniorTitles = ['vp', 'vice president', 'director', 'head', 'chief', 'cto', 'ceo', 'cfo', 'coo', 'cmo', 'svp', 'evp', 'founder', 'president', 'owner', 'partner'];
        const midTitles = ['manager', 'lead', 'senior', 'principal', 'sr.'];

        if (seniorTitles.some(t => title.includes(t))) {
            score += 20; // Strong ICP match
        } else if (midTitles.some(t => title.includes(t))) {
            score += 10; // Moderate match
        } else {
            score += 5; // Some title present
        }
    }

    // Industry present
    if (lead.industry && lead.industry.trim().length > 0) {
        score += 5;
    }

    // Phone present
    if (lead.phone) {
        score += 5;
    }

    return Math.min(score, 55); // Cap fit score at 55
}

// ─── Intent Scoring ───────────────────────────────────────────

/**
 * Provide the numeric intent score directly from the AI analysis.
 * The AI uses a 120-point framework.
 */
function calculateIntentScore(analysis) {
    return Number(analysis.total_score) || 0;
}

// ─── Final Score & Classification ─────────────────────────────

/**
 * Calculate final score and determine classification.
 * Honors the AI's exact classification if available (honoring its strict Hot Lead Rules).
 */
function calculateFinalScore(fitScore, intentScore, aiAnalysis) {
    const finalScore = fitScore + intentScore;

    let classification = 'cold';
    if (aiAnalysis && aiAnalysis.classification) {
        classification = aiAnalysis.classification.toLowerCase();
    } else {
        // Fallback for leads with no AI history
        if (finalScore >= 70) classification = 'hot';
        else if (finalScore >= 40) classification = 'warm';
    }

    return { finalScore, classification };
}

/**
 * Full scoring pipeline — fit + intent + final + classification.
 */
function fullScore(lead, aiAnalysis) {
    const fitScore = calculateFitScore(lead);
    const intentScore = aiAnalysis ? calculateIntentScore(aiAnalysis) : 0;
    const { finalScore, classification } = calculateFinalScore(fitScore, intentScore, aiAnalysis);

    logger.debug(`Scored lead ${lead.id}: fit=${fitScore} intent=${intentScore} final=${finalScore} → ${classification}`);

    return {
        fit_score: fitScore,
        intent_score: intentScore,
        final_score: finalScore,
        classification,
    };
}

module.exports = {
    calculateFitScore,
    calculateIntentScore,
    calculateFinalScore,
    fullScore,
};
