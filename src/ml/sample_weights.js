// src/ml/sample_weights.js
// Concept #20G: Sequential-Bootstrap-style Sample Weighting (López de Prado, ch. 4)
//
// Problem this solves: two predictions on the same track (e.g. two btc-5min
// trades opened 2 minutes apart) can have outcome windows that overlap in
// time. Every model in this codebase that trains on a list of past samples
// (meta_labeler.js, purged_walkforward.js) currently treats each one as an
// independent observation. They are not — overlapping trades share the same
// underlying market move, so counting both at full weight double-counts one
// piece of information and understates how much real, independent evidence
// the model has actually seen. That inflates confidence and understates
// overfitting risk.
//
// This module implements the simplified "average uniqueness" weighting
// López de Prado describes as a practical stand-in for full sequential
// bootstrap: a sample that overlaps with N other samples for a fraction f of
// its lifespan gets down-weighted roughly in proportion to how crowded that
// window was.
//
// Not wired into any training loop yet on purpose — meta_labeler.js and
// purged_walkforward.js only track a single timestamp per sample today, not
// an [entry, resolved] window, so there is nothing to compute overlap from
// yet. Wiring this in requires first having each caller record resolvedTs
// alongside ts. Exposed here, ready to use once that plumbing exists —
// deliberately not rushed into a live bot without that groundwork.

// samples: [{ ts, resolvedTs }] — resolvedTs defaults to ts (no overlap) if
// a caller doesn't yet track resolution windows.
export function computeUniquenessWeights(samples) {
  const n = samples.length;
  if (n === 0) return [];

  const windows = samples.map(s => ({
    start: s.ts,
    end: s.resolvedTs != null && s.resolvedTs >= s.ts ? s.resolvedTs : s.ts,
  }));

  // Concurrency at every window boundary: how many samples' windows cover
  // each point in time. Using boundary points keeps this O(n log n) instead
  // of O(n^2) for large sample sets.
  const events = [];
  for (const w of windows) {
    events.push({ t: w.start, delta: 1 });
    events.push({ t: w.end, delta: -1 });
  }
  events.sort((a, b) => a.t - b.t);

  const boundaries = [];
  let running = 0;
  for (const e of events) {
    running += e.delta;
    boundaries.push({ t: e.t, concurrency: Math.max(1, running) });
  }

  const concurrencyAt = (t) => {
    // Last boundary at or before t (boundaries is sorted).
    let lo = 0, hi = boundaries.length - 1, ans = boundaries[0].concurrency;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid].t <= t) { ans = boundaries[mid].concurrency; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };

  return windows.map(w => {
    if (w.end === w.start) {
      // No duration info — fall back to full weight rather than pretend we
      // know something about overlap we don't.
      return 1.0;
    }
    // Average of 1/concurrency sampled at the 25/50/75% marks — cheap
    // approximation of the integral used in the full sequential-bootstrap
    // derivation. Deliberately interior points, not the exact start/end: at
    // the exact boundary a same-instant neighbor may have just opened or
    // closed, which skews the estimate without reflecting real overlap
    // during the window.
    const span = w.end - w.start;
    const points = [w.start + span * 0.25, w.start + span * 0.5, w.start + span * 0.75];
    const samples3 = points.map(t => 1 / concurrencyAt(t));
    return samples3.reduce((a, b) => a + b, 0) / samples3.length;
  });
}

// Convenience: weighted mean, for computing e.g. a weighted win rate instead
// of a naive count-based one.
export function weightedMean(values, weights) {
  let num = 0, den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den > 0 ? num / den : 0;
}
