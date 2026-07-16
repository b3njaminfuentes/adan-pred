import fs from 'fs';
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
  if (!filePath) { console.error('Uso: node resolver.js /ruta/a/feature_log.jsonl'); process.exit(1); }
  
  if (!fs.existsSync(filePath)) {
    console.log('Archivo no existe.'); return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const trades = new Map();
  for (const line of lines) {
    if (!line) continue;
    try {
        const row = JSON.parse(line);
        if (row.type === 'entry') trades.set(row.id, { ...row, resolved: false });
        else if (row.type === 'resolution') {
            const t = trades.get(row.id);
            if (t) t.resolved = true;
        }
    } catch(e) {}
  }

  const pendientes = Array.from(trades.values()).filter(t => !t.resolved);
  if (pendientes.length === 0) return;

  const marketCache = new Map();
  let resueltosAhora = 0;

  for (const trade of pendientes) {
    const conditionId = trade.condition_id || trade.conditionId;
    const side = trade.side;
    if (!conditionId || !side) continue;

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

      const resolutionRow = {
          type: 'resolution',
          id: trade.id,
          ts: new Date().toISOString(),
          won: result.won,
          // This log format never records stake/entryPrice, so a real dollar PnL
          // can't be computed here. null (not 0) so downstream `t.pnl || 0` reducers
          // don't silently treat unresolved-PnL trades as confirmed break-even.
          pnl: null
      };
      fs.appendFileSync(filePath, JSON.stringify(resolutionRow) + '\n');
      resueltosAhora++;
    } catch (err) {}
  }

  if (resueltosAhora > 0) {
    console.log(`Resueltos ahora: ${resueltosAhora}`);
  } else {
    console.log('Ninguno resuelto aún.');
  }
}
main().catch(() => process.exit(1));
