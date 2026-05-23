/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Extraction Oracle                                                ║
 * ║                                                                              ║
 * ║  The ExtractionOracle is the central decision-making component of ASTra v3. ║
 * ║  It uses a multi-factor weighted scoring model to decide whether a region   ║
 * ║  should be extracted into its own file, and with what confidence.           ║
 * ║                                                                              ║
 * ║  Scoring Dimensions (8 factors):                                            ║
 * ║    1. Size pressure         — region line count vs thresholds              ║
 * ║    2. Complexity signal     — CC + cognitive complexity combined            ║
 * ║    3. Kind affinity         — some kinds inherently belong in own files     ║
 * ║    4. Smell severity        — weighted sum of detected smells               ║
 * ║    5. Coupling pressure     — how many other regions depend on this one     ║
 * ║    6. Cohesion reward       — high cohesion = more self-contained           ║
 * ║    7. Testability gain      — extracting improves test isolation            ║
 * ║    8. Dead export penalty   — dead exports penalise extraction              ║
 * ║                                                                              ║
 * ║  Output: ExtractionDecision with score ∈ [0,1], confidence, and            ║
 * ║          predicted maintainability improvement (ΔMI).                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type {
    ASTRegion,
    RegionKind,
    ExtractionDecision,
    Confidence,
    RegionMetrics,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds (tuned on a corpus of 500+ real-world TS/TSX files)
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
    SIZE: {
        extract_hard:    120,   // always extract above this
        extract_soft:    60,    // extract with medium confidence
        retain_hard:     15,    // always retain below this
    },
    CC: {
        critical: 20,
        high:     10,
        moderate:  6,
    },
    COGNITIVE: {
        critical: 25,
        high:     15,
    },
    COUPLING: {
        high:     0.6,
        medium:   0.3,
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Kind extraction affinity (how strongly does this kind want to be extracted?)
// ─────────────────────────────────────────────────────────────────────────────

const KIND_AFFINITY: Record<RegionKind, number> = {
    'context-provider': 0.95,
    'hoc':              0.90,
    'hook':             0.85,
    'class':            0.75,
    'react-component':  0.65,
    'utility-function': 0.60,
    'constant-block':   0.40,
    'enum':             0.35,
    'namespace':        0.30,
    'type-block':       0.05,  // types → routing, not new files
    'export-group':     0.20,
    'decorator':        0.50,
    'unknown':          0.10,
};

const KIND_DIR: Record<RegionKind, ExtractionDecision['suggestedDir']> = {
    'context-provider': 'providers',
    'hoc':              'hoc',
    'hook':             'hooks',
    'class':            'services',
    'react-component':  'components',
    'utility-function': 'utils',
    'constant-block':   'constants',
    'enum':             'constants',
    'type-block':       'types',
    'namespace':        'utils',
    'export-group':     'utils',
    'decorator':        'utils',
    'unknown':          'utils',
};

// ─────────────────────────────────────────────────────────────────────────────
// Smell severity weights
// ─────────────────────────────────────────────────────────────────────────────

const SMELL_WEIGHTS: Record<string, number> = {
    'God Component':               0.30,
    'Mixed Concerns — API + Render': 0.25,
    'Oversized Module (>200 lines)': 0.25,
    'Large Module (>100 lines)':   0.15,
    'Extreme Cyclomatic Complexity (>20)': 0.20,
    'High Cyclomatic Complexity (>10)': 0.15,
    'Extreme Nesting (>8 levels)': 0.15,
    'Deep Nesting (>5 levels)':    0.10,
    'Prop Drilling':               0.10,
    'Async useEffect':             0.05,
    'Missing useEffect Dependency Array': 0.05,
};

// ─────────────────────────────────────────────────────────────────────────────
// Score → Confidence mapping
// ─────────────────────────────────────────────────────────────────────────────

function scoreToConfidence(score: number): Confidence {
    if (score >= 0.85) return 'definitive';
    if (score >= 0.70) return 'high';
    if (score >= 0.50) return 'medium';
    if (score >= 0.30) return 'low';
    return 'speculative';
}

// ─────────────────────────────────────────────────────────────────────────────
// MI delta estimation
// Higher complexity + lower MI → bigger MI improvement from extraction
// ─────────────────────────────────────────────────────────────────────────────

function estimateMIDelta(metrics: RegionMetrics, extractionScore: number): number {
    const baseGain = (100 - metrics.maintainabilityIndex) * 0.3;
    return Math.round(baseGain * extractionScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// File name generation
// ─────────────────────────────────────────────────────────────────────────────

function suggestFileName(
    name: string,
    kind: RegionKind,
    ext: string
): string {
    const dir = KIND_DIR[kind];

    // Kebab-case the name for file naming
    const kebab = name
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '');

    return `${dir}/${kebab}.${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ExtractionOracle — main function
// ─────────────────────────────────────────────────────────────────────────────

export interface OracleInput {
    region: ASTRegion;
    metrics: RegionMetrics;
    smellNames: string[];
    couplingScore: number;
    cohesionScore: number;
    isDeadExport: boolean;
    sourceFileExt: string;
    /** Set true when this region is in a Strongly Connected Component (cycle) */
    isInSCC: boolean;
    /**
     * Calibrated extraction threshold σ_threshold ∈ [0.10, 0.75].
     * Provided by the HalsteadThresholdCalibrator.
     * Falls back to 0.35 if not supplied.
     */
    calibratedThreshold?: number;
}

export function evaluateExtraction(input: OracleInput): ExtractionDecision {
    const {
        region, metrics, smellNames,
        couplingScore, cohesionScore,
        isDeadExport, sourceFileExt, isInSCC,
    } = input;

    const reasons: string[] = [];

    // ── Hard retain rules ────────────────────────────────────────────────────
    if (region.kind === 'type-block') {
        return {
            shouldExtract: false,
            reasons: ['Type blocks are routed to existing types file'],
            confidence: 'definitive',
            miDelta: 0,
            suggestedFileName: suggestFileName(region.name, region.kind, sourceFileExt),
            suggestedDir: 'types',
        };
    }
    if (metrics.lineCount < THRESHOLDS.SIZE.retain_hard) {
        return {
            shouldExtract: false,
            reasons: [`Too small to extract (${metrics.lineCount} lines < ${THRESHOLDS.SIZE.retain_hard})`],
            confidence: 'high',
            miDelta: 0,
            suggestedFileName: suggestFileName(region.name, region.kind, sourceFileExt),
            suggestedDir: KIND_DIR[region.kind],
        };
    }
    if (isDeadExport && metrics.lineCount < 30) {
        return {
            shouldExtract: false,
            reasons: ['Dead export — too small to justify a new file'],
            confidence: 'medium',
            miDelta: 0,
            suggestedFileName: suggestFileName(region.name, region.kind, sourceFileExt),
            suggestedDir: KIND_DIR[region.kind],
        };
    }

    // ── Scoring dimensions ────────────────────────────────────────────────────

    let score = 0.0;

    // 1. Size pressure (0–0.25)
    let sizeScore = 0;
    if (metrics.lineCount >= THRESHOLDS.SIZE.extract_hard) {
        sizeScore = 0.25;
        reasons.push(`Large region (${metrics.lineCount} lines ≥ ${THRESHOLDS.SIZE.extract_hard})`);
    } else if (metrics.lineCount >= THRESHOLDS.SIZE.extract_soft) {
        sizeScore = 0.15;
        reasons.push(`Medium region (${metrics.lineCount} lines ≥ ${THRESHOLDS.SIZE.extract_soft})`);
    } else {
        sizeScore = metrics.lineCount / (THRESHOLDS.SIZE.extract_soft * 4);
    }
    score += sizeScore;

    // 2. Complexity signal (0–0.25)
    let ccScore = 0;
    if (metrics.cyclomaticComplexity >= THRESHOLDS.CC.critical) {
        ccScore = 0.25;
        reasons.push(`Critical cyclomatic complexity (CC=${metrics.cyclomaticComplexity})`);
    } else if (metrics.cyclomaticComplexity >= THRESHOLDS.CC.high) {
        ccScore = 0.18;
        reasons.push(`High cyclomatic complexity (CC=${metrics.cyclomaticComplexity})`);
    } else if (metrics.cyclomaticComplexity >= THRESHOLDS.CC.moderate) {
        ccScore = 0.10;
    }
    if (metrics.cognitiveComplexity >= THRESHOLDS.COGNITIVE.critical) {
        ccScore = Math.min(0.25, ccScore + 0.08);
        reasons.push(`Critical cognitive complexity (CogC=${metrics.cognitiveComplexity})`);
    } else if (metrics.cognitiveComplexity >= THRESHOLDS.COGNITIVE.high) {
        ccScore = Math.min(0.25, ccScore + 0.04);
    }
    score += ccScore;

    // 3. Kind affinity (0–0.20)
    const affinityScore = KIND_AFFINITY[region.kind] * 0.20;
    score += affinityScore;
    if (KIND_AFFINITY[region.kind] >= 0.80) {
        reasons.push(`${region.kind} inherently benefits from file isolation`);
    }

    // 4. Smell severity (0–0.15)
    let smellScore = 0;
    for (const smellName of smellNames) {
        smellScore += SMELL_WEIGHTS[smellName] ?? 0.03;
    }
    smellScore = Math.min(0.15, smellScore);
    if (smellScore > 0.05) {
        reasons.push(`${smellNames.length} code smell(s) detected`);
    }
    score += smellScore;

    // 5. Coupling pressure (0–0.10)
    // High coupling from many dependents → worth isolating
    if (couplingScore >= THRESHOLDS.COUPLING.high) {
        score += 0.10;
        reasons.push('High coupling — many regions depend on this');
    } else {
        score += couplingScore * 0.10 / THRESHOLDS.COUPLING.high;
    }

    // 6. Cohesion reward (0–0.05)
    // High cohesion = self-contained = easy to extract cleanly
    score += cohesionScore * 0.05;

    // 7. Testability gain (0–0.05)
    // Isolated functions are far more testable
    if (region.kind === 'utility-function' || region.kind === 'hook') {
        score += 0.05;
        reasons.push('Extracting improves test isolation');
    }

    // 8. Dead export penalty (−0.05)
    if (isDeadExport) {
        score -= 0.05;
    }

    // SCC penalty — cyclic dependencies make extraction riskier
    if (isInSCC) {
        score -= 0.08;
        reasons.push('Part of a circular dependency — extraction needs care');
    }

    // ── Decision boundary ─────────────────────────────────────────────────────
    const threshold     = input.calibratedThreshold ?? 0.35;
    const shouldExtract = score >= threshold;

    // Minimum reason if extracting but no explicit reason yet
    if (shouldExtract && reasons.length === 0) {
        reasons.push('Multiple moderate signals combined to recommend extraction');
    }
    if (input.calibratedThreshold !== undefined && input.calibratedThreshold !== 0.35) {
        reasons.push(`Threshold calibrated to ${Math.round(input.calibratedThreshold * 100)}% (Halstead P75 effort)`);
    }

    return {
        shouldExtract,
        reasons,
        confidence: scoreToConfidence(score),
        miDelta: shouldExtract ? estimateMIDelta(metrics, score) : 0,
        suggestedFileName: suggestFileName(region.name, region.kind, sourceFileExt),
        suggestedDir: KIND_DIR[region.kind],
    };
}
