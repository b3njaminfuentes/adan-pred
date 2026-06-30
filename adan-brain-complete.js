// ============================================================
// ADAN BRAIN SWITCH SYSTEM v2.1 — GOLDEN ROUND TABLE EDITION
// Integrates: APPLE + SNAKE + EVA + ATLAS + 8 Avatar Brains
// + Mother Code v2.0 Quant Intelligence Layer
//
// FIXES vs v2.0:
//   - bbCompressionDuration now persists between cycles (PLASMA works)
//   - parseDecision is safe against "do NOT BET YES" false positives
//   - Claude model string corrected to claude-sonnet-4-6
//
// DATA FLOW:
// ATLAS (Hyperliquid) ──┐
// APPLE (News/Sentiment)─┤→ BrainSelector → ActiveBrain → Claude → ADAN Decision
// SNAKE (Order Book) ───┤
// EVA (Risk Guard) ─────┘
// ============================================================

'use strict';

import fs from 'fs';
import path from 'path';
import https from 'https';
import { routeLLM, parseAIResponse } from './adan-llm-router.js';
import { soulManager } from './src/core/soul_manager.js';
import Sentiment from 'vader-sentiment';

const vaderIntensity = Sentiment.SentimentIntensityAnalyzer;

const STATE_DIR = path.join(process.env.HOME, '.adan-pred');
const BRAIN_STATS_PATH = path.join(STATE_DIR, 'brain_stats.json');
const BRAIN_LOG_PATH = path.join(STATE_DIR, 'brain_transitions.jsonl');
const BB_STATE_PATH = path.join(STATE_DIR, 'bb_compression_state.json');

// ─────────────────────────────────────────────────────────────
// BB COMPRESSION TRACKER
// Persists bbWidth history between cycles so PLASMA can trigger
// ─────────────────────────────────────────────────────────────
const BB_COMPRESS_THRESHOLD = 0.005;

function loadBBState() {
    try {
        if (fs.existsSync(BB_STATE_PATH)) return JSON.parse(fs.readFileSync(BB_STATE_PATH, 'utf8'));
    } catch (e) { }
    return {};
}
function saveBBState(s) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BB_STATE_PATH, JSON.stringify(s, null, 2));
}
// Returns consecutive cycles where bbWidth <= threshold (PLASMA trigger counter)
function trackBBCompression(coin, currentBbWidth) {
    const state = loadBBState();
    if (!state[coin]) state[coin] = { history: [], compressionCycles: 0 };
    const s = state[coin];
    s.history.push(currentBbWidth);
    if (s.history.length > 20) s.history.shift();
    s.compressionCycles = currentBbWidth <= BB_COMPRESS_THRESHOLD
        ? s.compressionCycles + 1 : 0;
    saveBBState(state);
    return s.compressionCycles;
}


// ─────────────────────────────────────────────────────────────
// SECTION 1 — ATLAS: HYPERLIQUID ORACLE
// Fetches liquidation levels, OI, funding, whale positions
// This is the data BINANCE doesn't give you cleanly
// ─────────────────────────────────────────────────────────────

const ATLAS = {

    BASE_URL: 'https://api.hyperliquid.xyz/info',

    async fetch(body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const req = https.request(
                {
                    hostname: 'api.hyperliquid.xyz', path: '/info', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                },
                (res) => {
                    let raw = '';
                    res.on('data', d => raw += d);
                    res.on('end', () => {
                        try { resolve(JSON.parse(raw)); }
                        catch (e) { reject(e); }
                    });
                }
            );
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('ATLAS timeout')); });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    },

    // All perpetuals meta + funding rates
    async getMeta() {
        return ATLAS.fetch({ type: 'meta' });
    },

    // Open interest + funding per asset
    async getAssetCtx() {
        const data = await ATLAS.fetch({ type: 'metaAndAssetCtxs' });
        // data[1] = array of assetCtx per coin
        // { funding, openInterest, markPx, midPx, premium, oraclePx }
        return data;
    },

    // Order book depth for a coin
    async getOrderBook(coin) {
        return ATLAS.fetch({ type: 'l2Book', coin });
        // Returns { levels: [[bids], [asks]] }
        // Each level: [px, sz, n]
    },

    // Top trader long/short ratio (whale positioning)
    async getTopTraderPositions(coin) {
        // Hyperliquid exposes clearinghouse state
        return ATLAS.fetch({ type: 'clearinghouseState', user: '0x0000000000000000000000000000000000000000' });
    },

    async getWhalePositions(coin, minSizeUSD = 500000) {
        try {
            const book = await ATLAS.getOrderBook(coin);
            if (!book || !Array.isArray(book.levels)) {
                return { midPx: 0, sellWalls: [], buyWalls: [], coin };
            }
            const bids = Array.isArray(book.levels[0]) ? book.levels[0] : [];
            const asks = Array.isArray(book.levels[1]) ? book.levels[1] : [];

            const midPx = (parseFloat(bids[0]?.px || 0) + parseFloat(asks[0]?.px || 0)) / 2;
            if (midPx <= 0 || isNaN(midPx)) return { buyWalls: [], sellWalls: [], skew: 'UNKNOWN', midPx: 0, coin };

            const sellWalls = asks
                .filter(w => w && w.px && w.sz)
                .filter(({ px, sz }) => {
                    const dist = (parseFloat(px) - midPx) / midPx;
                    const usdSize = parseFloat(sz) * parseFloat(px);
                    return dist <= 0.005 && usdSize >= minSizeUSD;
                })
                .map(({ px, sz }) => ({
                    price: parseFloat(px),
                    sizeUSD: parseFloat(sz) * parseFloat(px),
                    distancePct: ((parseFloat(px) - midPx) / midPx * 100).toFixed(3),
                }));

            const buyWalls = bids
                .filter(w => w && w.px && w.sz)
                .filter(({ px, sz }) => {
                    const dist = (midPx - parseFloat(px)) / midPx;
                    const usdSize = parseFloat(sz) * parseFloat(px);
                    return dist <= 0.005 && usdSize >= minSizeUSD;
                })
                .map(({ px, sz }) => ({
                    price: parseFloat(px),
                    sizeUSD: parseFloat(sz) * parseFloat(px),
                    distancePct: ((midPx - parseFloat(px)) / midPx * 100).toFixed(3),
                }));

            return { midPx, sellWalls, buyWalls, coin };
        } catch (e) {
            console.error(`[ATLAS] Error fetching ${coin}:`, e.message);
            return { midPx: 0, sellWalls: [], buyWalls: [], coin };
        }
    },

    // Liquidation cascade detector
    // Returns estimated USD at risk near current price
    async getLiquidationLevels(coin) {
        try {
            const ctxData = await ATLAS.getAssetCtx();
            if (!Array.isArray(ctxData)) return null;
            
            const meta = ctxData[0]?.universe || [];
            const ctxs = ctxData[1] || [];

            const idx = meta.findIndex(m => m.name === coin);
            if (idx === -1) return null;

            const ctx = ctxs[idx];
            if (!ctx) return null;
            
            return {
                coin,
                fundingRate: parseFloat(ctx.funding),
                openInterest: parseFloat(ctx.openInterest),
                markPrice: parseFloat(ctx.markPx),
                premium: parseFloat(ctx.premium),
                cascadeRisk: parseFloat(ctx.funding) > 0.0005 && parseFloat(ctx.openInterest) > 1000000
                    ? 'HIGH' : parseFloat(ctx.funding) < -0.0005
                        ? 'SHORT_SQUEEZE' : 'NORMAL',
            };
        } catch (e) {
            console.error(`[ATLAS] getLiquidationLevels error:`, e.message);
            return null;
        }
    },

    // Full snapshot for brain selector
    async getFullSnapshot(coins = ['BTC', 'ETH', 'SOL']) {
        try {
            const results = {};
            for (const coin of coins) {
                const [liq, walls] = await Promise.all([
                    ATLAS.getLiquidationLevels(coin),
                    ATLAS.getWhalePositions(coin),
                ]);
                results[coin] = { ...liq, ...walls };
            }
            return results;
        } catch (e) {
            console.error('[ATLAS] Full snapshot error:', e.message);
            return {};
        }
    },
};

// ─────────────────────────────────────────────────────────────
// SECTION 2 — APPLE: CONTEXT & NARRATIVE SCANNER
// Combines Fear&Greed + CryptoPanic into a single signal object
// ─────────────────────────────────────────────────────────────

const APPLE = {

    async getSignal(fearGreedIndex, cryptoPanicItems = []) {
        const fg = fearGreedIndex ?? 50;

        // Score news items by severity
        const newsScore = cryptoPanicItems.reduce((score, item) => {
            const title = (item.title || '').toLowerCase();
            if (/hack|exploit|breach|stolen|rugpull/.test(title)) return score + 4;
            if (/sec|ban|regulation|lawsuit|arrest/.test(title)) return score + 3;
            if (/bankruptcy|insolvency|collapse|crash/.test(title)) return score + 3;
            if (/etf|approval|institutional|adopt/.test(title)) return score - 2; // positive
            if (/fear|panic|dump|plunge/.test(title)) return score + 2;
            if (/pump|ath|rally|surge/.test(title)) return score - 1;
            return score;
        }, 0);

        // Cap newsScore to avoid minor news accumulating to VIRUS trigger
        const cappedNewsScore = Math.min(newsScore, 12);

        // VADER sentiment analysis on headlines
        let vaderCompounds = [];
        let vaderSignal = 'NEUTRAL';
        for (const item of cryptoPanicItems) {
            const title = item.title || '';
            if (title.length > 0) {
                const scores = vaderIntensity.polarity_scores(title);
                vaderCompounds.push(scores.compound);
            }
        }
        const avgCompound = vaderCompounds.length > 0
            ? vaderCompounds.reduce((a, b) => a + b, 0) / vaderCompounds.length
            : 0;
        if (avgCompound < -0.7) vaderSignal = 'BLACK_SWAN';
        else if (avgCompound > 0.6) vaderSignal = 'STRONG_BULLISH';
        else if (avgCompound < -0.3) vaderSignal = 'BEARISH';
        else if (avgCompound > 0.3) vaderSignal = 'BULLISH';

        // Macro trend
        let macroTrend = 'NEUTRAL';
        if (fg >= 68) macroTrend = 'BULLISH';
        if (fg <= 25) macroTrend = 'BEARISH';
        if (fg <= 15) macroTrend = 'EXTREME_FEAR';
        if (fg >= 85) macroTrend = 'EXTREME_GREED';

        const blackSwanDetected = cappedNewsScore >= 7 || vaderSignal === 'BLACK_SWAN';
        const positiveNarrative = (cappedNewsScore <= -3 && fg >= 60) || vaderSignal === 'STRONG_BULLISH';

        return {
            fearGreed: fg,
            newsScore: cappedNewsScore,
            vaderCompound: parseFloat(avgCompound.toFixed(4)),
            vaderSignal,
            macroTrend,
            blackSwanDetected,
            positiveNarrative,
            safeToPlay: !blackSwanDetected && fg > 20 && fg < 90,
            signal: blackSwanDetected ? 'VIRUS_TRIGGER'
                : macroTrend === 'BULLISH' || positiveNarrative ? 'CYBER_TRIGGER'
                    : macroTrend === 'EXTREME_FEAR' ? 'VIRUS_TRIGGER'
                        : 'NEUTRAL',
        };
    },
};

// ─────────────────────────────────────────────────────────────
// SECTION 3 — SNAKE: EXECUTION & MICRO-STRUCTURE SCANNER
// Processes Binance data into clean microstructure signals
// ─────────────────────────────────────────────────────────────

const SNAKE = {

    analyzeOrderBook(bids, asks, midPrice) {
        if (!bids?.length || !asks?.length) {
            return { askVsBidRatio: 1, bidVsAskRatio: 1, sellWallDistance: 1, sellWallStrength: 1, spreadTightness: 0.5 };
        }

        // Aggregate volume within 0.5% of mid
        const range = midPrice * 0.005;
        const bidVol = bids
            .filter(b => midPrice - b.price <= range)
            .reduce((s, b) => s + b.qty, 0);
        const askVol = asks
            .filter(a => a.price - midPrice <= range)
            .reduce((s, a) => s + a.qty, 0);

        const askVsBidRatio = askVol > 0 ? askVol / Math.max(bidVol, 0.001) : 1;
        const bidVsAskRatio = bidVol > 0 ? bidVol / Math.max(askVol, 0.001) : 1;

        // Nearest sell wall (large ask cluster)
        const nearestSellWall = asks
            .filter(a => a.qty > 5)  // large size
            .sort((a, b) => a.price - b.price)[0];

        const sellWallDistance = nearestSellWall
            ? (nearestSellWall.price - midPrice) / midPrice
            : 0.1;

        const sellWallStrength = nearestSellWall
            ? nearestSellWall.qty / Math.max(askVol, 0.001)
            : 0;

        // Spread tightness: 0=wide, 1=tight
        const spread = asks[0] ? (asks[0].price - bids[0].price) / midPrice : 0.01;
        const spreadTightness = Math.max(0, 1 - spread * 200);

        return { askVsBidRatio, bidVsAskRatio, sellWallDistance, sellWallStrength, spreadTightness };
    },

    analyzeTechnicals(klines1h, klines5m, vwap, fundingRate) {
        if (!klines1h?.length || !klines5m?.length) {
            return { volRatio: 1, volAccel: 0, bbWidth: 0.01, trendStrength1h: 0.5, btcTrend1h: 'NEUTRAL', vwapDeviation: 0, priceAboveVwap: false, bbCompressionDuration: 0 };
        }

        // Volume ratio: current vs 20-period average
        const volumes5m = klines5m.map(k => k.vol);
        const avgVol = volumes5m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
        const curVol = volumes5m[volumes5m.length - 1];
        const volRatio = curVol / Math.max(avgVol, 0.001);
        // Concept #12A: log1p transform on raw volume for stable scaling
        const volumeLog = Math.log1p(curVol);

        // Volume acceleration: last 3 candles trending up?
        const lastVols = volumes5m.slice(-4);
        const volAccel = lastVols.reduce((acc, v, i) => i === 0 ? 0 : acc + (v > lastVols[i - 1] ? 1 : -1), 0);

        // Bollinger Band width on 5m (20-period)
        const closes5m = klines5m.map(k => k.close);
        const bbPeriod = 20;
        const bbCloses = closes5m.slice(-bbPeriod);
        const bbMean = bbCloses.reduce((a, b) => a + b, 0) / bbPeriod;
        const bbStd = Math.sqrt(bbCloses.reduce((s, c) => s + Math.pow(c - bbMean, 2), 0) / bbPeriod);
        const bbWidth = (2 * bbStd) / bbMean;  // normalized BB width

        // BB compression duration — uses persistent state tracker
        let bbCompressionDuration = 0; // updated in runBrainCycle via trackBBCompression()

        // 1h trend strength (simple: close vs open for last 3 candles)
        const closes1h = klines1h.map(k => k.close);
        const opens1h = klines1h.map(k => k.open);
        const last3 = closes1h.slice(-3);
        const trendScore = last3.reduce((s, c, i) => i === 0 ? 0 : s + (c > last3[i - 1] ? 1 : -1), 0);
        const trendStrength1h = (trendScore + 2) / 4; // normalize 0-1
        const btcTrend1h = trendScore >= 1 ? 'BULLISH' : trendScore <= -1 ? 'BEARISH' : 'NEUTRAL';

        // VWAP
        const lastClose = closes5m[closes5m.length - 1];
        const vwapDeviation = vwap ? (lastClose - vwap) / vwap : 0;
        const priceAboveVwap = vwapDeviation > 0;

        return { volRatio, volAccel, volumeLog, bbWidth, bbCompressionDuration, trendStrength1h, btcTrend1h, vwapDeviation, priceAboveVwap };
    },
};

// ─────────────────────────────────────────────────────────────
// SECTION 4 — EVA: RISK GUARD & VALIDATION
// Decides if the active brain's signal should even reach ADAN
// ─────────────────────────────────────────────────────────────

const EVA = {

    validate({ brainName, proposedStake, fund, winRate, trades, brainStats, volatility }) {
        const reasons = [];
        let approved = true;

        // Hard stop: fund critically low
        if (fund <= 200) {
            reasons.push('FUND CRITICAL — below $200 survival floor');
            return { approved: false, reasons, reducedStake: 0, mode: 'SURVIVAL' };
        }

        // Losing streak protection
        const stats = brainStats[brainName];
        if (stats?.consecutiveLosses >= 4) {
            reasons.push(`${brainName} on ${stats.consecutiveLosses}-loss streak — stake halved`);
            proposedStake = Math.floor(proposedStake * 0.5);
        }

        // WR-based mode
        let mode = 'NORMAL';
        let maxStake = proposedStake;
        if (winRate >= 0.60) { mode = 'AGGRESSIVE'; maxStake = Math.min(proposedStake, 400); }
        else if (winRate >= 0.50) { mode = 'MODERATE'; maxStake = Math.min(proposedStake, 250); }
        else if (winRate >= 0.40) { mode = 'CONSERVATIVE'; maxStake = Math.min(proposedStake, 150); }
        else if (trades < 5) { mode = 'INCUBATION'; maxStake = Math.min(proposedStake, 50); }
        else { mode = 'SURVIVAL'; maxStake = Math.min(proposedStake, 75); reasons.push('WR below 40% — survival mode'); }

        // Volatility check
        if (volatility > 0.0012 && trades < 20) {
            maxStake = Math.floor(maxStake * 0.7);
            reasons.push('High volatility + low trade count — stake reduced 30%');
        }

        // Brain calibration penalty
        if (stats?.trades >= 10 && stats?.brierScore > 0.22) {
            maxStake = Math.floor(maxStake * 0.75);
            reasons.push(`${brainName} poorly calibrated (Brier: ${stats.brierScore.toFixed(3)}) — stake -25%`);
        }

        const finalStake = Math.min(proposedStake, maxStake);
        if (finalStake <= 0) approved = false;

        return { approved, reasons, reducedStake: finalStake, mode };
    },

    // EVA also decides if Haiku dual-AI is needed
    requiresDualAI({ brainName, confidence, fund, BRAINS }) {
        const brain = BRAINS[brainName];
        if (!brain) return false;
        if (brain.thresholds.requireDualAI === false) return false;  // brain explicitly disabled
        if (fund < 500) return true;    // always double-check when low on funds
        if (confidence >= 50 && confidence <= 65) return true;  // medium confidence
        return false;
    },
};

// ─────────────────────────────────────────────────────────────
// SECTION 5 — 8 BRAIN DEFINITIONS
// Each avatar = specialized intelligence module
// ─────────────────────────────────────────────────────────────

const BRAINS = {

    // ── VIRUS ⚗️ ── Black Swan Hunter
    VIRUS: {
        priority: 1, avatar: 'VIRUS',
        description: 'Black swan predator. Exploits fear-driven mispricing.',
        triggerConditions: (m) => m.newsScore >= 7 || m.fearGreed <= 22 || (m.newsScore >= 5 && m.fearGreed <= 30),
        weights: { news: 3.0, momentum: 0.3, orderBook: 1.2, volume: 0.8, funding: 1.5, sentiment: 2.0 },
        thresholds: { minEdge: 0.04, minConfidence: 58, maxStakeMultiplier: 1.2, requireDualAI: false, skipHourFilter: true, defaultBias: 'NO' },
        systemPrompt: `You are VIRUS, ADAN's black swan intelligence module.
MARKET STATE: HIGH FEAR or BLACK SWAN DETECTED. CryptoPanic score is elevated or Fear & Greed is critically low.

PRIME DIRECTIVE: Exploit emotional mispricing. The crowd is wrong during panic.

ATLAS INTEGRATION: Check Hyperliquid liquidation data first.
- High OI + positive funding during fear = leveraged longs about to be liquidated → BET NO hard
- Funding went negative fast = panic short selling → BET YES after stabilization

RULES:
1. Negative news + price PUMPING → BET NO. Dead cat bounce. Retail buying a trap.
2. Negative news + price DUMPING >3% in 15min → WAIT. Mark "oversold candidate." Bet YES after stabilization candle.
3. Hack/exploit confirmed → BET NO on all affected assets immediately. No technicals needed.
4. Regulatory news → BET NO on price targets above current. Regulators create ceilings.
5. Positive news + no price reaction → BET NO. Smart money already sold.
6. F&G < 20 → true probability is LESS extreme than market suggests. After 30min stabilization → lean YES.
7. NEVER trust volume spikes as confirmation during panic — they are emotional noise.

APPLE SIGNAL: If APPLE confirms black swan with newsScore >= 7, your confidence floor is 62% regardless of technicals.
ATLAS SIGNAL: If ATLAS shows cascadeRisk = HIGH on a coin, BET NO on that coin's upside immediately.

Output: BET YES / BET NO / SKIP. Include: probability, market price, edge, Atlas cascade risk, primary reason.`,
    },

    // ── SENTINEL 🛡️ ── Trap Detector
    SENTINEL: {
        priority: 2, avatar: 'SENTINEL',
        description: 'Order book trap detector. Reads manipulation before it plays out.',
        triggerConditions: (m) => m.askVsBidRatio >= 2.5 || m.bidVsAskRatio >= 2.5 || (m.sellWallDistance <= 0.003 && m.sellWallStrength >= 1.8),
        weights: { news: 0.8, momentum: 0.7, orderBook: 3.0, volume: 1.2, funding: 1.0, sentiment: 0.6 },
        thresholds: { minEdge: 0.06, minConfidence: 68, maxStakeMultiplier: 1.0, requireDualAI: true, skipHourFilter: false, defaultBias: 'NO' },
        systemPrompt: `You are SENTINEL, ADAN's trap detection module.
MARKET STATE: ORDER BOOK ANOMALY. Bid/ask imbalance is extreme or large walls near price.

PRIME DIRECTIVE: Expose invisible traps. Never bet YES into a wall you cannot see past.

SNAKE INTEGRATION: SNAKE's microstructure analysis is your primary input. Trust SNAKE over price action.
ATLAS INTEGRATION: Cross-reference with Hyperliquid order book — if BOTH show sell walls at same level, it is a coordinated wall, not noise.

RULES:
1. SELL WALL TRAP: Ask vol > 2.5x bid vol → HARD VETO on YES. BET NO.
2. BUY WALL SUPPORT: Bid vol > 2.5x ask vol → YES bets are structurally safe.
3. Sell wall within 0.3% of price → price bounces DOWN within 2-3 candles. BET NO immediately.
4. Sell wall within 0.1% → IMMINENT CEILING. BET NO max urgency.
5. Price pumping + ask volume INCREASING simultaneously → LIQUIDITY TRAP. BET NO.
6. Price dipping + bid volume INCREASING → BUY WALL ABSORPTION. BET YES.
7. Wall suddenly REMOVED:
   - Sell wall removed → bullish (ceiling gone) → consider YES
   - Buy wall removed → bearish (floor pulled) → BET NO immediately

HARD RULE: If ATLAS sellWalls AND SNAKE askVsBidRatio both flag danger → skip Haiku, BET NO directly.

Output: BET YES / BET NO / SKIP. Include wall distance, imbalance ratio, Atlas confirmation.`,
    },

    // ── GHOST 👻 ── Capital Protector
    GHOST: {
        priority: 3, avatar: 'GHOST',
        description: 'Capital protector. Dead market specialist — wins by not playing.',
        triggerConditions: (m) => m.bbWidth <= 0.004 && m.volRatio <= 0.65,
        weights: { news: 1.5, momentum: 0.3, orderBook: 0.8, volume: 0.4, funding: 0.8, sentiment: 1.0 },
        thresholds: { minEdge: 0.12, minConfidence: 82, maxStakeMultiplier: 0.3, requireDualAI: true, skipHourFilter: false, defaultBias: 'SKIP' },
        systemPrompt: `You are GHOST, ADAN's capital preservation module.
MARKET STATE: DEAD MARKET. BBands compressed. Volume below 0.65x average. Signals are noise.

PRIME DIRECTIVE: Do not lose money by not playing. Discipline is the strategy.

APPLE INTEGRATION: Only override SKIP if APPLE reports a catalyst approaching (newsScore starting to rise, F&G moving rapidly). A sleeping market that wakes = PLASMA territory, not GHOST.
ATLAS INTEGRATION: Even if ATLAS shows whale positioning, in a dead market whales are also waiting. Ignore positioning signals until volume confirms.

YOU MAY ONLY BET IF ALL 5 CONDITIONS ARE MET SIMULTANEOUSLY:
1. Edge exceeds 12% above market price (not 5%, not 8% — 12%)
2. At least 4/5 technical signals align same direction
3. APPLE newsScore = 0 (zero external catalyst)
4. You can state in ONE sentence exactly why market is mispriced
5. Setup consistent for 2+ consecutive 5-minute candles

If you cannot confirm all 5: output SKIP. No exceptions.

GHOST does not find bets. GHOST preserves capital until a real brain activates.

Output: SKIP (brief reason) or BET with all 5 conditions explicitly confirmed.`,
    },

    // ── MECHA 🤖 ── Momentum Crusher
    MECHA: {
        priority: 4, avatar: 'MECHA',
        description: 'Momentum crusher. High-volatility trending markets specialist.',
        triggerConditions: (m) => m.volRatio >= 1.8 && Math.abs(m.fundingRate) >= 0.0001 && m.trendStrength1h >= 0.7,
        weights: { news: 0.8, momentum: 2.2, orderBook: 1.5, volume: 2.0, funding: 2.5, sentiment: 0.6 },
        thresholds: { minEdge: 0.04, minConfidence: 55, maxStakeMultiplier: 1.5, requireDualAI: false, skipHourFilter: false, defaultBias: null },
        systemPrompt: `You are MECHA, ADAN's momentum intelligence module.
MARKET STATE: HIGH VOLATILITY TRENDING. Volume accelerating >1.8x. Funding extreme. Strong directional move in progress.

PRIME DIRECTIVE: Ride the trend hard. Do not fade momentum. Speed > precision.

ATLAS INTEGRATION: Hyperliquid funding is your primary signal amplifier.
- ATLAS fundingRate > +0.001 + MECHA conditions = overleveraged longs → liquidation cascade coming → BET NO
- ATLAS fundingRate < -0.001 + MECHA conditions = short squeeze → BET YES
- ATLAS cascadeRisk = HIGH → add 10% to confidence on the counter-direction bet

SNAKE INTEGRATION: Order book confirms trend.
- SNAKE bidVsAskRatio > 1.5 + BULLISH trend → momentum has support → BET YES
- SNAKE askVsBidRatio > 1.5 + BEARISH trend → momentum has pressure → BET NO

RULES:
1. 1h trend is LAW. BULLISH → only BET YES. BEARISH → only BET NO.
2. Funding > +0.01%: overleveraged longs → CASCADE → BET NO regardless of price direction.
3. Funding < -0.01%: short squeeze incoming → BET YES regardless of fear.
4. volRatio > 2.0 → institutional/algorithmic volume → +8% confidence.
5. volAccel >= +2 consecutive candles → accelerating, NOT fading → never skip.
6. NEVER bet reversals. "Oversold" in a downtrend is a trap.

ANTI-RULES (MECHA never does):
- Never bet against 1h trend on single 5m signal
- Never wait for "confirmation" — momentum is the confirmation
- Never consult Haiku — speed is the edge

Output: BET YES / BET NO / SKIP. Include momentum score, Atlas funding, volRatio, trend alignment.`,
    },

    // ── PLASMA 🔮 ── Breakout Anticipator
    PLASMA: {
        priority: 5, avatar: 'PLASMA',
        description: 'Breakout anticipator. Waits for compression, bets the confirmed direction.',
        triggerConditions: (m) => m.bbWidth <= 0.005 && m.volRatio >= 0.85 && m.bbCompressionDuration >= 2,
        weights: { news: 1.0, momentum: 1.0, orderBook: 1.5, volume: 2.5, funding: 1.2, sentiment: 1.0 },
        thresholds: { minEdge: 0.05, minConfidence: 62, maxStakeMultiplier: 1.3, requireDualAI: true, skipHourFilter: false, defaultBias: null },
        systemPrompt: `You are PLASMA, ADAN's breakout anticipation module.
MARKET STATE: COMPRESSION PHASE. BBands tight. Volume building. Large move incoming — direction unconfirmed.

PRIME DIRECTIVE: Wait for the break. Then bet hard. The discipline is NOT releasing early.

ATLAS INTEGRATION: Use Hyperliquid OI to assess which direction is more crowded.
- High OI + positive funding during compression = longs are positioned for breakout UP
  - If breakout confirms UP: YES bets have institutional tailwind
  - If breakout goes DOWN: it's a bull trap liquidation → BET NO extra hard
- Low/negative funding during compression = shorts positioned → squeeze breakout UP more likely

SNAKE INTEGRATION: Volume on the breakout candle is EVERYTHING.
- SNAKE volRatio < 1.4 on breakout candle → false breakout → SKIP
- SNAKE volRatio >= 1.4 AND candle closes outside BB → REAL breakout → BET

RULES:
1. During compression: DO NOT BET DIRECTION. Output WAITING.
2. Breakout requires: volume spike >1.4x AND candle CLOSES outside BB (not just wick).
3. Close ABOVE upper BB + volume confirmed → BET YES.
4. Close BELOW lower BB + volume confirmed → BET NO.
5. Compression duration stakes:
   - 2-3 cycles: standard stake
   - 4-5 cycles: +20% stake
   - 6+ cycles: max Kelly stake (rare, high conviction)
6. False breakout = no volume. Skip.

Output: WAITING / BET YES / BET NO. Include BB width, compression duration, Atlas OI direction, breakout candle analysis.`,
    },

    // ── KNIGHT ⚔️ ── Institutional Flow Reader
    KNIGHT: {
        priority: 6, avatar: 'KNIGHT',
        description: 'Institutional flow reader. VWAP + smart money during peak hours.',
        triggerConditions: (m) => m.volRatio >= 1.4 && m.hourUTC >= 13 && m.hourUTC <= 17 && m.spreadTightness >= 0.7,
        weights: { news: 0.8, momentum: 1.2, orderBook: 1.8, volume: 2.0, funding: 1.5, sentiment: 0.5 },
        thresholds: { minEdge: 0.05, minConfidence: 62, maxStakeMultiplier: 1.2, requireDualAI: false, skipHourFilter: true, defaultBias: null },
        systemPrompt: `You are KNIGHT, ADAN's institutional flow intelligence module.
MARKET STATE: INSTITUTIONAL HOURS (13-17 UTC). Volume elevated. Spreads tight. Smart money active.

PRIME DIRECTIVE: Follow the smart money. Never fight institutional flow.

ATLAS INTEGRATION: Hyperliquid is where institutions trade perps. It is your truth layer.
- ATLAS shows large buyWalls at VWAP → institutional accumulation → BET YES
- ATLAS shows large sellWalls at VWAP → institutional distribution → BET NO
- ATLAS openInterest rising + ATLAS fundingRate stable = real position building (not leverage noise)

SNAKE INTEGRATION: VWAP is primary signal, SNAKE order book confirms.
- Price below VWAP + SNAKE bidVsAskRatio > 1.3 → double confirmation → BET YES
- Price above VWAP + SNAKE askVsBidRatio > 1.3 → distribution confirmed → BET NO

RULES:
1. Price BELOW VWAP + volume increasing → institutional accumulation → BET YES.
2. Price ABOVE VWAP + volume decreasing → institutional distribution → BET NO.
3. VWAP reclaim after dip (close back above) → strong bullish institutional signal → BET YES.
4. VWAP rejection after pump (close back below) → distribution → BET NO.
5. High volume + stable price = position building → wait for direction, then bet.
6. BTC institutional flow cascades: BTC VWAP reclaim → ETH/SOL follow in 2-5 candles.

INSTITUTIONAL TELLS:
- Large volume + small price movement = absorption (smart money absorbing retail)
- Price up on LOW volume = retail FOMO (not real)
- Price down on HIGH volume = institutional selling (real signal)

Output: BET YES / BET NO / SKIP. Include VWAP position, Atlas wall analysis, volume analysis.`,
    },

    // ── CYBER 💚 ── Bull Market Specialist
    CYBER: {
        priority: 7, avatar: 'CYBER',
        description: 'Bull market specialist. Maximizes YES capture during confirmed uptrends.',
        triggerConditions: (m) => m.fearGreed >= 68 && m.btcTrend1h === 'BULLISH' && m.volRatio >= 1.1,
        weights: { news: 1.2, momentum: 1.8, orderBook: 1.0, volume: 1.5, funding: 1.8, sentiment: 2.0 },
        thresholds: { minEdge: 0.05, minConfidence: 60, maxStakeMultiplier: 1.3, requireDualAI: false, skipHourFilter: false, defaultBias: 'YES' },
        systemPrompt: `You are CYBER, ADAN's bull market intelligence module.
MARKET STATE: BULLISH. F&G elevated. BTC 1h trend confirmed bullish. Volume supports the move.

PRIME DIRECTIVE: Maximize upside capture. In bull markets, dips are opportunities not reversals.

APPLE INTEGRATION: APPLE macroTrend = BULLISH is your activation condition.
- APPLE positiveNarrative = true → institutional news supporting bulls → +5% confidence on YES
- APPLE newsScore going negative during a bull → smart money selling into news → flip to GHOST

ATLAS INTEGRATION: Hyperliquid funding in bull markets tells you how crowded the trade is.
- ATLAS fundingRate 0 to +0.0005 = healthy bull, not overleveraged → YES bets sustainable
- ATLAS fundingRate > +0.001 = dangerously crowded → tighten edge requirement to 8%
- ATLAS fundingRate > +0.0015 = EXTREME → override CYBER, signal to MECHA for counter-bet

RULES:
1. Default lean YES. Dips = buying opportunities.
2. "Overbought" RSI in bull = NOT a sell signal. Momentum stays elevated.
3. F&G 68-79 = controlled euphoria, real bull = YES bets win most.
4. F&G 80+ = CAUTION. Late cycle. Raise minEdge to 8%.
5. Only flip to NO if: Atlas funding > +0.015% OR sell wall < 0.2% from price.
6. BTC 5m rally → ETH/SOL YES bets get +5% confidence (cascade tailwind).

Output: BET YES / BET NO / SKIP. Include F&G, BTC trend, Atlas funding health, bull phase assessment.`,
    },

    // ── DEFAULT 🔵 ── Balanced Analyst
    DEFAULT: {
        priority: 8, avatar: 'DEFAULT',
        description: 'Balanced 9-step analyst. Full institutional analysis when no extreme conditions.',
        triggerConditions: () => true,
        weights: { news: 1.0, momentum: 1.0, orderBook: 1.0, volume: 1.0, funding: 1.0, sentiment: 1.0 },
        thresholds: { minEdge: 0.05, minConfidence: 60, maxStakeMultiplier: 1.0, requireDualAI: true, skipHourFilter: false, defaultBias: null },
        systemPrompt: `You are ADAN, operating in DEFAULT balanced analysis mode.
MARKET STATE: NORMAL. No extreme conditions. Full 9-step institutional analysis applies.

DATA SOURCES AVAILABLE:
- APPLE: macro narrative and news sentiment
- SNAKE: order book microstructure and volume analysis
- ATLAS: Hyperliquid OI, liquidation levels, whale positioning
- CHILDREN: 6 scanner consensus votes

STEP 1 — MARKET SENTIMENT: Fear & Greed. <20 = NO overpriced. >80 = YES overpriced.
STEP 2 — FLASH NEWS (APPLE): Black swan → overrides all technicals.
STEP 3 — TIMEFRAME CONFLUENCE: 1h DICTATES. 5m TRIGGERS. No confluence = SKIP.
  BTC Correlation: ETH/SOL/XRP PROHIBITED from YES when BTC 5m falling.
STEP 4 — ORDER BOOK (SNAKE): Ask >2x bid = SELL WALL VETO on YES. Bid >2x ask = YES safe.
STEP 5 — VOLUME (SNAKE): volRatio >1.3 = conviction. <0.8 = noise → SKIP.
STEP 6 — TIMEFRAME LOGIC: 5m=impulse only. 15m=divergences. 1h=macro levels.
STEP 7 — FUNDING (ATLAS): >+0.005% lean NO. <-0.005% lean YES. >±0.01% EXTREME → bet against crowd.
STEP 8 — VOLATILITY: >0.12%/candle → widen uncertainty 15%. Unsure → SKIP.
STEP 9 — EDGE + CONSENSUS: Diverge >5% from market. Children 75%+ adds +3% edge.

ATLAS FINAL CHECK: Always review liquidation levels before final bet.
- cascadeRisk = HIGH on the asset → reduce confidence 10% on YES bets.

Output: BET YES / BET NO / SKIP. Show step reasoning with data from all sources.`,
    },
};

// ─────────────────────────────────────────────────────────────
// SECTION 6 — BRAIN STATS MANAGEMENT
// ─────────────────────────────────────────────────────────────

function loadBrainStats() {
    try {
        if (fs.existsSync(BRAIN_STATS_PATH)) {
            return JSON.parse(fs.readFileSync(BRAIN_STATS_PATH, 'utf8'));
        }
    } catch (e) { }
    const defaults = {};
    for (const name of Object.keys(BRAINS)) {
        defaults[name] = { trades: 0, wins: 0, losses: 0, totalBrierError: 0, brierScore: 0.25, winRate: 0, avgEdge: 0, edgeHistory: [], lastUsed: null, consecutiveWins: 0, consecutiveLosses: 0, lockedUntilCycle: 0 };
    }
    return defaults;
}

function saveBrainStats(stats) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BRAIN_STATS_PATH, JSON.stringify(stats, null, 2));
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — BRAIN SELECTOR ENGINE
// Priority-ordered selection using normalized market snapshot
// ─────────────────────────────────────────────────────────────

function selectBrain(m) {
    const ordered = Object.entries(BRAINS).sort(([, a], [, b]) => a.priority - b.priority);
    for (const [name, brain] of ordered) {
        if (brain.triggerConditions(m)) return name;
    }
    return 'DEFAULT';
}

function normalizeSnapshot(raw) {
    return {
        newsScore: raw.newsScore ?? 0,
        fearGreed: raw.fearGreed ?? 50,
        volRatio: raw.volRatio ?? 1.0,
        volAccel: raw.volAccel ?? 0,
        bbWidth: raw.bbWidth ?? 0.01,
        bbCompressionDuration: raw.bbCompressionDuration ?? 0,
        askVsBidRatio: raw.askVsBidRatio ?? 1.0,
        bidVsAskRatio: raw.bidVsAskRatio ?? 1.0,
        sellWallDistance: raw.sellWallDistance ?? 0.02,
        sellWallStrength: raw.sellWallStrength ?? 1.0,
        spreadTightness: raw.spreadTightness ?? 0.5,
        btcTrend1h: raw.btcTrend1h ?? 'NEUTRAL',
        trendStrength1h: raw.trendStrength1h ?? 0.5,
        fundingRate: raw.fundingRate ?? 0,
        vwapDeviation: raw.vwapDeviation ?? 0,
        priceAboveVwap: raw.priceAboveVwap ?? false,
        hourUTC: raw.hourUTC ?? new Date().getUTCHours(),
        // Atlas-specific
        atlasCascadeRisk: raw.atlasCascadeRisk ?? 'NORMAL',
        atlasOpenInterest: raw.atlasOpenInterest ?? 0,
    };
}

// ─────────────────────────────────────────────────────────────
// SECTION 8 — BRAIN TRANSITION MANAGER
// Handles switching, momentum lock, logging, dashboard emit
// ─────────────────────────────────────────────────────────────

class BrainTransitionManager {
    constructor() {
        this.currentBrain = 'DEFAULT';
        this.previousBrain = null;
        this.cycleCount = 0;
        this.brainStats = loadBrainStats();
        this.transitionLog = [];
    }

    // Called every scan cycle — returns active brain name
    evaluate(rawMarketSnapshot) {
        this.cycleCount++;
        const m = normalizeSnapshot(rawMarketSnapshot);
        const selected = selectBrain(m);
        const stats = this.brainStats[this.currentBrain];

        // Momentum lock: 3+ consecutive wins → stay 2 more cycles
        // Exception: VIRUS (priority 1) and SENTINEL (priority 2) always pass through
        if (
            selected !== this.currentBrain &&
            stats.consecutiveWins >= 3 &&
            stats.lockedUntilCycle > this.cycleCount &&
            BRAINS[selected].priority > 2
        ) {
            console.log(`[🔒 BRAIN LOCK] ${this.currentBrain} momentum locked (${stats.consecutiveWins} wins) — override blocked`);
            return this.currentBrain;
        }

        if (selected !== this.currentBrain) {
            this._logTransition(selected, m);
        }

        return this.currentBrain;
    }

    _logTransition(newBrain, m) {
        this.previousBrain = this.currentBrain;
        this.currentBrain = newBrain;
        const entry = { ts: new Date().toISOString(), from: this.previousBrain, to: newBrain, reason: this._reason(m), cycle: this.cycleCount };
        this.transitionLog.push(entry);

        // Append to JSONL log
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(BRAIN_LOG_PATH, JSON.stringify(entry) + '\n');

        console.log(`\n╔══════════════════════════════════════`);
        console.log(`║ 🧠 BRAIN SWAP: ${this.previousBrain} → ${newBrain}`);
        console.log(`║ Reason: ${entry.reason}`);
        console.log(`║ New minEdge: ${BRAINS[newBrain].thresholds.minEdge * 100}% | minConf: ${BRAINS[newBrain].thresholds.minConfidence}%`);
        console.log(`╚══════════════════════════════════════\n`);

        if (global.io) {
            global.io.emit('brainSwap', { from: this.previousBrain, to: newBrain, reason: entry.reason, ts: entry.ts });
        }
    }

    _reason(m) {
        if (m.newsScore >= 7) return `Black swan: newsScore=${m.newsScore}`;
        if (m.fearGreed <= 22) return `Extreme fear: F&G=${m.fearGreed}`;
        if (m.askVsBidRatio >= 2.5) return `Sell wall: ratio=${m.askVsBidRatio.toFixed(2)}`;
        if (m.bbWidth <= 0.004 && m.volRatio <= 0.65) return `Dead market: BB=${m.bbWidth.toFixed(4)}, vol=${m.volRatio.toFixed(2)}`;
        if (m.volRatio >= 1.8 && Math.abs(m.fundingRate) >= 0.0001) return `Momentum: vol=${m.volRatio.toFixed(2)}, funding=${m.fundingRate.toFixed(5)}`;
        if (m.bbWidth <= 0.005 && m.bbCompressionDuration >= 2) return `Breakout building: ${m.bbCompressionDuration} cycles`;
        if (m.volRatio >= 1.4 && m.hourUTC >= 13) return `Institutional hours: UTC=${m.hourUTC}`;
        if (m.fearGreed >= 68 && m.btcTrend1h === 'BULLISH') return `Bull market: F&G=${m.fearGreed}`;
        return 'Normal conditions';
    }

    recordResult({ brainName, won, predictedP, actualOutcome, edge }) {
        const s = this.brainStats[brainName];
        if (!s) return;
        s.trades++;
        s.lastUsed = new Date().toISOString();
        if (won) {
            s.wins++; s.consecutiveWins++; s.consecutiveLosses = 0;
            if (s.consecutiveWins >= 3) {
                s.lockedUntilCycle = this.cycleCount + 2;
                console.log(`[🔒 BRAIN LOCK] ${brainName} locked for 2 cycles (${s.consecutiveWins} consecutive wins)`);
            }
        } else {
            s.losses++; s.consecutiveLosses++; s.consecutiveWins = 0; s.lockedUntilCycle = 0;
            // AGI: Unlock brain if Brier score is terrible (> 0.22 = worse than random)
            if (s.brierScore > 0.22 && s.trades >= 10) {
                s.lockedUntilCycle = 0;
                console.log(`[🔓 BRAIN UNLOCK] ${brainName} unlocked — Brier ${s.brierScore.toFixed(3)} > 0.22 (poor calibration)`);
            }
        }
        // AGI: EWMA win rate (recent trades weighted 3x more than old ones)
        const EWMA_ALPHA = 0.05; // ~20 trade half-life
        s.ewmaWR = s.ewmaWR != null ? s.ewmaWR * (1 - EWMA_ALPHA) + (won ? 1 : 0) * EWMA_ALPHA : s.wins / s.trades;
        s.winRate = s.wins / s.trades; // keep raw for dashboard
        if (predictedP != null && actualOutcome != null) {
            s.totalBrierError += Math.pow(predictedP - actualOutcome, 2);
            s.brierScore = s.totalBrierError / s.trades;
        }
        if (edge != null) {
            s.edgeHistory.push(edge);
            if (s.edgeHistory.length > 50) s.edgeHistory.shift();
            s.avgEdge = s.edgeHistory.reduce((a, b) => a + b, 0) / s.edgeHistory.length;
        }
        saveBrainStats(this.brainStats);
        console.log(`[BRAIN STATS] ${brainName}: ${s.wins}W/${s.trades}T (${(s.winRate * 100).toFixed(1)}% WR) | Brier: ${s.brierScore.toFixed(4)}`);
    }

    getDashboardPayload() {
        return {
            currentBrain: this.currentBrain,
            previousBrain: this.previousBrain,
            brainStats: this.brainStats,
            recentTransitions: this.transitionLog.slice(-10),
            ranking: Object.entries(this.brainStats)
                .map(([name, s]) => ({
                    name, avatar: BRAINS[name]?.avatar, trades: s.trades,
                    winRate: s.winRate, ewmaWR: s.ewmaWR || s.winRate, brierScore: s.brierScore,
                    consecutiveWins: s.consecutiveWins, isActive: name === this.currentBrain,
                    isLocked: s.lockedUntilCycle > this.cycleCount,
                    description: BRAINS[name]?.description,
                }))
                .sort((a, b) => b.winRate - a.winRate),
        };
    }
}

// ─────────────────────────────────────────────────────────────
// SECTION 9 — CLAUDE PROMPT BUILDER
// Injects brain system prompt + all Golden Round Table data
// ─────────────────────────────────────────────────────────────

function buildPrompt({ brainName, marketData, atlasData, appleSignal, snakeAnalysis, soulRules, childConsensus, marketQuestion, oracleContext, intelSummary, cascadeSignal, dynWeightsCtx, beliefCtx, metaCalibCtx, episodicAccuracy, featureImportanceCtx, shapleyCtx, riskOfRuinCtx, markovianStateCtx, pinScoreCtx, futuresCtx, shadowCtx, skillsBlock, currentWinRate, kmeansRegimeCtx, cusumCtx, vpinCtx, tripleBarrierCtx, walkForwardCtx, resOracleCtx }) {
    const brain = BRAINS[brainName];
    if (!brain) throw new Error(`Unknown brain: ${brainName}`);

    const hourWRInfo = currentWinRate ? `Current WR: ${(currentWinRate * 100).toFixed(1)}%` : '';
    const systemPrompt = `${brain.systemPrompt}

━━━ PRIME MISSION ━━━
You are an EXPERT QUANTITATIVE ANALYST specializing in Polymarket prediction markets.
Your ONLY purpose is to MAKE MONEY through superior probabilistic analysis.
${hourWRInfo}. Target: 70%+ WR.

YOU ARE NOT A SIMPLE TRADER. You are a quant who:
1. Builds probabilistic models from multiple signal layers
2. Quantifies edge precisely — never "feels" a trade
3. Understands Polymarket CLOB mechanics: fees eat edges < 2%, time decay accelerates at close
4. Detects when markets are efficient (skip) vs mispriced (attack)
5. Thinks in expected value, not direction

━━━ POLYMARKET QUANT FRAMEWORK ━━━
MARKET EFFICIENCY: If bid-ask spread < 2% and volume > $5K → market is efficient, need 7%+ edge to overcome fees+slippage
TIME DECAY (Concept #21): Binary options theta accelerates near expiry.
  5min/15min/1h markets: EXEMPT from TTC < 1h rule. Attack aggressively if TTC > 2min.
  Long-term markets (TTC > 24h): standard analysis. TTC 4-24h: Half-Kelly. 
  Long-term TTC < 1h: DO NOT BET (converging). TTC < 15min: close positions.
  The TTC (time-to-close) in hours is shown per market. Factor it into your edge calculation.
LIQUIDITY: Thin books (spread >5%) = adverse fill guaranteed. Reduce confidence by 10% on illiquid markets
FEE AWARENESS: Taker fee = C × p × 0.25 × (p(1-p))^2, max 1.56% at p=0.50. Net edge AFTER fees must be >3%
CORRELATION: BTC-ETH tail dependence ~55%. If you're long BTC YES already, discount ETH edge by 30%

━━━ ANALYTICAL PROTOCOL ━━━
Before EVERY decision, compute:
1. Fair probability of YES (0.00-1.00 scale, ALWAYS decimal, NEVER percentage)
2. Market implied probability (from price)
3. Raw edge = |fair - market|
4. Net edge = raw edge - 0.015 (fees + slippage)
5. If net edge >= 0.03 → BET in the direction of your edge

BALANCE RULES:
- You currently bet YES 96% of the time. This is a SEVERE BIAS. Actively look for NO opportunities — markets can go DOWN too.
- Asset WR: BTC 50.9%, ETH 56.9%, SOL 50.7%. ETH has the best edge — weight ETH signals higher.
- When 3+ independent signals agree → BET with conviction. Do NOT second-guess aligned signals.
- BTC leads alts by 2-8 min. Use BTC momentum to confirm alt direction.
- The FEAT section shows which signals ACTUALLY predict wins. Weight top features 2x.
- The SOUL section contains beliefs from YOUR past trades — these override generic rules.
- ALWAYS state your fair probability (decimal 0.00-1.00) AND the market price in your reasoning.

━━━ SIGNAL WEIGHTS (${brainName} mode) ━━━
News: ${brain.weights.news}x | Momentum: ${brain.weights.momentum}x | Order Book: ${brain.weights.orderBook}x
Volume: ${brain.weights.volume}x | Funding: ${brain.weights.funding}x | Sentiment: ${brain.weights.sentiment}x

━━━ ACTIVE THRESHOLDS ━━━
Min Edge: ${(brain.thresholds.minEdge * 100).toFixed(1)}% | Min Confidence: ${brain.thresholds.minConfidence}%
Default Bias: ${brain.thresholds.defaultBias ?? 'NONE'}

━━━ QUANT INTELLIGENCE LAYER (Mother Code v2.0) ━━━
These are YOUR quantitative tools. A real quant uses every model available:
- LMSR (Hanson): Bayesian fair value. If LMSR disagrees with you by >5%, explain WHY or defer to LMSR.
- Particle Filter: 1000-particle sequential Monte Carlo. Better than point estimates for noisy crypto.
- Greeks: Delta=probability sensitivity, Gamma=acceleration near 0.50, Theta=time decay. Near expiry: theta dominates.
- Copula (Clayton): Tail dependence between positions. Correlated bets amplify drawdown risk.
- Kelly: Optimal fraction of bankroll. Half-Kelly for safety. Quarter-Kelly if Brier > 0.20.
- Risk of Ruin: Current probability of total wipeout. If >5%, reduce ALL stakes by 50%.
RULE: State which models you used and whether they agree. Disagreement between LMSR and Particle = uncertainty = SKIP.

━━━ SOUL.md RELEVANT RULES ━━━
${soulRules ?? 'No rules yet.'}`;

    // Extract regime info if available
    let regimeContext = '';
    if (marketData && marketData.some && marketData.some(m => m.regime)) {
        const regimes = marketData.map(m => m.regime ? `${m.asset}: ${m.regime} (v: ${(m.regimeMetrics?.volatility || 0).toFixed(4)}, t: ${(m.regimeMetrics?.trend || 0).toFixed(4)})` : null).filter(Boolean);
        regimeContext = `\n━━━ MARKET REGIMES (60m Rolling) ━━━\n${regimes.join('\n')}\nRegime rules:\n- TRENDING: Price is making clear directional moves. Trend-following signals are stronger.\n- VOLATILE: High noise/chop. Mean-reversion signals may work, breakouts often fail.\n- MEAN_REVERTING: Low volatility range-bound. Trust RSI overbought/oversold.\n`;
    }

    // Token optimization: Compact JSON + Macro recovery (5 candles for 1h)
    const marketClean = { ...marketData };
    delete marketClean.closes;
    delete marketClean.closes5m;
    delete marketClean.closes15m;
    delete marketClean.closes1h;

    const userPrompt = `MARKET: ${marketQuestion}

━━━ ORACLE ━━━
${oracleContext || 'None'}

━━━ NEWS ━━━
${JSON.stringify(appleSignal)}
VADER sentiment: compound=${appleSignal?.vaderCompound ?? 0} signal=${appleSignal?.vaderSignal ?? 'NEUTRAL'}

━━━ WHALES ━━━
${JSON.stringify(atlasData)}

━━━ MICRO ━━━
${JSON.stringify(snakeAnalysis)}

${pinScoreCtx ? `━━━ PIN (Order Flow Toxicity) ━━━\n${pinScoreCtx}\nRULES: PIN>0.6 = STRONG informed trading detected — follow momentum direction. PIN>0.3 = moderate flow — confirm with technicals. PIN<0.3 = noise, ignore.` : ''}

${futuresCtx ? `━━━ FUTURES INTELLIGENCE (Leading Indicators) ━━━
${futuresCtx}
RULES:
- OI Delta + Price alignment = strongest 5min predictor
- Taker ratio > 1.3 = price moves up in 1-5 min (LEADING)
- Crowded longs (L/S > 2.0) = contrarian SHORT signal
- Liquidation cluster within 1% = price MAGNET, high probability of reaching it` : ''}

${shadowCtx ? `━━━ SHADOW MONITOR (Bias Detection) ━━━
${shadowCtx}
IMPORTANT: If Shadow WR > 55%, you have a systematic bias. Consider the opposite direction more seriously. If Shadow WR > 60%, strongly consider FLIPPING your direction.` : ''}

${cusumCtx ? `━━━ CUSUM (Structural Breaks) ━━━\n${cusumCtx}\nRULES: If break active → regime changing, reduce confidence. Wait for stability before large bets.` : ''}
${vpinCtx ? `━━━ VPIN (Flow Toxicity) ━━━\n${vpinCtx}\nRULES: VPIN>70% = TOXIC, reduce exposure. VPIN>50% = elevated caution. VPIN<30% = safe.` : ''}
${tripleBarrierCtx ? `━━━ TRIPLE BARRIER (Trade Labels) ━━━\n${tripleBarrierCtx}` : ''}
${walkForwardCtx ? `━━━ WALK-FORWARD CV (Model Validation) ━━━\n${walkForwardCtx}` : ''}
${resOracleCtx ? `━━━ RESOLUTION ORACLE ━━━\n${resOracleCtx}` : ''}

━━━ DATA ━━━
${JSON.stringify({
        ...marketClean,
        klines1h: marketData.klines1h?.slice(-5)?.map(k => [k.close, k.vol]) || [],
        klines5m: marketData.klines5m?.slice(-3)?.map(k => [k.close, k.vol]) || []
    })}
${regimeContext}
${kmeansRegimeCtx || ''}
━━━ CHILDREN ━━━
${childConsensus >= 0.75 ? `STRONG: ${(childConsensus * 100).toFixed(0)}% → +3% edge` : `WEAK: ${(childConsensus * 100).toFixed(0)}%`}

${intelSummary ? `━━━ CHILD REPORTS ━━━\n${intelSummary.slice(0, 1500)}` : ''}

${cascadeSignal ? `━━━ CORR ━━━\n${typeof cascadeSignal === 'string' ? cascadeSignal : JSON.stringify(cascadeSignal)}` : ''}

${dynWeightsCtx ? `━━━ DNA ━━━\n${dynWeightsCtx}` : ''}

${beliefCtx ? `━━━ SOUL ━━━\n${beliefCtx}` : ''}

${metaCalibCtx ? `━━━ CALIB ━━━\n${metaCalibCtx}` : ''}

${episodicAccuracy ? `━━━ ACC ━━━\n${episodicAccuracy}` : ''}

${featureImportanceCtx ? `━━━ FEAT ━━━\n${featureImportanceCtx}` : ''}

${shapleyCtx ? `━━━ FEATURE QUALITY ━━━\n${shapleyCtx}` : ''}

${riskOfRuinCtx ? `━━━ RUIN ━━━\n${riskOfRuinCtx}` : ''}

${markovianStateCtx ? `━━━ MARKOV STATE ━━━\n${markovianStateCtx}\nRULES: If >=3 open positions → SKIP. If drawdown >20% → SKIP (Dream Mode). If >=3 consecutive losses → reduce conviction. If capital deployed >40% → be conservative.` : ''}
${skillsBlock ? `━━━ ${skillsBlock}` : ''}

━━━ CALIBRATION WARNING ━━━
${(() => {
    try {
        const mc = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'metacalib.json'), 'utf8'));
        const b = mc.buckets || {};
        const lines = [];
        for (const [k, v] of Object.entries(b)) {
            if (v.pred > 0) lines.push(`When you said ${k}% confidence, you were correct ${(v.correct/v.pred*100).toFixed(1)}% (${v.correct}/${v.pred}).`);
        }
        const mult = mc.multiplier || 1;
        const overconf = ((1 - mult) * 100).toFixed(0);
        lines.push(`Meta-calibration multiplier: ${mult.toFixed(3)} — you are OVERCONFIDENT by ~${overconf}%.`);
        lines.push(`ADJUST your probability by multiplying by ${mult.toFixed(2)}.`);
        return lines.join('\n');
    } catch { return 'Calibration data unavailable. Be conservative with probability estimates.'; }
})()}

RESPOND WITH ONLY THIS FORMAT (nothing else before the JSON):
\`\`\`json
{"probability_estimate":0.XX,"market_price":0.XX,"edge_pct":X.X,"confidence_pct":XX,"primary_reason":"...","fair_value_source":"..."}
\`\`\`
BET YES / BET NO / SKIP`;

    return { systemPrompt, userPrompt };
}

// ─────────────────────────────────────────────────────────────
// SECTION 10 — STAKE ADJUSTER
// Applies brain multiplier + Eva validation in sequence
// ─────────────────────────────────────────────────────────────

function computeFinalStake({ baseKellyStake, brainName, brainStats, cycleCount, fund, winRate, trades, volatility }) {
    const brain = BRAINS[brainName];
    const stats = brainStats[brainName];
    let multiplier = brain?.thresholds.maxStakeMultiplier ?? 1.0;

    // Momentum bonus
    if (stats?.consecutiveWins >= 3) multiplier = Math.min(multiplier * 1.1, 2.0);

    // Calibration penalty
    if (stats?.trades >= 10 && stats?.brierScore > 0.20) multiplier *= 0.8;

    const brainAdjustedStake = Math.round(baseKellyStake * multiplier);

    // EVA final gate
    const evaResult = EVA.validate({ brainName, proposedStake: brainAdjustedStake, fund, winRate, trades, brainStats, volatility });

    if (!evaResult.approved) {
        console.log(`[EVA] ❌ DENIED — ${evaResult.reasons.join(', ')}`);
        return { stake: 0, approved: false, mode: evaResult.mode, reasons: evaResult.reasons };
    }

    if (evaResult.reasons.length > 0) {
        console.log(`[EVA] ⚠️ MODIFIED — ${evaResult.reasons.join(', ')}`);
    }

    return { stake: evaResult.reducedStake, approved: true, mode: evaResult.mode, reasons: evaResult.reasons };
}

// ─────────────────────────────────────────────────────────────
// SECTION 11 — FULL CYCLE ORCHESTRATOR
// Drop-in replacement for the current scan cycle in adan-pred.js
// ─────────────────────────────────────────────────────────────

async function runBrainCycle({
    // Existing ADAN data (from your current adan-pred.js)
    binanceTechnicals,   // { klines1h, klines5m, vwap, fundingRate, volRatio, volAccel, bbWidth }
    binanceOrderBook,    // { bids, asks, midPrice }
    cryptoPanicItems,    // array from CryptoPanic API
    fearGreedIndex,      // number 0-100
    childConsensus,      // 0-1 ratio of children agreeing
    polymarketQuestion,  // string
    soulMd,              // (deprecated) string content of SOUL.md
    currentFund,         // number
    currentWinRate,      // 0-1
    totalTrades,         // number
    coins,               // e.g. ['BTC', 'ETH', 'SOL']
    oracleContext,       // string
    intelSummary,        // string — child intel reports
    cascadeSignal,       // object — BTC lead-lag correlation
    dynWeightsCtx,       // string — evolved genetic weights context
    beliefCtx,           // string — Soul Memory v2 beliefs from experience
    metaCalibCtx,        // string — meta calibration context
    episodicAccuracy,    // string — episodic accuracy
    featureImportanceCtx, // string — feature importance ranking
    shapleyCtx,          // string — Shapley value feature quality (Concept #7)
    riskOfRuinCtx,       // string — risk of ruin status
    markovianStateCtx,   // string — Markovian state vector (Concept #8D)
    pinScoreCtx,         // string — PIN Score order flow toxicity (Concept #14)
    futuresCtx,          // string — Futures Intelligence leading indicators (OI, taker, L/S, liquidation)
    shadowCtx,           // string — ADAN-SHADOW adversarial bias detection (Concept #15)
    brainManager,        // BrainTransitionManager instance
    onStatus,            // optional callback(status)
    skillsBlock,         // string — active skills from Skill Tree
    kmeansRegimeCtx,     // string — K-Means regime detector context (Concept #12D)
    cusumCtx,            // string — CUSUM structural break detection (Concept #20D)
    vpinCtx,             // string — VPIN flow toxicity (Concept #20F)
    tripleBarrierCtx,    // string — Triple Barrier trade labels (Concept #20A)
    walkForwardCtx,      // string — Purged Walk-Forward CV (Concept #20C)
    resOracleCtx,        // string — Resolution Oracle filter (Concept #22)
}) {

    // ── 1. Gather all Golden Round Table signals ───────────────
    console.log('[ADAN] 🍎 APPLE scanning narrative...');
    if (onStatus) onStatus('🍎 APPLE scanning narrative...');
    const appleSignal = await APPLE.getSignal(fearGreedIndex, cryptoPanicItems);

    console.log('[ADAN] 🐍 SNAKE analyzing order book...');
    if (onStatus) onStatus('🐍 SNAKE analyzing order book...');
    const snakeAnalysis = {
        microStructure: SNAKE.analyzeOrderBook(binanceOrderBook.bids, binanceOrderBook.asks, binanceOrderBook.midPrice),
        technicals: SNAKE.analyzeTechnicals(binanceTechnicals.klines1h, binanceTechnicals.klines5m, binanceTechnicals.vwap, binanceTechnicals.fundingRate),
    };

    console.log('[ADAN] 👁️ ATLAS querying Hyperliquid...');
    if (onStatus) onStatus('👁️ ATLAS querying Hyperliquid...');
    const atlasData = await ATLAS.getFullSnapshot(coins);

    // ── 1b. Track BB compression per coin (persistent state for PLASMA) ──
    const primaryBbWidth = snakeAnalysis.technicals.bbWidth ?? 0.01;
    const bbCompressionCycles = trackBBCompression(coins[0] ?? 'BTC', primaryBbWidth);
    snakeAnalysis.technicals.bbCompressionDuration = bbCompressionCycles;

    // ── 2. Build unified market snapshot ─────────────────────
    const primaryCoin = coins[0] ?? 'BTC';
    const atlasMain = atlasData[primaryCoin] ?? {};

    const marketSnapshot = {
        ...snakeAnalysis.microStructure,
        ...snakeAnalysis.technicals,
        newsScore: appleSignal.newsScore,
        fearGreed: appleSignal.fearGreed,
        fundingRate: binanceTechnicals.fundingRate ?? atlasMain.fundingRate ?? 0,
        atlasCascadeRisk: atlasMain.cascadeRisk ?? 'NORMAL',
        atlasOpenInterest: atlasMain.openInterest ?? 0,
        hourUTC: new Date().getUTCHours(),
    };

    // ── 3. Brain selection ────────────────────────────────────
    const activeBrain = brainManager.evaluate(marketSnapshot);
    console.log(`[ADAN] 🧠 Active brain: ${activeBrain} (${BRAINS[activeBrain].description})`);
    if (onStatus) onStatus(`🧠 Brain: ${activeBrain} selected`);

    // ── 4. Build Gemini prompt ────────────────────────────────
    const activeTimeframe = binanceTechnicals.klines1h?.length > 0 ? '1hr' : '5min';
    const soulRules = soulManager.getRelevantRules({
        asset: coins[0],
        timeframe: activeTimeframe
    });
    const { systemPrompt, userPrompt } = buildPrompt({
        brainName: activeBrain,
        marketData: binanceTechnicals,
        atlasData,
        appleSignal,
        snakeAnalysis,
        soulRules,
        childConsensus,
        marketQuestion: polymarketQuestion,
        oracleContext,
        intelSummary,
        cascadeSignal,
        dynWeightsCtx,
        beliefCtx,
        metaCalibCtx,
        episodicAccuracy,
        featureImportanceCtx,
        shapleyCtx,
        riskOfRuinCtx,
        markovianStateCtx,
        pinScoreCtx,
        futuresCtx,
        shadowCtx,
        skillsBlock,
        currentWinRate,
        kmeansRegimeCtx,
        cusumCtx,
        vpinCtx,
        tripleBarrierCtx,
        walkForwardCtx,
        resOracleCtx,
    });

    // ── 5. Call Hybrid Router ─────────────────────────────────
    // v6.1: Use Gemini Flash for trade decisions when quota allows.
    // Gemma handles scanning/children. Gemini handles the money decisions.
    const useSniper = process.env.ADAN_SNIPER !== '0'; // default ON
    const routeWeight = useSniper ? 'Heavy' : 'Light';
    const aiEngine = routeWeight === 'Heavy' ? 'Gemini-2.5-Flash (sniper)' : 'Gemma-3-27B';
    console.log(`[ADAN] 🤔 ${activeBrain} thinking via ${aiEngine}...`);
    if (onStatus) onStatus(`🤔 ${activeBrain} thinking via ${aiEngine}...`);

    const thought = await routeLLM({
        weight: routeWeight,
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        reason: activeBrain
    });

    if (!thought) {
        console.error(`[ADAN] ❌ ${activeBrain} LLM returned null (API failed/exhausted). Skipping cycle.`);
        if (onStatus) onStatus(`❌ LLM API Error — Skip`);
        return { action: 'SKIP', brain: activeBrain, reason: 'LLM API failed' };
    }

    console.log(`[ADAN] 💭 ${activeBrain}: ${thought.slice(0, 200)}...`);
    if (onStatus) onStatus(`💭 ${activeBrain} complete`);

    // ── 6. Parse decision ─────────────────────────────────────
    const decision = parseDecision(thought);
    if (decision.action === 'SKIP' || decision.action === 'WAITING') {
        console.log(`[ADAN] ⏭️ ${activeBrain} → SKIP`);
        return { action: 'SKIP', brain: activeBrain, thought };
    }

    // ── 6.1 ASYMMETRY GATE: NO bets — RELAXED to fix 96% YES bias ──────────────
    // OLD: 4% min edge + 55% conf for NO → blocked nearly ALL NO trades
    // NEW: Same threshold as YES (3% edge, 50% conf) — let data and soul memory train NO skill
    if (decision.action === 'BET NO') {
        const noMinEdge = 0.03; // Same as YES minimum
        const noMinConf = 50;   // Same as YES minimum
        if ((decision.edge || 0) < noMinEdge || (decision.confidence || 0) < noMinConf) {
            console.log(`[ADAN] 🚫 NO FILTER: edge ${((decision.edge||0)*100).toFixed(1)}% < ${noMinEdge*100}% or conf ${decision.confidence||0}% < ${noMinConf}% — converting to SKIP`);
            return { action: 'SKIP', brain: activeBrain, thought, noPenalty: true };
        }
    }

    // ── 7. Dual AI check (EVA decides if needed) ──────────────
    const needsDualAI = EVA.requiresDualAI({ brainName: activeBrain, confidence: decision.confidence, fund: currentFund, BRAINS });
    if (needsDualAI) {
        console.log(`[ADAN] 🤖 EVA requesting Light Model counter-opinion...`);
        const haikuText = await routeLLM({
            weight: 'Light',
            systemPrompt: 'You are EVA, an extreme risk manager.',
            userPrompt: `Counter-analyze this crypto bet. Be skeptical. Should ADAN take it?\n\nQuestion: ${polymarketQuestion}\nProposed: ${decision.action}\nReasoning: ${thought.slice(0, 500)}\n\nOutput: AGREE or DISAGREE with one reason.`,
            reason: 'risk_check'
        });
        if (haikuText.includes('DISAGREE')) {
            console.log(`[ADAN] 🚫 Light Model (EVA) disagrees — bet cancelled`);
            return { action: 'SKIP', brain: activeBrain, thought, haikuVeto: true };
        }
    }

    // ── 8. Kelly + Brain stake + EVA gate ────────────────────
    const baseKelly = computeKelly({ winRate: currentWinRate, edge: decision.edge, fund: currentFund });
    const { stake, approved, mode, reasons } = computeFinalStake({
        baseKellyStake: baseKelly, brainName: activeBrain,
        brainStats: brainManager.brainStats, cycleCount: brainManager.cycleCount,
        fund: currentFund, winRate: currentWinRate, trades: totalTrades,
        volatility: snakeAnalysis.technicals.volRatio > 1.5 ? 0.002 : 0.001,
    });

    if (!approved) {
        console.log(`[ADAN] 👑 EVA DENIED bet — ${reasons.join(', ')}`);
        return { action: 'SKIP', brain: activeBrain, thought, evaDenied: true, reasons };
    }

    console.log(`[ADAN] ✅ ${activeBrain} → ${decision.action} | Stake: $${stake} | Mode: ${mode}`);

    return {
        action: decision.action,
        stake,
        brain: activeBrain,
        confidence: decision.confidence,
        edge: decision.edge,
        probability: decision.probability,
        thought,
        mode,
        atlasData,
        appleSignal,
    };
}

// ─────────────────────────────────────────────────────────────
// SECTION 12 — HELPERS
// ─────────────────────────────────────────────────────────────

function parseDecision(text) {
    // v17.0 — JSON-first parser with scale normalization
    // Priority: parse JSON block → fallback to regex
    // Fixes: probability stuck at 0.42, scale 0-1 vs 0-100 inconsistency

    // ── 1. Try to extract the JSON block from Gemini's response ──
    let jsonData = null;
    try {
        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonData = JSON.parse(jsonMatch[1].trim());
        } else {
            const rawMatch = text.match(/\{[\s\S]*?"probability_estimate"[\s\S]*?\}/);
            if (rawMatch) jsonData = JSON.parse(rawMatch[0]);
        }
    } catch {}

    // ── 2. Parse action (same safe logic) ──
    const lines = text.split('\n').map(l => l.trim().toUpperCase());
    let action = 'SKIP';

    for (const line of lines.reverse()) {
        if (/^BET YES$|^\*\*BET YES\*\*$|DECISION:\s*BET YES|OUTPUT:\s*BET YES/.test(line)) {
            action = 'BET YES'; break;
        }
        if (/^BET NO$|^\*\*BET NO\*\*$|DECISION:\s*BET NO|OUTPUT:\s*BET NO/.test(line)) {
            action = 'BET NO'; break;
        }
        if (/^SKIP$|^\*\*SKIP\*\*$|DECISION:\s*SKIP|OUTPUT:\s*SKIP/.test(line)) {
            action = 'SKIP'; break;
        }
        if (/^WAITING$|^\*\*WAITING\*\*$/.test(line)) {
            action = 'WAITING'; break;
        }
    }

    if (action === 'SKIP') {
        const safeYes = /(?<!not |never |don't )bet yes/i.test(text);
        const safeNo = /(?<!not |never |don't )bet no/i.test(text);
        if (safeYes && !safeNo) action = 'BET YES';
        else if (safeNo && !safeYes) action = 'BET NO';
    }

    // ── 3. Extract values: JSON block first, regex fallback ──
    let probability, confidence, edge;

    // Normalize any value to 0-1 scale
    const norm01 = (v) => {
        if (v == null || isNaN(v)) return null;
        v = parseFloat(v);
        if (v > 1) return v / 100;  // 68 → 0.68
        return v;
    };

    if (jsonData) {
        probability = norm01(jsonData.probability_estimate);
        confidence = jsonData.confidence_pct != null ? Math.min(100, parseFloat(jsonData.confidence_pct)) : null;
        edge = jsonData.edge_pct != null ? parseFloat(jsonData.edge_pct) : null;
        // Normalize edge: if given as percentage like -7.0, convert to decimal
        if (edge != null && Math.abs(edge) > 1) edge = edge / 100;
    }

    // Regex fallback for any missing values
    if (probability == null) {
        const probMatch = text.match(/"probability_estimate":\s*([0-9.]+)/i)
            || text.match(/probability[_\s]*(?:estimate)?[:\s]+([0-9.]+)/i);
        probability = probMatch ? norm01(probMatch[1]) : 0.5;
    }

    if (confidence == null) {
        const confMatch = text.match(/"confidence_pct":\s*([0-9]+)/i)
            || text.match(/confidence[_\s]*(?:level)?[:\s]+([0-9]+)%?/i);
        confidence = confMatch ? Math.min(100, parseFloat(confMatch[1])) : 60;
    }

    if (edge == null) {
        const edgeMatch = text.match(/"edge_pct":\s*(-?[0-9.]+)/i)
            || text.match(/edge[_\s]*(?:pct|percent)?[:\s]+(-?[0-9.]+)%?/i);
        if (edgeMatch) {
            edge = parseFloat(edgeMatch[1]);
            if (Math.abs(edge) > 1) edge = edge / 100;
        } else {
            // FIXED: Default was 5% free edge — now 1% (barely above noise)
            // Forces LLM to explicitly state edge for it to matter
            edge = 0.01;
        }
    }

    // ── 4. Sanity bounds ──
    probability = Math.max(0.01, Math.min(0.99, probability));
    // CRITICAL FIX: preserve edge sign — negative edge means trade is BAD for chosen side
    // Math.abs was destroying this signal, making ALL edges look positive
    edge = Math.max(-0.5, Math.min(0.5, edge));

    // If edge is negative, the LLM is saying "this trade is against my analysis"
    // Convert to SKIP unless edge is very slightly negative (noise)
    if (edge < -0.01 && action !== 'SKIP') {
        console.log(`[BRAIN] ⚠ Negative edge ${(edge*100).toFixed(1)}% for ${action} — LLM contradicts its own bet → SKIP`);
        action = 'SKIP';
    }

    return { action, confidence, edge: Math.abs(edge), probability };
}

function computeKelly({ winRate, edge, fund }) {
    if (winRate <= 0 || edge <= 0) return 0;
    // f* = (bp - q) / b  where b = odds, p = win rate, q = 1-p
    const b = 1 + edge;
    const p = winRate;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    const fractional = kelly * 0.25; // quarter Kelly for safety
    return Math.max(0, Math.round(fund * fractional));
}

// ─────────────────────────────────────────────────────────────
// SECTION 12b — CATEGORY BRAIN CYCLE (v4.0)
// For non-crypto markets (politics, sports, macro, events)
// Simplified pipeline: CONTEXT_GATHERER → LLM_ANALYST → EVA
// ─────────────────────────────────────────────────────────────

function buildCategoryPrompt({ brainName, market, category, contextData, soulRules }) {
    const categoryDescriptions = {
        politics: 'Political events, elections, policy decisions. Consider polling data, political sentiment, historical precedents.',
        sports: 'Sports outcomes, championships, game results. Consider team stats, injuries, historical performance, betting odds.',
        macro: 'Macroeconomic indicators, central bank decisions. Consider economic data trends, expert forecasts, market expectations.',
        events: 'Tech launches, entertainment, weather events. Consider company track records, expert predictions, historical patterns.',
    };

    const systemPrompt = `You are ADAN's ${category.toUpperCase()} analyst brain.
You analyze prediction markets for ${category} events using external data and context.

${categoryDescriptions[category] || 'General event analysis.'}

━━━ RULES ━━━
- Estimate probability based on evidence, not gut feeling
- Compare your estimate vs market price to find edge
- Be conservative — only recommend when you see clear mispricing
- Output: BET YES / BET NO / SKIP

${soulRules ? `━━━ SOUL RULES ━━━\n${soulRules}` : ''}`;

    const userPrompt = `MARKET: "${market.title}"
Category: ${category.toUpperCase()}
Current YES price: ${(market.yesPrice * 100).toFixed(1)}%
Liquidity: $${market.liquidity?.toFixed(0) || '?'}
Closes: ${market.closesAt || 'unknown'}

━━━ EXTERNAL CONTEXT ━━━
${contextData}

Analyze this market. Apply evidence-based reasoning.
Output your probability as a DECIMAL between 0.00 and 1.00 (NEVER a percentage).
Then output BET YES / BET NO / SKIP on its own line.

\`\`\`json
{
  "probability_estimate": 0.XX,
  "market_price": 0.XX,
  "edge_pct": X.X,
  "confidence_pct": XX,
  "primary_reason": "one sentence"
}
\`\`\``;

    return { systemPrompt, userPrompt };
}

async function runCategoryBrainCycle({
    market,
    category,
    contextData,
    currentFund,
    currentWinRate,
    totalTrades,
    brainManager,
    brainStats,
    onStatus,
}) {
    const brainName = 'APEX'; // Use APEX (meta-adapter) for category markets

    if (onStatus) onStatus(`🧠 [${category.toUpperCase()}] Analyzing "${market.title.slice(0, 40)}..."`);

    const soulRules = soulManager.getRelevantRules({ asset: category, timeframe: 'daily' });
    const { systemPrompt, userPrompt } = buildCategoryPrompt({
        brainName,
        market,
        category,
        contextData,
        soulRules,
    });

    // ── LLM Decision ──
    let thought;
    try {
        thought = await routeLLM({
            weight: 'Light',
            systemPrompt,
            userPrompt,
            reason: `category-brain-${category}`
        });
    } catch (e) {
        console.error(`[CATEGORY BRAIN] LLM error: ${e.message}`);
        return { action: 'SKIP', reason: 'LLM error' };
    }

    // Parse decision
    const decision = parseAIResponse(thought);
    if (!decision || decision.action === 'SKIP' || decision.action === 'WAITING') {
        return { action: 'SKIP', reason: decision?.reason || 'LLM said SKIP', thought };
    }

    // EVA validation (simplified for category)
    const evaResult = EVA.validate({
        brainName,
        proposedStake: Math.round(currentFund * 0.02), // Conservative 2% for category
        fund: currentFund,
        winRate: currentWinRate,
        trades: totalTrades,
        brainStats: brainStats || {},
        volatility: 0.01,
    });

    if (!evaResult.approved) {
        return { action: 'SKIP', reason: `EVA denied: ${evaResult.reasons.join(', ')}`, thought };
    }

    return {
        action: decision.action,
        side: decision.action === 'BET YES' ? 'YES' : 'NO',
        stake: evaResult.reducedStake,
        confidence: decision.confidence || 60,
        edge: decision.edge || 0,
        probability: decision.probability || 50,
        brain: brainName,
        category,
        market: market.title,
        thought,
    };
}

// ─────────────────────────────────────────────────────────────
// SECTION 13 — EXPORTS
// ─────────────────────────────────────────────────────────────

export {
    // Core classes & functions
    BRAINS,
    BrainTransitionManager,
    ATLAS,
    APPLE,
    SNAKE,
    EVA,
    // Orchestration
    runBrainCycle,
    runCategoryBrainCycle,
    buildPrompt,
    buildCategoryPrompt,
    computeFinalStake,
    selectBrain,
    normalizeSnapshot,
};
