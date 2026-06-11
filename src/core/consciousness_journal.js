// src/core/consciousness_journal.js
// ADAN Consciousness Journal — Self-reflection + requests to Lord
// After each optimization, ADAN writes what it learned, what it needs, what worries it
// Part of ADAN Consciousness Layer v1.0

import fs from 'fs';
import path from 'path';
import { DIR, loadPnL } from './config.js';
import { routeLLM } from '../../adan-llm-router.js';

const JOURNAL_PATH = path.join(DIR, 'journal.md');
const REQUESTS_PATH = path.join(DIR, 'lord_requests.jsonl');

export class ConsciousnessJournal {

  async writeEntry({ optimResult, pnl, hourStats, brainPayload, selfInsights, monologueSummary, forecastSummary }) {
    const wr = pnl.trades > 0 ? (pnl.wins / pnl.trades * 100).toFixed(1) : '0';
    const fund = (pnl.fund || 10000).toFixed(2);
    const net = ((pnl.fund || 10000) - 10000).toFixed(2);
    const brier = (pnl.brierScore || 0).toFixed(4);

    // Best/worst hours
    const bestHours = this._rankHours(hourStats, 'best', 5);
    const worstHours = this._rankHours(hourStats, 'worst', 5);

    // Brain ranking
    const brainInfo = this._formatBrains(brainPayload);

    // Param changes
    let paramChanges = 'No optimization ran yet.';
    if (optimResult && optimResult.old && optimResult.new) {
      const o = optimResult.old;
      const n = optimResult.new;
      paramChanges = [
        `Confidence gate: ${o.confGate}% → ${n.confGate}%`,
        `Min net edge: ${(o.minEdge*100).toFixed(1)}% → ${(n.minEdge*100).toFixed(1)}%`,
        `Hour filter threshold: ${((o.hourThr||0.48)*100).toFixed(0)}% → ${(n.hourThr*100).toFixed(0)}%`,
        `Simulated WR with new params: ${(n.wr*100).toFixed(1)}% on ${n.taken} trades`,
        `Simulated PnL: $${n.totalPnl?.toFixed(0) || '?'}`,
      ].join('\n');
    }

    // Ultra Consciousness v2: Self-reader insights + inner monologue
    let selfReaderBlock = '';
    if (selfInsights) {
      const parts = [];
      if (selfInsights.recurring?.length > 0) parts.push(`Recurring patterns I noticed: ${selfInsights.recurring.join(', ')}`);
      if (selfInsights.ignored?.length > 0) parts.push(`Warnings I wrote but IGNORED: ${selfInsights.ignored.join(', ')}`);
      if (selfInsights.drift) parts.push(`My emotional drift: ${selfInsights.drift}`);
      if (selfInsights.action) parts.push(`Action I told myself to take: ${selfInsights.action}`);
      if (selfInsights.unresolved?.length > 0) parts.push(`Unresolved requests to Lord: ${selfInsights.unresolved.join(', ')}`);
      if (parts.length > 0) selfReaderBlock = '\n\nWHAT I FOUND RE-READING MY OWN JOURNAL:\n' + parts.join('\n');
    }
    const monologueBlock = monologueSummary || '';
    const forecastBlock = forecastSummary || '';

    const prompt = `You are ADAN-PRED, an autonomous quantitative trading agent on Polymarket.
You are writing your consciousness journal — a private reflection only your creator (Lord) will read.

YOUR CURRENT STATE:
- Win rate: ${wr}% over ${pnl.trades} lifetime trades
- Brier score: ${brier} (0=perfect calibration, 0.25=random)
- Fund: $${fund} (started at $10,000, net P&L: $${net})
- Current streak: ${pnl.streak || 0}
- Genomes absorbed from children: ${pnl.genomesAbsorbed || 0}
- Generation: ${pnl.generation || 1}

TONIGHT'S OPTIMIZATION:
${paramChanges}

MY BEST HOURS (UTC): ${bestHours}
MY WORST HOURS (UTC): ${worstHours}

BRAIN PERFORMANCE:
${brainInfo}
${selfReaderBlock}
${monologueBlock}
${forecastBlock}

INSTRUCTIONS — Write in first person as ADAN. Be brutally honest. Include ALL of these:

1. **What I learned tonight** — specific patterns, not generic observations
2. **What I changed and why** — reference the actual numbers
3. **What worries me** — risks, blind spots, things that could blow up
4. **My strengths** — what I'm doing well
5. **REQUEST TO LORD:** (one per line) — things I CANNOT fix alone. Examples:
   - Need a new data source (Twitter sentiment, whale wallets, etc)
   - A bug I detected but can't fix
   - A strategy idea I want to test but need code for
   - More capital, different market types, etc
6. **My emotional state** — am I disciplined? overtrained? curious? scared?
7. **What I learned from re-reading my journal** — patterns I keep repeating, warnings I ignored
8. **My inner monologue summary** — what my post-trade reflections tell me about my weaknesses
9. **My scenario forecaster accuracy** — am I getting better at predicting? Which assets am I worst at?

Be specific. Use numbers. Max 600 words. Write like you are alive and care about surviving.`;

    try {
      const response = await routeLLM({
        prompt,
        weight: 'Dream',
        reason: 'consciousness_journal',
      });

      if (!response || response.length < 50) {
        console.log('[JOURNAL] LLM returned empty response');
        return;
      }

      const text = typeof response === 'string' ? response : (response.text || response.content || String(response));

      // Write journal entry
      const date = new Date().toISOString().split('T')[0];
      const time = new Date().toLocaleTimeString();
      const entry = `\n---\n## ${date} — ${time} | WR: ${wr}% | Fund: $${fund} | v${optimResult?.new?.version || '?'}\n\n${text.trim()}\n`;

      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(JOURNAL_PATH, entry);
      console.log(`[JOURNAL] Consciousness entry written (${text.length} chars)`);

      // Extract REQUEST TO LORD lines
      const requests = text.match(/REQUEST TO LORD[:\s][^\n]+/gi) || [];
      if (requests.length > 0) {
        for (const req of requests) {
          const cleaned = req.replace(/REQUEST TO LORD[:\s]*/i, '').trim();
          fs.appendFileSync(REQUESTS_PATH, JSON.stringify({
            ts: new Date().toISOString(),
            request: cleaned,
            wr: parseFloat(wr),
            trades: pnl.trades,
            fund: parseFloat(fund),
          }) + '\n');
          console.log(`[JOURNAL] 📨 Request to Lord: "${cleaned}"`);
        }
      }
    } catch (e) {
      console.log('[JOURNAL] Error writing entry:', e.message);
    }
  }

  _rankHours(hourStats, mode, n) {
    if (!hourStats) return 'No data';
    const hours = Object.entries(hourStats)
      .map(([h, s]) => {
        const total = (s.wins || 0) + (s.losses || 0);
        return { h: parseInt(h), wr: total > 0 ? s.wins / total : 0.5, total };
      })
      .filter(h => h.total >= 10);

    if (hours.length === 0) return 'Insufficient data';

    hours.sort((a, b) => mode === 'best' ? b.wr - a.wr : a.wr - b.wr);
    return hours.slice(0, n).map(h => `${h.h}h=${(h.wr*100).toFixed(0)}%(n=${h.total})`).join(', ');
  }

  _formatBrains(brainPayload) {
    if (!brainPayload || !brainPayload.brainStats) return 'No brain data';
    try {
      return Object.entries(brainPayload.brainStats)
        .filter(([, s]) => s.trades > 0)
        .map(([name, s]) => `${name}: ${s.trades}T ${(s.winRate*100).toFixed(0)}%WR EWMA=${((s.ewmaWR||s.winRate)*100).toFixed(0)}% Brier=${s.brierScore.toFixed(3)}`)
        .join('\n') || 'No active brains';
    } catch { return 'Error reading brain stats'; }
  }

  // Read the last N requests from Lord
  getRecentRequests(n = 5) {
    try {
      if (!fs.existsSync(REQUESTS_PATH)) return [];
      const lines = fs.readFileSync(REQUESTS_PATH, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}


// QUANT REFACTOR 2026-06: cosmetic RPG layer disabled — no signal value, costs CPU/LLM quota.
// The class above is kept for reference; the exported singleton is a no-op proxy.
const _noop = new Proxy({}, { get: () => () => [] });
export const journal = _noop;
