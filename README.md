# ADAN-PRED v9.0: Mother Code v2.0 + Learning Loop v2
## Evidence-Driven Evolution × Quant ML × Oracle Front-Run × Human Psychology Layer
---

## Executive Summary

ADAN-PRED is a fully autonomous, self-evolving prediction markets Quantitative Research agent focused on **Polymarket crypto markets (BTC/ETH/SOL, 5–15min windows)**.

In **v9.0**, the architecture gained a complete **Mother Code v2.0** layer — 14 new intelligence modules that close the gap between raw feature extraction and institutional-grade trade logic. The centerpiece is **Learning Loop v2**: an append-only `trades.jsonl` ledger that turns every trade into calibration evidence, drives directed DNA mutations, and computes Wilson-lower-bound survival scores to separate skill from luck.

**Current Focus:** Polymarket crypto binary markets (up/down). Paper trading mode building the evidence base for live deployment.

---

## Full Changelog

| Version | Added |
|---------|-------|
| v8.0 | 14 scientific concepts, MoE Dynasty, 4-voter ensemble |
| v8.1 | Futures Intelligence (OI Delta, Taker, L/S, Liquidation) |
| v8.2 | Meta-Labeling (#20E), ADAN-SHADOW (#15) |
| v8.3 | Triple Barrier (#20A), CUSUM (#20D), VPIN (#20F), Purged WF (#20C), Resolution Oracle (#22) |
| v8.4 | Scenario Forecaster (#23), Distributed LLM Router v9.0 |
| v8.5 | Python Quant ML Stack, SQLite Sync, Jupyter Validation, Perps Purged, LLM Watchdog |
| v8.6 | Venue toggles, Polymarket crypto-only refactor, doScan wiring, dashboard stability |
| **v9.0** | **Mother Code v2.0**: Learning Loop v2, Polymerase, LMSR Engine, Particle Filter, Oracle Front-Runner, Smart Money, Human Event Layer, Market Sessions, Metabolism, Risk of Ruin, Order Book Intelligence, Quota Manager, Soul Manager. Heartbeat resilience. Batched resolutions. Log rotation. |

---

## v9.0: Mother Code v2.0

### What Changed (v8.5 → v9.0)

| Layer | v8.5 | v9.0 |
|-------|------|------|
| **Learning** | Walk-forward CV + online SGD | + Learning Loop v2 (append-only ledger, Wilson survival, directed mutations) |
| **Edge Calculation** | LogReg + ensemble | + LMSR Bayesian fair value + Particle Filter (200 particles) |
| **Market Intelligence** | Binance futures | + Oracle Front-Runner (CEX→Polymarket lag) + Smart Money (whale flow) |
| **Psychology Layer** | None | + Human Event Layer (6 states) + Market Sessions (8 global windows) |
| **Risk Infrastructure** | Kelly × 15 multipliers | + Risk of Ruin calculator + Metabolism (fund-based scaling) + Apoptosis (controlled exit) |
| **Pre-trade Safety** | Meta-labeling gate | + Polymerase (7-gate simulator + shadow bets) + Order Book spread filter |
| **LLM Management** | Basic quota tracking | + Quota Manager (6-tier budgets per category) + Soul Manager (deduplication) |
| **Reliability** | Watchdog restart | + Heartbeat decoupled from cycle + log rotation + batched resolutions |

### The Evidence Backbone: Learning Loop v2

The `trades.jsonl` ledger is the single source of truth. Every open and every resolution is written atomically. From it:

- **Calibration curves** per child, per regime, per hour — declared vs realized edge
- **Wilson lower bound** survival scores — statistical proof of skill vs luck before promoting a child
- **Directed DNA mutations** — losses are not random noise, they become specific numeric corrections
- **Edge inflation detection** — catches when children consistently overestimate their edge
- **Shadow bet tracking** — bets blocked by Polymerase are recorded and resolved in simulation

---

## Architecture Overview (v9.0)

```
                    ┌──────────────────────────────────────────┐
                    │   Node.js Nervous System                 │
                    │   24/7 Data Collector + Feature Eng.    │
                    └────────────┬─────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────────────┐
              │                  │                           │
    ┌─────────▼──────┐  ┌────────▼────────┐  ┌─────────────▼──────┐
    │  Oracle Front  │  │  Binance        │  │  Polymarket CLOB   │
    │  Runner        │  │  Candles/Futures│  │  WebSocket (L2)    │
    └─────────┬──────┘  └────────┬────────┘  └─────────────┬──────┘
              └──────────────────┼──────────────────────────┘
                                 │ Raw Signals
                    ┌────────────▼──────────────────────────┐
                    │   MOTHER CODE v2.0 (Intelligence)     │
                    │   Particle Filter → LMSR Engine       │
                    │   Human Event Layer → Market Sessions │
                    │   Smart Money → Order Book            │
                    │   Polymerase (7-gate pre-trade check) │
                    └────────────┬──────────────────────────┘
                                 │ edge / stake / direction
                    ┌────────────▼──────────────────────────┐
                    │   4-Voter Ensemble + Kelly × 15       │
                    │   (Stat × LLM × Hist × Online)       │
                    └────────────┬──────────────────────────┘
                                 │
                    ┌────────────▼──────────────────────────┐
                    │   trades.jsonl (append-only ledger)   │
                    │   Learning Loop v2 → directed DNA     │
                    └────────────┬──────────────────────────┘
                                 │
                    ┌────────────▼──────────────────────────┐
                    │   SQLite (adan_data.db)               │
                    └────────────┬──────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
 ┌──────▼──────┐          ┌──────▼──────┐         ┌──────▼──────┐
 │  XGBoost    │          │ Logistic Reg│         │ EDA (Pandas)│
 │  Feature Imp│          │ Brier Score │         │ Equity Curve│
 └─────────────┘          └─────────────┘         └─────────────┘
                           JUPYTER NOTEBOOK AREA
```

---

## Mother Code v2.0 — Module Reference

### Learning Loop v2 (`src/core/learning_loop.js`)

Append-only `trades.jsonl` ledger replaces scattered JSON state files. Every decision leaves a paper trail.

- `ledger.open(trade)` — records bet at placement with full feature snapshot
- `ledger.resolve(id, won)` — closes the record with actual outcome
- `wilsonLower(wins, n)` — 95% CI lower bound for skill measurement
- `nightlyReport()` — calibration audit: declared vs realized edge per segment
- `applyDirectedMutations(child)` — losses → specific DNA corrections (not random noise)

### Polymerase (`src/core/polymerase.js`)

Pre-execution safety simulator with 7 gates that must pass before any bet is placed:

| Gate | Check | Block Condition |
|------|-------|----------------|
| PRICE_VALID | 0.01 ≤ price ≤ 0.99 | Invalid boundary |
| EXIT_PATH | Liquidity exists to exit | < $50 on other side |
| RECOVERY | Recovery potential if wrong | < 15% recovery path |
| VAR_WILMOTT | Portfolio VaR (Ch.19) | Exceeds 20% fund |
| LIQUIDITY | Minimum depth | < $100 total depth |
| DEAD_ZONE | Spread + slippage trap | Net EV < 0 after costs |
| CLOSE_WINDOW | TTC gate | < 60s remaining |

All blocked bets are recorded as **shadow bets** in `shadow_bets.jsonl` — they resolve naturally and feed the learning loop with counterfactual evidence.

### LMSR Engine (`src/core/lmsr_engine.js`)

Understands Polymarket's Logarithmic Market Scoring Rule mechanism:

- Estimates liquidity parameter `b` from observed volume
- Inverts market price to implied momentum: `b × log(p/(1-p))`
- Applies RSI, Fear&Greed, and volume signals as Bayesian updates
- Outputs `posteriorFairValue` — the true edge vs market price

### Particle Filter (`src/core/particle_filter.js`)

Bootstrap particle filter (N=200) that estimates true market probability from noisy price signal:

- Propagates particles via Gaussian process noise (σ tuned per regime)
- Reweights by likelihood against market price observation
- Boosts with directional technical signals
- Systematic resampling prevents particle degeneracy
- Returns `mean` + `variance` — high variance = avoid market

### Oracle Front-Runner (`src/core/oracle_front_run.js`)

Detects Binance (CEX) price moves **30–90 seconds before Polymarket reprices**:

- Rolling 1-min candles: >0.3% move in 2min, >0.5% in 3min = signal
- Confidence weighted by momentum + volume confirmation
- Signal decays linearly after 90s (the CEX→Polymarket lag window)
- Edge type: pure market structure arbitrage, not prediction

### Smart Money Tracker (`src/core/smart_money.js`)

Polls Polymarket Gamma API for whale order flow:

- Detects `flowDirection` (BUY/SELL/UNKNOWN) from large order imbalances
- Volume spike vs 7-day average (>2× = elevated smart money)
- Liquidity skew: best_bid/best_ask imbalance as directional signal
- Output: `smartMoneyConfidence` (0–1) fed into Kelly sizing

### Order Book Intelligence (`src/core/order_book.js`)

Analyzes execution economics before placing:

- Spread > 5% → AVOID (cost destroys edge)
- Spread > 3% → REDUCE_SIZE (×0.6 Kelly)
- Depth < $500 → liquidity warning
- Calculates effective edge loss from crossing the spread

### Human Event Layer (`src/core/human_event_layer.js`)

Detects 6 market psychology states using Fear&Greed, volume ratio, and UTC hour:

| State | Edge Mult | Stake Mult | Trigger |
|-------|-----------|------------|---------|
| HERD_PANIC | ×1.4 | ×0.8 | Fear < 20, volume spike |
| HERD_FOMO | ×0.7 | ×0.6 | Greed > 80, FOMO volume |
| NEWS_SHOCK | ×0 | ×0 | Black swan flag active |
| SLEEPING_HERD | ×1.1 | ×0.7 | UTC 02–08, low volume |
| RATIONAL_MARKET | ×1.0 | ×1.0 | Default |
| DEAD_ZONE_TRAP | ×0.5 | ×0.3 | Spread trap detected |

All events logged to `human_events.jsonl`.

### Market Sessions (`src/core/market_sessions.js`)

8 global trading windows with Polymarket-calibrated multipliers:

| Session | UTC | Edge | Stake | Notes |
|---------|-----|------|-------|-------|
| Sydney | 22–00 | ×0.85 | ×0.8 | Thin liquidity |
| Tokyo | 00–03 | ×0.90 | ×0.85 | Yen crosses |
| Shanghai | 01–04 | ×0.95 | ×0.9 | PBOC CNY fix 01:15 |
| London | 07–10 | ×1.10 | ×1.0 | Institutional open |
| Buenos Aires | 12–16 | ×1.00 | ×1.0 | Baseline |
| **New York** | **13–17** | **×1.30** | **×1.1** | **PRIME — Polymarket +40% vol** |
| Los Angeles | 17–20 | ×0.95 | ×0.9 | Post-NY fade |
| Dead Zone | 20–22 | ×0.70 | ×0.6 | Avoid |

### Metabolism (`src/core/metabolism.js`)

Fund-based stake scaling — prevents over-betting relative to bankroll:

| Fund Level | Kelly Multiplier |
|-----------|-----------------|
| < $100 | ×0 (hibernate) |
| $100–$500 | ×0.3 |
| $500–$1000 | ×0.6 |
| > $1000 | exponential unleash |

Also handles hibernation (fund < $500 → children sleep), and human-state overrides (NEWS_SHOCK = ×0).

### Risk of Ruin (`src/core/risk_of_ruin.js`)

`RoR = ((1 − edge) / (1 + edge)) ^ (bankroll / unit_stake)`

| RoR | Action |
|-----|--------|
| > 20% | Stakes × 0.25 (emergency) |
| > 10% | Stakes × 0.50 |
| > 5% | Stakes × 0.75 |
| < 5% | Normal sizing |

### Apoptosis (`src/core/apoptosis.js`)

Controlled programmatic shutdown (activates at LVL 10+):

- Trigger: fund < 30% of initial deposit OR ≥ 10 consecutive losses
- Closes all open positions cleanly before exit
- Saves final state snapshot
- Resets quota counters
- Exits process — watchdog will NOT restart (intentional death)

### Quota Manager (`src/core/quota_manager.js`)

Tracks RPD (requests per day) across all 6 LLM tiers with per-category budgets:

| Category | Daily Budget |
|----------|-------------|
| Crypto children | 10,000 |
| Politics / Sports / Events | 1,500 each |
| Macro | 500 |

Resets at UTC midnight. `isSaverMode()` activates when < 20% quota remaining.

### Soul Manager (`src/core/soul_manager.js`)

Deduplicates SOUL.md rules (which can reach 470KB) down to the 6 most contextually relevant per prompt:

- Normalizes percentages + patterns to detect > 80% text similarity
- Prevents Gemma (15K TPM) prompt explosion
- Migrates old format to new JSON rules structure

---

## Scientific Concepts (24 Integrated)

### Concept #2: Evolution Strategies (ES)
**File:** `src/ml/evolution_strategies.js`

N=20 parameter vectors evolved with OpenAI-style ES. Fitness = Sharpe ratio over last 200 trades. `θ_new = θ_old + α × (1/Nσ) × Σ(εᵢ × fitnessᵢ)`. Gaussian noise σ=0.02, η=0.01. Runs per Dream cycle.

### Concept #3: VADER Sentiment Analysis
**Integrated in:** `adan-brain-complete.js` (APPLE module)

`vader-sentiment` on CryptoPanic headlines. Signal: `BLACK_SWAN` (< −0.7), `STRONG_BULLISH` (> 0.6), `BEARISH` (< −0.3), `BULLISH` (> 0.3), `NEUTRAL`. BLACK_SWAN overrides all technical analysis.

### Concept #7: Shapley Value Feature Importance
**File:** `src/ml/shapley_values.js`

M=100 random permutations per feature. Identifies TOP (Shapley > 0.01), HARMFUL (negative), IRRELEVANT (|Shapley| < 0.001). Runs per Dream cycle on last 500 trades.

### Concept #8A: L2 Tensor (Order Book Intelligence)
**Integrated in:** `adan-pred.js`

`wall_score` (resistance density), `imbalance_ratio` (ask/bid pressure), `depth_score` (liquidity concentration near mid). 3 features in the 32-feature vector.

### Concept #8C: UCB Market Explorer
**File:** `src/ml/ucb_explorer.js`

`ucb_score = avg_edge + 2.0 × √(log(N)/n_market)`. Blacklist: WR < 40% after 15 trades → 30-day ban. Exploration cap: 3% of fund.

### Concept #8D: Markovian State Tracker
**Integrated in:** `adan-pred.js`

5 state variables: `positions_open` (≥3 → block), `capital_deployed_pct` (>40% → Kelly on free only), `consecutive_losses` (≥3 → cap $75), `hours_since_last_win`, `current_drawdown_pct` (>20% → Dream + stop).

### Concept #10: Mixture of Experts Dynasty (MoE)
**File:** `src/core/moe_dynasty.js`

12 crypto children each with learned gate weight (softmax). Gating: 50% WR + 30% inv-Brier + 20% edge accuracy. Weight update η=0.05. Auto-specialization after 50 trades.

### Concept #12A: Log Transform
**Integrated in:** `adan-brain-complete.js` + `src/api/binance.js`

`Math.log1p()` on raw volumes only. Prevents outliers from dominating feature vectors.

### Concept #12C: Bin Counting Hour Filter
**Integrated in:** `adan-pred.js`

`score = log(pWin/(1−pWin))` with Laplace smoothing. Score > 0.3 → ×1.1 Kelly. Score < −1.0 → hard SKIP.

### Concept #12D: K-Means Regime Detector
**File:** `src/core/regime_detector.js`

Pure Node.js K-Means (k=3) on 5 features: volatility, volume_ratio, trend_strength, bb_width, efficiency_ratio. `EVENT` regime → ALL bets VETOED.

### Concept #14: PIN Score
**File:** `src/core/pin_score.js`

Probability of Informed Trading from bid/ask imbalance. `STRONG_INFORMED` > 0.6: follow direction. `NOISE` < 0.3: ignore.

### Concept #15: ADAN-SHADOW (Adversarial Twin)
**File:** `src/core/adan_shadow.js`

Takes OPPOSITE bet on every ADAN trade. Shadow WR > 60% = ADAN has systematic bias → prompt warning + flip consideration.

### Concept #16: Online Learning (SGD)
**File:** `src/ml/online_learner.js`

SGD after every resolved trade. Exponential decay: `0.995^(T−t)`. Adaptive η. L2 regularization λ=0.01. 4th voter in ensemble.

### Concept #17: Conformal Prediction Parser
**Integrated in:** `adan-brain-complete.js`

JSON-first extraction, regex fallback. `norm01`: converts 68 → 0.68. Negative edge → auto-SKIP. Edge > 20% capped to 15%.

### Concept #20A: Triple Barrier Labeling
**File:** `src/ml/triple_barrier.js`

TP/SL = entry ± 2.0 × volatility. Vertical barrier = 20 bars. Labels: {1=TP, 0=timeout, −1=SL}.

### Concept #20C: Purged Walk-Forward CV
**File:** `src/ml/purged_walkforward.js`

5-fold chronological. 5-sample purge at boundary. 3-sample embargo. Overfitting flag: train/test ratio > 1.3×.

### Concept #20D: CUSUM Filter
**File:** `src/ml/cusum_filter.js`

Two-sided accumulator. Threshold = 2 × rolling std of log returns (window 100). Break detected → stake ×0.6.

### Concept #20E: Meta-Labeling
**File:** `src/ml/meta_labeler.js`

Second logistic regression: P(primary model is correct). 12 meta-features. `ALLOW` > 0.55, `REDUCE` 0.45–0.55 (×0.6), `VETO` < 0.45.

### Concept #20F: VPIN
**File:** `src/ml/vpin.js`

`VPIN = mean(|buyVol−sellVol|/bucketSize)` over 50 buckets. > 0.7 = TOXIC (×0.5). > 0.5 = ELEVATED (×0.8).

### Concept #21: Time-to-Close Filter
**Integrated in:** `adan-pred.js`

5/15min crypto: allowed with > 1min. < 2min → ×0.7. Long-term: < 1h → ×0.7 + 3% edge min.

### Concept #22: Resolution Oracle
**File:** `src/ml/resolution_oracle.js`

Clarity score: crypto price markets → 0.8+. Vague events → 0.2–0.4. AVOID if clarity < 0.4.

### Concept #23: Scenario Forecaster (Third Eye)
**File:** `src/ml/scenario_forecaster.js`

3 future scenarios (Bull/Bear/Neutral) per trade. Forecast agrees → ×1.15. Contradicts → ×0.75. Features #33–35 in vector.

### Concept #24: Distributed LLM Router v9.0
**File:** `adan-llm-router.js`

| Priority | Model | RPM | TPM | RPD | Role |
|----------|-------|-----|-----|-----|------|
| 1 | `gemini-3.1-flash-lite-preview` | 15 | 250K | 500 | Workhorse (primary) |
| 2 | `gemma-3-12b-it` | 30 | 15K | 14.4K | Reserve (light) |
| 3 | `gemini-2.5-flash-lite` | 10 | 250K | 20 | Overflow |
| 4 | `gemini-3-flash-preview` | 5 | 250K | 20 | Overflow #2 |
| 5 | `gemma-3-27b-it` | 30 | 15K | 14.4K | Reserve (heavy) |
| 6 | `gemini-2.0-flash` | ∞ | 250K | 0* | Last resort |

Routing by weight: Heavy/Dream → Sniper (2.5 Flash), Light/UltraLight → Distributed fleet, Child → Gemma 12B.

---

## ML Intelligence Layer

### 1. Statistical Brain — 32-Feature Logistic Regression

Pure JavaScript L2-regularized logistic regression trained on ADAN's own trade history.

**Base Features (15):** `rsi`, `rsi5m`, `trend1m/5m/15m/1h`, `bbPct`, `volRatio`, `volAccel`, `vwapPct`, `buyPressure`, `obRatio`, `volatility`, `edge`, `confidence`

**Alien Features (8):** `macdHist`, `fundingRate`, `priceDist`, `timeToExpiry`, `yesPrice`, `fearGreed`, `rsi1h`, `effRatio`

**Regime Interaction (4):** `rsi_x_trending`, `rsi_x_meanrev`, `trend5m_x_trending`, `volRatio_x_volatile`

**Binary + Cyclical + L2 Tensor (5):** `sellWallTrap`, `buyWallTrap`, `side_is_yes`, `hour_sin`, `hour_cos`

**L2 Tensor (3):** `wall_score`, `imbalance_ratio`, `depth_score`

### 2. 4-Voter Ensemble

```
P_ensemble = normalize(P_stat^w1 × P_llm^w2 × P_hist^w3 × P_online^w4)
```

| Voter | Weight | Source |
|-------|--------|--------|
| STAT | 50% | Logistic regression (Platt-calibrated) |
| LLM | 30% | Gemma/Gemini (Platt-calibrated) |
| HIST | 15% | Bayesian base-rate (bin count + asset + soul) |
| ONLINE | 5% | Online SGD learner (adaptive) |

### 3. Kelly Sizer — 15 Multipliers + Mother Code Overrides

```
stake = baseKelly
      × human × session × metabolic × particle × copula
      × wilmott × IV × timeDecay × kmeansRegime × binCountHour
      × metaLabel × cusum × vpin × purgedWF × forecast
      × humanEvent × marketSession × riskOfRuin × smartMoney
```

---

## The Dynasty: MoE Genetic Swarm

### 12 Crypto Children

| Asset | 5-min | 15-min | 1-hour |
|-------|-------|--------|--------|
| **BTC** | HERMES | KRONOS | TITAN |
| **ETH** | ATHENA | DAEDALUS | ZEUS |
| **SOL** | HELIOS | APOLLO | POSEIDON |
| **XRP** | ARES | PROTEUS | HADES |

### 4 LLM Category Children
**politics-daily**, **sports-daily**, **macro-weekly**, **events-daily**

### Evolution (Learning Loop v2)
- Every trade logged to `trades.jsonl` with full feature snapshot
- Wilson lower bound determines if child has proven skill
- Losses generate **directed mutations** (specific numeric DNA corrections)
- Random noise ES runs per Dream cycle on top of directed mutations

---

## Risk Management Stack

| Layer | Concept | Action |
|-------|---------|--------|
| Polymerase | 7-gate pre-trade simulator | Block if any gate fails |
| Order Book | Spread economics | > 5% spread → AVOID |
| Human Event Layer | Psychology state | NEWS_SHOCK → ×0 stake |
| Market Session | Global session | Dead Zone → ×0.6 edge |
| Risk of Ruin | Bankroll protection | RoR > 20% → ×0.25 stake |
| Metabolism | Fund-based scaling | Fund < $100 → hibernate |
| Apoptosis | Catastrophic loss | ≥10 losses → controlled exit |
| Markovian Gate | 3 open positions | Block new bets |
| Markovian Gate | Drawdown > 20% | Dream Mode + full stop |
| Markovian Gate | 3+ consecutive losses | Cap stake at $75 |
| Meta-Labeling | P(correct) < 0.45 | VETO bet |
| Meta-Labeling | P(correct) < 0.55 | Stake ×0.6 |
| Resolution Oracle | Clarity < 0.4 | AVOID market |
| CUSUM Filter | Structural break | Stake ×0.6 |
| VPIN Toxicity | VPIN > 0.7 | Stake ×0.5 |
| VPIN Toxicity | VPIN > 0.5 | Stake ×0.8 |
| K-Means Regime | EVENT detected | Veto ALL bets |
| K-Means Regime | RANGING | Kelly ×0.5 |
| Bin Count Hour | Log-odds < −1.0 | Skip toxic hour |
| TTC Filter | < 1min remaining | Block bet |
| Wilmott Engine | 16 quantitative checks | Various |
| CrashMetrics | Correlation spike | Stake ×0.3 |
| VaR Limit | 99% confidence | Block if > 20% fund |
| Copula Risk | Portfolio correlation | Penalty |
| ADAN-SHADOW | Shadow WR > 60% | Consider flip |
| Edge Inflation Guard | Declared edge > 20% | Cap to 15% |
| Edge Sign Gate | LLM negative edge | Auto-SKIP |
| QUANT GATE + ES | ES-evolved floor | Block if below threshold |
| Scenario Forecaster | Forecast contradicts | Kelly ×0.75 |

---

## Real-Time Data Layer

| Source | Data | Module |
|--------|------|--------|
| Binance | 1m/5m/15m/1h candles, L2 order book, funding rates, VWAP | `src/api/binance.js` |
| Binance Futures | OI Delta, Taker Ratio, L/S Ratio, Liquidation Clusters | `src/api/binance_futures.js` |
| Polymarket CLOB WS | Real-time L2 order book, whale orders, depth | `src/api/polymarket_ws.js` |
| Polymarket Gamma | Smart money flow, volume anomalies, liquidity skew | `src/core/smart_money.js` |
| CryptoPanic | News headlines + VADER sentiment | APPLE module |
| Fear & Greed Index | Market sentiment (0–100) | `src/api/binance.js` |
| Oracle Front-Runner | CEX→Polymarket price lag (30–90s) | `src/core/oracle_front_run.js` |
| VPIN | Volume-synced informed trading probability | `src/ml/vpin.js` |
| CUSUM | Structural break detection | `src/ml/cusum_filter.js` |

---

## Wilmott Quantitative Layer (16 Concepts)

### Tier 1: Game Changers
| # | Concept | Implementation |
|---|---------|----------------|
| 1 | EWMA Volatility | σ²_n = λ×σ²_{n-1} + (1-λ)×R²_n, λ=0.94 |
| 2 | Uncertain Parameters | Fair value range [V_min, V_max] with σ±30% |
| 3 | CrashMetrics | All correlations → 1 in crash. Stake ×0.3 |
| 4 | Portfolio VaR | 99% confidence (α=2.326). Blocks at 20% fund |
| 5 | Crash Allocation | Korn-Wilmott ODE: π̂(t) decreasing |
| 6 | Skill Factor | z-score > 1.645 = statistically skilled |

### Tier 2: High Value
| # | Concept | Implementation |
|---|---------|----------------|
| 7 | Transaction Costs | Min edge > 2× spread |
| 8 | Binary Fair Value | Black-Scholes binary digital call pricing |
| 9 | Jump Diffusion | Kurtosis > 3.5 → confidence reduction |
| 10 | Feedback Effect | σ_eff = σ/(1 − ε×∂Δ/∂S) |
| 11 | Utility Theory | CRRA, Half-Kelly = log utility |
| 12 | Arbitrage Detection | YES + NO < 1.0 − fees → scanner |

---

## Key Files

| File | Purpose |
|------|---------|
| `adan-pred.js` | Main engine (~4400 lines): scanning, trading, ensemble, risk |
| `adan-brain-complete.js` | LLM brain: 8 personas (ATLAS/APPLE/SNAKE/EVA), prompt builder, JSON parser |
| `adan-llm-router.js` | Distributed LLM Router v9.0 (6 Gemini/Gemma models) |
| `start-adan.sh` | Watchdog: auto-restart, heartbeat check, log rotation at 10MB |
| `force_dream.js` | Manual dream cycle trigger |
| **Mother Code v2.0** | |
| `src/core/learning_loop.js` | **NEW** Append-only trades.jsonl ledger, Wilson bounds, directed mutations |
| `src/core/polymerase.js` | **NEW** 7-gate pre-trade simulator + shadow bet recorder |
| `src/core/lmsr_engine.js` | **NEW** LMSR Bayesian fair value calculator |
| `src/core/particle_filter.js` | **NEW** Bootstrap particle filter (N=200) for true probability estimation |
| `src/core/oracle_front_run.js` | **NEW** CEX→Polymarket lag detector (30–90s window) |
| `src/core/smart_money.js` | **NEW** Whale flow tracker (Polymarket Gamma API) |
| `src/core/order_book.js` | **NEW** Spread economics + execution cost filter |
| `src/core/human_event_layer.js` | **NEW** 6-state market psychology detector |
| `src/core/market_sessions.js` | **NEW** 8 global trading sessions with calibrated multipliers |
| `src/core/metabolism.js` | **NEW** Fund-based stake scaling + hibernation |
| `src/core/risk_of_ruin.js` | **NEW** RoR calculator + auto stake reduction |
| `src/core/apoptosis.js` | **NEW** Controlled programmatic exit on catastrophic loss |
| `src/core/quota_manager.js` | **NEW** 6-tier LLM quota tracking per category |
| `src/core/soul_manager.js` | **NEW** SOUL.md deduplication (470KB → top-6 per prompt) |
| **ML Layer** | |
| `src/ml/logistic_regression.js` | 32-feature L2-regularized logistic regression |
| `src/ml/walk_forward.js` | Walk-forward validation (27 folds, proper OOS) |
| `src/ml/ensemble.js` | 4-voter log-linear pooling with learned weights |
| `src/ml/kelly_sizer.js` | Quarter-Kelly optimal sizing |
| `src/ml/calibrator.js` | Platt/Isotonic calibration (PAV algorithm) |
| `src/ml/market_filter.js` | Bayesian market quality filter |
| `src/ml/online_learner.js` | Online SGD learner with exponential decay |
| `src/ml/evolution_strategies.js` | 20-vector ES with Sharpe fitness |
| `src/ml/shapley_values.js` | Monte Carlo Shapley feature importance |
| `src/ml/ucb_explorer.js` | UCB1 market selection bandit |
| `src/ml/meta_labeler.js` | Meta-Labeling bet quality gate |
| `src/ml/triple_barrier.js` | Triple Barrier trade labeling |
| `src/ml/cusum_filter.js` | CUSUM structural break detector |
| `src/ml/vpin.js` | VPIN volume toxicity tracker |
| `src/ml/purged_walkforward.js` | Purged Walk-Forward CV |
| `src/ml/resolution_oracle.js` | Resolution Oracle market filter |
| `src/ml/scenario_forecaster.js` | Scenario Forecaster (Third Eye) |
| **Core** | |
| `src/core/wilmott_quant.js` | 16 Wilmott concepts: EWMA, VaR, CrashMetrics |
| `src/core/iv_solver.js` | Black-Scholes IV Solver & Skew Analysis |
| `src/core/regime_classifier.js` | EWMA-based regime detection + kurtosis |
| `src/core/regime_detector.js` | K-Means clustering regime detector |
| `src/core/pin_score.js` | PIN Score order flow toxicity |
| `src/core/moe_dynasty.js` | Mixture of Experts gating for children |
| `src/core/adan_shadow.js` | ADAN-SHADOW adversarial bias detection |
| `src/core/genetics.js` | DNA crossover, mutation, Tournament of Death |
| `src/core/child_learning.js` | Accuracy tracking + MoE weight updates |
| `src/core/copula_risk.js` | Portfolio correlation risk |
| `src/core/inner_monologue.js` | Post-trade reflections |
| `src/core/consciousness_journal.js` | Dream cycle journal |
| `src/core/experiment_engine.js` | Self-directed hypothesis testing |
| `src/core/adan_voice.js` | Voice output + system status reports |
| `src/core/greeks_adapter.js` | Options Greeks adapter |
| `src/core/feature_importance.js` | Feature importance tracking |
| `src/core/feature_attribution.js` | Feature attribution per trade |
| **API** | |
| `src/api/polymarket.js` | Polymarket REST API + market classification |
| `src/api/polymarket_ws.js` | Real-time CLOB WebSocket (L2 order book) |
| `src/api/binance.js` | Binance candles, order book, funding, VWAP |
| `src/api/binance_futures.js` | Futures Intelligence (OI, Taker, L/S, Liquidation) |
| `src/api/brier-reporter.js` | Brier score tracking |
| `src/api/external_data.js` | Fear & Greed + external signals |
| `src/api/hyperliquid.js` | HyperLiquid ATLAS cross-exchange intelligence |
| **Quant (Python)** | |
| `quant/sync_to_sqlite.py` | ETL: JSON feature logs → SQLite |
| `quant/Research_01.ipynb` | Walk-forward CV, XGBoost, Equity Curve |

---

## Setup & Workflow

```bash
# 1. Start ADAN (with watchdog)
npm install
echo "GEMINI_API_KEY=your_key" > .env
chmod +x start-adan.sh
./start-adan.sh

# 2. Python Quant Environment
cd quant
python3 -m venv venv
source venv/bin/activate
pip install pandas scikit-learn xgboost jupyter matplotlib seaborn

# 3. Daily: Sync trades to database
python sync_to_sqlite.py

# 4. Validate edge in Jupyter
jupyter notebook
```

---

## Intelligence Score: 880/1000

| Category | Score | Details |
|----------|-------|---------|
| **Statistical Brain** | 135/150 | 32-feature LogReg + Online SGD + walk-forward + Shapley. Missing: XGBoost/neural net in real-time loop. |
| **Calibration** | 95/100 | Platt isotonic + meta-calibration + conformal parser + edge inflation guard + Learning Loop v2 calibration curves. |
| **Ensemble** | 95/100 | 4-voter log-linear pooling + learned weights + veto. |
| **Market Selection** | 90/100 | Bayesian filter + UCB bandit + Oracle Front-Runner + Smart Money + LMSR fair value. |
| **Risk Management** | 100/100 | Kelly (15+ mult) + Wilmott (16) + VaR + Apoptosis + Risk of Ruin + Metabolism + Polymerase (7 gates) + 20+ blockers. |
| **Data Pipeline** | 85/100 | Binance + Polymarket WS + CryptoPanic + VADER + Fear&Greed + PIN + L2 + Futures + Smart Money + CEX Oracle. |
| **Consciousness** | 75/100 | Self-reader + monologue + experiments + voice + Scenario Forecaster + journal + Human Event Layer. |
| **Genetic Evolution** | 80/100 | MoE Dynasty + ES + Shapley pruning + Learning Loop v2 directed mutations + Wilson survival gates. |
| **LLM Infrastructure** | 70/100 | Distributed Router v9.0 (6 models), quota management, Soul Manager deduplication. |
| **Execution** | 55/100 | Paper trading. CLOB WebSocket connected. Real execution pending USDC + private key integration. |

**What gets us to 950+:** Live CLOB execution + Claude Haiku/Sonnet as LLM brain + XGBoost automated pipeline + >58% sustained WR.

---

## Pending Concepts (Roadmap)

| # | Concept | Requirement | Priority |
|---|---------|-------------|----------|
| 1 | Live CLOB Execution | USDC wallet + private key | **CRITICAL** |
| 2 | Claude as LLM Brain | Anthropic API key | HIGH |
| 3 | Automated XGBoost Pipeline | Python microservice | HIGH |
| 4 | CNN 1D Multivariate | Python microservice | HIGH |
| 5 | DQN Trading Environment | Python + RL | HIGH |
| 6 | LSTM Regime Detector | Python + TensorFlow | MEDIUM |
| 7 | Whale Wallet Tracker | On-chain API | MEDIUM |
| 8 | Infrastructure (PostgreSQL, Docker) | DevOps | LOW |
| 9 | Ephemeral Coding | LVL 25+ gate | GATED |
| 10 | Mempool Reader | WR > 62% + fund > $30k | GATED |

---

*Autonomous intelligence research. Paper trading mode. Not financial advice.*
*Statistical: logistic regression + walk-forward + Platt calibration + Learning Loop v2.*
*Quantitative: Paul Wilmott's "Quantitative Finance" (Wiley, 2006).*
*ML: Marcos López de Prado's "Advances in Financial Machine Learning" (Wiley, 2018).*
*LLM Infrastructure: Google Gemini Fleet (6 models, distributed routing).*
*Evidence backbone: append-only trades.jsonl ledger — every decision has a paper trail.*
