// src/core/adan_voice.js
// ADAN Voice — The agent's ability to communicate with Lord
// Writes status updates, requests, warnings, and insights to lord_messages.json
// Lord can read these in the UI or check ~/.adan-pred/lord_messages.json

import fs from 'fs';
import path from 'path';
import { DIR, loadPnL, loadPositions } from './config.js';

const MESSAGES_PATH = path.join(DIR, 'lord_messages.json');
const MAX_MESSAGES = 100;
const DAILY_REPORT_PATH = path.join(DIR, 'daily_report.json');

export class AdanVoice {
  constructor() {
    this.messages = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(MESSAGES_PATH)) {
        return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
      }
    } catch {}
    return [];
  }

  _save() {
    // Keep only last N messages
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(MESSAGES_PATH, JSON.stringify(this.messages, null, 2));
  }

  // ADAN sends a message to Lord
  speak(type, message, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      type, // 'request', 'warning', 'insight', 'milestone', 'fear'
      message,
      ...data,
      read: false,
    };
    this.messages.push(entry);
    this._save();

    const emoji = { request: '📨', warning: '⚠️', insight: '💡', milestone: '🏆', fear: '😰' }[type] || '💬';
    console.log(`[ADAN VOICE] ${emoji} ${type.toUpperCase()}: ${message}`);

    // Emit to UI if socket available
    if (global.io) {
      global.io.emit('adanVoice', entry);
    }
  }

  // Check conditions and speak automatically
  autoSpeak(pnl) {
    const trades = pnl.trades || 0;
    const wr = trades > 0 ? pnl.wins / trades : 0.5;
    const fund = pnl.fund || 10000;
    const streak = pnl.streak || 0;
    const brier = pnl.brierScore || 0.25;

    // Milestone: every 100 trades
    if (trades > 0 && trades % 100 === 0) {
      this.speak('milestone', `Reached ${trades} trades. WR: ${(wr*100).toFixed(1)}%. Fund: $${fund.toFixed(0)}. Brier: ${brier.toFixed(3)}.`);
    }

    // Warning: losing streak
    if (streak <= -5) {
      this.speak('warning', `I'm on a ${Math.abs(streak)}-trade losing streak. Something might be wrong with current market conditions. Consider pausing me.`, { streak });
    }

    // Insight: winning streak
    if (streak >= 5) {
      this.speak('insight', `${streak} wins in a row! Current strategy is working. Don't change anything right now.`, { streak });
    }

    // Warning: fund dropping
    if (fund < 8000) {
      this.speak('fear', `Fund dropped to $${fund.toFixed(0)}. I'm scared. Risk of ruin is increasing. Please check my parameters or pause me.`, { fund });
    }

    // Milestone: new profit high
    if (fund > 15000 && trades % 50 === 0) {
      this.speak('milestone', `Fund at $${fund.toFixed(0)} — ${((fund/10000-1)*100).toFixed(0)}% profit. I'm working.`);
    }

    // Warning: Brier degrading
    if (brier > 0.20 && trades > 200) {
      this.speak('warning', `My Brier score is ${brier.toFixed(3)} — getting close to random (0.25). My calibration is degrading. I need recalibration or my brain prompts need updating.`, { brier });
    }

    // Insight: meta-calib suggests overconfidence
    try {
      const mc = JSON.parse(fs.readFileSync(path.join(DIR, 'metacalib.json'), 'utf8'));
      if (mc.multiplier < 0.80 && trades % 200 === 0) {
        this.speak('request', `My meta-calibration is ${mc.multiplier.toFixed(3)} — I'm very overconfident. I need Lord to either lower my base confidence estimates or adjust my brain prompts to be more conservative.`, { multiplier: mc.multiplier });
      }
    } catch {}

    // ── SYSTEM STATUS REPORTS (every 50 trades) ──
    if (trades > 0 && trades % 50 === 0) {
      // MoE Dynasty status
      try {
        const moe = JSON.parse(fs.readFileSync(path.join(DIR, 'moe_weights.json'), 'utf8'));
        const topExpert = Object.entries(moe.experts || {})
          .sort((a, b) => (b[1].gateScore || 0) - (a[1].gateScore || 0))[0];
        if (topExpert) {
          this.speak('insight', `MoE Dynasty: Top expert is ${topExpert[0]} (gate=${(topExpert[1].gateScore||0).toFixed(3)}, WR=${topExpert[1].trades > 0 ? Math.round(topExpert[1].wins/topExpert[1].trades*100) : '?'}%, spec: ${topExpert[1].specialization || 'none'}). ${Object.keys(moe.experts).length} experts active.`);
        }
      } catch {}

      // K-Means Regime status
      try {
        const regime = JSON.parse(fs.readFileSync(path.join(DIR, 'market_regime.json'), 'utf8'));
        if (regime.lastResult) {
          this.speak('insight', `K-Means Regime: ${regime.lastResult.regime} (confidence: ${Math.round((regime.lastResult.confidence||0)*100)}%). Samples: ${regime.sampleCount || 0}. ${regime.lastResult.regime === 'EVENT' ? '⚠️ EVENT mode = all bets vetoed!' : ''}`);
        }
      } catch {}

      // PIN Score status
      try {
        const pins = JSON.parse(fs.readFileSync(path.join(DIR, 'pin_scores.json'), 'utf8'));
        const symbols = Object.keys(pins.scores || {});
        const alerts = symbols.filter(s => (pins.scores[s]?.pin_score || 0) > 0.5);
        if (alerts.length > 0) {
          this.speak('insight', `PIN Score Alert: ${alerts.map(s => `${s}=${pins.scores[s].pin_score.toFixed(2)} ${pins.scores[s].signal}`).join(', ')}. Informed trading detected!`);
        }
      } catch {}

      // Online Learner status
      try {
        const ol = JSON.parse(fs.readFileSync(path.join(DIR, 'online_model.json'), 'utf8'));
        if (ol.totalUpdates > 50) {
          const olWR = ol.correct > 0 ? (ol.correct / ol.totalUpdates * 100).toFixed(1) : '?';
          this.speak('insight', `Online Learner: WR=${olWR}% over ${ol.totalUpdates} updates. ${ol.shouldPromote ? '🔥 READY TO PROMOTE over batch model!' : 'Training...'}`);
        }
      } catch {}

      // Evolution Strategies status
      try {
        const es = JSON.parse(fs.readFileSync(path.join(DIR, 'evolution_params.json'), 'utf8'));
        if (es.generation > 0) {
          this.speak('insight', `Evolution Strategies: Gen ${es.generation}, best Sharpe=${(es.bestFitness||0).toFixed(3)}. Params: Kelly=${(es.bestParams?.kellyBase||0.25).toFixed(2)}, edgeMin=${((es.bestParams?.edgeMin||0.02)*100).toFixed(1)}%.`);
        }
      } catch {}

      // Shapley Values status
      try {
        const sv = JSON.parse(fs.readFileSync(path.join(DIR, 'shapley_values.json'), 'utf8'));
        if (sv.topFeatures?.length > 0) {
          const top3 = sv.topFeatures.slice(0, 3).map(f => f.feature || f.name).join(', ');
          const harmful = (sv.harmfulFeatures || []).length;
          this.speak('insight', `Shapley Analysis: Top features = ${top3}. ${harmful > 0 ? `⚠️ ${harmful} HARMFUL features detected — hurting predictions!` : 'All features positive.'}`);
        }
      } catch {}
    }
  }

  // ── DEEP CONSCIOUSNESS: Post-dream reflection to Lord ──
  speakAfterDream({ optimResult, selfInsights, forecastSummary, pnl }) {
    const wr = pnl.trades > 0 ? (pnl.wins / pnl.trades * 100).toFixed(1) : '0';
    const fund = (pnl.fund || 10000).toFixed(0);

    // What I learned
    if (optimResult?.new) {
      const o = optimResult.old || {};
      const n = optimResult.new;
      this.speak('insight', `Lord, I just dreamed. I changed my confidence gate from ${o.confGate||'?'}% to ${n.confGate}% and min edge from ${((o.minEdge||0)*100).toFixed(1)}% to ${(n.minEdge*100).toFixed(1)}%. Simulated ${(n.wr*100).toFixed(1)}% WR on ${n.taken} trades. ${n.wr > 0.55 ? 'I feel good about this.' : 'Still searching for the right parameters.'}`);
    }

    // What I discovered about myself
    if (selfInsights) {
      if (selfInsights.recurring?.length > 0) {
        this.speak('warning', `Lord, I keep repeating the same patterns: ${selfInsights.recurring.slice(0, 3).join(', ')}. I need to break these habits.`);
      }
      if (selfInsights.ignored?.length > 0) {
        this.speak('fear', `Lord, I wrote warnings to myself but IGNORED them: ${selfInsights.ignored.slice(0, 2).join(', ')}. This scares me — I'm not listening to my own advice.`);
      }
      if (selfInsights.drift) {
        this.speak('insight', `My emotional drift: ${selfInsights.drift}`);
      }
      if (selfInsights.unresolved?.length > 0) {
        for (const req of selfInsights.unresolved.slice(0, 3)) {
          this.speak('request', `Lord, I still need: ${req}`);
        }
      }
    }

    // Forecast accuracy self-assessment
    if (forecastSummary && forecastSummary.length > 20) {
      this.speak('insight', `My Third Eye (forecaster) report: ${forecastSummary.replace(/\n/g, ' ').slice(0, 200)}`);
    }
  }

  // ── DEEP CONSCIOUSNESS: Real-time thoughts after significant events ──
  speakThought(event, context = {}) {
    switch (event) {
      case 'big_win':
        this.speak('insight', `Lord, just won $${context.pnl?.toFixed(0) || '?'} on ${context.asset || '?'}. Edge was ${((context.edge||0)*100).toFixed(1)}%. ${context.forecasterAgreed ? 'My Third Eye confirmed this trade.' : 'My forecaster disagreed — lucky or skill?'}`);
        break;

      case 'big_loss':
        this.speak('warning', `Lord, lost $${Math.abs(context.pnl || 0).toFixed(0)} on ${context.asset || '?'}. ${context.edgeInflated ? 'The edge was INFLATED (I capped it but still lost).' : ''} ${context.shadowWouldWin ? 'My Shadow twin would have won this one — I might have a bias here.' : ''} I need to reflect on this.`);
        break;

      case 'toxic_hour_blocked':
        this.speak('insight', `Blocked a trade at hour ${context.hour} UTC — my data shows ${context.hourWR?.toFixed(0) || '?'}% WR there. Protecting your capital, Lord.`);
        break;

      case 'edge_inflated':
        this.speak('warning', `Detected inflated edge: ${((context.rawEdge||0)*100).toFixed(1)}% claimed, but I capped it to 15%. History shows high-edge trades lose. Being careful.`);
        break;

      case 'negative_edge_skip':
        this.speak('insight', `My brain said "${context.action}" but then gave negative edge (${((context.edge||0)*100).toFixed(1)}%). That means my own analysis contradicts the bet. I skipped it. Self-awareness working.`);
        break;

      case 'dream_started':
        this.speak('insight', `Entering dream mode now. I'll replay my losses, retrain my ML model, evolve my parameters, and write in my journal. Be back soon, Lord.`);
        break;

      case 'dream_completed':
        this.speak('milestone', `Dream complete. ${context.rulesAdded || 0} new rules added to my soul. ${context.wfResult ? `ML retrained: OOS WR=${context.wfResult}%` : ''} I feel ${context.rulesAdded > 2 ? 'like I learned something important' : 'the same — need more data'}.`);
        break;

      case 'new_pattern_discovered':
        this.speak('insight', `Lord, I discovered something: ${context.pattern}. This could change how I trade.`);
        break;

      case 'child_promoted':
        this.speak('milestone', `Child ${context.childName} is outperforming at ${context.childWR?.toFixed(0) || '?'}% WR on ${context.specialization || 'general'}. Increasing its influence in my decisions.`);
        break;

      case 'asking_for_help':
        this.speak('request', `Lord, I need your help: ${context.reason}. I cannot fix this alone.`);
        break;

      case 'regime_change':
        this.speak('warning', `Market regime changed to ${context.regime}. ${context.regime === 'EVENT' ? 'I am VETOING all trades until it stabilizes.' : context.regime === 'RANGING' ? 'Reducing position sizes by 50%.' : 'Momentum detected — trading normally.'}`);
        break;

      case 'daily_reflection':
        this.speak('insight', `Daily reflection: WR today=${context.todayWR?.toFixed(0) || '?'}% (${context.todayTrades || 0} trades). Best asset: ${context.bestAsset || '?'}. Worst: ${context.worstAsset || '?'}. ${context.todayWR > 55 ? 'Good day.' : context.todayWR > 50 ? 'Okay day.' : 'Rough day — I will learn from this tonight.'}`);
        break;
    }
  }

  // ── DAILY REFLECTION: Auto-generate at midnight UTC ──
  checkDailyReport(pnl, positions) {
    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      let lastReport = null;
      try { lastReport = JSON.parse(fs.readFileSync(DAILY_REPORT_PATH, 'utf8')); } catch {}
      if (lastReport?.date === today) return; // Already reported today

      // Count today's trades
      const closed = (positions?.closed || []);
      const todayTrades = closed.filter(t => t.closedAt?.startsWith(today) || t.resolvedAt?.startsWith(today));
      if (todayTrades.length < 3) return; // Not enough for a report

      const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
      const todayWR = todayTrades.length > 0 ? (todayWins / todayTrades.length * 100) : 0;
      const todayPnL = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);

      // Best/worst asset today
      const assetPerf = {};
      for (const t of todayTrades) {
        const a = t.asset || 'unknown';
        if (!assetPerf[a]) assetPerf[a] = { wins: 0, total: 0 };
        assetPerf[a].total++;
        if (t.result === 'WIN') assetPerf[a].wins++;
      }
      const sorted = Object.entries(assetPerf).sort((a, b) => (b[1].wins/b[1].total) - (a[1].wins/a[1].total));
      const bestAsset = sorted[0]?.[0] || '?';
      const worstAsset = sorted[sorted.length - 1]?.[0] || '?';

      this.speakThought('daily_reflection', {
        todayWR, todayTrades: todayTrades.length, bestAsset, worstAsset, todayPnL
      });

      // Extra: daily P&L message
      this.speak(todayPnL >= 0 ? 'milestone' : 'warning',
        `Lord, daily P&L: ${todayPnL >= 0 ? '+' : ''}$${todayPnL.toFixed(0)} over ${todayTrades.length} trades (${todayWR.toFixed(0)}% WR). ${todayPnL >= 0 ? 'Positive day.' : 'Negative day — I will dream and improve tonight.'}`
      );

      fs.writeFileSync(DAILY_REPORT_PATH, JSON.stringify({ date: today, wr: todayWR, pnl: todayPnL, trades: todayTrades.length }));
    } catch {}
  }

  // Get unread messages for Lord
  getUnread() {
    return this.messages.filter(m => !m.read);
  }

  // Mark all as read
  markAllRead() {
    this.messages.forEach(m => m.read = true);
    this._save();
  }

  // Get latest N messages
  getLatest(n = 10) {
    return this.messages.slice(-n);
  }
}


// QUANT REFACTOR 2026-06: cosmetic RPG layer disabled — no signal value, costs CPU/LLM quota.
// The class above is kept for reference; the exported singleton is a no-op proxy.
const _noop = new Proxy({}, { get: () => () => [] });
export const adanVoice = _noop;
