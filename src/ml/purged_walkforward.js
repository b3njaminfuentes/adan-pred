// src/ml/purged_walkforward.js
// Concept #20C: Purged Walk-Forward Cross-Validation (López de Prado)
// Proper ML validation: chronological splits, purge boundary samples, embargo period.
// Detects overfitting that standard k-fold misses.

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.env.HOME, '.adan-pred');
const STATE_PATH = path.join(DIR, 'walkforward_cv.json');

class PurgedWalkForward {
  constructor() {
    this.nSplits = 5;
    this.purgeLength = 5;    // Samples purged at train/test boundary
    this.embargoLength = 3;  // Samples embargoed after test fold

    this.samples = [];  // [{features, label, ts}]
    this.lastValidation = null;
    this.validationHistory = [];  // last 10 validation runs

    this._load();
  }

  addSample(features, label, timestamp) {
    this.samples.push({
      features: Array.isArray(features) ? features : Object.values(features || {}),
      label: label ? 1 : 0,
      ts: timestamp || Date.now(),
    });
    if (this.samples.length > 2000) this.samples = this.samples.slice(-2000);

    // Auto-validate every 200 new samples
    if (this.samples.length >= 200 && this.samples.length % 200 === 0) {
      this._autoValidate();
    }
  }

  validate(trainFn, predictFn) {
    const n = this.samples.length;
    if (n < 100) return null;

    // Sort by timestamp
    const sorted = [...this.samples].sort((a, b) => a.ts - b.ts);
    const foldSize = Math.floor(n / this.nSplits);
    if (foldSize < 20) return null;

    const foldResults = [];
    let totalTrainAcc = 0;
    let totalTestAcc = 0;

    for (let i = 1; i < this.nSplits; i++) {
      const testStart = i * foldSize;
      const testEnd = Math.min(testStart + foldSize, n);

      // Purge: drop samples right before the test fold — their labels can
      // still be resolving over a window that bleeds into the test period.
      const trainEnd = Math.max(0, testStart - this.purgeLength);

      // Embargo: this.embargoLength was declared but never applied — training
      // data from LATER folds could still include samples right after this
      // fold's test period, whose labels formed while info from the test
      // period was already public. Skip forward past the embargo before
      // resuming training data for anything beyond this fold's test window.
      const embargoEnd = Math.min(n, testEnd + this.embargoLength);
      const trainData = sorted.slice(0, trainEnd).concat(sorted.slice(embargoEnd));
      const testData = sorted.slice(testStart, testEnd);

      if (trainData.length < 30 || testData.length < 10) continue;

      const trainX = trainData.map(s => s.features);
      const trainY = trainData.map(s => s.label);
      const testX = testData.map(s => s.features);
      const testY = testData.map(s => s.label);

      try {
        const model = trainFn(trainX, trainY);

        // Train accuracy
        const trainPreds = predictFn(model, trainX);
        const trainCorrect = trainPreds.filter((p, j) => (p >= 0.5 ? 1 : 0) === trainY[j]).length;
        const trainAcc = trainCorrect / trainX.length;

        // Test accuracy
        const testPreds = predictFn(model, testX);
        const testCorrect = testPreds.filter((p, j) => (p >= 0.5 ? 1 : 0) === testY[j]).length;
        const testAcc = testCorrect / testX.length;

        // Base rate for this fold
        const baseRate = Math.max(
          testY.filter(y => y === 1).length / testY.length,
          testY.filter(y => y === 0).length / testY.length
        );

        foldResults.push({
          fold: i,
          trainSize: trainX.length,
          testSize: testX.length,
          trainAcc,
          testAcc,
          baseRate,
          overfit: trainAcc - testAcc,
        });

        totalTrainAcc += trainAcc;
        totalTestAcc += testAcc;
      } catch (e) {
        console.log(`[PURGED-WF] Fold ${i} error:`, e.message);
      }
    }

    if (foldResults.length === 0) return null;

    const avgTrainAcc = totalTrainAcc / foldResults.length;
    const avgTestAcc = totalTestAcc / foldResults.length;
    const avgBaseRate = foldResults.reduce((s, f) => s + f.baseRate, 0) / foldResults.length;
    const overfitScore = avgTrainAcc > 0 ? avgTrainAcc / avgTestAcc : 1;

    const result = {
      foldResults,
      avgTrainAcc,
      avgTestAcc,
      avgBaseRate,
      overfitScore,
      isOverfit: overfitScore > 1.3 || (avgTrainAcc - avgTestAcc) > 0.15,
      isReliable: avgTestAcc > avgBaseRate + 0.03 && !foldResults.some(f => f.testAcc < f.baseRate - 0.05),
      ts: Date.now(),
    };

    this.lastValidation = result;
    this.validationHistory.push(result);
    if (this.validationHistory.length > 10) this.validationHistory = this.validationHistory.slice(-10);

    console.log(`[PURGED-WF] Validation: Train ${(avgTrainAcc * 100).toFixed(1)}% | Test ${(avgTestAcc * 100).toFixed(1)}% | Base ${(avgBaseRate * 100).toFixed(1)}% | Overfit: ${overfitScore.toFixed(2)}x`);

    this._save();
    return result;
  }

  // Auto-validate using simple logistic regression
  _autoValidate() {
    if (this.samples.length < 200) return;

    const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));

    const trainFn = (X, Y) => {
      const nFeatures = X[0]?.length || 1;
      const w = new Array(nFeatures).fill(0);
      let b = 0;
      const lr = 0.01;

      for (let epoch = 0; epoch < 50; epoch++) {
        for (let i = 0; i < X.length; i++) {
          let z = b;
          for (let j = 0; j < nFeatures; j++) z += (w[j] || 0) * (X[i][j] || 0);
          const pred = sigmoid(z);
          const err = pred - Y[i];
          for (let j = 0; j < nFeatures; j++) w[j] -= lr * err * (X[i][j] || 0);
          b -= lr * err;
        }
      }
      return { w, b };
    };

    const predictFn = (model, X) => {
      return X.map(x => {
        let z = model.b;
        for (let j = 0; j < model.w.length; j++) z += (model.w[j] || 0) * (x[j] || 0);
        return sigmoid(z);
      });
    };

    this.validate(trainFn, predictFn);
  }

  getLastValidation() {
    return this.lastValidation;
  }

  isModelReliable() {
    return this.lastValidation?.isReliable ?? true; // optimistic default
  }

  getOverfitScore() {
    return this.lastValidation?.overfitScore ?? 1.0;
  }

  getPromptContext() {
    if (!this.lastValidation) return '';
    const v = this.lastValidation;
    let ctx = `WALK-FORWARD CV: Test ${(v.avgTestAcc * 100).toFixed(1)}% vs Base ${(v.avgBaseRate * 100).toFixed(1)}%`;
    ctx += ` | Overfit: ${v.overfitScore.toFixed(2)}x`;
    if (v.isOverfit) ctx += ' ⚠️ OVERFIT DETECTED — model may not generalize';
    if (!v.isReliable) ctx += ' ⚠️ MODEL UNRELIABLE — test acc near base rate';
    if (v.isReliable && !v.isOverfit) ctx += ' ✓ Model validated, predictions trustworthy';
    return ctx;
  }

  getStatus() {
    return {
      samples: this.samples.length,
      lastValidation: this.lastValidation ? {
        trainAcc: (this.lastValidation.avgTrainAcc * 100).toFixed(1) + '%',
        testAcc: (this.lastValidation.avgTestAcc * 100).toFixed(1) + '%',
        overfit: this.lastValidation.overfitScore.toFixed(2) + 'x',
        reliable: this.lastValidation.isReliable,
      } : null,
      validationRuns: this.validationHistory.length,
    };
  }

  _save() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const data = {
        samples: this.samples.slice(-2000),
        lastValidation: this.lastValidation,
        validationHistory: this.validationHistory.slice(-10),
      };
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
      console.error('[PURGED-WF] Save error:', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const d = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        this.samples = d.samples || [];
        this.lastValidation = d.lastValidation || null;
        this.validationHistory = d.validationHistory || [];
        if (this.samples.length > 0) console.log(`[PURGED-WF] Loaded: ${this.samples.length} samples, ${this.validationHistory.length} validations`);
      }
    } catch (e) {
      console.error('[PURGED-WF] Load error:', e.message);
    }
  }
}

export const purgedWF = new PurgedWalkForward();
