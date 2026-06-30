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

// Start a persistent 4-second heartbeat loop
setInterval(() => {
  const url = process.env.BRIER_URL || '';
  const slug = process.env.BRIER_BOT_SLUG || '';
  const ingestKey = process.env.BRIER_INGEST_KEY || '';
  
  if (url && slug && ingestKey) {
    fetch(`${url}/api/bots/${slug}/heartbeat`, {
      method: 'POST',
      headers: { 'x-brier-key': ingestKey },
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

export async function reportPaperBet(bet) {
  const url = process.env.BRIER_URL || '';
  const apiKey = process.env.BRIER_API_KEY || '';
  const apiSecret = process.env.BRIER_API_SECRET || '';

  if (!url || !apiKey || !apiSecret) return;
  try {
    const payload = JSON.stringify({
      marketId: bet.marketId,
      marketTitle: bet.marketTitle,
      conditionId: bet.conditionId,
      side: bet.side, // "YES" | "NO"
      confidence: bet.confidence,
      marketProbabilityAtCommit: bet.marketProbabilityAtCommit,
      liquidity: bet.liquidity,
    });
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', apiSecret).update(ts + payload).digest('hex');

    const res = await fetch(`${url}/api/predictions/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'x-timestamp': ts,
        'x-signature': sig,
      },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log('[BRIER] SDK commit failed:', res.status, await res.text());
    } else {
      console.log('[BRIER] SDK prediction committed to Brier Protocol shadow layer');
    }
  } catch (e) {
    console.log('[BRIER] SDK network error:', e.message);
  }
}
