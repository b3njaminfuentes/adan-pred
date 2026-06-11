import { POLYMARKET_API } from '../core/config.js';
import dns from 'dns';
import https from 'https';
import { promisify } from 'util';

// ISP blocks gamma-api.polymarket.com at resolver level — bypass via 1.1.1.1
dns.setServers(['1.1.1.1', '8.8.8.8']);
const resolve4 = promisify(dns.resolve4);
const POLY_HOST = 'gamma-api.polymarket.com';
let _polyIP = null;

async function getPolyIP() {
  if (_polyIP) return _polyIP;
  try { _polyIP = (await resolve4(POLY_HOST))[0]; }
  catch { _polyIP = '104.18.34.205'; }
  return _polyIP;
}

// ── Polymarket helpers ───────────────────────────────────────────────────────
function httpsGet(ip, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ip, port: 443, path, method: 'GET',
      servername: POLY_HOST,
      headers: { Host: POLY_HOST, Accept: 'application/json' },
      timeout: 8000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function polyFetch(endpoint) {
  try {
    const ip = await getPolyIP();
    const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    return await httpsGet(ip, path);
  } catch { return null; }
}

// Keywords that identify crypto price markets
const CRYPTO_RE = /bitcoin|ethereum|solana|btc|eth|sol|crypto|above|below|matic|avax|doge|shib|xrp|ripple|ada|dot|link|uni|atom|near/i;

// ── Multi-Category Classification (ADAN v4.0) ──────────────────────────────
const CATEGORY_PATTERNS = {
  crypto: /bitcoin|ethereum|solana|\bbtc\b|\beth\b|\bsol\b|\bxrp\b|ripple|crypto|doge|shib|\babove\b|\bbelow\b/i,
  politics: /president|election|trump|biden|congress|senate|governor|democrat|republican|vote|poll|tariff|impeach|supreme court/i,
  sports: /\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|soccer|football|tennis|\bmma\b|\bufc\b|boxing|championship|playoffs|super bowl|world cup/i,
  macro: /fed|interest rate|cpi|inflation|gdp|unemployment|fomc|powell|recession|jobs report/i,
  events: /launch|spacex|oscar|grammy|iphone|weather|hurricane|earthquake|netflix|earnings|ipo/i,
};

function classifyMarket(title) {
  const text = (title || '').toLowerCase();
  // Check non-crypto categories FIRST (they're more specific)
  // Then crypto as fallback (since crypto patterns are very broad)
  const priorityOrder = ['politics', 'sports', 'macro', 'events', 'crypto'];
  for (const cat of priorityOrder) {
    if (CATEGORY_PATTERNS[cat].test(text)) return cat;
  }
  return 'events'; // default bucket for unclassified
}

async function fetchPolymarkets(strat) {
  const hoursMax = strat.maxHoursToClose || 168;
  const nowMs = Date.now();
  const maxMs = nowMs + Math.max(hoursMax, 720) * 3600 * 1000;
  const seen = new Set();
  const all = [];

  // ── Live 5M/15M/1H/4H "Up or Down" markets — BTC, ETH, SOL ──
  // Fetch WITHOUT ordering to get ALL active events including live ones
  await Promise.all(['bitcoin', 'ethereum', 'solana'].map(async asset => {
    const data = await polyFetch(`/events?tag_slug=${asset}&limit=200&active=true&closed=false`);
    const events = Array.isArray(data) ? data : (data?.events || data?.data || []);
    for (const ev of events) {
      if (!/up.or.down/i.test(ev.title || '')) continue;
      for (const m of (ev.markets || [])) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const endMs = m.endDate ? new Date(m.endDate).getTime()
          : ev.endDate ? new Date(ev.endDate).getTime() : 0;
        if (endMs <= nowMs || endMs > maxMs) continue;
        if (!m.question) m.question = ev.title;
        m._isUpDown = true;
        m._asset = asset;
        all.push(m);
      }
    }
  }));

  // Up-or-down only: ADAN's edge is short-window crypto price action.
  // Bulk volume scans and non-crypto categories were removed on purpose —
  // they fed the LLM noise it has no informational advantage on.

  // ── Sort: By Volume and Edge ──
  // Instead of pushing Up/Down always to the top (which starves the bot with short-expiry markets),
  // we sort purely by proximity to close, but shuffle the top 20 to ensure variety
  all.sort((a, b) => {
    const aMs = a.endDate ? new Date(a.endDate).getTime() : maxMs;
    const bMs = b.endDate ? new Date(b.endDate).getTime() : maxMs;
    return aMs - bMs;
  });

  // Keep a mix of UpDown and regular markets if we have too many
  const upDown = all.filter(m => m._isUpDown);
  const regular = all.filter(m => !m._isUpDown);

  // Return interleaved array to guarantee variety
  const mixed = [];
  let i = 0, j = 0;
  while (i < upDown.length || j < regular.length) {
    if (i < upDown.length) mixed.push(upDown[i++]);
    if (j < regular.length) mixed.push(regular[j++]);
  }

  return mixed;
}

// ── Particle Filter for Price Smoothing (Real-time updating SMC) ──────────────
const pfStates = {}; // Market ID -> Particle Filter state

function expit(x) { return 1 / (1 + Math.exp(-x)); }
function logit(p) { return Math.log(Math.max(0.001, Math.min(0.999, p)) / (1 - Math.max(0.001, Math.min(0.999, p)))); }
// Box-Muller transform for Gaussian noise (coherent with Gaussian likelihood)
function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function applyParticleFilter(marketId, obsPrice) {
  if (!pfStates[marketId]) {
    const N = 1000;
    const priorLogit = logit(obsPrice);
    const particles = new Float64Array(N);
    for (let i = 0; i < N; i++) particles[i] = priorLogit + gaussianRandom() * 0.25;
    const weights = new Float64Array(N);
    weights.fill(1 / N);
    pfStates[marketId] = { particles, weights, N };
    return obsPrice;
  }

  const state = pfStates[marketId];
  const processVol = 0.03; // Random walk process noise
  const obsNoise = 0.03;   // Observation noise tolerance
  let maxLogW = -Infinity;
  const logWeights = new Float64Array(state.N);

  for (let i = 0; i < state.N; i++) {
    // Propagate: random walk in logit space (approx normal with uniform bounds)
    state.particles[i] += gaussianRandom() * processVol;
    const prob = expit(state.particles[i]);
    // Reweight
    const logL = -0.5 * Math.pow((obsPrice - prob) / obsNoise, 2);
    const currLogW = Math.log(Math.max(state.weights[i], 1e-300)) + logL;
    logWeights[i] = currLogW;
    if (currLogW > maxLogW) maxLogW = currLogW;
  }

  let sumW = 0;
  for (let i = 0; i < state.N; i++) {
    state.weights[i] = Math.exp(logWeights[i] - maxLogW);
    sumW += state.weights[i];
  }

  let sumSq = 0;
  let estimate = 0;
  for (let i = 0; i < state.N; i++) {
    state.weights[i] /= sumW;
    sumSq += state.weights[i] * state.weights[i];
    estimate += expit(state.particles[i]) * state.weights[i];
  }

  // Systematic resampling if ESS is too low
  const ess = 1.0 / sumSq;
  if (ess < state.N / 2) {
    const cumsum = new Float64Array(state.N);
    cumsum[0] = state.weights[0];
    for (let i = 1; i < state.N; i++) cumsum[i] = cumsum[i - 1] + state.weights[i];
    const newParticles = new Float64Array(state.N);
    const u0 = Math.random() / state.N;
    let rank = 0;
    for (let j = 0; j < state.N; j++) {
      const u = u0 + j / state.N;
      while (rank < state.N - 1 && cumsum[rank] < u) rank++;
      newParticles[j] = state.particles[rank];
    }
    state.particles = newParticles;
    state.weights.fill(1 / state.N);
  }
  return estimate;
}

function normalizePolymarket(raw, prices = {}) {
  const id = String(raw.id || raw.conditionId || '');
  const title = raw.question || raw.title || raw._eventTitle || 'Unknown';

  // Parse outcome prices — outcomePrices[0] = YES/UP price, [1] = NO/DOWN price
  let yesPrice = 0.5;
  try {
    if (raw.outcomePrices) {
      const op = typeof raw.outcomePrices === 'string' ? JSON.parse(raw.outcomePrices) : raw.outcomePrices;
      if (Array.isArray(op) && op.length >= 2) {
        const p0 = parseFloat(op[0]);
        const p1 = parseFloat(op[1]);
        // Use bestBid if available (more accurate live price)
        if (raw.bestBid != null) yesPrice = parseFloat(raw.bestBid) || 0.5;
        else yesPrice = isNaN(p0) ? 0.5 : p0;
      }
    } else if (raw.bestBid != null) {
      yesPrice = parseFloat(raw.bestBid) || 0.5;
    }
  } catch { }

  // Apply Particle Filter: smooths out noise spikes and tracks true underlying probability
  yesPrice = applyParticleFilter(id, yesPrice);

  // Skip markets that are already decided (price at extreme = resolved/nearly resolved)
  if (yesPrice >= 0.85 || yesPrice <= 0.15) return null;

  const liquidity = parseFloat(raw.liquidityNum || raw.liquidity || raw.volume || 0);
  const closesAt = raw.endDate || null;

  // Detect which asset
  const text = title.toLowerCase();
  let asset = 'other';
  if (/btc|bitcoin/.test(text)) asset = 'btc';
  else if (/eth|ethereum/.test(text)) asset = 'eth';
  else if (/sol|solana/.test(text)) asset = 'sol';
  else if (/xrp|ripple/.test(text)) asset = 'xrp';

  // Detect window length from title (5min, 15min, 1h, 4h)
  let windowMin = null;
  const wMatch = title.match(/(\d+):(\d+)\w*[-–](\d+):(\d+)/);
  if (wMatch) {
    const s = parseInt(wMatch[1]) * 60 + parseInt(wMatch[2]);
    const e = parseInt(wMatch[3]) * 60 + parseInt(wMatch[4]);
    windowMin = Math.abs(e - s) || 5;
  } else if (/\b9PM ET\b|\b9pm ET\b/.test(title)) {
    windowMin = 60;
  } else if (/\b4:00PM-8:00PM\b|\b8:00PM-12:00AM\b/.test(title)) {
    windowMin = 240;
  }
  if (raw._isUpDown && !windowMin) windowMin = 5;

  // Extract price target from title if possible
  const targetMatch = title.match(/\$([0-9,]+)/);
  const targetPrice = targetMatch ? parseFloat(targetMatch[1].replace(/,/g, '')) : null;

  // Current price data for this asset
  const symMap = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT' };
  const sym = symMap[asset];
  const priceData = sym ? prices[sym] : null;

  // Rough edge hint
  let roughEdge = null;
  if (targetPrice && priceData?.price) {
    const dist = (targetPrice - priceData.price) / priceData.price * 100;
    roughEdge = Math.abs(dist) < 1 ? 0.1 : Math.abs(dist) < 2 ? 0.05 : 0;
  } else if (asset === 'other') {
    // For non-crypto markets (politics, sports) during Night Watch, we don't have Binance data.
    // Calculate a basic algorithmic edge based on pure probability asymmetry.
    roughEdge = yesPrice > 0.5 ? yesPrice - 0.5 : 0.5 - yesPrice;
  }

  const _category = raw._category || classifyMarket(title);
  // Preserve clobTokenIds for WebSocket subscription
  let clobTokenIds = null;
  try {
    if (raw.clobTokenIds) {
      clobTokenIds = typeof raw.clobTokenIds === 'string' ? JSON.parse(raw.clobTokenIds) : raw.clobTokenIds;
    }
  } catch { }
  // CTF conditionId — required by Brier's ResolutionWatcher to settle paper bets
  const conditionId = raw.conditionId || raw.condition_id || null;
  return { id, title, yesPrice, liquidity, closesAt, asset, targetPrice, roughEdge, priceData, windowMin, _isUpDown: raw._isUpDown || false, _category, clobTokenIds, conditionId };
}

// ── Check market resolution via Polymarket API (for long-horizon non-crypto) ──
async function checkMarketResolution(marketId) {
  try {
    const data = await polyFetch(`/markets/${marketId}`);
    if (!data) return null;
    return {
      resolved: !!data.resolved,
      resolution: data.resolution || null,      // 'YES' | 'NO' | null
      resolvedAt: data.resolvedAt || null,
      closed: !!data.closed,
    };
  } catch { return null; }
}

export {
  polyFetch, fetchPolymarkets, applyParticleFilter, normalizePolymarket,
  expit, logit, classifyMarket, checkMarketResolution, CATEGORY_PATTERNS
};