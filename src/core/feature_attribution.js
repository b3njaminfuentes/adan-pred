// src/core/feature_attribution.js
// Feature 4: Feature Attribution — measures which signals generate alpha
// Tracks features per trade, calculates per-signal information ratio

import fs from 'fs';
import path from 'path';

const ADAN_DIR = process.env.ADAN_DIR || process.cwd();
const JSONL_FILE = path.join(ADAN_DIR, 'data', 'feature_log.jsonl');

export class FeatureTracker {
    constructor() {
        this.knownEntries = new Set();
        try {
            if (fs.existsSync(JSONL_FILE)) {
                const lines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
                for (const line of lines) {
                    if (!line) continue;
                    try {
                        const row = JSON.parse(line);
                        if (row.type === 'entry') this.knownEntries.add(row.id);
                    } catch (e) { }
                }
            }
        } catch (e) { }
    }

    _buildState() {
        const trades = new Map();
        try {
            if (fs.existsSync(JSONL_FILE)) {
                const lines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
                for (const line of lines) {
                    if (!line) continue;
                    try {
                        const row = JSON.parse(line);
                        if (row.type === 'entry') {
                            trades.set(row.id, { ...row, resolved: false, won: null, pnl: 0 });
                        } else if (row.type === 'resolution') {
                            const t = trades.get(row.id);
                            if (t) {
                                t.resolved = true;
                                t.won = row.won;
                                t.pnl = row.pnl;
                                if (t.resolutionCount) {
                                    t.resolutionCount++;
                                    console.warn(`[WARNING] Duplicate resolution found for ID ${row.id}`);
                                } else {
                                    t.resolutionCount = 1;
                                }
                            }
                        } else if (row.type === 'void') {
                            trades.delete(row.id);
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { }
        return Array.from(trades.values());
    }

    // Record features when entering a trade
    recordEntry(tradeId, features, marketCtx = {}) {
        if (!marketCtx.condition_id || !marketCtx.side) {
            console.error('[FEATURE_ATTR] ALERTA: trade sin condition_id o side. Este trade quedará huérfano y no se podrá resolver:', marketCtx);
        }

        const row = {
            type: 'entry',
            id: tradeId,
            ts: new Date().toISOString(),
            condition_id: marketCtx.condition_id || null,
            market_id: marketCtx.market_id || null,
            slug: marketCtx.slug || null,
            side: marketCtx.side || null,
            features: { ...features }
        };
        try {
            const dir = path.dirname(JSONL_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(JSONL_FILE, JSON.stringify(row) + '\n');
            this.knownEntries.add(tradeId);
        } catch (e) {
            console.error('[FEATURE_ATTR] Entry append error:', e.message);
        }
    }

    // We no longer update trades in memory here. The resolver handles this independently.
    // If we need to record resolution locally, we append a resolution event.
    recordResolution(tradeId, won, pnl, posCtx = null) {
        if (!this.knownEntries.has(tradeId)) {
            if (posCtx && posCtx.marketId) {
                // Backfill entry
                const fallbackFeatures = this.extractFeatures(posCtx);
                const entryRow = {
                    type: 'entry',
                    id: tradeId,
                    ts: posCtx.entryTime || new Date().toISOString(),
                    condition_id: posCtx.conditionId || null,
                    market_id: posCtx.marketId || null,
                    slug: posCtx.slug || null,
                    side: posCtx.side || null,
                    features: fallbackFeatures,
                    backfilled: true
                };
                try {
                    fs.appendFileSync(JSONL_FILE, JSON.stringify(entryRow) + '\n');
                    this.knownEntries.add(tradeId);
                } catch (e) {}
            } else {
                // Can't backfill, log error and skip resolution
                const orphanLogPath = path.join(path.dirname(JSONL_FILE), 'orphan_resolutions.log');
                const errMsg = `${new Date().toISOString()} - Orphan ID: ${tradeId}\n`;
                try {
                    fs.appendFileSync(orphanLogPath, errMsg);
                } catch (e) {}
                return;
            }
        }

        const row = {
            type: 'resolution',
            id: tradeId,
            ts: new Date().toISOString(),
            won,
            pnl
        };
        try {
            fs.appendFileSync(JSONL_FILE, JSON.stringify(row) + '\n');
        } catch (e) {
            console.error('[FEATURE_ATTR] Resolution append error:', e.message);
        }
    }

    // Extract feature vector from current market state
    extractFeatures(state) {
        const fg = state.fearGreed || 0;
        const funding = state.fundingRate || 0;
        const trendStr = state.trendStrength || 0;
        const volRatio = state.volRatio || 1;
        const session = state.sessionName || 'UNKNOWN';
        const humanState = state.humanState || 'RATIONAL_MARKET';
        const utcH = new Date().getUTCHours();
        const edge = state.edge || 0;
        const confidence = state.confidence || 50;
        const asset = (state.asset || '').toUpperCase();
        const smartMoneySig = state.smartMoneySignal || 'NO_DATA';
        const spreadPct = state.spreadPct || 0;

        return {
            fearGreed: fg,
            fearBucket: fg < 25 ? 'EXTREME_FEAR' : fg < 40 ? 'FEAR' : fg < 60 ? 'NEUTRAL' : fg < 75 ? 'GREED' : 'EXTREME_GREED',
            fundingRate: funding,
            fundingBucket: funding < -0.01 ? 'NEG_STRONG' : funding < 0 ? 'NEG_WEAK' : funding < 0.01 ? 'POS_WEAK' : 'POS_STRONG',
            trendStrength: trendStr,
            volRatio,
            session,
            humanState,
            utcHour: utcH,
            hourBucket: utcH < 6 ? 'ASIA_NIGHT' : utcH < 12 ? 'EU_MORNING' : utcH < 18 ? 'US_SESSION' : 'US_EVENING',
            edge,
            confidence,
            asset,
            smartMoneySig,
            spreadPct
        };
    }

    // Calculate per-feature win rates
    getAttribution() {
        const trades = this._buildState();
        const resolved = trades.filter(t => t.resolved);
        if (resolved.length < 10) {
            return { sufficient: false, totalTrades: resolved.length, features: {} };
        }

        const totalWR = resolved.filter(t => t.won).length / resolved.length;

        // Feature buckets to analyze
        const buckets = ['fearBucket', 'fundingBucket', 'session', 'humanState', 'hourBucket', 'asset', 'smartMoneySig'];
        const attribution = {};

        for (const feature of buckets) {
            const values = {};
            for (const trade of resolved) {
                const val = trade.features?.[feature] || 'UNKNOWN';
                if (!values[val]) values[val] = { wins: 0, losses: 0, total: 0, pnl: 0 };
                values[val].total++;
                if (trade.won) values[val].wins++;
                else values[val].losses++;
                values[val].pnl += trade.pnl || 0;
            }

            // Calculate information ratio for each value
            const featureResults = {};
            for (const [val, stats] of Object.entries(values)) {
                if (stats.total < 3) continue; // Not enough data
                const wr = stats.wins / stats.total;
                const edge = wr - totalWR;
                const ir = edge; // Simplified information ratio
                featureResults[val] = {
                    wr: parseFloat((wr * 100).toFixed(1)),
                    trades: stats.total,
                    edge: parseFloat((edge * 100).toFixed(1)),
                    pnl: Math.round(stats.pnl),
                    impact: edge > 0.05 ? 'STRONG_POSITIVE' :
                        edge > 0.02 ? 'POSITIVE' :
                            edge > -0.02 ? 'NEUTRAL' :
                                edge > -0.05 ? 'NEGATIVE' : 'STRONG_NEGATIVE'
                };
            }

            attribution[feature] = featureResults;
        }

        return {
            sufficient: true,
            totalTrades: resolved.length,
            baselineWR: parseFloat((totalWR * 100).toFixed(1)),
            features: attribution
        };
    }

    // Generate terminal report
    getReport() {
        const attr = this.getAttribution();
        if (!attr.sufficient) {
            return `Feature Attribution: ${attr.totalTrades} trades (need 10+ for analysis)`;
        }

        const lines = [
            `═══ FEATURE ATTRIBUTION · ${attr.totalTrades} trades · Baseline WR: ${attr.baselineWR}% ═══`,
        ];

        for (const [feature, values] of Object.entries(attr.features)) {
            lines.push(`\n▶ ${feature.toUpperCase()}`);
            const sorted = Object.entries(values).sort((a, b) => b[1].edge - a[1].edge);
            for (const [val, stats] of sorted) {
                const color = stats.edge > 0 ? '+' : '';
                const icon = stats.impact.includes('POSITIVE') ? '✅' :
                    stats.impact.includes('NEGATIVE') ? '❌' : '○';
                lines.push(`  ${icon} ${val}: ${stats.wr}% WR (${stats.trades}t) | Edge: ${color}${stats.edge}% | P&L: $${stats.pnl}`);
            }
        }

        return lines.join('\n');
    }

    // API response format
    getAPIResponse() {
        return this.getAttribution();
    }
}

export const featureTracker = new FeatureTracker();
