import fs from 'fs';
import path from 'path';
import {
  HOME, DIR, DYN_WEIGHTS_PATH, INTEL_DIR, TREE_RULES,
  C, BOLD, X, R, M, G, Y,
  loadPnL, savePnL, loadSoul, appendToSoul, loadStrategy, loadDynWeights,
  loadConfig, saveConfig, expProgress
} from './config.js';
import { childLearning } from './child_learning.js';
import { wilsonLower } from './learning_loop.js';

// ── Claude naming for children ────────────────────────────────────────────────
const CHILD_NAMES = {
  'BTC-5min': 'HERMES', 'ETH-5min': 'ATHENA', 'SOL-5min': 'HELIOS',
  'BTC-15min': 'KRONOS', 'ETH-15min': 'DAEDALUS', 'SOL-15min': 'APOLLO',
  'BTC-1hr': 'TITAN', 'ETH-1hr': 'ZEUS', 'SOL-1hr': 'POSEIDON',
};
async function nameChild(spec, signal) {
  // Try predefined first — fast + free
  if (CHILD_NAMES[spec]) return CHILD_NAMES[spec];
  try {
    const { routeLLM, parseAIResponse } = await import('../../adan-llm-router.js');
    const prompt = `Name a trading AI agent: specialization=${spec}, signal=${signal || 'neutral'}. One mythological name only (Greek/Roman/Norse). Reply with just the name in CAPS.`;
    const resp = await routeLLM({ prompt, weight: 'Light' });
    return resp.trim().replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10) || CHILD_NAMES[spec] || 'UNNAMED';
  } catch { return CHILD_NAMES[spec] || 'UNNAMED'; }
}

// ── Spawn child agent ─────────────────────────────────────────────────────────
async function spawnChild(pnl, specialization) {
  const xpData = expProgress(pnl.exp || 0);
  const sc = TREE_RULES.spawnConditions;
  const children = pnl.children || [];
  // LVL 3 → 1 max child. LVL 4+ → up to 6 children. Children ONLY report, NEVER bet.
  const maxC = xpData.level >= 4 ? TREE_RULES.maxChildrenGen1 : TREE_RULES.maxChildrenAtLvl3;
  if (xpData.level < sc.minLvl) return null;
  if (children.length >= maxC) return null;
  if (pnl.trades < sc.minTrades) return null;
  if ((pnl.wins / Math.max(pnl.trades, 1)) < sc.minWinRate) return null;
  if ((pnl.treasury || 0) <= 0) return null;

  const SPECS = [
    'BTC-5min', 'ETH-5min', 'SOL-5min', 'XRP-5min',
    'BTC-15min', 'ETH-15min', 'SOL-15min', 'XRP-15min',
    'BTC-1hr', 'ETH-1hr', 'SOL-1hr', 'XRP-1hr'
  ];
  const taken = children.map(c => c.spec);
  const nextSpec = specialization || SPECS.find(s => !taken.includes(s)) || 'BTC-5min';

  // Name the child based on Faction balancing
  pnl.factionSpawnCounts = pnl.factionSpawnCounts || { apple: 0, snake: 0, eva: 0, atlas: 0, adan: 0 };
  const factions = ['apple', 'snake', 'eva', 'atlas', 'adan'];
  const factionKeys = { apple: 'a', snake: 's', eva: 'e', atlas: 'at', adan: 'ad' };

  // Count only alive children for balancing
  const aliveChildren = children.filter(c => c.status !== 'dead');
  const aliveCounts = { apple: 0, snake: 0, eva: 0, atlas: 0, adan: 0 };
  aliveChildren.forEach(c => { if (c.faction && aliveCounts[c.faction] !== undefined) aliveCounts[c.faction]++; });


  let chosenFaction = factions[0];
  let minC = aliveCounts[chosenFaction];
  for (const f of factions) {
    if (aliveCounts[f] < minC) { minC = aliveCounts[f]; chosenFaction = f; }
  }

  pnl.factionSpawnCounts[chosenFaction]++;
  const childName = (factionKeys[chosenFaction] + pnl.factionSpawnCounts[chosenFaction]).toUpperCase();

  // Inherit relevant SOUL sections
  const parentSoul = loadSoul();
  const relevantAsset = nextSpec.replace(/-.*/, '').toLowerCase();
  const inheritedLines = parentSoul.split('\n').filter(l =>
    l.includes('## Rules') || l.includes('## Identity') ||
    l.includes(relevantAsset.toUpperCase()) || l.includes('MISTAKE') ||
    l.includes('PATTERNS') || l.includes('REGLA')
  ).slice(0, 30);

  const childDir = path.join(HOME, `.adan-pred/children/${nextSpec.replace(/\//g, '-')}`);
  if (!fs.existsSync(childDir)) fs.mkdirSync(childDir, { recursive: true });

  const childSoul = `# ${childName} — ADAN-PRED CHILD
Created: ${new Date().toISOString().slice(0, 10)}
Name: ${childName} | Spec: ${nextSpec} | Faction: ${chosenFaction.toUpperCase()} | Gen: ${(pnl.generation || 1) + 1}

## Identity
I am ${childName}. Child of ${chosenFaction.toUpperCase()}. I specialize in ${nextSpec} markets.
I scan every cycle, report intelligence to my father, and learn my domain.
I never bet — I inform. Father decides.

## Inherited wisdom from Parent:
${inheritedLines.join('\n')}

## My Rules
1. I only analyze ${nextSpec} markets
2. I report signals to parent ADAN — parent makes all betting decisions
3. I NEVER bet — I scan, score, and report. Father decides.
4. I observe patterns and promote confirmed ones bottom-up
5. I accumulate EXP from father's wins. At 100 EXP I may spawn up to 2 grandchildren (when ADAN is LVL 4+).
`;

  const childId = Date.now().toString();
  const capital = Math.min(pnl.treasury * 0.3, 500);

  // ── GENETIC MUTATION — evolutionary pressure ─────────────────────────────────
  // Gen 1 (Risk): minEdge ±10%, Gen 2 (Stake): 5-15% capital, Gen 3 (Patience): ±20%
  // Gen C (Cognitive): analysis style (A=volume/vwap, B=bollinger/vol, C=rsi/reversal)
  const mutate = (base, pct = 0.08) => parseFloat((base * (1 + (Math.random() * 2 - 1) * pct)).toFixed(4));
  const parentStrat = loadStrategy();
  // Cognitive style: read from parent's best child or random
  const cognitiveStyles = ['volume_vwap', 'bollinger_vol', 'rsi_reversal'];
  const cognitiveStyle = cognitiveStyles[Math.floor(Math.random() * 3)];
  // Stake: 5%-15% of available fund (vs fixed $100 in parent)
  const stakePct = parseFloat((0.05 + Math.random() * 0.10).toFixed(3)); // 5-15%
  // Market patience: minutes before skipping a market (shorter = more selective)
  const patience = parseFloat((0.8 + Math.random() * 0.8).toFixed(2)); // 0.8-1.6x
  const dna = {
    minEdge: mutate(parentStrat.minEdge || 0.05, 0.10), // Gen 1: risk aversion ±10%
    volWeight: mutate(1.0, 0.08), // volume weight
    vwapWeight: mutate(1.0, 0.08), // VWAP weight
    boredBBMin: mutate(0.006, 0.10), // boredom threshold
    stakePct,                                                      // Gen 2: stake 5-15% capital
    patience,                                                      // Gen 3: market patience factor
    cognitiveStyle,                                                // Cognitive style A/B/C
    mutation: Math.round(Math.random() * 100)                   // traceability seed
  };
  // ─────────────────────────────────────────────────────────────────────────

  fs.writeFileSync(path.join(childDir, 'SOUL.md'), childSoul);
  fs.writeFileSync(path.join(childDir, 'pnl.json'), JSON.stringify({
    trades: 0, wins: 0, losses: 0, net: 0, exp: 0,
    fund: parseFloat(capital.toFixed(2)),
    treasury: 0, children: [], generation: (pnl.generation || 1) + 1, streak: 0, hourStats: {},
    parentId: pnl.id || 'root', spec: nextSpec, name: childName, faction: chosenFaction,
    // Child observes first 5 trades before sending signals (signal quality gate)
    signalActiveTrades: 5, status: 'observing',
    dna  // hereditary genetic mutation
  }, null, 2));

  const child = { id: childId, name: childName, spec: nextSpec, faction: chosenFaction, born: new Date().toISOString(), capital, dir: childDir, generation: (pnl.generation || 1) + 1, status: 'observing', dna };
  pnl.children = [...children, child];
  pnl.treasury = parseFloat(((pnl.treasury || 0) - capital).toFixed(2));
  savePnL(pnl);

  appendToSoul(`\n### CHILD SPAWNED — ${new Date().toISOString()}:\n${childName} (${nextSpec}, faction: ${chosenFaction}) born with $${capital.toFixed(2)} capital. Gen ${child.generation}. Children: ${pnl.children.length}.\n`);
  return child;
}

// ── ASCENDING GENETIC ABSORPTION ────────────────────────────────────────────
// The central mechanism of evolution: the best child promotes its genes to the parent.
// ADAN is the evaluator and beneficiary — not the one who decides which child survives,
// but the one who absorbs winning intelligence into its own operational DNA.
//
// Flow: child born with mutated DNA → operates → if outperforms ADAN in ≥10 trades →
//        ADAN absorbs its DNA → dynamic_weights.json updates →
//        ADAN operates in the next cycle with that superior genome.
function absorbEliteGenome(pnl) {
  const children = pnl.children || [];
  if (!children.length) return;

  // STATISTICAL GATE: absorption pushes a child's DNA into the LIVE parent
  // weights, so the entry bar must be evidence, not a lucky streak. A raw-WR
  // gate at n=5 once absorbed a child with 14/18 wins the moment it went
  // bankrupt. Now: minimum 30 resolved trades AND Wilson 95% lower bound ≥ 0.50
  // (i.e. we are statistically confident the true WR is above a coin flip).
  const MIN_ABSORB_TRADES = 30;
  const MIN_ABSORB_WILSON = 0.50;
  let bestChild = null;
  let bestScore = -Infinity;

  for (const ch of children) {
    const childDir = ch.dir || path.join(DIR, 'children', ch.id || ch.spec);
    const cpPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(cpPath)) continue;
    let cp;
    try { cp = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { continue; }

    if (!cp.dna) continue;                          // child without mutation = not applicable
    if ((cp.trades || 0) < MIN_ABSORB_TRADES) continue;
    const childWilson = wilsonLower(cp.wins || 0, cp.trades || 0);
    if (childWilson < MIN_ABSORB_WILSON) continue;

    const score = childWilson * 100;
    if (score > bestScore) {
      bestScore = score;
      bestChild = { ...ch, cp };
    }
  }

  if (!bestChild) return; // nobody outperforms the winning threshold yet

  // FIX: Read EVOLVED DNA from childLearning (the DNA that actually changes via evolution)
  // genetics.js DNA (pnl.json) is static — childLearning DNA is what evolves via _evolvePool
  const specId = (bestChild.spec || '').replace(/[A-Z]+-/, m => m.toLowerCase());
  const evolvedDna = childLearning.getChildDNA(specId);
  const spawnDna = bestChild.cp.dna || {};

  const curr = loadDynWeights();
  const parentWR = pnl.trades > 0 ? pnl.wins / pnl.trades : 0.40;

  // Gradual absorption (20% delta per cycle — no total absorption at once)
  const lerp = (a, b, t) => parseFloat((a + (b - a) * t).toFixed(4));
  const T = 0.20; // absorption rate: 20% of the way to child genome

  // Absorb BOTH DNA systems: spawn DNA (volWeight/vwapWeight) + evolved DNA (signal params)
  const absorbed = {
    volumeWeight: lerp(curr.volumeWeight, spawnDna.volWeight || 1.0, T),
    vwapWeight: lerp(curr.vwapWeight, spawnDna.vwapWeight || 1.0, T),
    trendWeight: lerp(curr.trendWeight || 1.0, (evolvedDna.trendMinPct || 0.3) / 0.3, T),
    // Store the evolved signal DNA so ADAN's children inherit winning params
    _evolvedDNA: {
      rsiOversold: evolvedDna.rsiOversold,
      rsiOverbought: evolvedDna.rsiOverbought,
      macdWeight: evolvedDna.macdWeight,
      trendMinPct: evolvedDna.trendMinPct,
      volSpikeThreshold: evolvedDna.volSpikeThreshold,
      minConfidence: evolvedDna.minConfidence,
    },
    _lastAbsorbed: new Date().toISOString(),
    _absorbedFrom: bestChild.name || bestChild.spec,
    _childWR: Math.round(bestChild.cp.wins / bestChild.cp.trades * 100) + '%',
    _parentWR: Math.round(parentWR * 100) + '%',
    _note: curr._note
  };

  // Only write if real change
  const changed = Math.abs(absorbed.volumeWeight - curr.volumeWeight) > 0.001
    || Math.abs(absorbed.vwapWeight - curr.vwapWeight) > 0.001
    || Math.abs(absorbed.trendWeight - (curr.trendWeight || 1.0)) > 0.001;
  if (!changed) return;

  fs.writeFileSync(DYN_WEIGHTS_PATH, JSON.stringify({ ...curr, ...absorbed }, null, 2));

  // Increment counter in parent PnL
  pnl.genomesAbsorbed = (pnl.genomesAbsorbed || 0) + 1;
  savePnL(pnl);

  const msg = `\n### GENETIC ABSORPTION — ${new Date().toISOString()}:\n`
    + `Elite child: ${bestChild.name || bestChild.spec} | WR: ${absorbed._childWR} (parent: ${absorbed._parentWR})\n`
    + `DNA absorbed: volW=${absorbed.volumeWeight}, vwapW=${absorbed.vwapWeight}, trendW=${absorbed.trendWeight}\n`
    + `Evolved signal DNA: RSI(${evolvedDna.rsiOversold}/${evolvedDna.rsiOverbought}), MACD×${evolvedDna.macdWeight}, trend>${evolvedDna.trendMinPct}%\n`
    + `Absorption rate: 20% delta. ADAN evolves gradually toward winning genome.\n`;
  appendToSoul(msg);

  console.log(C + BOLD + '\n  ◈ DNA ABSORBED from ' + bestChild.name + ' → ADAN evolves' + X);
}

// ── NATURAL CHILD DEATH ───────────────────────────────────────────────────────
// A child that loses all capital dies. It doesn't reappear. It doesn't recover.
// This is selection pressure: bad genomes disappear from the tree.
// Good ones survive, reproduce, and their DNA moves up to ADAN via absorption.
function pruneDeadChildren(pnl) {
  const children = pnl.children || [];
  const alive = [];
  const dead = [];

  for (const ch of children) {
    const childDir = ch.dir || path.join(DIR, 'children', ch.id || ch.spec);
    const cpPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(cpPath)) { alive.push(ch); continue; }
    let cp;
    try { cp = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { alive.push(ch); continue; }

    const fund = cp.fund || 0;
    // Death 1: capital exhausted
    if (fund <= 0 && (cp.trades || 0) >= 5) {
      dead.push({ ...ch, deathReason: 'capital', finalWR: cp.trades > 0 ? Math.round(cp.wins / cp.trades * 100) : 0, finalTrades: cp.trades });
      continue;
    }
    // Death 2: incompetence — but PROTECT children with good real accuracy
    // Check real prediction accuracy from child_learning (resolved shadow bets)
    const specSlug = (ch.spec || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const learnStats = childLearning.learning?.[specSlug] || childLearning.learning?.[ch.spec] || childLearning.learning?.[ch.spec?.toLowerCase()] || {};
    const realResolved = learnStats.totalResolved || 0;
    const realAccuracy = realResolved >= 5 ? Math.round((learnStats.correct || 0) / realResolved * 100) : null;

    // IMMUNITY by Wilson lower bound: protection must be earned with statistical
    // evidence, not a lucky streak. wilson>=0.40 with n>=10 ≈ "real skill plausible".
    const realWilson = realResolved >= 10 ? wilsonLower(learnStats.correct || 0, realResolved) : null;
    if (realWilson !== null && realWilson >= 0.40) {
      console.log(G + '  🛡️ IMMUNE: ' + (ch.name || ch.spec) + ' — wilson:' + realWilson.toFixed(2) + ' (' + realResolved + ' preds) — protected from death' + X);
      alive.push(ch);
      continue;
    }

    // Only kill by intelScore if child has NO proven track record OR bad accuracy
    const slug2 = ch.spec.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const intelPath2 = path.join(INTEL_DIR, slug2 + '.json');
    if (fs.existsSync(intelPath2)) {
      try {
        const intel2 = JSON.parse(fs.readFileSync(intelPath2, 'utf8'));
        const hist2 = intel2.scoreHistory || [];
        if (hist2.length >= 15) {
          const avgScore = hist2.reduce((a, b) => a + b, 0) / hist2.length;
          if (avgScore < 40) {
            // Double check: if real accuracy exists and is decent (>= 40%), spare it
            if (realAccuracy !== null && realAccuracy >= 40) {
              console.log(Y + '  ⚠️ SPARED: ' + (ch.name || ch.spec) + ' — intelScore low (' + avgScore.toFixed(0) + ') but real acc:' + realAccuracy + '% — keeping alive' + X);
              alive.push(ch);
              continue;
            }
            dead.push({ ...ch, deathReason: 'incompetence', avgScore: avgScore.toFixed(0), finalTrades: cp.trades || 0, realAccuracy });
            continue;
          }
        }
      } catch { }
    }
    alive.push(ch);
  }

  if (dead.length === 0) return;

  // Graba la muerte en SOUL.md
  for (const d of dead) {
    const reason = d.deathReason === 'incompetence'
      ? `Avg intel score: ${d.avgScore}/100 over 15 cycles — consistently weak signal.`
      : `Capital exhausted. Final WR: ${d.finalWR}% in ${d.finalTrades} trades.`;
    const msg = `\n### CHILD DIED — ${new Date().toISOString()}:\n`
      + `${d.name || d.spec} (${d.spec}) has died due to ${d.deathReason || 'capital'}.\n`
      + `${reason} DNA: ${JSON.stringify(d.dna || {})}\n`
      + `Natural selection has spoken. This genome did not survive.\n`;
    appendToSoul(msg);
    const cause = d.deathReason === 'incompetence' ? 'incompetent (score avg ' + d.avgScore + ')' : 'capital exhausted';
    console.log(R + BOLD + '\n  ✗ CHILD DIED: ' + (d.name || d.spec) + ' (' + d.spec + ') — ' + cause + X);
  }

  // ── v5: REBIRTH WITH CROSSOVER DNA ──
  // Dead children are reborn with DNA crossed over from top 2 living children by accuracy.
  // For each DNA param: 50% chance from parent1, 50% from parent2, then 15% mutation.
  const reborn = [];

  // Find top 2 living children by REAL accuracy (from child_learning)
  const aliveScored = [];
  for (const ch of alive) {
    const specSlug = (ch.spec || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const learnData = childLearning.learning?.[specSlug] || childLearning.learning?.[ch.spec] || childLearning.learning?.[ch.spec?.toLowerCase()] || {};
    const resolved = learnData.totalResolved || 0;
    const accuracy = resolved >= 3 ? (learnData.correct || 0) / resolved : 0;
    // Wilson as fitness: sample size is already priced in — no log bonus needed
    const score = wilsonLower(learnData.correct || 0, resolved) * 100;
    const cpPath = path.join(ch.dir || path.join(DIR, 'children', ch.id || ch.spec), 'pnl.json');
    let childData = null;
    try { childData = JSON.parse(fs.readFileSync(cpPath, 'utf8')); childData._spec = ch.spec; } catch { }
    aliveScored.push({ ch, score, childData, accuracy });
  }
  aliveScored.sort((a, b) => b.score - a.score);

  const parent1 = aliveScored[0]?.childData || null;
  const parent2 = aliveScored[1]?.childData || parent1; // fallback to self-crossover if only 1 alive

  if (parent1) {
    console.log(`[CROSSOVER] 🧬 Parents: ${parent1._spec} (score:${aliveScored[0]?.score.toFixed(1)}, acc:${(aliveScored[0]?.accuracy * 100).toFixed(0)}%) × ${parent2._spec} (score:${aliveScored[1]?.score?.toFixed(1) || '?'}, acc:${(aliveScored[1]?.accuracy * 100 || 0).toFixed(0)}%)`);
  }

  for (const d of dead) {
    const childDir = d.dir || path.join(DIR, 'children', d.id || d.spec);
    const cpPath = path.join(childDir, 'pnl.json');

    // v5: Crossover DNA from top 2 parents, then mutate 15%
    const dna1 = parent1?.dna || d.dna || {};
    const dna2 = parent2?.dna || d.dna || {};
    const allKeys = new Set([...Object.keys(dna1), ...Object.keys(dna2)]);
    const mutatedDNA = {};
    const MUTATION_RATE = 0.15;
    for (const key of allKeys) {
      if (key === 'generation' || key === 'crossoverFrom' || key === 'isElite') {
        mutatedDNA[key] = dna1[key] ?? dna2[key];
        continue;
      }
      // DIVERSITY FIX: cognitiveStyle/mutation were inherited verbatim from the
      // winning parent, which collapsed the whole population to one style
      // (8 of 9 live children ended up 'bollinger_vol'). Re-sample instead:
      // 60% keep a parent's style, 40% explore a random style.
      if (key === 'cognitiveStyle') {
        const STYLES = ['volume_vwap', 'bollinger_vol', 'rsi_reversal'];
        mutatedDNA[key] = Math.random() < 0.6
          ? (Math.random() < 0.5 ? dna1[key] : dna2[key]) ?? STYLES[Math.floor(Math.random() * STYLES.length)]
          : STYLES[Math.floor(Math.random() * STYLES.length)];
        continue;
      }
      if (key === 'mutation') {
        mutatedDNA[key] = Math.floor(Math.random() * 3); // fresh seed, not inherited
        continue;
      }
      // 50/50 crossover: pick from parent1 or parent2
      const chosen = Math.random() < 0.5 ? (dna1[key] ?? dna2[key]) : (dna2[key] ?? dna1[key]);
      if (typeof chosen !== 'number') { mutatedDNA[key] = chosen; continue; }
      // Apply 15% mutation on top
      const noise = 1 + (Math.random() * 2 - 1) * MUTATION_RATE;
      mutatedDNA[key] = parseFloat((chosen * noise).toFixed(4));
    }
    mutatedDNA.generation = Math.max(dna1.generation || 1, dna2.generation || 1) + 1;
    mutatedDNA.crossoverFrom = [parent1?._spec || 'self', parent2?._spec || 'self'];

    // Reset the child's PnL — fresh start with evolved DNA
    try {
      if (fs.existsSync(cpPath)) {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        cp.trades = 0; cp.wins = 0; cp.losses = 0; cp.net = 0;
        cp.exp = 0;
        cp.dna = mutatedDNA;
        cp.generation = mutatedDNA.generation;
        cp.rebornAt = new Date().toISOString();
        cp.crossoverFrom = mutatedDNA.crossoverFrom;
        fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
      }
    } catch { }

    // Clear the stale intel scoreHistory so it doesn't immediately die again
    const slug = d.spec.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const iPath = path.join(INTEL_DIR, slug + '.json');
    try {
      if (fs.existsSync(iPath)) {
        const intel = JSON.parse(fs.readFileSync(iPath, 'utf8'));
        intel.scoreHistory = []; // Reset — give it a clean slate
        fs.writeFileSync(iPath, JSON.stringify(intel, null, 2));
      }
    } catch { }

    d.status = 'alive'; // REBORN, not dead
    d.dna = mutatedDNA;
    d.generation = mutatedDNA.generation;
    d.rebornAt = new Date().toISOString();
    reborn.push(d);

    const parents = mutatedDNA.crossoverFrom.join(' × ');
    console.log(C + BOLD + '\n  🧬 CHILD REBORN: ' + (d.name || d.spec) + ' → Gen ' + mutatedDNA.generation + ' (crossover: ' + parents + ', mutated 15%)' + X);
    appendToSoul(`\n### CHILD REBORN — ${new Date().toISOString()}:\n${d.name || d.spec} reborn as Gen ${mutatedDNA.generation}. DNA crossover from ${parents} with 15% mutation.\nNatural selection continues. Stronger genome deployed.\n`);
  }

  pnl.children = [...alive, ...reborn];
  savePnL(pnl);
}

// ── TOURNAMENT OF DEATH: at trade 20 kill bottom 50%, redistribute capital ────────────
// Accelerated natural selection: only the most profitable survive the first purge.
// Capital from the dead goes to father's treasury to be redistributed to the living.
function runTournamentOfDeath(pnl) {
  const children = pnl.children || [];
  if (!children.length) return;
  if ((pnl.trades || 0) < TREE_RULES.tournamentTrades) return;
  if (pnl._tournamentDone) return; // solo una vez

  // Read PnL from each child
  const withStats = children.map(ch => {
    const childDir = ch.dir || path.join(DIR, 'children', ch.id || ch.spec);
    const cpPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(cpPath)) return { ...ch, wr: 0, fund: 0 };
    try {
      const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
      const wr = cp.trades > 0 ? cp.wins / cp.trades : 0;
      const wilson = wilsonLower(cp.wins || 0, cp.trades || 0);
      return { ...ch, wr, wilson, fund: cp.fund || 0, trades: cp.trades || 0 };
    } catch { return { ...ch, wr: 0, fund: 0 }; }
  });

  // Only if enough children have trades to compare
  const active = withStats.filter(c => c.trades >= 5);
  if (active.length < 2) return;

  // Sort by Wilson lower bound: a steady 18/30 outranks a lucky 6/8
  active.sort((a, b) => b.wilson - a.wilson);
  const cutoff = Math.ceil(active.length / 2);
  const survivors = active.slice(0, cutoff);
  const losers = active.slice(cutoff);

  if (losers.length === 0) { pnl._tournamentDone = true; savePnL(pnl); return; }

  let recoveredCapital = 0;
  for (const loser of losers) {
    recoveredCapital += loser.fund || 0;
    const childDir = loser.dir || path.join(DIR, 'children', loser.id || loser.spec);
    const cpPath = path.join(childDir, 'pnl.json');
    // Zero out capital — death
    try {
      const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
      cp.fund = 0;
      fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
    } catch { }
    const msg = `\n### TOURNAMENT DEATH — ${new Date().toISOString()}:\n`
      + `${loser.name || loser.spec} eliminated in Tournament of Death (trade ${pnl.trades}).\n`
      + `WR: ${Math.round(loser.wr * 100)}% — missed the cut. Recovered capital: $${(loser.fund || 0).toFixed(2)}.\n`;
    appendToSoul(msg);
    console.log(R + BOLD + '\n  ✗ TOURNAMENT KILL: ' + (loser.name || loser.spec) + ' wilson ' + (loser.wilson * 100).toFixed(0) + '% (WR ' + Math.round(loser.wr * 100) + '%)' + X);
  }

  // Capital redistributed to treasury
  pnl.treasury = parseFloat(((pnl.treasury || 0) + recoveredCapital).toFixed(2));
  pnl._tournamentDone = true;

  // Keep survivors + children without enough trades + dead losers
  const noTrades = withStats.filter(c => !active.find(a => a.id === c.id));

  for (const loser of losers) {
    loser.status = 'dead';
    loser.deathReason = 'tournament';
    loser.deathTime = new Date().toISOString();
  }

  pnl.children = [...survivors, ...noTrades, ...losers];
  savePnL(pnl);

  appendToSoul(`\n### TOURNAMENT RESULT — ${new Date().toISOString()}:\nSurvivors: ${survivors.map(s => (s.name || s.spec) + ' wilson:' + (s.wilson * 100).toFixed(0) + '%').join(', ')}.\nCapital recovered: $${recoveredCapital.toFixed(2)} → treasury.\n`);
  console.log(M + BOLD + '\n  ◈ TOURNAMENT DONE: ' + survivors.length + ' survivors, $' + recoveredCapital.toFixed(2) + ' recovered' + X);
}

// ── HORIZONTAL COMPETITION: multiple variants per archetype ──────────────
// After each trade, evaluates which parent was more accurate and adjusts influence.
function evaluateParentPerformance(pnl, tradeResult) {
  const config = loadConfig();
  if (!config?.mesaRedonda?.competition?.horizontal) return;

  const parents = config.mesaRedonda.parents;
  const decayRate = config.mesaRedonda.competition?.influenceDecayRate || 0.05;

  // Read last intel reports from each parent
  for (const parent of parents) {
    const intelPath = path.join(INTEL_DIR, parent.id + '.json');
    if (!fs.existsSync(intelPath)) continue;

    try {
      const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
      const report = intel.report;
      if (!report) continue;

      let wasAccurate = false;

      if (parent.id === 'apple') {
        // Apple was accurate if opportunity direction matched trade result
        const bullOpp = report.opportunity?.includes('BULL') || report.opportunity?.includes('RECOVERY');
        const bearOpp = report.opportunity?.includes('BEAR') || report.opportunity?.includes('REVERSAL');
        if (tradeResult.side === 'YES' && tradeResult.result === 'WIN' && bullOpp) wasAccurate = true;
        if (tradeResult.side === 'NO' && tradeResult.result === 'WIN' && bearOpp) wasAccurate = true;
        if (tradeResult.result === 'WIN' && !bullOpp && !bearOpp) wasAccurate = true; // neutral = no penalty
      } else if (parent.id === 'snake') {
        // Snake was accurate if viability assessment matched outcome
        if (report.viability === 'HIGH' && tradeResult.result === 'WIN') wasAccurate = true;
        if (report.viability === 'LOW' && tradeResult.result === 'LOSS') wasAccurate = true;
      } else if (parent.id === 'eva') {
        // Eva was accurate if approval was correct
        if (report.approved && tradeResult.result === 'WIN') wasAccurate = true;
        if (!report.approved && tradeResult.result === 'LOSS') wasAccurate = true;
      }

      // Update influence score
      if (!parent.influence) parent.influence = 50;
      if (wasAccurate) {
        parent.influence = Math.min(100, parent.influence + 5);
      } else {
        parent.influence = Math.max(0, parent.influence - 3);
      }

      // Decay toward 50 (regression to mean)
      parent.influence += (50 - parent.influence) * decayRate;
      parent.influence = Math.round(parent.influence * 100) / 100;

      // Update variants scores if they exist
      if (parent.variants && parent.variants.length > 0) {
        for (const variant of parent.variants) {
          if (!variant.score) variant.score = 0;
          // Simple variant tracking — increment best, decrement worst
          if (wasAccurate) variant.score += 1;
          else variant.score -= 1;
        }
        // Eliminate variants with very low scores
        parent.variants = parent.variants.filter(v => v.score > -10);
      }
    } catch { }
  }

  config.mesaRedonda.parents = parents;
  saveConfig(config);
}

// ── VERTICAL COMPETITION: The Path of the Usurper ──────────────────────────
// Gen2 child with WR consistently > archetypal parent in 10+ trades → usurps
function checkUsurperPath(pnl) {
  const config = loadConfig();
  if (!config?.mesaRedonda?.competition?.verticalUsurper) return;

  const minTrades = config.mesaRedonda.competition?.minTradesForChallenge || 10;
  const children = pnl.children || [];
  const parents = config.mesaRedonda.parents;

  for (const child of children) {
    const childDir = child.dir || path.join(DIR, 'children', child.id || child.spec);
    const childPnlPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(childPnlPath)) continue;

    let childPnl;
    try { childPnl = JSON.parse(fs.readFileSync(childPnlPath, 'utf8')); } catch { continue; }

    if ((childPnl.trades || 0) < minTrades) continue;
    const childWR = (childPnl.wins || 0) / childPnl.trades;

    // Check against each parent — find weakest parent
    let weakestParent = null;
    let weakestInfluence = 100;

    for (const parent of parents) {
      const inf = parent.influence ?? 50;
      if (inf < weakestInfluence) {
        weakestInfluence = inf;
        weakestParent = parent;
      }
    }

    // Child must have > 60% WR and the parent must be underperforming (< 35 influence)
    const childWilson = wilsonLower(childPnl.wins || 0, childPnl.trades || 0);
    if (weakestParent && childWilson > 0.50 && weakestInfluence < 35) {
      const oldParentId = weakestParent.id;
      const msg = `\n### USURPATION — ${new Date().toISOString()}:\n`
        + `${child.name || child.spec} (wilson:${Math.round(childWilson * 100)}% WR:${Math.round(childWR * 100)}%) usurped ${weakestParent.name} (influence:${Math.round(weakestInfluence)}).\n`
        + `The dynasty grows stronger through competition.\n`;
      appendToSoul(msg);
      console.log(C + BOLD + '\n  ⚔ USURPATION: ' + (child.name || child.spec) + ' replaced ' + weakestParent.name + X);

      // Replace parent in config with child's DNA becoming the new standard
      weakestParent.usurpedBy = child.name || child.spec;
      weakestParent.usurpedAt = new Date().toISOString();
      weakestParent.influence = 60; // Reset influence on usurpation
      weakestParent.dna = child.dna || {};

      saveConfig(config);
      return; // One usurpation per cycle
    }
  }
}

// ── GRANDCHILD PROMOTION: if grandchild outperforms child parent, the child dies and grandchild moves up ──
// This implements ascending selection: the best genome always moves to the highest level.
// Grandchild (Gen3) → kills Child (Gen2) → Grandchild becomes direct Child of ADAN (Gen2)
// The grandchild inherits the position and can create their own new children.
function promoteEliteGrandchild(pnl) {
  const children = pnl.children || [];
  if (!children.length) return;

  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    const childDir = child.dir || path.join(DIR, 'children', child.id || child.spec);
    const childPnlPath = path.join(childDir, 'pnl.json');
    if (!fs.existsSync(childPnlPath)) continue;

    let childPnl;
    try { childPnl = JSON.parse(fs.readFileSync(childPnlPath, 'utf8')); } catch { continue; }

    const childWR = (childPnl.trades || 0) >= 10 ? (childPnl.wins || 0) / childPnl.trades : null;
    const grandChildren = childPnl.children || [];
    if (!grandChildren.length) continue;

    for (const gc of grandChildren) {
      const gcDir = gc.dir || path.join(childDir, 'children', gc.id || gc.spec);
      const gcPnlPath = path.join(gcDir, 'pnl.json');
      if (!fs.existsSync(gcPnlPath)) continue;

      let gcPnl;
      try { gcPnl = JSON.parse(fs.readFileSync(gcPnlPath, 'utf8')); } catch { continue; }

      const gcWR = (gcPnl.trades || 0) >= 10 ? (gcPnl.wins || 0) / gcPnl.trades : null;
      if (childWR === null || gcWR === null) continue;
      if (gcWR <= childWR + 0.12) continue; // grandchild must outperform parent by >12%

      // PROMOTION: grandchild eliminates parent and moves up to Gen 2
      const msg = `\n### GRANDCHILD PROMOTION — ${new Date().toISOString()}:\n`
        + `${gc.name || gc.spec} (GC·WR:${Math.round(gcWR * 100)}%) eliminated ${child.name || child.spec} (WR:${Math.round(childWR * 100)}%)\n`
        + `${gc.name || gc.spec} promoted to Gen 2 — direct child of ADAN. The best genome survives.\n`
        + `Grandchild DNA: ${JSON.stringify(gc.dna || {})}\n`;
      appendToSoul(msg);
      console.log(C + BOLD + '\n  ◈ PROMOTION: ' + (gc.name || gc.spec) + ' → Gen2 (eliminated parent ' + (child.name || child.spec) + ')' + X);

      // Grandchild becomes direct child of ADAN
      const promoted = {
        ...gc,
        generation: (pnl.generation || 1) + 1,
        dir: gcDir,
        status: 'observing',
        promotedFrom: child.name || child.spec,
        promotedAt: new Date().toISOString()
      };

      // Replaces child with promoted grandchild
      children.splice(i, 1, promoted);
      pnl.children = children;
      savePnL(pnl);
      return; // one promotion per cycle
    }
  }
}

export {
  nameChild, spawnChild, absorbEliteGenome, pruneDeadChildren,
  runTournamentOfDeath, evaluateParentPerformance, checkUsurperPath,
  promoteEliteGrandchild
};