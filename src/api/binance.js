import { BINANCE_API, G, Y, R, D, BOLD, X } from '../core/config.js';

// ── Binance helpers ──────────────────────────────────────────────────────────
async function fetchBinancePrice(symbol) {
  try {
    const r = await fetch(`${BINANCE_API}/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return parseFloat(d.price) || null;
  } catch { return null; }
}

async function fetchBinanceKlines(symbol, interval = '1m', limit = 20) {
  try {
    const r = await fetch(`${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (!Array.isArray(d)) return [];
    // [openTime, open, high, low, close, volume, ...]
    return d.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5]),
      time: c[0]
    }));
  } catch { return []; }
}

// Klines for an explicit time window, not just "the last N".
// Needed to reconstruct what an asset actually did during a trade that has
// already closed — fetchBinanceKlines() above can only ever look back from
// *now*, which is useless once the window has passed.
// startTime/endTime are ms epoch, matching Binance's own convention.
async function fetchKlineRange(symbol, startTime, endTime, interval = '1m') {
  try {
    const url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}`
      + `&startTime=${Math.floor(startTime)}&endTime=${Math.floor(endTime)}&limit=1000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (!Array.isArray(d)) return [];
    return d.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5]),
      time: c[0],
    }));
  } catch { return []; }
}

// ── Technical Analysis — full suite ─────────────────────────────────────────
function calcTrend(closes) {
  if (closes.length < 3) return 0;
  const recent = closes.slice(-Math.min(closes.length, 10));
  return (recent[recent.length - 1] - recent[0]) / recent[0] * 100;
}

function calcVolatility(closes) {
  if (closes.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  // Phase 1: SMA of gains/losses over first `period` candles
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  // Phase 2: Wilder smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcMACD(closes) {
  // EMA series helper — returns array of EMA values
  const emaSeries = (arr, period) => {
    const k = 2 / (period + 1);
    const result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  };
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  // EMA-12 and EMA-26 over full close array
  const ema12Series = emaSeries(closes, 12);
  const ema26Series = emaSeries(closes, 26);
  // MACD line = EMA12 - EMA26 (from index 25 onward for meaningful values)
  const macdSeries = ema12Series.map((v, i) => v - ema26Series[i]);
  const macdValid = macdSeries.slice(25); // at least 26 values before this is meaningful
  if (macdValid.length < 9) {
    const macd = macdValid[macdValid.length - 1] || 0;
    return { macd, signal: macd, hist: 0 };
  }
  // Signal line = EMA-9 of MACD series
  const signalSeries = emaSeries(macdValid, 9);
  const macd = macdValid[macdValid.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { macd, signal, hist: macd - signal };
}

function calcBollingerBands(closes, period = 20) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0, pct: 50 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + 2 * std, lower = mid - 2 * std;
  const current = closes[closes.length - 1];
  const pct = std > 0 ? ((current - lower) / (upper - lower)) * 100 : 50;
  return { upper, mid, lower, pct, std, width: mid > 0 ? (upper - lower) / mid : 0 };
}

// VWAP (Volume-Weighted Average Price) — el único indicador con lag real en 5m
function calcVWAP(klines) {
  if (!klines || klines.length < 3) return null;
  let tpvSum = 0, volSum = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    tpvSum += tp * k.vol;
    volSum += k.vol;
  }
  if (volSum === 0) return null;
  const vwap = tpvSum / volSum;
  const current = klines[klines.length - 1].close;
  const pct = ((current - vwap) / vwap) * 100;
  return { vwap, pct, above: current > vwap };
}

// Aceleración de volumen: +1 si cada vela tiene más vol que la anterior, -1 si menos
function calcVolAccel(klines) {
  if (!klines || klines.length < 4) return 0;
  const vols = klines.slice(-4).map(k => k.vol);
  let accel = 0;
  for (let i = 1; i < vols.length; i++) {
    if (vols[i] > vols[i - 1] * 1.05) accel++;
    else if (vols[i] < vols[i - 1] * 0.95) accel--;
  }
  return accel; // -3 a +3; positivo = volumen acelerando
}

function calcVolumeProfile(klines) {
  if (!klines.length) return { trend: 'flat', spike: false, volumeLog: 0 };
  const vols = klines.map(k => k.vol);
  const avg = vols.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(vols.length - 3, 1);
  const last3 = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  // Concept #12A: log1p transform on raw volume for stable feature scaling
  const volumeLog = Math.log1p(last3);
  return {
    trend: last3 > avg * 1.5 ? 'rising' : last3 < avg * 0.6 ? 'falling' : 'flat',
    spike: last3 > avg * 2.5,
    ratio: avg > 0 ? last3 / avg : 1,
    volumeLog
  };
}

// ── Composite Intelligence Score 0-100 ───────────────────────────────────────
// Combines trend + RSI + MACD + Bollinger + volume → single confidence number
function calcIntelScore(d) {
  if (!d) return 50;
  let score = 50;
  // Trend signal
  if (d.trend1m > 0.3) score += 8;
  else if (d.trend1m > 0.1) score += 4;
  else if (d.trend1m < -0.3) score -= 8;
  else if (d.trend1m < -0.1) score -= 4;
  // 5m trend alignment
  if (d.trend5m > 0 && d.trend1m > 0) score += 6;
  if (d.trend5m < 0 && d.trend1m < 0) score -= 6;
  // RSI signal
  if (d.rsi < 30) score -= 10; // oversold — potential bounce
  else if (d.rsi > 70) score += 5;  // overbought — momentum
  else if (d.rsi > 55) score += 3;
  // MACD
  if (d.macd?.hist > 0) score += 5;
  else score -= 5;
  // Bollinger %B
  if (d.bb?.pct > 80) score += 6;  // near upper band — strong uptrend
  else if (d.bb?.pct < 20) score -= 6; // near lower band
  // Volume
  if (d.vol?.trend === 'rising') score += 5;
  if (d.vol?.spike) score += 3;
  // Volatility penalty — high vol = unpredictable
  if (d.volatility > 0.15) score -= 8;
  else if (d.volatility > 0.10) score -= 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Interpret signal direction
function signalLabel(score) {
  if (score >= 75) return G + BOLD + '▲▲ STRONG UP' + X;
  if (score >= 62) return G + '▲ UP' + X;
  if (score >= 55) return Y + '↗ SLIGHT UP' + X;
  if (score >= 45) return D + '→ NEUTRAL' + X;
  if (score >= 38) return Y + '↘ SLIGHT DN' + X;
  if (score >= 25) return R + '▼ DOWN' + X;
  return R + BOLD + '▼▼ STRONG DN' + X;
}

export {
  fetchBinancePrice, fetchBinanceKlines, fetchKlineRange, calcTrend, calcVolatility, calcRSI,
  calcMACD, calcBollingerBands, calcVWAP, calcVolAccel, calcVolumeProfile,
  calcIntelScore, signalLabel
};
