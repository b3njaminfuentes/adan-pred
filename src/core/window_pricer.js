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

// Bar size to measure volatility at, given the horizon being priced.
//
// The 5/15-min path estimates sigma from 1-minute returns and scales it by
// sqrt(minutes remaining). That is fine over minutes, but scaling 1-minute
// vol out to a 24-hour horizon is badly biased: short-horizon returns
// mean-revert, so sqrt-of-time from 1m systematically OVERSTATES the vol of
// a long window. An overstated sigma shrinks z, pushes pUp toward 0.5, and
// the model would simply never see an edge on daily markets.
//
// Fix: measure sigma at roughly the same timescale as the prediction. Each
// interval is chosen so a full window spans ~24-96 bars — enough samples for
// a stable estimate without reaching back into a different vol regime.
function barIntervalFor(winMin) {
  if (winMin <= 30) return { interval: '1m', barMin: 1 };
  if (winMin <= 180) return { interval: '5m', barMin: 5 };
  if (winMin <= 720) return { interval: '15m', barMin: 15 };
  return { interval: '1h', barMin: 60 };
}

// Per-bar log-return volatility from the last `limit` bars of `interval`.
// Returns null (never a guess) if Binance is unreachable or the tape is dead.
async function realizedSigmaAt(sym, interval, limit = 60) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const k = await res.json();
    if (!Array.isArray(k) || k.length < 20) return null;
    const closes = k.map(c => parseFloat(c[4])).filter(Number.isFinite);
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
      const r = Math.log(closes[i] / closes[i - 1]);
      if (Number.isFinite(r)) rets.push(r);
    }
    if (rets.length < 15) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const s = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length);
    return s > 1e-8 ? s : null;
  } catch { return null; }
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
  // Horizons this pricer will quote. 5/15 are the original intraday windows;
  // 60/240/1440 are the hourly and daily Up-or-Down markets, which have
  // orders of magnitude more volume ($94k on a daily vs $15-47 on a 5-min)
  // and were never priced because of a hardcoded 5-or-15 gate. The maths is
  // horizon-agnostic — only the volatility estimate has to follow the scale.
  const SUPPORTED = [5, 15, 60, 240, 1440];
  if (!SUPPORTED.includes(winMin)) return null;
  if (!market.closesAt) return null;

  const isLongHorizon = winMin > 15;

  const endMs = new Date(market.closesAt).getTime();
  const now = Date.now();
  const remainMin = (endMs - now) / 60000;
  // Too late: execution/settlement risk dominates. The floor scales with the
  // horizon — 30 seconds is a sane cutoff on a 5-minute window and reckless
  // on a daily one, where a fill can still move materially against us.
  const minRemain = Math.max(0.5, winMin * 0.02);
  // Too early: no information has accumulated yet (delta ~ 0 → pUp ~ 0.5 →
  // no edge anyway, so this mostly saves the API calls below).
  if (!(remainMin > minRemain) || remainMin > winMin - 0.3) return null;

  const sym = SYM_MAP[market.asset];
  const pd = market.priceData;
  if (!sym || !pd?.price) return null;

  const closes = pd.closes || [];
  // Short windows read sigma off the in-memory 1m tape; long ones fetch their
  // own bars below and do not need it.
  if (!isLongHorizon && closes.length < 15) return null;

  const startMs = endMs - winMin * 60000;
  const startPrice = await binanceOpenAt(sym, startMs);
  if (!startPrice || startPrice <= 0) return null;

  // Fresh spot + clock measured in the same instant, AFTER all awaits.
  const livePrice = (await spotPrice(sym)) ?? pd.price;
  const nowFresh = Date.now();
  const remainFresh = (endMs - nowFresh) / 60000;
  if (!(remainFresh > 0.4)) return null; // window nearly over after fetch latency

  // Volatility, measured at the timescale we are predicting over. Both
  // branches produce a PER-BAR sigma; `barMin` says how long a bar is, so the
  // z-score below divides by sqrt(remaining bars) in either case.
  let sigma, barMin;
  if (isLongHorizon) {
    const cfg = barIntervalFor(winMin);
    barMin = cfg.barMin;
    sigma = await realizedSigmaAt(sym, cfg.interval);
    if (sigma == null) return null; // no vol estimate, no opinion
  } else {
    barMin = 1;
    // Realized per-minute vol from in-memory 1m closes (last ~30 bars).
    const rets = [];
    const tail = closes.slice(-31);
    for (let i = 1; i < tail.length; i++) {
      const r = Math.log(tail[i] / tail[i - 1]);
      if (Number.isFinite(r)) rets.push(r);
    }
    if (rets.length < 10) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    sigma = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length);
    if (!(sigma > 1e-6)) return null; // dead tape: no vol estimate, no opinion
  }

  const delta = Math.log(livePrice / startPrice);
  const remainBars = Math.max(remainFresh / barMin, 0.25);
  const z = delta / (sigma * Math.sqrt(remainBars));
  const raw = phi(z);
  const pUp = Math.min(0.97, Math.max(0.03, raw)); // clamp: model humility

  // Refuse to quote when the model has no actual opinion. Both edges of that
  // are dangerous once a caller subtracts a market price from pUp:
  //
  //   z ~ 0    -> pUp ~ 0.50 by default, not by evidence. Against a book at
  //               0.22/0.24 that reads as a 26-point "edge" produced entirely
  //               by the model knowing nothing.
  //   clamped  -> pUp is 0.03/0.97 because the floor says so, not because the
  //               model believes it. Buying a 2c tail on a floored number is a
  //               coin flip dressed as conviction.
  //
  // Observed both live right after the order-book fix, and they were the
  // largest apparent edges on the board — which is exactly the trap: the
  // biggest numbers came from the least informative outputs.
  const MIN_ABS_Z = 0.15;                       // below this there is no signal
  const clamped = raw < 0.03 || raw > 0.97;
  if (clamped || Math.abs(z) < MIN_ABS_Z) return null;

  return { pUp, z, delta, sigma, barMin, remainMin: remainFresh, startPrice, livePrice };
}

export function calculateEdge(pTheoretical, side, orderBook) {
    // side is 'YES' or 'NO' in polymarket terms. Let's map 'YES' -> buy, 'NO' -> buy NO (which means sell YES)
    // Actually the user's snippet uses 'buy' and 'sell', but in Polymarket we always 'buy' YES or 'buy' NO.
    // If side === 'YES', we buy YES, which costs bestAsk.
    // If side === 'NO', we buy NO, which costs 1 - bestBid (since bestBid is the highest price someone is willing to pay for YES).
    // The snippet provided:
    const executionPrice = side === 'YES' ? orderBook.bestAsk : (1 - orderBook.bestBid);
    const pSide = side === 'YES' ? pTheoretical : (1 - pTheoretical);
    
    // Net edge is your theoretical probability minus the cost to execute
    const edge = pSide - executionPrice;
    return edge; // este es el edge REAL, ya neto de spread
}
