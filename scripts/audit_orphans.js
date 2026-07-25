import fs from 'fs';
import path from 'path';

const ADAN_DIR = process.env.ADAN_DIR || '/Users/benjaminfuentes/adan-pred';
const JSONL_FILE = path.join(ADAN_DIR, 'data', 'feature_log.jsonl');
const POS_FILE = path.join(process.env.HOME || '/Users/benjaminfuentes', '.adan-pred', 'positions.json');
const BAK1 = path.join(ADAN_DIR, 'data', 'feature_log.json.bak');
const BAK2 = path.join(ADAN_DIR, 'data', 'feature_log.json.bak2');
const ORPHAN_LOG = path.join(ADAN_DIR, 'data', 'orphan_resolutions.log');

function loadPositions() {
    try {
        if (fs.existsSync(POS_FILE)) {
            const data = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
            return [...(data.open || []), ...(data.closed || [])];
        }
    } catch (e) {}
    return [];
}

function loadBak(file) {
    try {
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(data) ? data : (data.trades || []);
        }
    } catch (e) {}
    return [];
}

const entries = new Set();
const resolutions = new Map();
const voids = new Set();
const rawLines = [];

if (fs.existsSync(JSONL_FILE)) {
    const lines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
    for (const line of lines) {
        if (!line) continue;
        rawLines.push(line);
        try {
            const row = JSON.parse(line);
            if (row.type === 'entry') entries.add(row.id);
            else if (row.type === 'resolution') resolutions.set(row.id, row);
            else if (row.type === 'void') voids.add(row.id);
        } catch (e) {}
    }
}

const orphans = [];
for (const [id, res] of resolutions.entries()) {
    if (!entries.has(id) && !voids.has(id)) {
        orphans.push(id);
    }
}

if (orphans.length === 0) {
    console.log("No active orphans found.");
    process.exit(0);
}

const allPositions = loadPositions();
const allBaks = [...loadBak(BAK1), ...loadBak(BAK2)];

let backfilled = 0;
let voided = 0;

for (const id of orphans) {
    let trade = allPositions.find(p => p.id === id);
    if (!trade) {
        trade = allBaks.find(p => p.id === id);
    }

    if (trade && trade.marketId && trade.side) {
        // Backfill
        const entryRow = {
            type: 'entry',
            id: id,
            ts: trade.entryTime || trade.ts || new Date().toISOString(),
            condition_id: trade.conditionId || null,
            market_id: trade.marketId || null,
            slug: trade.slug || null,
            side: trade.side || null,
            features: trade.features || { asset: trade.asset, confidence: trade.confidence },
            backfilled: true
        };
        fs.appendFileSync(JSONL_FILE, JSON.stringify(entryRow) + '\n');
        backfilled++;
    } else {
        // Void
        const voidRow = {
            type: 'void',
            id: id,
            ts: new Date().toISOString(),
            reason: 'orphan_missing_entry_data'
        };
        fs.appendFileSync(JSONL_FILE, JSON.stringify(voidRow) + '\n');
        fs.appendFileSync(ORPHAN_LOG, `${new Date().toISOString()} - Voided Orphan ID: ${id}\n`);
        voided++;
    }
}

console.log(`\n=== AUDIT SUMMARY ===`);
console.log(`Total Orphans Processed: ${orphans.length}`);
console.log(`Backfilled (reconstructed): ${backfilled}`);
console.log(`Voided (unrecoverable): ${voided}`);

// Verify
const verifyLines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
const finEntries = new Set();
const finResolutions = new Set();
const finVoids = new Set();
let validBrierEntries = 0;

for (const line of verifyLines) {
    if (!line) continue;
    try {
        const row = JSON.parse(line);
        if (row.type === 'entry') finEntries.add(row.id);
        else if (row.type === 'resolution') finResolutions.add(row.id);
        else if (row.type === 'void') finVoids.add(row.id);
    } catch (e) {}
}

const remainingOrphans = [];
for (const id of finResolutions) {
    if (!finEntries.has(id) && !finVoids.has(id)) {
        remainingOrphans.push(id);
    } else if (finEntries.has(id) && !finVoids.has(id)) {
        validBrierEntries++;
    }
}

console.log(`Remaining orphans: ${remainingOrphans.length}`);
console.log(`Valid completed trades for Brier Score: ${validBrierEntries}`);
console.log(`=====================\n`);
