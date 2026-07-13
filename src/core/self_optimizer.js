// src/core/self_optimizer.js
// ADAN Self-Optimizer — Nightly grid search over gating thresholds
// Finds optimal confidence gate, min edge, and hour filter from its own trade history
// Part of ADAN Consciousness Layer v1.0

import fs from 'fs';
import path from 'path';
import { DIR, loadPositions, loadPnL } from './config.js';

const PARAMS_PATH = path.join(DIR, 'self_optimized_params.json');
const OPT_LOG_PATH = path.join(DIR, 'optimization_log.jsonl');

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
    const trades = (pos.closed || []).slice(-500);
    if (trades.length < 100) {
      console.log(`[SELF-OPT] Only ${trades.length} closed trades — need 100+ to optimize`);
      return null;
    }

    const current = this.loadParams();

    // Grid search over 3 dimensions
    const results = [];
    for (let confGate = 50; confGate <= 80; confGate += 5) {
      for (let minEdge = 0.01; minEdge <= 0.08; minEdge += 0.01) {
        for (let hourThr = 0.38; hourThr <= 0.55; hourThr += 0.02) {
          const sim = this._simulate(trades, confGate, minEdge, hourThr);
          results.push({ confGate, minEdge: parseFloat(minEdge.toFixed(2)), hourThr: parseFloat(hourThr.toFixed(2)), ...sim });
        }
      }
    }

    // Sort by composite score: WR × sqrt(taken) × profitFactor
    results.sort((a, b) => b.score - a.score);

    // Safety: must take at least 25% of trades (prevent "skip everything" degenerate)
    const minTrades = Math.floor(trades.length * 0.25);
    const best = results.find(r => r.taken >= minTrades && r.taken >= 30) || results[0];

    if (!best || best.taken < 20) {
      console.log(`[SELF-OPT] No valid parameter set found (best had ${best?.taken || 0} trades)`);
      return null;
    }

    // Derive child params (slightly more aggressive)
    best.childConfGate = Math.max(50, best.confGate - 5);
    best.childMinEdge = parseFloat((best.minEdge * 0.66).toFixed(3));
    best.optimizedAt = new Date().toISOString();
    best.version = (current.version || 0) + 1;
    best.windowSize = trades.length;

    // Save
    this._saveParams(best);
    this._logChange(current, best, trades.length);

    return { old: current, new: best };
  }

  _simulate(trades, confGate, minEdge, hourThr) {
    // Build hour stats from THIS window only (no data leakage)
    const hourStats = {};
    for (const t of trades) {
      const h = new Date(t.entryTime || t.openedAt || 0).getUTCHours().toString();
      if (!hourStats[h]) hourStats[h] = { w: 0, l: 0 };
      if (t.result === 'WIN' || t.won === true) hourStats[h].w++;
      else hourStats[h].l++;
    }

    let taken = 0, wins = 0, totalPnl = 0;

    for (const t of trades) {
      const conf = t.confidence || t.confidence_pct || 50;
      const rawEdge = Math.abs(t.edge || 0);
      const netEdge = rawEdge - 0.017; // fee + slippage deduction

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
