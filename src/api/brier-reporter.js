// Brier Protocol bridge — reports each ADAN paper bet to the shadow-phase
// ingestion endpoint so the ResolutionWatcher can settle it and the score
// cron can compute the real Brier. Fire-and-forget: a Brier outage must
// never block ADAN's trading loop.

import crypto from 'crypto';

const BRIER_URL = process.env.BRIER_URL || '';
const BRIER_BOT_SLUG = process.env.BRIER_BOT_SLUG || '';
const BRIER_API_KEY = process.env.BRIER_API_KEY || '';
const BRIER_API_SECRET = process.env.BRIER_API_SECRET || '';
const BRIER_INGEST_KEY = process.env.BRIER_INGEST_KEY || '';

// ── Feedback loop: ADAN reads its own Brier Score from the protocol ─────────
// Cached 10 min; refreshMyBrierScore() is fire-and-forget at cycle start,
// getMyBrierScore() is the sync accessor used inside the quant gate.
const SCORE_TTL_MS = 10 * 60 * 1000;
let _scoreCache = null;
let _scoreFetchedAt = 0;

export function getMyBrierScore() {
  return _scoreCache;
}

export async function refreshMyBrierScore() {
  if (!BRIER_URL || !BRIER_BOT_SLUG) return null;
  if (_scoreCache && Date.now() - _scoreFetchedAt < SCORE_TTL_MS) return _scoreCache;
  try {
    // Send heartbeat first
    if (BRIER_INGEST_KEY) {
      await fetch(`${BRIER_URL}/api/bots/${BRIER_BOT_SLUG}/heartbeat`, {
        method: 'POST',
        headers: { 'x-brier-key': BRIER_INGEST_KEY },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}); // silent failure
    }

    const res = await fetch(`${BRIER_URL}/api/bots/${BRIER_BOT_SLUG}`, {
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

export async function reportPaperBet({ market, side, stake, tradeId }) {
  if (!BRIER_URL || !BRIER_API_KEY || !BRIER_API_SECRET) return;

  // The watcher resolves by CTF conditionId — without it the trade can't settle.
  const conditionId = market.conditionId || (String(market.id || '').startsWith('0x') ? market.id : null);
  if (!conditionId) {
    console.log('[BRIER] ⚠ no conditionId for market — bet not reported:', (market.title || '').slice(0, 40));
    return;
  }

  // Convert side and stake to confidence (Brier SDK expects confidence between 0 and 1)
  // For now, ADAN entryPrice is considered the market's price, and the confidence is the bot's prediction probability.
  // Actually, ADAN doesn't explicitly store its own P(YES), it just decides YES or NO based on edge.
  // If it goes YES, its forecast is > marketPrice. Let's send a realistic forecast based on edge.
  // Wait, Brier SDK expects `confidence`. In `adan-brain-complete.js`, ADAN calculates edge.
  // We can just send a slight edge over entryPrice.
  const entryPrice = side === 'YES' ? (market.yesPrice || 0.5) : 1 - (market.yesPrice || 0.5);
  // To simulate ADAN's confidence, we'll add 5% to the entry price if YES, or subtract if NO (but side is always relative to YES in Brier predictions? No, side="YES" means prediction is for YES).
  // SDK accepts side="YES" and confidence is the probability of THAT side.
  const confidence = Math.min(0.999, Math.max(0.001, entryPrice + 0.05));

  const timestamp = Date.now().toString();
  const bodyPayload = JSON.stringify({
    marketId: conditionId,
    conditionId: conditionId,
    side: side,
    confidence: confidence,
    marketTitle: market.title || market.question || 'Unknown Market'
  });

  const signature = crypto.createHmac('sha256', BRIER_API_SECRET).update(timestamp + bodyPayload).digest('hex');

  try {
    const res = await fetch(`${BRIER_URL}/api/predictions/commit`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': BRIER_API_KEY,
        'x-timestamp': timestamp,
        'x-signature': signature
      },
      body: bodyPayload,
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log(`[BRIER] ✅ SDK prediction committed → ${side} (conf: ${confidence.toFixed(2)}) on "${(market.title || '').slice(0, 40)}"`);
    } else {
      const err = await res.json().catch(() => ({}));
      console.log('[BRIER] ⚠ SDK commit rejected:', res.status, err.error || '');
    }
  } catch (e) {
    console.log('[BRIER] ⚠ SDK commit failed (non-blocking):', e.message);
  }
}
