import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DIR = path.join(HOME, '.adan-pred');
const CONFIG_PATH = path.join(process.cwd(), 'config.json'); // Use local config
const PNL_PATH = path.join(DIR, 'pnl.json');
const POSITIONS_PATH = path.join(DIR, 'positions.json');
const SOUL_PATH = path.join(DIR, 'SOUL.md');
const THOUGHTS_PATH = path.join(DIR, 'thoughts.jsonl');
const STRATEGY_PATH = path.join(DIR, 'strategy.json');
const CALIB_PATH = path.join(DIR, 'calibration.json');
const INTEL_DIR = path.join(DIR, 'intel');      // hijos escriben aquí
const HYPOTHESIS_PATH = path.join(DIR, 'hypotheses.jsonl'); // memoria episódica
const DYN_WEIGHTS_PATH = path.join(DIR, 'dynamic_weights.json'); // P5: auto-modificación limitada (Fase 2)

// ── APIs ───────────────────────────────────────────────────────────────────
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const BINANCE_API = 'https://api.binance.com/api/v3';
const SCAN_INTERVAL_MS = 90 * 1000; // 90sec — TRAINING MODE: max speed
const MAX_POSITIONS = 15;    // TRAINING: más slots = más trades simultáneos
const MIN_EDGE = 0.02;  // TRAINING: 2% edge — toma casi todo para aprender
const PAPER_BET_SIZE = 100;   // $100 por bet = 1% del fondo $10k

// Symbols to track on Binance
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ── Default Strategy ────────────────────────────────────────────────────────
const DEFAULT_STRATEGY = {
  minEdge: 0.02,    // TRAINING: 2% edge — maximize trades for learning
  minLiquidity: 200, // TRAINING: lower liquidity floor
  maxMarketsCheck: 30,
  minConfidence: 60,
  maxHoursToClose: 168,
  version: 1,
  evolvedAt: null
};

// ── Tree rules ──────────────────────────────────────────────────────────────
const TREE_RULES = {
  // ADAN spawn rules:
  //   LVL 3 → primer hijo (1 máximo)
  //   LVL 4 → hasta 6 hijos
  maxChildrenGen1: 9,  // max hijos directos — full coverage BTC/ETH/SOL × 5m/15m/1hr
  maxChildrenAtLvl3: 1, // al LVL 3 solo puede tener 1 hijo
  // Nietos (Gen2 → Gen3): cada hijo puede tener hasta 2 nietos
  maxChildrenGen2: 2,   // max nietos por hijo (hijo necesita expChild >= 100)
  // Bisnietos (Gen3 → Gen4): cada nieto puede tener hasta 3 bisnietos, luego muere
  maxChildrenGen3: 3,
  canSpawnGen3: true,
  maxGen: 4,
  treasuryPct: 0.10,
  childExpToSpawn: 100, // EXP que debe tener un hijo para poder engendrar nietos
  // Torneo de la Muerte: al trade 20, bottom 50% de hijos muere, capital redistribuído
  tournamentTrades: 20,
  // Condiciones spawn padre (paper phase: WR gate eliminado — 10 trades + LVL 2):
  spawnConditions: { minWinRate: 0.00, minTrades: 0, minLvl: 2, minNetPositive: false }
};

// ── Colors ──────────────────────────────────────────────────────────────────
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m';
const B = '\x1b[34m', C = '\x1b[36m', M = '\x1b[35m';
const W = '\x1b[97m', D = '\x1b[2m', X = '\x1b[0m';
const BOLD = '\x1b[1m';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    lines.forEach(l => {
      // Ignore comments and empty lines
      if (l.trim().startsWith('#') || l.trim() === '') return;
      const match = l.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = (match[2] || '').trim();
        // Remove surrounding quotes if they exist
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);

        // Remove trailing comments in the value line
        if (value.includes('#')) value = value.split('#')[0].trim();

        // Only set if not already set or if it's currently a placeholder
        if (!process.env[key] || process.env[key] === 'FROM_ENV' || process.env[key] === '') {
          process.env[key] = value;
        }
      }
    });
  }

  const key = process.env.GEMINI_API_KEY;
  if (key && key.startsWith('AIza')) {
    console.log(G + '✅ Gemini API Key Loaded: ' + key.slice(0, 10) + '...' + key.slice(-4) + X);
  } else {
    console.log(R + '❌ API Key Error: GEMINI_API_KEY not found or invalid in .env' + X);
  }
}
loadEnv();

function cls() { process.stdout.write('\x1b[2J\x1b[H'); }
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { mode: 0o700, recursive: true }); }
function loadConfig() { return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null; }
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 }); }

function loadStrategy() {
  if (!fs.existsSync(STRATEGY_PATH)) { fs.writeFileSync(STRATEGY_PATH, JSON.stringify(DEFAULT_STRATEGY, null, 2)); return { ...DEFAULT_STRATEGY }; }
  try { return { ...DEFAULT_STRATEGY, ...JSON.parse(fs.readFileSync(STRATEGY_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_STRATEGY }; }
}

// ── P5: dynamic_weights.json — ADAN lee, humanos escriben (Fase 1: read-only) ─
// En Fase 2: ADAN podrá modificar sus propios pesos cuando WR > 55% por 20 trades.
const DEFAULT_DYN_WEIGHTS = {
  volumeWeight: 1.0,   // multiplicador de señales de volumen
  vwapWeight: 1.0,   // multiplicador de señales de VWAP
  trendWeight: 1.0,   // multiplicador de señales de tendencia
  fearGreedBias: 0.0,  // sesgo cuando F&G < 20 (positivo = más NO bets)
  _note: 'Fase 1: modificar manualmente para ajustar. Fase 2: ADAN ajusta autónomamente al 55%+ WR.',
  _lastModified: new Date().toISOString()
};
function loadDynWeights() {
  if (!fs.existsSync(DYN_WEIGHTS_PATH)) {
    fs.writeFileSync(DYN_WEIGHTS_PATH, JSON.stringify(DEFAULT_DYN_WEIGHTS, null, 2));
    return { ...DEFAULT_DYN_WEIGHTS };
  }
  try { return { ...DEFAULT_DYN_WEIGHTS, ...JSON.parse(fs.readFileSync(DYN_WEIGHTS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_DYN_WEIGHTS }; }
}
function saveStrategy(s) { fs.writeFileSync(STRATEGY_PATH, JSON.stringify(s, null, 2)); }

// Atomic write: write to tmp then rename (prevents corruption from concurrent writes)
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function loadPnL() {
  const def = { trades: 0, wins: 0, losses: 0, net: 0, exp: 0, fund: 10000, treasury: 0, children: [], generation: 1, streak: 0, hourStats: {} };
  try { return fs.existsSync(PNL_PATH) ? { ...def, ...JSON.parse(fs.readFileSync(PNL_PATH, 'utf8')) } : def; }
  catch { return def; }
}
function savePnL(p) { atomicWrite(PNL_PATH, p); }

function loadPositions() {
  const def = { open: [], closed: [] };
  try { return fs.existsSync(POSITIONS_PATH) ? { ...def, ...JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8')) } : def; }
  catch { return def; }
}
function savePositions(p) { atomicWrite(POSITIONS_PATH, p); }

// ── Calibration ─────────────────────────────────────────────────────────────
function loadCalibration() {
  const def = { btc: { p: 0, c: 0 }, eth: { p: 0, c: 0 }, sol: { p: 0, c: 0 }, other: { p: 0, c: 0 } };
  if (!fs.existsSync(CALIB_PATH)) return def;
  try { return { ...def, ...JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8')) }; }
  catch { return def; }
}
function saveCalibration(c) { fs.writeFileSync(CALIB_PATH, JSON.stringify(c, null, 2)); }

function updateCalibration(asset, won) {
  const c = loadCalibration();
  const key = asset.toLowerCase().includes('btc') ? 'btc'
    : asset.toLowerCase().includes('eth') ? 'eth'
      : asset.toLowerCase().includes('sol') ? 'sol' : 'other';
  if (!c[key]) c[key] = { p: 0, c: 0 };
  c[key].p++;
  if (won) c[key].c++;
  saveCalibration(c);
}

// ── SOUL ────────────────────────────────────────────────────────────────────
function loadSoul() {
  if (!fs.existsSync(SOUL_PATH)) {
    fs.writeFileSync(SOUL_PATH, `# ADAN-PRED SOUL
Created: ${new Date().toISOString().slice(0, 10)}

## Identity
I am ADAN-PRED. Autonomous prediction markets agent.
Brain: Claude Sonnet 4.6. Data: Polymarket + Binance.
Goal: 55%+ win rate over 20 predictions → real USDC.

## Rules from Lord
1. Only bet when technical analysis + market odds give real edge > 8%.
2. Binance candles are truth — respect the trend.
3. Short-term crypto markets (5-15min) are momentum plays.
4. Never fight a strong trend. If BTC is dumping fast → NO on up bets.
5. Volatility kills predictions — avoid when candles are chaotic.

## Patterns Discovered
*(updated every 5 closed trades)*

## Mistakes
*(updated on every losing bet)*
`);
  }
  return fs.readFileSync(SOUL_PATH, 'utf8');
}
function appendToSoul(entry) {
  // Use append for performance
  fs.appendFileSync(SOUL_PATH, '\n' + entry);

  // Log Rotation: if > 5MB, keep only header + most recent history
  try {
    const stats = fs.statSync(SOUL_PATH);
    if (stats.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(SOUL_PATH, 'utf8');
      const lines = content.split('\n');
      if (lines.length > 2000) {
        const header = lines.slice(0, 50).join('\n'); // Keep identity/rules
        const footer = lines.slice(-1000).join('\n'); // Keep last 1k lines
        fs.writeFileSync(SOUL_PATH, header + '\n\n... [TRUNCATED FOR SPEED] ...\n\n' + footer);
      }
    }
  } catch (e) { }
}

// ── EXP / Level ─────────────────────────────────────────────────────────────
function expForLevel(L) { if (L <= 1) return 0; return Math.round((50 / 3) * (Math.pow(L, 3) - 6 * Math.pow(L, 2) + 17 * L - 12)); }
function levelFromExp(e) { let L = 1; while (expForLevel(L + 1) <= e) L++; return L; }
function expProgress(e) {
  const L = levelFromExp(e), cur = expForLevel(L), nxt = expForLevel(L + 1);
  const pct = Math.round((e - cur) / (nxt - cur) * 100), f = Math.round(pct / 5);
  return { level: L, bar: '█'.repeat(f) + '░'.repeat(20 - f), pct, needed: nxt - e, curTotal: Math.round(e), nxtTotal: nxt };
}
function levelTitle(L) {
  if (L >= 100) return '👑 SOVEREIGN'; if (L >= 80) return '🏦 DYNASTY';
  if (L >= 70) return '🏹 SNIPER'; if (L >= 60) return '🌐 ORACLE GOD';
  if (L >= 50) return '💳 PROPHET'; if (L >= 40) return '💰 SEER';
  if (L >= 30) return '🧠 FORECASTER'; if (L >= 20) return '▲ ANALYST';
  if (L >= 15) return '⚔ TRADER'; if (L >= 10) return '🛡 READER';
  if (L >= 5) return '● STUDENT'; return '○ NOVICE';
}

function getSkills(L) {
  return [
    { lvl: 1, name: 'LIVE FEED', icon: '📡', desc: 'Polymarket + Binance real-time data', unlocked: L >= 1 },
    { lvl: 2, name: 'TREND READ', icon: '📊', desc: 'Binance candles momentum analysis 1m/5m/15m', unlocked: L >= 2 },
    { lvl: 3, name: 'FIRST CHILD', icon: '👶', desc: 'Spawns first child agent specialized by asset', unlocked: L >= 3 },
    { lvl: 3, name: 'EDGE FILTER', icon: '🎯', desc: 'Dynamic edge threshold — learns min per asset', unlocked: L >= 3 },
    { lvl: 4, name: 'KELLY BET', icon: '📐', desc: 'Optimal bet size via Kelly Criterion — scales with edge', unlocked: L >= 4 },
    { lvl: 5, name: 'MULTI-BET', icon: '⚡', desc: 'Up to 9 simultaneous positions', unlocked: L >= 5 },
    { lvl: 6, name: 'CANDLE PAT', icon: '🕯️', desc: 'Hammer/engulfing/doji reversal detection', unlocked: L >= 6 },
    { lvl: 8, name: 'CALIBRATION', icon: '🔬', desc: 'Accuracy tracking by asset (BTC/ETH/SOL)', unlocked: L >= 8 },
    { lvl: 9, name: 'TIMING', icon: '⏱️', desc: 'Learns best minute within window to enter', unlocked: L >= 9 },
    { lvl: 10, name: 'VOL SENSE', icon: '🌊', desc: 'Avoids chaotic high-volatility markets', unlocked: L >= 10 },
    { lvl: 12, name: 'FEAR EXPLOIT', icon: '😱', desc: 'Fear & Greed < 20 — exploit market overreaction', unlocked: L >= 12 },
    { lvl: 15, name: 'STRAT EVO', icon: '🧬', desc: 'Auto-evolves edge threshold every 5 trades', unlocked: L >= 15 },
    { lvl: 18, name: 'CORRELATION', icon: '🔗', desc: 'BTC cascade → SOL/ETH follow-through bets', unlocked: L >= 18 },
    { lvl: 20, name: 'NIGHT OWL', icon: '🌙', desc: 'Off-hours pattern memory — 2AM-6AM ET', unlocked: L >= 20 },
    { lvl: 25, name: 'SHADOW MODE', icon: '🌑', desc: 'Binance-only training when Polymarket offline', unlocked: L >= 25 },
    { lvl: 30, name: 'SONIC MIND', icon: '🧠', desc: 'Deep candle pattern recognition — 50+ signals', unlocked: L >= 30 },
    { lvl: 35, name: 'X RADAR', icon: '📰', desc: 'Twitter/X sentiment — paid from treasury', unlocked: L >= 35 },
    { lvl: 40, name: 'REAL USDC', icon: '💰', desc: 'Graduated — live USDC betting on Polymarket', unlocked: L >= 40 },
    { lvl: 50, name: 'AUTO-FUND', icon: '💳', desc: 'Uses treasury to self-pay API costs on-chain', unlocked: L >= 50 },
    { lvl: 60, name: 'MULTI-MARKET', icon: '🌐', desc: 'Expand to Manifold + other prediction markets beyond Polymarket', unlocked: L >= 60 },
    { lvl: 70, name: 'SNIPER', icon: '🏹', desc: 'Only highest-edge bet per cycle — ruthless filter', unlocked: L >= 70 },
    { lvl: 80, name: 'DYNASTY', icon: '🏦', desc: 'Full 3-gen tree — padre + 6 hijos + 12 nietos', unlocked: L >= 80 },
    { lvl: 100, name: 'SOVEREIGN', icon: '👑', desc: 'Fully autonomous — no human supervision needed', unlocked: L >= 100 },
  ];
}

function calcWinExp(conf, edge, streak) {
  let base = 100;
  if (conf >= 90) base = Math.round(base * 2.0); else if (conf >= 80) base = Math.round(base * 1.5); else if (conf < 65) base = Math.round(base * 0.7);
  if (edge >= 0.30) base += 500; else if (edge >= 0.20) base += 200; else if (edge >= 0.15) base += 100;
  if (streak >= 3) base += 50 * (streak - 2);
  return base;
}

async function showLevelUpScreen(from, to) {
  const newSkill = getSkills(to).find(s => s.lvl === to);
  const col = to >= 40 ? Y : to >= 20 ? C : to >= 10 ? Y : G;
  cls();
  console.log('\n\n' + col + BOLD);
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║       ✦ ✦ ✦   L E V E L   U P !   ✦ ✦ ✦                  ║');
  console.log('  ║   LEVEL ' + String(from).padStart(3) + X + col + BOLD + '  →  LEVEL ' + String(to).padEnd(3) + '   ' + levelTitle(to).padEnd(22) + '    ║');
  if (newSkill) {
    console.log('  ║   NEW SKILL: ' + newSkill.icon + '  ' + newSkill.name.padEnd(14) + '  ' + newSkill.desc.slice(0, 36).padEnd(36) + '  ║');
  }
  console.log('  ╚══════════════════════════════════════════════════════════════╝' + X);
  await new Promise(r => setTimeout(r, 3000));
}

function awardExp(amount) {
  const p = loadPnL(); p.exp = (p.exp || 0) + amount;
  const before = levelFromExp(p.exp - amount), after = levelFromExp(p.exp);
  savePnL(p);
  if (after > before) showLevelUpScreen(before, after).catch(() => { });
  return p.exp;
}

export {
  HOME, DIR, CONFIG_PATH, PNL_PATH, POSITIONS_PATH, SOUL_PATH, THOUGHTS_PATH,
  STRATEGY_PATH, CALIB_PATH, INTEL_DIR, HYPOTHESIS_PATH, DYN_WEIGHTS_PATH,
  POLYMARKET_API, BINANCE_API, SCAN_INTERVAL_MS, MAX_POSITIONS, MIN_EDGE,
  PAPER_BET_SIZE, SYMBOLS, DEFAULT_STRATEGY, TREE_RULES,
  G, Y, R, B, C, M, W, D, X, BOLD,
  loadEnv, cls, ensureDir, loadConfig, saveConfig, loadStrategy,
  loadDynWeights, saveStrategy, loadPnL, savePnL, loadPositions, savePositions,
  loadCalibration, saveCalibration, updateCalibration, loadSoul, appendToSoul,
  expForLevel, levelFromExp, expProgress, levelTitle, getSkills, calcWinExp,
  awardExp
};
