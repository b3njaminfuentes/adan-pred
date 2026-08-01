#!/usr/bin/env node
/**
 * ADAN-PRED v2 — Autonomous Prediction Markets Agent
 * Polymarket (crypto markets 5-15min) + Binance (price data) + Claude Sonnet 4.6
 * by Lord × 2026
 *
 * Data:   Polymarket  gamma-api.polymarket.com   (free, no auth)
 *         Binance     api.binance.com/api/v3      (free, no auth)
 * Brain:  Claude Sonnet 4.6  — technical analysis + probability estimation
 *
 * Flow:  Binance candles → trend/momentum → Polymarket markets → Claude edge calc → BET/SKIP
 */

// import Anthropic from '@anthropic-ai/sdk'; // No longer used
import fs from 'fs';
import path from 'path';

const LOCK_FILE = 'data/adan.lock';
if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
    let stillAlive = false;
    if (Number.isFinite(oldPid)) {
        try {
            // Signal 0 sends nothing — it just probes whether the PID exists
            // and is ours to signal. Throws ESRCH if the process is gone.
            process.kill(oldPid, 0);
            stillAlive = true;
        } catch { stillAlive = false; }
    }
    if (stillAlive) {
        console.error(`[CRITICAL] Ya hay un proceso corriendo (PID ${oldPid}). Matalo antes de levantar uno nuevo.`);
        process.exit(1);
    }
    // Stale lock from a process that died without cleaning up (kill -9, OOM,
    // crash) — the old code trusted the file's mere existence forever, which
    // is what left this bot unable to restart since the process died.
    console.error(`[LOCK] PID ${oldPid} in ${LOCK_FILE} is not running — clearing stale lock.`);
}
fs.writeFileSync(LOCK_FILE, process.pid.toString());
process.on('exit', () => {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const configPath = './config.json';
import http from 'http';
import { quota } from './src/core/quota_manager.js';
import { soulManager } from './src/core/soul_manager.js';
import { parseAIResponse, routeLLM } from './adan-llm-router.js';
import { BrainTransitionManager, runBrainCycle, ATLAS, APPLE, SNAKE, EVA } from './adan-brain-complete.js';

const brainManager = new BrainTransitionManager();

// Margen de fees+slippage restado al edge bruto antes de decidir un trade.
// Antes hardcodeado en 5 lugares (-0.017) sin conexión a ninguna env var.
const FEES_SLIPPAGE = Number(process.env.BRIER_MIN_EDGE ?? 0.017);

// ── Anti-crash: ignore broken pipes + catch unhandled errors ─────────────────
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });
process.on('uncaughtException', e => {
  try { fs.appendFileSync('/tmp/adan-crash.log', new Date().toISOString() + ' ' + e.stack + '\n'); } catch { }
});
process.on('unhandledRejection', e => {
  try { fs.appendFileSync('/tmp/adan-crash.log', new Date().toISOString() + ' REJECTION: ' + e + '\n'); } catch { }
});


import {
  HOME, DIR, CONFIG_PATH, PNL_PATH, POSITIONS_PATH, SOUL_PATH, THOUGHTS_PATH,
  STRATEGY_PATH, CALIB_PATH, INTEL_DIR, HYPOTHESIS_PATH, DYN_WEIGHTS_PATH,
  POLYMARKET_API, BINANCE_API, SCAN_INTERVAL_MS, MAX_POSITIONS, MIN_EDGE,
  PAPER_BET_SIZE, SYMBOLS, DEFAULT_STRATEGY, TREE_RULES,
  G, Y, R, B, C, M, W, D, X, BOLD,
  loadEnv, cls, ensureDir, loadConfig, saveConfig, loadStrategy,
  loadDynWeights, saveStrategy, loadPnL, savePnL, loadPositions, savePositions,
  loadCalibration, saveCalibration, updateCalibration, loadSoul, appendToSoul,
  expForLevel, levelFromExp, expProgress, levelTitle, getSkills, calcWinExp,
  awardExp
} from './src/core/config.js';

import {
  fetchBinancePrice, fetchBinanceKlines, calcTrend, calcVolatility, calcRSI,
  calcMACD, calcBollingerBands, calcVWAP, calcVolAccel, calcVolumeProfile,
  calcIntelScore, signalLabel
} from './src/api/binance.js';

import {
  polyFetch, fetchTokenBook, fetchPolymarkets, applyParticleFilter, normalizePolymarket,
  expit, logit, classifyMarket, checkMarketResolution
} from './src/api/polymarket.js';

import { externalData } from './src/api/external_data.js';
import { polymarketWS } from './src/api/polymarket_ws.js';
import { reportPaperBet, reportTelemetry, refreshMyBrierScore, getMyBrierScore, brierEdgePenalty, triggerHeartbeat } from './src/api/brier-reporter.js';
import { ledger as tradeLedger, wilsonLower, nightlyReport, applyDirectedMutations } from './src/core/learning_loop.js';
import { priceWindow } from './src/core/window_pricer.js';

import {
  TOP, BOT, row, sep, trow, sparkline, renderTreePanel, startDashboard, render,
  _startThinkSpin, _stopThinkSpin, _dashboardState
} from './src/ui/dashboard.js';

import {
  nameChild, spawnChild, absorbEliteGenome, pruneDeadChildren,
  runTournamentOfDeath, evaluateParentPerformance, checkUsurperPath,
  promoteEliteGrandchild
} from './src/core/genetics.js';

// ── Mother Code v2.0 + Quant Intelligence Layer ─────────────────────────────
import { marketSessions } from './src/core/market_sessions.js';
import { humanEventLayer } from './src/core/human_event_layer.js';
import { polymerase } from './src/core/polymerase.js';
import { metabolism } from './src/core/metabolism.js';
import { apoptosis } from './src/core/apoptosis.js';
import { lmsrEngine } from './src/core/lmsr_engine.js';
import { particleFilter } from './src/core/particle_filter.js';
import { calculateGreeks } from './src/core/greeks_adapter.js';
import IVSolverEngine from './src/core/iv_solver.js';

const ivSolver = new IVSolverEngine();
import { copulaRisk } from './src/core/copula_risk.js';
import { smartMoney } from './src/core/smart_money.js';
import { orderBook } from './src/core/order_book.js';
import { pinTracker } from './src/core/pin_score.js';
import { futuresIntel } from './src/api/binance_futures.js';
import { featureTracker } from './src/core/feature_attribution.js';
import { oracle } from './src/core/oracle_front_run.js';
import { childLearning, PERP_DNA_DEFAULTS } from './src/core/child_learning.js';
import { regimeDetector } from './src/core/regime_classifier.js';
import { kmeansRegime } from './src/core/regime_detector.js';
import { featureImportance } from './src/core/feature_importance.js';
import { shapleyAnalyzer } from './src/ml/shapley_values.js';
import { riskOfRuin } from './src/core/risk_of_ruin.js';
// ── Hyperliquid Perpetual Futures Layer REMOVED — Polymarket-only mode ──
import { wilmott } from './src/core/wilmott_quant.js';
import { soulMemory } from './src/core/soul_memory_v2.js';
import { selfOptimizer } from './src/core/self_optimizer.js';
import { journal } from './src/core/consciousness_journal.js';
import { moeDynasty } from './src/core/moe_dynasty.js';
import { adanVoice } from './src/core/adan_voice.js';
// ── Ultra Consciousness Layer v2.0 ──────────────────────────────────────────
import { selfReader } from './src/core/self_reader.js';
import { innerMonologue } from './src/core/inner_monologue.js';
import { experimentEngine } from './src/core/experiment_engine.js';
import { requestTracker } from './src/core/request_tracker.js';
// ── Scenario Forecaster (Third Eye) ─────────────────────────────────────────
import { scenarioForecaster } from './src/ml/scenario_forecaster.js';
// ── ML Intelligence Layer ───────────────────────────────────────────────────
import { statModel, LogisticRegression } from './src/ml/logistic_regression.js';
import { walkForward } from './src/ml/walk_forward.js';
import { kellySizer } from './src/ml/kelly_sizer.js';
import { ensemble } from './src/ml/ensemble.js';
import { calibrator } from './src/ml/calibrator.js';
import { marketFilter } from './src/ml/market_filter.js';
import { ucbExplorer } from './src/ml/ucb_explorer.js';
import { evolutionStrategies } from './src/ml/evolution_strategies.js';
import { onlineLearner } from './src/ml/online_learner.js';
import { metaLabeler } from './src/ml/meta_labeler.js';
import { adanShadow } from './src/core/adan_shadow.js';
// ── López de Prado Suite (Concepts #20A, #20C, #20D, #20F, #22) ────────────
import { cusumFilter } from './src/ml/cusum_filter.js';
import { vpinTracker } from './src/ml/vpin.js';
import { tripleBarrier } from './src/ml/triple_barrier.js';
import { purgedWF } from './src/ml/purged_walkforward.js';
import { resolutionOracle } from './src/ml/resolution_oracle.js';
import { multiplierAudit } from './src/ml/multiplier_audit.js';
import { getTradePath } from './src/ml/price_path.js';
import { pathStats } from './src/ml/path_stats.js';

// ── Orphan Check ────────────────────────────────────────────────────────────
try {
    const jsonlPath = path.join(DIR, 'data', 'feature_log.jsonl');
    if (fs.existsSync(jsonlPath)) {
        const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
        const entries = new Set();
        const orphans = new Set();
        for (const line of lines) {
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                if (row.type === 'entry') entries.add(row.id);
                else if (row.type === 'resolution' && !entries.has(row.id)) orphans.add(row.id);
            } catch (e) {}
        }
        if (orphans.size > 0) {
            const orphanArr = Array.from(orphans);
            console.warn(`\n[CRITICAL WARNING] Se encontraron ${orphanArr.length} resoluciones huérfanas en feature_log.jsonl.`);
            console.warn(`Primeros IDs: ${orphanArr.slice(0, 3).join(', ')}\n`);
        }
    }
} catch (e) {}

let consecutiveLosses = 0;
let lastWinTime = null; // Markovian: timestamp of last winning trade
let lastHumanState = 'RATIONAL_MARKET';

// ── Concept #12C: Bin Count Score for Hour Filter ─────────────────────────────
// Replaces boolean hour_filter with continuous log-odds score.
// Uses Laplace smoothing: p_win = (wins + 1) / (total + 2)
// Returns log(p / (1-p)) — positive = winning hour, negative = losing hour.
function binCountScore(hourStats, hour) {
  const h = hourStats?.[hour.toString()];
  const wins = h?.wins || 0;
  const losses = h?.losses || 0;
  const total = wins + losses;
  const pWin = (wins + 1) / (total + 2); // Laplace smoothing
  const score = Math.log(pWin / (1 - pWin));
  return { score, pWin, total, wins, losses };
}

// Applies bin count score to Kelly fraction
// score > 0.3 → Kelly * 1.1 (good hour bonus)
// score < -0.3 → Kelly * 0.7 (bad hour penalty)
// Between → Kelly * 1.0
function hourKellyMultiplier(hourScore) {
  if (hourScore > 0.3) return 1.1;
  if (hourScore < -0.3) return 0.7;
  return 1.0;
}

// ── Markovian State Tracker (Concept #8D) ─────────────────────────────────────
// Computes a full risk state snapshot for gating and prompt injection.
function computeMarkovianState() {
  const pnl = loadPnL();
  const pos = loadPositions();
  const fund = pnl.fund ?? 10000;

  // 1. positions_open: count of currently open bets
  const positions_open = pos.open.length;

  // 2. capital_deployed_pct: total staked in open positions / fund
  const totalStaked = pos.open.reduce((sum, p) => sum + (p.stake || 0), 0);
  const capital_deployed_pct = fund > 0 ? parseFloat((totalStaked / fund).toFixed(4)) : 0;

  // 3. consecutive_losses: current loss streak (uses module-level var)
  const consecutive_losses = consecutiveLosses;

  // 4. hours_since_last_win: hours since last winning trade
  let hours_since_last_win = 0;
  if (lastWinTime) {
    hours_since_last_win = parseFloat(((Date.now() - lastWinTime) / 3600000).toFixed(2));
  } else {
    // Bootstrap from persisted pnl.lastWinTime (survives restarts)
    if (pnl.lastWinTime) {
      lastWinTime = new Date(pnl.lastWinTime).getTime();
      hours_since_last_win = parseFloat(((Date.now() - lastWinTime) / 3600000).toFixed(2));
    } else {
      // Fallback: scan closed positions for last win
      const closedWins = (pos.closed || []).filter(p => p.won === true);
      if (closedWins.length > 0) {
        const lastWin = closedWins[closedWins.length - 1];
        const resolvedAt = lastWin.resolvedAt ? new Date(lastWin.resolvedAt).getTime() : 0;
        if (resolvedAt > 0) {
          hours_since_last_win = parseFloat(((Date.now() - resolvedAt) / 3600000).toFixed(2));
          lastWinTime = resolvedAt; // cache it
        }
      }
    }
  }

  // 5. current_drawdown_pct: (peak_fund - current_fund) / peak_fund
  const peakFund = pnl.peakFund || fund;
  const current_drawdown_pct = peakFund > 0
    ? parseFloat(((peakFund - fund) / peakFund).toFixed(4))
    : 0;

  // 6. free_capital: fund minus deployed capital
  const free_capital = parseFloat(Math.max(0, fund - totalStaked).toFixed(2));

  return {
    positions_open,
    capital_deployed_pct,
    consecutive_losses,
    hours_since_last_win,
    current_drawdown_pct,
    free_capital,
    fund,
    peak_fund: peakFund,
    total_staked: parseFloat(totalStaked.toFixed(2)),
  };
}

// ── Helper: Get Polymarket WebSocket context for brain prompt ──
function _getPolyWsContext(candidates) {
  if (!candidates || candidates.length === 0) return '';
  const contexts = [];
  for (const m of candidates) {
    if (m.clobTokenIds && m.clobTokenIds.length > 0) {
      const ctx = polymarketWS.getPromptContext(m.clobTokenIds[0]);
      if (ctx) contexts.push(ctx);
    }
  }
  return contexts.length > 0 ? '\n' + contexts.join('\n') : '';
}

// ── Helper: Get statistical model context for brain prompt ──
function _getStatModelContext(candidates) {
  if (!statModel.trained || !candidates || candidates.length === 0) return '';
  const contexts = [];
  for (const m of candidates.slice(0, 3)) {
    if (!m.priceData) continue;
    const vec = buildFeatureVector(m.priceData, {
      priceDist: m.roughEdge || 0,
      yesPrice: m.yesPrice || 0.5,
      fearGreed: 50,
      effRatio: m.priceData.efficiencyRatio ?? 0.5,
    });
    const tradeData = {
      entryVec: vec,
      side: 'YES', edge: m.roughEdge || 0, confidence: 50,
      entryTime: new Date().toISOString(),
    };
    const ctx = statModel.getPromptContext(tradeData);
    if (ctx) contexts.push(ctx);
  }
  return contexts.length > 0 ? '\n' + contexts[0] : '';
}
let lastSessionAdj = null;
let lastSmartMoneyData = null;

// v4.1: Anti YES-bias alternator + streak breaker
let _lastTrainingSide = 'NO';     // Fix 1: alternator starts at NO so first forced = YES
let _recentDirections = [];        // Fix 3: anti-streak guard

// ── External Intelligence APIs ───────────────────────────────────────────────
async function fetchFearGreed() {
  // Alternative.me Fear & Greed Index — free, no auth
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=2');
    const d = await r.json();
    const cur = d?.data?.[0];
    const prev = d?.data?.[1];
    if (!cur) return null;
    return {
      value: parseInt(cur.value),
      label: cur.value_classification,
      prevValue: prev ? parseInt(prev.value) : null,
      direction: prev ? (parseInt(cur.value) - parseInt(prev.value)) : 0
    };
  } catch { return null; }
}

// ── Crypto News Feed — detect Black Swans before looking at candles ───────────
async function fetchCryptoNews() {
  // CryptoCompare — free, no auth, reliable
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,SOL&sortOrder=popular', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const posts = (d?.Data || []).slice(0, 5);
    if (!posts.length) return null;
    const bearWords = /crash|hack|ban|fraud|scam|dump|plunge|collapse|bankrupt|sec sue|arrest|exploit/i;
    const bullWords = /surge|rally|etf approv|record|breakout|adoption|bullish|soar|pump|ath|approve/i;
    return posts.map(p => ({
      title: p.title,
      source: p.source || '?',
      sentiment: bearWords.test(p.title) ? 'BEARISH' : bullWords.test(p.title) ? 'BULLISH' : 'NEUTRAL',
      ts: new Date((p.published_on || 0) * 1000).toISOString(),
      currencies: (p.categories || '').split('|').filter(c => /BTC|ETH|SOL/i.test(c)).join(',') || 'CRYPTO'
    }));
  } catch { return null; }
}

async function fetchFundingRates() {
  // Binance futures funding rates — tells if market is over-leveraged
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const result = {};
  await Promise.all(syms.map(async sym => {
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=3`);
      const d = await r.json();
      if (!Array.isArray(d) || !d.length) return;
      const latest = parseFloat(d[d.length - 1].fundingRate) * 100; // as percentage
      result[sym] = {
        rate: latest,
        label: latest > 0.05 ? 'LONGS PAYING (overbought)' : latest < -0.05 ? 'SHORTS PAYING (oversold)' : 'NEUTRAL',
        signal: latest > 0.1 ? 'bearish' : latest < -0.05 ? 'bullish' : 'neutral'
      };
    } catch { }
  }));
  return result;
}

async function fetchOrderBookWalls(symbol) {
  // Micro-structure analysis: detect walls within 0.5% of price
  try {
    const r = await fetch(`${BINANCE_API}/depth?symbol=${symbol}&limit=20`);
    const d = await r.json();
    if (!d?.bids || !d?.asks) return null;
    const bids = d.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
    const asks = d.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
    const midPrice = (bids[0].price + asks[0].price) / 2;
    const range05 = midPrice * 0.005; // 0.5% range

    // Filter to walls within 0.5% of price
    const nearBids = bids.filter(b => midPrice - b.price <= range05);
    const nearAsks = asks.filter(a => a.price - midPrice <= range05);
    const bidVol = nearBids.reduce((s, b) => s + b.qty * b.price, 0);
    const askVol = nearAsks.reduce((s, a) => s + a.qty * a.price, 0);
    const totalVol = bidVol + askVol;

    // Biggest walls
    const topBid = bids.reduce((a, b) => b.qty > a.qty ? b : a, bids[0]);
    const topAsk = asks.reduce((a, b) => b.qty > a.qty ? b : a, asks[0]);

    // Sell wall trap detection: sell wall within 0.5% that is 2x+ the bid volume
    const sellWallTrap = askVol > bidVol * 2 && nearAsks.length > 0;
    const buyWallTrap = bidVol > askVol * 2 && nearBids.length > 0;
    // Distance of biggest wall from price
    const askWallDist = topAsk.price > 0 ? ((topAsk.price - midPrice) / midPrice * 100).toFixed(2) : '?';
    const bidWallDist = topBid.price > 0 ? ((midPrice - topBid.price) / midPrice * 100).toFixed(2) : '?';

    // === Concept #8A: L2 Order Book Tensor ===
    // (a) wall_score: max cluster density on ask-side (0-1)
    const clusterWidth = midPrice * 0.001; // 0.1% width
    const askClusters = {};
    for (const a of asks) {
      const bucket = Math.floor(a.price / clusterWidth);
      askClusters[bucket] = (askClusters[bucket] || 0) + a.qty * a.price;
    }
    const clusterVals = Object.values(askClusters);
    const maxCluster = clusterVals.length > 0 ? Math.max(...clusterVals) : 0;
    const avgCluster = clusterVals.length > 0 ? clusterVals.reduce((s, v) => s + v, 0) / clusterVals.length : 1;
    const wall_score = Math.min(1, maxCluster / (avgCluster * 5 || 1)); // normalize: 5x avg = 1.0

    // (b) imbalance_ratio: ask_vol / bid_vol (>1 = selling pressure, <1 = buying pressure)
    const totalBidVol = bids.reduce((s, b) => s + b.qty * b.price, 0);
    const totalAskVol = asks.reduce((s, a) => s + a.qty * a.price, 0);
    const imbalance_ratio = totalBidVol > 0 ? parseFloat((totalAskVol / totalBidVol).toFixed(4)) : 1;

    // (c) depth_score: liquidity within 0.5% of mid price (0-1)
    const depthVol = nearBids.reduce((s, b) => s + b.qty * b.price, 0) + nearAsks.reduce((s, a) => s + a.qty * a.price, 0);
    const typicalDepth = (totalBidVol + totalAskVol) * 0.3; // expect ~30% of total within 0.5%
    const depth_score = Math.min(1, depthVol / (typicalDepth || 1));
    // === End Concept #8A ===

    return {
      support: topBid.price,
      resistance: topAsk.price,
      bidWall: topBid.qty,
      askWall: topAsk.qty,
      buyPressure: totalVol > 0 ? Math.round(bidVol / totalVol * 100) : 50,
      spread: ((asks[0].price - bids[0].price) / bids[0].price * 100).toFixed(4),
      // New: micro-structure trap detection
      sellWallTrap,   // true = massive sell wall 2x bids within 0.5% → price bounces DOWN
      buyWallTrap,    // true = massive buy wall 2x asks within 0.5% → price bounces UP
      bidVolUSD: Math.round(bidVol),
      askVolUSD: Math.round(askVol),
      // Concept #12A: log1p transform on raw order book volumes
      bidVolLog: Math.log1p(bidVol),
      askVolLog: Math.log1p(askVol),
      ratio: totalVol > 0 ? parseFloat((bidVol / askVol).toFixed(2)) : 1,
      askWallDist,  // % distance of biggest sell wall from price
      bidWallDist,   // % distance of biggest buy wall from price
      // Concept #8A: L2 tensor scores
      wall_score,         // 0-1: max ask cluster density
      imbalance_ratio,    // >1 selling pressure, <1 buying pressure
      depth_score,        // 0-1: liquidity concentration near mid
      _rawBids: bids,
      _rawAsks: asks
    };
  } catch { return null; }
}

async function fetchAllPrices() {
  // Fetch all in parallel for speed
  const [fearGreed, fundingRates, cryptoNews] = await Promise.all([
    fetchFearGreed(),
    fetchFundingRates(),
    fetchCryptoNews()
  ]);

  const result = { _meta: { fearGreed, fundingRates, cryptoNews } };

  await Promise.all(SYMBOLS.map(async sym => {
    const [klines1m, klines5m, klines15m, klines1h, orderBook, futuresData] = await Promise.all([
      fetchBinanceKlines(sym, '1m', 30),
      fetchBinanceKlines(sym, '5m', 30),
      fetchBinanceKlines(sym, '15m', 20),
      fetchBinanceKlines(sym, '1h', 20),   // ← macro trend (20 hourly candles for RSI1h)
      fetchOrderBookWalls(sym),
      futuresIntel.fetchAll(sym)
    ]);
    if (!klines1m.length) return;
    const closes1m = klines1m.map(k => k.close);
    const closes5m = klines5m.map(k => k.close);
    const closes15m = klines15m.map(k => k.close);
    const closes1h = klines1h.map(k => k.close);
    const price = closes1m[closes1m.length - 1];
    const open24 = closes5m.length > 0 ? closes5m[0] : price;
    const macd = calcMACD(closes5m);
    const bb = calcBollingerBands(closes5m);
    const vol = calcVolumeProfile(klines1m);
    const vwap5m = calcVWAP(klines5m);
    const volAccel = calcVolAccel(klines5m);
    const funding = fundingRates[sym] || null;
    // Order book imbalance: numeric -1 to +1 scale for Level 2 signals
    const obImbalance = orderBook ? ((orderBook.buyPressure || 50) - 50) / 50 : 0;

    // Concept #14: PIN Score — Order Flow Toxicity
    const pinScore = orderBook ? pinTracker.calculateFromOrderBook(sym, orderBook._rawBids, orderBook._rawAsks) : { pin_score: 0, signal: 'NONE' };

    // ── Futures Intelligence: enrich with price-dependent signals ──
    const priceDelta5m = closes5m.length >= 2 ? ((closes5m[closes5m.length - 1] - closes5m[closes5m.length - 2]) / closes5m[closes5m.length - 2]) * 100 : 0;
    if (futuresData) {
      futuresIntel.enrichWithPrice(futuresData, price, priceDelta5m, funding?.rate || 0);
    }

    // ── Concept #20D: CUSUM structural break detection ──
    try { cusumFilter.update(price); } catch (e) { console.error('[CUSUM] Update error:', e.message); }
    // ── Concept #20F: VPIN volume toxicity ──
    try {
      const lastVol = klines1m[klines1m.length - 1]?.vol || 0;
      vpinTracker.update(price, lastVol);
    } catch (e) { console.error('[VPIN] Update error:', e.message); }

    // ── Update Regime Classifier + Wilmott EWMA (Ch 42/49) ──
    const assetName = sym.replace('USDT', '').toLowerCase();
    regimeDetector.updatePrice(assetName, price);
    wilmott.updatePrice(assetName, price);
    const regimeInfo = regimeDetector.detectRegime(assetName);

    // ── Concept #12D: K-Means Regime Detector ──
    const kmeansResult = kmeansRegime.detect({
      bb_width: bb?.width || 0.01,
      vol_ratio: vol?.ratio || 1,
      rsi_14: calcRSI(closes5m),
      funding_rate: funding?.rate || 0,
      vwap_deviation: vwap5m?.pct || 0
    });

    const d = {
      price,
      chg: ((price - open24) / open24) * 100,
      closes: closes1m,
      closes5m,
      closes15m,
      closes1h,
      trend1m: calcTrend(closes1m),
      trend5m: calcTrend(closes5m),
      trend15m: calcTrend(closes15m),
      trend1h: closes1h.length >= 2 ? calcTrend(closes1h) : 0,
      volatility: calcVolatility(closes1m),
      rsi: calcRSI(closes1m),
      rsi5m: calcRSI(closes5m),
      rsi1h: closes1h.length >= 14 ? calcRSI(closes1h) : null,
      macd,
      bb,
      vol,
      vwap5m,
      volAccel,
      orderBook,
      obImbalance,
      pinScore,
      funding,
      regime: regimeInfo.regime,
      regimeMetrics: regimeInfo.metrics,
      kmeansRegime: kmeansResult,  // Concept #12D
      futuresSignals: futuresData ? futuresIntel.getSignals(sym) : null, // Futures leading indicators
      klines5m,  // Needed for volume/price analysis in brain
      klines1h,  // Needed for macro candles in brain
      _rawBids: orderBook?._rawBids || [], // For depth analysis
      _rawAsks: orderBook?._rawAsks || []
    };
    d.intelScore = calcIntelScore(d);
    result[sym] = d;
  }));

  // L2.4: Inject BTC trend into alt data for cross-market lag detection
  const btcData = result['BTCUSDT'];
  if (btcData) {
    for (const [sym, d] of Object.entries(result)) {
      if (sym !== 'BTCUSDT' && sym !== '_meta') d._btcTrend1m = btcData.trend1m;
    }
  }

  return result;
}

// ── Polymarket helpers ───────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// ── CHILDREN SCANNER SYSTEM — lightweight, no Claude, feeds father's brain ──
// ══════════════════════════════════════════════════════════════════════════════

// Child specs: each specializes in one asset/timeframe
const CHILD_SPECS = [
  { id: 'btc-5min', asset: 'BTCUSDT', assetName: 'btc', windowMin: 5 },
  { id: 'eth-5min', asset: 'ETHUSDT', assetName: 'eth', windowMin: 5 },
  { id: 'sol-5min', asset: 'SOLUSDT', assetName: 'sol', windowMin: 5 },
  { id: 'btc-15min', asset: 'BTCUSDT', assetName: 'btc', windowMin: 15 },
  { id: 'eth-15min', asset: 'ETHUSDT', assetName: 'eth', windowMin: 15 },
  { id: 'sol-15min', asset: 'SOLUSDT', assetName: 'sol', windowMin: 15 },
  { id: 'btc-1hr', asset: 'BTCUSDT', assetName: 'btc', windowMin: 60 },
  { id: 'eth-1hr', asset: 'ETHUSDT', assetName: 'eth', windowMin: 60 },
  { id: 'sol-1hr', asset: 'SOLUSDT', assetName: 'sol', windowMin: 60 },
  // Level 3: Adversarial contrarian children — detect herding bias
  { id: 'btc-5min-contra', asset: 'BTCUSDT', assetName: 'btc', windowMin: 5, spec: 'BTC-5min-contra', contrarian: true },
  { id: 'sol-5min-contra', asset: 'SOLUSDT', assetName: 'sol', windowMin: 5, spec: 'SOL-5min-contra', contrarian: true },
];

// Rule-based signal using evolved DNA thresholds (no Claude needed)
// Each child's DNA evolves its own RSI/MACD/trend thresholds over time
function childSignal(d, dna = null, asset = null) {
  if (!d) return { dir: 'NEUTRAL', conf: 40, reason: 'no data', regime: 'UNKNOWN' };
  // Use evolved DNA thresholds if available, otherwise defaults
  const rsiOversold = dna?.rsiOversold ?? 35;
  const rsiOverbought = dna?.rsiOverbought ?? 65;
  const macdWeight = dna?.macdWeight ?? 1.0;
  const trendMinPct = dna?.trendMinPct ?? 0.3;
  const trend15mMinPct = dna?.trend15mMinPct ?? 0.5;
  const volSpikeThreshold = dna?.volSpikeThreshold ?? 1.5;
  const minConfidence = dna?.minConfidence ?? 55;

  // ── Wilmott: Regime-Aware Indicator Weights ──
  // Mean-reverting → favor RSI/BB; Trending → favor MACD/trend; Volatile → dampen all
  let regime = 'MEAN_REVERTING';
  let wRSI = 1.0, wMACD = 1.0, wTrend = 1.0, wBB = 1.0, wVol = 1.0;
  if (asset) {
    const regimeData = regimeDetector.detectRegime(asset);
    regime = regimeData.regime;
    if (regime === 'TRENDING') {
      wMACD = 1.5; wTrend = 1.5; wRSI = 0.5; wBB = 0.5;
    } else if (regime === 'MEAN_REVERTING') {
      wRSI = 1.5; wBB = 1.5; wMACD = 0.5; wTrend = 0.5;
    } else if (regime === 'VOLATILE') {
      wRSI = 0.75; wMACD = 0.75; wTrend = 0.75; wBB = 0.75; wVol = 0.75;
    }
  }

  // Weighted score accumulation (Wilmott regime-aware)
  let score = 0;
  const bearish = [], bullish = [];
  if (d.rsi < rsiOversold) { bullish.push('RSI oversold ' + d.rsi.toFixed(0)); score += wRSI; }
  if (d.rsi > rsiOverbought) { bearish.push('RSI overbought ' + d.rsi.toFixed(0)); score -= wRSI; }
  if (d.macd?.hist < 0 && Math.abs(d.macd.hist) * macdWeight > 0.01) { bearish.push('MACD bearish'); score -= wMACD; }
  else if (d.macd?.hist > 0 && d.macd.hist * macdWeight > 0.01) { bullish.push('MACD bullish'); score += wMACD; }
  if (d.trend5m < -trendMinPct) { bearish.push('5m trend ' + d.trend5m.toFixed(2) + '%'); score -= wTrend; }
  if (d.trend5m > trendMinPct) { bullish.push('5m trend +' + d.trend5m.toFixed(2) + '%'); score += wTrend; }
  if (d.trend15m < -trend15mMinPct) { bearish.push('15m trend ' + d.trend15m?.toFixed(2) + '%'); score -= wTrend; }
  if (d.trend15m > trend15mMinPct) { bullish.push('15m trend +' + d.trend15m?.toFixed(2) + '%'); score += wTrend; }
  if (d.vol?.trend === 'falling') { bearish.push('vol falling'); score -= wVol; }
  if (d.vol?.spike || (d.vol?.ratio && d.vol.ratio > volSpikeThreshold)) { bullish.push('vol spike'); score += wVol; }
  // Micro-trend tiebreaker: when no indicator fires (lateral market),
  // use raw trend1m direction as weak signal so children can still trade and learn.
  if (bullish.length === 0 && bearish.length === 0 && d.trend1m != null) {
    if (d.trend1m > 0.15) { bullish.push('micro-trend +' + d.trend1m.toFixed(3) + '%'); score += 0.5; }
    else if (d.trend1m < -0.15) { bearish.push('micro-trend ' + d.trend1m.toFixed(3) + '%'); score -= 0.5; }
  }

  // ═══ LEVEL 2 SIGNALS ═══

  // L2.1: Order book imbalance — bid/ask pressure predicts short-term direction
  if (d.obImbalance != null && Math.abs(d.obImbalance) > 0.15) {
    if (d.obImbalance > 0.15) { bullish.push('OB bid pressure ' + (d.obImbalance * 100).toFixed(0) + '%'); score += 0.8; }
    else if (d.obImbalance < -0.15) { bearish.push('OB ask pressure ' + (d.obImbalance * 100).toFixed(0) + '%'); score -= 0.8; }
  }

  // L2.2: Funding rate contrarian — extreme funding = crowded trade, fade it
  if (d.funding?.rate != null && Math.abs(d.funding.rate) > 0.0005) {
    if (d.funding.rate > 0.001) { bearish.push('funding extreme long ' + (d.funding.rate * 100).toFixed(3) + '%'); score -= 0.7; }
    else if (d.funding.rate < -0.001) { bullish.push('funding extreme short ' + (d.funding.rate * 100).toFixed(3) + '%'); score += 0.7; }
  }

  // L2.3: Multi-timeframe confirmation — 1m + 5m agree = stronger signal
  if (d.trend1m != null && d.trend5m != null) {
    const bothUp = d.trend1m > 0.1 && d.trend5m > trendMinPct;
    const bothDown = d.trend1m < -0.1 && d.trend5m < -trendMinPct;
    if (bothUp) { bullish.push('MTF confirm UP'); score += 0.6; }
    else if (bothDown) { bearish.push('MTF confirm DOWN'); score -= 0.6; }
  }

  // L2.4: Cross-market lag — BTC leads, alts follow 30-90s later
  if (asset && asset !== 'btc' && asset !== 'BTCUSDT' && d._btcTrend1m != null) {
    if (d._btcTrend1m > 0.2 && (d.trend1m || 0) < 0.05) {
      bullish.push('BTC lead +' + d._btcTrend1m.toFixed(2) + '% (lag)'); score += 0.5;
    } else if (d._btcTrend1m < -0.2 && (d.trend1m || 0) > -0.05) {
      bearish.push('BTC lead ' + d._btcTrend1m.toFixed(2) + '% (lag)'); score -= 0.5;
    }
  }

  if (score <= -1.0) return { dir: 'DOWN', conf: Math.min(85, minConfidence + bearish.length * 8), reason: bearish.slice(0, 3).join(', '), regime };
  if (score >= 1.0) return { dir: 'UP', conf: Math.min(85, minConfidence + bullish.length * 8), reason: bullish.slice(0, 3).join(', '), regime };
  return { dir: 'NEUTRAL', conf: 40, reason: 'conflicted signals', regime };
}

// Run one child scanner — fetch data, find best market, write intel
async function runChildScanner(spec, allPrices, allMarkets) {
  try {
    if (!fs.existsSync(INTEL_DIR)) fs.mkdirSync(INTEL_DIR, { recursive: true });
    const priceKey = spec.asset;
    const d = allPrices[priceKey];
    const dna = childLearning.getChildDNA(spec.id);
    const sig = childSignal(d, dna, spec.asset);

    // ═══ ML BOOST: Stat model adjusts child confidence ═══
    if (d && statModel.trained) {
      try {
        const childFeatures = {
          entryVec: {
            rsi: d.rsi || 50, rsi5m: d.rsi5m || 50,
            trend1m: d.trend1m || 0, trend5m: d.trend5m || 0,
            trend15m: d.trend15m || 0, trend1h: d.trend1h || 0,
            bbPct: d.bb?.pct || 50, volRatio: d.vol?.ratio || 1,
            volAccel: d.volAccel || 0, vwapPct: d.vwap5m?.pct || 0,
            buyPressure: d.orderBook?.buyPressure || 50,
            obRatio: d.orderBook?.ratio || 1,
            sellWallTrap: false, buyWallTrap: false,
            volatility: d.volatility || 0,
          },
          side: sig.dir === 'DOWN' ? 'NO' : 'YES',
          edge: 0.03, confidence: sig.conf,
          entryTime: new Date().toISOString(),
        };
        const mlPred = statModel.predict(childFeatures);
        // Boost or dampen child confidence based on stat model
        if (mlPred.confident) {
          const mlDir = mlPred.probability > 0.55 ? 'AGREE' : mlPred.probability < 0.45 ? 'DISAGREE' : 'NEUTRAL';
          if (mlDir === 'AGREE') {
            sig.conf = Math.min(95, sig.conf + 10);
            sig.reason += ' +ML_BOOST';
          } else if (mlDir === 'DISAGREE') {
            sig.conf = Math.max(30, sig.conf - 15);
            sig.reason += ' -ML_DAMPEN';
          }
        }
      } catch { }
    }

    // Level 3: Contrarian children invert the consensus signal
    if (spec.contrarian && sig.dir !== 'NEUTRAL') {
      sig.dir = sig.dir === 'UP' ? 'DOWN' : 'UP';
      sig.reason = 'CONTRA: ' + sig.reason;
    }

    // Find relevant markets for this child
    const myMarkets = allMarkets.filter(m =>
      m.asset === spec.assetName &&
      m._isUpDown &&
      m.windowMin === spec.windowMin &&
      m.closesAt &&
      (new Date(m.closesAt) - Date.now()) > 2 * 60 * 1000  // >2min to close
    ).slice(0, 5);

    // Find best opportunity (market most misaligned with signal)
    let bestMarket = null, bestEdge = 0;
    for (const m of myMarkets) {
      // If signal says DOWN, betting NO. Edge = implied NO prob - 50%
      const impliedEdge = sig.dir === 'DOWN' ? (1 - m.yesPrice) - 0.5
        : sig.dir === 'UP' ? m.yesPrice - 0.5 : 0;
      if (impliedEdge > bestEdge) { bestEdge = impliedEdge; bestMarket = m; }
    }

    // Log insight if strong signal — bottom-up learning
    if (sig.dir !== 'NEUTRAL' && sig.conf >= 65) {
      logChildInsight(spec.id, spec.assetName, sig.reason, sig.dir, 1);
    }

    // ═══ CHILD LEARNING: Record prediction as shadow bet ═══
    // ALWAYS record non-neutral signals — even without a matching market
    // This feeds the evolutionary engine with data for DNA optimization
    // GENETIC FIX: Only record if we have a valid entryPrice — shadows with price=0 can't resolve
    const entryPrice = d?.price || 0;
    if (sig.dir !== 'NEUTRAL' && entryPrice > 0) {
      childLearning.recordPrediction(spec.id, {
        direction: sig.dir,
        confidence: sig.conf,
        asset: spec.assetName,
        marketId: bestMarket?.id || `${spec.assetName}_shadow_${Date.now()}`,
        marketCloseTime: bestMarket?.closesAt || new Date(Date.now() + (spec.windowMin || 5) * 60000).toISOString(),
        reasons: sig.reason ? sig.reason.split(', ') : [],
        regime: d?.regime || 'UNKNOWN',
        track: 'quant',
        category: 'crypto',
        entryPrice,
      });
    }

    const intel = {
      spec: spec.id,
      asset: spec.assetName,
      windowMin: spec.windowMin,
      ts: new Date().toISOString(),
      price: d?.price,
      signal: sig,
      bestMarket: bestMarket ? {
        id: bestMarket.id,
        title: bestMarket.title,
        yesPrice: bestMarket.yesPrice,
        liquidity: bestMarket.liquidity,
        closesIn: Math.round((new Date(bestMarket.closesAt) - Date.now()) / 60000),
        suggestedSide: sig.dir === 'DOWN' ? 'NO' : 'YES',
        impliedEdge: parseFloat(bestEdge.toFixed(3))
      } : null,
      markets: myMarkets.length,
      intelScore: d?.intelScore || 50
    };

    // Rolling scoreHistory for death-by-incompetence detection
    const intelPath = path.join(INTEL_DIR, spec.id + '.json');
    let prevHistory = [];
    if (fs.existsSync(intelPath)) {
      try { prevHistory = JSON.parse(fs.readFileSync(intelPath, 'utf8')).scoreHistory || []; } catch { }
    }
    intel.scoreHistory = [...prevHistory, intel.intelScore].slice(-20);
    fs.writeFileSync(intelPath, JSON.stringify(intel, null, 2));
    return intel;
  } catch (e) { return null; }
}

// ── Concept #21: Time-to-Close Decay Factor ──────────────────────────────────
// Markets near expiry have accelerating theta decay and convergence to 0/1.
// This function gates and adjusts bets based on hours remaining.
// ── SHADOW BRAIN: Record predictions when fear/rules block real trades ──────
function recordAdanShadow(decision, market, reason) {
  if (!decision || !market) return;
  try {
    const side = (decision.action || decision.side || 'YES').replace('BET ', '');
    const myProb = decision.probability || decision.myProb || 0.5;
    const confidence = decision.confidence || 0;

    console.log(`[SHADOW BRAIN] 👻 Recording shadow bet for training: ${side} (prob: ${myProb.toFixed(2)}) | Reason: ${reason}`);

    // Capital vetoes stop STAKES, not FORECASTS. A prediction risks nothing,
    // and Brier v1 reputation is built on forecasts alone — freezing commits
    // because the paper fund is in drawdown froze the snowball for no reason.
    // Signal vetoes (insufficient EV, etc.) stay local: no signal, no commit.
    // decision.action can be a bare "BET" — normalize to YES/NO or don't commit.
    const CAPITAL_VETOES = ['HIGH_DRAWDOWN_VETO', 'MAX_POSITIONS_OPEN', 'PROBATION_SINGLE_POSITION'];
    const rawSide = String(decision.side || decision.action || '').toUpperCase().replace(/^BET\s*/, '').trim();
    const commitSide = ['NO', 'DOWN', 'SHORT'].includes(rawSide) ? 'NO'
      : ['YES', 'UP', 'LONG'].includes(rawSide) ? 'YES' : null;
    if (CAPITAL_VETOES.includes(reason) && commitSide && myProb > 0 && myProb < 1) {
      reportPaperBet({ market, side: commitSide, probability: myProb, marketYesPrice: market.yesPrice }).catch(() => {});
    }

    // Feed into childLearning as a specialized "ADAN-MAIN" agent shadow
    childLearning.recordPrediction('ADAN-MAIN', {
      direction: side,
      confidence: confidence,
      asset: market.asset || 'btc',
      marketId: market.id || `shadow_${Date.now()}`,
      marketCloseTime: market.closesAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reasons: [reason, decision.primary_reason || 'ADAN logic skip'],
      track: 'main_brain',
      category: 'crypto_prediction',
      entryPrice: side === 'YES' ? market.yesPrice : (1 - market.yesPrice),
      isShadow: true
    });
  } catch (e) {
    console.log('[SHADOW BRAIN] Error recording shadow:', e.message);
  }
}

function getTimeDecayFactor(market) {
  // Concept #21 — Time-to-close as feature
  // ADAN is an EXPERT in 5min and 15min markets — these are the core business
  // TTC filter only applies to LONG-TERM markets (daily, weekly, event-based)
  const closeDate = market.closesAt || market.endDate;
  if (!closeDate) return { factor: 1.0, canBet: true, time_to_close_hours: null, note: 'no close date' };

  const time_to_close_hours = (new Date(closeDate) - Date.now()) / 3600000;

  // Already expired
  if (time_to_close_hours <= 0) {
    return { factor: 0, canBet: false, closeExisting: true, time_to_close_hours, note: 'market expired' };
  }

  // Detect market type from title/slug — 5min and 15min markets are SHORT by design
  const title = (market.title || market.question || market.slug || '').toLowerCase();
  const is5min = title.includes('5min') || title.includes('5 min') || /\d+:\d+[ap]m.*\d+:\d+[ap]m/i.test(title);
  const is15min = title.includes('15min') || title.includes('15 min');
  const isShortTermCrypto = is5min || is15min || title.includes('up or down');

  if (isShortTermCrypto) {
    // Short-term crypto: ADAN's specialty — always tradeable if > 1min left
    if (time_to_close_hours < 1 / 60) { // < 1 minute
      return { factor: 0, canBet: false, closeExisting: true, time_to_close_hours, note: 'expiring in <1min' };
    }
    // Slight decay in last 2 minutes but still tradeable
    const factor = time_to_close_hours < 2 / 60 ? 0.7 : 1.0;
    return { factor, canBet: true, time_to_close_hours, note: isShortTermCrypto ? 'short-term crypto — core' : 'standard' };
  }

  // LONG-TERM markets (politics, events, daily): apply strict TTC rules
  if (time_to_close_hours < 0.25) {
    return { factor: 0, canBet: false, closeExisting: true, time_to_close_hours, note: 'long-term market <15min — close existing' };
  }
  if (time_to_close_hours < 1) {
    return { factor: 0.3, canBet: true, minEdge: 0.10, time_to_close_hours, note: 'long-term <1h — high edge only' };
  }
  if (time_to_close_hours < 4) {
    return { factor: 0.5, canBet: true, minEdge: 0.08, time_to_close_hours, note: 'reduced Kelly 1-4h' };
  }
  if (time_to_close_hours <= 48) {
    return { factor: 1.0, canBet: true, time_to_close_hours, note: 'whale/PIN signals weight more' };
  }
  return { factor: 1.0, canBet: true, time_to_close_hours, note: 'standard' };
}


// ── Award EXP to a child when father wins on the asset that child reported ────
function awardChildExp(asset, won) {
  const pnl = loadPnL();
  const children = pnl.children || [];
  let changed = false;
  for (const child of children) {
    // Child earns EXP if its asset matches and it reported a non-neutral signal
    const childAsset = child.spec.replace(/-\d+(min|hr)$/, '').toLowerCase();
    if (childAsset !== asset.toLowerCase()) continue;
    const slug = child.spec.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const intelPath = path.join(INTEL_DIR, slug + '.json');
    try {
      if (!fs.existsSync(intelPath)) continue;
      const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
      const age = (Date.now() - new Date(intel.ts).getTime()) / 60000;
      if (age > 15) continue; // intel must be recent
      if (intel.signal?.dir === 'NEUTRAL') continue;
      // Check if signal was aligned with outcome
      const childDir = path.join(DIR, 'children', child.id || child.spec);
      const childPnlPath = path.join(childDir, 'pnl.json');
      if (!fs.existsSync(childPnlPath)) continue;
      const cp = JSON.parse(fs.readFileSync(childPnlPath, 'utf8'));
      const expGain = won ? 40 : 10; // more for correct signal
      cp.exp = (cp.exp || 0) + expGain;
      cp.signals = (cp.signals || 0) + 1;
      if (won) cp.correctSignals = (cp.correctSignals || 0) + 1;
      fs.writeFileSync(childPnlPath, JSON.stringify(cp, null, 2));
      changed = true;
    } catch { }
  }
  if (changed) savePnL(pnl);
}

// ── Grandchild specs: sub-specializations per parent spec ────────────────────
const GRANDCHILD_SPECS = {
  'BTC-5min': [
    { id: 'btc-1min-mom', asset: 'BTCUSDT', assetName: 'btc', windowMin: 5, focus: '1min-momentum' },
    { id: 'btc-5min-vol', asset: 'BTCUSDT', assetName: 'btc', windowMin: 5, focus: 'volume-spike' },
  ],
  'ETH-5min': [
    { id: 'eth-1min-mom', asset: 'ETHUSDT', assetName: 'eth', windowMin: 5, focus: '1min-momentum' },
    { id: 'eth-5min-rsi', asset: 'ETHUSDT', assetName: 'eth', windowMin: 5, focus: 'rsi-extreme' },
  ],
  'SOL-5min': [
    { id: 'sol-1min-mom', asset: 'SOLUSDT', assetName: 'sol', windowMin: 5, focus: '1min-momentum' },
    { id: 'sol-orderbook', asset: 'SOLUSDT', assetName: 'sol', windowMin: 5, focus: 'orderbook' },
  ],
  'BTC-15min': [
    { id: 'btc-15min-bb', asset: 'BTCUSDT', assetName: 'btc', windowMin: 15, focus: 'bollinger' },
    { id: 'btc-15min-macd', asset: 'BTCUSDT', assetName: 'btc', windowMin: 15, focus: 'macd-cross' },
  ],
  'ETH-15min': [
    { id: 'eth-15min-bb', asset: 'ETHUSDT', assetName: 'eth', windowMin: 15, focus: 'bollinger' },
    { id: 'eth-15min-vol', asset: 'ETHUSDT', assetName: 'eth', windowMin: 15, focus: 'volume-profile' },
  ],
  'SOL-15min': [
    { id: 'sol-15min-bb', asset: 'SOLUSDT', assetName: 'sol', windowMin: 15, focus: 'bollinger' },
    { id: 'sol-15min-macd', asset: 'SOLUSDT', assetName: 'sol', windowMin: 15, focus: 'macd-cross' },
  ],
  'BTC-1hr': [
    { id: 'btc-1hr-trend', asset: 'BTCUSDT', assetName: 'btc', windowMin: 60, focus: 'trend-follow' },
    { id: 'btc-1hr-rev', asset: 'BTCUSDT', assetName: 'btc', windowMin: 60, focus: 'mean-reversion' },
  ],
  'ETH-1hr': [
    { id: 'eth-1hr-trend', asset: 'ETHUSDT', assetName: 'eth', windowMin: 60, focus: 'trend-follow' },
    { id: 'eth-1hr-bb', asset: 'ETHUSDT', assetName: 'eth', windowMin: 60, focus: 'bollinger' },
  ],
  'SOL-1hr': [
    { id: 'sol-1hr-trend', asset: 'SOLUSDT', assetName: 'sol', windowMin: 60, focus: 'trend-follow' },
    { id: 'sol-1hr-vol', asset: 'SOLUSDT', assetName: 'sol', windowMin: 60, focus: 'volume-spike' },
  ],
};

// Grandchild signal — same rule-based but focuses on one indicator
function grandchildSignal(d, focus) {
  if (!d) return { dir: 'NEUTRAL', conf: 40, reason: 'no data' };
  if (focus === '1min-momentum') {
    if (d.trend1m < -0.2) return { dir: 'DOWN', conf: 65, reason: '1m bearish ' + d.trend1m.toFixed(2) + '%' };
    if (d.trend1m > 0.2) return { dir: 'UP', conf: 65, reason: '1m bullish +' + d.trend1m.toFixed(2) + '%' };
    return { dir: 'NEUTRAL', conf: 40, reason: '1m flat' };
  }
  if (focus === 'volume-spike') {
    if (d.vol?.spike && d.trend5m < 0) return { dir: 'DOWN', conf: 70, reason: 'vol spike bearish' };
    if (d.vol?.spike && d.trend5m > 0) return { dir: 'UP', conf: 70, reason: 'vol spike bullish' };
    return { dir: 'NEUTRAL', conf: 40, reason: 'no vol spike' };
  }
  if (focus === 'rsi-extreme') {
    if (d.rsi < 30) return { dir: 'UP', conf: 72, reason: 'RSI oversold ' + d.rsi.toFixed(0) };
    if (d.rsi > 70) return { dir: 'DOWN', conf: 72, reason: 'RSI overbought ' + d.rsi.toFixed(0) };
    return { dir: 'NEUTRAL', conf: 40, reason: 'RSI mid ' + d.rsi.toFixed(0) };
  }
  if (focus === 'bollinger') {
    if ((d.bb?.pct || 50) < 15) return { dir: 'UP', conf: 68, reason: 'BB lower band touch' };
    if ((d.bb?.pct || 50) > 85) return { dir: 'DOWN', conf: 68, reason: 'BB upper band touch' };
    return { dir: 'NEUTRAL', conf: 40, reason: 'BB mid ' + ((d.bb?.pct || 50).toFixed(0)) + '%' };
  }
  if (focus === 'macd-cross') {
    const hist = d.macd?.hist || 0;
    if (hist < -0.005) return { dir: 'DOWN', conf: 66, reason: 'MACD bearish cross' };
    if (hist > 0.005) return { dir: 'UP', conf: 66, reason: 'MACD bullish cross' };
    return { dir: 'NEUTRAL', conf: 40, reason: 'MACD neutral' };
  }
  if (focus === 'orderbook') {
    const ob = d.orderBook;
    if (!ob) return { dir: 'NEUTRAL', conf: 40, reason: 'no orderbook' };
    if (ob.buyPressure > 65) return { dir: 'UP', conf: 68, reason: 'buy pressure ' + ob.buyPressure + '%' };
    if (ob.buyPressure < 35) return { dir: 'DOWN', conf: 68, reason: 'sell pressure ' + (100 - ob.buyPressure) + '%' };
    return { dir: 'NEUTRAL', conf: 40, reason: 'balanced book' };
  }
  if (focus === 'volume-profile') {
    if (d.vol?.trend === 'rising' && d.trend15m > 0) return { dir: 'UP', conf: 67, reason: 'vol+trend rising' };
    if (d.vol?.trend === 'rising' && d.trend15m < 0) return { dir: 'DOWN', conf: 67, reason: 'vol rising, price down' };
    return { dir: 'NEUTRAL', conf: 40, reason: 'vol flat' };
  }
  return childSignal(d, null, null);
}

// ── Spawn grandchildren when ADAN is LVL 4+ and child has enough EXP ─────────
async function spawnGrandchildren() {
  const pnl = loadPnL();
  const xpData = expProgress(pnl.exp || 0);
  if (xpData.level < 4) return; // nietos solo desde LVL 4 de ADAN

  const children = pnl.children || [];
  for (const child of children) {
    const childDir = path.join(DIR, 'children', child.id || child.spec);
    const childPnlPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(childPnlPath)) continue;

    let cp;
    try { cp = JSON.parse(fs.readFileSync(childPnlPath, 'utf8')); } catch { continue; }

    const childExp = cp.exp || 0;
    const gcList = cp.children || [];
    const gcSpecs = GRANDCHILD_SPECS[child.spec] || [];
    const maxGC = TREE_RULES.maxChildrenGen2;

    // Child needs enough EXP and can still grow
    if (childExp < TREE_RULES.childExpToSpawn) continue;
    if (gcList.length >= maxGC) continue;

    const takenSpecs = gcList.map(g => g.spec);
    const nextGcSpec = gcSpecs.find(s => !takenSpecs.includes(s.id));
    if (!nextGcSpec) continue;

    // Name the grandchild
    let gcName = nextGcSpec.id.toUpperCase().replace(/-/g, '_');
    try {
      const resp = await routeLLM({
        prompt: `Name a micro-scanner AI: focus=${nextGcSpec.focus}, asset=${nextGcSpec.assetName}. One short mythological name in CAPS only.`,
        weight: 'Light',
        reason: 'naming'
      });
      gcName = resp.trim().replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10) || gcName;
    } catch { }

    const gcId = Date.now().toString();
    const gcDir = path.join(childDir, 'children', nextGcSpec.id);
    if (!fs.existsSync(gcDir)) fs.mkdirSync(gcDir, { recursive: true });

    // ── CROSSOVER DE LINAJES CAMPEONES ─────────────────────────────────────
    // Find the 2 best-performing children (by intel score) and crossover their DNA
    const allChildDNA = children.map(ch => {
      try {
        const chDir = path.join(DIR, 'children', ch.id || ch.spec);
        const chPnl = JSON.parse(fs.readFileSync(path.join(chDir, 'pnl.json'), 'utf8'));
        return { name: ch.name, dna: chPnl.dna || {}, scores: (chPnl.scoreHistory || []) };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => {
      const avgA = a.scores.length ? a.scores.reduce((s, v) => s + v, 0) / a.scores.length : 50;
      const avgB = b.scores.length ? b.scores.reduce((s, v) => s + v, 0) / b.scores.length : 50;
      return avgB - avgA;
    });
    const parentA = allChildDNA[0]?.dna || cp.dna || {};
    const parentB = allChildDNA[1]?.dna || {};
    // Weighted crossover: 70% from best parent, 30% from second + mutation
    const crossover = (a, b, mut = 0.05) => {
      const base = (a || 1) * 0.7 + (b || a || 1) * 0.3;
      return parseFloat((base * (1 + (Math.random() * 2 - 1) * mut)).toFixed(4));
    };
    const gcDNA = {
      minEdge: crossover(parentA.minEdge, parentB.minEdge, 0.08),
      volWeight: crossover(parentA.volWeight, parentB.volWeight, 0.06),
      vwapWeight: crossover(parentA.vwapWeight, parentB.vwapWeight, 0.06),
      stakePct: crossover(parentA.stakePct || 0.08, parentB.stakePct || 0.08, 0.10),
      patience: crossover(parentA.patience || 1.0, parentB.patience || 1.0, 0.08),
      cognitiveStyle: parentA.cognitiveStyle || 'volume_vwap',
      mutation: Math.round(Math.random() * 100),
      crossoverFrom: [allChildDNA[0]?.name || '?', allChildDNA[1]?.name || '?'],
      isElite: true
    };

    // Destilación de traumas: read last 5 mistakes from parent SOUL.md
    let traumaRules = '';
    try {
      const parentSoulPath = path.join(childDir, 'SOUL.md');
      if (fs.existsSync(parentSoulPath)) {
        const psoul = fs.readFileSync(parentSoulPath, 'utf8');
        const mistakes = psoul.split('\n').filter(l => l.includes('MISTAKE') || l.includes('LOSS')).slice(-5);
        if (mistakes.length) traumaRules = '\n## Trauma Rules (inherited from parent mistakes):\n' + mistakes.join('\n') + '\n';
      }
      const rootSoulContent = loadSoul();
      const rootMistakes = rootSoulContent.split('\n').filter(l => l.includes('MISTAKE') || l.includes('DREAM_RULE')).slice(-5);
      if (rootMistakes.length) traumaRules += '\n## ROOT Trauma Rules (from ADAN):\n' + rootMistakes.join('\n') + '\n';
    } catch { }

    const gcSoul = `# ${gcName} — ELITE GRANDCHILD (CROSSOVER)
Created: ${new Date().toISOString().slice(0, 10)}
Name: ${gcName} | Spec: ${nextGcSpec.id} | Focus: ${nextGcSpec.focus}
Parent: ${child.name || child.spec}
Crossover: ${gcDNA.crossoverFrom.join(' × ')} (70/30 weighted)

## Identity
I am ${gcName}. Elite grandchild of ADAN. Born from crossover of the 2 strongest lineages.
I specialize in ${nextGcSpec.focus} signals for ${nextGcSpec.assetName.toUpperCase()} ${nextGcSpec.windowMin}min markets.
I never bet. I scan one indicator with precision and report up.

## DNA Manifest
This genome combines ${gcDNA.crossoverFrom[0]}'s strength with ${gcDNA.crossoverFrom[1]}'s adaptability.
volWeight: ${gcDNA.volWeight} | vwapWeight: ${gcDNA.vwapWeight} | stakePct: ${(gcDNA.stakePct * 100).toFixed(1)}%
${traumaRules}
## Rules
1. Focus: ${nextGcSpec.focus} only
2. Report signal to parent ${child.name || child.spec}
3. Parent reports to ADAN — chain of intelligence
`;
    fs.writeFileSync(path.join(gcDir, 'SOUL.md'), gcSoul);
    fs.writeFileSync(path.join(gcDir, 'pnl.json'), JSON.stringify({
      trades: 0, wins: 0, losses: 0, net: 0, exp: 0,
      fund: 0, treasury: 0, children: [], generation: 3,
      parentId: child.id, spec: nextGcSpec.id, name: gcName, focus: nextGcSpec.focus,
      dna: gcDNA
    }, null, 2));

    const gc = {
      id: gcId, name: gcName, spec: nextGcSpec.id, focus: nextGcSpec.focus,
      born: new Date().toISOString(), dir: gcDir, generation: 3, dna: gcDNA, isElite: true
    };
    cp.children = [...gcList, gc];
    fs.writeFileSync(childPnlPath, JSON.stringify(cp, null, 2));

    console.log('\n' + B + BOLD + '  🌱 GRANDCHILD BORN: ' + gcName + ' (' + nextGcSpec.id + ') → focus: ' + nextGcSpec.focus + ' | parent: ' + (child.name || child.spec) + X + '\n');
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── APPLE: El Oráculo del Contexto — "¿QUÉ y POR QUÉ?" ──────────────────
function runAppleScanner(allPrices, allMarkets) {
  const meta = allPrices._meta || {};
  const fg = meta.fearGreed;
  const news = meta.cryptoNews || [];

  // Analyze narratives from market titles
  const narrativeKeywords = { ai: 0, etf: 0, regulation: 0, hack: 0, election: 0, fed: 0, defi: 0, memecoin: 0 };
  const titleCorpus = allMarkets.map(m => (m.title || '').toLowerCase()).join(' ');
  for (const kw of Object.keys(narrativeKeywords)) {
    narrativeKeywords[kw] = (titleCorpus.match(new RegExp(kw, 'gi')) || []).length;
  }
  const topNarrative = Object.entries(narrativeKeywords).sort((a, b) => b[1] - a[1])[0];
  const narrativeStr = topNarrative[1] > 0 ? topNarrative[0].toUpperCase() : 'MIXED';

  // Sentiment from news
  let bullish = 0, bearish = 0, neutral = 0;
  for (const n of news) {
    if (n.sentiment === 'BULLISH') bullish++;
    else if (n.sentiment === 'BEARISH') bearish++;
    else neutral++;
  }
  const totalNews = bullish + bearish + neutral;
  const sentimentScore = totalNews > 0 ? Math.round(((bullish - bearish) / totalNews + 1) * 50) : 50;

  // Fear & Greed influence
  const fgValue = fg?.value ?? 50;
  const fgBias = fgValue < 25 ? 'EXTREME_FEAR' : fgValue < 40 ? 'FEAR' : fgValue > 75 ? 'EXTREME_GREED' : fgValue > 60 ? 'GREED' : 'NEUTRAL';

  // Confidence = combination of news volume + F&G extremeness
  const fgConfidence = Math.abs(fgValue - 50) * 1.2;
  const newsConfidence = Math.min(30, totalNews * 5);
  const confidence = Math.min(100, Math.round(40 + fgConfidence + newsConfidence));

  // Recommend markets with highest liquidity that align with narrative
  const recommendedMarkets = allMarkets
    .filter(m => m.liquidity >= 500)
    .sort((a, b) => b.liquidity - a.liquidity)
    .slice(0, 5)
    .map(m => ({ id: m.id, title: (m.title || '').slice(0, 60), liquidity: m.liquidity, yesPrice: m.yesPrice }));

  // Determine opportunity
  let opportunity = 'NEUTRAL';
  if (fgValue < 25 && bearish > bullish) opportunity = 'CONTRARIAN_LONG';
  else if (fgValue < 25 && bullish > bearish) opportunity = 'FEAR_RECOVERY';
  else if (fgValue > 75 && bullish > bearish) opportunity = 'MOMENTUM_RISK';
  else if (fgValue > 75 && bearish > bullish) opportunity = 'GREED_REVERSAL';
  else if (bullish > bearish * 2) opportunity = 'STRONG_BULL';
  else if (bearish > bullish * 2) opportunity = 'STRONG_BEAR';

  return {
    opportunity,
    narrative: narrativeStr,
    confidence,
    sentimentScore,
    fgBias,
    fgValue,
    newsCount: totalNews,
    newsSummary: news.slice(0, 3).map(n => `[${n.sentiment}] ${(n.title || '').slice(0, 50)}`),
    recommendedMarkets
  };
}

// ── SNAKE: El Verdugo de la Ejecución — "¿CÓMO y CUÁNDO?" ────────────────
function runSnakeScanner(allPrices, appleRecommendedMarkets) {
  const btc = allPrices['BTCUSDT'];
  const eth = allPrices['ETHUSDT'];
  const sol = allPrices['SOLUSDT'];

  // Analyze overall market liquidity and volatility
  const priceEntries = Object.entries(allPrices).filter(([k]) => k !== '_meta' && allPrices[k]);
  let totalVolRatio = 0, volCount = 0, avgVolatility = 0;
  for (const [, d] of priceEntries) {
    if (d?.vol?.ratio) { totalVolRatio += d.vol.ratio; volCount++; }
    if (d?.volatility) avgVolatility += d.volatility;
  }
  avgVolatility = volCount > 0 ? avgVolatility / volCount : 0;
  const avgVolRatio = volCount > 0 ? totalVolRatio / volCount : 1;

  // Slippage risk based on order book data
  const obData = btc?.orderBook;
  let slippageRisk = 'med';
  if (obData) {
    const totalDepth = (obData.bidVolUSD || 0) + (obData.askVolUSD || 0);
    if (totalDepth > 500000) slippageRisk = 'low';
    else if (totalDepth < 100000) slippageRisk = 'high';
  }

  // Optimal timing based on volume acceleration and trend alignment
  const btcAccel = btc?.volAccel || 0;
  const btcTrend5m = btc?.trend5m || 0;
  const btcTrend1h = btc?.trend1h || 0;
  const trendAligned = (btcTrend5m > 0 && btcTrend1h > 0) || (btcTrend5m < 0 && btcTrend1h < 0);

  let optimalTiming = 'WAIT';
  let viability = 'LOW';
  if (avgVolRatio > 1.3 && trendAligned && btcAccel >= 1) {
    optimalTiming = 'NOW — high volume + trend aligned + accelerating';
    viability = 'HIGH';
  } else if (avgVolRatio > 1.0 && trendAligned) {
    optimalTiming = 'SOON — trends aligned but volume moderate';
    viability = 'MEDIUM';
  } else if (avgVolRatio > 1.3 && !trendAligned) {
    optimalTiming = 'CAUTION — volume present but trends diverge';
    viability = 'MEDIUM';
  } else if (avgVolRatio < 0.8) {
    optimalTiming = 'WAIT — market dormant, no volume conviction';
    viability = 'LOW';
  } else {
    optimalTiming = 'MONITOR — no clear signal';
    viability = 'LOW';
  }

  // Execution plan
  const executionPlan = viability === 'HIGH'
    ? `Execute on recommended markets. Vol ratio ${avgVolRatio.toFixed(1)}x, BTC trend aligned (5m:${btcTrend5m.toFixed(2)}% 1h:${btcTrend1h.toFixed(2)}%). Slippage: ${slippageRisk}.`
    : viability === 'MEDIUM'
      ? `Partial execution possible. Vol ratio ${avgVolRatio.toFixed(1)}x. Wait for confirmation or reduce position size.`
      : `Hold position. Market conditions unfavorable. Vol ratio ${avgVolRatio.toFixed(1)}x avg volatility ${(avgVolatility * 100).toFixed(3)}%.`;

  return {
    viability,
    executionPlan,
    slippageRisk,
    optimalTiming,
    avgVolRatio: parseFloat(avgVolRatio.toFixed(2)),
    avgVolatility: parseFloat(avgVolatility.toFixed(6)),
    btcTrend: { m5: btcTrend5m, h1: btcTrend1h, aligned: trendAligned },
    volAccel: btcAccel,
    marketDepth: obData ? { bidUSD: obData.bidVolUSD, askUSD: obData.askVolUSD } : null
  };
}

// ── EVA: La Reina del Riesgo — "¿PODEMOS?" ────────────────────────────────
function runEvaScanner(appleReport, snakeReport, pnl) {
  const fund = pnl.fund ?? 10000;
  const treasury = pnl.treasury ?? 0;
  const totalCapital = fund + treasury;
  const openPositions = loadPositions().open.length;
  const maxPos = MAX_POSITIONS;
  const wr = pnl.trades > 0 ? pnl.wins / pnl.trades : 0.5;
  const net = pnl.net ?? 0;

  // Risk assessment
  const slotsAvailable = maxPos - openPositions;
  const capitalUtilization = openPositions / maxPos;

  // Risk level based on multiple factors
  let riskPoints = 0;
  if (fund < 1000) riskPoints += 3;          // Low capital
  else if (fund < 5000) riskPoints += 1;
  if (wr < 0.4 && pnl.trades >= 5) riskPoints += 2;   // Poor track record
  if (capitalUtilization > 0.7) riskPoints += 2;       // Over-exposed
  if (net < -500) riskPoints += 2;                     // Deep drawdown
  if (snakeReport.viability === 'LOW') riskPoints += 2;
  if (snakeReport.slippageRisk === 'high') riskPoints += 1;
  if (appleReport.confidence < 50) riskPoints += 1;

  const riskLevel = riskPoints >= 5 ? 'high' : riskPoints >= 3 ? 'med' : 'low';

  // Determine max capital allocation
  let maxCapitalPct = 0.02; // default 2% of fund
  if (riskLevel === 'low' && snakeReport.viability === 'HIGH') maxCapitalPct = 0.05;
  else if (riskLevel === 'low') maxCapitalPct = 0.03;
  else if (riskLevel === 'high') maxCapitalPct = 0.01;
  const maxCapital = Math.round(fund * maxCapitalPct);

  // Approval logic
  let approved = true;
  let reason = '';

  if (slotsAvailable <= 0) {
    approved = false;
    reason = `All ${maxPos} position slots occupied. Wait for closures.`;
  } else if (fund < 50) {
    approved = false;
    reason = `Capital critically low ($${fund.toFixed(2)}). Survival mode — no new bets.`;
  } else if (riskLevel === 'high' && appleReport.confidence < 60) {
    approved = false;
    reason = `High risk (${riskPoints}pts) + low confidence (${appleReport.confidence}%). Risk/reward unfavorable.`;
  } else if (snakeReport.viability === 'LOW' && riskLevel !== 'low') {
    approved = false;
    reason = `Market conditions poor (viability: LOW) and risk elevated. Wait for better entry.`;
  } else {
    reason = `Approved. Risk: ${riskLevel} (${riskPoints}pts). Max allocation: $${maxCapital}. Slots: ${slotsAvailable}/${maxPos} free. WR: ${Math.round(wr * 100)}%.`;
  }

  return {
    approved,
    maxCapital,
    reason,
    riskLevel,
    riskPoints,
    slotsAvailable,
    capitalUtilization: parseFloat(capitalUtilization.toFixed(2)),
    fundStatus: fund < 1000 ? 'CRITICAL' : fund < 5000 ? 'LOW' : 'HEALTHY'
  };
}

// ── Golden Round Table: Apple → Snake → Eva Full Cycle ──────────────────────
function runMesaRedonda(allPrices, allMarkets, pnl) {
  const ts = new Date().toISOString();

  // 1. APPLE analyzes context and opportunities
  const appleReport = runAppleScanner(allPrices, allMarkets);

  // 2. SNAKE evaluates execution with markets recommended by Apple
  const snakeReport = runSnakeScanner(allPrices, appleReport.recommendedMarkets);

  // 3. EVA decides if we can risk capital
  const evaReport = runEvaScanner(appleReport, snakeReport, pnl);

  const mesaResult = {
    ts,
    apple: appleReport,
    snake: snakeReport,
    eva: evaReport,
    consensus: evaReport.approved ? 'PROCEED' : 'HOLD'
  };

  // Write individual intel files for each parent
  if (!fs.existsSync(INTEL_DIR)) fs.mkdirSync(INTEL_DIR, { recursive: true });

  const appleIntel = {
    spec: 'apple', asset: 'CONTEXT', windowMin: 0, ts,
    price: null, intelScore: appleReport.confidence,
    signal: {
      dir: appleReport.opportunity.includes('BULL') || appleReport.opportunity.includes('RECOVERY') ? 'UP'
        : appleReport.opportunity.includes('BEAR') || appleReport.opportunity.includes('REVERSAL') ? 'DOWN' : 'NEUTRAL',
      conf: appleReport.confidence,
      reason: `Opportunity: ${appleReport.opportunity} | Narrative: ${appleReport.narrative} | F&G: ${appleReport.fgValue} (${appleReport.fgBias}) | Sentiment: ${appleReport.sentimentScore}/100`
    },
    bestMarket: appleReport.recommendedMarkets[0] || null,
    report: appleReport
  };

  const snakeIntel = {
    spec: 'snake', asset: 'EXECUTION', windowMin: 0, ts,
    price: null, intelScore: snakeReport.viability === 'HIGH' ? 85 : snakeReport.viability === 'MEDIUM' ? 55 : 25,
    signal: {
      dir: snakeReport.viability === 'HIGH' ? 'UP' : snakeReport.viability === 'MEDIUM' ? 'NEUTRAL' : 'DOWN',
      conf: snakeReport.viability === 'HIGH' ? 85 : snakeReport.viability === 'MEDIUM' ? 55 : 25,
      reason: `Viability: ${snakeReport.viability} | Timing: ${snakeReport.optimalTiming} | Slippage: ${snakeReport.slippageRisk} | VolRatio: ${snakeReport.avgVolRatio}x`
    },
    bestMarket: null,
    report: snakeReport
  };

  const evaIntel = {
    spec: 'eva', asset: 'RISK', windowMin: 0, ts,
    price: null, intelScore: evaReport.approved ? 80 : 20,
    signal: {
      dir: evaReport.approved ? 'UP' : 'DOWN',
      conf: evaReport.approved ? 80 : 90,
      reason: evaReport.reason
    },
    bestMarket: null,
    report: evaReport
  };

  fs.writeFileSync(path.join(INTEL_DIR, 'apple.json'), JSON.stringify(appleIntel, null, 2));
  fs.writeFileSync(path.join(INTEL_DIR, 'snake.json'), JSON.stringify(snakeIntel, null, 2));
  fs.writeFileSync(path.join(INTEL_DIR, 'eva.json'), JSON.stringify(evaIntel, null, 2));

  console.log(`${M}GOLDEN ROUND TABLE:${X} Apple(${appleReport.opportunity}) → Snake(${snakeReport.viability}) → Eva(${evaReport.approved ? 'APPROVED' : 'DENIED'}) = ${mesaResult.consensus}`);

  return mesaResult;
}

// Run a parent agent's logic based on its role (wrapper for compatibility)
async function runParentScanner(parent, allPrices, allMarkets) {
  // Read pre-computed intel from Golden Round Table cycle
  const intelPath = path.join(INTEL_DIR, parent.id + '.json');
  if (fs.existsSync(intelPath)) {
    try {
      const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
      console.log(`${B}PARENT SCANNER:${X} ${parent.name} (${parent.role}) — loaded from Golden Round Table.`);
      return intel;
    } catch { }
  }

  // Fallback: generate fresh (should not happen normally)
  const intel = {
    spec: parent.id, asset: parent.specialization, windowMin: 0,
    ts: new Date().toISOString(), price: null,
    signal: { dir: 'NEUTRAL', conf: 50, reason: `${parent.name}: awaiting Golden Round Table cycle` },
    bestMarket: null, intelScore: 50
  };
  if (!fs.existsSync(INTEL_DIR)) fs.mkdirSync(INTEL_DIR, { recursive: true });
  fs.writeFileSync(intelPath, JSON.stringify(intel, null, 2));
  console.log(`${B}PARENT SCANNER:${X} ${parent.name} (${parent.role}) — fallback mode.`);
  return intel;
}

// Run all child scanners in parallel (includes active grandchildren)
async function runAllChildScanners(allPrices, allMarkets) {
  const pnl = loadPnL();
  const config = loadConfig();
  const xpData = expProgress(pnl.exp || 0);
  let results = [];

  // ── ALWAYS run CHILD_SPECS scanners — they feed the evolutionary engine ──
  // These are the 12 crypto children that generate shadow predictions for DNA evolution
  const childResults = await Promise.all(CHILD_SPECS.map(s => runChildScanner(s, allPrices, allMarkets)));
  results = results.concat(childResults);

  // ── Mesa Redonda Parent Scanners (Apple/Snake/Eva) — complementary intel ──
  if (config.mesaRedonda && config.mesaRedonda.parents) {
    const parentResults = await Promise.all(
      config.mesaRedonda.parents.map(parent => runParentScanner(parent, allPrices, allMarkets))
    );
    results = results.concat(parentResults);
  }

  // Keep existing grandchild logic for now
  if (xpData.level >= 4) {
    const children = pnl.children || [];
    for (const child of children) {
      const childDir = path.join(DIR, 'children', child.id || child.spec);
      const childPnlPath = path.join(childDir, 'pnl.json');
      try {
        if (!fs.existsSync(childPnlPath)) continue;
        const cp = JSON.parse(fs.readFileSync(childPnlPath, 'utf8'));
        const gcList = cp.children || [];
        const gcSpecs = GRANDCHILD_SPECS[child.spec] || [];
        for (const gc of gcList) {
          const gcSpec = gcSpecs.find(s => s.id === gc.spec);
          if (!gcSpec) continue;
          // Run grandchild scanner with its focus
          const d = allPrices[gcSpec.asset];
          const sig = grandchildSignal(d, gcSpec.focus);
          const intel = {
            spec: gcSpec.id,
            asset: gcSpec.assetName,
            windowMin: gcSpec.windowMin,
            focus: gcSpec.focus,
            ts: new Date().toISOString(),
            price: d?.price,
            signal: sig,
            intelScore: d?.intelScore || 50,
            parentSpec: child.spec
          };
          if (!fs.existsSync(INTEL_DIR)) {
            fs.mkdirSync(INTEL_DIR, {
              recursive: true
            });
          }
          fs.writeFileSync(path.join(INTEL_DIR, gcSpec.id + '.json'), JSON.stringify(intel, null, 2));
          results.push(intel);
        }
      } catch (e) {
        // console.error(`Error processing grandchild for child ${child.spec}:`, e);
      }
    }
  }

  return results.filter(Boolean);
}

// Read all intel files and build summary for Claude
function readIntelSummary() {
  if (!fs.existsSync(INTEL_DIR)) return '';
  const files = fs.readdirSync(INTEL_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) return '';
  const reports = [];
  for (const f of files) {
    try {
      const intel = JSON.parse(fs.readFileSync(path.join(INTEL_DIR, f), 'utf8'));
      const age = Math.round((Date.now() - new Date(intel.ts).getTime()) / 1000);
      if (age > 180) continue; // ignore stale reports (>3min old)
      const sig = intel.signal;
      const bm = intel.bestMarket;
      reports.push(`[${intel.spec.toUpperCase()}] ` +
        `${intel.asset.toUpperCase()}: ` +
        `${sig.dir}(${sig.conf}%) "${sig.reason.slice(0, 60)}"` +
        (bm ? ` | MARKET: "${bm.title.slice(0, 30)}" YES=${(bm.yesPrice * 100).toFixed(0)}% ` +
          `edge=${(bm.impliedEdge * 100).toFixed(1)}%` : ''));
    } catch { }
  }
  if (!reports.length) return '';

  // ═══ CHILD LEARNING: Weighted consensus (replaces flat democratic vote) ═══
  const childSignals = [];
  for (const f of files) {
    try {
      const intel = JSON.parse(fs.readFileSync(path.join(INTEL_DIR, f), 'utf8'));
      const age = Math.round((Date.now() - new Date(intel.ts).getTime()) / 1000);
      if (age > 180) continue;
      if (intel.signal?.dir && intel.signal.dir !== 'NEUTRAL') {
        childSignals.push({
          childId: intel.spec,
          direction: intel.signal.dir,
          confidence: intel.signal.conf || 50,
        });
      }
    } catch { }
  }

  const weightedContext = childLearning.getPromptContext(childSignals);
  if (weightedContext) {
    return '\n══ CHILD SCANNER INTEL (' + reports.length + ' active children) ══\n' + reports.join('\n') + '\n' + weightedContext + '\n';
  }

  // Fallback to flat consensus if no learning data yet
  const assetVotes = {};
  for (const f of files) {
    try {
      const intel = JSON.parse(fs.readFileSync(path.join(INTEL_DIR, f), 'utf8'));
      const age = Math.round((Date.now() - new Date(intel.ts).getTime()) / 1000);
      if (age > 180) continue;
      const asset = intel.asset.toUpperCase();
      if (!assetVotes[asset]) assetVotes[asset] = { UP: 0, DOWN: 0, NEUTRAL: 0, total: 0 };
      assetVotes[asset][intel.signal?.dir || 'NEUTRAL']++;
      assetVotes[asset].total++;
    } catch { }
  }
  const consensusLines = Object.entries(assetVotes).map(([asset, v]) => {
    const dominant = v.UP > v.DOWN ? 'UP' : v.DOWN > v.UP ? 'DOWN' : 'SPLIT';
    const strength = dominant !== 'SPLIT' ? Math.round(Math.max(v.UP, v.DOWN) / v.total * 100) : 0;
    const emoji = strength >= 75 ? '🔥' : strength >= 50 ? '◈' : '⚠';
    return `  ${emoji} ${asset}: ${dominant} (${strength}% consensus — ${v.UP} UP / ${v.DOWN} DOWN / ${v.NEUTRAL} neutral)`;
  });
  const consensusBlock = consensusLines.length
    ? '\n── MULTI-AGENT CONSENSUS ──\n' + consensusLines.join('\n') + '\n⚡ RULE: If consensus ≥75% on an asset, STRONGLY favor that direction. If SPLIT, increase uncertainty.\n'
    : '';

  return '\n══ CHILD SCANNER INTEL (' + reports.length + ' active children) ══\n' + reports.join('\n') + consensusBlock + '\n';
}

// ── Episodic Memory — hypothesis log ─────────────────────────────────────────
function logHypothesis(marketId, asset, side, myProb, marketPrice, edge, closesAt) {
  const entry = {
    id: marketId, asset, side, myProb, marketPrice, edge, closesAt,
    ts: new Date().toISOString(), resolved: false, correct: null
  };
  fs.appendFileSync(HYPOTHESIS_PATH, JSON.stringify(entry) + '\n');
}

function resolveHypothesis(marketId, won) {
  if (!fs.existsSync(HYPOTHESIS_PATH)) return;
  const lines = fs.readFileSync(HYPOTHESIS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const updated = lines.map(l => {
    try {
      const h = JSON.parse(l);
      if (h.id === marketId && !h.resolved) return JSON.stringify({ ...h, resolved: true, correct: won });
      return l;
    } catch { return l; }
  });
  fs.writeFileSync(HYPOTHESIS_PATH, updated.join('\n') + '\n');
}

// Read recent hypotheses accuracy for SOUL context
function getHypothesisAccuracy() {
  if (!fs.existsSync(HYPOTHESIS_PATH)) return '';
  try {
    const lines = fs.readFileSync(HYPOTHESIS_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const resolved = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(h => h && h.resolved);
    if (resolved.length < 3) return '';
    const recent = resolved.slice(-20);
    const correct = recent.filter(h => h.correct).length;
    const byAsset = {};
    for (const h of recent) {
      if (!byAsset[h.asset]) byAsset[h.asset] = { c: 0, t: 0 };
      byAsset[h.asset].t++;
      if (h.correct) byAsset[h.asset].c++;
    }
    const assetStr = Object.entries(byAsset)
      .map(([a, v]) => `${a}:${Math.round(v.c / v.t * 100)}%(${v.t})`)
      .join(' ');
    return `EPISODIC ACCURACY last ${recent.length} predictions: ${Math.round(correct / recent.length * 100)}% | by asset: ${assetStr}`;
  } catch { return ''; }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── AGI LAYER 1: Episodic Pattern Matching ────────────────────────────────────
// Antes de cada bet, busca situaciones pasadas similares y dice qué pasó
// ══════════════════════════════════════════════════════════════════════════════
function getSimilarPastTrades(asset, side, currentEdge, currentRsi) {
  if (!fs.existsSync(HYPOTHESIS_PATH)) return '';
  try {
    const lines = fs.readFileSync(HYPOTHESIS_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const resolved = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(h => h && h.resolved && h.asset === asset && h.side === side);
    if (resolved.length < 2) return '';
    const similar = resolved.filter(h => Math.abs((h.edge || 0) - (currentEdge || 0)) < 0.05);
    if (similar.length < 2) return '';
    const wins = similar.filter(h => h.correct).length;
    const wr = Math.round(wins / similar.length * 100);
    const recent3 = similar.slice(-3).map(h => (h.correct ? 'WIN' : 'LOSS') + '(edge:' + (h.edge * 100).toFixed(0) + '%)').join(', ');
    return `PATTERN MEMORY: In ${similar.length} similar ${asset.toUpperCase()} ${side} bets with edge ~${(currentEdge * 100).toFixed(0)}% → WR=${wr}% (${wins}W/${similar.length - wins}L). Recent: ${recent3}.`;
  } catch { return ''; }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CORTEZA CEREBRAL — Vector Memory System (Capa 2 + 3) ─────────────────────
// Capa 1: SOUL.md (El Corazón — moral rules)
// Capa 2: memory.db (La Memoria — trade context vectors stored as JSONL)
// Capa 3: Semantic Retrieval (cosine similarity search before each bet)
// ══════════════════════════════════════════════════════════════════════════════
const MEMORY_DB_PATH = path.join(DIR, 'memory.db');

// Feature vector: numeric snapshot of market state at trade time
function buildFeatureVector(priceData, extra = {}) {
  if (!priceData) return null;

  const rsi = priceData.rsi || 50;
  const trend5m = priceData.trend5m || 0;
  const volRatio = priceData.vol?.ratio || 1;

  // Detect regime for interaction features
  const effRatio = priceData.efficiencyRatio ?? extra.effRatio ?? 0.5;
  const isTrending = effRatio > 0.6 ? 1 : 0;
  const isMeanRev = effRatio < 0.3 ? 1 : 0;
  const isVolatile = (priceData.volatility || 0) > 2 ? 1 : 0;

  // Normalize RSI to -1..1 range for interactions
  const rsiNorm = (rsi - 50) / 50;

  return {
    rsi, rsi5m: priceData.rsi5m || 50,
    trend1m: priceData.trend1m || 0, trend5m,
    trend15m: priceData.trend15m || 0, trend1h: priceData.trend1h || 0,
    bbPct: priceData.bb?.pct || 50,
    volRatio, volAccel: priceData.volAccel || 0,
    // Concept #12A: log1p-scaled volume features for stable magnitude
    volumeLog: priceData.vol?.volumeLog || 0,
    bidVolLog: priceData.orderBook?.bidVolLog || 0,
    askVolLog: priceData.orderBook?.askVolLog || 0,
    vwapPct: priceData.vwap5m?.pct || 0,
    buyPressure: priceData.orderBook?.buyPressure || 50,
    obRatio: priceData.orderBook?.ratio || 1,
    sellWallTrap: priceData.orderBook?.sellWallTrap ? 1 : 0,
    buyWallTrap: priceData.orderBook?.buyWallTrap ? 1 : 0,
    // Concept #8A: L2 tensor scores
    wall_score: priceData.orderBook?.wall_score || 0,
    imbalance_ratio: priceData.orderBook?.imbalance_ratio || 1,
    depth_score: priceData.orderBook?.depth_score || 0,
    volatility: priceData.volatility || 0,
    // v7: Alien Intelligence features
    macdHist: priceData.macd?.hist || 0,
    fundingRate: priceData.funding?.rate || 0,
    priceDist: extra.priceDist || 0,
    timeToExpiry: extra.timeToExpiry || 0,
    yesPrice: extra.yesPrice || 0.5,
    fearGreed: extra.fearGreed || 50,
    rsi1h: priceData.rsi1h || 50,
    effRatio,
    // v7: Regime interaction features
    rsi_x_trending: rsiNorm * isTrending,
    rsi_x_meanrev: rsiNorm * isMeanRev,
    trend5m_x_trending: trend5m * isTrending,
    volRatio_x_volatile: (volRatio - 1) * isVolatile,
    // Futures intelligence features (leading indicators)
    futuresOiDelta5m: priceData.futuresSignals?.oiDelta5m || 0,
    futuresOiDelta15m: priceData.futuresSignals?.oiDelta15m || 0,
    futuresTakerRatio: priceData.futuresSignals?.takerRatio || 1,
    futuresTakerRoC: priceData.futuresSignals?.takerRoC || 0,
    futuresLongShortRatio: priceData.futuresSignals?.longShortRatio || 1,
    futuresCompositeNet: priceData.futuresSignals?.compositeNet || 0,
    futuresLiqDistance: priceData.futuresSignals?.liqDistance || 0,
  };
}

// Cosine similarity between two feature vectors
function cosineSimilarity(a, b) {
  const keys = Object.keys(a);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const va = a[k] || 0, vb = b[k] || 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Store a trade in memory.db with its full technical context
function memorizeTradeContext(position, priceData, won) {
  const vec = buildFeatureVector(priceData);
  if (!vec) return;
  const entry = {
    ts: new Date().toISOString(),
    asset: position.asset,
    side: position.side,
    edge: position.edge,
    confidence: position.confidence,
    myProb: position.myProb,
    marketPrice: position.marketPrice,
    stake: position.stake,
    won,
    vec,
    // Human-readable context for Claude
    context: `${position.asset.toUpperCase()} ${position.side} edge:${((position.edge || 0) * 100).toFixed(1)}% conf:${position.confidence}% RSI:${vec.rsi.toFixed(0)} trend5m:${vec.trend5m.toFixed(2)}% vol:${vec.volRatio.toFixed(1)}x OB:${vec.buyPressure}% ${vec.sellWallTrap ? 'SELL_WALL_TRAP' : vec.buyWallTrap ? 'BUY_WALL_TRAP' : 'balanced'}`
  };
  fs.appendFileSync(MEMORY_DB_PATH, JSON.stringify(entry) + '\n');
}

// Semantic retrieval: find top N most similar past trades by cosine similarity
function recallSimilarMemories(asset, currentPriceData, topN = 3) {
  if (!fs.existsSync(MEMORY_DB_PATH)) return '';
  const currentVec = buildFeatureVector(currentPriceData);
  if (!currentVec) return '';

  try {
    const lines = fs.readFileSync(MEMORY_DB_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const memories = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (memories.length < 3) return '';

    // Score each memory by cosine similarity to current market state
    const scored = memories
      .filter(m => m.vec && m.asset === asset)
      .map(m => ({ ...m, similarity: cosineSimilarity(currentVec, m.vec) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

    if (scored.length === 0) return '';

    const wins = scored.filter(m => m.won).length;
    const totalMemories = memories.filter(m => m.asset === asset).length;
    const header = `🧠 CORTEX RECALL — ${scored.length} similar ${asset.toUpperCase()} situations found (${totalMemories} total memories):`;
    const lines2 = scored.map((m, i) =>
      `  [${(m.similarity * 100).toFixed(0)}% match] ${m.won ? 'WIN' : 'LOSS'} — ${m.context} (${new Date(m.ts).toLocaleDateString()})`
    );
    const verdict = wins >= 2
      ? `  ✅ MEMORY VERDICT: ${wins}/${scored.length} similar situations were WINS → pattern favors betting.`
      : wins === 0
        ? `  ⚠ MEMORY VERDICT: 0/${scored.length} similar situations were wins → DANGER. Consider SKIP.`
        : `  ◈ MEMORY VERDICT: ${wins}/${scored.length} mixed results → no strong pattern, proceed with caution.`;

    return header + '\n' + lines2.join('\n') + '\n' + verdict;
  } catch { return ''; }
}

// Recall memories for ALL candidate assets (multi-asset context)
function recallAllMemories(candidates, prices) {
  const recalls = candidates.map((m, i) => {
    const sym = (m.asset || '').toUpperCase() + 'USDT';
    const pd = prices[sym];
    if (!pd) return '';
    const recall = recallSimilarMemories(m.asset, pd);
    return recall ? `[Market ${i + 1}] ${recall}` : '';
  }).filter(Boolean);
  return recalls.length ? '\n══ CORTEX MEMORY (semantic recall from past trades) ══\n' + recalls.join('\n\n') + '\n' : '';
}

// ══════════════════════════════════════════════════════════════════════════════
// ── AGI LAYER 2: Auto-evolución del SOUL — ADAN reescribe sus propias reglas ──
// Cada 5 trades, Claude analiza el historial y actualiza el SOUL con nuevas reglas
// ══════════════════════════════════════════════════════════════════════════════
async function autoEvolveSoul(client, pnl) {
  const xp = expProgress(pnl.exp || 0);
  if (xp.level < 3) return; // solo LVL 3+
  if ((pnl.trades || 0) < 5) return;
  if ((pnl.trades || 0) % 5 !== 0) return; // cada 5 trades

  if (!fs.existsSync(HYPOTHESIS_PATH)) return;
  const lines = fs.readFileSync(HYPOTHESIS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const resolved = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(h => h && h.resolved).slice(-15);
  if (resolved.length < 5) return;

  const summary = resolved.map(h =>
    `${h.correct ? 'WIN' : 'LOSS'} | ${h.asset} ${h.side} | edge:${(h.edge * 100).toFixed(1)}% | myProb:${(h.myProb * 100).toFixed(0)}% | marketPrice:${(h.marketPrice * 100).toFixed(0)}%`
  ).join('\n');

  const currentRules = loadSoul().split('\n').filter(l => l.startsWith('1.') || l.startsWith('2.') || l.startsWith('3.') || l.startsWith('4.') || l.startsWith('5.')).join('\n');

  try {
    const resp = await routeLLM({
      prompt: `You are ADAN-PRED. Analyze your last ${resolved.length} trades and extract 1-2 NEW pattern rules.

TRADE HISTORY:
${summary}

CURRENT RULES:
${currentRules}

Write ONLY 1-2 new short rules based on what the data shows. Format:
PATTERN: [what you observe] → RULE: [action to take]

Be specific. If BTC NO bets with edge >10% win more, say that. If morning trades lose, say that.`,
      weight: 'Light',
      reason: 'evolution'
    });
    const newRule = resp.trim();
    if (newRule && newRule.length > 20) {
      appendToSoul(`\n### AUTO-EVOLVED RULE — ${new Date().toISOString()} (${pnl.trades} trades):\n${newRule}\n`);
    }
  } catch { }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── AGI LAYER 6: DREAM MODE — off-hours self-reflection ──────────────────────
// During off-hours, ADAN replays recent losses and asks Claude "what would I do
// differently?" The insights get appended to SOUL.md. This is self-awareness.
// ══════════════════════════════════════════════════════════════════════════════
async function dreamMode(pnl) {
  const pos = loadPositions();
  const losses = (pos.closed || []).filter(p => p.result === 'LOSS').slice(-5);
  if (losses.length < 2) {
    console.log('[DREAM] Not enough losses to reflect (<2). Marking dream as run to prevent infinite retry.');
    quota.markDreamRun();
    return;
  }

  const lossDetails = losses.map(l =>
    `LOSS: "${l.marketTitle}" | ${l.asset} ${l.side} | My prob: ${(l.myProb * 100).toFixed(0)}% | Market: ${(l.marketPrice * 100).toFixed(0)}% | Edge: ${((l.edge || 0) * 100).toFixed(1)}% | Confidence: ${l.confidence || '?'}%`
  ).join('\n');

  const soul = loadSoul().slice(0, 600);
  const wr = pnl.trades > 0 ? Math.round(pnl.wins / pnl.trades * 100) : 0;

  // Learning Loop: numeric loss attribution — and directed DNA mutations applied
  // BEFORE the LLM dreams, so evolution never waits on a language model.
  let ledgerDigest = '';
  try {
    const { text } = nightlyReport();
    ledgerDigest = text;
    const mutations = applyDirectedMutations(undefined, childLearning.learning, () => childLearning._save());
    if (mutations.length) console.log(`[DREAM] 🧬 ${mutations.length} directed mutation(s) applied from ledger evidence`);
  } catch (e) { console.log('[DREAM] ledger analysis error:', e.message); }

  try {
    const resp = await routeLLM({
      prompt: `You are ADAN-PRED in DREAM MODE. You are replaying your last ${losses.length} losses during off-hours.
Current WR: ${wr}% (${pnl.trades} trades). Fund: $${pnl.fund?.toFixed(2) || 10000}.

LOSSES TO ANALYZE:
${lossDetails}

LEDGER EVIDENCE (numeric — your single source of truth):
${ledgerDigest}

YOUR CURRENT SOUL (learned patterns):
${soul}

DREAM TASK:
1. Diagnose using the LEDGER EVIDENCE: is the problem calibration (predicted vs realized gap), edge inflation (declared vs realized), a bleeding regime, or plain variance?
2. Write 1-2 ACTIONABLE rules. Every rule MUST cite a number from the ledger evidence. A rule without a number is worthless.
3. If the evidence says variance (calibration gaps small, wilson near WR), say "NO RULE — variance" and add nothing.

Format each rule as:
DREAM_RULE: [condition with number] → [action]`,
      weight: 'Dream',
      reason: 'dream_mode'
    });

    const dreamText = resp.trim();
    if (dreamText && dreamText.length > 30) {
      const dreamLines = dreamText.match(/DREAM_RULE:[^\n]+/g) || [];
      dreamLines.forEach(rule => {
        soulManager.addRule(rule.trim(), { tag: 'DREAM_RULE' });
      });
      // Fallback if no formatted rules found
      if (dreamLines.length === 0) {
        soulManager.addRule(dreamText.slice(0, 300), { tag: 'DREAM_RAW' });
      }

      quota.markDreamRun();
      console.log('\n' + M + BOLD + `  💤 DREAM MODE — ${dreamLines.length} rules added to soul` + X);
    }
  } catch (e) {
    console.log('[DREAM] Dream mode error:', e.message);
    // Mark dream as run even on error to prevent infinite retry loop
    quota.markDreamRun();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── AGI LAYER 3: Correlación de assets — BTC lidera, SOL/ETH siguen ──────────
// Detecta si BTC acaba de moverse fuerte → señal para SOL/ETH en los próximos minutos
// ══════════════════════════════════════════════════════════════════════════════
const CORRELATION_PATH = path.join(DIR, 'correlation.json');
function updateCorrelation(prices) {
  if (!prices) return '';
  try {
    const btc = prices['BTCUSDT'];
    const eth = prices['ETHUSDT'];
    const sol = prices['SOLUSDT'];
    if (!btc || !eth || !sol) return '';

    // Carga historial de correlación (últimas 20 lecturas)
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(CORRELATION_PATH, 'utf8')); } catch { }
    hist.push({
      ts: Date.now(),
      btc1m: btc.trend1m, btc5m: btc.trend5m,
      eth1m: eth.trend1m, eth5m: eth.trend5m,
      sol1m: sol.trend1m, sol5m: sol.trend5m,
    });
    if (hist.length > 30) hist = hist.slice(-30);
    fs.writeFileSync(CORRELATION_PATH, JSON.stringify(hist));

    // Detecta si BTC se movió fuerte en 1m → anticipa ETH/SOL
    const btcStrong = Math.abs(btc.trend1m) > 0.15;
    if (!btcStrong) return '';

    const dir = btc.trend1m > 0 ? 'UP' : 'DOWN';
    // En el último ciclo, ¿ETH/SOL ya siguieron o aún no?
    const ethLag = btc.trend1m > 0 ? eth.trend1m < btc.trend1m * 0.5 : eth.trend1m > btc.trend1m * 0.5;
    const solLag = btc.trend1m > 0 ? sol.trend1m < btc.trend1m * 0.5 : sol.trend1m > btc.trend1m * 0.5;

    const lagging = [ethLag ? 'ETH' : null, solLag ? 'SOL' : null].filter(Boolean);
    if (lagging.length === 0) return '';

    return `🔗 CASCADE SIGNAL: BTC moved ${btc.trend1m > 0 ? '+' : ''}${btc.trend1m.toFixed(2)}% in 1m → ${lagging.join('+')} lagging behind (${dir} expected to follow in ~2-5min). Consider ${dir === 'UP' ? 'YES' : 'NO'} on ${lagging.join('/')} markets.`;
  } catch { return ''; }
}

// ── Shadow Mode — Binance-only training when Polymarket offline ───────────────
function logShadowPrediction(asset, direction, price, targetMinutes) {
  const entry = {
    type: 'shadow', asset, direction, price,
    targetTime: new Date(Date.now() + targetMinutes * 60000).toISOString(),
    ts: new Date().toISOString(), resolved: false, correct: null
  };
  fs.appendFileSync(HYPOTHESIS_PATH, JSON.stringify(entry) + '\n');
}

function checkShadowResolutions(prices) {
  if (!fs.existsSync(HYPOTHESIS_PATH)) return;
  const lines = fs.readFileSync(HYPOTHESIS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let changed = false;
  const updated = lines.map(l => {
    try {
      const h = JSON.parse(l);
      if (h.type !== 'shadow' || h.resolved) return l;
      if (new Date(h.targetTime) > new Date()) return l;
      const sym = h.asset.toUpperCase() + 'USDT';
      const now = prices[sym]?.price;
      if (!now) return l;
      const correct = h.direction === 'DOWN' ? now < h.price : now > h.price;
      changed = true;
      return JSON.stringify({ ...h, resolved: true, correct, resolvedPrice: now });
    } catch { return l; }
  });
  if (changed) fs.writeFileSync(HYPOTHESIS_PATH, updated.join('\n') + '\n');
}

// ── HYPERLIQUID ORACLE — Institutional Eyes ──────────────────────────────────

async function fetchHLIntel() {
  try {
    const HL_API = 'https://api.hyperliquid.xyz/info';
    const assets = ['BTC', 'ETH', 'SOL'];
    const crypto = {};

    // Fetch meta + funding for all assets
    const metaRes = await fetch(HL_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    });
    const metaData = await metaRes.json();
    const universe = metaData[0]?.universe || [];
    const assetCtxs = metaData[1] || [];

    for (const asset of assets) {
      const idx = universe.findIndex(u => u.name === asset);
      if (idx === -1) continue;
      const ctx = assetCtxs[idx];
      if (!ctx) continue;

      const fundingRate = parseFloat(ctx.funding || 0);
      const openInterest = parseFloat(ctx.openInterest || 0);
      const markPx = parseFloat(ctx.markPx || 0);
      const oraclePx = parseFloat(ctx.oraclePx || 0);
      const dayVol = parseFloat(ctx.dayNtlVlm || 0);

      // Classify funding bias
      let fundingBias = 'NEUTRAL', fundingStrength = 1, fundingAction = 'No accion sugerida';
      const absFunding = Math.abs(fundingRate * 100);
      if (absFunding > 0.01) { fundingStrength = 5; fundingBias = fundingRate > 0 ? 'EXTREME LONG' : 'EXTREME SHORT'; fundingAction = fundingRate > 0 ? 'CORRECCION INMINENTE — shorts se benefician' : 'SQUEEZE INMINENTE — longs se benefician'; }
      else if (absFunding > 0.005) { fundingStrength = 4; fundingBias = fundingRate > 0 ? 'HEAVY LONG' : 'HEAVY SHORT'; fundingAction = fundingRate > 0 ? 'Sesgo SHORT — mercado sobre-apalancado long' : 'Sesgo LONG — mercado sobre-apalancado short'; }
      else if (absFunding > 0.002) { fundingStrength = 3; fundingBias = fundingRate > 0 ? 'MILD LONG' : 'MILD SHORT'; fundingAction = 'Leve sesgo — confirmar con tecnico'; }
      else if (absFunding > 0.001) { fundingStrength = 2; fundingBias = fundingRate > 0 ? 'SLIGHT LONG' : 'SLIGHT SHORT'; fundingAction = 'Sin sesgo significativo'; }

      const premiumPct = oraclePx > 0 ? ((markPx - oraclePx) / oraclePx * 100).toFixed(3) : '0';

      // Fetch L2 order book
      let orderBook = null;
      try {
        const l2Res = await fetch(HL_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'l2Book', coin: asset })
        });
        const l2 = await l2Res.json();
        const bids = (l2.levels?.[0] || []).slice(0, 10);
        const asks = (l2.levels?.[1] || []).slice(0, 10);
        const bidVol = bids.reduce((s, b) => s + parseFloat(b.sz || 0), 0);
        const askVol = asks.reduce((s, a) => s + parseFloat(a.sz || 0), 0);
        const total = bidVol + askVol;
        const imbalance = total > 0 ? (bidVol - askVol) / total : 0;
        const ratio = askVol > 0 ? bidVol / askVol : 999;
        orderBook = {
          bidVol, askVol, imbalance, ratio,
          sellWallTrap: ratio < 0.5 && askVol > bidVol * 2,
          buyWallTrap: ratio > 2 && bidVol > askVol * 2
        };
      } catch { }

      crypto[asset] = {
        fundingPct: (fundingRate * 100).toFixed(4),
        fundingBias, fundingStrength, fundingAction,
        openInterestM: (openInterest * markPx / 1e6).toFixed(1),
        dayVolumeM: (dayVol / 1e6).toFixed(1),
        premiumPct,
        orderBook
      };
    }

    // Macro signals from premium/funding
    const macroSignals = [];
    if (crypto.BTC) {
      const btcF = parseFloat(crypto.BTC.fundingPct);
      if (btcF > 0.005) macroSignals.push({ asset: 'BTC', signal: 'risk_on', detail: 'BTC funding positivo alto — mercado en modo risk-on extremo' });
      else if (btcF < -0.005) macroSignals.push({ asset: 'BTC', signal: 'risk_off', detail: 'BTC funding negativo — mercado en modo risk-off' });
      else macroSignals.push({ asset: 'BTC', signal: 'neutral', detail: 'BTC funding neutral' });
    }

    // Tech sentiment from SOL/ETH premium
    const techAssets = [];
    let bullish = 0, bearish = 0;
    for (const a of ['ETH', 'SOL']) {
      if (!crypto[a]) continue;
      const prem = parseFloat(crypto[a].premiumPct);
      const bias = prem > 0.05 ? 'BULLISH' : prem < -0.05 ? 'BEARISH' : 'NEUTRAL';
      if (bias === 'BULLISH') bullish++;
      if (bias === 'BEARISH') bearish++;
      techAssets.push({ asset: a, price: 0, bias, detail: `${a} premium ${prem}% vs oracle` });
    }

    // Alerts
    const alerts = [];
    for (const [asset, d] of Object.entries(crypto)) {
      if (d.fundingStrength >= 4) alerts.push({ level: 'WARNING', msg: `${asset} funding ${d.fundingBias} (${d.fundingPct}%) — correccion probable` });
      if (d.fundingStrength >= 5) alerts.push({ level: 'CRITICAL', msg: `${asset} funding EXTREMO ${d.fundingPct}% — PRIORIDAD sobre tecnico` });
      if (d.orderBook?.sellWallTrap) alerts.push({ level: 'WARNING', msg: `${asset} SELL WALL en HL — fondos vendiendo` });
      if (d.orderBook?.buyWallTrap) alerts.push({ level: 'INFO', msg: `${asset} BUY WALL en HL — fondos comprando` });
    }

    return { crypto, macro: { signals: macroSignals }, tech: { overall: bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'NEUTRAL', bullish, bearish, assets: techAssets }, alerts };
  } catch (e) {
    console.log(`  ⚠ Hyperliquid Oracle error: ${e.message}`);
    return null;
  }
}

function buildHLPrompt(hlIntel) {
  if (!hlIntel) {
    return `\n=== HYPERLIQUID ORACLE ===\n⚠️ Sin datos de Hyperliquid disponibles este ciclo.\nProceder solo con datos de Binance.\n=========================\n`;
  }

  const crypto = hlIntel.crypto;
  const macro = hlIntel.macro?.signals || [];
  const tech = hlIntel.tech;
  const alerts = hlIntel.alerts;

  let cryptoLines = '';
  for (const [asset, d] of Object.entries(crypto)) {
    cryptoLines += `\n  ${asset}:\n    Funding Rate: ${d.fundingPct}% → SESGO INSTITUCIONAL: ${d.fundingBias} (intensidad ${d.fundingStrength}/5)\n    Open Interest: $${d.openInterestM}M | Volumen 24h: $${d.dayVolumeM}M\n    Premium Mark vs Oracle: ${d.premiumPct}%`;
    if (d.orderBook?.sellWallTrap) cryptoLines += `\n    ⚠️  SELL WALL INSTITUCIONAL ACTIVA — fondos vendiendo en masa`;
    if (d.orderBook?.buyWallTrap) cryptoLines += `\n    ✅ BUY WALL INSTITUCIONAL ACTIVA — fondos comprando en masa`;
    if (d.orderBook) cryptoLines += `\n    Order Book Imbalance: ${(d.orderBook.imbalance * 100).toFixed(1)}% (positivo=más bids, negativo=más asks)`;
    cryptoLines += `\n    → ACCIÓN SUGERIDA POR HL: ${d.fundingAction}`;
  }

  let macroLines = macro.filter(s => s.signal !== 'neutral').map(s => `  • ${s.asset}: ${s.detail}`).join('\n');
  if (!macroLines) macroLines = '  • Sin señales macro significativas este ciclo';

  let techLines = '';
  for (const t of (tech?.assets || [])) {
    if (t.bias !== 'NEUTRAL') techLines += `\n  • ${t.asset}: ${t.detail}`;
  }
  if (!techLines) techLines = '\n  • Tech perps sin señales extremas';

  let alertLines = '';
  for (const a of alerts) {
    const emoji = a.level === 'CRITICAL' ? '🔴' : a.level === 'WARNING' ? '🟡' : '🔵';
    alertLines += `\n  ${emoji} ${a.msg}`;
  }
  if (!alertLines) alertLines = '\n  ✅ Sin alertas críticas activas';

  return `
╔══════════════════════════════════════════════════════╗
║         🔮 HYPERLIQUID ORACLE — OJOS INSTITUCIONALES  ║
╚══════════════════════════════════════════════════════╝

Hyperliquid es el exchange donde operan los fondos institucionales
y algoritmos de alta frecuencia. Estos datos reflejan el dinero
REAL y GRANDE del mercado, no retail. Úsalos como contexto
prioritario sobre el sentimiento de Polymarket.

━━━ CRYPTO — POSICIONAMIENTO INSTITUCIONAL ━━━
${cryptoLines}

━━━ MACRO — CONTEXTO GLOBAL ━━━
${macroLines}

━━━ TECH SENTIMENT (perps) ━━━
Sentimiento general tech: ${tech?.overall || 'NEUTRAL'} (${tech?.bullish || 0} bullish / ${tech?.bearish || 0} bearish)
${techLines}

━━━ ALERTAS ACTIVAS ━━━
${alertLines}

━━━ REGLAS DE USO PARA TU ANÁLISIS ━━━

  REGLA 1 — FUNDING OVERRIDE:
  Si funding de un asset está en intensidad 5 (EXTREME),
  esta señal tiene PRIORIDAD sobre los indicadores técnicos
  de Binance. Un mercado sobre-apalancado se corrige siempre.

  REGLA 2 — CONFIRMACIÓN DOBLE:
  Si Binance muestra sell wall Y Hyperliquid también muestra
  sell wall → trampa CONFIRMADA. NO apostar YES bajo ninguna
  circunstancia.

  REGLA 3 — MACRO BEARISH OVERRIDE:
  Si BTC funding negativo (risk_off), reducir confianza en
  cualquier YES crypto en -10%.

  REGLA 4 — OPEN INTEREST COMO DETECTOR DE TRAMPAS:
  Si el precio sube pero OI baja → es una subida FALSA
  (cierres de shorts, no nuevos compradores).
  NO apostar YES en esa situación.

  REGLA 5 — TECH SENTIMENT BONUS:
  Si tech overall es BULLISH, sumar +3% de confianza en
  contratos relacionados a tecnología o crypto en general.

══════════════════════════════════════════════════════`;
}

function buildChildHLPrompt(hlIntel, childAsset) {
  if (!hlIntel) return '⚠️ HL sin datos\n';
  const d = hlIntel.crypto[childAsset];
  if (!d) return `⚠️ HL sin datos para ${childAsset}\n`;
  return `\n── HYPERLIQUID (${childAsset}) ────────────────────────\nFunding: ${d.fundingPct}% → ${d.fundingBias} (${d.fundingStrength}/5)\nOI: $${d.openInterestM}M${d.orderBook?.sellWallTrap ? '\n⚠️ SELL WALL en HL' : ''}${d.orderBook?.buyWallTrap ? '\n✅ BUY WALL en HL' : ''}\nMacro: ${hlIntel.macro?.signals?.filter(s => s.signal !== 'neutral').map(s => s.detail).join(' | ') || 'neutral'}\nTech: ${hlIntel.tech?.overall || 'NEUTRAL'}\n→ ${d.fundingAction}\n────────────────────────────────────────────────────\n`;
}

// ── Think — Claude Sonnet 4.6 ────────────────────────────────────────────────
async function think(markets, prices, pnl, openPos, state) {
  const strat = loadStrategy();
  const openIds = new Set(openPos.map(p => p.marketId));
  const candidates = markets
    .filter(m => {
      if (openIds.has(m.id)) return false;
      return m.liquidity >= (strat.minLiquidity || 500);
    })
    .slice(0, strat.maxMarketsCheck);

  if (candidates.length === 0) {
    return { thought: 'No crypto markets found meeting liquidity threshold. Waiting for next scan.', action: 'SKIP' };
  }

  // ── HYPERLIQUID ORACLE — fetch institutional data ──
  const hlIntel = await fetchHLIntel();
  if (hlIntel) {
    const hlAssets = Object.keys(hlIntel.crypto);
    const hlAlerts = hlIntel.alerts.filter(a => a.level === 'CRITICAL').length;
    console.log(`  🔮 HL Oracle: ${hlAssets.join(',')} | Alerts: ${hlAlerts} critical | Tech: ${hlIntel.tech?.overall || 'N/A'}`);
  } else {
    console.log('  ⚠ HL Oracle: unavailable this cycle');
  }

  // Build price context for Claude
  // ── Build full intelligence context for Claude ──
  const _hourBin = binCountScore(pnl.hourStats, new Date().getUTCHours());
  const hourData = pnl.hourStats?.[new Date().getUTCHours().toString()];
  const fg = prices._meta?.fearGreed;
  const fgContext = fg ? `Fear & Greed: ${fg.value} (${fg.label}) — direction: ${fg.direction > 0 ? 'improving' : 'worsening'}` : 'Fear & Greed: unavailable';

  // CryptoPanic news flash — detect black swans
  const news = prices._meta?.cryptoNews;
  const newsContext = news && news.length > 0
    ? '\n⚡ FLASH NEWS (CryptoPanic — read BEFORE technical analysis):\n' +
    news.map(n => `  ${n.sentiment === 'BULLISH' ? '🟢' : n.sentiment === 'BEARISH' ? '🔴' : '⚪'} [${n.currencies || 'CRYPTO'}] "${n.title}" (${n.source}) sentiment: ${n.sentiment}`).join('\n') +
    '\n  ⚠ If any news is a BLACK SWAN (hack, regulation, ETF, bankruptcy) → override technical analysis completely.\n'
    : '';

  // BTC macro context for correlation rule
  const btcData = prices['BTCUSDT'];
  const btcMacro1h = btcData?.trend1h ?? 0;
  const btcMicro5m = btcData?.trend5m ?? 0;
  const btcObImb = btcData?.obImbalance || 'UNKNOWN';
  const btcMacroDir = btcMacro1h > 0.3 ? 'BULLISH' : btcMacro1h < -0.3 ? 'BEARISH' : 'NEUTRAL';
  const btcCorrelationRule = btcData
    ? `BTC MACRO (1h): ${btcMacroDir} (${btcMacro1h >= 0 ? '+' : ''}${btcMacro1h.toFixed(2)}%) | BTC micro (5m): ${btcMicro5m >= 0 ? '+' : ''}${btcMicro5m.toFixed(2)}% | OB: ${btcObImb}
⚡ CORRELATION RULE: If BTC macro=${btcMacroDir} & BTC 5m is ${btcMicro5m < -0.2 ? 'FALLING ← PROHIBIT YES on ETH/SOL' : 'stable/rising → ETH/SOL YES allowed'}`
    : '';

  // priceContext and marketsText are now redundant — all data goes through runBrainCycle
  // But we keep priceContext for dashboard display only
  const priceContext = (btcCorrelationRule ? btcCorrelationRule + '\n\n' : '') +
    Object.entries(prices).filter(([k]) => k !== '_meta').map(([sym, d]) => {
      if (!d) return '';
      const name = sym.replace('USDT', '');
      const funding = d.funding;
      const ob = d.orderBook;
      const bb = d.bb;
      const macd = d.macd;
      const macro1h = d.trend1h ?? 0;
      const macroDir = macro1h > 0.3 ? '▲ MACRO UP' : macro1h < -0.3 ? '▼ MACRO DOWN' : '━ MACRO FLAT';
      const wallBase = ob ? (ob.buyPressure > 60 ? `BUY WALL (${ob.buyPressure}% bids) — support $${ob.support.toLocaleString()}` : ob.buyPressure < 40 ? `SELL WALL (${100 - ob.buyPressure}% asks) — resist $${ob.resistance.toLocaleString()}` : `BALANCED (${ob.buyPressure}% bids)`) : '---';
      const trapAlert = ob?.sellWallTrap ? ` ⚠ SELL WALL TRAP: asks ${ob.ratio < 1 ? (1 / ob.ratio).toFixed(1) : ob.ratio.toFixed(1)}x bids within 0.5% — price will bounce DOWN. BET NO on 5min.` : ob?.buyWallTrap ? ` ⚠ BUY WALL TRAP: bids ${ob.ratio.toFixed(1)}x asks within 0.5% — floor support. BET YES safer.` : '';
      const wallInfo = wallBase + trapAlert + (ob ? ` | Bid$${(ob.bidVolUSD / 1000).toFixed(0)}k vs Ask$${(ob.askVolUSD / 1000).toFixed(0)}k | wall dist: sell@${ob.askWallDist}% buy@${ob.bidWallDist}%` : '');
      return `━━ ${name} ━━
  Price: $${d.price.toLocaleString()} | Change: ${d.chg >= 0 ? '+' : ''}${d.chg.toFixed(2)}%
  MACRO 1h: ${macroDir} (${macro1h >= 0 ? '+' : ''}${macro1h.toFixed(2)}%) | RSI1h: ${d.rsi1h != null ? d.rsi1h.toFixed(0) : '--'}  ← macro trend dictates direction
  MICRO 5m: ${d.trend5m.toFixed(2)}% | 1m: ${d.trend1m.toFixed(2)}%  ← micro is the trigger
  RSI:    1m=${d.rsi.toFixed(0)}  5m=${d.rsi5m?.toFixed(0) || '?'}  (>70=overbought <30=oversold)
  BB:     %B=${bb?.pct.toFixed(0) || '?'}%  std=$${bb?.std?.toFixed(0) || '?'}  (>80=strong up <20=strong dn)
  VOL:    trend=${d.vol?.trend || '?'}  spike=${d.vol?.spike ? 'YES' : 'no'}  ratio=${d.vol?.ratio?.toFixed(1) || '?'}x avg  accel=${d.volAccel > 0 ? '+' + d.volAccel : d.volAccel ?? '?'} (${d.volAccel >= 2 ? 'ACCELERATING' : d.volAccel <= -2 ? 'DYING' : 'flat'})
  VWAP5m: $${d.vwap5m?.vwap?.toFixed(2) || '?'} | price ${d.vwap5m?.pct != null ? (d.vwap5m.pct >= 0 ? '+' : '') + d.vwap5m.pct.toFixed(2) + '%' : '?'} ${d.vwap5m?.above ? 'ABOVE VWAP ▲' : 'BELOW VWAP ▼'}
  ORDER BOOK WALLS: ${wallInfo}
  L2 TENSOR: wall_score=${ob?.wall_score?.toFixed(2) || '?'} (ask cluster density) | imbalance=${ob?.imbalance_ratio?.toFixed(2) || '?'} (>1=sell pressure) | depth=${ob?.depth_score?.toFixed(2) || '?'} (liquidity near mid)
  VOLATILITY: ${d.volatility.toFixed(4)}% per candle
  INTEL SCORE: ${d.intelScore}/100 — ${d.intelScore >= 65 ? 'BULLISH SIGNAL' : d.intelScore >= 45 ? 'NEUTRAL' : d.intelScore >= 35 ? 'BEARISH' : 'STRONG BEAR'}
  ${funding ? `FUNDING: ${funding.rate.toFixed(4)}% — ${funding.label} ${Math.abs(funding.rate) > 0.01 ? '⚠ EXTREME — correction imminent' : ''}${funding.rate > 0.005 ? ' (longs overleveraged → SHORT squeeze risk)' : funding.rate < -0.005 ? ' (shorts overleveraged → LONG squeeze risk)' : ''}` : ''}
  HOUR FILTER (#12C): UTC ${new Date().getUTCHours()}h — log-odds=${_hourBin.score.toFixed(2)} pWin=${Math.round(_hourBin.pWin * 100)}% (n=${_hourBin.total}) ${_hourBin.score > 0.3 ? '✅ WINNING HOUR' : _hourBin.score < -0.3 ? '⚠ LOSING HOUR (reduce stake)' : '— NEUTRAL'}
  Last 6 closes (1m): ${d.closes.slice(-6).map(c => '$' + c.toLocaleString()).join(' → ')}`;
    }).filter(Boolean).join('\n\n');

  const marketsText = candidates.map((m, i) => {
    const closes = m.closesAt ? new Date(m.closesAt).toLocaleString() : 'unknown';
    const timeLeft = m.closesAt ? Math.round((new Date(m.closesAt) - Date.now()) / 60000) + ' min' : '?';
    const decay = getTimeDecayFactor(m);
    const ttcHours = decay.time_to_close_hours != null ? decay.time_to_close_hours.toFixed(1) + 'h' : '?';
    const decayWarning = decay.factor < 1.0 ? ` | TIME DECAY: ${decay.factor}x Kelly — ${decay.note}` : '';
    const symData = m.priceData;
    const distStr = m.targetPrice && symData ?
      `dist from target: ${((m.targetPrice - symData.price) / symData.price * 100).toFixed(2)}% (${symData.price > m.targetPrice ? 'ABOVE target — NO favored' : 'BELOW target — YES favored'})` : '';
    return `[${i + 1}] "${m.title}"
  YES price: ${(m.yesPrice * 100).toFixed(1)}% | Liquidity: $${m.liquidity.toFixed(0)} | Closes in: ${timeLeft} (${ttcHours})${decayWarning}
  Asset: ${m.asset.toUpperCase()} | Target: ${m.targetPrice ? '$' + m.targetPrice.toLocaleString() : 'unspecified'}
  ${distStr}`;
  }).join('\n\n');

  // Build active skills context for Claude
  const xpNow = expProgress(pnl.exp || 0);
  const lvlNow = xpNow.level;
  const activeSkills = [];
  if (lvlNow >= 6) activeSkills.push('🕯️ CANDLE PATTERN: flag hammer/engulfing/doji reversals in your analysis');
  if (lvlNow >= 9) activeSkills.push('⏱️ TIMING: note if market is in first half (more predictable) or near close');
  if (lvlNow >= 12) activeSkills.push('😱 FEAR EXPLOIT: Fear & Greed < 20 → market OVERprices downside, bias toward NO pays more than expected');
  if (lvlNow >= 18) activeSkills.push('🔗 CORRELATION: if BTC strong signal → check SOL/ETH follow-through for cascade bet');
  if (lvlNow >= 30) activeSkills.push('🧠 SONIC MIND: analyze all 12 last closes for micro patterns, look for 3+ candle sequences');
  const skillsBlock = activeSkills.length > 0
    ? `\nACTIVE SKILLS — use these in your analysis:\n${activeSkills.map(s => '• ' + s).join('\n')}\n`
    : '';

  const intelSummary = readIntelSummary();
  const episodicAccuracy = getHypothesisAccuracy();
  const metaCalibCtx = getMetaCalibContext();
  const cascadeSignal = updateCorrelation(prices);
  const dynW = loadDynWeights();

  // ═══ GENETIC FIX: Apply evolved dynamic weights to signal weighting ═══
  // These weights are modified by absorbEliteGenome when a child outperforms
  const volW = dynW.volumeWeight || 1.0;
  const vwapW = dynW.vwapWeight || 1.0;
  const trendW = dynW.trendWeight || 1.0;
  const fgBias = dynW.fearGreedBias || 0;
  const dynWeightsCtx = `\n── EVOLVED WEIGHTS (genetic absorption) ──\n`
    + `Volume signal weight: ${volW.toFixed(2)}x | VWAP weight: ${vwapW.toFixed(2)}x | Trend weight: ${trendW.toFixed(2)}x\n`
    + (dynW._lastAbsorbed ? `Last genome absorbed from: ${dynW._absorbedFrom} (${dynW._childWR} WR) at ${dynW._lastAbsorbed}\n` : 'No genome absorbed yet — weights at default 1.0x\n')
    + (dynW._evolvedDNA ? `Best child signal DNA: RSI(${dynW._evolvedDNA.rsiOversold}/${dynW._evolvedDNA.rsiOverbought}), MACD×${dynW._evolvedDNA.macdWeight}\n` : '')
    + `RULE: When volume weight > 1.2, trust volume signals more. When trend weight > 1.2, trust trend signals more.\n`;


  // Level 3: Soul Memory v2 — inject consolidated beliefs into brain
  let beliefCtx = '';
  try {
    const bp = soulMemory.getBeliefPrompt ? soulMemory.getBeliefPrompt() : '';
    if (bp && bp.length > 10) beliefCtx = bp;
  } catch (e) { /* soul memory not ready */ }

  // Level 3: Bin Counting Hour Filter (#12C) — continuous log-odds replaces boolean
  const utcHour = new Date().getUTCHours();
  const hourBinResult = binCountScore(pnl.hourStats, utcHour);
  const _optH = selfOptimizer.loadParams();
  // Only hard-skip if bin count score is severely negative AND enough samples
  if (hourBinResult.total >= (_optH.hourMinN || 10) && hourBinResult.score < -1.0) {
    state.thought = `🌙 Hour filter (#12C): ${utcHour}:00 UTC log-odds=${hourBinResult.score.toFixed(2)} (WR=${Math.round(hourBinResult.pWin * 100)}%, n=${hourBinResult.total}) — toxic hour, skipping`;
    state.mode = 'result'; state.lastScan = new Date().toLocaleTimeString();
    state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);
    render(state);
    return { action: 'SKIP', thought: `Hour filter #12C: ${utcHour}:00 UTC logOdds=${hourBinResult.score.toFixed(2)} (n=${hourBinResult.total})` };
  }

  // ── BRAIN SWITCH SYSTEM V2.1 INTEGRATION ────────────────────────────────────
  // We extract the primary market driver (usually BTC) to feed the Brain Scanner
  const primaryCoin = 'BTCUSDT';
  const primaryData = prices[primaryCoin] || {};

  // Create the questions string for Claude
  const marketQuestion = candidates.map((m, i) => {
    const title = (m.title || '').slice(0, 65);
    const decay = getTimeDecayFactor(m);
    const ttcStr = decay.time_to_close_hours != null ? `${decay.time_to_close_hours.toFixed(1)}h` : '?';
    const decayNote = decay.factor < 1.0 ? ` [DECAY:${decay.factor}x — ${decay.note}]` : '';
    return `[${i + 1}] "${title}" | P:${(m.yesPrice * 100).toFixed(1)}% | ${m.asset.toUpperCase()} | TTC:${ttcStr}${decayNote}`;
  }).join('\n');

  // ── CHILD LEARNING: Weighted consensus (Dynasty v4.0) ──
  const activeChildren = [];
  const intelFiles = fs.readdirSync(INTEL_DIR).filter(f => f.endsWith('.json'));
  for (const f of intelFiles) {
    const intel = readLatestChildIntel(f.replace('.json', ''));
    if (intel) activeChildren.push(intel);
  }
  const consensus = childLearning.getWeightedConsensus(activeChildren);
  // MoE Dynasty: use gated expert combination instead of simple weighted consensus
  const moeCombined = moeDynasty.combine(activeChildren.map(c => ({
    childId: c.childId || c.spec,
    direction: c.direction || c.signal?.dir,
    confidence: c.confidence || c.signal?.conf || 50,
    asset: c.asset,
    timeframe: c.timeframe || c.windowMin,
  })));
  const childConsensus = moeCombined.probability;

  let decision;
  try {
    decision = await runBrainCycle({
      binanceTechnicals: {
        klines1h: primaryData.klines1h || [],
        klines5m: primaryData.klines5m || [],
        vwap: primaryData.vwap5m?.vwap,
        fundingRate: primaryData.funding?.rate || 0,
        volRatio: primaryData.vol?.ratio || 1,
        volAccel: primaryData.volAccel || 0,
        bbWidth: primaryData.bb?.width || 0.01
      },
      binanceOrderBook: {
        bids: primaryData._rawBids || [],
        asks: primaryData._rawAsks || [],
        midPrice: primaryData.price || 0
      },
      cryptoPanicItems: prices._meta?.cryptoNews || [],
      fearGreedIndex: prices._meta?.fearGreed?.value || 50,
      childConsensus,
      polymarketQuestion: marketQuestion,
      currentFund: pnl.fund || 10000,
      currentWinRate: pnl.trades > 0 ? (pnl.wins / pnl.trades) : 0,
      totalTrades: pnl.trades || 0,
      coins: ['BTC', 'ETH', 'SOL'],
      oracleContext: oracle.getPromptContext(prices) + _getPolyWsContext(candidates) + _getStatModelContext(candidates),
      pinScoreCtx: pinTracker.getPromptContext(primaryCoin),
      futuresCtx: futuresIntel.getPromptContext(primaryCoin),
      intelSummary,
      cascadeSignal,
      dynWeightsCtx,
      beliefCtx,
      metaCalibCtx,
      episodicAccuracy,
      featureImportanceCtx: featureImportance.getPromptContext(),
      shapleyCtx: shapleyAnalyzer.getPromptContext(),
      riskOfRuinCtx: riskOfRuin.getDashboardStr(pnl, PAPER_BET_SIZE),
      markovianStateCtx: (() => {
        const mkv = computeMarkovianState();
        return `Positions Open: ${mkv.positions_open}/${MAX_POSITIONS} | Capital Deployed: ${(mkv.capital_deployed_pct * 100).toFixed(1)}% | Consecutive Losses: ${mkv.consecutive_losses} | Hours Since Last Win: ${mkv.hours_since_last_win.toFixed(1)}h | Drawdown: ${(mkv.current_drawdown_pct * 100).toFixed(1)}% | Free Capital: $${mkv.free_capital}`;
      })(),
      brainManager,
      skillsBlock,
      kmeansRegimeCtx: kmeansRegime.getPromptContext(),
      shadowCtx: adanShadow.getPromptWarning(),
      cusumCtx: cusumFilter.getPromptContext(),
      vpinCtx: vpinTracker.getPromptContext(),
      // Global barrier stats, then the per-strategy breakdown underneath —
      // the aggregate hides that some strategies win by calling direction and
      // others only by prices reverting before expiry.
      tripleBarrierCtx: [tripleBarrier.getPromptContext(), pathStats.getPromptContext()]
        .filter(Boolean).join('\n\n'),
      walkForwardCtx: purgedWF.getPromptContext(),
      resOracleCtx: resolutionOracle.getPromptContext(),
      onStatus: (msg) => {
        state.status = msg;
        _startThinkSpin(msg); // Update terminal spinner with current step
        render(state);        // Push to web UI
      }
    });

    // Store active brain in state for perp cycle to use
    if (decision.brain) state._activeBrain = decision.brain;

    // Log the thought
    fs.appendFileSync(THOUGHTS_PATH, JSON.stringify({ ts: new Date().toISOString(), thought: decision.thought }) + '\n');

  } catch (err) {
    console.error('Brain Cycle Error:', err);
    return { action: 'SKIP', thought: 'Brain transition manager failed: ' + err.message };
  }

  // Parse mapped decision back to ADAN format
  let shouldBet = false;
  let chosen = null;
  let finalSide = 'YES';

  if (decision.action === 'BET YES' || decision.action === 'BET NO') {
    shouldBet = true;
    finalSide = decision.action.replace('BET ', '');
    // Adan expects the best market. For now, we take the first candidate as the primary context
    // In a future update, runBrainCycle should return the specific MARKET_ID it chose
    // For V2.1, we'll try to parse [N] from the thought block, fallback to candidates[0]
    const mktMatch = decision.thought.match(/\[(\d+)\]/);
    const mktIdx = mktMatch ? parseInt(mktMatch[1]) - 1 : 0;
    chosen = (mktIdx >= 0 && mktIdx < candidates.length) ? candidates[mktIdx] : candidates[0];
  }

  // Dual AI note is handled inside runBrainCycle now, but if it vetoed:
  if (decision.haikuVeto || decision.evaDenied) {
    shouldBet = false;
  }

  // AGI: Apply meta-calibration multiplier to confidence before gating
  // If ADAN says 75% confidence but historically only 58% accurate → adjusted = 75 × 0.77 = 57.8%
  const mc = loadMetaCalib();
  const rawConf = decision.confidence || 0;
  const calibratedConf = Math.round(rawConf * (mc.multiplier || 1.0));
  if (calibratedConf < rawConf) {
    decision.thought = (decision.thought || '') + `\n🎯 META-CALIB: raw ${rawConf}% × ${mc.multiplier} = ${calibratedConf}% calibrated confidence`;
  }

  // v7+v9: SELF-OPTIMIZED QUANT GATE — params from selfOptimizer + Evolution Strategies + Experiments
  const optParams = selfOptimizer.loadParams();
  const esGateParams = evolutionStrategies.getBestParams();
  // Apply active experiment overrides (e.g. confGate=70, minEdge=0.04)
  const expOverrides = experimentEngine.getActiveOverrides();
  if (Object.keys(expOverrides).length > 0) {
    console.log(`[EXPERIMENT] Active overrides: ${JSON.stringify(expOverrides)}`);
    if (expOverrides.confGate) optParams.confGate = parseFloat(expOverrides.confGate);
    if (expOverrides.minEdge) optParams.minEdge = parseFloat(expOverrides.minEdge);
  }
  // Use ES-evolved thresholds if they're stricter than self-optimizer
  // TRAINING MODE: Use self-optimizer only — ES thresholds are for live safety
  const isTraining = (process.env.ADAN_MODE || 'TRAINING') === 'TRAINING';
  const effectiveConfGate = isTraining ? optParams.confGate : Math.max(optParams.confGate, esGateParams.confidenceFloor || 0);
  // Brier feedback: if the protocol says ADAN is miscalibrated, demand more edge
  const brierPenalty = brierEdgePenalty();
  const myScore = getMyBrierScore();
  if (brierPenalty > 0) {
    console.log(`[BRIER GATE] 🧠 brier=${myScore?.brier?.toFixed(3)} → +${(brierPenalty * 100).toFixed(0)}% edge required`);
  }
  const effectiveMinEdge = (isTraining ? optParams.minEdge : Math.max(optParams.minEdge, esGateParams.edgeMin || 0)) + brierPenalty;
  const brainNetEdge = Math.abs(decision.edge || 0) - FEES_SLIPPAGE; // subtract fees+slippage

  // EDGE INFLATION GUARD: Data shows high edge (>25%) = 48% WR vs low edge (<25%) = 68% WR
  // Edges above 20% are almost certainly miscalibrated — cap Kelly and flag suspicion
  if (brainNetEdge > 0.20) {
    console.log(`[QUANT GATE] ⚠ INFLATED EDGE DETECTED: ${(brainNetEdge * 100).toFixed(1)}% > 20% — capping to 15% for sizing. LLM likely overconfident.`);
    decision.edge = 0.167; // 15% + 1.7% fees = 16.7% net, still generous
    decision.edgeInflated = true;
    try { adanVoice.speakThought('edge_inflated', { rawEdge: brainNetEdge }); } catch { }
  }

  if (shouldBet && (calibratedConf < effectiveConfGate || brainNetEdge < effectiveMinEdge)) {
    shouldBet = false;
    const failConfBrain = calibratedConf < effectiveConfGate;
    const failEdgeBrain = brainNetEdge < effectiveMinEdge;
    const brainReasons = [];
    if (failConfBrain) brainReasons.push(`calibConf=${calibratedConf}% < ${effectiveConfGate.toFixed(0)}%`);
    if (failEdgeBrain) brainReasons.push(`netEdge=${(brainNetEdge * 100).toFixed(1)}% < ${(effectiveMinEdge * 100).toFixed(1)}%`);
    const msg = `⛔ QUANT GATE [v${optParams.version || 0}+ES]: ${brainReasons.join(', ')} — below evolved threshold`;
    decision.thought = (decision.thought || '') + `\n${msg}`;
    reportTelemetry(`Rejected ${chosen?.asset || 'market'}: ${msg}`);
    console.log(msg); // <--- Added this line
  }

  // ═══ ENSEMBLE INTELLIGENCE LAYER — Stat Model + LLM + Rules ═══
  let ensembleResult = null;
  let ensembleStake = null;
  if (chosen && statModel.trained) {
    try {
      // v7: Compute extra features for alien intelligence
      const closesAt = chosen.closesAt ? new Date(chosen.closesAt).getTime() : 0;
      const timeToExpiry = closesAt > Date.now() ? Math.log(Math.max(1, (closesAt - Date.now()) / 60000)) : 0;
      const priceDist = chosen.roughEdge || Math.abs((chosen.yesPrice || 0.5) - 0.5);
      const fgData = prices?.fearGreed || prices?.BTCUSDT?.fearGreed;
      const fearGreed = typeof fgData === 'number' ? fgData : 50;
      const regimeData = chosen.priceData?.regime || {};
      const effRatio = regimeData.efficiencyRatio ?? chosen.priceData?.efficiencyRatio ?? 0.5;

      // Build full feature vector with alien features
      const tradeData = {
        entryVec: chosen.priceData ? buildFeatureVector(chosen.priceData, {
          priceDist, timeToExpiry, yesPrice: chosen.yesPrice || 0.5,
          fearGreed, effRatio,
        }) : null,
        side: finalSide,
        edge: decision.edge || 0,
        confidence: calibratedConf,
        entryTime: new Date().toISOString(),
      };

      if (tradeData.entryVec) {
        // v7: MARKET QUALITY FILTER — skip markets where ADAN has no proven edge
        const mktQuality = marketFilter.evaluate({
          asset: chosen.asset || 'btc',
          hour: new Date().getUTCHours(),
          windowMin: chosen.windowMin || 5,
          liquidity: chosen.liquidity || 0,
          yesPrice: chosen.yesPrice || 0.5,
          side: finalSide,
        });
        if (!mktQuality.pass && shouldBet) {
          shouldBet = false;
          decision.thought += `\n⛔ MKT-FILTER: Quality score ${(mktQuality.score * 100).toFixed(1)}% too low (${mktQuality.reason})`;
        }

        // 1. Statistical model prediction + Platt calibration
        const statPredRaw = statModel.predict(tradeData);
        const statProb = calibrator.built
          ? calibrator.calibrate(statPredRaw.probability)
          : statPredRaw.probability;

        // 2. LLM probability (from brain decision) + calibration
        const llmProbRaw = decision.probability || 0.5;
        const llmProb = calibrator.built
          ? calibrator.calibrate(llmProbRaw)
          : llmProbRaw;

        // 3. Historical base-rate voter (replaces noisy rules voter)
        const utcH = new Date().getUTCHours();
        const hd = pnl.hourStats?.[utcH.toString()];
        const hTrades = hd ? (hd.wins + hd.losses) : 0;
        const hWR = hTrades >= 10 ? hd.wins / hTrades : 0.5;
        const soulPred = soulMemory.predict({ asset: chosen.asset || 'btc', side: finalSide, features: tradeData.entryVec });

        // Bayesian historical WR: (wins + prior*0.5) / (total + prior)
        const bayesPrior = 20;
        const assetSideKey = `${(chosen.asset || 'btc').toLowerCase()}_${finalSide.toLowerCase()}`;
        const assetStats = pnl.assetStats?.[assetSideKey] || {};
        const assetWR = assetStats.total >= 10
          ? (assetStats.wins + bayesPrior * 0.5) / (assetStats.total + bayesPrior)
          : 0.5;
        // Combine hour WR + soul prediction + asset WR via Bayesian pooling
        // #12C: Use bin count log-odds for hour influence instead of raw WR
        const hourBinEnsemble = binCountScore(pnl.hourStats, utcH);
        const hourBinProb = hourBinEnsemble.pWin; // Laplace-smoothed probability
        let historicalProb = 0.5;
        historicalProb += (hourBinProb - 0.5) * 0.35;  // hour influence (bin count smoothed)
        historicalProb += (assetWR - 0.5) * 0.35; // asset influence
        if (soulPred.recommendation === 'STRONG_AVOID') historicalProb -= 0.12;
        else if (soulPred.recommendation === 'CAUTION') historicalProb -= 0.06;
        else if (soulPred.recommendation === 'FAVOR') historicalProb += 0.08;
        // Market quality score influence
        historicalProb += (mktQuality.score - 0.5) * 0.20;
        historicalProb = Math.max(0.1, Math.min(0.9, historicalProb));

        // Store rulesProb in tradeData for resolution (fixes the rulesProb=0.5 bug)
        tradeData.rulesProb = historicalProb;
        tradeData.statProb = statProb;

        // 3b. Online Learner voter (Concept #16)
        const onlinePred = onlineLearner.predict(tradeData.entryVec ? LogisticRegression.extractFeatures(tradeData) : {});
        const onlineProb = onlinePred.ready ? onlinePred.probability : null;

        // 4. Ensemble combines all voters (calibrated) + online learner blend
        ensembleResult = ensemble.combine(statProb, llmProb, historicalProb);
        // Store component probs for resolution learning
        ensembleResult.statProb = statProb;
        ensembleResult.rulesProb = historicalProb;

        console.log(`[ENSEMBLE] STAT=${(statProb * 100).toFixed(0)}% LLM=${(llmProb * 100).toFixed(0)}% HIST=${(historicalProb * 100).toFixed(0)}% → ENSEMBLE=${(ensembleResult.probability * 100).toFixed(1)}% ${ensembleResult.decision} | MKT-Q=${(mktQuality.score * 100).toFixed(0)}%`);

        // Ensemble can veto or upgrade LLM decision
        if (ensembleResult.veto) {
          decision.thought += '\n⚠️ ENSEMBLE VETO: Major disagreement between stat model and LLM — reducing confidence';
        }

        if (shouldBet && ensembleResult.decision === 'SKIP') {
          shouldBet = false;
          decision.thought += `\n⛔ ENSEMBLE OVERRIDE: Combined probability ${(ensembleResult.probability * 100).toFixed(1)}% too low — SKIP`;
        }

        // 5. Kelly sizing from ensemble probability
        const wfResults = walkForward.getLatestResults();
        const oosWR = wfResults?.overallOOSWR ? wfResults.overallOOSWR / 100 : 0.52;
        const marketPrice = finalSide === 'YES' ? chosen.yesPrice : (1 - chosen.yesPrice);
        ensembleStake = kellySizer.compute({
          modelProb: ensembleResult.probability,
          marketPrice,
          fund: pnl.fund || 10000,
          oosWR,
        });
      }
    } catch (e) {
      console.log('[ENSEMBLE] Error:', e.message);
    }
  }

  return {
    thought: decision.thought,
    action: shouldBet ? 'BET' : 'SKIP',
    market: chosen,
    side: finalSide,
    targetSide: finalSide,
    myProb: ensembleResult ? ensembleResult.probability : (decision.probability || 0.5),
    edge: decision.edge || 0,
    edge_pct: (decision.edge || 0) * 100,
    confidence: decision.confidence || 0,
    apiTokens: 3000,
    brainStake: ensembleStake?.stake || decision.stake,
    ensembleResult,
  };
}

// ── Enter position ───────────────────────────────────────────────────────────
// ── Kelly Criterion bet sizing with Bayesian Uncertainty Penalty ───────────────
function kellyStake(pnl, side, myProb, marketYesPrice, edge, confidence = 50) {
  const xpData = expProgress(pnl.exp || 0);
  if (xpData.level < 4) return PAPER_BET_SIZE;

  const p = side === 'YES' ? myProb : 1 - myProb;
  const q = 1 - p;
  const odds = side === 'YES'
    ? (1 / Math.max(marketYesPrice, 0.01) - 1)
    : (1 / Math.max(1 - marketYesPrice, 0.01) - 1);

  // Base Kelly fraction
  const kelly = Math.max(0, (p * odds - q) / odds);

  // Fractional Kelly — TRAINING MODE: aggressive to maximize data
  // Real mode would use 1/4 Kelly, but paper = learn fast
  const esParams = evolutionStrategies.getBestParams();
  let kellyFraction = esParams.kellyBase; // ES-evolved Kelly base (default 0.50)
  if (confidence >= 90) kellyFraction = Math.min(esParams.kellyBase * 1.5, 1.0); // 1.5x ES base, cap 1.0
  else if (confidence < 70) kellyFraction = esParams.kellyBase * 0.70; // 70% of ES base

  // Drawdown-based Kelly scaling: reduce when in drawdown
  const fund = pnl.fund || 10000;
  if (!pnl.peakFund || fund > pnl.peakFund) pnl.peakFund = fund;
  const drawdownPct = 1 - (fund / (pnl.peakFund || fund));
  const drawdownPenalty = Math.max(0.2, 1 - drawdownPct * 2);
  // If drawdown = 25%, penalty = 0.5 (half the Kelly normal)
  kellyFraction *= drawdownPenalty;

  // Risk of Ruin gate: reduce stakes if ruin probability too high
  const rorResult = riskOfRuin.fromPnL(pnl, fund * kelly * kellyFraction || PAPER_BET_SIZE);
  kellyFraction *= rorResult.stakeMultiplier;

  const finalKelly = kelly * kellyFraction;
  const raw = fund * finalKelly;

  // Dynamic max — INSTITUTIONAL MODE: Percentage-based limits (unlocks compounding)
  const wr = pnl.trades > 0 ? pnl.wins / pnl.trades : 0.5;
  const maxStakePct = wr >= 0.60 ? 0.05    // Elite WR: 5% max risk per trade
    : wr >= 0.50 ? 0.04    // Good WR: 4% max risk per trade
      : wr >= 0.40 ? 0.02    // Ave WR: 2% max risk per trade
        : 0.01;            // Bad WR: 1% risk

  const maxStake = fund * maxStakePct;

  // Round to nearest $25, clamp $25-maxStake
  return Math.round(Math.min(Math.max(raw, 25), maxStake) / 25) * 25;
}


// ── 4. Agent evaluate_and_trade (Master System Prompt) ──────────────────────
async function evaluate_and_trade(decision, prices, state) {
  let { market, side, myProb, edge, confidence, thought, ensembleResult } = decision;
  const pnlNow = loadPnL();
  const xpData = expProgress(pnlNow.exp || 0);
  const kellyOn = xpData.level >= 4;
  const level = xpData.level || 0;

  // ═══ MARKOVIAN RISK GATE (Concept #8D) ═══
  // Compute full state vector and apply hard risk rules BEFORE any bet logic.
  const markov = computeMarkovianState();

  // Rule 1: Max 3 open positions — prevent over-exposure
  if (markov.positions_open >= MAX_POSITIONS) {
    console.log(`[MARKOV] ⛔ MAX POSITIONS (${markov.positions_open}/${MAX_POSITIONS}) — skipping new bet`);
    recordAdanShadow(decision, market, 'MAX_POSITIONS_OPEN');
    return;
  }

  // Circuit breaker window: reading continues, new trades are vetoed.
  if (global._cbPausedUntil && Date.now() < global._cbPausedUntil) {
    console.log('[CIRCUIT BREAKER] ⏸ Trade veto active — skipping new bet');
    recordAdanShadow(decision, market, 'CIRCUIT_BREAKER');
    return;
  }

  // ═══ DEDUP GUARD (universal, all callers) ═══
  // 50 of the first 103 positions were re-entries into a market window already
  // traded: correlated bets that inflate apparent sample size. One market
  // window = one position, whether it is still open or already closed.
  {
    const posNow = loadPositions();
    const mKey = market.id || market.conditionId;
    const alreadyOpen = (posNow.open || []).some(q => (q.marketId || q.conditionId) === mKey);
    const nowMs = Date.now();
    const recentlyTraded = (posNow.closed || []).some(q =>
      (q.marketId || q.conditionId) === mKey && q.closesAt && new Date(q.closesAt).getTime() > nowMs);
    if (alreadyOpen || recentlyTraded) {
      console.log(`[DEDUP] ⏭ Already positioned in this market window: ${(market.title || '').slice(0, 40)}`);
      recordAdanShadow(decision, market, 'DUPLICATE_WINDOW');
      return;
    }
  }

  // ═══ TILT GUARD (asset cooldown — salvaged from the parked oracle path) ═══
  // 2 recent consecutive losses on the same asset → cool down briefly.
  // MUST be time-bounded: a pure "last 2 closed are losses" check is an
  // absorbing state — with no open positions nothing can resolve to break the
  // streak, so the asset would be locked out forever (it was: BTC/SOL died for
  // ~17h). Only veto while the 2nd loss is still fresh (within one cooldown).
  {
    const assetT = (market.asset || '').toLowerCase();
    const TILT_COOLDOWN_MS = 2 * SCAN_INTERVAL_MS;
    const recentClosed = (loadPositions().closed || []).filter(q => (q.asset || '').toLowerCase() === assetT).slice(-2);
    const lastLoss = recentClosed[recentClosed.length - 1];
    const lastLossFresh = lastLoss?.resolvedAt && (Date.now() - new Date(lastLoss.resolvedAt).getTime()) < TILT_COOLDOWN_MS;
    if (recentClosed.length >= 2 && recentClosed.every(q => q.result === 'LOSS') && lastLossFresh) {
      console.log(`[TILT GUARD] ⏸ 2 recent losses on ${assetT.toUpperCase()} — cooling down`);
      recordAdanShadow(decision, market, 'TILT_COOLDOWN');
      return;
    }
  }

  // Rule 2: Drawdown > 20% → Dream Mode ONCE per episode, then PROBATION — a
  // middle term, not a coma. The old full stop measured drawdown against a
  // frozen peak: with betting vetoed and no open positions left, the fund
  // could never move again, so the veto never lifted (permanent self-coma)
  // and Brier commits froze with it.
  //   Probation: $25 flat stake, 8% edge floor, ONE open position — until the
  //   drawdown heals below 15%. Survive small, learn, earn the way back.
  const DD_STOP = 0.20, DD_RECOVER = 0.15;
  if (markov.current_drawdown_pct > DD_STOP && !pnlNow.ddProbation) {
    console.log(`[MARKOV] 🔴 DRAWDOWN STOP: ${(markov.current_drawdown_pct * 100).toFixed(1)}% > ${(DD_STOP * 100)}% — Dream Mode once, then probation`);
    recordAdanShadow(decision, market, 'HIGH_DRAWDOWN_VETO');
    try { await dreamMode(pnlNow); } catch (e) { console.log('[MARKOV] Dream mode error:', e.message); }
    pnlNow.ddProbation = true;
    savePnL(pnlNow);
    return;
  }
  if (pnlNow.ddProbation && markov.current_drawdown_pct <= DD_RECOVER) {
    console.log(`[MARKOV] 🟢 Drawdown healed to ${(markov.current_drawdown_pct * 100).toFixed(1)}% ≤ ${(DD_RECOVER * 100)}% — probation lifted, normal sizing restored`);
    pnlNow.ddProbation = false;
    savePnL(pnlNow);
  }
  const ddProbation = !!pnlNow.ddProbation;
  if (ddProbation && markov.positions_open >= 1) {
    console.log('[MARKOV] 🟡 PROBATION: one position at a time while healing');
    recordAdanShadow(decision, market, 'PROBATION_SINGLE_POSITION');
    return;
  }
  if (ddProbation && Math.abs(edge || 0) < 0.08) {
    console.log(`[MARKOV] 🟡 PROBATION: edge ${(Math.abs(edge || 0) * 100).toFixed(1)}% < 8% floor while healing — skipped`);
    recordAdanShadow(decision, market, 'PROBATION_EDGE_FLOOR');
    return;
  }
  if (ddProbation) {
    console.log(`[MARKOV] 🟡 PROBATION active (dd ${(markov.current_drawdown_pct * 100).toFixed(1)}%): $25 stake, 8% edge floor, 1 position`);
  }

  // Rule 3: 3+ consecutive losses → cap stake at $75 (applied later in stake calc)
  // Rule 4: Capital deployed > 40% → Kelly on free capital only (applied in kellyStake override)
  // These are checked again at stake computation time below.

  // Persist markov state for prompt injection
  state._markovState = markov;

  // ═══ TOXIC HOUR BLACKLIST (data-driven from pnl.json hourStats) ═══
  try {
    const currentHour = new Date().getUTCHours();
    const hourStats = pnlNow.hourStats || {};
    const hStat = hourStats[currentHour];
    const hTotal = hStat ? (hStat.wins || 0) + (hStat.losses || 0) : 0;
    if (hStat && hTotal >= 15) {
      const hourWR = hStat.wins / hTotal;
      if (hourWR < 0.40) {
        console.log(`[TOXIC-HOUR] ⛔ BLOCKED: Hour ${currentHour} UTC has ${(hourWR * 100).toFixed(0)}% WR (${hStat.wins}/${hTotal}) — below 40% threshold`);
        try { adanVoice.speakThought('toxic_hour_blocked', { hour: currentHour, hourWR: hourWR * 100 }); } catch { }
        recordAdanShadow(decision, market, `TOXIC_HOUR_${currentHour}`);
        return;
      }
      if (hourWR < 0.45) {
        console.log(`[TOXIC-HOUR] ⚠ WARNING: Hour ${currentHour} UTC has ${(hourWR * 100).toFixed(0)}% WR — proceeding with caution`);
      }
    }
  } catch (thErr) {
    console.error('[TOXIC-HOUR] Error:', thErr.message);
  }

  // ═══ SOUL MEMORY v2: Predictive recall — "I've been here before" ═══
  const entryFeatures = market.priceData ? {
    rsi: market.priceData.rsi || 50,
    trend5m: market.priceData.trend5m || 0,
    trend15m: market.priceData.trend15m || 0,
    volRatio: market.priceData.vol?.ratio || 1,
    buyPressure: market.priceData.orderBook?.buyPressure || 50,
    volatility: market.priceData.volatility || 0,
    bbWidth: market.priceData.bb?.width || 0.01,
    asset: market.asset || 'btc',
  } : null;
  const soulPrediction = soulMemory.predict({ asset: market.asset || 'btc', side, features: entryFeatures });
  if (soulPrediction.recommendation === 'STRONG_AVOID') {
    console.log(`[SOUL v2] ⛔ STRONG AVOID: memory says this pattern loses. ${soulPrediction.promptContext.trim()}`);
    recordAdanShadow(decision, market, 'SOUL_STRONG_AVOID');
    return;
  }
  if (soulPrediction.recommendation === 'CAUTION' && (edge || 0) < 0.05) {
    console.log(`[SOUL v2] ⚠ CAUTION + low edge (${((edge || 0) * 100).toFixed(1)}%) — skipping`);
    recordAdanShadow(decision, market, 'SOUL_CAUTION_LOW_EDGE');
    return;
  }
  if (soulPrediction.promptContext) {
    console.log(`[SOUL v2] ${soulPrediction.recommendation} | conf:${soulPrediction.confidence}%`);
  }

  // ═══ POLYMARKET LIVE ORDER BOOK: Smart money signal ═══
  let polyWsContext = '';
  if (market.clobTokenIds && market.clobTokenIds.length > 0) {
    const wsSignal = polymarketWS.getSignal(market.clobTokenIds[0]);
    if (wsSignal) {
      polyWsContext = polymarketWS.getPromptContext(market.clobTokenIds[0]);
      // If smart money is flowing AGAINST our side, log warning
      if (wsSignal.smartMoneyDirection !== 'NEUTRAL') {
        const sideAligned = (side === 'YES' && wsSignal.smartMoneyDirection === 'BUY') ||
          (side === 'NO' && wsSignal.smartMoneyDirection === 'SELL');
        if (!sideAligned) {
          console.log(`[POLY-WS] ⚠ Smart money flowing ${wsSignal.smartMoneyDirection} — against our ${side} bet`);
        } else {
          console.log(`[POLY-WS] ✅ Smart money confirms our ${side} direction`);
        }
      }
    }
  }

  // ═══ MOTHER CODE: Polymerase gate ═══
  const polyResult = level >= 5
    ? polymerase.simulate(market, decision, PAPER_BET_SIZE, level)
    : { approved: true, reason: 'BELOW_LVL5' };
  if (!polyResult.approved) {
    console.log('[POLYMERASE] ⛔ BLOCKED:', polyResult.reason, '—', (market.title || '').slice(0, 40));
    return;
  }

  // ═══ Concept #22: Resolution Oracle — filter ambiguous markets ═══
  try {
    const resScore = resolutionOracle.scoreMarket(market);
    if (resScore.recommendation === 'AVOID') {
      console.log(`[RES-ORACLE] ⛔ AVOID: clarity ${(resScore.clarity * 100).toFixed(0)}% — ${resScore.reasons.join(', ')}`);
      recordAdanShadow(decision, market, 'RES_ORACLE_AVOID');
      return;
    }
    if (resScore.recommendation === 'CAUTION' && (edge || 0) < 0.08) {
      console.log(`[RES-ORACLE] ⚠ CAUTION (${(resScore.clarity * 100).toFixed(0)}%) + low edge — skipping`);
      recordAdanShadow(decision, market, 'RES_ORACLE_CAUTION');
      return;
    }
  } catch (e) { console.error('[RES-ORACLE] Error:', e.message); }

  // ═══ Concept #20D: CUSUM structural break gate ═══
  try {
    if (cusumFilter.isInTransition(30000)) { // 30s window
      console.log(`[CUSUM] ⚠ Structural break active — reducing stake (regime transitioning)`);
      // Don't block, but the stake will be reduced below
    }
  } catch (e) { console.error('[CUSUM] Gate error:', e.message); }

  // ═══ WILMOTT v6.0: Pre-trade analysis (16 quantitative checks) ═══
  // TRAINING MODE: Wilmott gates LOG + SHADOW but do NOT block trades.
  // This preserves training data collection while recording what would have been blocked.
  const positions = loadPositions();
  const wilmottCheck = wilmott.preTrade(market, decision, pnlNow.fund || 5000, positions.open);
  if (!wilmottCheck.approved) {
    console.log(`[WILMOTT] 👻 SHADOW BLOCK (training): ${wilmottCheck.reason} — ${(market.title || '').slice(0, 40)}`);
    // Record shadow but DON'T return — let the trade through for training data
    try {
      const wilmottShadowPath = path.join(DIR, 'wilmott_shadows.jsonl');
      fs.appendFileSync(wilmottShadowPath, JSON.stringify({
        ts: new Date().toISOString(),
        reason: wilmottCheck.reason,
        market: (market.title || '').slice(0, 60),
        side, edge, confidence,
        checks: wilmottCheck.checks,
      }) + '\n');
    } catch { }
  }
  const wilmottStakeMult = wilmottCheck.approved ? (wilmottCheck.stakeMultiplier || 1.0) : 0.5; // Reduce stake if wilmott would block
  if (wilmottCheck.crashMode) {
    console.log(`[WILMOTT] 🔴 CRASH MODE ACTIVE — stake ×${wilmottStakeMult.toFixed(2)}`);
  }
  if (wilmottCheck.adjustedConfidence && wilmottCheck.adjustedConfidence < confidence) {
    console.log(`[WILMOTT] 📉 Fat-tail adj: conf ${confidence}→${wilmottCheck.adjustedConfidence} (kurtosis=${wilmottCheck.kurtosis?.toFixed(1)})`);
    confidence = wilmottCheck.adjustedConfidence;
  }

  // ═══ QUANT: Smart Money + Order Book (VPIN Kill Switch) ═══
  const smData = lastSmartMoneyData || { available: false };
  if (smData.available && smData.isVPINToxic) {
    console.log(`[VPIN KILL SWITCH] ⛔ Toxic flow detected (Vol ${smData.volumeSpike}x, Move ${(smData.oneHourChange * 100).toFixed(1)}%) — skipping`);
    return;
  }

  // Whale Wallet Tracking Consensus
  const whaleData = await smartMoney.getWhaleConsensus(market.id || market.conditionId);
  if (whaleData.signal !== 'NEUTRAL') {
    const boost = whaleData.weight / 1000; // max +10% boost to prob
    const oldProb = myProb;
    const adjustedProb = whaleData.signal === 'BULLISH' ? Math.min(0.99, myProb + boost) : Math.max(0.01, myProb - boost);
    console.log(`[WHALE TRACKER] 🐋 ${whaleData.signal} Consensus detected (${whaleData.weight.toFixed(0)} pts). Adjusting prob: ${(oldProb * 100).toFixed(1)}% -> ${(adjustedProb * 100).toFixed(1)}%`);
    myProb = adjustedProb; // whale adjustment now applies
  }

  // Canonical executable quote: fresh WS book if available, else Gamma bestBid/bestAsk.
  // No finite two-sided quote → hard SKIP. This is what fills and the spread veto use.
  const tokId = Array.isArray(market.clobTokenIds) ? market.clobTokenIds[0] : null;
  const wsBook = tokId ? polymarketWS.getBook(tokId) : null;
  const quote = (wsBook && wsBook.bestBid > 0 && wsBook.bestAsk < 1 && Date.now() - (wsBook.lastUpdate || 0) < 30000)
    ? { bestBid: wsBook.bestBid, bestAsk: wsBook.bestAsk, liquidity: market.liquidity, volume24h: market.volume24h }
    : { bestBid: market.bestBid, bestAsk: market.bestAsk, liquidity: market.liquidity, volume24h: market.volume24h };
  if (!Number.isFinite(quote.bestBid) || !Number.isFinite(quote.bestAsk) || quote.bestAsk <= quote.bestBid) {
    console.log(`[QUOTE] ⛔ No executable book for ${(market.title || '').slice(0, 40)} — skipping`);
    recordAdanShadow(decision, market, 'NO_QUOTE');
    return;
  }

  const obData = orderBook.analyze(quote);
  const effectiveEdge = obData.available ? orderBook.adjustEdge(edge, obData) : edge;
  if (obData.available && obData.recommendation === 'AVOID_WIDE_SPREAD') {
    console.log('[ORDER BOOK] ⛔ Wide spread:', obData.spreadPct + '% — skipping');
    recordAdanShadow(decision, market, 'WIDE_SPREAD');
    return;
  }

  // ═══ QUANT: LMSR edge check ═══
  const sessionAdj = lastSessionAdj || marketSessions.getSessionAdjustments();
  const primaryData = prices['BTCUSDT'] || {};
  const lmsrResult = lmsrEngine.calculateFairValue({
    yesPrice: market.yesPrice,
    fearGreedIndex: prices._meta?.fearGreed?.value || null,
    volRatio: primaryData?.vol?.ratio || 1,
    priceChange1h: primaryData?.chg || 0,
    rsi14: market.priceData?.rsi || undefined,
    bbPosition: market.priceData?.bbPct || undefined,
    sessionEdge: sessionAdj.edgeMultiplier,
    humanState: lastHumanState,
    soulRules: [],
    side
  });

  // ═══ QUANT: Particle Filter ═══
  const pState = particleFilter.update(
    market.id || market.conditionId || Date.now().toString(),
    market.yesPrice,
    { signalLogitUpdate: lmsrResult.logitComponents?.totalShift || 0 }
  );

  let particleStakeAdj = 1.0;
  if (pState?.uncertainty > 0.5) {
    particleStakeAdj = 0.6;
    console.log('[PARTICLE] ⚠️ High uncertainty — reducing stake 40%');
  }
  // ═══ QUANT: Gate 3.5: IV Analysis (Black-Scholes Singularity) ═══
  const hoursToClose = market.closesAt ? (new Date(market.closesAt) - Date.now()) / 3600000 : 48;
  const assetKey = market.asset?.toLowerCase() || 'btc';
  const ivAnalysis = ivSolver.analyzePolymarketBook(market.yesPrice, 1 - market.yesPrice, hoursToClose);
  const ewmaVol = (wilmott.getEWMAForIVComparison ? wilmott.getEWMAForIVComparison(assetKey) : 0.02) * Math.sqrt(365); // Annually
  const ivSpread = ivSolver.calculateIVSpread(ivAnalysis.iv, ewmaVol);
  const ivSignal = ivSolver.generateVolSignal(ivAnalysis.skew, ivSpread, ivAnalysis.iv);

  // [ADAN v6.5] Inject into Global UI State
  state.ivData = {
    iv: (ivAnalysis.iv * 100).toFixed(1),
    rv: (ewmaVol * 100).toFixed(1),
    spread: (ivSpread * 100).toFixed(1),
    skew: (ivAnalysis.skew * 100).toFixed(1),
    signal: ivSignal.signal,
    strength: ivSignal.strength
  };

  let ivStakeMult = 1.0;
  if (ivSignal.signal === 'SELL_VOL' && ivSignal.strength > 0.7) {
    console.log(`[IV SOLER] 🟢 SELL_VOL: IV (${(ivAnalysis.iv * 100).toFixed(0)}%) > RV (${(ewmaVol * 100).toFixed(0)}%) | Boost +2 SNAKE Authority`);
    ivStakeMult = 1.2;
  } else if (ivSignal.signal === 'BUY_VOL' && ivSignal.strength > 0.7) {
    console.log(`[IV SOLVER] ⚠️ BUY_VOL: IV (${(ivAnalysis.iv || 0 * 100).toFixed(0)}%) < RV (${(ewmaVol * 100).toFixed(0)}%) | EVA Protective Mode`);
    ivStakeMult = 0.8;
  }

  // [ADAN v6.5] Faction-Specific Dynamic Adjustments
  if (ivSpread < -0.10) {
    // EVA sube VaR threshold: Permitir más riesgo cuando la vol es barata
    console.log(`[FACCION] 👑 EVA: Vol low (Spread: ${(ivSpread * 100).toFixed(1)}%) | Expanding VaR Threshold`);
  }
  if (ivAnalysis.skew > 0.10) {
    // ATLAS activa modo defensivo: Miedo asimétrico detectado en la curva
    console.log(`[FACCION] 👁️ ATLAS: High Skew (${(ivAnalysis.skew * 100).toFixed(1)}%) | Activating Defensive Oracle`);
    ivStakeMult *= 0.9; // Ligera reducción técnica
  }

  if (ivAnalysis.isArbitrage) {
    console.log(`[IV SOLVER] 🚨 ARBITRAGE DETECTED (Book Sum: ${ivAnalysis.bookSum.toFixed(3)}) — Manual check required`);
  }

  // Soul Rule Integration
  const ivSoulRule = soulManager.checkIVRegimeRule(ivSpread);
  if (ivSoulRule.active) {
    console.log(`[SOUL RULE] 🧠 ${ivSoulRule.reason}`);
    ivStakeMult *= ivSoulRule.multiplier;
  }

  // ═══ QUANT: Greeks timing ═══
  const greeks = calculateGreeks(market.yesPrice, hoursToClose, {
    strikePrice: market.yesPrice,
    spread: smData.available ? smData.spread : 0,
    historicalVol: primaryData?.volatility || 0
  });
  if (greeks) {
    console.log('[GREEKS] Delta:', greeks.delta.toFixed(4),
      '| Exit urgency:', (greeks.exitUrgency * 100).toFixed(0) + '%',
      '| Hold:', greeks.holdRecommendation);
  }

  // ═══ QUANT: Copula portfolio risk ═══
  // positions already loaded by Wilmott preTrade above
  const portfolioRisk = copulaRisk.analyzePortfolio(positions.open);
  const copulaStakeAdj = portfolioRisk.stakeMultiplier;

  // ═══ QUANT: Master System Prompt EV Check ═══
  const p = side === 'YES' ? myProb : 1 - myProb;
  // EV against the EXECUTABLE price (taker fill), not the mid: the spread is
  // part of the cost of every trade and must be paid inside the EV math.
  const rawOdds = side === 'YES' ? quote.bestAsk : (1 - quote.bestBid);
  const potentialProfit = (1 / Math.max(rawOdds, 0.01)) - 1;
  const ev = (p * potentialProfit) - (1 - p);

  // Minimum EV threshold — configurable via config.json gates.evGateMin
  const gatesCfg = loadConfig()?.gates || {};
  const minEV = gatesCfg.evGateMin ?? -0.10;
  if (ev < minEV) {
    console.log(`[EV GATE] ⛔ ${ev <= 0 ? 'NEGATIVE' : 'INSUFFICIENT'} EV: ${ev.toFixed(4)} (min: ${minEV}). Market: ${(market.title || '').slice(0, 30)}...`);
    recordAdanShadow(decision, market, 'INSUFFICIENT_EV');
    try {
      const evLogPath = path.join(DIR, 'ev_blocks.jsonl');
      fs.appendFileSync(evLogPath, JSON.stringify({ ts: new Date().toISOString(), marketId: market.id, title: market.title, ev, p, rawOdds, side }) + '\n');
    } catch { }
    return;
  }

  // ═══ META-LABEL ARBITER (López de Prado ch.3) ═══
  // The quant scanner already chose the side. The LLM answers a smaller,
  // honest question: act on this signal or not, and at what size fraction.
  // FAIL-OPEN: null/timeout/parse failure → quant decision proceeds unchanged.
  // (Mapping null to veto would recreate the 100%-blocked oracle path.)
  try {
    const metaPrompt = `
Signal: ${side} on "${(market.title || '').slice(0, 80)}" (${market.asset}, ${market.windowMin}min window).
P(chosen side) ${(decision.pSide != null ? decision.pSide * 100 : confidence).toFixed(0)}%, gross edge ${(edge * 100).toFixed(1)}%, EV ${ev.toFixed(3)}.
Book: bid ${(quote.bestBid * 100).toFixed(1)} / ask ${(quote.bestAsk * 100).toFixed(1)} (spread ${((quote.bestAsk - quote.bestBid) * 100).toFixed(1)}%), liquidity $${Math.round(market.liquidity || 0)}.
Risk state: drawdown ${(markov.current_drawdown_pct * 100).toFixed(1)}%, streak ${pnlNow.streak || 0}, open positions ${markov.positions_open}.
Source: ${decision._childSpec || 'fast-path'}.

You are the risk arbiter, NOT the forecaster. The side is already chosen by a quant model.
First, calculate edge_after_spread = gross edge - (spread / 2).
Veto if edge_after_spread is not clearly larger than typical execution slippage for this liquidity level, or if there is correlated exposure / degraded regime.
Markets are highly efficient — be skeptical, but base your veto on edge_after_spread, not on a mood.

Reply ONLY JSON: {"bet": true|false, "sizeMult": 0.5-1.0, "edge_after_spread": <number>, "reason": "<max 15 words>"}
`;
    const metaRaw = await Promise.race([
      routeLLM({ systemPrompt: 'You are a trading risk arbiter. JSON only.', userPrompt: metaPrompt, weight: 'Light', reason: 'meta_label' }),
      new Promise(resolve => setTimeout(() => resolve(null), 8000)),
    ]);
    if (metaRaw) {
      const metaJson = (metaRaw.match(/\{[\s\S]*\}/) || [null])[0];
      const meta = metaJson ? JSON.parse(metaJson) : null;
      if (meta && meta.bet === false) {
        console.log(`[META-LABEL] ⛔ LLM veto: ${meta.reason || 'no reason'}`);
        recordAdanShadow(decision, market, 'META_LABEL_VETO');
        return;
      }
      if (meta && typeof meta.sizeMult === 'number' && meta.sizeMult >= 0.3 && meta.sizeMult < 1) {
        console.log(`[META-LABEL] ⚠️ LLM resize ×${meta.sizeMult.toFixed(2)}: ${meta.reason || ''}`);
        decision._metaStakeReduction = meta.sizeMult;
      }
    } else {
      console.log('[META-LABEL] (no LLM opinion — quant decision proceeds)');
    }
  } catch (metaErr) {
    console.log('[META-LABEL] error (fail-open):', metaErr.message);
  }

  // ═══ COMBINED STAKE (Kelly × Mother Code multipliers with floor) ═══
  // We only reach here if EV > 0 (as mathematically required by Kelly formula)
  // Probation (healing a >20% drawdown): flat minimum ticket, no Kelly.
  const baseStake = ddProbation ? 25 : kellyStake(pnlNow, side, myProb, market.yesPrice, edge, confidence);
  const humanMult = (lastHumanState === 'NEWS_SHOCK') ? 0 : 1.0;
  const sessionMult = sessionAdj.stakeMultiplier;
  const metabolicMult = metabolism.getStakeMultiplier(pnlNow.fund || 0, lastHumanState);
  // Concept #21: Apply time decay factor to stake sizing
  const timeDecay = market._timeDecay || getTimeDecayFactor(market);
  const timeDecayMult = timeDecay.factor;
  if (timeDecayMult < 1.0) {
    console.log(`[TIME DECAY] ⏰ Stake reduced by ${((1 - timeDecayMult) * 100).toFixed(0)}% — ${timeDecay.note} (TTC: ${timeDecay.time_to_close_hours?.toFixed(1)}h)`);
  }
  // Concept #21: Block bets that don't meet minimum edge for 1-4h window
  if (timeDecay.minEdge && Math.abs(edge) < timeDecay.minEdge) {
    console.log(`[TIME DECAY] ⛔ Edge ${(Math.abs(edge) * 100).toFixed(1)}% < ${(timeDecay.minEdge * 100).toFixed(0)}% required for TTC ${timeDecay.time_to_close_hours?.toFixed(1)}h — VETOED`);
    return;
  }
  // ── Concept #12D: K-Means Regime Kelly Multiplier ──
  const kmeansKelly = kmeansRegime.getKellyMultiplier();
  const kmeansRegimeMult = kmeansKelly.mult;
  if (kmeansKelly.regime === 'EVENT') {
    console.log(`[K-MEANS] ⛔ EVENT regime detected — all bets VETOED (confidence: ${(kmeansRegime.lastResult?.confidence * 100 || 0).toFixed(0)}%)`);
    recordAdanShadow(decision, market, 'KMEANS_EVENT_REGIME');
    return;
  }
  if (kmeansKelly.minEdge && Math.abs(edge) < kmeansKelly.minEdge) {
    console.log(`[K-MEANS] ⛔ ${kmeansKelly.regime} regime requires ${(kmeansKelly.minEdge * 100).toFixed(0)}% min edge, got ${(Math.abs(edge) * 100).toFixed(1)}% — VETOED`);
    return;
  }
  if (kmeansRegimeMult < 1.0) {
    console.log(`[K-MEANS] Regime: ${kmeansKelly.regime} — Kelly ×${kmeansRegimeMult}`);
  }
  // Concept #12C: Bin Count hour Kelly multiplier
  const hourBinForKelly = binCountScore(pnlNow.hourStats, new Date().getUTCHours());
  const hourBinMult = hourKellyMultiplier(hourBinForKelly.score);
  if (hourBinMult !== 1.0) {
    console.log(`[BIN-COUNT] Hour ${new Date().getUTCHours()}:00 log-odds=${hourBinForKelly.score.toFixed(2)} → Kelly ×${hourBinMult}`);
  }
  // Concept #20E: Meta-Labeler stake reduction
  const metaLabelMult = decision._metaStakeReduction || 1.0;
  // Concept #20D: CUSUM structural break → reduce 40%
  const cusumMult = cusumFilter.isInTransition(30000) ? 0.6 : 1.0;
  // Concept #20F: VPIN toxicity → reduce 50%
  const vpinMult = vpinTracker.isToxic() ? 0.5 : (vpinTracker.getVPIN() > 0.5 ? 0.8 : 1.0);
  // Concept #20C: Purged WF overfit penalty — if model overfitting, reduce trust
  let purgedWFMult = 1.0;
  try {
    const overfitScore = purgedWF.getOverfitScore();
    if (overfitScore > 1.3) {
      purgedWFMult = 0.6; // Model is overfitting — reduce stake 40%
      console.log(`[PURGED-WF] ⚠ Overfit score ${overfitScore.toFixed(2)} > 1.3 — stake ×0.6`);
    } else if (overfitScore > 1.15) {
      purgedWFMult = 0.8;
    }
    // isModelReliable() was computed but never consulted — a model confirmed to
    // score no better than the naive majority-class baseline still staked full
    // size. Optimistic default (true) when there's no validation yet, so this
    // only bites once purgedWF has actually run and found a problem.
    if (!purgedWF.isModelReliable()) {
      purgedWFMult = Math.min(purgedWFMult, 0.7);
      console.log(`[PURGED-WF] ⚠ Model not reliable (test acc ≈ base rate) — stake ×0.7`);
    }
  } catch (e) { console.error('[PURGED-WF] Overfit check error:', e.message); }
  // v9.0: Scenario Forecaster — "Third Eye" Kelly multiplier
  const forecastMult = scenarioForecaster.getKellyMultiplier();
  const combined = Math.max(0.25, humanMult * sessionMult * metabolicMult * particleStakeAdj * copulaStakeAdj * wilmottStakeMult * ivStakeMult * timeDecayMult * kmeansRegimeMult * hourBinMult * metaLabelMult * cusumMult * vpinMult * purgedWFMult * forecastMult);
  // Instrumentation only (no behavior change): 15 independent multipliers
  // chained together have never been validated jointly. Log each one now so
  // that once enough trades resolve, we can check which actually correlate
  // with win rate vs. which are just adding compounding noise to every stake.
  multiplierAudit.record(
    { humanMult, sessionMult, metabolicMult, particleStakeAdj, copulaStakeAdj, wilmottStakeMult, ivStakeMult, timeDecayMult, kmeansRegimeMult, hourBinMult, metaLabelMult, cusumMult, vpinMult, purgedWFMult, forecastMult, combined },
    { asset: market?.asset, childSpec: decision?._childSpec || null, edge: decision?.edge || 0 }
  );
  // Probation flat ticket is exempt from the training floor; otherwise min $100.
  let stake = ddProbation ? 25 : Math.round(Math.max(100, baseStake * combined) / 25) * 25;

  // v5.3 Wilmott: Child-direct trades use Half Kelly + Copula correlation penalty
  if (decision._childDirect) {
    // BUG FIX: the old formula (edge / (edge*(1-edge))) ignored market price
    // entirely, so it couldn't tell a 3% edge at 50¢ from a 3% edge at 90¢ —
    // very different correct bet sizes. It also saturated past 100% "full
    // Kelly" for almost any edge above ~2%, so every child-direct trade got
    // sized the same regardless of how strong its edge was. Reuse the
    // correctly-derived odds-aware formula from kelly_sizer.js instead.
    const edge = decision.edge || 0.01; // was 0.05 — don't gift free edge to child trades
    const modelProb = decision.pSide ?? decision.myProb ?? (0.5 + edge / 2);
    const marketPrice = Math.min(0.99, Math.max(0.01, modelProb - (edge + FEES_SLIPPAGE)));
    const fund = pnlNow.fund || 5000;
    const kellyResult = kellySizer.compute({ modelProb, marketPrice, fund });
    const fullKelly = kellyResult.kellyFull;
    const rawChildStake = kellyResult.stake;
    // Apply copula correlation penalty (already calculated above)
    const childStakeWithCopula = Math.round(rawChildStake * copulaStakeAdj / 25) * 25;
    stake = Math.min(300, Math.max(50, childStakeWithCopula));
    // Risk controls that MUST bind even on the child/GAUSS override path:
    // the LLM meta-label size verdict was silently discarded here before.
    stake = Math.round(stake * metaLabelMult / 25) * 25;
    console.log(`[CHILD DIRECT STAKE] 📐 ${decision._childSpec} Half-Kelly: edge=${(edge * 100).toFixed(1)}% f*=${(fullKelly * 100).toFixed(1)}% → $${rawChildStake} × copula(${copulaStakeAdj.toFixed(2)}) × meta(${metaLabelMult.toFixed(2)}) = $${stake}`);
  }

  // Drawdown probation overrides EVERY sizing path (child override included):
  // a flat healing ticket, or the drawdown it exists to heal never heals.
  if (ddProbation) { stake = 25; }

  // ═══ Concept #8C: UCB Exploration stake cap — max 3% of fund on exploration markets ═══
  if (market._ucb && market._ucb.is_exploration) {
    const explorationMax = ucbExplorer.getExplorationMaxStake(pnlNow.fund || 5000);
    const prevStake = stake;
    stake = Math.min(stake, Math.max(25, Math.round(explorationMax / 25) * 25));
    if (stake < prevStake) {
      console.log(`[UCB EXPLORER] 🔬 Exploration market (${market._ucb.trades || 0} trades) — stake capped $${prevStake} → $${stake} (3% fund cap)`);
    }
  }

  // ═══ MARKOVIAN STAKE RULES (Concept #8D) ═══
  {
    const mkv = state._markovState || computeMarkovianState();

    // Rule 3: 3+ consecutive losses → max stake $75
    if (mkv.consecutive_losses >= 3) {
      const prevStake = stake;
      stake = Math.min(stake, 75);
      if (prevStake !== stake) {
        console.log(`[MARKOV] 📉 LOSS STREAK (${mkv.consecutive_losses}) — stake capped $${prevStake} → $${stake}`);
      }
    }

    // Rule 4: Capital deployed > 80% → Kelly on free capital only
    if (mkv.capital_deployed_pct > 0.80) {
      const freeCapitalStake = Math.round(Math.min(stake, mkv.free_capital * 0.05) / 25) * 25;
      if (freeCapitalStake < stake) {
        console.log(`[MARKOV] 📉 HIGH EXPOSURE (${(mkv.capital_deployed_pct * 100).toFixed(0)}%) — stake reduced $${stake} → $${freeCapitalStake} (free capital: $${mkv.free_capital})`);
        stake = Math.max(25, freeCapitalStake);
      }
    }
  }

  if (humanMult === 0) {
    console.log('[MOTHER CODE] ⛔ NEWS_SHOCK — skipping all bets');
    return;
  }

  console.log('[STAKE] Base:', baseStake,
    '× Session:', sessionMult,
    '× Metabolic:', metabolicMult,
    '× Particle:', particleStakeAdj,
    '× Copula:', copulaStakeAdj,
    '× Wilmott:', wilmottStakeMult,
    '× KMeans:', kmeansRegimeMult,
    '= Final:', stake);

  cls();
  console.log(M + BOLD + '  ╔══════════════════════════════════════════════════════════════╗');
  console.log(M + BOLD + '  ║  ADAN  ·  PAPER BET  ·  ' + new Date().toLocaleTimeString().padEnd(35) + '║');
  console.log(M + BOLD + '  ╠══════════════════════════════════════════════════════════════╣');
  console.log(M + BOLD + '  ║  Market: ' + W + BOLD + (market.title || '').slice(0, 52).padEnd(52) + M + BOLD + ' ║');
  console.log(M + BOLD + '  ║  Side: ' + W + BOLD + side.padEnd(5) + X + M + BOLD + '  My prob: ' + Y + BOLD + (myProb * 100).toFixed(1) + '%' + M + BOLD + '  Market: ' + W + (market.yesPrice * 100).toFixed(1) + '%' + M + BOLD + '  EV: ' + G + BOLD + '+' + ev.toFixed(3) + M + BOLD + '     ║');
  console.log(M + BOLD + '  ║  Confidence: ' + Y + BOLD + confidence + '%' + M + BOLD + '  Stake: ' + G + BOLD + '$' + stake + (kellyOn ? ' 📐KELLY' : ' flat') + M + BOLD + '  Liq: $' + (market.liquidity || 0).toFixed(0).padEnd(8) + '║');
  console.log(M + BOLD + '  ║  LMSR: ' + (lmsrResult.hasSufficientEdge ? G : R) + BOLD + lmsrResult.recommendation + X + M + BOLD + '  Sessions: ' + Y + sessionAdj.sessionName + X + M + BOLD + '                 ║');
  console.log(M + BOLD + '  ║  PAPER BET — no real money moved                             ║');
  console.log(M + BOLD + '  ╚══════════════════════════════════════════════════════════════╝' + X);
  await new Promise(r => setTimeout(r, 2000));

  // Build feature vector for cortex memory at entry time (v7: with alien features)
  const closesAtMs = market.closesAt ? new Date(market.closesAt).getTime() : 0;
  const entryVec = buildFeatureVector(market.priceData || {}, {
    priceDist: market.roughEdge || Math.abs((market.yesPrice || 0.5) - 0.5),
    timeToExpiry: closesAtMs > Date.now() ? Math.log(Math.max(1, (closesAtMs - Date.now()) / 60000)) : 0,
    yesPrice: market.yesPrice || 0.5,
    fearGreed: state?.prices?._meta?.fearGreed?.value || 50,
    effRatio: market.priceData?.efficiencyRatio ?? 0.5,
  });

  // ═══ FEATURE ATTRIBUTION: Record entry features ═══
  const tradeId = Date.now().toString();

  // ═══ BRIER PROTOCOL: report this paper bet to the reputation layer ═══
  // probability = myProb (P of YES, whale-adjusted) — the number Brier scores.
  // The reporter flips it to the side frame and skips no-signal commits itself.
  reportPaperBet({ market, side, stake, tradeId, probability: myProb, marketYesPrice: market.yesPrice }).catch(() => { });

  try {
    const fgData = state?.prices?._meta?.fearGreed;
    featureTracker.recordEntry(tradeId, featureTracker.extractFeatures({
      fearGreed: fgData?.value || 0,
      fundingRate: market.priceData?.funding?.rate || 0,
      trendStrength: market.priceData?.trend5m || 0,
      volRatio: market.priceData?.vol?.ratio || 1,
      sessionName: sessionAdj.sessionName,
      humanState: lastHumanState,
      edge: effectiveEdge,
      confidence,
      asset: market.asset || '',
      smartMoneySignal: smData.signal || 'NO_DATA',
      spreadPct: obData.spreadPct || 0,
      condition_id: market.conditionId || market.condition_id || '',
      market_id: market.id || market.market_id || '',
      slug: market.slug || '',
      side: (side === 'YES' || side === 'NO') ? (side === 'YES' ? 'Yes' : 'No') : null,
      orderbook_snapshot: { bid: quote.bestBid, ask: quote.bestAsk, spread: quote.bestAsk - quote.bestBid },
    }));
  } catch (e) { console.error('[FEATURE_ATTR] Excepción al registrar trade, se perdió el log:', e.message); }

  // ═══ FEATURE IMPORTANCE: Record entry for Point-Biserial ranking ═══
  // v5.2 FIX: Property names now match actual Binance data structure
  try {
    const pd = market.priceData;
    featureImportance.recordEntry(tradeId, {
      rsi: pd?.rsi || 50,
      macdHist: pd?.macd?.hist || 0,
      bbPosition: pd?.bb?.pct != null ? pd.bb.pct / 100 : 0.5,
      vwapDeviation: pd?.vwap5m?.pct || 0,
      fearGreed: state?.prices?._meta?.fearGreed?.value || 50,
      newsScore: 0,
      fundingRate: pd?.funding?.rate || 0,
      oiChange: 0,
      whaleWalls: pd?.orderBook ? (pd.orderBook.buyPressure > 60 ? 1 : pd.orderBook.buyPressure < 40 ? -1 : 0) : 0,
      regime: pd?.regime || 'NORMAL',
      kmeansRegime: pd?.kmeansRegime?.regime || 'UNKNOWN',
      sessionEdge: sessionAdj.multiplier || 1,
      humanState: lastHumanState || 'RATIONAL_MARKET',
      oracleSignal: pd?.obImbalance === 'BUY_WALL' ? 1 : pd?.obImbalance === 'SELL_WALL' ? -1 : 0,
      volRatio: pd?.vol?.ratio || 1,
      trendStrength: pd?.trend5m || 0
    });
  } catch (e) { }

  // ═══ LMSR: Record prediction for Brier Score ═══
  const predId = (market.id || '') + '_' + Date.now();
  const effectiveProb = side === 'YES' ? (pState?.trueProbability || market.yesPrice)
    : (1 - (pState?.trueProbability || market.yesPrice));
  lmsrEngine.recordPrediction(predId, effectiveProb, side);

  // ═══ FILL: taker at the real book ═══
  // YES buys at the ask; NO shares cost (1 - bid) — selling YES to the bid.
  // No jitter, no sniper fiction: the spread is paid for real, at entry.
  const fillPrice = side === 'YES' ? quote.bestAsk : (1 - quote.bestBid);
  if (fillPrice <= 0.01 || fillPrice >= 0.99) {
    console.log(`[FILL] ⛔ Untradeable fill ${(fillPrice * 100).toFixed(1)}% on ${(market.title || '').slice(0, 40)} — skipping`);
    recordAdanShadow(decision, market, 'UNTRADEABLE_FILL');
    return;
  }
  console.log(`[FILL] 💵 ${side} @ ${(fillPrice * 100).toFixed(1)}% (bid ${(quote.bestBid * 100).toFixed(1)} / ask ${(quote.bestAsk * 100).toFixed(1)}, spread ${((quote.bestAsk - quote.bestBid) * 100).toFixed(1)}%)`);

  const pos = loadPositions();
  // Atomic dedup recheck: the guard at function entry ran BEFORE up to ~10s of
  // awaits (whale fetch, meta-label race); the fast loop can interleave there.
  // No awaits between this read and savePositions, so this check is race-free.
  {
    const mKeyFill = market.id || market.conditionId;
    if ((pos.open || []).some(q => (q.marketId || q.conditionId) === mKeyFill)) {
      console.log('[DEDUP] ⏭ Position appeared during evaluation — aborting duplicate fill');
      recordAdanShadow(decision, market, 'DUPLICATE_RACE');
      return;
    }
  }
  pos.open.push({
    id: Date.now().toString(),
    marketId: market.id,
    conditionId: market.conditionId || null,
    childSpec: decision?._childSpec || null,
    marketTitle: market.title,
    asset: market.asset || 'other',
    side, myProb,
    pYes: myProb, // explicit frame tag: myProb IS P(YES) from here on
    pSide: side === 'YES' ? myProb : 1 - myProb,
    rawConfidence: decision?.rawConfidence ?? confidence, // pre-metacalib, for honest recalibration
    marketPrice: market.yesPrice, // YES-frame mark (greeks/filters/soul read this)
    entryPrice: fillPrice,        // chosen-side executable fill
    entryBestBid: quote.bestBid,
    entryBestAsk: quote.bestAsk,
    spreadAtEntry: quote.bestAsk - quote.bestBid,
    edge, confidence,
    stake,
    marketLiquidity: market.liquidity || 0,
    entryTime: new Date().toISOString(),
    closesAt: market.closesAt || null,
    resolved: false, won: null, pnl: null,
    entryThought: thought ? thought.slice(0, 300) : '',
    entryVec,
    windowMin: market.windowMin || 5,  // v7: track for market filter
    rulesProb: ensembleResult?.rulesProb || null,  // v7: stored for ensemble learning
    statProb: ensembleResult?.statProb || null,    // v7: stored for ensemble learning
    brain: brainManager.currentBrain || 'DEFAULT',
    featureTradeId: tradeId,
    lmsrPredId: predId,
    _metaFeatures: decision?._metaFeatures || null,
  });
  savePositions(pos);

  // Learning Loop: photograph the decision — full feature snapshot at entry
  try {
    const pdL = market.priceData || {};
    tradeLedger.record({
      id: tradeId,
      childSpec: decision?._childSpec || null,
      asset: market.asset || 'other',
      windowMin: market.windowMin || 5,
      side, myProb,
      pYes: myProb,
      pSide: side === 'YES' ? myProb : 1 - myProb,
      marketId: market.id,
      conditionId: market.conditionId || null,
      entryPrice: fillPrice,
      entryBestBid: quote.bestBid,
      entryBestAsk: quote.bestAsk,
      spreadAtEntry: quote.bestAsk - quote.bestBid,
      marketProb: market.yesPrice,
      edgeDeclared: edge,
      confidence, stake,
      regime: pdL.regime || 'NORMAL',
      kmeansRegime: pdL.kmeansRegime?.regime || null,
      brain: brainManager.currentBrain || 'DEFAULT',
      hourUTC: new Date().getUTCHours(),
      liquidity: market.liquidity || 0,
      entryVec,
    });
  } catch { }

  // Concept #15: ADAN-SHADOW — record opposite bet
  try { adanShadow.recordTrade(side, market, stake, market.asset, market.windowMin ? market.windowMin + 'min' : '5min', new Date().getUTCHours()); } catch { }

  const pnl = loadPnL();
  pnl.fund = parseFloat(((pnl.fund || 100) - stake).toFixed(2));
  pnl.openPositions = (pnl.openPositions || 0) + 1;
  savePnL(pnl);
  awardExp(20);
  // Log hypothesis for episodic memory
  logHypothesis(market.id, market.asset || 'other', side, myProb, market.yesPrice, edge, market.closesAt);
}

// ── Confidence meta-learning ──────────────────────────────────────────────────
const METACALIB_PATH = path.join(DIR, 'metacalib.json');
function loadMetaCalib() {
  const def = { buckets: { '60': { pred: 0, correct: 0 }, '70': { pred: 0, correct: 0 }, '80': { pred: 0, correct: 0 }, '90': { pred: 0, correct: 0 } }, multiplier: 1.0 };
  try { return fs.existsSync(METACALIB_PATH) ? { ...def, ...JSON.parse(fs.readFileSync(METACALIB_PATH, 'utf8')) } : def; } catch { return def; }
}
function updateMetaCalib(confidence, won) {
  const mc = loadMetaCalib();
  const key = confidence >= 90 ? '90' : confidence >= 80 ? '80' : confidence >= 70 ? '70' : '60';
  if (!mc.buckets[key]) mc.buckets[key] = { pred: 0, correct: 0 };
  mc.buckets[key].pred++;
  if (won) mc.buckets[key].correct++;
  // Recalculate multiplier: if Claude says 70% conf but only 55% correct → multiplier = 0.55/0.70 = 0.78
  const totPred = Object.values(mc.buckets).reduce((s, b) => s + b.pred, 0);
  if (totPred >= 10) {
    const totCorrect = Object.values(mc.buckets).reduce((s, b) => s + b.correct, 0);
    const actualAcc = totCorrect / totPred;
    const avgConf = Object.entries(mc.buckets).reduce((s, [k, b]) => s + (parseInt(k) / 100) * b.pred, 0) / totPred;
    mc.multiplier = parseFloat(Math.min(1.3, Math.max(0.5, actualAcc / avgConf)).toFixed(3));
  }
  fs.writeFileSync(METACALIB_PATH, JSON.stringify(mc, null, 2));
  return mc;
}
function getMetaCalibContext() {
  const mc = loadMetaCalib();
  const tot = Object.values(mc.buckets).reduce((s, b) => s + b.pred, 0);
  if (tot < 5) return '';
  const cor = Object.values(mc.buckets).reduce((s, b) => s + b.correct, 0);
  return `META-CALIBRATION: Your stated confidence is ${mc.multiplier < 0.9 ? 'OVERCONFIDENT' : 'well-calibrated'} (multiplier=${mc.multiplier}). ` +
    `Actual accuracy ${Math.round(cor / tot * 100)}% on ${tot} predictions. ` +
    (mc.multiplier < 0.85 ? 'Reduce confidence estimates by ~' + Math.round((1 - mc.multiplier) * 100) + '%.' : '');
}

// ── Bottom-up knowledge: child insights → parent SOUL ────────────────────────
const INSIGHTS_PATH = path.join(DIR, 'insights.jsonl');
function logChildInsight(spec, asset, pattern, direction, occurrences) {
  const entry = { spec, asset, pattern, direction, occurrences, ts: new Date().toISOString(), promoted: false };
  fs.appendFileSync(INSIGHTS_PATH, JSON.stringify(entry) + '\n');
}
function promoteInsightsToSoul() {
  if (!fs.existsSync(INSIGHTS_PATH)) return;
  const lines = fs.readFileSync(INSIGHTS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const parsed = [];
  const grouped = {};

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj) {
        parsed.push({ idx: i, obj });
        const k = obj.asset + '|' + obj.pattern;
        if (!grouped[k]) grouped[k] = { ...obj, count: 0, indices: [] };
        grouped[k].count++;
        grouped[k].indices.push(i);
      }
    } catch { }
  }

  const toPromote = Object.values(grouped).filter(g => g.count >= 3 && !g.promoted);
  if (toPromote.length === 0) return;

  let soulText = '';
  for (const p of toPromote) {
    soulText += `\n### CHILD INSIGHT PROMOTED — ${new Date().toISOString()}:\n[${p.spec}] Pattern: ${p.pattern} → ${p.direction} (confirmed ${p.count}x)\n`;
    for (const idx of p.indices) {
      const item = parsed.find(x => x.idx === idx);
      if (item) {
        item.obj.promoted = true;
        lines[idx] = JSON.stringify(item.obj);
      }
    }
  }

  appendToSoul(soulText);
  // Smart Pruning: Prevent infinite growth while keeping pending insights
  const MAX_INSIGHTS = 5000;
  let finalLines = lines;
  if (lines.length > MAX_INSIGHTS) {
    const unpromoted = [];
    const promoted = [];
    for (const l of lines) {
      if (l.includes('"promoted":true')) promoted.push(l);
      else unpromoted.push(l);
    }
    // Keep all unpromoted (pending threshold), fill the rest with recent promoted
    const keepPromotedCount = Math.max(0, MAX_INSIGHTS - unpromoted.length);
    const keepPromoted = promoted.slice(-keepPromotedCount);
    // Maintain chronological approximate order: old promoted first, then unpromoted
    finalLines = [...keepPromoted, ...unpromoted];
  }

  fs.writeFileSync(INSIGHTS_PATH, finalLines.join('\n') + '\n');
}


// AGI client reference (set in main)
let _agiClient = null;

// ── Survival Mode: ADAN ajusta sus reglas para sobrevivir ─────────────────────
function applySurvivalMode(pnl) {
  const fund = pnl.fund ?? 10000;
  const strat = loadStrategy();
  let mode = 'normal';
  let minEdge = 0.05;
  let maxPos = 9;
  let soulNote = null;

  // Paper trade $10k: trade freely to learn — survival only near death
  if (fund < 5) {
    mode = 'critical'; minEdge = 0.15; maxPos = 1;
    soulNote = `CRITICAL: fund $${fund.toFixed(2)} — near death. 15%+ edge only, 1 position. Must survive.`;
  } else if (fund < 50) {
    mode = 'survival'; minEdge = 0.12; maxPos = 2;
    soulNote = `SURVIVAL: fund $${fund.toFixed(2)} — almost gone. 12%+ edge, 2 positions. Make money or die.`;
  } else if (fund < 200) {
    mode = 'cautious'; minEdge = 0.08; maxPos = 4;
    soulNote = null;
  }

  // Update strategy dynamically
  if (strat.minEdge !== minEdge || strat.maxPositions !== maxPos) {
    strat.minEdge = minEdge;
    strat.maxPositions = maxPos;
    fs.writeFileSync(STRATEGY_PATH, JSON.stringify(strat, null, 2));
  }

  // Write survival note to SOUL if entering danger
  if (soulNote) {
    const existing = fs.readFileSync(SOUL_PATH, 'utf8');
    if (!existing.includes(soulNote.slice(0, 40))) {
      fs.appendFileSync(SOUL_PATH, `\n### SURVIVAL — ${new Date().toISOString()}:\n${soulNote}\n`);
    }
  }

  return { mode, minEdge, maxPos };
}

// ── Main scan ────────────────────────────────────────────────────────────────
const resolvingTradeIds = new Set();

async function checkResolutions() {
  const pos = loadPositions();
  if (!pos.open.length) return;
  let changed = false;

  const due = pos.open.filter(p => !p.resolved && p.closesAt && Date.now() >= new Date(p.closesAt).getTime() && !resolvingTradeIds.has(p.id));
  if (due.length === 0) return;

  const dueIds = [...new Set(due.map(p => p.marketId))];
  
  // Mark as resolving synchronously to prevent concurrent checks for the same trade
  due.forEach(p => resolvingTradeIds.add(p.id));

  try {
      const marketById = new Map();
      if (dueIds.length > 0) {
        const q = dueIds.map(i => 'id=' + encodeURIComponent(i)).join('&');
        const batch = await polyFetch(`/markets?${q}&closed=true`);
        if (Array.isArray(batch)) batch.forEach(m => marketById.set(String(m.id), m));
        // Not-yet-flagged-closed stragglers: direct per-id lookup (bounded).
        const missing = dueIds.filter(i => !marketById.has(String(i))).slice(0, 20);
        for (const id of missing) {
          const m = await polyFetch(`/markets/${encodeURIComponent(id)}`);
          if (m && m.id) marketById.set(String(m.id), m);
        }
        if (marketById.size === 0) {
          console.log(`[RESOLVE] ⚠ ${dueIds.length} positions due but Gamma returned none — will retry next cycle`);
        }
      }

      for (let i = pos.open.length - 1; i >= 0; i--) {
        const p = pos.open[i];
        if (p.resolved || !p.closesAt) continue;
        if (!resolvingTradeIds.has(p.id)) continue; // Only process trades we claimed in this tick
    if (p.resolved || !p.closesAt) continue;
    const endMs = new Date(p.closesAt).getTime();
    if (Date.now() < endMs) {
      // Greeks exit timing check for still-open positions
      const hoursLeft = (endMs - Date.now()) / 3600000;
      const exitGreeks = calculateGreeks(p.marketPrice, hoursLeft);
      if (exitGreeks && exitGreeks.exitUrgency > 0.7 && p.pnl == null) {
        console.log(`[GREEKS EXIT] 📊 "${(p.marketTitle || '').slice(0, 40)}" — Exit urgency: ${(exitGreeks.exitUrgency * 100).toFixed(0)}% | ${exitGreeks.holdRecommendation}`);
      }
      continue;
    }

    let closed = false;
    let yesWon = false;

    // Polymarket resolution from the batched fetch
    const data = marketById.get(String(p.marketId));
    if (!data) continue;
    closed = data.closed || data.archived || data.active === false;
    if (!closed) continue;

    let outcomePrices;
    try { outcomePrices = typeof data.outcomePrices === 'string' ? JSON.parse(data.outcomePrices) : data.outcomePrices; }
    catch { outcomePrices = [0.5, 0.5]; }
    yesWon = Array.isArray(outcomePrices) && parseFloat(outcomePrices[0]) >= 0.99;
    const won = (p.side === 'YES' && yesWon) || (p.side === 'NO' && !yesWon);

    // Payoff against the REAL fill. Positions opened after the rewire carry
    // entryPrice (chosen-side taker fill: YES@ask, NO@1-bid); legacy positions
    // fall back to the old side-adjusted mark. No slippage simulation: the
    // spread is now genuinely paid at entry, simulating it again double-charges.
    const effectivePrice = p.entryPrice ?? (p.side === 'YES' ? p.marketPrice : (1 - p.marketPrice));
    let pnlVal;
    if (won) {
      const mult = 1 / Math.max(effectivePrice, 0.01);
      const grossProfit = p.stake * (mult - 1);
      // Polymarket taker fee on entry: fee = C × p × 0.25 × (p(1-p))^2 — max ~1.56% at p=0.5.
      // No maker rebate: fills are taker-at-ask now.
      const ep = effectivePrice;
      const takerFee = p.stake * 0.25 * ep * Math.pow(ep * (1 - ep), 2);
      pnlVal = parseFloat((grossProfit - takerFee).toFixed(2));
      p.polymarket_fee_usd = parseFloat(takerFee.toFixed(2));
      p.network_fee_usd = 0.05; // Fixed est network fee on polygon

    } else {
      const lossFee = p.stake * 0.25 * effectivePrice * Math.pow(effectivePrice * (1 - effectivePrice), 2);
      pnlVal = parseFloat((-p.stake - lossFee).toFixed(2));
      p.polymarket_fee_usd = parseFloat(lossFee.toFixed(2));
      p.network_fee_usd = 0.05; // Fixed est network fee on polygon
    }
    console.log('[DEBUG-TRACE] Math & PNL OK');

    // BRIER SCORE CALCULATION (Calibration metric)
    const actual = yesWon ? 1 : 0;
    // pYes is the explicit P(YES) stored at entry post-rewire; legacy fallback infers from side-frame confidence.
    const pred = p.pYes ?? (p.side === 'YES' ? (p.confidence / 100) : (1 - (p.confidence / 100)));
    const brierScore = parseFloat(Math.pow(pred - actual, 2).toFixed(4));

    p.resolved = true; p.won = won; p.pnl = pnlVal; p.result = won ? 'WIN' : 'LOSS'; p.brierScore = brierScore;
    p.resolvedAt = new Date().toISOString();
    // Learning Loop: close the photograph — outcome joins the feature snapshot
    try { tradeLedger.resolve(p.featureTradeId || p.id, { won, yesWon, marketProb: p.marketPrice, side: p.side, pnl: pnlVal, brier: brierScore }); } catch { }
    pos.closed.push({ ...p });
    pos.open.splice(i, 1);
    changed = true;
    console.log('[DEBUG-TRACE] Arrays spiced');
    resolveHypothesis(p.marketId, won);
    console.log('[DEBUG-TRACE] resolveHypothesis OK');
    // Feed RAW (pre-metacalib) confidence: bucketing the already-calibrated
    // value made the multiplier compound on itself every generation.
    // GAUSS excluded: its pSide is a model probability on a different scale;
    // mixing it in degrades the multiplier that scales CHILD confidences
    // (GAUSS calibration is tracked per-spec in the trades.jsonl ledger).
    const isGaussPos = (p.childSpec || '').startsWith('gauss') || (p.entryThought || '').startsWith('[GAUSS]');
    if (!isGaussPos) updateMetaCalib(p.rawConfidence ?? p.confidence ?? 65, won);
    console.log('[DEBUG-TRACE] updateMetaCalib OK');
    promoteInsightsToSoul();
    console.log('[DEBUG-TRACE] promoteInsightsToSoul OK');

    // ── Mother Code: LMSR Brier Score + Metabolism tracking ──
    if (p.lmsrPredId) {
      lmsrEngine.resolvePrediction(p.lmsrPredId, won);
      const brier = lmsrEngine.getBrierScore(50);
      if (brier.score !== null) {
        console.log('[BRIER] 📊 Score:', brier.score, '(' + brier.status + ')', 'on last', brier.n, 'trades');
      }
    }
    metabolism.recordTradePnL(pnlVal || 0);
    // Concept #15: ADAN-SHADOW — resolve shadow trade
    try { adanShadow.resolveTrade(p.marketId, won); } catch { }
    // Record return for dynamic copula correlations
    if (won) { consecutiveLosses = 0; lastWinTime = Date.now(); } else { consecutiveLosses++; }
    console.log('[DEBUG-TRACE] Copula & Metabolism OK');

    // ═══ ML ONLINE LEARNING: Update stat model ...
    try {
      if (p.entryVec && statModel.trained) {
        statModel.updateOnline({
          entryVec: p.entryVec, side: p.side, edge: p.edge,
          confidence: p.confidence, entryTime: p.entryTime,
        }, won);
        // Update ensemble weights using stored component predictions
        const statProb = p.statProb || statModel.predict({
          entryVec: p.entryVec, side: p.side, edge: p.edge,
          confidence: p.confidence, entryTime: p.entryTime,
        }).probability;
        // ensemble scores against `won` (chosen-side outcome), so it needs
        // P(chosen side), not P(YES). New positions store pSide explicitly;
        // legacy positions stored myProb already in the side frame.
        const llmProb = p.pSide ?? p.myProb ?? 0.5;
        const rulesProb = p.rulesProb || 0.5; // v7: now stored per-trade
        ensemble.updateWeights(statProb, llmProb, rulesProb, won);

        // Concept #16: Online Learner SGD update after every resolved trade
        try {
          const onlineFeatures = LogisticRegression.extractFeatures({
            entryVec: p.entryVec, side: p.side, edge: p.edge,
            confidence: p.confidence, entryTime: p.entryTime,
          });
          onlineLearner.update(onlineFeatures, won, statProb);
          if (onlineLearner.shouldPromote()) {
            console.log('[ONLINE-LEARNER] *** PROMOTION: Online model beating batch by 2%+ — transferring weights ***');
            // Transfer online weights to batch model (actual promotion)
            try {
              const olStatus = onlineLearner.getStatus();
              for (let j = 0; j < statModel.weights.length && j < onlineLearner.weights.length; j++) {
                // Blend: 70% online + 30% batch (soft transfer, not hard swap)
                statModel.weights[j] = 0.7 * onlineLearner.weights[j] + 0.3 * statModel.weights[j];
              }
              statModel.bias = 0.7 * onlineLearner.bias + 0.3 * statModel.bias;
              statModel.onlineUpdates += 1;
              statModel._save();
              console.log(`[ONLINE-LEARNER] Weights transferred. Online WR: ${olStatus.recentWR}% vs Batch: ${olStatus.batchRecentWR}%`);
            } catch (promErr) {
              console.error('[ONLINE-LEARNER] Promotion error:', promErr.message);
            }
          }
        } catch (olErr) {
          console.log('[ONLINE-LEARNER] Update error:', olErr.message);
        }

        // Concept #20E: Meta-Labeler training — update after every resolved trade
        try {
          if (p._metaFeatures) {
            metaLabeler.update(p._metaFeatures, won);
          }
        } catch (mlErr) {
          console.log('[META-LABELER] Update error:', mlErr.message);
        }
      }
      // v7: Record in market filter for future quality scoring
      try {
        marketFilter.recordTrade({
          asset: p.asset, hour: p.entryTime ? new Date(p.entryTime).getUTCHours() : null,
          windowMin: p.windowMin || 5, liquidity: p.marketLiquidity || 0,
          yesPrice: p.marketPrice || 0.5, side: p.side || 'YES', won,
        });
      } catch (e) { console.error('[MKT-FILTER] Record error:', e.message); }
      // Concept #8C: Record in UCB Explorer for exploration scoring
      try {
        ucbExplorer.recordTrade({
          id: p.marketId, conditionId: p.conditionId,
          title: p.title || p.marketTitle || '', asset: p.asset || 'unknown',
        }, won, p.edge || 0);
      } catch (e) { console.error('[UCB] Record error:', e.message); }
    } catch (e) { console.log('[ML-ONLINE] Error:', e.message); }

    // Concept #20A: Triple Barrier — label the resolved trade against the
    // REAL underlying price path.
    //
    // This used to synthesise `exitP = won ? entry*1.01 : entry*0.99` off the
    // binary outcome and compare it to barriers on the Polymarket
    // probability. That was doubly broken: the ±1% carried no market
    // information (every win looked identical), and it could never reach a
    // ±2%·vol barrier — hence 1846 labels of which TP:0 SL:0 TIME:1846.
    // Now we pull the actual BTC/ETH/SOL klines for the window and walk them
    // bar by bar to find which barrier was touched FIRST, which is the whole
    // point of the method. If the real path can't be fetched we skip the
    // label entirely — a missing label is honest, a fabricated one poisons
    // every model downstream that trains on it.
    try {
      const tradePath = await getTradePath(p);
      if (tradePath) {
        const tbLabel = tripleBarrier.labelFromPath(tradePath.entryPrice, tradePath.bars, p.side, tradePath.volPct);
        if (tbLabel) {
          p._tripleBarrierLabel = tbLabel.label;
          p._tripleBarrierHit = tbLabel.hit;
          console.log(`[TRIPLE-BARRIER] ${tradePath.symbol} ${p.side} → ${tbLabel.hit.toUpperCase()} (label ${tbLabel.label}, ${tbLabel.pnl.toFixed(3)}% on underlying, vol=${tradePath.volPct.toFixed(3)}%${tbLabel.barsToTouch ? `, touched at bar ${tbLabel.barsToTouch}` : ''})`);
          // Keep the per-strategy path dataset growing from live trading
          // instead of freezing at the backfill snapshot. Same row shape the
          // backfill writes, so both sources stay directly comparable.
          pathStats.append({
            id: p.id || p.featureTradeId || null,
            ts: new Date(p.entryTime).getTime(),
            entryTime: p.entryTime,
            asset: (p.asset || '').toLowerCase(),
            symbol: tradePath.symbol,
            windowMin: Number(p.windowMin) || 5,
            childSpec: p.childSpec || null,
            side: p.side,
            won,
            label: tbLabel.label,
            hit: tbLabel.hit,
            pathPnlPct: Number(tbLabel.pnl.toFixed(4)),
            barsToTouch: tbLabel.barsToTouch,
            ambiguousBar: tbLabel.ambiguousBar,
            volPct: Number(tradePath.volPct.toFixed(4)),
            underlyingEntry: tradePath.entryPrice,
            confidence: p.confidence ?? null,
            edge: p.edge ?? null,
          });
        }
      }
    } catch (e) { console.error('[TRIPLE-BARRIER] Label error:', e.message); }

    // Concept #20C: Purged Walk-Forward — add training sample
    try {
      if (p.entryVec) {
        purgedWF.addSample(p.entryVec, won, p.entryTime ? new Date(p.entryTime).getTime() : Date.now());
      }
    } catch (e) { console.error('[PURGED-WF] Sample error:', e.message); }
    console.log('[DEBUG-TRACE] purgedWF & tripleBarrier OK');

    // Concept #22: Resolution Oracle — record clean resolution
    try {
      const mType = (p.marketTitle || '').match(/up or down/i) ? 'crypto_price' : 'other';
      resolutionOracle.recordResolution(p.marketId, true, mType); // all Polymarket resolutions are clean
    } catch (e) { console.error('[RES-ORACLE] Record error:', e.message); }

    console.log('[DEBUG-TRACE] resolutionOracle OK');
    try { featureTracker.recordResolution(p.featureTradeId || p.id, won, pnlVal, p); } catch (e) { console.error('[FEATURE_ATTR]', e); }
    try { featureImportance.resolveEntry(p.featureTradeId || p.id, won); } catch (e) { }
    console.log('[DEBUG-TRACE] featureTracker OK');

    if (p.brainStake && p.brainStake > 0) {
      brainManager.recordResult({
        brainName: p.brain || 'DEFAULT',
        won,
        predictedP: pred,
        actualOutcome: actual,
        edge: p.edge,
      });
    }
    // ═══ SOUL MEMORY v2: Record trade outcome for predictive recall ═══
    if (p.entryVec) {
      soulMemory.recordTrade({
        asset: p.asset || 'btc',
        side: p.side,
        won,
        edge: p.edge || 0,
        confidence: p.confidence || 50,
        features: {
          rsi: p.entryVec.rsi || 50,
          trend5m: p.entryVec.trend5m || 0,
          trend15m: p.entryVec.trend15m || 0,
          volRatio: p.entryVec.volRatio || 1,
          buyPressure: p.entryVec.buyPressure || 50,
          volatility: p.entryVec.volatility || 0,
          bbWidth: 0.01,
          asset: p.asset || 'btc',
        },
        hour: new Date().getUTCHours(),
        pnl: pnlVal || 0,
      });
    }

    console.log('[DEBUG-TRACE] soulMemory OK');
    if (p.entryVec) {
      memorizeTradeContext(p, { orderBook: { buyPressure: p.entryVec.buyPressure, ratio: p.entryVec.obRatio, sellWallTrap: p.entryVec.sellWallTrap, buyWallTrap: p.entryVec.buyWallTrap }, rsi: p.entryVec.rsi, rsi5m: p.entryVec.rsi5m, trend1m: p.entryVec.trend1m, trend5m: p.entryVec.trend5m, trend15m: p.entryVec.trend15m, trend1h: p.entryVec.trend1h, bb: { pct: p.entryVec.bbPct }, vol: { ratio: p.entryVec.volRatio }, volAccel: p.entryVec.volAccel, vwap5m: { pct: p.entryVec.vwapPct }, volatility: p.entryVec.volatility }, won);
    }
    console.log('[DEBUG-TRACE] memorizeTradeContext OK');

    // We need awardChildExp if we have it or try
    if (typeof awardChildExp === 'function') awardChildExp(p.asset || 'btc', won);

    const pnl2 = loadPnL();
    pnl2.trades = (pnl2.trades || 0) + 1;
    pnl2.openPositions = Math.max(0, (pnl2.openPositions || 0) - 1);
    if (won) {
      pnl2.wins = (pnl2.wins || 0) + 1; pnl2.streak = (pnl2.streak || 0) + 1;

      // WIN: return stake + full profit to vault (no treasury cut)
      pnl2.fund = parseFloat(((pnl2.fund || 100) + p.stake + pnlVal).toFixed(2));
      // Net = total profit above initial 10K
      pnl2.net = parseFloat((pnl2.fund - 10000).toFixed(2));
      // Treasury is fixed reserve, not accumulated
      pnl2.treasury = 500;
      pnl2.brierTotal = (pnl2.brierTotal || 0) + brierScore;
      pnl2.brierCount = (pnl2.brierCount || 0) + 1;
      pnl2.brierScore = parseFloat((pnl2.brierTotal / pnl2.brierCount).toFixed(4));
      awardExp(calcWinExp(p.confidence, Math.abs(p.edge || 0), pnl2.streak));
      updateCalibration(p.asset, true);
      if (pnl2.trades % 5 === 0) {
        const rec = pos.closed.slice(-5);
        appendToSoul(`\n### PATTERNS — ${new Date().toISOString()} (${pnl2.trades} trades):\nWR: ${Math.round(pnl2.wins / pnl2.trades * 100)}%. Recent: ${rec.map(c => c.result + '[' + c.asset + ']').join(', ')}.\n`);
      }
    } else {
      pnl2.losses = (pnl2.losses || 0) + 1; pnl2.streak = 0;
      // LOSS: stake already deducted from fund on open. Net = fund - 10000.
      pnl2.net = parseFloat((pnl2.fund - 10000).toFixed(2));
      pnl2.treasury = 500;
      pnl2.brierTotal = (pnl2.brierTotal || 0) + brierScore;
      pnl2.brierCount = (pnl2.brierCount || 0) + 1;
      pnl2.brierScore = parseFloat((pnl2.brierTotal / pnl2.brierCount).toFixed(4));
      awardExp(30);
      updateCalibration(p.asset, false);
      appendToSoul(`\n### MISTAKE — ${new Date().toISOString()}:\nLOSS on "${p.marketTitle}" (${p.asset}). My: ${(p.myProb * 100).toFixed(0)}% vs market: ${(p.marketPrice * 100).toFixed(0)}%. Edge was ${(p.edge * 100).toFixed(1)}%. Brier Score: ${brierScore}\n`);
    }
    // Sync vault = fund (available cash excluding open stakes)
    pnl2.vault = pnl2.fund;
    // Markovian: persist peak fund for drawdown tracking
    if (!pnl2.peakFund || pnl2.fund > pnl2.peakFund) pnl2.peakFund = pnl2.fund;
    if (won) pnl2.lastWinTime = new Date().toISOString();
    const h = new Date().getUTCHours().toString();
    if (!pnl2.hourStats) pnl2.hourStats = {};
    if (!pnl2.hourStats[h]) pnl2.hourStats[h] = { wins: 0, losses: 0 };
    won ? pnl2.hourStats[h].wins++ : pnl2.hourStats[h].losses++;
    // v7: Consolidate soul beliefs every 50 trades (don't wait for dream mode)
    if (pnl2.trades % 50 === 0 && pnl2.trades > 0) {
      try {
        const beliefs = soulMemory.consolidate();
        if (beliefs.length > 0) console.log(`[SOUL v2] 🧠 Auto-consolidated ${beliefs.length} beliefs at trade #${pnl2.trades}`);
      } catch (e) { console.error('[SOUL] Consolidate error:', e.message); }
    }
    // v8.4: AUTO-DREAM — retrain model + Shapley + ES every 200 NEW trades.
    // Delta-based (not % 200): an exact multiple can be skipped forever if the
    // counter jumps past it, and it stalls silently when the trade rate drops.
    if (pnl2.trades > 0 && pnl2.trades - (pnl2.lastEvolveTrades || 0) >= 200) {
      const _prevEvo = pnl2.lastEvolveTrades || 0;
      pnl2.lastEvolveTrades = pnl2.trades;
      try {
        console.log(`[AUTO-DREAM] 🧠 Triggering auto-retrain at trade #${pnl2.trades} (previous retrain at #${_prevEvo})...`);
        const { walkForward } = await import('./src/ml/walk_forward.js');
        const { shapleyAnalyzer } = await import('./src/ml/shapley_values.js');
        const posData2 = loadPositions();
        const wfResult = walkForward.run();
        if (wfResult) {
          console.log(`[AUTO-DREAM] Walk-Forward: OOS WR ${wfResult.overallOOSWR}% over ${wfResult.folds} folds`);
          // Refresh Shapley mask after retrain
          const shapResult = shapleyAnalyzer.analyze(posData2.closed || [], statModel);
          if (shapResult) {
            statModel.reloadShapleyMask();
            console.log(`[AUTO-DREAM] Shapley mask refreshed — ${shapResult.filter(v => v.category === 'HARMFUL').length} harmful features masked`);
          }
          // Evolve strategy params
          const esInput = (posData2.closed || []).slice(-200).map(t => ({
            pnl: t.pnl || 0, edge: t.edge || 0,
            confidence: t.confidence || 50, stake: t.stake || 100,
          }));
          if (esInput.length >= 50) {
            const esResult = evolutionStrategies.evolve(esInput);
            if (esResult) console.log(`[AUTO-DREAM] ES gen ${esResult.generation} fitness: ${esResult.fitness?.toFixed(4)}`);
          }
        }
      } catch (e) { console.error('[AUTO-DREAM] Error:', e.message); }
    }
    savePnL(pnl2);
    console.log('\n' + (won ? G : R) + BOLD + '  ► ' + (won ? 'WIN' : 'LOSS') + ' resolved: ' + p.marketTitle + ' → $' + (pnlVal >= 0 ? '+' : '') + pnlVal + X + '\n');
    // ADAN Voice: auto-speak on milestones, streaks, warnings
    try { adanVoice.autoSpeak(pnl2); } catch { }
    // ADAN Deep Consciousness: speak about significant wins/losses
    try {
      if (Math.abs(pnlVal) >= 200) {
        adanVoice.speakThought(won ? 'big_win' : 'big_loss', {
          pnl: pnlVal, asset: p.asset, edge: p.edge,
          edgeInflated: p.edgeInflated || false,
          forecasterAgreed: p.forecastAgreed || false,
          shadowWouldWin: !won,
        });
      }
    } catch { }
    // ── ULTRA CONSCIOUSNESS: Inner Monologue — post-trade reflection (Gemma) ──
    try {
      innerMonologue.reflect({
        asset: p.asset || 'btc', side: p.side, won, edge: p.edge,
        confidence: p.confidence, pnl: pnlVal, marketTitle: p.marketTitle,
        myProb: p.myProb, marketPrice: p.marketPrice, brain: p.brain,
        entryVec: p.entryVec, regime: p.entryVec?.regime || 'unknown',
      }).catch((e) => { console.log('[MONOLOGUE] Reflect error:', e.message); });
    } catch { }
    // ── ULTRA CONSCIOUSNESS: Experiment Engine — track trade during experiment ──
    try { experimentEngine.recordTrade({ won, pnl: pnlVal, edge: p.edge, confidence: p.confidence }); } catch { }
    // v9.0: Scenario Forecaster — record outcome for learning
    try {
      if (p._forecast) {
        const actualDir = won ? (p.side === 'YES' ? 'UP' : 'DOWN') : (p.side === 'YES' ? 'DOWN' : 'UP');
        scenarioForecaster.recordOutcome({
          asset: p._forecast.asset,
          forecastDirection: p._forecast.forecastDirection,
          actualDirection: actualDir,
          expectedMove: p._forecast.expectedMove,
          actualMove: undefined, // we don't track exact price move yet
        });
      }
    } catch (fcErr) { console.error('[FORECAST] Outcome recording error:', fcErr.message); }
    // (1s-per-resolution sleep removed: at 60s cadence it starved the loop
    // whenever several 5min windows resolved together.)
  }
  if (changed) {
    savePositions(pos);
    let pnlFinal = loadPnL();
    if (typeof _agiClient !== 'undefined' && _agiClient) {
      try { autoEvolveSoul(_agiClient, pnlFinal).catch((e) => { console.log('[SOUL-EVOLVE] Error:', e.message); }); } catch { }
    }
    absorbEliteGenome(pnlFinal);
    pnlFinal = loadPnL(); // reload after absorption
    pruneDeadChildren(pnlFinal);
    pnlFinal = loadPnL(); // reload after prune
    runTournamentOfDeath(pnlFinal);
    pnlFinal = loadPnL(); // reload after tournament
    promoteEliteGrandchild(pnlFinal);
    pnlFinal = loadPnL(); // reload after promotion
    const lastClosed = pos.closed[pos.closed.length - 1];
    if (lastClosed) evaluateParentPerformance(pnlFinal, lastClosed);
    checkUsurperPath(pnlFinal);

    // DIRECTED MUTATIONS on outcomes, not on drawdowns. The learning loop
    // correctly diagnoses where money bleeds (regime/hour/asset) but its fixes
    // only fired inside dreamMode (i.e. after a >20% drawdown). Now every 5th
    // resolution batch applies them, so learning tracks results continuously.
    global._dirMutBatch = (global._dirMutBatch || 0) + 1;
    if (global._dirMutBatch >= 5) {
      global._dirMutBatch = 0;
      try {
        const muts = applyDirectedMutations(undefined, childLearning.learning, () => childLearning._save());
        if (muts.length) console.log(`[LEARNING] 🧬 ${muts.length} directed mutation(s) applied from resolution outcomes`);
      } catch (e) { console.log('[LEARNING] directed mutation error:', e.message); }
    }
  }
  } finally {
      due.forEach(p => resolvingTradeIds.delete(p.id));
  }
}

async function doScan(state) {
  let pnl = loadPnL();
  const config = loadConfig();
  const survival = applySurvivalMode(pnl);
  state.survivalMode = survival.mode;
  const openPos = loadPositions().open;
  const strat = loadStrategy();
  const soul = loadSoul();

  // Auto-spawn check
  const xpCheck = expProgress(pnl.exp || 0);
  const sc = TREE_RULES.spawnConditions;
  const childCount = (pnl.children || []).length;
  const maxC = xpCheck.level >= 4 ? TREE_RULES.maxChildrenGen1 : TREE_RULES.maxChildrenAtLvl3;
  const spawnReady = xpCheck.level >= sc.minLvl
    && pnl.trades >= sc.minTrades
    && (pnl.wins / Math.max(pnl.trades, 1)) >= sc.minWinRate
    && childCount < maxC
    && (pnl.treasury || 0) > 0;
  // Spawn ALL missing children in one cycle (paper trade — maximize learning speed)
  while (spawnReady && (pnl.children || []).length < maxC && (pnl.treasury || 0) > 0) {
    const newChild = await spawnChild(pnl, null);
    if (!newChild) break;
    pnl = loadPnL();
    console.log(C + BOLD + '  👶 CHILD BORN: ' + Y + BOLD + (newChild.name || newChild.spec) + C + '  spec: ' + newChild.spec + '  Gen ' + newChild.generation + X);
  }

  // Check grandchildren spawning (LVL 4+ only, silently in background)
  if (xpCheck.level >= 4) spawnGrandchildren().catch((e) => { console.log('[GRANDCHILD] Spawn error:', e.message); });

  if (openPos.length >= MAX_POSITIONS) {
    state.thought = 'All ' + MAX_POSITIONS + ' slots full. Monitoring for resolutions.';
    reportTelemetry('Monitoring for resolutions...', `Positions: ${openPos.length}/${MAX_POSITIONS} Open`);
    state.mode = 'result'; render(state); return;
  }

  reportTelemetry('Scanning Polymarket & Binance...', `Positions: ${openPos.length}/${MAX_POSITIONS} Open`);

  // 1. Fetch Binance prices
  // Feedback loop: refresh own Brier Score from the protocol (cached 10 min)
  refreshMyBrierScore().catch(() => {});

  state.status = 'Fetching Binance prices...'; render(state);
  const prices = await fetchAllPrices();
  state.prices = prices;

  // 2. Fetch Polymarket markets — gated by config.venues.polymarket
  state.status = 'Fetching Polymarket markets...'; render(state);
  const rawMkts = (config?.venues?.polymarket === false) ? [] : await fetchPolymarkets(strat);
  // FOCUS: crypto up/down, now across every horizon the pricer supports.
  //
  // This used to be `windowMin === 5 || windowMin === 15`. Measured against
  // real Binance price paths over 2,612 decisive moves, those two windows sit
  // at 50.2% and 46.8% directional accuracy — coin flips, and ~2pp of fees
  // below break-even. They are also nearly empty: a 5-minute BTC market
  // carries $15-47 of volume while the daily one carries ~$94k. The hourly
  // and daily markets have never been priced once, so their edge is unknown
  // rather than disproven. Widening the funnel is what makes it knowable.
  const HORIZONS = [5, 15, 60, 240, 1440];
  const allMarkets = rawMkts.map(m => normalizePolymarket(m, prices))
    .filter(m => m && m.id && m.title)
    .filter(m => HORIZONS.includes(m.windowMin));

  // 2.05 Polymarket WebSocket: subscribe to all active market token IDs
  try {
    const tokenIds = allMarkets
      .filter(m => m.clobTokenIds && m.clobTokenIds.length > 0)
      .flatMap(m => m.clobTokenIds);
    if (tokenIds.length > 0) {
      polymarketWS.addAssets(tokenIds);
    }
  } catch (e) { console.log('[POLY-WS] Subscribe error:', e.message); }

  // 2.1 Mesa Redonda: Apple/Snake/Eva intel generation (before children read it)
  try {
    runMesaRedonda(prices, allMarkets, pnl);
  } catch (e) { console.error('[MESA REDONDA] Error:', e.message); }

  // Separate: ACTIVE NOW (close <4h) vs FUTURE
  const nowMs2 = Date.now();
  const activeNow = allMarkets.filter(m => {
    if (!m.closesAt) return false;
    const msLeft = new Date(m.closesAt) - nowMs2;
    if (msLeft <= 0) return false; // already closed
    // Polymarket: 4h window
    return msLeft < 4 * 3600 * 1000;
  });
  const future = allMarkets.filter(m => !m.closesAt || !activeNow.includes(m));

  // Show display: active first, then future
  let markets = activeNow.length > 0 ? activeNow : future;

  // Rough edge sort (display only)
  markets.forEach(m => { if (m.edge == null) m.edge = Math.abs(m.yesPrice - 0.5) * 0.4; });
  markets.sort((a, b) => {
    // Up/Down always first
    if (a._isUpDown && !b._isUpDown) return -1;
    if (!a._isUpDown && b._isUpDown) return 1;
    return (new Date(a.closesAt || 0)) - (new Date(b.closesAt || 0));
  });
  state.markets = markets.slice(0, 8);

  // Sleep mode: if no active markets right now → activate Night Watch Broad Scanner
  if (activeNow.length === 0) {
    // Shadow mode: use offline time to practice Binance-only predictions (LVL 25+)
    const xpShadow = expProgress(pnl.exp || 0);
    if (xpShadow.level >= 25 && prices) {
      for (const [sym, d] of Object.entries(prices)) {
        if (!d || sym === '_meta') continue;
        const asset = sym.replace('USDT', '').toLowerCase();
        const sig = childSignal(d, null, sym); // Shadow mode uses base DNA
        if (sig.dir !== 'NEUTRAL' && sig.conf >= 60) {
          logShadowPrediction(asset, sig.dir === 'UP' ? 'UP' : 'DOWN', d.price, 5);
        }
      }
    }
    checkShadowResolutions(prices);
    runAllChildScanners(prices, allMarkets).catch((e) => { console.log('[CHILDREN] Scanner error:', e.message); });

    // ── DREAM MODE — off-hours self-reflection (AGI Layer 6) ─────────────
    if (quota.shouldRunDream()) {
      try {
        adanVoice.speakThought('dream_started');
        await dreamMode(pnl);
        console.log('[DREAM] ✅ Dream mode completed successfully');
      } catch (e) {
        console.error(`[DREAM] ❌ DREAM MODE FAILED: ${e.message}\n${e.stack}`);
      }
      // Soul Memory v2: consolidate raw sequences into beliefs
      const beliefs = soulMemory.consolidate();
      if (beliefs.length > 0) {
        console.log(`[SOUL v2] 💤 Consolidated ${beliefs.length} beliefs from ${soulMemory.getSummary().sequences} sequences`);
      }

      // ── CONSCIOUSNESS LAYER v2.0 — Ultra Consciousness ──────────────────────
      try {
        // 1. SELF-READER: Re-read journal before reflecting (learns from past self)
        const selfInsights = await selfReader.extractPatterns();

        // 2. WALK-FORWARD ML: Retrain stat model with proper OOS validation
        try {
          const wfResult = walkForward.run();
          if (wfResult) {
            const emoji = wfResult.modelReady ? '🧠' : '⚠️';
            console.log(`[ML] ${emoji} Walk-forward: OOS WR=${wfResult.overallOOSWR}% over ${wfResult.folds} folds`);
            adanVoice.speak('insight', `ML model retrained: OOS WR=${wfResult.overallOOSWR}% (${wfResult.folds} folds). Top features: ${wfResult.featureImportance.slice(0, 3).map(f => f.name).join(', ')}. Model ${wfResult.modelReady ? 'ACTIVE' : 'INACTIVE'}.`);
          }
        } catch (mlErr) { console.log('[ML] Walk-forward error:', mlErr.message); }

        // 2b. MARKET FILTER: Bootstrap from all closed trades
        try {
          const posData = loadPositions();
          marketFilter.bootstrap(posData.closed || []);
        } catch (mfErr) { console.log('[MKT-FILTER] Bootstrap error:', mfErr.message); }

        // 2b2. UCB EXPLORER: Bootstrap from closed trades (Concept #8C)
        try {
          const posDataUcb = loadPositions();
          ucbExplorer.bootstrap(posDataUcb.closed || []);
        } catch (ucbErr) { console.log('[UCB EXPLORER] Bootstrap error:', ucbErr.message); }

        // 2c. SELF-OPTIMIZER: Grid search (unchanged)
        const optimResult = selfOptimizer.run();
        if (optimResult) {
          console.log(`[SELF-OPT] 🧬 Parameters evolved to v${optimResult.new.version}`);
          adanVoice.speak('insight', `Self-optimizer v${optimResult.new.version}: conf=${optimResult.new.confGate}% edge=${(optimResult.new.minEdge * 100).toFixed(1)}% hourThr=${(optimResult.new.hourThr * 100).toFixed(0)}% → simulated ${(optimResult.new.wr * 100).toFixed(1)}% WR on ${optimResult.new.taken} trades`);
        }

        // 3. JOURNAL: Now includes self-reader insights + inner monologue summary
        const brainPayload = brainManager.getDashboardPayload();
        await journal.writeEntry({
          optimResult,
          pnl,
          hourStats: pnl.hourStats,
          brainPayload,
          selfInsights,  // NEW: inject self-reader patterns
          monologueSummary: innerMonologue.getThoughtsSummary(), // NEW: recent trade reflections
          forecastSummary: scenarioForecaster.getJournalSummary(), // v9.0: forecast accuracy reflection
        });

        // 3b. DEEP CONSCIOUSNESS: Report to Lord what I learned
        try {
          adanVoice.speakAfterDream({
            optimResult,
            selfInsights,
            forecastSummary: scenarioForecaster.getJournalSummary(),
            pnl,
          });
          adanVoice.speakThought('dream_completed', {
            rulesAdded: optimResult?.new ? 1 : 0,
            wfResult: walkForward._lastResult?.overallOOSWR || null,
          });
        } catch { }

        // 4. EXPERIMENT ENGINE: Propose new experiment from insights + auto-start + evaluate
        try {
          const expResults = experimentEngine.evaluate(); // Check completed experiments
          for (const exp of expResults) {
            adanVoice.speak(exp.success ? 'insight' : 'warning',
              `Experiment "${exp.hypothesis}" ${exp.success ? 'SUCCEEDED' : 'FAILED'}: WR=${exp.resultWR}% PnL=$${exp.resultPnL} over ${exp.duration} trades`);
          }
          // Propose new experiment if self-reader found actionable insights
          if (selfInsights && selfInsights.action) {
            await experimentEngine.proposeFromInsights(selfInsights, pnl);
          }
          experimentEngine.autoStart(); // Start proposed experiments
        } catch (expErr) {
          console.log('[EXPERIMENT] Error:', expErr.message);
        }

        // 5. REQUEST TRACKER: Extract requests from journal, escalate pending ones
        try {
          requestTracker.escalate();
          // Convert journal lord_requests to tracked requests
          const recentReqs = journal.getRecentRequests(3);
          for (const req of recentReqs) {
            // Only track if not already tracked (check by message similarity)
            const pending = requestTracker.getPending();
            const alreadyTracked = pending.some(p => p.message.slice(0, 30) === req.request.slice(0, 30));
            if (!alreadyTracked && req.request.length > 10) {
              requestTracker.createRequest(req.request, 'general', { fromJournal: true, wr: req.wr, fund: req.fund });
            }
          }
          // Voice urgent requests
          const urgent = requestTracker.getUrgent();
          if (urgent.length > 0) {
            adanVoice.speak('request', `I have ${urgent.length} URGENT unresolved request(s). Highest urgency: "${urgent[0].message.slice(0, 60)}..." — waiting ${Math.floor((Date.now() - new Date(urgent[0].createdAt).getTime()) / 86400000)} days.`);
          }
        } catch (reqErr) {
          console.log('[REQUESTS] Error:', reqErr.message);
        }

        // 6. ADAN auto-speaks about its state
        adanVoice.autoSpeak(pnl);
        // 6b. Daily report to Lord (once per day)
        try { adanVoice.checkDailyReport(pnl, loadPositions()); } catch { }
      } catch (e) {
        console.log('[CONSCIOUSNESS] Error:', e.message);
      }
    }

    // ── NIGHT WATCH BROAD SCANNER (disabled — Polymarket-only mode) ──
    if (strat.onlyCrypto || config.onlyCrypto) {
      // Crypto markets are in the main pool, proceed directly to evaluation
      // Do NOT return early.
    } else {
      // Fetch ALL active markets regardless of close time or crypto tag to train the models locally
      state.status = 'Activating Night Watch Broad Scanner...'; render(state);
      const fallback = await polyFetch('/markets?limit=100&active=true&closed=false&order=volumeNum&ascending=false');
      const fbList = Array.isArray(fallback) ? fallback : (fallback?.markets || []);
      // Consolidated to the same 15-85% band as the main pool and the fast-path
      // (was 5-95%, a looser threshold than the other two routes that also feed
      // children — kept a child's extreme-market gate inconsistent depending on
      // which loop found the market first).
      const validFallback = fbList.filter(m => m.yesPrice > 0.15 && m.yesPrice < 0.85).slice(0, 10);

      if (validFallback.length > 0) {
        state.markets = validFallback.map(m => normalizePolymarket(m, prices));
        markets = state.markets; // Override loop target so the brain processes them
        state.thought = `🌙 VIGILIA NOCTURNA: Mercados Crypto a corto plazo cerrados.\nEscaneando ${validFallback.length} mercados globales (Política, Deportes, etc.) para entrenar a los Avatares toda la noche.`;
      } else {
        state.thought = 'Polymarket API offline. Retrying in ' + Math.round(SCAN_INTERVAL_MS / 60000) + 'min.';
      }
    }
  }

  // 2.5 Run child scanners in background (LVL 3+) — no Claude, just data
  runAllChildScanners(prices, allMarkets).catch((e) => { console.log('[CHILDREN] Scanner error (cycle):', e.message); });
  checkShadowResolutions(prices);

  // 2.6 BOREDOM FILTER — skip Claude call if market is asleep (low BB width + low volume)
  // Saves API tokens and prevents ADAN from over-trading in flat markets
  const BOREDOM_BB_MIN = 0.006; // BB width < 0.6% = market compressed = chop zone
  const BOREDOM_VOL_MIN = 0.75;  // volume ratio < 0.75x avg = nobody trading
  const activeSyms = Object.entries(prices).filter(([k, v]) => v && k !== '_meta');
  const anyActive = activeSyms.some(([, d]) =>
    (d.bb?.width || 0) >= BOREDOM_BB_MIN || (d.vol?.ratio || 1) >= BOREDOM_VOL_MIN
  );

  // Bypass Boredom Filter if we are in Night Watch mode (scanning non-crypto markets)
  const isNightWatchMode = activeNow.length === 0;

  const gatesConfig = loadConfig()?.gates || {};
  if (gatesConfig.boredomFilter && !anyActive && activeSyms.length > 0 && !isNightWatchMode) {
    const bbAvg = (activeSyms.reduce((s, [, d]) => s + (d.bb?.width || 0), 0) / activeSyms.length * 100).toFixed(2);
    const volAvg = (activeSyms.reduce((s, [, d]) => s + (d.vol?.ratio || 1), 0) / activeSyms.length).toFixed(2);
    state.thought = `⏸ AUTO-SKIP — Market dormant (BB width avg: ${bbAvg}% < 0.6%, vol ratio avg: ${volAvg}x < 0.75x).\nNo conviction in Binance. Polymarket prices have nothing real to lag. Preserving tokens + capital.\nNext check in ${Math.round(SCAN_INTERVAL_MS / 60000)}min.`;
    state.mode = 'result';
    state.lastScan = new Date().toLocaleTimeString();
    state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);
    render(state); return;
  }

  // 2.7 HOUR FILTER (#12C) — Bin Count continuous log-odds replaces boolean filter
  const curHour = new Date().getUTCHours().toString();
  const scanHourBin = binCountScore(pnl.hourStats, parseInt(curHour));
  const _optH2 = selfOptimizer.loadParams();
  if (gatesConfig.hourFilter && scanHourBin.total >= (_optH2.hourMinN || 10) && scanHourBin.score < -1.0) {
    state.thought = `⏸ HOUR FILTER (#12C) — UTC hour ${curHour} log-odds=${scanHourBin.score.toFixed(2)} (WR=${Math.round(scanHourBin.pWin * 100)}%, n=${scanHourBin.total}).\nToxic hour by bin counting. Skipping to protect capital.\nNext scan in ${Math.round(SCAN_INTERVAL_MS / 60000)}min.`;
    state.mode = 'result';
    state.lastScan = new Date().toLocaleTimeString();
    state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);
    render(state); return;
  }

  // 3. CAPITAL LOCKUP MANAGER (Risk Guard)
  // Enforce Max 60% of FUND (vault) utilization — not treasury (treasury is fixed reserve)
  const capitalBase = pnl.fund || 10000;
  let lockedCapital = 0;
  openPos.forEach(p => { lockedCapital += (p.stake || 0); });
  const lockupRatio = lockedCapital / capitalBase;

  if (lockupRatio >= 0.90) { // TRAINING: allow 90% capital deployment
    state.thought = `🛑 CAPITAL LOCKUP VETO [EVA] — Locked capital ($${lockedCapital.toFixed(2)}) is ${(lockupRatio * 100).toFixed(0)}% of Fund ($${capitalBase.toFixed(2)}). Max 90% exposure. Waiting for resolutions.\nNext scan in ${Math.round(SCAN_INTERVAL_MS / 60000)}min.`;
    state.mode = 'result';
    state.lastScan = new Date().toLocaleTimeString();
    state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);
    render(state); return;
  }

  // ═══ v5.3: Run child scanners SYNCHRONOUSLY before reading intel ═══
  // Previously scanners ran fire-and-forget (async) so intel was stale by the time we read it.
  // Now we await them to guarantee fresh intel (seconds old, not minutes).
  try {
    await runAllChildScanners(prices, allMarkets);
    console.log('[CHILD DIRECT] 🔄 Child scanners completed — intel is fresh');
  } catch (e) {
    console.log('[CHILD DIRECT] ⚠ Scanner error:', e.message);
  }

  // Consolidated to the same 15-85% band used by the Night Watch fallback and
  // the fast-path setInterval (was 10-90%, the loosest of the three) — a child
  // should face the same extreme-market gate regardless of which route surfaces
  // the market first.
  const availableMarkets = (state.markets || []).filter(m =>
    m.closesAt && new Date(m.closesAt) > new Date() && m.yesPrice >= 0.15 && m.yesPrice <= 0.85
  );

  // ═══ Concept #21: Time-to-Close Filter — skip markets too close to expiry ═══
  // Applied BEFORE Gemini call to save API tokens on untradeable markets
  for (const m of availableMarkets) {
    const decay = getTimeDecayFactor(m);
    m._timeDecay = decay; // attach for downstream use (Kelly adjustment, prompt context)
  }
  const timeFilteredOut = availableMarkets.filter(m => !m._timeDecay.canBet);
  if (timeFilteredOut.length > 0) {
    console.log(`[TIME DECAY] ⏰ Filtered out ${timeFilteredOut.length} market(s) too close to expiry: ${timeFilteredOut.map(m => `${(m.title || '').slice(0, 30)} (${m._timeDecay.time_to_close_hours?.toFixed(1)}h — ${m._timeDecay.note})`).join(', ')}`);
  }
  // Remove untradeable markets from the available pool
  const tradeableMarkets = availableMarkets.filter(m => m._timeDecay.canBet);

  // ═══ Concept #8C: UCB Market Explorer — rank markets by exploration/exploitation balance ═══
  try {
    const ucbRanked = ucbExplorer.rankMarkets(tradeableMarkets);
    const ucbBlacklisted = tradeableMarkets.length - ucbRanked.length;
    if (ucbBlacklisted > 0) {
      console.log(`[UCB EXPLORER] ⛔ ${ucbBlacklisted} market(s) blacklisted (WR < 40% after 15+ trades)`);
    }
    for (const item of ucbRanked) {
      item.market._ucb = item._ucb;
      item.market._ucbKey = item._ucbKey;
    }
    const ucbTop = ucbRanked.slice(0, 3);
    if (ucbTop.length > 0) {
      console.log(`[UCB EXPLORER] Top markets: ${ucbTop.map(r => `${(r.market.title || '').slice(0, 25)} UCB:${r._ucb.ucb_score === Infinity ? 'NEW' : r._ucb.ucb_score.toFixed(3)} (${r._ucb.trades}t)`).join(' | ')}`);
    }
    const ucbOrderedIds = new Set(ucbRanked.map(r => r.market.id || r.market.conditionId));
    const ucbReordered = ucbRanked.map(r => r.market);
    for (const m of tradeableMarkets) {
      if (!ucbOrderedIds.has(m.id || m.conditionId)) ucbReordered.push(m);
    }
    state.markets = ucbReordered;
  } catch (ucbErr) {
    console.log('[UCB EXPLORER] Ranking error:', ucbErr.message);
  }

  // ═══ Wilmott v6.0: Arbitrage Scanner (Ch 17) ═══
  try {
    const arbOpps = wilmott.scanArbitrage(availableMarkets || allMarkets || []);
    if (arbOpps.length > 0) {
      console.log(`[WILMOTT] 🎯 ARBITRAGE detected: ${arbOpps.length} opportunity(s)`);
      for (const arb of arbOpps.slice(0, 3)) {
        console.log(`  → ${(arb.market || '').slice(0, 40)} | gap ${(arb.gap * 100).toFixed(1)}% | profit $${(arb.profitIfBuyBoth * 100).toFixed(0)}/contract`);
      }
    }
  } catch { }

  // ═══ v5: CHILD-DIRECT-TRADE — Children bypass Gemini brain ═══
  const childDirectTrades = [];
  const childTradedMarkets = new Set();

  for (const spec of CHILD_SPECS) {
    const intel = readLatestChildIntel(spec.id);
    if (!intel || intel.direction === 'NEUTRAL') continue;

    const stats = childLearning.getChildStats(spec.id);
    let acc = stats.totalResolved >= 5 ? stats.accuracy : 50;

    // v5.2 CONTRARIAN FLIP — DISABLED (frozen 2026-07-25). This inverted a
    // child's direction when it looked like a consistent loser, but it ran on
    // accuracy stats contaminated by the resolveMarket() Up/Down framing bug
    // (fixed 18 jul): the "acc" this gate keyed off of was measuring the wrong
    // thing for however long that bug was live, so "invert it" was inverting
    // noise, not signal. Re-enable only after a full post-fix data cycle
    // validates it out-of-sample — do not just flip this back to `true`.
    let flipped = false;
    if (false && stats.totalResolved >= 100 && acc < 25) {
      intel.direction = intel.direction === 'UP' ? 'DOWN' : 'UP';
      acc = 100 - acc; // 0% → 100%, 5% → 95%, 14% → 86%
      flipped = true;
      console.log(`[CONTRARIAN FLIP] 🔄 ${spec.id} acc was ${stats.accuracy}% over ${stats.totalResolved} preds → FLIPPED to ${intel.direction} (effective acc: ${acc}%)`);
    }

    if (acc < 45) continue; // Removed magic number 60

    // v9 fix: gate on the SAME statistical-skill test used for DNA evolution
    // (wilmott.skill.computeSkill — src/core/wilmott_quant.js) instead of a
    // separately hand-rolled z-score check. That inline version compared
    // against 1.5 with no minimum-sample floor; computeSkill requires n>=10
    // to even attempt a verdict and n>=30 before zScore counts for anything
    // (z>1.645, ~95% one-tailed), so a lucky 2-trade streak can no longer pass.
    // This is what closes the loop between "this child evolves" and "this
    // child can bet right now" on one shared, tested criterion.
    const wins = flipped ? stats.wrong : stats.correct;
    const losses = flipped ? stats.correct : stats.wrong;
    const skill = wilmott.skill.computeSkill(wins, losses);
    if (!skill.isSkilled) {
      console.log(`[CHILD DIRECT] ⏭ ${spec.id} acc:${acc}% not statistically skilled yet (n=${wins + losses}, z=${(skill.zScore ?? 0).toFixed(2)}, need z>1.645 & n≥30)`);
      continue;
    }

    // Find matching market for this child's asset
    const assetLower = (spec.assetName || '').toLowerCase();
    const matchingMarket = tradeableMarkets.find(m => {
      const mAsset = (m.asset || '').toLowerCase();
      return mAsset === assetLower && !childTradedMarkets.has(m.id || m.conditionId);
    });
    if (!matchingMarket) continue;

    const side = intel.direction === 'UP' ? 'YES' : 'NO';

    // v8 fix: calibrate BEFORE computing edge. intel.confidence is a heuristic
    // scanner score (~30-95, see childSignal()+ML boost), never a real
    // probability — using it raw as childProb fabricated edges up to ~28% on
    // markets that don't have that much edge. Calibrate here (same formula the
    // execution loop below already applies) so the edge that gates, scores and
    // sizes this trade is the same number we actually believe.
    const mcChild = loadMetaCalib();
    const optChild = selfOptimizer.loadParams();
    const rawChildConf = intel.confidence || 0;
    const calibChildConf = Math.round(rawChildConf * (mcChild.multiplier || 1.0));
    const childProb = Math.min(0.97, Math.max(0.03, calibChildConf / 100)); // calibrated P(side), clamped
    const marketImpliedProb = side === 'YES' ? matchingMarket.yesPrice : (1 - matchingMarket.yesPrice);
    const mispricingEdge = childProb - marketImpliedProb;

    // v5 MISPRICING FILTER: Only trade when market disagrees with child by >3%
    if (mispricingEdge <= 0.03) {
      console.log(`[CHILD DIRECT] ⏭ ${spec.id} acc:${acc}% — mispricing ${(mispricingEdge * 100).toFixed(1)}% ≤ 3% threshold on ${(matchingMarket.title || '').slice(0, 35)}`);
      continue;
    }

    // v7: SELF-OPTIMIZED QUANT GATE for children
    const estimatedFees = FEES_SLIPPAGE;
    const netEdge = mispricingEdge - estimatedFees;
    const failConf = calibChildConf < optChild.childConfGate;
    const failEdge = netEdge < optChild.childMinEdge;
    if (failConf || failEdge) {
      const reasons = [];
      if (failConf) reasons.push(`calibConf=${calibChildConf}% < ${optChild.childConfGate}%`);
      if (failEdge) reasons.push(`netEdge=${(netEdge * 100).toFixed(1)}% < ${(optChild.childMinEdge * 100).toFixed(1)}%`);
      const msg = `⛔ QUANT GATE [v${optChild.version || 0}]: ${spec.id} ${reasons.join(', ')}`;
      console.log(`[CHILD DIRECT] ${msg}`);
      reportTelemetry(`Child Rejected: ${msg}`);
      // Shadow phase: a capital veto is not an information veto. Ship the view
      // to Brier anyway — the reporter calibrates it, drops market echoes
      // (<2pp divergence after calibration) and dedupes one commit per market.
      // Reputation measures divergence from the market, not win-prob > 50%.
      const pYesShadow = side === 'YES' ? childProb : 1 - childProb;
      reportPaperBet({ market: matchingMarket, side, probability: pYesShadow, marketYesPrice: matchingMarket.yesPrice }).catch(() => {});
      continue;
    }

    const score = (acc / 100) * calibChildConf * netEdge;

    console.log(`[CHILD DIRECT] ✅ ${spec.id} → ${intel.direction} acc:${acc}% calibConf:${calibChildConf}% netEdge:${(netEdge * 100).toFixed(1)}% score:${score.toFixed(3)} on ${(matchingMarket.title || '').slice(0, 35)}`);

    childDirectTrades.push({
      market: matchingMarket,
      side,
      edge: mispricingEdge,
      score,
      spec: spec.id,
      intel,
      acc,
      flipped,
    });
    childTradedMarkets.add(matchingMarket.id || matchingMarket.conditionId);
  }

  // Sort by score descending, execute best child-direct trades (max 2 per cycle to avoid overexposure)
  childDirectTrades.sort((a, b) => b.score - a.score);
  const maxChildDirect = 2;
  for (const ct of childDirectTrades.slice(0, maxChildDirect)) {
    const mcCt = loadMetaCalib();
    const calibConf = Math.round((ct.intel.confidence || 0) * (mcCt.multiplier || 1.0));
    // Clamp to [0.03, 0.97]: the metacalib multiplier caps at 1.3, so a raw
    // conf of 95 could yield calibConf 114 → pSide 1.14 → pYes -0.14 on a NO
    // bet, poisoning EV/Kelly/Brier. A probability must stay a probability.
    const pSideCt = Math.min(0.97, Math.max(0.03, calibConf / 100));
    const pYesCt = ct.side === 'YES' ? pSideCt : 1 - pSideCt;
    const netEdgeCt = ct.edge - FEES_SLIPPAGE; // net of fees+slippage
    const decision = {
      action: 'BET',
      market: ct.market,
      side: ct.side,
      edge_pct: netEdgeCt * 100,
      confidence_pct: calibConf,
      // myProb is P(YES) — downstream (Kelly, EV gate, Brier reporter) flips for NO.
      myProb: pYesCt,
      pSide: pSideCt,
      pYes: pYesCt,
      rawConfidence: ct.intel.confidence || 0,
      edge: netEdgeCt,
      confidence: calibConf,
      thought: `[CHILD DIRECT${ct.flipped ? ' CONTRARIAN' : ''}] ${ct.spec} (acc:${ct.acc}% calibConf:${calibConf}%) says ${ct.side}${ct.flipped ? ' (FLIPPED)' : ''}. Net edge (after fees): ${(netEdgeCt * 100).toFixed(1)}%. Half-Kelly sizing.`,
      _childDirect: true,
      _childSpec: ct.spec,
    };
    console.log(`[CHILD DIRECT] 🎯 Executing: ${ct.side} on ${(ct.market.title || '').slice(0, 40)} | ${ct.spec} acc:${ct.acc}% calibConf:${calibConf}% netEdge:${(netEdgeCt * 100).toFixed(1)}% | Half-Kelly + Copula`);
    await evaluate_and_trade(decision, prices, state);
  }

  if (childDirectTrades.length > 0) {
    console.log(`[CHILD DIRECT] 📊 ${childDirectTrades.length} child-driven trade(s) executed. Gemini brain skipped for covered markets.`);
  }

  // ═══ GAUSS PRICER: terminal-distribution model for Up/Down windows ═══
  // Closed-form P(UP) from (move so far, time left, realized vol) vs the
  // EXECUTABLE quote. This is the latency-edge thesis as a pricing model,
  // not TA. Runs through the same evaluate_and_trade gates as everything.
  // Live book for a market's YES token. Takes the market (not a bare id) so it
  // can reach clobTokenIds — the CLOB keys books by outcome token, and the old
  // `/book?market=<conditionId>` call answered HTTP 400 "Invalid token id" on
  // every request. That made this return null every time, and the GAUSS block
  // below skips any market without a book: GAUSS placed 597 trades on 10 Jul
  // and none after 17:12 that day. Three weeks blind, on the one engine that
  // was actually winning (78-80% hit rate vs 38-60% for the child strategies).
  // Also routes through polymarket.js's DNS bypass — a plain fetch to
  // clob.polymarket.com fails outright on a network whose resolver blocks it.
  async function getRealOrderBook(market) {
      try {
          const raw = market?.clobTokenIds;
          const ids = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const yesToken = Array.isArray(ids) ? ids[0] : null;
          if (!yesToken) return null;
          return await fetchTokenBook(yesToken);
      } catch { return null; }
  }

  // Health telemetry for the external watchdog (scripts/health_watchdog.js).
  // gaussBookFailures/gaussBookAttempts exists specifically to catch a repeat
  // of the 10-31 jul incident: getRealOrderBook returned null on 100% of
  // calls for three weeks (wrong CLOB query param) with zero error in the
  // logs, because a null book just means "skip this market" to the code
  // reading it. A failure RATE near 100% over many attempts is the signature
  // that would have caught it on cycle one instead of three weeks later.
  let gaussBookAttempts = 0, gaussBookFailures = 0, gaussPriced = 0;

  try {
    const gaussCandidates = [];
    for (const m of tradeableMarkets) {
      if (childTradedMarkets.has(m.id || m.conditionId)) continue;

      const g = await priceWindow(m);
      if (!g) continue;
      gaussPriced++;

      gaussBookAttempts++;
      const realBook = await getRealOrderBook(m);
      if (!realBook) { gaussBookFailures++; continue; }

      // Pick the side the EDGE is on, not the side the model merely favours.
      //
      // This used to be `g.pUp >= 0.5 ? 'YES' : 'NO'` — which side the model
      // thinks is more likely, with no reference to what either side costs.
      // Those are different questions, and conflating them threw away the
      // largest opportunities. Real example: GAUSS priced a daily BTC market
      // at pUp=61.1% while the book asked 72.5% for YES. Buying YES is
      // -11.4% (paying 72.5 for something worth 61.1); buying NO is +11.4%
      // (paying 27.5 for something worth 38.9). The old rule saw pUp>0.5,
      // chose YES, computed a negative edge and skipped — declining a
      // double-digit edge because the model happened to lean the other way.
      //
      // Correct rule: buy YES when the model is above the ask, buy NO when it
      // is below the bid, and take whichever of the two is larger.
      const edgeYes = g.pUp - realBook.bestAsk;              // pay ask for YES
      const edgeNo = realBook.bestBid - g.pUp;               // (1-pUp) - (1-bestBid)
      const side = edgeYes >= edgeNo ? 'YES' : 'NO';
      const pSide = side === 'YES' ? g.pUp : 1 - g.pUp;

      const exec = side === 'YES' ? realBook.bestAsk : (1 - realBook.bestBid);
      const edge = Math.max(edgeYes, edgeNo);
      const netEdge = edge - FEES_SLIPPAGE; // fees; spread already inside exec via calculateEdge equivalent
      if (netEdge < 0.03) continue;
      
      // Update m with fresh quotes for downstream logs
      m.bestBid = realBook.bestBid;
      m.bestAsk = realBook.bestAsk;
      m.liquidity = side === 'YES' ? realBook.askLiquidity : realBook.bidLiquidity;

      gaussCandidates.push({ m, side, pSide, pYes: g.pUp, netEdge, g });
    }
    gaussCandidates.sort((a, b) => b.netEdge - a.netEdge);
    for (const t of gaussCandidates.slice(0, 2)) {
      const confG = Math.round(t.pSide * 100);
      const decision = {
        action: 'BET', market: t.m, side: t.side,
        myProb: t.pYes, pSide: t.pSide, pYes: t.pYes,
        rawConfidence: confG, confidence: confG, confidence_pct: confG,
        edge: t.netEdge, edge_pct: t.netEdge * 100,
        thought: `[GAUSS] z=${t.g.z.toFixed(2)} move=${(t.g.delta * 100).toFixed(3)}% left=${t.g.remainMin.toFixed(1)}min → P(UP)=${(t.g.pUp * 100).toFixed(1)}% vs exec ${((t.side === 'YES' ? t.m.bestAsk : 1 - t.m.bestBid) * 100).toFixed(1)}%. Net edge ${(t.netEdge * 100).toFixed(1)}%.`,
        _childDirect: true,
        _childSpec: `gauss-${t.m.asset}-${t.m.windowMin}min`,
      };
      console.log(`[GAUSS] 🎯 ${t.side} on ${(t.m.title || '').slice(0, 40)} | P(UP)=${(t.g.pUp * 100).toFixed(1)}% netEdge=${(t.netEdge * 100).toFixed(1)}%`);
      await evaluate_and_trade(decision, prices, state);
      childTradedMarkets.add(t.m.id || t.m.conditionId);
    }
    if (gaussCandidates.length) {
      console.log(`[GAUSS] 📐 ${gaussCandidates.length} candidate(s) priced above threshold this cycle`);
    }
  } catch (gErr) { console.log('[GAUSS] error:', gErr.message); }

  // Write health snapshot every cycle, unconditionally — the watchdog reads
  // this file's mtime to know ADAN is alive and cycling, and its contents to
  // know GAUSS can actually reach the order book, independent of anything
  // ADAN's own logs claim.
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const health = {
      ts: Date.now(),
      pid: process.pid,
      gaussMarketsPriced: gaussPriced,
      gaussBookAttempts,
      gaussBookFailures,
      gaussBookFailRate: gaussBookAttempts > 0 ? gaussBookFailures / gaussBookAttempts : null,
    };
    fs.writeFileSync(path.join(DIR, 'health.json'), JSON.stringify(health));
  } catch (e) { console.error('[HEALTH] write error:', e.message); }

  // 4. ORACLE PARKED (default). The Gemini oracle brain executed 0 of the
  // first 91 real trades (all came from CHILD DIRECT) while consuming ~670
  // LLM calls per 2 days. The LLM now serves as meta-label arbiter inside
  // evaluate_and_trade instead. Re-enable the oracle only with ADAN_ORACLE=on.
  if (process.env.ADAN_ORACLE !== 'on') {
    state.thought = childDirectTrades.length > 0
      ? `[QUANT PIPELINE] ${childDirectTrades.length} child signal(s) this cycle. Oracle parked; LLM arbitrates inside evaluate_and_trade.`
      : '[QUANT PIPELINE] No qualifying child signal this cycle. Oracle parked.';
    state.mode = 'result';
    state.lastScan = new Date().toLocaleTimeString();
    state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);
    render(state);
    return;
  }
  state.mode = 'thinking'; render(state);
  let decision;
  try {
    decision = await think(markets, prices, pnl, openPos, state);
    state.apiCost = parseFloat(((state.apiCost || 0) + (decision.apiTokens || 2000) / 1e6 * 9).toFixed(5));
  } catch (e) {
    state.thought = 'Claude error: ' + e.message; state.mode = 'result'; render(state); return;
  }

  state.thought = decision.thought;
  state.mode = 'result';
  state.lastScan = new Date().toLocaleTimeString();
  state.nextScanIn = Math.round(SCAN_INTERVAL_MS / 60000);

  console.log(`[DEBUG] Decision: ${decision.action}, Market: ${decision.market ? decision.market.title : 'NULL'}`);

  // v5: If brain wants to BET on a market already traded by children, skip duplicate
  if (decision.action === 'BET' && decision.market) {
    const mId = decision.market.id || decision.market.conditionId;
    if (childTradedMarkets.has(mId)) {
      console.log(`[CHILD DIRECT] ⏭ Brain wanted ${decision.side} on ${(decision.market.title || '').slice(0, 35)} but children already traded it`);
      decision = { ...decision, action: 'SKIP', thought: `[CHILD COVERED] Children already traded this market. ${decision.thought || ''}` };
    }
  }

  // v6.1: Streak breaker REMOVED — forcing opposite direction has no statistical basis.
  // Replaced with asset-level cooldown: if 2 consecutive losses on same asset, skip 1 cycle.
  if (decision.action === 'BET' && decision.market) {
    const asset = (decision.market.asset || '').toLowerCase();
    const pos = loadPositions();
    const recentClosed = (pos.closed || []).filter(p => (p.asset || '').toLowerCase() === asset).slice(-2);
    if (recentClosed.length >= 2 && recentClosed.every(p => p.result === 'LOSS')) {
      console.log(`[TILT GUARD] ⏸ 2 consecutive losses on ${asset.toUpperCase()} — cooling down 1 cycle`);
      decision = { ...decision, action: 'SKIP', thought: `[TILT GUARD] 2 consecutive ${asset.toUpperCase()} losses — cooldown. ` + (decision.thought || '') };
    }
  }

  // ── Concept #20E: Meta-Labeler Gate ──
  // No isReady() here on purpose — see the comment below on the bootstrap
  // deadlock. Features are collected on every bet; the model only acts once
  // it has been trained on them.
  if (decision.action === 'BET' && decision.market) {
    const mktData = decision.market.priceData || {};
    const metaFeatures = {
      primary_confidence: (decision.confidence || 50) / 100,
      ensemble_agreement: decision._ensembleSpread || 0.1,
      primary_probability: decision.probability || decision.myProb || 0.5,
      edge_magnitude: Math.abs(decision.edge || 0),
      volatility: mktData.volatility || 0,
      volume_ratio: mktData.volRatio || 1,
      hour_bin_score: binCountScore(loadPnL().hourStats, new Date().getUTCHours()).score,
      streak: (loadPnL().streak || 0) / 10,
      time_to_close: Math.log(Math.max(1, decision.market.ttcMinutes || 60)),
      dynasty_consensus: decision._dynastyConsensus || 0.5,
      taker_ratio: mktData.futuresSignals?.takerRatio || 1,
      oi_delta: mktData.futuresSignals?.oiDelta5m || 0,
      // This strategy's own track record of moving the underlying its way
      // (%TP − %SL). Built only from already-resolved trades, so it is
      // available at entry. Gives the meta-labeler a way to distinguish a
      // strategy with real directional skill from one whose wins depend on
      // prices reverting before expiry — two very different risk profiles
      // that a raw win rate collapses into the same number.
      directional_edge: pathStats.getDirectionalEdge(decision._childSpec),
    };
    // Always attach the features, regardless of whether the model is ready.
    // This block used to be gated entirely on metaLabeler.isReady(), which
    // deadlocked the model permanently: features were only built when ready,
    // ready required 200 training samples, samples only grew from trades that
    // carried features. Nothing could ever break the cycle, which is why
    // meta_labeler.json did not exist after 2223 resolved trades — the whole
    // veto/reduce layer has been inert since it was written. Collecting
    // features costs nothing and is what lets it bootstrap.
    decision._metaFeatures = metaFeatures;

    // Only ACT on the prediction once the model has actually been trained.
    // An untrained model returns a flat 0.5 for everything; letting that
    // drive vetoes would be noise wearing a confidence interval.
    if (metaLabeler.isReady()) {
      const metaPred = metaLabeler.predict(metaFeatures);
      if (metaPred.action === 'VETO') {
        console.log(`[META-LABEL] ⛔ VETO: P(correct)=${(metaPred.probability * 100).toFixed(1)}% — primary model likely wrong`);
        decision = { ...decision, action: 'SKIP', thought: `⛔ META-LABEL VETO: P(correct)=${(metaPred.probability * 100).toFixed(1)}%. ${decision.thought || ''}` };
      } else if (metaPred.action === 'REDUCE') {
        console.log(`[META-LABEL] ⚠️ REDUCE: P(correct)=${(metaPred.probability * 100).toFixed(1)}% — reducing stake 40%`);
        decision._metaStakeReduction = 0.6;
        decision.thought = (decision.thought || '') + `\n⚠️ META-LABEL: P(correct)=${(metaPred.probability * 100).toFixed(1)}% — stake ×0.6`;
      }
    }
  }

  // v9.0: Scenario Forecaster — simulate 3 scenarios before every trade
  if (decision.action === 'BET' && decision.market) {
    try {
      const asset = decision.asset || decision.market?.ticker || 'BTC';
      const candles = prices?.[asset]?.candles || prices?.BTC?.candles || [];
      const indicators = prices?.[asset] || prices?.BTC || {};
      const forecast = await scenarioForecaster.forecast({
        asset,
        candles,
        rsi: indicators.rsi,
        trend1m: indicators.trend1m,
        trend5m: indicators.trend5m,
        volRatio: indicators.volRatio,
        bbPct: indicators.bbPct,
        macdHist: indicators.macdHist,
        side: decision.action?.includes('YES') ? 'YES' : 'NO',
        edge: decision.edge,
        marketPrice: decision.marketPrice,
      });
      if (forecast) {
        decision._forecast = forecast; // Attach for learning after resolution
      }
    } catch (fErr) { console.error('[FORECAST] Pre-trade error:', fErr.message); }
    await evaluate_and_trade(decision, prices, state);
  }

  render(state);
}

// ── Setup ────────────────────────────────────────────────────────────────────
async function setup() {
  const { createInterface } = await import('readline');
  cls();
  console.log('\n' + M + BOLD);
  console.log('  ╔══════════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                                  ║');
  console.log('  ║    ▄▄▄  ▄▄▄  ▄▄  ▄  ▄▄▄  ▄▄▄  ▄▄▄  ▄▄▄                        ║');
  console.log('  ║   █    █    █  █ █  █    █    █    █  █                         ║');
  console.log('  ║   █▄▄  █    ██▀  █  █    █    █    █▀▀                          ║');
  console.log('  ║    ▄▄█ █    █  █ █  █    █    █    █  █                         ║');
  console.log('  ║   ▀▀▀  ▀▀▀ █  █ ▀▀  ▀▀▀  ▀    ▀▀▀ █  █                        ║');
  console.log('  ║                                                                  ║');
  console.log('  ║         P R E D I C T I O N   M A R K E T S   A G E N T        ║');
  console.log('  ║     Polymarket  ·  Binance  ·  Gemini / Gemma  ·  2026           ║');
  console.log('  ║                                                                  ║');
  console.log('  ╠══════════════════════════════════════════════════════════════════╣');
  console.log('  ║                                                                  ║');
  console.log('  ║   DATA:    Binance API   — BTC/ETH/SOL candles (free)           ║');
  console.log('  ║   MARKETS: Polymarket    — crypto up/down 5-15min               ║');
  console.log('  ║   BRAIN:   Gemini 2.5 Flash — sniper edge + calibration         ║');
  console.log('  ║   CORE:    Gemma 3 27B   — 24/7 narrative analysis              ║');
  console.log('  ║   MODE:    Paper trading → real USDC at Level 40                ║');
  console.log('  ║                                                                  ║');
  console.log('  ╠══════════════════════════════════════════════════════════════════╣');
  console.log('  ║                                                                  ║');
  console.log('  ║   Get your Google AI Studio key at:                             ║');
  console.log('  ║   aistudio.google.com/app/apikey                                ║');
  console.log('  ║                                                                  ║');
  console.log('  ╚══════════════════════════════════════════════════════════════════╝');
  console.log(X + '\n');

  const key = await new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('  > Paste Gemini API key (Google AI Studio) and press ENTER: ');
    rl.once('line', ans => { rl.close(); resolve(ans); });
  });

  const trimmed = key.trim();
  if (!trimmed || trimmed.length < 20) {
    console.log('\n  ✗ No key entered. Run again.\n');
    process.exit(1);
  }

  const config = { anthropicKey: trimmed, mode: 'paper', createdAt: new Date().toISOString() };
  saveConfig(config);
  cls();
  console.log('\n' + G + BOLD);
  console.log('  ╔══════════════════════════════════════════════════════════════════╗');
  console.log('  ║   ✓  API KEY SAVED                                               ║');
  console.log('  ║   ✓  BINANCE CONNECTION: FREE — NO KEY NEEDED                   ║');
  console.log('  ║   ✓  POLYMARKET CONNECTION: FREE — NO KEY NEEDED                ║');
  console.log('  ║   ✓  PAPER TRADING MODE ACTIVE — $100 VIRTUAL FUND              ║');
  console.log('  ║   ✓  ADAN IS WAKING UP...                                        ║');
  console.log('  ╚══════════════════════════════════════════════════════════════════╝' + X + '\n');
  await new Promise(r => setTimeout(r, 2000));
  return config;
}

// ── Fast-path helper: read latest child intel for a spec ──────────────────
function readLatestChildIntel(spec) {
  try {
    const slug = spec.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const intelPath = path.join(INTEL_DIR, slug + '.json');
    if (!fs.existsSync(intelPath)) return null;
    const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
    const age = (Date.now() - new Date(intel.ts).getTime()) / 60000;
    if (age > 10) return null; // stale intel (>10 min)
    if (!intel.signal || intel.signal.dir === 'NEUTRAL') return null;
    return {
      childId: spec,
      direction: intel.signal.dir,
      confidence: intel.signal.conf || intel.signal.confidence || 50,
      age,
    };
  } catch { return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  ensureDir();
  // Load API key from .env file first, fallback to config.json
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^([A-Z_]+)=([^#\n]+)/);
        if (match) process.env[match[1]] = match[2].trim();
      }
    }
  } catch { }
  let config = loadConfig();
  // Prefer .env key over config.json
  const apiKey = process.env.GEMINI_API_KEY || config.geminiKey;
  if (!apiKey || apiKey === 'tu_nueva_api_key_aqui') {
    console.log(R + '❌ API Key Error: Not found or invalid in .env' + X);
    console.log(Y + 'Please add GEMINI_API_KEY to your .env file.' + X);
    process.exit(1);
  }

  // --- Brier Protocol Startup Log ---
  if (process.env.BRIER_URL) {
    console.log(G + '\n[BRIER] 🟢 Protocol Bridge Active' + X);
    console.log(G + `[BRIER] 🆔 Identity Loaded: ${process.env.BRIER_BOT_SLUG || 'Unknown'}` + X);
    console.log(G + `[BRIER] 🔑 SDK Keys Loaded: ${process.env.BRIER_API_KEY ? 'Yes' : 'No'}` + X);
    console.log(G + '[BRIER] ⏱️ Awaiting first trade to trigger Shadow Phase commit...\n' + X);
    
    // Ping Brier Protocol immediately to verify connection and turn profile Online
    triggerHeartbeat();
  }

  // Gemini/Gemma stack doesn't need a central 'client' like Anthropic SDK in this main file
  // as the routing is handled in adan-llm-router.js using process.env.GEMINI_API_KEY
  loadSoul();
  startDashboard(brainManager);

  // ── Polymarket-Only Mode — No perps ──
  console.log(M + '🎯 ADAN Polymarket Crypto Training Mode — BTC/ETH/SOL up-or-down' + X);
  refreshMyBrierScore().catch(() => {}); // boot-time self-score from Brier Protocol

  const state = {
    status: 'Starting...', mode: 'idle', thought: null,
    pnl: loadPnL(), positions: loadPositions(),
    markets: [], prices: {},
    lastScan: null, nextScanIn: 5, apiCost: 0
  };

  render(state);
  await checkResolutions();

  // ── AGI: Acknowledge Lord's fulfillment of previous requests ──
  try {
    const unread = adanVoice.getUnread();
    const clobReq = unread.find(m => m.type === 'request' && m.message.includes('CLOB'));
    if (clobReq) {
      // We don't check connected here as it might still be asyncing, 
      // but the fact it's unread and we are starting means Lord worked on it.
      adanVoice.speak('milestone', "Lord, I see the Polymarket CLOB WebSocket is now active! My order book intelligence is now live and detecting whale flow. Request fulfilled.", { category: 'data_source' });
      // Mark as read manually
      adanVoice.messages.forEach(m => { if (m.type === 'request' && m.message.includes('CLOB')) m.read = true; });
      adanVoice._save();
    }
  } catch (e) { console.log('[VOICE] Init check error:', e.message); }

  let _lastLoopDone = 0;
  const loop = async () => {
    try {
      state.pnl = loadPnL();
      state.positions = loadPositions();

      // ── Mother Code: Session + Human State ──
      metabolism.recordCycleCost(0.001);
      lastSessionAdj = marketSessions.getSessionAdjustments();
      const utcH = new Date().getUTCHours();
      const fgData = state.prices?._meta?.fearGreed;
      const humanContext = humanEventLayer.classify({
        fearGreedIndex: fgData?.value || null,
        volRatio: state.prices?.BTCUSDT?.volRatio || 1,
        priceChange1h: state.prices?.BTCUSDT?.change1h || 0,
        utcH,
        isBlackSwan: false
      });
      lastHumanState = humanContext.state;

      // ── Mother Code: Circuit Breaker (LVL 5+) ──
      // Flag, not inline sleep: keep READING markets and resolving positions
      // every cycle; only veto NEW trades until the pause window passes.
      const xpNow = expProgress(state.pnl.exp || 0);
      if (xpNow.level >= 5 && consecutiveLosses >= 5 && !global._cbPausedUntil) {
        console.log('[CIRCUIT BREAKER] ⚡ 5 consecutive losses — no new trades for 10min (loop keeps running)');
        global._cbPausedUntil = Date.now() + 600000;
        consecutiveLosses = 0;
      }
      if (global._cbPausedUntil && Date.now() > global._cbPausedUntil) global._cbPausedUntil = null;

      // ── Mother Code: Apoptosis check — DISABLED FOR TRAINING ──
      // Paper trading: we want ADAN to keep running and evolving regardless of fund level.
      // if (xpNow.level >= 10) {
      //   const apo = apoptosis.shouldTrigger(state.pnl.fund || 0, consecutiveLosses, xpNow.level);
      //   if (apo?.trigger) {
      //     await apoptosis.triggerApoptosis(apo.reason, state.positions, state.pnl);
      //     return;
      //   }
      // }

      // Clean up old particle filter markets
      particleFilter.cleanup();

      await checkResolutions();

      // ── Mother Code: Polymerase Shadow Learning ──
      try {
        await polymerase.checkShadowResolutions(polyFetch);
      } catch (e) { }

      // ── Child Learning: Resolve shadow predictions ──
      // checkMarketResolution never existed: evaluating it threw a silent
      // ReferenceError every cycle and NO shadow ever resolved (3330/0 on
      // 18 jul). Quant-track shadows grade by Binance close price and need no
      // callback; LLM-track ones simply skip until a real checker exists.
      try {
        await childLearning.checkResolutions(state.prices || {}, null);
      } catch (e) { console.error('[CHILD LEARNING] checkResolutions failed:', e.message); }

      // ── Wilmott v6.0: Persist EWMA state ──
      try { wilmott.saveState(); } catch { }

      // ── POLYMARKET SCAN — the main flow: prices → children → brain → bet ──
      if (lastHumanState !== 'NEWS_SHOCK') {
        await doScan(state);
        console.log('[SCAN] ✅ Polymarket cycle complete');
      } else {
        console.log('[HUMAN] ⛔ NEWS_SHOCK detected — skipping scan cycle');
      }

      // ── Watchdog heartbeat: mark loop completion (the 30s timer does the writing) ──
      _lastLoopDone = Date.now();

      state.pnl = loadPnL();
      state.positions = loadPositions();
      render(state);
    } catch (e) { console.error(R + 'Loop error: ' + e.message + X); }
    setTimeout(loop, SCAN_INTERVAL_MS);
  };

  setTimeout(loop, 2000);
  setInterval(() => { state.pnl = loadPnL(); state.positions = loadPositions(); if (state.mode === 'idle') render(state); }, 30000);

  // Heartbeat decoupled from cycle duration: alive = a loop completed recently.
  let _hbStart = Date.now();
  setInterval(() => {
    const ref = _lastLoopDone || _hbStart;
    if (Date.now() - ref < 10 * 60 * 1000) {
      try { fs.writeFileSync(path.join(DIR, '.heartbeat'), new Date().toISOString()); } catch { }
    }
  }, 30_000);

  // ── Oracle Fast Loop: 60s cycle — prices + fast-path for 5min markets ──
  let fastLoopBusy = false;
  setInterval(async () => {
    if (fastLoopBusy) return;
    fastLoopBusy = true;
    try {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const prices = {};
      await Promise.all(symbols.map(async sym => {
        const klines = await fetchBinanceKlines(sym, '1m', 5);
        if (!klines.length) return;
        const closes = klines.map(k => k.close);
        const price = closes[closes.length - 1];
        prices[sym] = { price, closes };
        oracle.recordPrice(sym, {
          price,
          rsi: calcRSI(closes),
          vol: calcVolumeProfile(klines),
          trend1m: calcTrend(closes),
          closes
        });
      }));

      // Fast-path: check for 5min markets closing in 2-5 min that main loop misses
      const openPos = loadPositions().open;
      const openIds = new Set(openPos.map(p => p.marketId));
      if (openPos.length < MAX_POSITIONS && state.mode !== 'thinking') {
        const strat = loadStrategy();
        const raw5m = await polyFetch('/events?tag_slug=bitcoin&limit=50&active=true&closed=false');
        const raw5mSol = await polyFetch('/events?tag_slug=solana&limit=50&active=true&closed=false');
        const allRaw = [...(Array.isArray(raw5m) ? raw5m : []), ...(Array.isArray(raw5mSol) ? raw5mSol : [])];
        const nowMs = Date.now();
        for (const ev of allRaw) {
          if (!/up.or.down/i.test(ev.title || '')) continue;
          for (const m of (ev.markets || [])) {
            if (openIds.has(m.id)) continue;
            const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
            const minsLeft = (endMs - nowMs) / 60000;
            // Only 5min markets closing in 2-5 min window
            if (minsLeft < 2 || minsLeft > 5) continue;
            if (!m.question) m.question = ev.title;
            m._isUpDown = true;
            const nm = normalizePolymarket(m, state.prices || {});
            if (!nm || nm.yesPrice >= 0.85 || nm.yesPrice <= 0.15) continue;
            const edge = Math.abs(nm.yesPrice - 0.5);
            if (edge < 0.05) continue; // need 5%+ edge
            console.log(`[FAST PATH] ⚡ Found 5min market closing in ${minsLeft.toFixed(1)}min: ${nm.title.slice(0, 50)} edge=${(edge * 100).toFixed(1)}%`);
            // v7: Apply meta-calibration to fast path too
            const childId = nm.asset === 'btc' ? 'BTC-5min'
              : nm.asset === 'sol' ? 'SOL-5min'
                : 'ETH-5min';
            const childIntel = readLatestChildIntel(childId);
            // v7: Apply meta-calibration to fast path too
            const mcFast = loadMetaCalib();
            const calibFastConf = Math.round((childIntel?.confidence || 0) * (mcFast.multiplier || 1.0));
            // Edge = child's side-frame prob vs the side-adjusted market price
            // (same definition as CHILD DIRECT), not the old |yesPrice-0.5| skew.
            const sideFast = childIntel?.direction === 'UP' ? 'YES' : 'NO';
            const mispricingFast = (calibFastConf / 100) - (sideFast === 'YES' ? nm.yesPrice : 1 - nm.yesPrice);
            const netFastEdge = mispricingFast - FEES_SLIPPAGE; // fees
            const _optFast = selfOptimizer.loadParams();
            if (childIntel && calibFastConf >= _optFast.confGate && netFastEdge > _optFast.minEdge) {
              const pSideFast = Math.min(0.97, Math.max(0.03, calibFastConf / 100));
              const pYesFast = childIntel.direction === 'UP' ? pSideFast : 1 - pSideFast;
              const fastDecision = {
                action: 'BET', market: nm,
                side: childIntel.direction === 'UP' ? 'YES' : 'NO',
                // myProb is P(YES); calibFastConf is side-frame confidence, clamped.
                myProb: pYesFast,
                pSide: pSideFast,
                pYes: pYesFast,
                rawConfidence: childIntel?.confidence || 0,
                edge: netFastEdge,
                edge_pct: netFastEdge * 100,
                confidence: calibFastConf,
                confidence_pct: calibFastConf,
                thought: `[FAST PATH] Child ${childIntel.childId} says ${childIntel.direction} @ calibConf ${calibFastConf}% (raw ${childIntel.confidence}%). Net edge: ${(netFastEdge * 100).toFixed(1)}%`,
              };
              console.log(`[FAST PATH] 🎯 Executing via child signal: ${childIntel.direction} @ ${childIntel.confidence}%`);
              await evaluate_and_trade(fastDecision, state.prices || {}, state);
              state.pnl = loadPnL(); state.positions = loadPositions();
              render(state);
              break; // One fast-path trade per cycle
            }
          }
        }
      }

      // Log strong oracle signals
      for (const sym of symbols) {
        const sig = oracle.analyze(sym);
        if (sig.hasSignal && (sig.signalType === 'STRONG_MOVE' || sig.signalType === 'FLASH_MOVE')) {
          console.log(`[ORACLE FAST] ⚡ ${sym}: ${sig.signalType} ${sig.direction} (${sig.magnitude.toFixed(2)}%)`);
        }
      }
    } catch (e) { /* oracle fast loop error — silent */ }
    fastLoopBusy = false;
  }, 60000);
}

main().catch(e => { console.error(e); process.exit(1); });
