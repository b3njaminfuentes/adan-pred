// scripts/backfill_triple_barrier.js
//
// Rebuilds every historical triple-barrier label from real Binance price data.
//
// Why: until the price_path fix, resolutions were labelled by synthesising
// `exit = won ? entry*1.01 : entry*0.99` and comparing it to barriers on the
// Polymarket probability. That could not produce anything except a timeout —
// the recorded state was TP:0 SL:0 TIME:1846, i.e. 1846 labels carrying zero
// information. Those are known artifacts of a bug, not observations, so they
// are rebuilt rather than kept. The underlying trades are untouched: every
// label here is recomputed from the real BTC/ETH/SOL path during the exact
// window each trade was open.
//
// Fetch strategy: naively this is 2 requests per trade (~4.4k calls). Instead
// we pull each asset's full 1m history once, in 1000-bar chunks (~135 calls
// total), and slice each trade's window locally. Same data, ~3% of the load.
//
// Writes two outputs and never touches the live state file directly:
//   1. triple_barrier.backfilled.json  — rebuilt stats, swapped in manually
//   2. triple_barrier_labels.jsonl     — per-trade records: the Polymarket
//      outcome next to the path label. This pairing is what makes it possible
//      to tell "read the direction wrong" apart from "read it right but the
//      move reverted before expiry" — two different failures that a bare
//      win/loss flag cannot distinguish.

import fs from 'fs';
import path from 'path';
import { fetchKlineRange } from '../src/api/binance.js';
import { tripleBarrier } from '../src/ml/triple_barrier.js';
import { realisedVolPct, LOOKBACK_MIN, SYMBOL_MAP } from '../src/ml/price_path.js';

const DIR = path.join(process.env.HOME, '.adan-pred');
const POSITIONS_PATH = path.join(DIR, 'positions.json');
const OUT_STATE = path.join(DIR, 'triple_barrier.backfilled.json');
const OUT_LABELS = path.join(DIR, 'triple_barrier_labels.jsonl');

const CHUNK_BARS = 1000;           // Binance max per klines request
const THROTTLE_MS = 250;           // deliberate pacing; nowhere near the limit
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFullHistory(symbol, startMs, endMs) {
  const bars = [];
  let cursor = startMs;
  let requests = 0;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_BARS * 60_000, endMs);
    const got = await fetchKlineRange(symbol, cursor, chunkEnd, '1m');
    requests++;
    if (!got.length) {
      // Gap or transient failure: step past this chunk rather than spin.
      cursor = chunkEnd + 60_000;
      await sleep(THROTTLE_MS);
      continue;
    }
    bars.push(...got);
    cursor = got[got.length - 1].time + 60_000;
    process.stdout.write(`\r  ${symbol}: ${bars.length} velas (${requests} requests)   `);
    await sleep(THROTTLE_MS);
  }
  process.stdout.write('\n');
  // Dedupe by openTime and sort — chunk boundaries can overlap by one bar.
  const seen = new Map();
  for (const b of bars) seen.set(b.time, b);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

// First index whose bar time is >= t. Bars are sorted and may have gaps, so
// binary search rather than arithmetic on a fixed cadence.
function lowerBound(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const pos = JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  const trades = [...(pos.open || []), ...(pos.closed || [])]
    .filter(p => p.resolved && p.entryTime && SYMBOL_MAP[(p.asset || '').toLowerCase()])
    .map(p => ({ ...p, _entryMs: new Date(p.entryTime).getTime() }))
    .filter(p => Number.isFinite(p._entryMs))
    .sort((a, b) => a._entryMs - b._entryMs);

  console.log(`Trades a re-etiquetar: ${trades.length}`);
  if (!trades.length) return;

  // Per-asset history covering every trade's lookback and window.
  const histories = {};
  for (const asset of Object.keys(SYMBOL_MAP)) {
    const forAsset = trades.filter(t => (t.asset || '').toLowerCase() === asset);
    if (!forAsset.length) continue;
    const symbol = SYMBOL_MAP[asset];
    const startMs = forAsset[0]._entryMs - LOOKBACK_MIN * 60_000;
    const endMs = forAsset[forAsset.length - 1]._entryMs
      + (Number(forAsset[forAsset.length - 1].windowMin) || 5) * 60_000;
    console.log(`\nDescargando ${symbol} (${forAsset.length} trades)...`);
    histories[asset] = await fetchFullHistory(symbol, startMs, endMs);
  }

  // Fresh stats — deliberately NOT seeded from the corrupt existing state.
  const stats = { tp: 0, sl: 0, time: 0, pnlByLabel: { '1': 0, '0': 0, '-1': 0 }, countByLabel: { '1': 0, '0': 0, '-1': 0 } };
  const history = [];
  const labelRows = [];
  let skipped = 0;

  // Agreement matrix: did the path label agree with the Polymarket outcome?
  const matrix = { tpWon: 0, tpLost: 0, slWon: 0, slLost: 0, timeWon: 0, timeLost: 0 };

  for (const t of trades) {
    const asset = (t.asset || '').toLowerCase();
    const bars = histories[asset];
    if (!bars || !bars.length) { skipped++; continue; }

    const windowMin = Number(t.windowMin) || 5;
    const entryMs = t._entryMs;
    const lbStart = lowerBound(bars, entryMs - LOOKBACK_MIN * 60_000);
    const winStart = lowerBound(bars, entryMs);
    const winEnd = lowerBound(bars, entryMs + windowMin * 60_000);

    const lookback = bars.slice(lbStart, winStart);
    const window = bars.slice(winStart, Math.max(winEnd, winStart + 1));
    if (!window.length) { skipped++; continue; }

    const volPct = realisedVolPct(lookback);
    if (volPct == null) { skipped++; continue; }

    const lbl = tripleBarrier.labelFromPath(window[0].open, window, t.side, volPct, { record: false });
    if (!lbl) { skipped++; continue; }

    // Fold into our own stats (labelFromPath was told not to record).
    if (lbl.hit === 'tp') stats.tp++; else if (lbl.hit === 'sl') stats.sl++; else stats.time++;
    const key = String(lbl.label);
    stats.pnlByLabel[key] += lbl.pnl;
    stats.countByLabel[key] += 1;
    history.push({ ts: entryMs, hit: lbl.hit, label: lbl.label, pnl: lbl.pnl });

    if (lbl.hit === 'tp') { t.won ? matrix.tpWon++ : matrix.tpLost++; }
    else if (lbl.hit === 'sl') { t.won ? matrix.slWon++ : matrix.slLost++; }
    else { t.won ? matrix.timeWon++ : matrix.timeLost++; }

    labelRows.push({
      id: t.id || t.featureTradeId || null,
      ts: entryMs,
      entryTime: t.entryTime,
      asset, symbol: SYMBOL_MAP[asset], windowMin,
      childSpec: t.childSpec || null,
      side: t.side,
      won: t.won,                       // Polymarket outcome at expiry
      label: lbl.label,                 // path label: 1 TP / 0 time / -1 SL
      hit: lbl.hit,
      pathPnlPct: Number(lbl.pnl.toFixed(4)),
      barsToTouch: lbl.barsToTouch,
      ambiguousBar: lbl.ambiguousBar,
      volPct: Number(volPct.toFixed(4)),
      underlyingEntry: window[0].open,
      confidence: t.confidence ?? null,
      edge: t.edge ?? null,
    });
  }

  history.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(OUT_STATE, JSON.stringify({
    stats,
    history: history.slice(-500),   // same cap the live module keeps
    activeBarriers: {},
  }));
  fs.writeFileSync(OUT_LABELS, labelRows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const total = stats.tp + stats.sl + stats.time;
  const pct = n => total ? (n / total * 100).toFixed(1) + '%' : '?';
  console.log(`\n\n═══ BACKFILL COMPLETO ═══`);
  console.log(`Etiquetados: ${total}   (omitidos: ${skipped})`);
  console.log(`  TP   ${stats.tp}\t${pct(stats.tp)}`);
  console.log(`  SL   ${stats.sl}\t${pct(stats.sl)}`);
  console.log(`  TIME ${stats.time}\t${pct(stats.time)}`);
  console.log(`\nPnL medio sobre el subyacente:`);
  for (const k of ['1', '0', '-1']) {
    const c = stats.countByLabel[k];
    console.log(`  label ${k.padStart(2)}: ${c ? (stats.pnlByLabel[k] / c).toFixed(4) + '%' : '—'} (n=${c})`);
  }
  console.log(`\n═══ CAMINO vs RESULTADO EN POLYMARKET ═══`);
  console.log(`(divergencia esperada: el camino mide el movimiento, Polymarket mide dónde cerró)`);
  console.log(`  TP   → ganó ${matrix.tpWon}\tperdió ${matrix.tpLost}`);
  console.log(`  SL   → ganó ${matrix.slWon}\tperdió ${matrix.slLost}`);
  console.log(`  TIME → ganó ${matrix.timeWon}\tperdió ${matrix.timeLost}`);
  console.log(`\nEscrito:\n  ${OUT_STATE}\n  ${OUT_LABELS}`);
}

main().catch(e => { console.error('\nBackfill error:', e); process.exit(1); });
