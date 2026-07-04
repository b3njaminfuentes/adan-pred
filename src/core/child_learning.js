// src/core/child_learning.js
// Child Learning Engine — Shadow Predictions, Weighted Consensus & Evolutionary Architecture
// Each child records predictions, accumulates accuracy, and evolves its DNA over time.

import fs from 'fs';
import path from 'path';
import { wilmott } from './wilmott_quant.js';
import { moeDynasty } from './moe_dynasty.js';

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const DIR = process.env.ADAN_DIR || path.join(HOME, '.adan-pred');
const LEARNING_PATH = path.join(DIR, 'child_learning.json');
const SHADOWS_PATH = path.join(DIR, 'child_shadows.jsonl');
const CHILDREN_DIR = path.join(DIR, 'children');

const MAX_CHILDREN_PER_PARENT = 3;
const GRANDCHILD_COUNT = 20;           // Ephemeral grandchildren per simulation round
const GRANDCHILD_SIM_WINDOW = 50;      // Simulate against last N price candles
const GRANDCHILD_SURVIVAL_TOP = 3;     // Top N grandchildren whose DNA propagates up
const MIN_PREDICTIONS_FOR_WEIGHT = 3;    // TRAINING: 3 preds to start weighting
const MIN_PREDICTIONS_FOR_EVOLUTION = 15; // TRAINING: evolve sooner
const EVOLUTION_INTERVAL = 5;             // TRAINING: evolve every 5 resolved — hyperspeed
const MUTATION_RATE = 0.15;               // TRAINING: 15% mutation — explore more DNA space
const DIVERSITY_THRESHOLD = 0.80;         // TRAINING: force diversity earlier
const MIN_PARENT_ACCURACY = 50;           // v4.1: Parents must have >=50% accuracy to reproduce

// ═══ DEFAULT DNA — the tunable parameters each child can evolve ═══
const DEFAULT_DNA = {
    rsiOversold: 35,
    rsiOverbought: 65,
    macdWeight: 1.0,
    trendMinPct: 0.3,
    trend15mMinPct: 0.5,
    volSpikeThreshold: 1.5,
    minConfidence: 55,
    generation: 1
};

// Hard floors and ceilings for each parameter (prevents insane mutations)
const DNA_BOUNDS = {
    rsiOversold: { min: 20, max: 45 },
    rsiOverbought: { min: 55, max: 80 },
    macdWeight: { min: 0.2, max: 2.0 },
    trendMinPct: { min: 0.05, max: 1.0 },
    trend15mMinPct: { min: 0.1, max: 1.5 },
    volSpikeThreshold: { min: 1.0, max: 3.0 },
    minConfidence: { min: 40, max: 80 },
};

// ═══ v4.0: LLM-TRACK DNA — Strategy parameters for non-crypto children ═══
const LLM_DNA_DEFAULTS = {
    confidenceFloor: 50,
    edgeThresholdPct: 3,
    newsRecencyHours: 24,
    maxMarketsPerCycle: 5,
    skipIfLiquidityBelow: 500,
    generation: 1,
};

const LLM_DNA_BOUNDS = {
    confidenceFloor: { min: 40, max: 75 },
    edgeThresholdPct: { min: 3, max: 25 },
    newsRecencyHours: { min: 1, max: 72 },
    maxMarketsPerCycle: { min: 1, max: 8 },
    skipIfLiquidityBelow: { min: 100, max: 10000 },
};

// ═══ PERP-TRACK DNA — Strategy parameters for Hyperliquid perpetual children ═══
const PERP_DNA_DEFAULTS = {
    leverageBase: 3,            // base leverage multiplier
    slTightness: 1.5,           // stop loss as % of ATR (1.0 = tight, 2.0 = loose)
    tpMultiplier: 2.5,          // TP = SL × this (risk:reward)
    fundingFadeThreshold: 0.05, // fade when funding > this %
    vpinEntryMin: 0.5,          // min VPIN to enter
    oiConfirmation: true,       // require OI expansion for trend trades
    generation: 1,
};

const PERP_DNA_BOUNDS = {
    leverageBase: { min: 1, max: 10 },
    slTightness: { min: 0.5, max: 3.0 },
    tpMultiplier: { min: 1.5, max: 5.0 },
    fundingFadeThreshold: { min: 0.01, max: 0.15 },
    vpinEntryMin: { min: 0.2, max: 0.8 },
};

class ChildLearningEngine {
    constructor() {
        this.learning = {};   // { childId: { predictions, correct, wrong, accuracy, perSignal, dna, ... } }
        this.shadows = [];    // Unresolved shadow predictions
        this.globalResolved = 0;
        this.lastEvolution = 0;
        this._load();
    }

    // ═══ PHASE 1: SHADOW PREDICTION TRACKING ═══

    /**
     * Record a child's prediction as a shadow bet
     * Called from runChildScanner() whenever a child emits a non-NEUTRAL signal
     */
    recordPrediction(childId, { direction, confidence, asset, marketId, marketCloseTime, reasons, regime = 'UNKNOWN', track = 'quant', category = 'crypto', entryPrice = null }) {
        const shadow = {
            childId,
            direction,       // 'UP' or 'DOWN' (or 'YES'/'NO' for LLM track)
            confidence,
            asset,
            marketId: marketId || `${asset}_${Date.now()}`,
            marketCloseTime: marketCloseTime || new Date(Date.now() + 5 * 60000).toISOString(),
            reasons: reasons || [],
            regime,         // TRENDING, VOLATILE, MEAN_REVERTING
            track,          // 'quant' or 'llm'
            category,       // 'crypto', 'politics', 'sports', 'macro', 'events'
            ts: new Date().toISOString(),
            entryPrice,     // Must be set at record time for accurate resolution
            resolved: false,
            correct: null,
        };

        this.shadows.push(shadow);

        // Persist shadow (with entryPrice already set)
        try {
            fs.appendFileSync(SHADOWS_PATH, JSON.stringify(shadow) + '\n');
        } catch (e) { /* skip */ }

        return shadow;
    }

    /**
     * Check if any shadow predictions can be resolved
     * Called from the main checkResolutions() cycle
     */
    /**
     * Check resolutions — dual-track logic:
     * - Track 'quant': resolve by Binance price movement (existing)
     * - Track 'llm': resolve by Polymarket API polling (checkMarketResolution callback)
     * @param {object} prices - Binance price data
     * @param {function} [checkMarketResolutionFn] - async fn(marketId) → { resolved, resolution }
     */
    async checkResolutions(prices, checkMarketResolutionFn = null) {
        const now = Date.now();
        let resolved = 0;

        for (const s of this.shadows) {
            if (s.resolved) continue;

            // ── LLM track: resolve via Polymarket API polling ──
            if (s.track === 'llm') {
                if (!checkMarketResolutionFn) continue;
                try {
                    const result = await checkMarketResolutionFn(s.marketId);
                    if (!result || !result.resolved) continue;

                    const actualDirection = result.resolution === 'YES' ? 'YES' : 'NO';
                    const predicted = s.direction === 'UP' ? 'YES' : s.direction === 'DOWN' ? 'NO' : s.direction;
                    const correct = (predicted === actualDirection);

                    s.resolved = true;
                    s.correct = correct;
                    s.resolvedAt = new Date().toISOString();
                    s.actualDirection = actualDirection;

                    this._updateChildStats(s);
                    resolved++;

                    const icon = correct ? '✅' : '❌';
                    console.log(`[CHILD LEARNING][LLM] ${icon} ${s.childId}: predicted ${predicted}, resolved ${actualDirection} | ${correct ? 'CORRECT' : 'WRONG'}`);
                } catch (e) { /* skip */ }
                continue;
            }

            // ── Quant track: resolve by price movement ──
            const closeTime = new Date(s.marketCloseTime).getTime();
            if (closeTime > now) continue; // Not closed yet

            try {
                const sym = this._assetToSymbol(s.asset);
                if (!s.entryPrice || s.entryPrice <= 0) continue; // No valid entryPrice — skip

                // Grade at WINDOW CLOSE, not at whatever moment this loop runs.
                // Grading against the current price added resolution-timing noise
                // to the exact metric that decides which child is "elite".
                const closePrice = await this._priceAtTime(sym, closeTime);
                const currentPrice = closePrice ?? prices?.[sym]?.price; // fail-soft fallback
                if (!currentPrice) continue;

                const pctChange = (currentPrice - s.entryPrice) / s.entryPrice;
                const actualDirection = pctChange > 0.001 ? 'UP' : pctChange < -0.001 ? 'DOWN' : 'NEUTRAL';

                // Dead zone: price moved <0.1% — treat as no-contest, skip resolution
                // Children never predict NEUTRAL, so counting it as wrong is unfair
                if (actualDirection === 'NEUTRAL') continue;

                const correct = (s.direction === actualDirection);

                s.resolved = true;
                s.correct = correct;
                s.resolvedAt = new Date().toISOString();
                s.actualDirection = actualDirection;

                this._updateChildStats(s);
                resolved++;

                const icon = correct ? '✅' : '❌';
                console.log(`[CHILD LEARNING] ${icon} ${s.childId}: predicted ${s.direction}, actual ${actualDirection} | ${correct ? 'CORRECT' : 'WRONG'}`);
            } catch (e) { /* skip */ }
        }

        if (resolved > 0) {
            this.globalResolved += resolved;
            this._save();
            this._printReport();

            // Check if evolution should trigger — DUAL POOL
            if (this.globalResolved - this.lastEvolution >= EVOLUTION_INTERVAL) {
                this._evolve();
                this.lastEvolution = this.globalResolved;
                this._save();
            }
        }

        // Cleanup old resolved shadows (keep last 1000)
        const resolvedShadows = this.shadows.filter(s => s.resolved);
        if (resolvedShadows.length > 1000) {
            this.shadows = [
                ...this.shadows.filter(s => !s.resolved),
                ...resolvedShadows.slice(-1000)
            ];
        }

        return resolved;
    }

    // ═══ STATS & WEIGHTED CONSENSUS ═══

    /**
     * Get stats for a specific child
     */
    getChildStats(childId) {
        const id = childId?.toLowerCase() || childId;
        return this.learning[id] || this.learning[childId] || this._initChild(id);
    }

    /**
     * Calculate weighted consensus from all children's current signals
     * @param {Array} childSignals - [{ childId, direction, confidence }, ...]
     * @returns {{ direction, weightedConfidence, details }}
     */
    getWeightedConsensus(childSignals) {
        if (!childSignals || childSignals.length === 0) {
            return { direction: 'NEUTRAL', weightedConfidence: 0, details: [] };
        }

        let upScore = 0, downScore = 0;
        const details = [];

        for (const sig of childSignals) {
            if (sig.direction === 'NEUTRAL') continue;

            const stats = this.getChildStats(sig.childId);

            // ── REGIME-WEIGHTED CONSENSUS ──
            // If we have a current regime from the signal, we use the regime-specific accuracy.
            // Otherwise, fallback to the global accuracy.
            const regime = sig.regime || 'UNKNOWN';
            let accuracyToUse = stats.accuracy;
            let usedRegimeAcc = false;

            if (regime !== 'UNKNOWN' && stats.regimes && stats.regimes[regime] && stats.regimes[regime].total >= 5) {
                // We have enough data to judge this child's performance in this specific regime
                accuracyToUse = Math.round((stats.regimes[regime].correct / stats.regimes[regime].total) * 100);
                usedRegimeAcc = true;
            }

            // Weight = accuracy / 50 (so 60% acc = 1.2x, 40% = 0.8x)
            // If not enough data, weight = 1.0 (neutral)
            const weight = stats.totalResolved >= MIN_PREDICTIONS_FOR_WEIGHT
                ? Math.max(0.3, Math.min(2.0, accuracyToUse / 50))
                : 1.0;

            const contribution = sig.confidence * weight;

            if (sig.direction === 'UP') upScore += contribution;
            else if (sig.direction === 'DOWN') downScore += contribution;

            details.push({
                childId: sig.childId,
                direction: sig.direction,
                confidence: sig.confidence,
                accuracy: accuracyToUse,
                regimeUsed: usedRegimeAcc ? regime : 'GLOBAL',
                weight: parseFloat(weight.toFixed(2)),
                generation: stats.dna?.generation || 1,
                totalResolved: stats.totalResolved,
            });
        }

        const totalScore = upScore + downScore;
        const direction = upScore > downScore ? 'UP' : downScore > upScore ? 'DOWN' : 'NEUTRAL';
        const weightedConfidence = totalScore > 0
            ? Math.round((Math.max(upScore, downScore) / totalScore) * 100)
            : 0;

        // Sort details: highest weight first
        details.sort((a, b) => b.weight - a.weight);

        return { direction, weightedConfidence, details };
    }

    /**
     * Generate prompt context for the LLM (replaces flat intel summary)
     */
    getPromptContext(childSignals) {
        const consensus = this.getWeightedConsensus(childSignals);
        if (consensus.details.length === 0) return '';

        const agreeing = consensus.details.filter(d => d.direction === consensus.direction);
        const opposing = consensus.details.filter(d => d.direction !== consensus.direction && d.direction !== 'NEUTRAL');

        const lines = [
            `━━━ DYNASTY WEIGHTED CONSENSUS ━━━`,
            `Direction: ${consensus.direction} (${consensus.weightedConfidence}% weighted confidence)`,
        ];

        if (agreeing.length > 0) {
            lines.push(`Agreeing: ${agreeing.map(d =>
                `${d.childId}(${d.accuracy}% acc [${d.regimeUsed}], ${d.weight}x)`
            ).join(', ')}`);
        }
        if (opposing.length > 0) {
            lines.push(`Opposing: ${opposing.map(d =>
                `${d.childId}(${d.accuracy}% acc [${d.regimeUsed}], ${d.weight}x) → signal discounted`
            ).join(', ')}`);
        }

        const maxGen = Math.max(...consensus.details.map(d => d.generation), 1);
        const totalResolved = Object.values(this.learning).reduce((s, l) => s + (l.totalResolved || 0), 0);
        const nextEvolution = EVOLUTION_INTERVAL - (this.globalResolved - this.lastEvolution);
        lines.push(`Generation: G${maxGen} | Total resolved: ${totalResolved} | Next evolution in ${nextEvolution} predictions`);

        return lines.join('\n');
    }

    /**
     * Get DNA for a child (for use in childSignal function to use evolved thresholds)
     */
    getChildDNA(childId, track = 'quant') {
        const stats = this.getChildStats(childId);
        if (track === 'llm') {
            return stats.dna || { ...LLM_DNA_DEFAULTS };
        }
        return stats.dna || { ...DEFAULT_DNA };
    }

    /**
     * Initialize a child with LLM track defaults
     */
    initLLMChild(childId) {
        if (!this.learning[childId]) {
            this.learning[childId] = {
                ...this._initChild(childId),
                dna: { ...LLM_DNA_DEFAULTS },
                track: 'llm',
            };
            this._save();
        }
        return this.learning[childId];
    }

    // ═══ PHASE 2: EVOLUTIONARY ENGINE ═══

    _evolve() {
        // ── TRIPLE-POOL EVOLUTION: Crypto quant, LLM, and Perp pools NEVER cross ──
        this._evolvePool('quant', DNA_BOUNDS, DEFAULT_DNA);
        this._evolvePool('llm', LLM_DNA_BOUNDS, LLM_DNA_DEFAULTS);
        // Perp children use PERP_DNA_BOUNDS but are already in 'quant' track
        // The per-coin A/B lineages compete within the quant pool naturally
    }

    _evolvePool(trackName, bounds, defaults) {
        const children = Object.entries(this.learning)
            .filter(([, stats]) => {
                const childTrack = stats.track || 'quant';
                return childTrack === trackName && stats.totalResolved >= 5;
            })
            .sort((a, b) => {
                // Wilmott Ch17+Ch75: Growth rate × Skill Factor
                // Composite = accuracy × log(trades+1) × skillBonus
                // Skill Factor (Ch 75): p = 2×(winRate-0.5), bonus if statistically significant
                const calcScore = (stats) => {
                    if (stats.totalResolved < 20) return stats.accuracy / 100;
                    const freqEdge = (stats.accuracy / 100) * Math.log(stats.totalResolved + 1);
                    const skill = wilmott.skill.computeSkill(stats.correct || 0, stats.wrong || 0);
                    const skillBonus = skill.isSkilled ? 1.0 + skill.p : 1.0;
                    return freqEdge * skillBonus;
                };
                return calcScore(b[1]) - calcScore(a[1]);
            });

        if (children.length < 1) return; // Need at least 1 child

        console.log(`\n[EVOLUTION][${trackName.toUpperCase()}] 🧬 ═══ EVOLUTIONARY CYCLE ═══`);

        // Log composite scores (Wilmott frequency×edge×skill ranking)
        for (const [id, stats] of children) {
            const skill = wilmott.skill.computeSkill(stats.correct || 0, stats.wrong || 0);
            const freqEdge = stats.totalResolved >= 20
                ? (stats.accuracy / 100) * Math.log(stats.totalResolved + 1)
                : stats.accuracy / 100;
            const skillBonus = skill.isSkilled ? 1.0 + skill.p : 1.0;
            const composite = freqEdge * skillBonus;
            console.log(`[EVOLUTION][${trackName.toUpperCase()}] 📊 ${id}: acc=${stats.accuracy}% trades=${stats.totalResolved} skill=${skill.p.toFixed(3)}${skill.isSkilled ? '✓' : ''} composite=${composite.toFixed(3)}`);
        }

        // ── DEAD ZONE KILLER: Force-reset children stuck at 25-45% with 200+ trades ──
        // These children are too bad to be useful but too good to contrarian-flip.
        // Fresh random DNA breaks them out of local minima that crossover can't escape.
        for (const [id, stats] of children) {
            if (stats.totalResolved >= 200 && stats.accuracy >= 25 && stats.accuracy < 45) {
                console.log(`[EVOLUTION][${trackName.toUpperCase()}] 💀 DEAD ZONE KILL: ${id} (${stats.accuracy}% over ${stats.totalResolved} trades) — stuck in 25-45% dead zone → fresh random DNA`);
                const freshDNA = {};
                for (const key of Object.keys(bounds)) {
                    const b = bounds[key];
                    freshDNA[key] = parseFloat((b.min + Math.random() * (b.max - b.min)).toFixed(2));
                }
                freshDNA.generation = (stats.dna?.generation || 1) + 1;
                this.learning[id] = {
                    ...this._initChild(id),
                    dna: freshDNA,
                    track: trackName,
                    evolvedFrom: ['dead_zone_reset'],
                    evolvedAt: new Date().toISOString(),
                };
            }
        }

        // v4.1: Filter parents by MIN_PARENT_ACCURACY — stop bad genes from reproducing
        // Re-fetch children after dead zone kills
        const survivingChildren = Object.entries(this.learning)
            .filter(([, stats]) => {
                const childTrack = stats.track || 'quant';
                return childTrack === trackName && stats.totalResolved >= 5;
            });
        const qualifiedParents = survivingChildren.filter(([, stats]) => stats.accuracy >= MIN_PARENT_ACCURACY);
        const [worstId, worstStats] = children[children.length - 1];

        console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🔬 Qualified parents (>=${MIN_PARENT_ACCURACY}% acc): ${qualifiedParents.length}/${children.length}`);
        console.log(`[EVOLUTION][${trackName.toUpperCase()}] 💀 Worst: ${worstId} (${worstStats.accuracy}%) → CULLING`);

        if (qualifiedParents.length === 0) {
            console.log(`[EVOLUTION][${trackName.toUpperCase()}] ⛔ No parents qualify (all <${MIN_PARENT_ACCURACY}% accuracy) — skipping evolution, culling worst`);
            // Still cull the worst child — rebirth with fresh defaults
            this.learning[worstId] = {
                ...this._initChild(worstId),
                dna: { ...defaults, generation: (worstStats.dna?.generation || 1) + 1 },
                track: trackName,
                evolvedFrom: ['fresh_reset'],
                evolvedAt: new Date().toISOString(),
            };
            return;
        }

        let best1Id, best1Stats, best2Id, best2Stats;

        if (qualifiedParents.length === 1) {
            // Self-crossover with 2x mutation
            [best1Id, best1Stats] = qualifiedParents[0];
            best2Id = best1Id;
            best2Stats = best1Stats;
            console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🏆 Solo parent: ${best1Id} (${best1Stats.accuracy}%) — self-crossover with 2x mutation`);
        } else {
            [best1Id, best1Stats] = qualifiedParents[0];
            [best2Id, best2Stats] = qualifiedParents[1];
            console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🏆 Best: ${best1Id} (${best1Stats.accuracy}%) + ${best2Id} (${best2Stats.accuracy}%)`);
        }

        const entropy = this._calculateShannonEntropy(children.map(c => c[1].dna), bounds);
        console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🧬 Gene Pool Entropy: H = ${entropy.toFixed(3)}`);

        const effectiveMutationRate = qualifiedParents.length === 1 ? MUTATION_RATE * 2 : MUTATION_RATE;

        // Crossover using pool-specific bounds
        let newDNA = {};
        for (const key of Object.keys(bounds)) {
            newDNA[key] = Math.random() < 0.5
                ? (best1Stats.dna?.[key] ?? defaults[key])
                : (best2Stats.dna?.[key] ?? defaults[key]);
        }

        // Mutation
        let mutatedDNA = {};
        for (const key of Object.keys(bounds)) {
            mutatedDNA[key] = this._mutateParam(newDNA[key] ?? defaults[key], key, effectiveMutationRate, bounds);
        }

        // Diversity enforcement
        if (entropy < 0.5) {
            console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🚨 Monoculture! Forcing 3x mutation`);
            for (const key of Object.keys(bounds)) {
                mutatedDNA[key] = this._mutateParam(mutatedDNA[key], key, MUTATION_RATE * 3, bounds);
            }
        } else {
            for (const [id, stats] of children) {
                if (id === worstId) continue;
                const similarity = this._dnaSimilarity(mutatedDNA, stats.dna, bounds);
                if (similarity > DIVERSITY_THRESHOLD) {
                    console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🔀 Diversity penalty (${(similarity * 100).toFixed(0)}% similar to ${id})`);
                    for (const key of Object.keys(bounds)) {
                        mutatedDNA[key] = this._mutateParam(mutatedDNA[key], key, MUTATION_RATE * 2, bounds);
                    }
                    break;
                }
            }
        }

        mutatedDNA.generation = Math.max(best1Stats.dna?.generation || 1, best2Stats.dna?.generation || 1) + 1;

        // Cull + rebirth
        this.learning[worstId] = {
            ...this._initChild(worstId),
            dna: mutatedDNA,
            track: trackName,
            evolvedFrom: [best1Id, best2Id],
            evolvedAt: new Date().toISOString(),
        };

        console.log(`[EVOLUTION][${trackName.toUpperCase()}] 🌱 ${worstId} reborn as G${mutatedDNA.generation} from ${best1Id} × ${best2Id}`);
        console.log(`[EVOLUTION][${trackName.toUpperCase()}] 📊 New DNA:`, JSON.stringify(mutatedDNA, null, 2));
        console.log(`[EVOLUTION][${trackName.toUpperCase()}] ═══════════════════════════════════\n`);
    }

    _crossover(dna1, dna2, bounds = DNA_BOUNDS, defaults = DEFAULT_DNA) {
        const child = {};
        for (const key of Object.keys(bounds)) {
            child[key] = Math.random() < 0.5 ? (dna1?.[key] ?? defaults[key]) : (dna2?.[key] ?? defaults[key]);
        }
        return child;
    }

    _mutate(dna, bounds = DNA_BOUNDS, defaults = DEFAULT_DNA) {
        const mutated = { ...dna };
        for (const key of Object.keys(bounds)) {
            mutated[key] = this._mutateParam(mutated[key] ?? defaults[key], key, MUTATION_RATE, bounds);
        }
        return mutated;
    }

    _mutateParam(value, paramName, rate, bounds = DNA_BOUNDS) {
        const noise = 1 + (Math.random() * 2 - 1) * rate;
        const mutated = value * noise;
        const b = bounds[paramName];
        if (!b) return mutated;
        return Math.max(b.min, Math.min(b.max, parseFloat(mutated.toFixed(2))));
    }

    _dnaSimilarity(dna1, dna2, bounds = DNA_BOUNDS) {
        if (!dna1 || !dna2) return 0;
        let totalDiff = 0, count = 0;
        for (const key of Object.keys(bounds)) {
            const v1 = dna1[key] ?? 0;
            const v2 = dna2[key] ?? 0;
            const maxVal = Math.max(Math.abs(v1), Math.abs(v2), 0.01);
            totalDiff += Math.abs(v1 - v2) / maxVal;
            count++;
        }
        return count > 0 ? 1 - (totalDiff / count) : 0;
    }

    /**
     * Calculates Shannon Entropy (H) of the current gene pool.
     * H = -Σ p_i * log(p_i)
     * High entropy = High diversity (healthy). Low entropy = Monoculture (danger).
     */
    _calculateShannonEntropy(dnas, bounds = DNA_BOUNDS) {
        if (!dnas || dnas.length < 2) return 1.0;

        let totalEntropy = 0;
        const keys = Object.keys(bounds);
        const numBins = 5;

        for (const key of keys) {
            const min = bounds[key].min;
            const max = bounds[key].max;
            const range = max - min;
            const binCounts = new Array(numBins).fill(0);

            // Assign each DNA's parameter to a bucket
            for (const dna of dnas) {
                let val = dna[key] ?? DEFAULT_DNA[key];
                val = Math.max(min, Math.min(max, val)); // Clamp
                let binIdx = Math.floor(((val - min) / range) * numBins);
                if (binIdx >= numBins) binIdx = numBins - 1; // edge case for val === max
                binCounts[binIdx]++;
            }

            // Calculate entropy for this parameter
            let paramEntropy = 0;
            for (const count of binCounts) {
                if (count > 0) {
                    const p = count / dnas.length;
                    paramEntropy -= p * Math.log2(p);
                }
            }

            // Normalize paramEntropy to [0, 1] range. Max entropy for N bins is log2(N)
            const maxPossibleEntropy = Math.log2(numBins);
            const normalizedEntropy = maxPossibleEntropy > 0 ? paramEntropy / maxPossibleEntropy : 0;

            totalEntropy += normalizedEntropy;
        }

        // Average entropy across all parameters
        return totalEntropy / keys.length;
    }

    // ═══ INTERNAL HELPERS ═══

    _updateChildStats(shadow) {
        const id = shadow.childId;
        if (!this.learning[id]) this.learning[id] = this._initChild(id);

        const stats = this.learning[id];
        stats.totalResolved++;

        if (shadow.correct) {
            stats.correct++;
        } else {
            stats.wrong++;
        }
        stats.accuracy = parseFloat((stats.correct / stats.totalResolved * 100).toFixed(1));

        // ═══ GENETIC FIX: Sync resolution to child pnl.json for absorbEliteGenome ═══
        this._syncChildPnl(id, shadow.correct);

        // ═══ MOE DYNASTY: Update expert gate weights ═══
        try {
            const asset = shadow.asset || '';
            const tfMatch = id.match(/(\d+)(min|hr)/);
            const timeframe = tfMatch ? (tfMatch[2] === 'hr' ? parseInt(tfMatch[1]) * 60 : parseInt(tfMatch[1])) : null;
            moeDynasty.updateWeights(id, shadow.correct, {
                asset,
                timeframe,
                confidence: shadow.confidence,
                actualProb: shadow.correct ? 1 : 0,
                hadEdge: shadow.confidence > 60,
            });
        } catch (e) { /* MoE update failure is non-fatal */ }

        // Regime-specific tracking
        const regime = shadow.regime || 'UNKNOWN';
        if (regime !== 'UNKNOWN') {
            if (!stats.regimes) stats.regimes = {};
            if (!stats.regimes[regime]) stats.regimes[regime] = { correct: 0, total: 0 };
            stats.regimes[regime].total++;
            if (shadow.correct) stats.regimes[regime].correct++;
        }

        // Per-signal tracking
        for (const reason of (shadow.reasons || [])) {
            const key = this._normalizeReason(reason);
            if (!stats.perSignal[key]) stats.perSignal[key] = { correct: 0, total: 0, accuracy: 0 };
            stats.perSignal[key].total++;
            if (shadow.correct) stats.perSignal[key].correct++;
            stats.perSignal[key].accuracy = parseFloat(
                (stats.perSignal[key].correct / stats.perSignal[key].total * 100).toFixed(1)
            );
        }
    }

    /**
     * Sync a child's shadow resolution to its pnl.json (trades/wins/losses counter)
     * This connects childLearning stats → child pnl.json → absorbEliteGenome
     */
    _syncChildPnl(childId, correct) {
        try {
            // Map childId to directory name (e.g., 'btc-5min' → 'BTC-5min')
            const dirName = this._childIdToDir(childId);
            const childDir = path.join(CHILDREN_DIR, dirName);
            const pnlPath = path.join(childDir, 'pnl.json');
            if (!fs.existsSync(pnlPath)) return;

            const cp = JSON.parse(fs.readFileSync(pnlPath, 'utf8'));
            cp.trades = (cp.trades || 0) + 1;
            if (correct) {
                cp.wins = (cp.wins || 0) + 1;
            } else {
                cp.losses = (cp.losses || 0) + 1;
            }
            // Write atomically via tmp + rename
            const tmp = pnlPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
            fs.renameSync(tmp, pnlPath);
        } catch (e) { /* skip — child dir may not exist yet */ }
    }

    /**
     * Map childId (e.g., 'btc-5min') to child directory name (e.g., 'BTC-5min')
     */
    _childIdToDir(childId) {
        // CHILD_SPECS use lowercase ids like 'btc-5min', dirs are uppercase like 'BTC-5min'
        const parts = childId.split('-');
        if (parts.length >= 2) {
            const asset = parts[0].toUpperCase();
            const rest = parts.slice(1).join('-');
            return `${asset}-${rest}`;
        }
        return childId;
    }

    _normalizeReason(reason) {
        if (/rsi/i.test(reason)) return 'RSI';
        if (/macd/i.test(reason)) return 'MACD';
        if (/trend/i.test(reason)) return 'TREND';
        if (/vol/i.test(reason)) return 'VOLUME';
        return 'OTHER';
    }

    _initChild(childId) {
        return {
            totalResolved: 0,
            correct: 0,
            wrong: 0,
            accuracy: 50, // Start at 50% (neutral prior)
            perSignal: {},
            regimes: {
                TRENDING: { correct: 0, total: 0 },
                VOLATILE: { correct: 0, total: 0 },
                MEAN_REVERTING: { correct: 0, total: 0 }
            },
            dna: { ...DEFAULT_DNA },
        };
    }

    _assetToSymbol(asset) {
        const map = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT' };
        return map[asset?.toLowerCase()] || asset;
    }

    // Binance 1m close at (or just before) tsMs — the honest grading price for
    // a window that closed at tsMs. Returns null on any failure (caller falls
    // back to current price rather than skipping resolution forever).
    async _priceAtTime(sym, tsMs) {
        try {
            const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&startTime=${tsMs - 120000}&endTime=${tsMs}&limit=3`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return null;
            const k = await res.json();
            if (Array.isArray(k) && k.length) return parseFloat(k[k.length - 1][4]);
        } catch { }
        return null;
    }

    _printReport() {
        const ids = Object.keys(this.learning);
        if (ids.length === 0) return;

        console.log('\n[CHILD LEARNING] 🧬 ═══ DYNASTY LEARNING REPORT ═══');
        for (const id of ids) {
            const s = this.learning[id];
            if (s.totalResolved === 0) continue;
            const gen = s.dna?.generation || 1;
            console.log(`  ${id}: G${gen} | ${s.totalResolved} resolved | ${s.correct}W/${s.wrong}L | Accuracy: ${s.accuracy}%`);
            for (const [sig, data] of Object.entries(s.perSignal)) {
                console.log(`    └─ ${sig}: ${data.correct}/${data.total} (${data.accuracy}%)`);
            }
            if (s.regimes) {
                for (const [reg, data] of Object.entries(s.regimes)) {
                    if (data.total > 0) {
                        const acc = Math.round((data.correct / data.total) * 100);
                        console.log(`    └─ [${reg}]: ${data.correct}/${data.total} (${acc}%)`);
                    }
                }
            }
        }
        const nextEvo = EVOLUTION_INTERVAL - (this.globalResolved - this.lastEvolution);
        console.log(`  Next evolution in: ${nextEvo} predictions`);
        console.log('[CHILD LEARNING] ═══════════════════════════════════\n');
    }

    // ═══ PERSISTENCE ═══

    _load() {
        try {
            if (fs.existsSync(LEARNING_PATH)) {
                const data = JSON.parse(fs.readFileSync(LEARNING_PATH, 'utf8'));
                this.learning = data.learning || {};
                this.globalResolved = data.globalResolved || 0;
                this.lastEvolution = data.lastEvolution || 0;
            }
        } catch (e) { /* start fresh */ }

        // Load unresolved shadows
        try {
            if (fs.existsSync(SHADOWS_PATH)) {
                const lines = fs.readFileSync(SHADOWS_PATH, 'utf8').trim().split('\n').filter(Boolean);
                this.shadows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                // Only keep unresolved ones in memory
                this.shadows = this.shadows.filter(s => !s.resolved);
            }
        } catch (e) { /* start fresh */ }
    }

    // ═══ PERP SHADOW RECORDING — alias for evaluate_and_trade_perp ═══
    recordShadow(shadow) {
        return this.recordPrediction(shadow.childId, shadow);
    }

    // ═══ PERP RESOLUTION — resolve a closed perp position for child evolution ═══
    resolvePerp(positionId, won) {
        const shadow = this.shadows.find(s => s.marketId === positionId && !s.resolved);
        if (!shadow) return;

        shadow.resolved = true;
        shadow.correct = won;

        const childId = shadow.childId || `PERP-${shadow.asset?.toUpperCase() || 'BTC'}-A`;
        if (!this.learning[childId]) {
            this.learning[childId] = {
                totalResolved: 0, correct: 0, wrong: 0,
                accuracy: 0, perSignal: {}, regimes: {},
                dna: { ...PERP_DNA_DEFAULTS }, track: 'quant', category: 'crypto',
            };
        }

        const cl = this.learning[childId];
        cl.totalResolved++;
        if (won) cl.correct++; else cl.wrong++;
        cl.accuracy = cl.totalResolved > 0 ? (cl.correct / cl.totalResolved * 100) : 0;

        // Track per-regime accuracy
        const regime = shadow.regime || 'UNKNOWN';
        if (!cl.regimes[regime]) cl.regimes[regime] = { correct: 0, total: 0 };
        cl.regimes[regime].total++;
        if (won) cl.regimes[regime].correct++;

        this.globalResolved++;
        console.log(`[CHILD-LEARN] Perp resolved: ${positionId} → ${won ? 'WIN' : 'LOSS'} | ${childId} acc: ${cl.accuracy.toFixed(1)}% (${cl.totalResolved} trades)`);

        // Trigger evolution if interval reached
        if (this.globalResolved - this.lastEvolution >= EVOLUTION_INTERVAL) {
            try { this._evolvePool('quant'); } catch (e) { console.error('[EVOLUTION] Perp evolve error:', e.message); }
            this.lastEvolution = this.globalResolved;
        }

        this._save();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HIERARCHICAL GRANDCHILD SIMULATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    // Architecture:
    //   Level 0: ADAN (master)
    //   Level 1: 2 parent children per coin (PERP-{COIN}-A, PERP-{COIN}-B) — persistent
    //   Level 2: N grandchildren per parent (ephemeral) — born, simulate, die, pass DNA up
    //
    // Each grandchild is a mutated variant of its parent's DNA. Grandchildren
    // "trade" against recent price history using a fast simulation. The top
    // survivors' DNA gets blended back into the parent, making parents smarter
    // over time without risking real (paper) capital.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Run a grandchild Monte Carlo simulation for a given coin.
     * Called after every real paper trade to continuously improve parent DNA.
     *
     * @param {string} coin - e.g. 'BTC'
     * @param {number} currentPrice - current mark price
     * @param {string} direction - 'LONG' or 'SHORT'
     * @param {string} regime - 'TREND' or 'MEAN_REVERT'
     */
    runGrandchildSimulation(coin, currentPrice, direction, regime) {
        if (!currentPrice || currentPrice <= 0) return;

        console.log(`\n[GRANDCHILD] 🧬 ═══ MONTE CARLO SIMULATION — ${coin} ═══`);

        for (const lineage of ['A', 'B']) {
            const parentId = `PERP-${coin}-${lineage}`;
            const parent = this.learning[parentId];
            if (!parent?.dna) continue;

            // ── Spawn N grandchildren with mutated DNA ──
            const grandchildren = [];
            for (let i = 0; i < GRANDCHILD_COUNT; i++) {
                const gcDna = this._spawnGrandchild(parent.dna);
                grandchildren.push({
                    id: `${parentId}-gc${i}`,
                    dna: gcDna,
                    fitness: 0,
                    trades: 0,
                    wins: 0,
                    pnl: 0,
                });
            }

            // ── Simulate each grandchild against recent price movements ──
            // We generate synthetic price scenarios based on current conditions
            const scenarios = this._generatePriceScenarios(currentPrice, regime, GRANDCHILD_SIM_WINDOW);

            for (const gc of grandchildren) {
                const result = this._simulateGrandchild(gc.dna, scenarios, direction, regime);
                gc.fitness = result.fitness;
                gc.trades = result.trades;
                gc.wins = result.wins;
                gc.pnl = result.pnl;
            }

            // ── Sort by fitness (Sharpe-like: return / risk) ──
            grandchildren.sort((a, b) => b.fitness - a.fitness);

            // ── Top survivors propagate DNA upward to parent ──
            const survivors = grandchildren.slice(0, GRANDCHILD_SURVIVAL_TOP);
            const deadCount = grandchildren.length - GRANDCHILD_SURVIVAL_TOP;

            if (survivors.length > 0 && survivors[0].fitness > 0) {
                // Blend top survivors' DNA into parent (weighted average by fitness)
                const totalFitness = survivors.reduce((s, gc) => s + Math.max(gc.fitness, 0.001), 0);
                const blendedDna = {};

                for (const key of Object.keys(PERP_DNA_BOUNDS)) {
                    let weightedSum = 0;
                    for (const gc of survivors) {
                        const weight = Math.max(gc.fitness, 0.001) / totalFitness;
                        weightedSum += (gc.dna[key] ?? PERP_DNA_DEFAULTS[key]) * weight;
                    }
                    // Blend: 70% parent DNA + 30% grandchild discoveries (conservative absorption)
                    const parentVal = parent.dna[key] ?? PERP_DNA_DEFAULTS[key];
                    blendedDna[key] = parentVal * 0.7 + weightedSum * 0.3;
                    // Clamp to bounds
                    const b = PERP_DNA_BOUNDS[key];
                    if (b) blendedDna[key] = Math.max(b.min, Math.min(b.max, parseFloat(blendedDna[key].toFixed(3))));
                }

                // Preserve non-numeric fields
                blendedDna.generation = (parent.dna.generation || 1);
                blendedDna.oiConfirmation = survivors[0].dna.oiConfirmation;
                blendedDna._grandchildSimulations = (parent.dna._grandchildSimulations || 0) + GRANDCHILD_COUNT;
                blendedDna._bestGrandchildFitness = survivors[0].fitness;
                blendedDna._lastSimTs = new Date().toISOString();

                // Update parent DNA with blended discoveries
                parent.dna = { ...parent.dna, ...blendedDna };

                console.log(`[GRANDCHILD] 🏆 ${parentId}: Top ${GRANDCHILD_SURVIVAL_TOP} survivors → parent DNA updated`);
                console.log(`[GRANDCHILD]   Best: fitness=${survivors[0].fitness.toFixed(3)} pnl=${survivors[0].pnl.toFixed(1)}% wins=${survivors[0].wins}/${survivors[0].trades}`);
                console.log(`[GRANDCHILD]   DNA absorbed: lev=${blendedDna.leverageBase?.toFixed(1)} sl=${blendedDna.slTightness?.toFixed(2)} tp=${blendedDna.tpMultiplier?.toFixed(2)} vpin=${blendedDna.vpinEntryMin?.toFixed(2)}`);
            } else {
                console.log(`[GRANDCHILD] ⚠️ ${parentId}: All ${GRANDCHILD_COUNT} grandchildren had negative fitness — no DNA propagated`);
            }

            console.log(`[GRANDCHILD] 💀 ${deadCount} grandchildren died. Knowledge absorbed. ${parentId} grows stronger.`);
        }

        console.log(`[GRANDCHILD] ═══════════════════════════════════════════\n`);
        this._save();
    }

    /**
     * Spawn a single grandchild by heavily mutating parent DNA.
     * Grandchildren explore more aggressively than normal evolution (3x mutation rate).
     */
    _spawnGrandchild(parentDna) {
        const gcDna = {};
        for (const key of Object.keys(PERP_DNA_BOUNDS)) {
            const parentVal = parentDna[key] ?? PERP_DNA_DEFAULTS[key];
            // 3x mutation rate — grandchildren are explorers, not optimizers
            gcDna[key] = this._mutateParam(parentVal, key, MUTATION_RATE * 3, PERP_DNA_BOUNDS);
        }
        // Boolean gene: 20% flip chance
        gcDna.oiConfirmation = Math.random() < 0.2
            ? !(parentDna.oiConfirmation ?? true)
            : (parentDna.oiConfirmation ?? true);
        return gcDna;
    }

    /**
     * Generate synthetic price scenarios for grandchild simulation.
     * Uses geometric Brownian motion calibrated to current regime.
     */
    _generatePriceScenarios(basePrice, regime, steps) {
        const scenarios = [];
        // Generate multiple paths (5 scenarios × steps each)
        const numPaths = 5;
        for (let p = 0; p < numPaths; p++) {
            const path = [basePrice];
            // Regime-calibrated volatility
            const dailyVol = regime === 'TREND' ? 0.035 : 0.02; // 3.5% or 2% per step
            const drift = regime === 'TREND'
                ? (Math.random() > 0.5 ? 0.002 : -0.002) // slight directional bias
                : 0; // mean-reverting = no drift

            for (let i = 0; i < steps; i++) {
                const prev = path[path.length - 1];
                const noise = (Math.random() * 2 - 1) * dailyVol;
                const meanRevert = regime === 'MEAN_REVERT'
                    ? (basePrice - prev) / basePrice * 0.1 // pull back toward base
                    : 0;
                const nextPrice = prev * (1 + drift + noise + meanRevert);
                path.push(Math.max(nextPrice, basePrice * 0.5)); // floor at -50%
            }
            scenarios.push(path);
        }
        return scenarios;
    }

    /**
     * Simulate a grandchild's DNA against price scenarios.
     * Returns { fitness, trades, wins, pnl }.
     * Fitness = Sharpe-like metric: mean return / std(returns) adjusted for win rate.
     */
    _simulateGrandchild(dna, scenarios, parentDirection, regime) {
        let totalPnl = 0;
        let trades = 0;
        let wins = 0;
        const returns = [];

        for (const pricePath of scenarios) {
            const entryPrice = pricePath[0];
            const slPct = dna.slTightness ?? 1.5;
            const tpPct = slPct * (dna.tpMultiplier ?? 2.5);
            const leverage = dna.leverageBase ?? 3;

            // Simulate bracket order
            for (let i = 1; i < pricePath.length; i++) {
                const px = pricePath[i];
                const movePct = ((px - entryPrice) / entryPrice) * 100;
                const leveragedMove = movePct * leverage;

                // Check direction (grandchild follows parent's direction signal)
                const isLong = parentDirection === 'LONG';
                const directedMove = isLong ? leveragedMove : -leveragedMove;

                // Check SL/TP hit
                if (directedMove <= -slPct) {
                    // Stop loss hit
                    totalPnl -= slPct;
                    returns.push(-slPct);
                    trades++;
                    break;
                } else if (directedMove >= tpPct) {
                    // Take profit hit
                    totalPnl += tpPct;
                    returns.push(tpPct);
                    trades++;
                    wins++;
                    break;
                }

                // If we reach end of path without hitting SL/TP, close at market
                if (i === pricePath.length - 1) {
                    totalPnl += directedMove;
                    returns.push(directedMove);
                    trades++;
                    if (directedMove > 0) wins++;
                }
            }
        }

        // Calculate fitness: Sharpe-like = mean(returns) / std(returns)
        if (trades === 0) return { fitness: -1, trades: 0, wins: 0, pnl: 0 };

        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance) || 0.01;
        const winRate = wins / trades;

        // Fitness combines Sharpe ratio with win rate bonus
        const sharpe = mean / std;
        const fitness = sharpe * (0.5 + winRate); // win rate scales Sharpe

        return { fitness, trades, wins, pnl: totalPnl };
    }

    _save() {
        try {
            fs.writeFileSync(LEARNING_PATH, JSON.stringify({
                learning: this.learning,
                globalResolved: this.globalResolved,
                lastEvolution: this.lastEvolution,
                savedAt: new Date().toISOString(),
            }, null, 2));
        } catch (e) { /* skip */ }

        // ═══ GENETIC FIX: Persist shadow status to prevent re-resolution storm on restart ═══
        try {
            const unresolved = this.shadows.filter(s => !s.resolved);
            const tmp = SHADOWS_PATH + '.tmp';
            fs.writeFileSync(tmp, unresolved.map(s => JSON.stringify(s)).join('\n') + (unresolved.length ? '\n' : ''));
            fs.renameSync(tmp, SHADOWS_PATH);
        } catch (e) { /* skip */ }
    }
}

export const childLearning = new ChildLearningEngine();
export { MAX_CHILDREN_PER_PARENT, DEFAULT_DNA, LLM_DNA_DEFAULTS, LLM_DNA_BOUNDS, PERP_DNA_DEFAULTS, PERP_DNA_BOUNDS };
