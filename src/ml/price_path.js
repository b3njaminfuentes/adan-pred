// src/ml/price_path.js
// Reconstructs what the UNDERLYING asset actually did during a trade window.
//
// Why this exists: when a trade resolved, adan-pred.js used to synthesise an
// exit price as `won ? entry * 1.01 : entry * 0.99` — a made-up ±1% derived
// from the binary outcome itself. Two consequences, both bad:
//   1. It carried zero market information. A 0.02% drift and a violent 3%
//      run both became "+1%", so the labels could not distinguish a decisive
//      correct call from a coin flip that happened to land right.
//   2. With barriers at ±2%·vol, a fabricated ±1% on a Polymarket
//      probability could never touch them. Result: 1846 labels recorded,
//      TP:0 SL:0 TIME:1846. The triple-barrier module was structurally
//      incapable of ever producing a non-zero label.
//
// This module fetches the real Binance klines for the exact window and hands
// back a genuine price path plus a volatility estimate.
//
// LOOK-AHEAD DISCIPLINE: the volatility used to place the barriers is
// computed strictly from bars BEFORE entry. Using the window's own
// volatility would let the label peek at the outcome it is trying to
// describe — the exact leakage purged_walkforward.js exists to prevent.

import { fetchKlineRange } from '../api/binance.js';

export const SYMBOL_MAP = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT' };

// Small TTL cache: when a batch of trades on the same asset resolves in one
// cycle, they often share overlapping windows. No need to re-ask Binance.
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

// How far back we look to estimate entry-time volatility. Exported so the
// backfill script uses the identical window — if live and historical labels
// were computed with different volatility lookbacks, their barriers would sit
// at different distances and the two sets of stats could not be compared.
export const LOOKBACK_MIN = 30;

// Realised volatility as a percentage, from 1-minute close-to-close returns.
// Returns null (not a fake default) when there isn't enough data — the caller
// must decide what to do rather than silently label against a made-up number.
export function realisedVolPct(bars) {
  if (!Array.isArray(bars) || bars.length < 5) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close, cur = bars[i].close;
    if (prev > 0 && cur > 0) rets.push((cur - prev) / prev);
  }
  if (rets.length < 4) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

/**
 * @param {object} p resolved position — needs { asset, entryTime, windowMin }
 * @returns {Promise<null | { entryPrice, bars, volPct, symbol }>}
 *          null whenever the real path can't be established. Callers must
 *          skip labelling in that case rather than fall back to a guess.
 */
export async function getTradePath(p) {
  const asset = (p?.asset || '').toLowerCase();
  const symbol = SYMBOL_MAP[asset];
  if (!symbol || !p?.entryTime) return null;

  const entryMs = new Date(p.entryTime).getTime();
  if (!Number.isFinite(entryMs)) return null;

  const windowMin = Number(p.windowMin) || 5;
  const key = `${symbol}:${entryMs}:${windowMin}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Binance won't have bars for a window that hasn't finished yet.
  const windowEndMs = entryMs + windowMin * 60 * 1000;
  if (Date.now() < windowEndMs) return null;

  const [lookbackBars, windowBars] = await Promise.all([
    fetchKlineRange(symbol, entryMs - LOOKBACK_MIN * 60 * 1000, entryMs - 1, '1m'),
    fetchKlineRange(symbol, entryMs, windowEndMs, '1m'),
  ]);

  if (!windowBars.length) return null;

  const volPct = realisedVolPct(lookbackBars);
  if (volPct == null) return null;

  const result = {
    symbol,
    entryPrice: windowBars[0].open,
    bars: windowBars,
    volPct,
  };
  cacheSet(key, result);
  return result;
}
