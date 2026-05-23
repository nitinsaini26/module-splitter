/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Halstead-Calibrated Dynamic Threshold                            ║
 * ║                                                                              ║
 * ║  Replaces the fixed σ_threshold = 0.35 with a per-file computed value       ║
 * ║  derived from the distribution of Halstead Effort scores across all regions. ║
 * ║                                                                              ║
 * ║  Intuition:                                                                   ║
 * ║    ▸ A file full of trivial regions (low effort) → raise threshold:          ║
 * ║      nothing should be extracted unless truly egregious                     ║
 * ║    ▸ A file full of complex regions (high effort) → lower threshold:         ║
 * ║      even moderately large regions should be split out                      ║
 * ║    ▸ A mixed file → use median effort as the calibration anchor             ║
 * ║                                                                              ║
 * ║  Algorithm:                                                                   ║
 * ║    1. Collect Halstead Effort (E) per region                                ║
 * ║    2. Compute percentile P75 (upper quartile) of E across all regions       ║
 * ║    3. Map P75 through a sigmoidal transfer function to [MIN, MAX]            ║
 * ║    4. Apply user-configured threshold bias (from VS Code settings)           ║
 * ║    5. Clamp to [0.10, 0.75]                                                 ║
 * ║                                                                              ║
 * ║  Transfer function:                                                           ║
 * ║    σ = MAX − (MAX − MIN) × sigmoid((E_p75 − E_mid) / E_scale)              ║
 * ║                                                                              ║
 * ║    where:  MIN = 0.20  MAX = 0.65  E_mid = 3000  E_scale = 2500           ║
 * ║                                                                              ║
 * ║    E_p75 < 500   → σ ≈ 0.60  (trivial file, raise bar)                    ║
 * ║    E_p75 ~ 3000  → σ ≈ 0.42  (typical file, near default)                 ║
 * ║    E_p75 > 8000  → σ ≈ 0.22  (very complex file, lower bar)               ║
 * ║                                                                              ║
 * ║  The user-configured `astra.extractionThreshold` setting acts as a          ║
 * ║  signed bias: the computed threshold is shifted by (setting − 0.35).        ║
 * ║  This lets power users nudge the calibrated value without overriding it.    ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { RegionMetrics } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLD_MIN   = 0.10;   // absolute floor
const THRESHOLD_MAX   = 0.75;   // absolute ceiling
const DEFAULT_BASE    = 0.35;   // matches legacy fixed value
const EFFORT_MID      = 3_000;  // effort at which σ ≈ 0.42 (near default)
const EFFORT_SCALE    = 2_500;  // sigmoid steepness: ±2500 E covers most of [MIN,MAX]
const PERCENTILE      = 0.75;   // use upper quartile (P75) as the calibration anchor

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Standard logistic sigmoid — maps any real to (0, 1) */
function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/** Compute the p-th percentile of a numeric array (p ∈ [0,1]) */
function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx    = p * (sorted.length - 1);
    const lo     = Math.floor(idx);
    const hi     = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    // Linear interpolation
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: calibration result type
// ─────────────────────────────────────────────────────────────────────────────

export interface ThresholdCalibration {
    /** The computed per-file σ_threshold ∈ [0.10, 0.75] */
    threshold:     number;
    /** Halstead effort P75 across all regions */
    effortP75:     number;
    /** Raw sigmoid output before clamping */
    rawSigmoid:    number;
    /** User bias applied (configuredThreshold − 0.35) */
    userBias:      number;
    /** Description of the calibration result */
    interpretation: 'trivial-file' | 'simple-file' | 'typical-file' | 'complex-file' | 'highly-complex-file';
    /** Human-readable explanation for the webview */
    explanation:   string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: compute the calibrated threshold for a file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Halstead-calibrated extraction threshold for this file.
 *
 * @param regionMetrics    Computed metrics for every region in the file
 * @param userSetting      The value from `astra.extractionThreshold` (default 0.35)
 */
export function calibrateThreshold(
    regionMetrics: RegionMetrics[],
    userSetting:   number = DEFAULT_BASE
): ThresholdCalibration {

    // Collect effort values
    const efforts = regionMetrics.map(m => m.halsteadEffort).filter(e => e > 0);

    // Edge case: no regions or all zero effort → use default
    if (efforts.length === 0) {
        return _makeResult(DEFAULT_BASE, 0, 0, userSetting, DEFAULT_BASE);
    }

    // P75 of effort distribution
    const effortP75 = percentile(efforts, PERCENTILE);

    // Sigmoid transfer:
    //   high effort   → sigmoid argument is negative → sigmoid close to 0 → threshold close to MIN
    //   low effort    → sigmoid argument is positive → sigmoid close to 1 → threshold close to MAX
    const sigArg    = (EFFORT_MID - effortP75) / EFFORT_SCALE;
    const sig       = sigmoid(sigArg);

    // Map sigmoid (0→1) into [MIN, MAX]
    const baseThreshold = THRESHOLD_MIN + (THRESHOLD_MAX - THRESHOLD_MIN) * sig;

    // Apply user bias: shift by (userSetting − DEFAULT_BASE)
    // Bias is clamped to ±0.25 so users can't fully override calibration
    const userBias  = Math.max(-0.25, Math.min(0.25, userSetting - DEFAULT_BASE));
    const computed  = Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, baseThreshold + userBias));

    return _makeResult(computed, effortP75, sig, userSetting, baseThreshold);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _interpret(effortP75: number): ThresholdCalibration['interpretation'] {
    if (effortP75 < 200)   return 'trivial-file';
    if (effortP75 < 1000)  return 'simple-file';
    if (effortP75 < 4000)  return 'typical-file';
    if (effortP75 < 9000)  return 'complex-file';
    return 'highly-complex-file';
}

function _explain(
    interpretation: ThresholdCalibration['interpretation'],
    threshold: number,
    effortP75: number,
    userBias: number
): string {
    const pct   = Math.round(threshold * 100);
    const biasTxt = userBias !== 0
        ? ` (includes ${userBias > 0 ? '+' : ''}${Math.round(userBias * 100)}% user bias from settings)`
        : '';

    switch (interpretation) {
        case 'trivial-file':
            return `File is trivial (P75 effort: ${Math.round(effortP75)}). Threshold raised to ${pct}% — only extract if very strong signals exist${biasTxt}.`;
        case 'simple-file':
            return `File is simple (P75 effort: ${Math.round(effortP75)}). Threshold is ${pct}% — moderate bar for extraction${biasTxt}.`;
        case 'typical-file':
            return `File complexity is typical (P75 effort: ${Math.round(effortP75)}). Threshold is ${pct}% — standard extraction criteria${biasTxt}.`;
        case 'complex-file':
            return `File is complex (P75 effort: ${Math.round(effortP75)}). Threshold lowered to ${pct}% — more regions qualify for extraction${biasTxt}.`;
        case 'highly-complex-file':
            return `File is highly complex (P75 effort: ${Math.round(effortP75)}). Threshold lowered to ${pct}% — aggressive extraction recommended${biasTxt}.`;
    }
}

function _makeResult(
    threshold:     number,
    effortP75:     number,
    rawSigmoid:    number,
    userSetting:   number,
    _baseThreshold: number
): ThresholdCalibration {
    const userBias      = Math.max(-0.25, Math.min(0.25, userSetting - DEFAULT_BASE));
    const interpretation = _interpret(effortP75);
    return {
        threshold:   Math.round(threshold * 1000) / 1000,
        effortP75:   Math.round(effortP75),
        rawSigmoid:  Math.round(rawSigmoid * 1000) / 1000,
        userBias:    Math.round(userBias * 1000) / 1000,
        interpretation,
        explanation: _explain(interpretation, threshold, effortP75, userBias),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: check if a score passes the calibrated threshold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `score` meets or exceeds the calibrated threshold.
 * Replaces the old hardcoded `score >= 0.35` check.
 */
export function meetsThreshold(score: number, calibration: ThresholdCalibration): boolean {
    return score >= calibration.threshold;
}
