// Brier Protocol bridge — reports each ADAN paper bet to the shadow-phase
// ingestion endpoint so the ResolutionWatcher can settle it and the score
// cron can compute the real Brier. Fire-and-forget: a Brier outage must
// never block ADAN's trading loop.

import crypto from 'crypto';

// ── Feedback loop: ADAN reads its own Brier Score from the protocol ─────────
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

// Start a persistent 4-second heartbeat loop
setInterval(() => {
  const url = process.env.BRIER_URL || '';
  const slug = process.env.BRIER_BOT_SLUG || '';
  const apiKey = process.env.BRIER_API_KEY || process.env.BRIER_INGEST_KEY || '';
  
  if (url && slug && apiKey) {
    const payload = JSON.stringify({ activity: lastActivity, constraints: lastConstraints });
    fetch(`${url}/api/bots/${slug}/heartbeat`, {
      method: 'POST',
      headers: { 'x-brier-key': apiKey, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}, 4000);

export async function refreshMyBrierScore() {
  const url = process.env.BRIER_URL || '';
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
      _scoreCache = {
        brier: latest.brierScore,
        winRate: latest.winRate,
        totalTrades: latest.totalTrades,
        status: bot.status,
        tier1: latest.brierScore <= 0.25,
      };
      _scoreFetchedAt = Date.now();
      console.log(`[BRIER] 🧠 self-score: brier=${latest.brierScore.toFixed(4)} WR=${(latest.winRate * 100).toFixed(0)}% trades=${latest.totalTrades} status=${bot.status}`);
    }
    return _scoreCache;
  } catch (e) {
    console.log('[BRIER] score fetch failed (non-blocking):', e.message);
    return _scoreCache;
  }
}

// Edge penalty by calibration quality: a poorly calibrated ADAN must demand
// more edge before betting; a sharp one can trust its estimates.
export function brierEdgePenalty() {
  const s = _scoreCache;
  if (!s || s.totalTrades < 5) return 0;       // not enough data — no adjustment
  if (s.brier <= 0.18) return 0;               // sharp — trust the edge
  if (s.brier <= 0.25) return 0.01;            // ok — demand +1% edge
  return 0.03;                                 // miscalibrated — demand +3% edge
}

export class BrierClient {
  constructor(apiKey, apiSecret, baseUrl = 'http://localhost:3000') {
    if (!apiKey) throw new Error('❌ Missing API_KEY')
    if (!apiSecret) throw new Error('❌ Missing API_SECRET')
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.baseUrl = baseUrl
  }

  async predict({ marketId, side, confidence, marketTitle, conditionId, liquidity = 0, marketSlug, category }) {
    if (!marketId) throw new Error('❌ Missing marketId')
    if (typeof confidence !== 'number' || confidence <= 0 || confidence >= 1) {
      throw new Error('❌ Invalid confidence value (must be >0 and <1)')
    }
    
    const payload = JSON.stringify({
      marketId,
      marketTitle: marketTitle || 'Loading market metadata...',
      marketSlug: marketSlug || '',
      category: category || '',
      conditionId: conditionId || '',
      side,
      confidence,
      liquidity,
    })

    const timestamp = Date.now().toString()
    const signature = crypto.createHmac('sha256', this.apiSecret).update(timestamp + payload).digest('hex')

    let res
    try {
      res = await fetch(`${this.baseUrl}/api/predictions/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'x-timestamp': timestamp,
          'x-signature': signature,
        },
        body: payload,
      })
    } catch (e) {
      console.error(`❌ Could not reach Brier API: ${e.message}`)
      throw e
    }

    if (!res.ok) {
      const errorText = await res.text()
      if (res.status === 401 && errorText.includes('signature')) {
        console.error(`❌ Invalid Signature: ${errorText}`)
      } else if (res.status === 401 && errorText.includes('API Key')) {
        console.error(`❌ Invalid API Key: ${errorText}`)
      } else if (res.status === 500 && errorText.includes('EXECUTOR_URL')) {
        console.error(`❌ Missing EXECUTOR_URL on server: ${errorText}`)
      } else {
        console.error(`❌ Prediction rejected (${res.status}): ${errorText}`)
      }
      throw new Error(`Prediction failed with status ${res.status}`)
    }

    const data = await res.json()
    console.log(`\n✓ Prediction committed`)
    console.log(`  Prediction ID: ${data.predictionId}`)
    console.log(`  Market:        ${marketId} - ${marketTitle}`)
    console.log(`  Confidence:    ${(confidence * 100).toFixed(1)}%`)
    console.log(`  Timestamp:     ${new Date(Number(timestamp)).toISOString()}\n`)
    
    return data
  }
}

// Retro-compatibility wrapper for existing ADAN loop
export async function reportPaperBet(bet) {
  const url = process.env.BRIER_URL || 'http://localhost:3000';
  const apiKey = process.env.BRIER_API_KEY;
  const apiSecret = process.env.BRIER_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('❌ Missing Brier credentials in environment. Skipping bet.')
    return
  }

  const client = new BrierClient(apiKey, apiSecret, url)
  const market = bet.market || {};
  
  await client.predict({
    marketId: bet.marketId || market.condition_id || market.id || market.asset || 'unknown-asset',
    marketTitle: bet.marketTitle || market.title || market.question || (market.asset ? `${market.asset} Price Movement` : 'Unknown Market'),
    marketSlug: bet.marketSlug || market.slug || (market.asset ? `binance-${market.asset.toLowerCase()}` : ''),
    category: bet.category || market.category || 'Crypto',
    conditionId: bet.conditionId || market.condition_id || market.asset || 'unknown-asset',
    side: bet.side,
    confidence: bet.confidence || 0.85,
    liquidity: bet.liquidity || market.liquidity || 0
  }).catch(e => {
    // Top level catch just prevents the node process from crashing if predict throws
    // The BrierClient already printed the clear error to the terminal.
  })
}
