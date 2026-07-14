import fs from 'fs';
import path from 'path';

const ADAN_DIR = process.env.ADAN_DIR || '/root/adan-pred';
const JSON_FILE = path.join(ADAN_DIR, 'data', 'feature_log.json');
const JSONL_FILE = path.join(ADAN_DIR, 'data', 'feature_log.jsonl');
const POS_FILE = path.join(process.env.HOME || '/root', '.adan-pred', 'positions.json');

function main() {
  if (!fs.existsSync(JSON_FILE)) {
    console.error(`Source file ${JSON_FILE} does not exist.`);
    process.exit(1);
  }

  // Load positions
  let closedPos = [];
  let openPos = [];
  if (fs.existsSync(POS_FILE)) {
    try {
      const posData = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
      closedPos = posData.closed || [];
      openPos = posData.open || [];
    } catch (e) {
      console.error(`Error reading positions: ${e.message}`);
    }
  }

  console.log(`Loaded ${closedPos.length} closed positions and ${openPos.length} open positions.`);

  // Create maps for quick lookup
  const closedMap = new Map();
  for (const pos of closedPos) {
    if (pos.featureTradeId) {
      closedMap.set(String(pos.featureTradeId), pos);
    }
  }

  const openMap = new Map();
  for (const pos of openPos) {
    if (pos.featureTradeId) {
      openMap.set(String(pos.featureTradeId), pos);
    }
  }

  // Load feature_log.json (array format)
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  } catch (e) {
    console.error(`Error reading feature_log.json: ${e.message}`);
    process.exit(1);
  }

  console.log(`Loaded ${entries.length} entries from feature_log.json.`);

  const jsonlLines = [];
  let resolvedCount = 0;
  let remainingCount = 0;
  let missingMatchCount = 0;

  for (const entry of entries) {
    const entryId = String(entry.id);
    const matchedClosed = closedMap.get(entryId);
    const matchedOpen = openMap.get(entryId);
    const matchedPos = matchedClosed || matchedOpen;

    let conditionId = entry.condition_id || null;
    let marketId = entry.market_id || null;
    let slug = entry.slug || null;
    let side = entry.side || null;

    if (matchedPos) {
      conditionId = matchedPos.conditionId || conditionId;
      marketId = matchedPos.marketId || marketId;
      slug = matchedPos.slug || slug;
      side = matchedPos.side ? (matchedPos.side === 'YES' ? 'Yes' : (matchedPos.side === 'NO' ? 'No' : matchedPos.side)) : side;
    }

    // Write entry row
    const entryRow = {
      type: 'entry',
      id: entry.id,
      ts: entry.timestamp || new Date().toISOString(),
      condition_id: conditionId,
      market_id: marketId,
      slug: slug,
      side: side,
      features: entry.features || {}
    };
    jsonlLines.push(JSON.stringify(entryRow));

    // If resolved or matched to closed position, write resolution row
    if (entry.resolved || (matchedClosed && matchedClosed.resolved)) {
      const won = matchedClosed ? matchedClosed.won : entry.won;
      const pnl = matchedClosed ? matchedClosed.pnl : (entry.pnl || 0);
      const resolutionRow = {
        type: 'resolution',
        id: entry.id,
        ts: (matchedClosed && matchedClosed.resolvedAt) || entry.timestamp || new Date().toISOString(),
        won: won,
        pnl: pnl
      };
      jsonlLines.push(JSON.stringify(resolutionRow));
      resolvedCount++;
    } else if (matchedOpen && matchedOpen.resolved) {
      const resolutionRow = {
        type: 'resolution',
        id: entry.id,
        ts: matchedOpen.resolvedAt || entry.timestamp || new Date().toISOString(),
        won: matchedOpen.won,
        pnl: matchedOpen.pnl || 0
      };
      jsonlLines.push(JSON.stringify(resolutionRow));
      resolvedCount++;
    } else {
      remainingCount++;
      if (!matchedPos) {
        missingMatchCount++;
      }
    }
  }

  // Write new JSONL file
  fs.writeFileSync(JSONL_FILE, jsonlLines.join('\n') + '\n');
  console.log(`Wrote ${jsonlLines.length} lines to ${JSONL_FILE}.`);
  console.log(`Successfully resolved: ${resolvedCount}`);
  console.log(`Remaining unresolved: ${remainingCount}`);
  console.log(`Entries with no matching position: ${missingMatchCount}`);

  // Backup original
  const backupFile = JSON_FILE + '.bak';
  if (fs.existsSync(JSON_FILE)) {
    fs.renameSync(JSON_FILE, backupFile);
    console.log(`Backed up original feature_log.json to ${backupFile}`);
  }
}

main();
