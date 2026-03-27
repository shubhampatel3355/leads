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
 * Map AI analysis output to a numeric intent score.
 * Blueprint mapping:
 *   Buying Intent: high → +40, medium → +20, low → +5
 *   Timeline: immediate → +25, 1-3 months → +15, 3-6 months → +5
 *   Budget: strong → +20, moderate → +10, weak → +3
 *   Decision Authority: yes → +15, influencer → +5
 */
function calculateIntentScore(analysis) {
    let score = 0;

    // Buying Intent
    const intentMap = { high: 40, medium: 20, low: 5, none: 0 };
    score += intentMap[analysis.buying_intent] || 0;

    // Timeline
    const timelineMap = { immediate: 25, '1-3_months': 15, '3-6_months': 5, no_timeline: 0 };
    score += timelineMap[analysis.timeline] || 0;

    // Budget (accept both budget_signal and budget_indication for compatibility)
    const budgetMap = { strong: 20, moderate: 10, weak: 3, none: 0 };
    const budgetValue = analysis.budget_signal || analysis.budget_indication;
    score += budgetMap[budgetValue] || 0;

    // Decision Authority (accept both decision_maker and decision_authority)
    const authMap = { yes: 15, influencer: 5, no: 0, unknown: 0 };
    const authValue = analysis.decision_maker || analysis.decision_authority;
    score += authMap[authValue] || 0;

    return Math.min(score, 100); // Cap at 100
}

// ─── Final Score & Classification ─────────────────────────────

/**
 * Calculate final score and determine classification.
 * final_score = fit_score + intent_score
 * Classification: 70+ → hot, 40-69 → warm, <40 → cold
 */
function calculateFinalScore(fitScore, intentScore) {
    const finalScore = fitScore + intentScore;

    let classification;
    if (finalScore >= 70) {
        classification = 'hot';
    } else if (finalScore >= 40) {
        classification = 'warm';
    } else {
        classification = 'cold';
    }

    return { finalScore, classification };
}

/**
 * Full scoring pipeline — fit + intent + final + classification.
 */
function fullScore(lead, aiAnalysis) {
    const fitScore = calculateFitScore(lead);
    const intentScore = aiAnalysis ? calculateIntentScore(aiAnalysis) : 0;
    const { finalScore, classification } = calculateFinalScore(fitScore, intentScore);

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
