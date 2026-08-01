// src/ml/multiplier_audit.js
// Instrumentation, not a fix: the stake-sizing path chains ~15 independent
// risk/confidence multipliers together multiplicatively. None of them have
// ever been validated jointly — each was tuned in isolation, so nobody can
// currently say which ones carry real signal and which are just adding
// compounding noise to every bet size. This module logs every multiplier
// alongside the final combined value so that, once enough trades resolve,
// getCorrelationReport() can be run against feature_log.jsonl outcomes to
// see which multipliers actually move win rate and which don't.
// Zero behavior change — this only observes, never adjusts a stake.

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.env.HOME, '.adan-pred');
const LOG_PATH = path.join(DIR, 'multiplier_audit.jsonl');

class MultiplierAudit {
  record(multipliers, meta = {}) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const row = {
        ts: Date.now(),
        id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 6),
        ...meta,          // e.g. { childSpec, edge, asset }
        multipliers,       // e.g. { humanMult, sessionMult, ..., combined }
      };
      fs.appendFileSync(LOG_PATH, JSON.stringify(row) + '\n');
    } catch (e) {
      console.error('[MULTIPLIER-AUDIT] Log error:', e.message);
    }
  }

  // Quick sanity read — how many rows logged, no correlation math yet.
  // Correlation against outcomes needs feature_log.jsonl resolutions joined
  // by timestamp proximity; do that analysis once there's enough volume
  // (a few hundred rows) rather than guessing from a handful of trades.
  getStatus() {
    try {
      if (!fs.existsSync(LOG_PATH)) return { rows: 0 };
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
      return { rows: lines.length };
    } catch {
      return { rows: 0 };
    }
  }
}

export const multiplierAudit = new MultiplierAudit();
