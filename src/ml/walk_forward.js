// src/ml/walk_forward.js
// Walk-Forward Validation — proper out-of-sample backtesting
// Replaces naive grid search to prevent overfitting
// Train on [0, N], test on [N+1, N+50], slide forward

import fs from 'fs';
import path from 'path';
import { LogisticRegression } from './logistic_regression.js';
import { calibrator } from './calibrator.js';
import { DIR, loadPositions } from '../core/config.js';

const WF_LOG_PATH = path.join(DIR, 'walk_forward_log.json');
const FOLD_SIZE = 50;       // Test window size
const MIN_TRAIN = 200;      // Minimum training samples before testing

export class WalkForward {

  // Run full walk-forward validation on historical trades
  run() {
    const pos = loadPositions();
    const trades = (pos.closed || []).filter(t => t.entryVec && Object.keys(t.entryVec).length >= 5);

    if (trades.length < MIN_TRAIN + FOLD_SIZE) {
      console.log(`[WALK-FWD] Need ${MIN_TRAIN + FOLD_SIZE}+ trades with features, got ${trades.length}`);
      return null;
    }

    const folds = [];
    let totalOOS = 0, totalOOSCorrect = 0;
    let totalLogLoss = 0;
    const allOOSPredictions = []; // v7: collect for calibrator

    // Slide the window
    for (let trainEnd = MIN_TRAIN; trainEnd + FOLD_SIZE <= trades.length; trainEnd += FOLD_SIZE) {
      const trainSet = trades.slice(0, trainEnd);
      const testSet = trades.slice(trainEnd, trainEnd + FOLD_SIZE);

      // Train a fresh model on this window
      const model = new LogisticRegression({ lambda: 0.01, lr: 0.1, epochs: 200 });
      // We need to train without triggering save/load
      const trained = model.train(trainSet);
      if (!trained) continue;

      // Test on out-of-sample fold
      let correct = 0, foldLogLoss = 0;
      const predictions = [];

      for (const t of testSet) {
        const pred = model.predict(t);
        const actual = t.won === true || t.result === 'WIN' ? 1 : 0;
        const predicted = pred.probability >= 0.5 ? 1 : 0;
        if (predicted === actual) correct++;

        // Log-loss
        const p = Math.max(1e-7, Math.min(1 - 1e-7, pred.probability));
        foldLogLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));

        predictions.push({ prob: pred.probability, actual, correct: predicted === actual });
        allOOSPredictions.push({ probability: pred.probability, actual });
      }

      const foldWR = correct / testSet.length;
      const avgLogLoss = foldLogLoss / testSet.length;

      folds.push({
        trainSize: trainEnd,
        testSize: testSet.length,
        wr: parseFloat((foldWR * 100).toFixed(1)),
        logLoss: parseFloat(avgLogLoss.toFixed(4)),
        trainWR: parseFloat((model.trainWR * 100).toFixed(1)),
        calibration: this._calibration(predictions),
      });

      totalOOS += testSet.length;
      totalOOSCorrect += correct;
      totalLogLoss += foldLogLoss;
    }

    if (folds.length === 0) {
      console.log('[WALK-FWD] No valid folds generated');
      return null;
    }

    const overallOOSWR = totalOOSCorrect / totalOOS;
    const overallLogLoss = totalLogLoss / totalOOS;
    // Base rate = accuracy of just always predicting the majority class. A fixed
    // 0.53 threshold looks "reliable" even when the model is worse than that
    // naive baseline (same margin purged_walkforward.js uses for isReliable).
    const positives = allOOSPredictions.filter(p => p.actual === 1).length;
    const overallBaseRate = Math.max(positives, totalOOS - positives) / totalOOS;

    // Train final model on ALL data
    const finalModel = new LogisticRegression({ lambda: 0.01, lr: 0.1, epochs: 300 });
    finalModel.train(trades);
    finalModel.oosWR = overallOOSWR;
    finalModel._save(); // Save the final trained model

    // v7: Build Platt calibration from all OOS predictions
    try {
      calibrator.build(allOOSPredictions);
    } catch (e) {
      console.log('[WALK-FWD] Calibrator build error:', e.message);
    }

    const result = {
      ts: new Date().toISOString(),
      totalTrades: trades.length,
      folds: folds.length,
      foldSize: FOLD_SIZE,
      overallOOSWR: parseFloat((overallOOSWR * 100).toFixed(1)),
      overallLogLoss: parseFloat(overallLogLoss.toFixed(4)),
      overallBaseRate: parseFloat((overallBaseRate * 100).toFixed(1)),
      bestFold: folds.reduce((a, b) => a.wr > b.wr ? a : b),
      worstFold: folds.reduce((a, b) => a.wr < b.wr ? a : b),
      featureImportance: finalModel.getFeatureImportance().slice(0, 10).map(f => ({
        name: f.name,
        weight: parseFloat(f.weight.toFixed(4)),
      })),
      foldDetails: folds,
      // Reliable only if it beats the naive "always predict majority class"
      // baseline by a real margin — not just an absolute 53% floor.
      modelReady: overallOOSWR > overallBaseRate + 0.03,
    };

    // Save log
    try {
      fs.writeFileSync(WF_LOG_PATH, JSON.stringify(result, null, 2));
    } catch {}

    console.log(`[WALK-FWD] ${folds.length} folds | OOS WR: ${result.overallOOSWR}% | Log-loss: ${result.overallLogLoss} | Model ready: ${result.modelReady}`);
    for (const fold of folds) {
      console.log(`  Fold train=${fold.trainSize} → OOS WR: ${fold.wr}% (train: ${fold.trainWR}%)`);
    }

    return result;
  }

  // Calibration: group predictions into bins and check actual WR
  _calibration(predictions) {
    const bins = { low: { n: 0, correct: 0 }, mid: { n: 0, correct: 0 }, high: { n: 0, correct: 0 } };
    for (const p of predictions) {
      if (p.prob < 0.4) { bins.low.n++; if (!p.actual) bins.low.correct++; }
      else if (p.prob > 0.6) { bins.high.n++; if (p.actual) bins.high.correct++; }
      else { bins.mid.n++; bins.mid.correct++; }
    }
    return {
      low: bins.low.n > 0 ? parseFloat((bins.low.correct / bins.low.n * 100).toFixed(0)) : null,
      mid: bins.mid.n > 0 ? parseFloat((bins.mid.correct / bins.mid.n * 100).toFixed(0)) : null,
      high: bins.high.n > 0 ? parseFloat((bins.high.correct / bins.high.n * 100).toFixed(0)) : null,
    };
  }

  // Get latest results
  getLatestResults() {
    try {
      if (fs.existsSync(WF_LOG_PATH)) {
        return JSON.parse(fs.readFileSync(WF_LOG_PATH, 'utf8'));
      }
    } catch {}
    return null;
  }
}

export const walkForward = new WalkForward();
