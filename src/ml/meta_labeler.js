// src/ml/meta_labeler.js
// Concept #20E: Meta-Labeling (López de Prado)
// A second model that predicts whether the PRIMARY model's bet will be correct.
// It doesn't predict the market — it predicts ADAN's accuracy on each trade.
// If meta_prob < 0.45 → VETO the bet. If < 0.55 → reduce stake 40%.

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.env.HOME, '.adan-pred');
const META_PATH = path.join(DIR, 'meta_labeler.json');

// Meta-features: characteristics of the PREDICTION, not the market
const META_FEATURES = [
  'primary_confidence',    // 0-1, how confident the primary model is
  'ensemble_agreement',    // spread between voter probabilities (lower = more agreement)
  'primary_probability',   // 0-1, what prob the primary model gave
  'edge_magnitude',        // absolute edge value
  'volatility',            // current market volatility
  'volume_ratio',          // current volume vs average
  'hour_bin_score',        // bin count log-odds for current hour
  'streak',                // normalized current streak (-1 to +1)
  'time_to_close',         // log of minutes remaining
  'dynasty_consensus',     // 0-1, what % of children agreed
  'taker_ratio',           // from futures intel
  'oi_delta',              // from futures intel
  // %TP − %SL over this strategy's own past resolved trades, measured on the
  // underlying price path (see path_stats.js). Positive means the asset
  // actually moved its way more often than against it; negative means its
  // wins lean on prices reverting before expiry. Computed strictly from
  // already-resolved history, so it is known at entry — no look-ahead.
  'directional_edge',
];
const N_META = META_FEATURES.length;

function sigmoid(z) {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

class MetaLabeler {
  constructor() {
    this.weights = new Float64Array(N_META).fill(0);
    this.bias = 0;
    this.mean = new Float64Array(N_META).fill(0);
    this.std = new Float64Array(N_META).fill(1);

    this.lambda = 0.01;      // L2 regularization
    this.lr = 0.05;          // Learning rate for batch training
    this.epochs = 200;

    // Training data buffer
    this.samples = [];       // [{features: [...], label: 0|1}]

    // Stats
    this.totalPredictions = 0;
    this.correctPredictions = 0;
    this.vetoes = 0;
    this.vetoCorrect = 0;    // vetoes where ADAN would have lost
    this.allows = 0;
    this.allowCorrect = 0;   // allows where ADAN won

    this.trained = false;
    this.trainedAt = null;
    this.lastTrainSamples = 0;

    this._load();
  }

  // ── Extract feature vector from meta-features object ──
  _extractVec(mf) {
    return META_FEATURES.map(f => {
      const v = mf[f];
      return (v != null && !isNaN(v)) ? v : 0;
    });
  }

  // ── Normalize a vector using stored mean/std ──
  _normalize(vec) {
    return vec.map((v, i) => this.std[i] > 1e-8 ? (v - this.mean[i]) / this.std[i] : 0);
  }

  // ── Compute normalization stats from samples ──
  _computeNormStats() {
    if (this.samples.length < 10) return;
    const n = this.samples.length;
    const sums = new Float64Array(N_META).fill(0);
    const sqSums = new Float64Array(N_META).fill(0);

    for (const s of this.samples) {
      for (let i = 0; i < N_META; i++) {
        sums[i] += s.features[i];
        sqSums[i] += s.features[i] * s.features[i];
      }
    }
    for (let i = 0; i < N_META; i++) {
      this.mean[i] = sums[i] / n;
      const variance = sqSums[i] / n - this.mean[i] * this.mean[i];
      this.std[i] = Math.sqrt(Math.max(variance, 1e-8));
    }
  }

  // ── Predict P(primary model is correct) ──
  predict(metaFeatures) {
    if (!this.trained) return { probability: 0.5, ready: false, action: 'ALLOW' };

    const raw = this._extractVec(metaFeatures);
    const norm = this._normalize(raw);

    let z = this.bias;
    for (let i = 0; i < N_META; i++) z += this.weights[i] * norm[i];
    const prob = sigmoid(z);

    this.totalPredictions++;
    let action = 'ALLOW';
    if (prob < 0.45) action = 'VETO';
    else if (prob < 0.55) action = 'REDUCE';

    return { probability: prob, ready: true, action };
  }

  // ── Add a training sample (called after trade resolves) ──
  update(metaFeatures, primaryWasCorrect) {
    const features = this._extractVec(metaFeatures);
    const label = primaryWasCorrect ? 1 : 0;
    this.samples.push({ features, label });

    // Keep last 2000 samples max
    if (this.samples.length > 2000) {
      this.samples = this.samples.slice(-2000);
    }

    // Track veto/allow accuracy
    if (this.trained) {
      const pred = this.predict(metaFeatures);
      if (pred.action === 'VETO') {
        this.vetoes++;
        if (!primaryWasCorrect) this.vetoCorrect++; // correctly vetoed a loser
      } else {
        this.allows++;
        if (primaryWasCorrect) this.allowCorrect++; // correctly allowed a winner
      }
    }

    // Retrain every 100 new samples
    if (this.samples.length >= 200 && (this.samples.length - this.lastTrainSamples) >= 100) {
      this.train();
    }

    this._save();
  }

  // ── Batch training with L2 regularization ──
  train() {
    if (this.samples.length < 200) return false;

    this._computeNormStats();

    // Prepare normalized training data
    const X = this.samples.map(s => this._normalize(s.features));
    const Y = this.samples.map(s => s.label);
    const n = X.length;

    // Initialize weights
    this.weights = new Float64Array(N_META).fill(0);
    this.bias = 0;

    let lr = this.lr;

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      let totalLoss = 0;
      const gradW = new Float64Array(N_META).fill(0);
      let gradB = 0;

      for (let i = 0; i < n; i++) {
        let z = this.bias;
        for (let j = 0; j < N_META; j++) z += this.weights[j] * X[i][j];
        const pred = sigmoid(z);
        const err = pred - Y[i];

        for (let j = 0; j < N_META; j++) {
          gradW[j] += err * X[i][j] + this.lambda * this.weights[j];
        }
        gradB += err;

        totalLoss += -Y[i] * Math.log(pred + 1e-10) - (1 - Y[i]) * Math.log(1 - pred + 1e-10);
      }

      // Update
      for (let j = 0; j < N_META; j++) {
        this.weights[j] -= lr * gradW[j] / n;
      }
      this.bias -= lr * gradB / n;

      // LR decay
      lr *= (1 - 0.005);
    }

    // Compute train accuracy
    let correct = 0;
    for (let i = 0; i < n; i++) {
      let z = this.bias;
      for (let j = 0; j < N_META; j++) z += this.weights[j] * X[i][j];
      const pred = sigmoid(z);
      if ((pred >= 0.5 && Y[i] === 1) || (pred < 0.5 && Y[i] === 0)) correct++;
    }

    this.trained = true;
    this.trainedAt = new Date().toISOString();
    this.lastTrainSamples = this.samples.length;
    this.correctPredictions = correct;

    const wins = Y.filter(y => y === 1).length;
    console.log(`[META-LABELER] Trained on ${n} samples. Train acc: ${(correct/n*100).toFixed(1)}%. Base rate: ${(wins/n*100).toFixed(1)}% wins.`);

    this._save();
    return true;
  }

  // ── Is the model ready for predictions? ──
  isReady() {
    return this.trained && this.samples.length >= 200;
  }

  // ── Status report ──
  getStatus() {
    const n = this.samples.length;
    const wins = this.samples.filter(s => s.label === 1).length;
    const vetoPrecision = this.vetoes > 0 ? (this.vetoCorrect / this.vetoes * 100).toFixed(1) : '?';
    const allowPrecision = this.allows > 0 ? (this.allowCorrect / this.allows * 100).toFixed(1) : '?';

    return {
      ready: this.isReady(),
      trained: this.trained,
      samples: n,
      baseRate: n > 0 ? (wins / n * 100).toFixed(1) + '%' : '?',
      trainAcc: n > 0 && this.correctPredictions > 0 ? (this.correctPredictions / n * 100).toFixed(1) + '%' : '?',
      vetoes: this.vetoes,
      vetoPrecision: vetoPrecision + '%',
      allows: this.allows,
      allowPrecision: allowPrecision + '%',
      trainedAt: this.trainedAt,
    };
  }

  // ── Persistence ──
  _save() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const data = {
        weights: Array.from(this.weights),
        bias: this.bias,
        mean: Array.from(this.mean),
        std: Array.from(this.std),
        samples: this.samples.slice(-2000),
        trained: this.trained,
        trainedAt: this.trainedAt,
        lastTrainSamples: this.lastTrainSamples,
        totalPredictions: this.totalPredictions,
        correctPredictions: this.correctPredictions,
        vetoes: this.vetoes,
        vetoCorrect: this.vetoCorrect,
        allows: this.allows,
        allowCorrect: this.allowCorrect,
      };
      const tmp = META_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, META_PATH);
    } catch (e) {
      console.error('[META-LABELER] Save error:', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(META_PATH)) {
        const data = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

        // Feature-count migration. When META_FEATURES grows, a saved weight
        // vector is one element short: predict() would read past its end,
        // get undefined, and quietly return NaN for every probability —
        // silently disabling the veto/reduce logic with no error anywhere.
        // Old weights are discarded (they were fitted on a different feature
        // space and cannot be extended meaningfully), but the SAMPLES are
        // kept and padded with 0 for the new feature. 0 is the neutral value
        // for directional_edge, which is honest: those trades genuinely had
        // no such measurement at the time. Retraining then refits on the
        // full history rather than throwing away thousands of observations.
        const savedLen = Array.isArray(data.weights) ? data.weights.length : 0;
        const dimensionChanged = savedLen > 0 && savedLen !== N_META;

        if (dimensionChanged) {
          console.log(`[META-LABELER] Feature set changed (${savedLen} → ${N_META}). Discarding old weights, padding ${(data.samples || []).length} samples, will retrain.`);
          this.weights = new Float64Array(N_META).fill(0);
          this.bias = 0;
          this.trained = false;
          this.lastTrainSamples = 0;
        } else {
          if (data.weights) this.weights = new Float64Array(data.weights);
          if (data.mean) this.mean = new Float64Array(data.mean);
          if (data.std) this.std = new Float64Array(data.std);
          this.bias = data.bias || 0;
        }

        this.samples = (data.samples || []).map(s => {
          const f = Array.isArray(s.features) ? s.features.slice(0, N_META) : [];
          while (f.length < N_META) f.push(0);
          return { ...s, features: f };
        });
        // Only restore the trained flag when the feature space is unchanged.
        // After a dimension change the weights above were deliberately reset,
        // so claiming trained=true would leave an all-zero model advertising
        // itself as ready — every predict() would return exactly 0.5 and the
        // veto logic would look functional while doing nothing.
        this.trained = dimensionChanged ? false : (data.trained || false);
        this.trainedAt = dimensionChanged ? null : (data.trainedAt || null);
        this.lastTrainSamples = dimensionChanged ? 0 : (data.lastTrainSamples || 0);
        this.totalPredictions = data.totalPredictions || 0;
        this.correctPredictions = data.correctPredictions || 0;
        this.vetoes = data.vetoes || 0;
        this.vetoCorrect = data.vetoCorrect || 0;
        this.allows = data.allows || 0;
        this.allowCorrect = data.allowCorrect || 0;
        if (this.trained) {
          console.log(`[META-LABELER] Loaded: ${this.samples.length} samples, trained=${this.trained}`);
        }
      }
    } catch (e) {
      console.error('[META-LABELER] Load error:', e.message);
    }
  }
}

export const metaLabeler = new MetaLabeler();
