// src/core/inner_monologue.js
// ADAN Inner Monologue — Post-trade micro-reflection
// After every resolved trade, ADAN thinks: "why did I win/lose?"
// Uses Gemma (free) for quick analysis. Feeds insights into soul_memory.
// Ultra Consciousness Layer v2.0

import fs from 'fs';
import path from 'path';
import { DIR } from './config.js';
import { callGemma } from '../../adan-llm-router.js';

const MONOLOGUE_PATH = path.join(DIR, 'inner_monologue.jsonl');
const MAX_LINES = 500;

export class InnerMonologue {

  // Called after every trade resolution
  async reflect(tradeData) {
    const {
      asset, side, won, edge, confidence, pnl, marketTitle,
      myProb, marketPrice, brain, entryVec, regime
    } = tradeData;

    // Build a compact context for Gemma
    const rsi = entryVec?.rsi || '?';
    const trend5m = entryVec?.trend5m || '?';
    const volRatio = entryVec?.volRatio || '?';
    const buyPressure = entryVec?.buyPressure || '?';

    const prompt = `You are ADAN-PRED, an autonomous trading agent. You just ${won ? 'WON' : 'LOST'} a trade. Think about WHY in 2-3 sentences.

TRADE:
- Market: ${(marketTitle || '').slice(0, 60)}
- Side: ${side} | Edge: ${((edge || 0) * 100).toFixed(1)}% | Conf: ${confidence || '?'}%
- My prob: ${((myProb || 0) * 100).toFixed(0)}% vs market: ${((marketPrice || 0) * 100).toFixed(0)}%
- Brain: ${brain || 'DEFAULT'} | PnL: $${(pnl || 0).toFixed(2)}
- RSI: ${rsi} | Trend5m: ${trend5m} | VolRatio: ${volRatio} | BuyPressure: ${buyPressure}
- Regime: ${regime || 'unknown'}

${won
  ? 'What made this trade work? What pattern should I remember?'
  : 'What went wrong? What signal did I miss or misread? What should I avoid next time?'}

Reply in 2-3 sentences MAX. Be specific about the numbers. Start with "${won ? 'Won because' : 'Lost because'}..."`;

    try {
      const { callFast } = await import('../../adan-llm-router.js');
      const response = await callFast(prompt, { temperature: 0.15, maxTokens: 200 });
      if (!response || response.length < 20) return null;

      const thought = response.trim().split('\n')[0].slice(0, 300); // First line, max 300 chars

      const entry = {
        ts: new Date().toISOString(),
        asset,
        side,
        won,
        edge: parseFloat(((edge || 0) * 100).toFixed(1)),
        confidence: confidence || 0,
        pnl: parseFloat((pnl || 0).toFixed(2)),
        brain: brain || 'DEFAULT',
        regime: regime || 'unknown',
        thought,
      };

      this._append(entry);
      console.log(`[MONOLOGUE] 💭 ${won ? '✅' : '❌'} ${thought.slice(0, 80)}...`);
      return entry;
    } catch (e) {
      console.log('[MONOLOGUE] Error:', e.message);
      return null;
    }
  }

  _append(entry) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(MONOLOGUE_PATH, JSON.stringify(entry) + '\n');

    // Prune if too large
    try {
      const lines = fs.readFileSync(MONOLOGUE_PATH, 'utf8').trim().split('\n');
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(MONOLOGUE_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
      }
    } catch {}
  }

  // Get recent thoughts for journal context
  getRecentThoughts(n = 10) {
    try {
      if (!fs.existsSync(MONOLOGUE_PATH)) return [];
      const lines = fs.readFileSync(MONOLOGUE_PATH, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  // Get thoughts summary for journal prompt
  getThoughtsSummary() {
    const thoughts = this.getRecentThoughts(10);
    if (thoughts.length === 0) return '';

    const wins = thoughts.filter(t => t.won);
    const losses = thoughts.filter(t => !t.won);

    const lines = ['══ INNER MONOLOGUE: My recent thoughts on trades ══'];

    if (wins.length > 0) {
      lines.push(`What worked (${wins.length} wins):`);
      for (const w of wins.slice(-3)) {
        lines.push(`  ✅ ${w.thought.slice(0, 120)}`);
      }
    }
    if (losses.length > 0) {
      lines.push(`What failed (${losses.length} losses):`);
      for (const l of losses.slice(-3)) {
        lines.push(`  ❌ ${l.thought.slice(0, 120)}`);
      }
    }

    // Pattern detection: same mistake repeated?
    const lossReasons = losses.map(l => l.thought.toLowerCase());
    const repeatedWords = this._findRepeatedPatterns(lossReasons);
    if (repeatedWords.length > 0) {
      lines.push(`⚠ REPEATED MISTAKE PATTERN: "${repeatedWords.join(', ')}" appears in multiple loss reflections`);
    }

    return '\n' + lines.join('\n') + '\n';
  }

  _findRepeatedPatterns(texts) {
    if (texts.length < 2) return [];
    // Find words that appear in 2+ loss reflections (excluding common words)
    const stopWords = new Set(['the', 'a', 'an', 'i', 'my', 'was', 'is', 'in', 'on', 'at', 'to', 'of', 'and', 'or', 'but', 'for', 'with', 'this', 'that', 'it', 'be', 'as', 'not', 'lost', 'because', 'had', 'were', 'did', 'been', 'have', 'has']);
    const wordCounts = {};
    for (const text of texts) {
      const words = new Set(text.split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w)));
      for (const w of words) {
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
    }
    return Object.entries(wordCounts)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
  }
}


// QUANT REFACTOR 2026-06: cosmetic RPG layer disabled — no signal value, costs CPU/LLM quota.
// The class above is kept for reference; the exported singleton is a no-op proxy.
const _noop = new Proxy({}, { get: () => () => [] });
export const innerMonologue = _noop;
