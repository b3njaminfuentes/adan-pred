// Learning Loop v2 — the quant spine of ADAN.
//
// Every decision is photographed (full feature snapshot) into an append-only
// ledger; every resolution closes the loop. From that single source of truth:
//   · calibration curves per child / regime / hour
//   · Wilson lower bounds — survival decisions select skill, not luck
//   · declared-vs-realized edge (LLM inflation detector)
//   · directed DNA mutations — losses become specific numeric corrections
//
// Storage: ~/.adan-pred/trades.jsonl  (two record types: 'open' and 'res')

import fs from 'fs';
import path from 'path';
import { HOME } from './config.js';

const DIR = path.join(HOME, '.adan-pred');
const LEDGER_PATH = path.join(DIR, 'trades.jsonl');
const REPORT_PATH = path.join(DIR, 'learning_report.json');

function append(obj) {
  try { fs.appendFileSync(LEDGER_PATH, JSON.stringify(obj) + '\n'); } catch { }
}

// ── Ledger ───────────────────────────────────────────────────────────────────
export const ledger = {
  record(entry) {
    append({ t: 'open', ts: new Date().toISOString(), ...entry });
  },

  resolve(id, outcome) {
    append({ t: 'res', ref: id, ts: new Date().toISOString(), ...outcome });
  },

  // Merged view: open entries with their resolution attached (if any)
  readAll() {
    if (!fs.existsSync(LEDGER_PATH)) return [];
    const opens = new Map();
    for (const line of fs.readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.t === 'open') opens.set(r.id, r);
      else if (r.t === 'res' && opens.has(r.ref)) opens.get(r.ref).res = r;
    }
    return [...opens.values()];
  },
};

// ── Wilson lower bound ───────────────────────────────────────────────────────
// "With 95% confidence this child wins at least X%". Survival decisions use
// the LOWER bound: a lucky 6/8 streak scores worse than a steady 18/30.
export function wilsonLower(wins, n, z = 1.96) {
  if (n === 0) return 0;
  const p = wins / n, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n));
}

// ── Analysis ─────────────────────────────────────────────────────────────────
const BUCKETS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];

function emptyStats() {
  return { n: 0, wins: 0, edgeDeclared: 0, edgeRealized: 0, buckets: BUCKETS.map(() => ({ n: 0, predSum: 0, wins: 0 })) };
}

function addTrade(s, tr) {
  const won = tr.res.won ? 1 : 0;
  s.n++; s.wins += won;
  // prob space, from the bet's own side. Post-rewire records carry explicit
  // pSide (P of chosen side) and entryPrice (real fill); legacy records stored
  // myProb in side frame, so it doubles as pSide for them.
  const pSide = tr.pSide ?? (tr.myProb || 0.5);
  const price = tr.entryPrice ?? (tr.side === 'YES' ? tr.marketProb : 1 - tr.marketProb);
  s.edgeDeclared += pSide - price;
  s.edgeRealized += won - price;
  const bi = BUCKETS.findIndex(([lo, hi]) => pSide >= lo && pSide < hi);
  if (bi >= 0) { const b = s.buckets[bi]; b.n++; b.predSum += pSide; b.wins += won; }
}

function finalize(s) {
  return {
    n: s.n,
    wins: s.wins,
    wr: s.n ? +(s.wins / s.n).toFixed(3) : null,
    wilson: +wilsonLower(s.wins, s.n).toFixed(3),
    edgeDeclaredAvg: s.n ? +(s.edgeDeclared / s.n).toFixed(4) : null,
    edgeRealizedAvg: s.n ? +(s.edgeRealized / s.n).toFixed(4) : null,
    calib: s.buckets.map((b, i) => ({
      range: `${BUCKETS[i][0]}-${Math.min(BUCKETS[i][1], 1)}`,
      n: b.n,
      predicted: b.n ? +(b.predSum / b.n).toFixed(3) : null,
      realized: b.n ? +(b.wins / b.n).toFixed(3) : null,
      gap: b.n ? +((b.predSum / b.n) - (b.wins / b.n)).toFixed(3) : null,
    })),
  };
}

export function analyze({ sinceDays = 30 } = {}) {
  const cutoff = Date.now() - sinceDays * 86400000;
  const trades = ledger.readAll().filter(t =>
    t.res && t.myProb != null && t.marketProb != null && new Date(t.ts).getTime() >= cutoff);

  const global = emptyStats();
  const by = { child: {}, regime: {}, hour: {}, assetWindow: {} };
  const dim = (map, key) => (map[key] ||= emptyStats());

  for (const tr of trades) {
    addTrade(global, tr);
    if (tr.childSpec) addTrade(dim(by.child, tr.childSpec), tr);
    if (tr.regime) addTrade(dim(by.regime, tr.regime), tr);
    addTrade(dim(by.hour, String(new Date(tr.ts).getUTCHours())), tr);
    addTrade(dim(by.assetWindow, `${tr.asset || '?'}-${tr.windowMin || '?'}m`), tr);
  }

  const fin = map => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, finalize(v)]));
  return {
    generatedAt: new Date().toISOString(),
    sinceDays,
    totalResolved: trades.length,
    global: finalize(global),
    perChild: fin(by.child),
    perRegime: fin(by.regime),
    perHour: fin(by.hour),
    perAssetWindow: fin(by.assetWindow),
  };
}

// ── Directed mutation hints ──────────────────────────────────────────────────
// Each hint is a numeric correction backed by ledger evidence — never vibes.
const MIN_N = { calib: 10, edge: 10, regime: 8 };

export function directedHints(a = analyze()) {
  const hints = [];

  for (const [spec, st] of Object.entries(a.perChild)) {
    // 1. Overconfidence: predicted >> realized in any bucket → tighten the gate
    for (const b of st.calib) {
      if (b.n >= MIN_N.calib && b.gap > 0.08) {
        hints.push({
          spec, param: 'gate', dir: +1, severity: b.gap,
          reason: `bucket ${b.range}: predice ${b.predicted} pero realiza ${b.realized} (n=${b.n})`,
        });
      }
    }
    // 2. Edge inflation: declares edge it never collects
    if (st.n >= MIN_N.edge && st.edgeDeclaredAvg - st.edgeRealizedAvg > 0.05) {
      hints.push({
        spec, param: 'gate', dir: +1, severity: st.edgeDeclaredAvg - st.edgeRealizedAvg,
        reason: `edge declarado ${st.edgeDeclaredAvg} vs realizado ${st.edgeRealizedAvg} (n=${st.n})`,
      });
    }
    // 3. Proven sharpness: wilson > 0.55 with real sample → can loosen slightly
    if (st.n >= 30 && st.wilson > 0.55) {
      hints.push({
        spec, param: 'gate', dir: -1, severity: 0.02,
        reason: `wilson ${st.wilson} con n=${st.n} — calibración demostrada`,
      });
    }
  }

  // 4. Regime weakness (global): flag regimes where ADAN demonstrably bleeds
  for (const [regime, st] of Object.entries(a.perRegime)) {
    if (st.n >= MIN_N.regime && st.wilson < 0.35) {
      hints.push({
        spec: '*', param: 'regimeBlock', dir: +1, severity: 0.5 - st.wilson, regime,
        reason: `régimen ${regime}: wilson ${st.wilson} con n=${st.n}`,
      });
    }
  }

  return hints;
}

// ── Apply mutations ──────────────────────────────────────────────────────────
// Mutates the DNA the children actually consume: child_learning.json →
// dna.minConfidence (childSignal's quality gate). Bounded ±10% per night,
// hard floor/ceiling 40-80 (same as DNA_BOUNDS), every change logged with
// its ledger evidence.
const STEP = 0.10;
const CONF_BOUNDS = [40, 80];

// The caller passes the LIVE childLearning.learning store and its save fn.
// Reading/writing child_learning.json directly was a double no-op: the file is
// nested under a `learning` key (so learning[spec] always missed), and the
// in-memory singleton — the only thing the live child signal reads — both
// ignored the file and clobbered it on the next _save(). Mutating the singleton
// in place is the only thing that actually changes child behavior.
export function applyDirectedMutations(hints = directedHints(), learning = null, save = null) {
  if (!learning) return [];
  const applied = [];

  // net direction per child (several hints may agree or cancel)
  const net = {};
  for (const h of hints.filter(h => h.spec !== '*' && h.param === 'gate')) {
    net[h.spec] = net[h.spec] || { dir: 0, reasons: [] };
    net[h.spec].dir += h.dir * Math.min(1, h.severity * 5);
    net[h.spec].reasons.push(h.reason);
  }

  for (const [spec, { dir, reasons }] of Object.entries(net)) {
    if (Math.abs(dir) < 0.1) continue;
    const child = learning[spec] || learning[spec.toLowerCase()];
    if (!child) continue; // gauss-* / unknown specs have no child entry — skip
    child.dna = child.dna || {};
    const cur = child.dna.minConfidence ?? 55;
    const delta = Math.max(-STEP, Math.min(STEP, dir * STEP)) * cur;
    const next = Math.round(Math.max(CONF_BOUNDS[0], Math.min(CONF_BOUNDS[1], cur + delta)));
    if (next === cur) continue;
    child.dna.minConfidence = next;
    child.dna.lastDirectedMutation = { at: new Date().toISOString(), from: cur, to: next, reasons };
    applied.push({ spec, param: 'minConfidence', from: cur, to: next, reasons });
    console.log(`[LEARNING] 🧬 ${spec}: minConfidence ${cur} → ${next} | ${reasons[0]}`);
  }

  if (applied.length && typeof save === 'function') { try { save(); } catch { } }
  return applied;
}

// ── Nightly report ───────────────────────────────────────────────────────────
// Numeric digest for the dream prompt — rules must cite numbers, not feelings.
export function nightlyReport() {
  const a = analyze();
  const hints = directedHints(a);
  const report = { ...a, hints };
  try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch { }

  if (!a.totalResolved) return { report, text: 'LEDGER: sin trades resueltos aún.' };

  const g = a.global;
  const lines = [
    `LEDGER (${a.sinceDays}d): ${a.totalResolved} resueltos | WR ${g.wr} | wilson ${g.wilson} | edge declarado ${g.edgeDeclaredAvg} vs realizado ${g.edgeRealizedAvg}`,
  ];
  for (const b of g.calib.filter(b => b.n > 0)) {
    lines.push(`CALIB ${b.range}: predice ${b.predicted} realiza ${b.realized} gap ${b.gap} (n=${b.n})`);
  }
  const worstChildren = Object.entries(a.perChild)
    .filter(([, s]) => s.n >= 8).sort((x, y) => x[1].wilson - y[1].wilson).slice(0, 3);
  for (const [spec, s] of worstChildren) {
    lines.push(`CHILD ${spec}: wilson ${s.wilson} WR ${s.wr} (n=${s.n})`);
  }
  for (const h of hints.slice(0, 5)) {
    lines.push(`HINT ${h.spec} ${h.param}${h.dir > 0 ? '+' : '-'}: ${h.reason}`);
  }
  return { report, text: lines.join('\n') };
}
