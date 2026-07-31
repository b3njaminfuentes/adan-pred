// src/ml/path_stats.js
// Per-strategy path quality — separating "reads direction well" from "gets
// rescued by mean reversion".
//
// The backfill exposed something a bare win/loss column cannot show. Two
// strategies with similar headline win rates can be winning for completely
// different reasons:
//
//   gauss-sol-15min  WR 76.6%  but TP 42.3% / SL 54.7%  → directional edge -12.4
//   sol-5min         WR 60.0%  but TP 40.0% / SL 28.0%  → directional edge +12.0
//
// The first wins more often, yet the underlying moves AGAINST it more often
// than for it — its profit comes from prices reverting before expiry, not
// from calling direction. That edge is fragile: it depends on the current
// mean-reverting regime persisting. The second calls direction genuinely
// better and is losing something to expiry timing instead.
//
// directionalEdge (TP% - SL%) is that distinction as one number. It is
// computed only from a strategy's PAST resolved trades, so it is known at
// entry time and safe to use as a live feature — no look-ahead.

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.env.HOME, '.adan-pred');
const LABELS_PATH = path.join(DIR, 'triple_barrier_labels.jsonl');

// Below this many resolved trades a strategy's TP/SL split is mostly noise.
// Return "no opinion" (0) rather than a confident-looking random number.
const MIN_N = 25;

class PathStats {
  constructor() {
    this.byChild = {};
    this.totalRows = 0;
    this.loadedAt = null;
    this._load();
  }

  _blank() {
    return { n: 0, won: 0, tp: 0, sl: 0, time: 0, tpWon: 0, slWon: 0, timeWon: 0 };
  }

  _fold(row) {
    const key = row.childSpec || '(llm-brain)';
    const b = (this.byChild[key] ||= this._blank());
    b.n++;
    if (row.won) b.won++;
    if (row.hit === 'tp') { b.tp++; if (row.won) b.tpWon++; }
    else if (row.hit === 'sl') { b.sl++; if (row.won) b.slWon++; }
    else { b.time++; if (row.won) b.timeWon++; }
    this.totalRows++;
  }

  _load() {
    try {
      if (!fs.existsSync(LABELS_PATH)) return;
      const lines = fs.readFileSync(LABELS_PATH, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try { this._fold(JSON.parse(line)); } catch { /* skip malformed row */ }
      }
      this.loadedAt = new Date().toISOString();
      const tracked = Object.keys(this.byChild).length;
      if (this.totalRows) console.log(`[PATH-STATS] Loaded: ${this.totalRows} labels across ${tracked} strategies`);
    } catch (e) {
      console.error('[PATH-STATS] Load error:', e.message);
    }
  }

  // Append a freshly resolved trade and fold it into the running stats, so
  // the dataset keeps growing from live trading rather than freezing at the
  // backfill snapshot.
  append(row) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(LABELS_PATH, JSON.stringify(row) + '\n');
      this._fold(row);
    } catch (e) {
      console.error('[PATH-STATS] Append error:', e.message);
    }
  }

  getChild(childSpec) {
    const b = this.byChild[childSpec || '(llm-brain)'];
    if (!b || b.n === 0) return null;
    const pct = x => x / b.n * 100;
    return {
      n: b.n,
      winRate: pct(b.won),
      tpPct: pct(b.tp),
      slPct: pct(b.sl),
      timePct: pct(b.time),
      directionalEdge: pct(b.tp) - pct(b.sl),
      wrGivenTP: b.tp ? b.tpWon / b.tp * 100 : null,
      wrGivenSL: b.sl ? b.slWon / b.sl * 100 : null,
    };
  }

  // The feature. 0 means "not enough evidence", which is also the neutral
  // value — a strategy we know nothing about should not be pushed either way.
  getDirectionalEdge(childSpec) {
    const s = this.getChild(childSpec);
    if (!s || s.n < MIN_N) return 0;
    return s.directionalEdge;
  }

  // A strategy is "mean-reversion dependent" when it wins often despite the
  // underlying moving against it more than for it. Worth surfacing because
  // that edge does not survive a regime change the way a directional one does.
  isMeanReversionDependent(childSpec) {
    const s = this.getChild(childSpec);
    if (!s || s.n < MIN_N) return false;
    return s.winRate > 55 && s.directionalEdge < -2;
  }

  getPromptContext(limit = 6) {
    const rows = Object.entries(this.byChild)
      .filter(([, b]) => b.n >= MIN_N)
      .map(([k]) => ({ k, s: this.getChild(k) }))
      .sort((a, b) => b.s.n - a.s.n)
      .slice(0, limit);
    if (!rows.length) return '';

    const lines = rows.map(({ k, s }) => {
      const flag = this.isMeanReversionDependent(k) ? ' ⚠️ gana por reversión, no por dirección' : '';
      return `${k}: WR ${s.winRate.toFixed(0)}% | dirEdge ${s.directionalEdge >= 0 ? '+' : ''}${s.directionalEdge.toFixed(1)} | WR|TP ${s.wrGivenTP != null ? s.wrGivenTP.toFixed(0) + '%' : '—'} (n=${s.n})${flag}`;
    });
    return `PATH QUALITY (dirEdge = %TP − %SL sobre el subyacente; positivo = lee dirección de verdad):\n${lines.join('\n')}`;
  }

  getStatus() {
    return {
      totalRows: this.totalRows,
      strategies: Object.keys(this.byChild).length,
      qualified: Object.keys(this.byChild).filter(k => this.byChild[k].n >= MIN_N).length,
    };
  }
}

export const pathStats = new PathStats();
