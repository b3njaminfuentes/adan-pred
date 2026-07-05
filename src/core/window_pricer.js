// src/core/window_pricer.js
// GAUSS: terminal-distribution pricer for Polymarket Up/Down windows.
//
// An "Up or Down" market asks: will price end the window above where it
// started? Mid-window, Binance already shows the move made so far. Given
// (move so far, time remaining, realized per-minute vol), the probability
// of finishing UP is a closed-form normal-CDF computation, not a guess:
//
//   z   = ln(current / windowStart) / (sigma_1m * sqrt(minutes_remaining))
//   pUp = Phi(z)
//
// This is the latency-edge thesis made executable: thin Polymarket books
// update slower than Binance spot. When pUp diverges from the executable
// quote net of fees, that gap is the edge. The ledger tracks this model
// under childSpec "gauss-*" so its calibration is measured like any child.

const SYM_MAP = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT' };

// Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8)
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// Fresh spot price. The in-memory priceData snapshot can be 20-60s old by the
// time GAUSS runs (child trades + LLM races sit between the fetch and us);
// pricing a 5-min window with a stale price systematically inflates |z| on
// busy cycles while the fill executes at the fresh book: adverse selection.
async function spotPrice(sym) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = await res.json();
    const p = parseFloat(j.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { }
  return null;
}

// Binance 1m open at exactly tsMs (Polymarket windows align to clock minutes).
// Returns null on any failure — the caller must skip, never guess.
async function binanceOpenAt(sym, tsMs) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&startTime=${tsMs}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const k = await res.json();
    if (Array.isArray(k) && k.length && k[0][0] === tsMs) return parseFloat(k[0][1]);
  } catch { }
  return null;
}

// market: normalized Polymarket market (closesAt, windowMin, asset, priceData)
// Returns { pUp, z, delta, sigma, remainMin, startPrice } or null (no opinion).
export async function priceWindow(market) {
  const winMin = market.windowMin;
  if (winMin !== 5 && winMin !== 15) return null;
  if (!market.closesAt) return null;

  const endMs = new Date(market.closesAt).getTime();
  const now = Date.now();
  const remainMin = (endMs - now) / 60000;
  // Too late: execution/settlement risk dominates. Too early: no information
  // has accumulated yet (delta ~ 0 → pUp ~ 0.5 → no edge anyway).
  if (!(remainMin > 0.5) || remainMin > winMin - 0.3) return null;

  const sym = SYM_MAP[market.asset];
  const pd = market.priceData;
  if (!sym || !pd?.price) return null;

  const closes = pd.closes || [];
  if (closes.length < 15) return null;

  const startMs = endMs - winMin * 60000;
  const startPrice = await binanceOpenAt(sym, startMs);
  if (!startPrice || startPrice <= 0) return null;

  // Fresh spot + clock measured in the same instant, AFTER all awaits.
  const livePrice = (await spotPrice(sym)) ?? pd.price;
  const nowFresh = Date.now();
  const remainFresh = (endMs - nowFresh) / 60000;
  if (!(remainFresh > 0.4)) return null; // window nearly over after fetch latency

  // Realized per-minute vol from in-memory 1m closes (last ~30 bars).
  const rets = [];
  const tail = closes.slice(-31);
  for (let i = 1; i < tail.length; i++) {
    const r = Math.log(tail[i] / tail[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sigma = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length);
  if (!(sigma > 1e-6)) return null; // dead tape: no vol estimate, no opinion

  const delta = Math.log(livePrice / startPrice);
  const z = delta / (sigma * Math.sqrt(Math.max(remainFresh, 0.25)));
  const pUp = Math.min(0.97, Math.max(0.03, phi(z))); // clamp: model humility

  return { pUp, z, delta, sigma, remainMin: remainFresh, startPrice, livePrice };
}
