// scripts/health_watchdog.js
//
// Runs as its OWN pm2 process, independent of ADAN-MIND. That independence
// is the entire point: if the watchdog lived inside adan-pred.js, the exact
// failure mode from 10-31 jul would have silenced it too — GAUSS's order
// book calls failed for three weeks with zero errors in the logs, because a
// null return just meant "skip this market" to the code reading it. Nothing
// internal to ADAN noticed anything was wrong. A watchdog that trusts only
// ADAN's own instrumentation inherits that blind spot.
//
// So every check here either reads a file ADAN writes as a side effect (not
// a self-report of health) or queries an external source of truth
// (brier.world's own API) that ADAN cannot lie to by being broken.
//
// Checks, each independent:
//   1. Is the ADAN-MIND pm2 process actually online?
//   2. Is health.json fresh? (proves the scan loop is still cycling, not
//      just that the process exists)
//   3. Is the order-book fetch failure rate high? This is the exact
//      signature of the 3-week GAUSS blindness — a near-100% failure rate
//      that produced zero log errors because failures were swallowed as
//      "no candidate this cycle."
//   4. Does brier.world's own API show a recent heartbeat? This is the
//      strongest check: it is impossible to fake from inside a broken ADAN
//      process, because it asks Brier, not ADAN, what it last heard.
//
// Alerts email once per issue, then stay quiet for ALERT_COOLDOWN_MS so a
// persistent problem doesn't spam every 5 minutes. Sends one "recovered"
// email when a previously-alerted issue clears.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import nodemailer from 'nodemailer';

const HOME = process.env.HOME;
const DIR = path.join(HOME, '.adan-pred');
const HEALTH_PATH = path.join(DIR, 'health.json');
const STATE_PATH = path.join(DIR, 'watchdog_state.json');

const BRIER_URL = process.env.BRIER_URL || 'https://brier.world';
const BRIER_BOT_SLUG = process.env.BRIER_BOT_SLUG || 'adan';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const HEALTH_STALE_MS = 15 * 60 * 1000;          // scan should update this often
const BRIER_HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const BOOK_FAIL_RATE_THRESHOLD = 0.8;
const MIN_BOOK_ATTEMPTS_FOR_ALARM = 10;           // don't alarm on a thin sample

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastAlert: {}, lastRecovered: {} }; }
}
function saveState(s) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }
  catch (e) { console.error('[WATCHDOG] state save error:', e.message); }
}
function canAlert(state, key) {
  const last = state.lastAlert[key];
  return !last || (Date.now() - last) > ALERT_COOLDOWN_MS;
}

async function sendEmail(subject, body) {
  const user = process.env.WATCHDOG_GMAIL_USER;
  const pass = process.env.WATCHDOG_GMAIL_APP_PASSWORD;
  const to = process.env.WATCHDOG_ALERT_EMAIL;
  if (!user || !pass || !to) {
    console.error(`[WATCHDOG] Sin configurar (WATCHDOG_GMAIL_USER/APP_PASSWORD/ALERT_EMAIL) — alerta no enviada: ${subject}`);
    return false;
  }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  try {
    await transporter.sendMail({ from: user, to, subject: `[ADAN Watchdog] ${subject}`, text: body });
    console.log('[WATCHDOG] Alerta enviada:', subject);
    return true;
  } catch (e) {
    console.error('[WATCHDOG] Fallo al enviar email:', e.message);
    return false;
  }
}

function isAdanRunning() {
  try {
    const procs = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8' }));
    const p = procs.find(x => x.name === 'ADAN-MIND');
    if (!p) return { known: true, up: false, note: 'proceso ADAN-MIND no existe en pm2' };
    return { known: true, up: p.pm2_env?.status === 'online', note: p.pm2_env?.status || 'desconocido' };
  } catch (e) {
    return { known: false, up: null, note: e.message }; // pm2 itself unreachable — don't alarm on this alone
  }
}

async function checkBrierHeartbeat() {
  try {
    const r = await fetch(`${BRIER_URL}/api/bots/${BRIER_BOT_SLUG}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const bot = await r.json();
    const lastMs = bot.lastHeartbeatAt ? new Date(bot.lastHeartbeatAt).getTime() : null;
    if (!lastMs) return { ok: false, reason: 'brier.world no tiene lastHeartbeatAt registrado' };
    const age = Date.now() - lastMs;
    return { ok: age < BRIER_HEARTBEAT_STALE_MS, reason: `último heartbeat hace ${(age / 60000).toFixed(1)} min` };
  } catch (e) {
    return { ok: false, reason: `no se pudo consultar brier.world: ${e.message}` };
  }
}

async function runCheck() {
  const state = loadState();
  const alerts = [];

  const proc = isAdanRunning();
  if (proc.known && proc.up === false) {
    alerts.push({ key: 'process_down', subject: 'ADAN-MIND no está corriendo', body: `pm2 reporta el proceso como: ${proc.note}` });
  }

  let health = null;
  try { health = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8')); } catch { /* not written yet or unreadable */ }

  if (!health) {
    alerts.push({ key: 'health_missing', subject: 'health.json no existe', body: 'ADAN nunca escribió su archivo de salud — puede estar corriendo una versión sin instrumentar, o nunca completó un ciclo.' });
  } else {
    const age = Date.now() - health.ts;
    if (age > HEALTH_STALE_MS) {
      alerts.push({ key: 'health_stale', subject: 'ADAN dejó de completar ciclos de escaneo', body: `El último health.json tiene ${(age / 60000).toFixed(1)} minutos. El proceso puede estar vivo pero colgado.` });
    } else if (health.gaussBookAttempts >= MIN_BOOK_ATTEMPTS_FOR_ALARM && health.gaussBookFailRate >= BOOK_FAIL_RATE_THRESHOLD) {
      alerts.push({
        key: 'gauss_blind',
        subject: 'GAUSS puede estar ciego otra vez',
        body: `${health.gaussBookFailures}/${health.gaussBookAttempts} intentos de traer el libro de órdenes fallaron en el último ciclo (${(health.gaussBookFailRate * 100).toFixed(0)}%). Es la misma firma del apagón del 10-31 jul: fallas silenciosas al pedir el book, cero errores visibles, cero candidatos generados.`,
      });
    }
  }

  const brier = await checkBrierHeartbeat();
  if (!brier.ok) {
    alerts.push({ key: 'brier_heartbeat', subject: 'brier.world no recibe heartbeat de ADAN', body: brier.reason });
  }

  for (const a of alerts) {
    if (canAlert(state, a.key)) {
      const sent = await sendEmail(a.subject, a.body);
      if (sent) state.lastAlert[a.key] = Date.now();
    }
  }

  // Recovery notice: an issue that was alerted and is no longer firing.
  for (const key of Object.keys(state.lastAlert)) {
    const stillFiring = alerts.some(a => a.key === key);
    if (!stillFiring && state.lastRecovered[key] !== state.lastAlert[key]) {
      const sent = await sendEmail(`Recuperado: ${key}`, 'Este problema ya no se detecta en el chequeo más reciente.');
      if (sent) state.lastRecovered[key] = state.lastAlert[key];
    }
  }

  saveState(state);
  const ts = new Date().toISOString();
  console.log(`[WATCHDOG] ${ts} — ${alerts.length} alerta(s) activa(s)${alerts.length ? ': ' + alerts.map(a => a.key).join(', ') : ''}`);
}

console.log(`[WATCHDOG] iniciado — chequeando cada ${CHECK_INTERVAL_MS / 60000} min`);
runCheck();
setInterval(runCheck, CHECK_INTERVAL_MS);
