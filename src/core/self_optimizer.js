// src/core/self_optimizer.js
// ADAN Self-Optimizer — Nightly grid search over gating thresholds
// Finds optimal confidence gate, min edge, and hour filter from its own trade history
// Part of ADAN Consciousness Layer v1.0

import fs from 'fs';
import path from 'path';
import { DIR, loadPositions, loadPnL } from './config.js';

const PARAMS_PATH = path.join(DIR, 'self_optimized_params.json');
const OPT_LOG_PATH = path.join(DIR, 'optimization_log.jsonl');

// Same fee+slippage margin adan-pred.js uses (FEES_SLIPPAGE) — the grid search
// must calibrate gates against the REAL live margin, not a stale hardcoded one.
const FEES_SLIPPAGE = Number(process.env.BRIER_MIN_EDGE ?? 0.017);

const DEFAULTS = {
  confGate: 55,
  minEdge: 0.03,
  hourThr: 0.48,
  hourMinN: 20,
  childConfGate: 50,
  childMinEdge: 0.02,
  optimizedAt: null,
  version: 0,
};

export class SelfOptimizer {

  loadParams() {
    try {
      if (fs.existsSync(PARAMS_PATH)) {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8')) };
      }
    } catch {}
    return { ...DEFAULTS };
  }

  run() {
    const pos = loadPositions();
    // Chronological order (defensive — don't assume `closed` is pre-sorted).
    const allClosed = [...(pos.closed || [])].sort((a, b) =>
      new Date(a.entryTime || a.openedAt || 0) - new Date(b.entryTime || b.openedAt || 0)
    );
    const trades = allClosed.slice(-500);
    if (trades.length < 100) {
      console.log(`[SELF-OPT] Only ${trades.length} closed trades — need 100+ to optimize`);
      return null;
    }

    const current = this.loadParams();

    // Purged chronological train/test split. Scoring a grid search on the same
    // trades it was selected from always finds a "winner" (confirmed: this
    // produced simWR=77.78% vs. 44.8% real win rate on resolved trades) — same
    // fee/spend the model is fit and evaluated on the same data. Selection must
    // come from a held-out slice, with a small embargo gap so boundary trades
    // can't leak into both sides (same spirit as purged_walkforward.js).
    const EMBARGO = 10;
    const testSize = Math.max(60, Math.floor(trades.length * 0.3));
    const testStart = trades.length - testSize;
    const trainEnd = Math.max(0, testStart - EMBARGO);
    const trainSet = trades.slice(0, trainEnd);
    const testSet = trades.slice(testStart);

    if (trainSet.length < 50 || testSet.length < 30) {
      console.log(`[SELF-OPT] Not enough trades for a purged split (train=${trainSet.length}, test=${testSet.length})`);
      return null;
    }

    // Grid search: every combo is scored on TEST only. Hour-of-day stats (the
    // 3rd gate) are built from TRAIN, so that filter isn't fit and graded on the
    // same trades either.
    const results = [];
    for (let confGate = 50; confGate <= 80; confGate += 5) {
      for (let minEdge = 0.01; minEdge <= 0.08; minEdge += 0.01) {
        for (let hourThr = 0.38; hourThr <= 0.55; hourThr += 0.02) {
          const sim = this._simulate(testSet, confGate, minEdge, hourThr, trainSet);
          results.push({ confGate, minEdge: parseFloat(minEdge.toFixed(2)), hourThr: parseFloat(hourThr.toFixed(2)), ...sim });
        }
      }
    }

    // Safety: must take at least 25% of the TEST set (prevent "skip everything").
    const minTestTrades = Math.max(15, Math.floor(testSet.length * 0.25));
    const eligible = results.filter(r => r.taken >= minTestTrades);

    if (eligible.length === 0) {
      console.log(`[SELF-OPT] No parameter set clears the min-test-trades bar (${minTestTrades} of ${testSet.length})`);
      return null;
    }

    eligible.sort((a, b) => b.score - a.score);
    const top = eligible[0];

    // One-standard-error rule (Elements of Statistical Learning §7.10): among
    // configs within 1 SE of the best held-out score, prefer the more
    // conservative one (higher confGate — fewer, higher-conviction trades)
    // instead of chasing the single noisiest peak of a 504-combo grid.
    const topSE = top.taken > 0 ? Math.sqrt(top.wr * (1 - top.wr) / top.taken) : 1;
    const withinOneSE = eligible.filter(r => r.score >= top.score - topSE);
    const best = withinOneSE.reduce((a, b) => (b.confGate > a.confGate ? b : a), withinOneSE[0]);

    // Derive child params (slightly more aggressive)
    best.childConfGate = Math.max(50, best.confGate - 5);
    best.childMinEdge = parseFloat((best.minEdge * 0.66).toFixed(3));
    best.optimizedAt = new Date().toISOString();
    best.version = (current.version || 0) + 1;
    best.windowSize = trades.length;
    best.trainSize = trainSet.length;
    best.testSize = testSet.length;

    // Save
    this._saveParams(best);
    this._logChange(current, best, trades.length);

    return { old: current, new: best };
  }

  // `trades` is what gets scored. `hourStatsSource` (defaults to `trades` for
  // backward compat) is what the hour-of-day filter's win-rate table is BUILT
  // from — pass the train set here so the filter isn't fit and graded on the
  // same data it's being scored against.
  _simulate(trades, confGate, minEdge, hourThr, hourStatsSource = trades) {
    const hourStats = {};
    for (const t of hourStatsSource) {
      const h = new Date(t.entryTime || t.openedAt || 0).getUTCHours().toString();
      if (!hourStats[h]) hourStats[h] = { w: 0, l: 0 };
      if (t.result === 'WIN' || t.won === true) hourStats[h].w++;
      else hourStats[h].l++;
    }

    let taken = 0, wins = 0, totalPnl = 0;

    for (const t of trades) {
      const conf = t.confidence || t.confidence_pct || 50;
      const rawEdge = Math.abs(t.edge || 0);
      const netEdge = rawEdge - FEES_SLIPPAGE; // fee + slippage deduction (env-configurable, was hardcoded)

      // Gate 1: confidence
      if (conf < confGate) continue;

      // Gate 2: net edge
      if (netEdge < minEdge) continue;

      // Gate 3: hour filter
      const h = new Date(t.entryTime || t.openedAt || 0).getUTCHours().toString();
      const hd = hourStats[h];
      if (hd) {
        const hTotal = hd.w + hd.l;
        const hWR = hTotal > 0 ? hd.w / hTotal : 0.5;
        if (hTotal >= 20 && hWR < hourThr) continue;
      }

      // Trade passes all gates
      taken++;
      const won = t.result === 'WIN' || t.won === true;
      if (won) wins++;
      totalPnl += (t.pnl || t.pnlVal || 0);
    }

    const wr = taken > 0 ? wins / taken : 0;
    const profitFactor = 1 + totalPnl / 10000;
    // Score: WR × sqrt(taken) × profitFactor
    const score = wr * Math.sqrt(Math.max(1, taken)) * Math.max(0.1, profitFactor);

    return {
      taken,
      wins,
      wr: parseFloat(wr.toFixed(4)),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      score: parseFloat(score.toFixed(4)),
    };
  }

  _saveParams(best) {
    fs.mkdirSync(DIR, { recursive: true });
    const save = {
      confGate: best.confGate,
      minEdge: best.minEdge,
      hourThr: best.hourThr,
      hourMinN: 20,
      childConfGate: best.childConfGate,
      childMinEdge: best.childMinEdge,
      optimizedAt: best.optimizedAt,
      version: best.version,
      // Stats for transparency
      simWR: best.wr,
      simTrades: best.taken,
      simPnl: best.totalPnl,
      windowSize: best.windowSize,
    };
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(save, null, 2));
  }

  _logChange(old, best, windowSize) {
    const entry = {
      ts: new Date().toISOString(),
      version: best.version,
      window: windowSize,
      old: { confGate: old.confGate, minEdge: old.minEdge, hourThr: old.hourThr },
      new: { confGate: best.confGate, minEdge: best.minEdge, hourThr: best.hourThr },
      simWR: best.wr,
      simTrades: best.taken,
      simPnl: best.totalPnl,
    };
    fs.appendFileSync(OPT_LOG_PATH, JSON.stringify(entry) + '\n');
    console.log(`[SELF-OPT] v${best.version}: conf=${best.confGate}% edge=${(best.minEdge*100).toFixed(1)}% hourThr=${(best.hourThr*100).toFixed(0)}% → simWR=${(best.wr*100).toFixed(1)}% on ${best.taken}/${windowSize} trades (PnL: $${best.totalPnl.toFixed(0)})`);
  }
}

export const selfOptimizer = new SelfOptimizer();
