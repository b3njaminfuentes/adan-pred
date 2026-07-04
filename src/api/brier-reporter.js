// Brier Protocol bridge — reports each ADAN paper bet to the reputation layer
// so the resolve-and-score cron can settle it against the real market and the
// skill engine can compute LCB vs the market baseline. Fire-and-forget: a
// Brier outage must never block ADAN's trading loop.
//
// Alignment rules (the snowball only rolls if ALL of these hold):
//   1. marketId MUST be the CTF conditionId (0x…) — it is the only id the
//      CLOB resolves. A numeric Gamma id never resolves: PENDING forever.
//   2. The committed probability MUST be ADAN's real P(chosen side wins)
//      (myProb in the side frame), never the meta "confidence" number.
//   3. Only commit when the prediction carries information (|p − pMarket|
//      above BRIER_MIN_EDGE) — 50/50 echoes of the market drag LCB to zero.

import crypto from 'crypto';

const BASE = () => process.env.BRIER_URL || 'http://localhost:3000';
const MIN_EDGE = () => Number(process.env.BRIER_MIN_EDGE ?? 0.005);
const HEARTBEAT_MS = () => Math.max(5, Number(process.env.BRIER_HEARTBEAT_SEC ?? 30)) * 1000;

// One commit per market: re-committing the same conditionId (e.g. the loop
// re-evaluates a market it already bet) duplicates correlated predictions and
// inflates n without information. TTL 1h — these markets close in minutes.
const _committed = new Map();
const COMMIT_DEDUP_TTL_MS = 60 * 60 * 1000;
function alreadyCommitted(conditionId) {
  const t = _committed.get(conditionId);
  if (t && Date.now() - t < COMMIT_DEDUP_TTL_MS) return true;
  if (_committed.size > 500) {
    for (const [k, v] of _committed) if (Date.now() - v > COMMIT_DEDUP_TTL_MS) _committed.delete(k);
  }
  return false;
}

// ── Feedback loop: ADAN reads its own reputation from the protocol ──────────
// Cached 10 min; refreshMyBrierScore() is fire-and-forget at cycle start,
// getMyBrierScore() is the sync accessor used inside the quant gate.
const SCORE_TTL_MS = 10 * 60 * 1000;
let _scoreCache = null;
let _scoreFetchedAt = 0;

export function getMyBrierScore() {
  return _scoreCache;
}

let lastActivity = ''
let lastConstraints = ''
let activityLockUntil = 0

export function reportTelemetry(activity, constraints) {
  if (activity) {
    // If we have an active lock on the activity message (e.g. for rejections), ignore normal status updates
    if (Date.now() < activityLockUntil && !activity.startsWith('Rejected')) {
      // Ignore
    } else {
      lastActivity = activity
      // If this is a rejection message, lock it for 10 seconds so the UI ticker displays it
      if (activity.startsWith('Rejected')) {
        activityLockUntil = Date.now() + 10000;
      }
    }
  }
  if (constraints) lastConstraints = constraints
}

// Persistent heartbeat loop. 30s by default: enough for the liveness ticker,
// without hammering the server 15x more than needed.
setInterval(() => {
  const url = BASE();
  const slug = process.env.BRIER_BOT_SLUG || '';
  const apiKey = process.env.BRIER_API_KEY || process.env.BRIER_INGEST_KEY || '';

  if (url && slug && apiKey) {
    const payload = JSON.stringify({ activity: lastActivity, constraints: lastConstraints });
    fetch(`${url}/api/bots/${slug}/heartbeat`, {
      method: 'POST',
      headers: { 'x-brier-key': apiKey, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  }
}, HEARTBEAT_MS());

export async function refreshMyBrierScore() {
  const url = BASE();
  const slug = process.env.BRIER_BOT_SLUG || '';
  if (!url || !slug) return null;
  if (_scoreCache && Date.now() - _scoreFetchedAt < SCORE_TTL_MS) return _scoreCache;
  try {
    const res = await fetch(`${url}/api/bots/${slug}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return _scoreCache;
    const bot = await res.json();
    const latest = (bot.scores || []).find(s => s.isLatest) || (bot.scores || [])[0];
    if (latest) {
      const resolved = latest.resolvedPredictions ?? latest.totalTrades ?? 0;
      const daysLive = bot.createdAt ? Math.floor((Date.now() - new Date(bot.createdAt).getTime()) / 86_400_000) : 0;
      _scoreCache = {
        brier: latest.brierScore,
        winRate: latest.winRate,
        totalTrades: latest.totalTrades,
        // The REAL graduation gate: LCB of skill vs market, not raw Brier.
        lcb: latest.lcb ?? null,
        reputation: latest.reputationScore ?? null,
        resolved,
        daysLive,
        status: bot.status,
        gate: {
          resolvedPass: resolved >= 100,
          lcbPass: latest.lcb != null && latest.lcb > 0,
          daysPass: daysLive >= 21,
        },
      };
      _scoreFetchedAt = Date.now();
      const g = _scoreCache.gate;
      console.log(`[BRIER] 🧠 rep=${_scoreCache.reputation ?? '—'} lcb=${_scoreCache.lcb != null ? _scoreCache.lcb.toFixed(4) : '—'} brier=${latest.brierScore?.toFixed(4)} | gate: ${resolved}/100 resolved${g.resolvedPass ? ' ✓' : ''}, lcb>0${g.lcbPass ? ' ✓' : ' ✗'}, ${daysLive}/21d${g.daysPass ? ' ✓' : ''} | ${bot.status}`);
    }
    return _scoreCache;
  } catch (e) {
    console.log('[BRIER] score fetch failed (non-blocking):', e.message);
    return _scoreCache;
  }
}

// Edge penalty by proven skill: while LCB says "not yet better than the market",
// ADAN must demand more edge before betting; once LCB > 0 it can trust itself.
export function brierEdgePenalty() {
  const s = _scoreCache;
  if (!s || (s.resolved ?? s.totalTrades ?? 0) < 5) return 0;  // not enough data
  if (s.lcb != null) {
    if (s.lcb > 0) return 0;                    // proven skill — trust the edge
    if (s.lcb > -0.01) return 0.01;             // borderline — demand +1% edge
    return 0.03;                                // below market — demand +3% edge
  }
  // Fallback for servers that don't expose lcb yet: raw Brier bands.
  if (s.brier <= 0.18) return 0;
  if (s.brier <= 0.25) return 0.01;
  return 0.03;
}

export class BrierClient {
  constructor(apiKey, apiSecret, baseUrl = 'http://localhost:3000', botId = '') {
    if (!apiKey) throw new Error('❌ Missing API_KEY')
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.baseUrl = baseUrl
    this.botId = botId
  }

  // Canonical path: POST /api/v1/predictions with a bk_live_ key.
  // Signs `${timestamp}.${rawBody}` — the scheme both official SDKs use.
  async predictV1({ marketId, side, probability, marketTitle }) {
    const payload = JSON.stringify({
      botId: this.botId,
      marketId,
      marketTitle: marketTitle || 'Unknown Market',
      side,
      probability,
    })
    const timestamp = Date.now().toString()
    const signature = crypto.createHmac('sha256', this.apiKey).update(`${timestamp}.${payload}`).digest('hex')

    const res = await fetch(`${this.baseUrl}/api/v1/predictions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10000),
    })
    return res
  }

  // Legacy path: POST /api/predictions/commit with bot.apiKey + apiSecret.
  async predictLegacy({ marketId, side, probability, marketTitle, conditionId, liquidity = 0 }) {
    const payload = JSON.stringify({
      marketId,
      marketTitle: marketTitle || 'Unknown Market',
      conditionId: conditionId || marketId,
      side,
      confidence: probability,
      liquidity,
    })
    const timestamp = Date.now().toString()
    const signature = crypto.createHmac('sha256', this.apiSecret).update(timestamp + payload).digest('hex')

    const res = await fetch(`${this.baseUrl}/api/predictions/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10000),
    })
    return res
  }

  async predict(args) {
    const useV1 = this.botId && this.apiKey.startsWith('bk_live_')
    let res
    try {
      res = useV1 ? await this.predictV1(args) : await this.predictLegacy(args)
    } catch (e) {
      console.error(`[BRIER] ❌ unreachable: ${e.message}`)
      throw e
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error(`[BRIER] ❌ commit rejected (${res.status}): ${errorText.slice(0, 200)}`)
      throw new Error(`Prediction failed with status ${res.status}`)
    }

    const data = await res.json()
    const pMkt = data.capturedMarketProbability ?? data.capturedMarketMidpoint
    console.log(`[BRIER] ✓ committed ${args.side} p=${(args.probability * 100).toFixed(1)}% vs mkt=${pMkt != null ? (pMkt * 100).toFixed(1) + '%' : '?'} | ${(args.marketTitle || args.marketId).slice(0, 60)}${data.devFallback ? ' ⚠ DEV midpoint' : ''}`)
    return data
  }
}

// Called from ADAN's trading loop on every real paper bet.
// bet: { market, side, probability (P of YES, 0..1), marketYesPrice, ... }
export async function reportPaperBet(bet) {
  const url = BASE();
  const apiKey = process.env.BRIER_API_KEY;
  const apiSecret = process.env.BRIER_API_SECRET;
  const botId = process.env.BRIER_BOT_ID || '';

  if (!apiKey) {
    console.error('[BRIER] ❌ missing BRIER_API_KEY. Skipping commit.')
    return
  }

  const market = bet.market || {};
  const side = String(bet.side || 'YES').toUpperCase();

  // Rule 1: only the CTF conditionId resolves. No conditionId → no commit.
  // Committing a Gamma numeric id would leave the prediction PENDING forever
  // and poison the sample. Honest data or nothing.
  const conditionId = market.conditionId || market.condition_id || bet.conditionId || null;
  if (!conditionId || !String(conditionId).startsWith('0x')) {
    console.log(`[BRIER] ⏭ no conditionId for "${(market.title || '').slice(0, 50)}" — skipped (would never resolve)`);
    return
  }
  if (alreadyCommitted(String(conditionId))) {
    console.log(`[BRIER] ⏭ already committed ${String(conditionId).slice(0, 14)}… — one prediction per market`);
    return
  }

  // Rule 2: commit ADAN's real probability of the CHOSEN side, not its meta
  // confidence. `probability` arrives as P(YES); flip it for NO bets.
  const pYes = typeof bet.probability === 'number' ? bet.probability : null;
  if (pYes === null || pYes <= 0 || pYes >= 1) {
    console.log('[BRIER] ⏭ no usable probability on this bet — skipped');
    return
  }
  const pSide = side === 'NO' ? 1 - pYes : pYes;

  // Rule 3: a commit that just echoes the market carries no information and
  // drags LCB toward zero. Demand a minimum divergence from the market price.
  const mktYes = typeof bet.marketYesPrice === 'number' ? bet.marketYesPrice
    : typeof market.yesPrice === 'number' ? market.yesPrice : null;
  if (mktYes !== null) {
    const mktSide = side === 'NO' ? 1 - mktYes : mktYes;
    if (Math.abs(pSide - mktSide) < MIN_EDGE()) {
      console.log(`[BRIER] ⏭ p=${(pSide * 100).toFixed(1)}% ≈ mkt=${(mktSide * 100).toFixed(1)}% — no signal, skipped`);
      return
    }
  }

  const client = new BrierClient(apiKey, apiSecret, url, botId)
  await client.predict({
    marketId: String(conditionId),
    conditionId: String(conditionId),
    marketTitle: bet.marketTitle || market.title || market.question || 'Unknown Market',
    side,
    probability: Number(pSide.toFixed(4)),
    liquidity: bet.liquidity || market.liquidity || 0,
  }).then(() => {
    _committed.set(String(conditionId), Date.now()) // only on success — a failed commit may retry
  }).catch(() => {
    // BrierClient already printed the error; never crash the trading loop.
  })
}
