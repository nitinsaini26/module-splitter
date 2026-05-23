/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Halstead Per-Function Threshold Calibrator                       ║
 * ║                                                                              ║
 * ║  Extends the existing file-level Halstead calibration to operate at         ║
 * ║  individual region granularity.                                              ║
 * ║                                                                              ║
 * ║  Problem with file-level calibration:                                        ║
 * ║    A file of 20 trivial constants + 1 complex God Component gets a          ║
 * ║    high threshold → the God Component escapes extraction.                   ║
 * ║                                                                              ║
 * ║  Solution — per-function calibration:                                        ║
 * ║    Each region's threshold is computed from BOTH:                           ║
 * ║      a) The file-level P75 effort (global context)                         ║
 * ║      b) The region's own Halstead effort vs. the file median               ║
 * ║                                                                              ║
 * ║  Formula:                                                                    ║
 * ║    ratio  = region_effort / median_file_effort   (clamped 0.1 – 10)        ║
 * ║    adj    = sigmoid((1 - ratio) × 1.5)           (0→1)                    ║
 * ║    σ_fn   = σ_file - (adj - 0.5) × MAX_DELTA                              ║
 * ║    σ_fn   = clamp(σ_fn, 0.10, 0.75)                                       ║
 * ║                                                                              ║
 * ║  Interpretation:                                                             ║
 * ║    ratio > 1 → this region is harder than average → lower threshold        ║
 * ║    ratio < 1 → this region is simpler than average → raise threshold        ║
 * ║    ratio = 1 → σ_fn = σ_file (no adjustment)                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { RegionMetrics } from '../types';
import { calibrateThreshold, type ThresholdCalibration } from './thresholdCalibrator';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DELTA   = 0.18;   // maximum per-function adjustment in either direction
const RATIO_CLAMP = 10;     // cap ratio so extreme outliers don't dominate

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx    = p * (sorted.length - 1);
    const lo     = Math.floor(idx);
    const hi     = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface PerFunctionCalibration {
    /** File-level calibrated threshold (from Halstead P75) */
    fileThreshold:     number;
    /** Per-region adjusted threshold */
    regionThreshold:   number;
    /** Region effort vs file median */
    effortRatio:       number;
    /** Adjustment applied to file threshold */
    adjustment:        number;
    /** Human-readable explanation */
    explanation:       string;
}

export interface PerFunctionCalibrationMap {
    /** regionId → calibration */
    calibrations:  Map<string, PerFunctionCalibration>;
    /** File-level baseline calibration */
    fileCalibration: ThresholdCalibration;
    /** Median effort across all regions */
    medianEffort:  number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: calibrate thresholds for all regions in a file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute per-function Halstead-calibrated thresholds for all regions.
 *
 * @param regionMetrics  Map of regionId → RegionMetrics (must have halsteadEffort)
 * @param userSetting    Value from astra.extractionThreshold setting (default 0.35)
 */
export function calibratePerFunction(
    regionMetrics: Map<string, RegionMetrics>,
    userSetting   = 0.35
): PerFunctionCalibrationMap {
    const allMetrics = [...regionMetrics.values()];

    // File-level calibration (P75 effort)
    const fileCalibration = calibrateThreshold(allMetrics, userSetting);
    const σ_file          = fileCalibration.threshold;

    // Median effort — used as the normalisation anchor
    const efforts     = allMetrics.map(m => m.halsteadEffort).filter(e => e > 0);
    const medianEffort = percentile(efforts, 0.5);

    const calibrations = new Map<string, PerFunctionCalibration>();

    for (const [regionId, metrics] of regionMetrics) {
        const regionEffort = metrics.halsteadEffort;

        if (regionEffort <= 0 || medianEffort <= 0) {
            // No effort data — use file threshold unchanged
            calibrations.set(regionId, {
                fileThreshold:   σ_file,
                regionThreshold: σ_file,
                effortRatio:     1,
                adjustment:      0,
                explanation:     `No Halstead effort data — using file threshold ${Math.round(σ_file * 100)}%`,
            });
            continue;
        }

        // Ratio: how complex is this region relative to the file median?
        const ratio = Math.max(1 / RATIO_CLAMP, Math.min(RATIO_CLAMP, regionEffort / medianEffort));

        // Sigmoid maps (1 - ratio) × 1.5 into (0, 1)
        // ratio > 1 → (1 - ratio) < 0 → sigmoid < 0.5 → adj < 0 → threshold lower
        // ratio < 1 → (1 - ratio) > 0 → sigmoid > 0.5 → adj > 0 → threshold higher
        const adj_raw   = (sigmoid((1 - ratio) * 1.5) - 0.5) * MAX_DELTA * 2;
        const adjustment = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, adj_raw));

        // σ_fn = σ_file + adjustment
        // ratio > 1 (hard region): sigmoid arg < 0 → sigmoid < 0.5 → adj < 0 → threshold LOWER ✓
        // ratio < 1 (easy region): sigmoid arg > 0 → sigmoid > 0.5 → adj > 0 → threshold HIGHER ✓
        const regionThreshold = Math.max(0.10, Math.min(0.75, σ_file + adjustment));

        const explanation = ratio > 1.5
            ? `Region effort ${Math.round(regionEffort)}× median — threshold lowered to ${Math.round(regionThreshold * 100)}%`
            : ratio < 0.67
            ? `Region effort ${Math.round(regionEffort)}× median — threshold raised to ${Math.round(regionThreshold * 100)}%`
            : `Region effort near file median — threshold unchanged at ${Math.round(regionThreshold * 100)}%`;

        calibrations.set(regionId, {
            fileThreshold:   Math.round(σ_file          * 1000) / 1000,
            regionThreshold: Math.round(regionThreshold  * 1000) / 1000,
            effortRatio:     Math.round(ratio            * 100)  / 100,
            adjustment:      Math.round(adjustment       * 1000) / 1000,
            explanation,
        });
    }

    return { calibrations, fileCalibration, medianEffort: Math.round(medianEffort) };
}

/**
 * Get the per-function threshold for a specific region, falling back to the
 * file-level threshold if no per-function calibration is available.
 */
export function getRegionThreshold(
    regionId:    string,
    calibMap:    PerFunctionCalibrationMap
): number {
    return calibMap.calibrations.get(regionId)?.regionThreshold
        ?? calibMap.fileCalibration.threshold;
}
