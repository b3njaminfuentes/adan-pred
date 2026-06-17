// Brier Protocol bridge — reports each ADAN paper bet to the shadow-phase
// ingestion endpoint so the ResolutionWatcher can settle it and the score
// cron can compute the real Brier. Fire-and-forget: a Brier outage must
// never block ADAN's trading loop.

import { writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BRIER_URL = process.env.BRIER_URL || '';
const BRIER_BOT_SLUG = process.env.BRIER_BOT_SLUG || '';
const BRIER_INGEST_KEY = process.env.BRIER_INGEST_KEY || '';

const ADAN_DIR = join(process.env.HOME || '/tmp', '.adan-pred');
try { mkdirSync(ADAN_DIR, { recursive: true }); } catch {}

function _writeStatus(data) {
  try { writeFileSync(join(ADAN_DIR, 'brier_status.json'), JSON.stringify(data, null, 2)); } catch {}
}

function _appendTrade(entry) {
  try { appendFileSync(join(ADAN_DIR, 'brier_reported.jsonl'), JSON.stringify(entry) + '\n'); } catch {}
}

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
      // Persist for TUI dashboard
      _writeStatus({
        connected: true,
        slug: BRIER_BOT_SLUG,
        brierScore: latest.brierScore,
        winRate: latest.winRate,
        totalTrades: latest.totalTrades,
        status: bot.status,
        tier1: latest.brierScore <= 0.25,
        lastSync: new Date().toISOString(),
      });
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
  if (!BRIER_URL || !BRIER_BOT_SLUG || !BRIER_INGEST_KEY) return;

  // The watcher resolves by CTF conditionId — without it the trade can't settle.
  const conditionId = market.conditionId || (String(market.id || '').startsWith('0x') ? market.id : null);
  if (!conditionId) {
    console.log('[BRIER] ⚠ no conditionId for market — bet not reported:', (market.title || '').slice(0, 40));
    return;
  }

  const entryPrice = side === 'YES' ? (market.yesPrice || 0.5) : 1 - (market.yesPrice || 0.5);
  const clampedEntry = Math.min(0.999, Math.max(0.001, entryPrice));

  try {
    const res = await fetch(`${BRIER_URL}/api/bots/${BRIER_BOT_SLUG}/paper-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-brier-key': BRIER_INGEST_KEY },
      body: JSON.stringify({
        marketId: conditionId,
        marketTitle: market.title || market.question || 'Unknown',
        side,
        amount: stake,
        entryPrice: clampedEntry,
        externalTradeId: `adan-${tradeId}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log(`[BRIER] ✅ paper bet reported → ${side} $${stake} on "${(market.title || '').slice(0, 40)}"`);
      // Append to trade log for TUI dashboard
      _appendTrade({
        ts: new Date().toISOString(),
        marketId: conditionId,
        marketTitle: market.title || market.question || 'Unknown',
        side,
        amount: stake,
        entryPrice: clampedEntry,
        tradeId: `adan-${tradeId}`,
      });
    } else {
      const err = await res.json().catch(() => ({}));
      console.log('[BRIER] ⚠ report rejected:', res.status, err.error || '');
    }
  } catch (e) {
    console.log('[BRIER] ⚠ report failed (non-blocking):', e.message);
  }
}
