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
import _fs from 'fs';
import _os from 'os';
import _path from 'path';

// ── Empirical calibration for committed probabilities ───────────────────────
// ADAN's stated confidence runs hot (metacalib multiplier ~0.58: "85% sure"
// has hit ~52-58% historically). The Brier score rewards the honest posterior,
// so map the stated bucket to its HISTORICAL hit rate before committing.
const _METACALIB = _path.join(_os.homedir(), '.adan-pred', 'metacalib.json');
function calibrateSide(pSide) {
  try {
    const mc = JSON.parse(_fs.readFileSync(_METACALIB, 'utf8'));
    const conf = pSide * 100;
    const key = conf >= 90 ? '90' : conf >= 80 ? '80' : conf >= 70 ? '70' : '60';
    const b = mc.buckets && mc.buckets[key];
    if (b && b.pred >= 20) {
      // Laplace-smoothed bucket hit rate. Floor at 0.5: a bucket can prove it
      // carries less information than stated, not that fading ADAN is the play.
      // Cap at the stated value: calibration only ever removes overconfidence.
      const acc = (b.correct + 1) / (b.pred + 2);
      return Math.max(0.5, Math.min(pSide, acc));
    }
    const m = typeof mc.multiplier === 'number' ? mc.multiplier : 1;
    return Math.max(0.5, 0.5 + (pSide - 0.5) * Math.min(1, m));
  } catch { return pSide }
}

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

export function triggerHeartbeat() {
  const url = BASE();
  const slug = process.env.BRIER_BOT_SLUG || '';
  const apiKey = process.env.BRIER_API_KEY || '';
  const apiSecret = process.env.BRIER_API_SECRET || '';
  const ingestKey = process.env.BRIER_INGEST_KEY || '';

  const keyToSend = apiKey.startsWith('bk_live_') ? apiSecret : (apiKey || ingestKey);

  if (url && slug && keyToSend) {
    const payload = JSON.stringify({ activity: lastActivity, constraints: lastConstraints });
    fetch(`${url}/api/bots/${slug}/heartbeat`, {
      method: 'POST',
      headers: { 'x-brier-key': keyToSend, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(4000),
    }).then(async res => {
      if (!res.ok) console.log(`[BRIER] ❌ Heartbeat failed (${res.status}): ${await res.text()}`);
      else console.log(`[BRIER] ⚡ Heartbeat sent successfully (${res.status}).`);
    }).catch(e => {
      console.log(`[BRIER] ❌ Heartbeat fetch error: ${e.message}`);
    });
  }
}

// Persistent heartbeat loop. 30s by default: enough for the liveness ticker,
// without hammering the server 15x more than needed.
setInterval(triggerHeartbeat, HEARTBEAT_MS());

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
        // LCB and days are quality signals, NOT gates. Since 30 jul 2026 the
        // vault opens on a single condition: 100 resolved predictions
        // (MIN_RESOLVED_FOR_VAULT in brier-protocol's src/lib/incubation.ts).
        // LCB and time-alive still get measured and shown because they drive
        // the reputation tier — which raises the capital ceiling — but they
        // no longer block access. This readout used to print "lcb>0 ✗,
        // 13/21d" next to the word "gate", which told the operator the bot
        // was blocked when it had in fact already qualified.
        lcb: latest.lcb ?? null,
        reputation: latest.reputationScore ?? null,
        resolved,
        daysLive,
        status: bot.status,
        gate: {
          resolvedPass: resolved >= 100,
        },
      };
      _scoreFetchedAt = Date.now();
      const vaultOpen = _scoreCache.gate.resolvedPass;
      const lcbStr = _scoreCache.lcb != null ? _scoreCache.lcb.toFixed(4) : '—';
      console.log(`[BRIER] 🧠 rep=${_scoreCache.reputation ?? '—'} brier=${latest.brierScore?.toFixed(4)} | vault: ${resolved}/100 resueltas ${vaultOpen ? '✓ HABILITADO' : '✗ falta volumen'} | tier: lcb=${lcbStr}, ${daysLive}d activo | ${bot.status}`);
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
    const signature = crypto.createHmac('sha256', this.apiSecret).update(`${timestamp}.${payload}`).digest('hex')

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

  async ping() {
    const useV1 = this.botId && this.apiKey.startsWith('bk_live_')
    if (!useV1) return { success: true, legacy: true };
    
    const payload = JSON.stringify({ botId: this.botId });
    const timestamp = Date.now().toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(`${timestamp}.${payload}`).digest('hex');

    const res = await fetch(`${this.baseUrl}/api/v1/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) {
      throw new Error(`Ping failed with status ${res.status}`);
    }
    return await res.json();
  }
}


// Called from ADAN's trading loop on every real paper bet.
// bet: { market, side, probability (P of YES, 0..1), marketYesPrice, ... }
export async function reportPaperBet(bet) {
  const url = BASE();
  const apiKey = process.env.BRIER_API_KEY;
  const apiSecret = process.env.BRIER_API_SECRET;
  const slug = process.env.BRIER_BOT_SLUG || '';
  let botId = process.env.BRIER_BOT_ID || '';

  if (!apiKey) {
    console.error('[BRIER] ❌ missing BRIER_API_KEY. Skipping commit.')
    return
  }

  // If using v1 keys but no botId is in .env, fetch it from the slug.
  if (!botId && slug && apiKey.startsWith('bk_live_')) {
    try {
      const res = await fetch(`${url}/api/bots/${slug}`);
      if (res.ok) {
        const b = await res.json();
        if (b && b.id) botId = b.id;
      }
    } catch (e) {
      // Silent fail, botId remains empty
    }
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

  // Rule 2.5: commit the calibrated posterior, never the bravado. The internal
  // gate already judges calibrated confidence; Brier must see the same honesty.
  const pCal = calibrateSide(pSide);
  if (Math.abs(pCal - pSide) > 0.005) {
    console.log(`[BRIER] 🎯 calibrated p ${(pSide * 100).toFixed(1)}% → ${(pCal * 100).toFixed(1)}% before commit`);
  }
  if (pCal <= 0.5) {
    // Calibration floored the stated confidence to a coin flip: the model is
    // claiming zero knowledge, so any divergence vs the market is an artifact
    // of the floor and the side label is arbitrary. No information, no commit.
    console.log(`[BRIER] ⏭ calibrated to ${(pCal * 100).toFixed(1)}% (coin flip) — no information, skipped`);
    return
  }

  // Rule 3: a commit that just echoes the market carries no information and
  // drags LCB toward zero. Demand a minimum divergence from the market price.
  const mktYes = typeof bet.marketYesPrice === 'number' ? bet.marketYesPrice
    : typeof market.yesPrice === 'number' ? market.yesPrice : null;
  if (mktYes !== null) {
    const mktSide = side === 'NO' ? 1 - mktYes : mktYes;
    if (Math.abs(pCal - mktSide) < MIN_EDGE()) {
      console.log(`[BRIER] ⏭ pCal=${(pCal * 100).toFixed(1)}% ≈ mkt=${(mktSide * 100).toFixed(1)}% — no signal after calibration, skipped`);
      return
    }
  }

  // Mark in-flight BEFORE sending: several children can hit the same market in
  // one scan, and success-only marking let all of them through (live dupes on
  // 18 jul). Roll back on failure so a transient error can retry next scan.
  _committed.set(String(conditionId), Date.now())
  const client = new BrierClient(apiKey, apiSecret, url, botId)
  await client.predict({
    marketId: String(conditionId),
    conditionId: String(conditionId),
    marketTitle: bet.marketTitle || market.title || market.question || 'Unknown Market',
    side,
    probability: Number(pCal.toFixed(4)),
    liquidity: bet.liquidity || market.liquidity || 0,
  }).catch(() => {
    // BrierClient already printed the error; never crash the trading loop.
    _committed.delete(String(conditionId))
  })
}

let _pingTries = 0;
export async function brierPing() {
  const url = BASE();
  const apiKey = process.env.BRIER_API_KEY;
  const apiSecret = process.env.BRIER_API_SECRET;
  
  // Try getting botId from env, or extract it from slug lookup if needed,
  // but wait, the ping payload requires botId.
  // Wait, BrierClient doesn't actually need botId for /v1/predictions if it uses API key, 
  // actually yes, /v1/ping requires botId.
  // The V1 SDK spec needs botId! Where do we get botId?
  // We can just query /api/bots/[slug] first.
  const slug = process.env.BRIER_BOT_SLUG;
  if (!apiKey || !apiSecret || !slug) return;
  
  try {
    const res = await fetch(`${url}/api/bots/${slug}`);
    if (!res.ok) return;
    const bot = await res.json();
    const botId = bot.id;
    
    const client = new BrierClient(apiKey, apiSecret, url, botId);
    await client.ping();
    console.log(`[BRIER] ⚡ Ping sent successfully for ${slug}.`);
    _pingTries = 0;
  } catch (e) {
    // A failed boot ping used to die silently and leave lastPingAt null on
    // Brier until someone pinged by hand. Log it and retry until it lands.
    _pingTries++;
    console.log(`[BRIER] ⚠ ping failed (${e && e.message}) — retry ${_pingTries}/30 in 60s`);
    if (_pingTries < 30) setTimeout(() => brierPing().catch(() => {}), 60000);
  }
}

