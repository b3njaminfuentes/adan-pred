const fs = require('fs');
const CLOB_BASE = 'https://clob.polymarket.com';
const RATE_LIMIT_MS = 350;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchMarket(conditionId) {
  const url = `${CLOB_BASE}/markets/${conditionId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} para condition_id ${conditionId}`);
  return res.json();
}

function resolveSide(market, side) {
  if (!market.closed) return null;
  const wantedOutcome = side.toUpperCase();
  const token = market.tokens.find((t) => (t.outcome || '').toUpperCase() === wantedOutcome);
  if (!token) return { won: null, reason: 'outcome_no_encontrado' };
  return { won: token.winner ? 1 : 0, reason: null };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) { console.error('Uso: node resolver.cjs /ruta/a/feature_log.json'); process.exit(1); }
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const trades = Array.isArray(data) ? data : data.trades;
  const pendientes = trades.filter((t) => t.resolved === false);
  if (pendientes.length === 0) {
    console.log('Ninguno para resolver.');
    return;
  }

  const marketCache = new Map();
  let resueltosAhora = 0;

  for (const trade of pendientes) {
    const conditionId = trade.condition_id || trade.conditionId;
    const side = trade.side;
    if (!conditionId || !side) continue; // Skip orphaned trades

    try {
      let market = marketCache.get(conditionId);
      if (!market) {
        market = await fetchMarket(conditionId);
        marketCache.set(conditionId, market);
        await sleep(RATE_LIMIT_MS);
      }
      const result = resolveSide(market, side);
      if (result === null) continue;
      if (result.won === null) continue;

      trade.resolved = true;
      trade.won = result.won;
      trade.resolvedAt = new Date().toISOString();
      resueltosAhora++;
    } catch (err) {}
  }

  if (resueltosAhora > 0) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Resueltos ahora: ${resueltosAhora}`);
  } else {
    console.log('Ningún trade nuevo estaba cerrado en Polymarket aún.');
  }
}
main().catch(() => process.exit(1));
