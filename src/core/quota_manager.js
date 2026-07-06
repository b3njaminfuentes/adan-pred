// Gestiona los rate limits de Google AI Studio
// Gemma 4: 1,500 RPD, 15 RPM | Gemini Flash: 20-500 RPD | Embeddings: 1,000 RPD

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.env.HOME, '.adan-pred');
const QUOTA_FILE = path.join(DIR, 'quota.json');

const DEFAULTS = {
    date: '',
    gemma: { used: 0, limit: 1480 },
    gemini: { used: 0, limit: 18 },      // Gemini 2.5 Flash: 20 RPD - reservamos 2
    workhorse: { used: 0, limit: 480 },   // Gemini 3.1 Flash Lite: 500 RPD - margen 20
    lite: { used: 0, limit: 18 },         // Gemini 2.5 Flash Lite: 20 RPD - margen 2
    flash3: { used: 0, limit: 18 },       // Gemini 3 Flash: 20 RPD - margen 2
    embed: { used: 0, limit: 950 },       // Embeddings: 1000 RPD - margen 50
    rpm: { gemma: 0, workhorse: 0, lastMinute: 0 }, // RPM tracking
    lastDream: null,
    // v4.0: Per-category LLM budget tracking
    categories: {
        crypto:   { used: 0, limit: 10000 },
        politics: { used: 0, limit: 1500 },
        sports:   { used: 0, limit: 1500 },
        macro:    { used: 0, limit: 500 },
        events:   { used: 0, limit: 1500 },
    }
};

export class QuotaManager {
    constructor() {
        this._load();
    }

    _today() {
        return new Date().toISOString().split('T')[0];
    }

    _load() {
        try {
            if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
            if (fs.existsSync(QUOTA_FILE)) {
                const raw = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
                if (raw.date !== this._today()) {
                    // Reset diario — nueva fecha, nuevas cuotas
                    this.q = { ...JSON.parse(JSON.stringify(DEFAULTS)), date: this._today(), lastDream: raw.lastDream || null };
                } else {
                    this.q = raw;
                }
            } else {
                this.q = { ...DEFAULTS, date: this._today() };
            }
        } catch {
            this.q = { ...DEFAULTS, date: this._today() };
        }
        this._save();
    }

    _save() {
        if (this._saving) return;
        this._saving = true;
        try {
            const tmp = QUOTA_FILE + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(this.q, null, 2));
            fs.renameSync(tmp, QUOTA_FILE);
        } finally {
            this._saving = false;
        }
    }

    // ── GEMMA (Cerebro 24/7) ─────────────────────────────────────────────────
    canUseGemma() {
        this._checkRpmReset();
        return this.q.gemma.used < this.q.gemma.limit && this.q.rpm.gemma < 13; // 15 RPM, margen 2
    }

    consumeGemma() {
        this.q.gemma.used++;
        this.q.rpm.gemma++;
        this._save();
        return this.q.gemma.used;
    }

    // ── WORKHORSE: Gemini 3.1 Flash Lite (500 RPD, 15 RPM, 250K TPM) ──────
    canUseWorkhorse() {
        this._checkRpmReset();
        if (!this.q.workhorse) this.q.workhorse = { used: 0, limit: 480 };
        if (!this.q.rpm.workhorse) this.q.rpm.workhorse = 0;
        return this.q.workhorse.used < this.q.workhorse.limit && this.q.rpm.workhorse < 13;
    }

    consumeWorkhorse() {
        if (!this.q.workhorse) this.q.workhorse = { used: 0, limit: 480 };
        if (!this.q.rpm.workhorse) this.q.rpm.workhorse = 0;
        this.q.workhorse.used++;
        this.q.rpm.workhorse++;
        this._save();
        return this.q.workhorse.used;
    }

    // ── LITE: Gemini 2.5 Flash Lite (20 RPD, 10 RPM, 250K TPM) ────────────
    canUseLite() {
        if (!this.q.lite) this.q.lite = { used: 0, limit: 18 };
        return this.q.lite.used < this.q.lite.limit;
    }

    consumeLite() {
        if (!this.q.lite) this.q.lite = { used: 0, limit: 18 };
        this.q.lite.used++;
        this._save();
        return this.q.lite.used;
    }

    // ── FLASH3: Gemini 3 Flash (20 RPD, 5 RPM, 250K TPM) ──────────────────
    canUseFlash3() {
        if (!this.q.flash3) this.q.flash3 = { used: 0, limit: 18 };
        return this.q.flash3.used < this.q.flash3.limit;
    }

    consumeFlash3() {
        if (!this.q.flash3) this.q.flash3 = { used: 0, limit: 18 };
        this.q.flash3.used++;
        this._save();
        return this.q.flash3.used;
    }

    // ── GEMINI 2.5 Flash (Francotirador) ───────────────────────────────────
    canUseGemini() {
        return this.q.gemini.used < this.q.gemini.limit;
    }

    // Modo ahorro: cuando quedan solo 3 tiros, solo usarlos para Dream Mode
    isSaverMode() {
        return this.q.gemini.used >= (this.q.gemini.limit - 3);
    }

    consumeGemini(reason = 'unknown') {
        if (!this.canUseGemini()) {
            throw new Error(`[QUOTA] Gemini agotado. ${this.q.gemini.used}/${this.q.gemini.limit} usados. Razón intentada: ${reason}`);
        }
        this.q.gemini.used++;
        this._save();
        console.log(`[QUOTA] 🎯 Gemini disparado (${this.q.gemini.used}/${this.q.gemini.limit}) — ${reason}`);
        return this.q.gemini.used;
    }

    // ── EMBEDDINGS ───────────────────────────────────────────────────────────
    canEmbed() {
        return this.q.embed.used < this.q.embed.limit;
    }

    consumeEmbed() {
        this.q.embed.used++;
        this._save();
        return this.q.embed.used;
    }

    // ── CATEGORY BUDGET (v4.0) ────────────────────────────────────────────────
    canUseCategory(category) {
        if (!this.q.categories) this.q.categories = { ...DEFAULTS.categories };
        const cat = this.q.categories[category];
        if (!cat) return true; // unknown category = no limit
        return cat.used < cat.limit;
    }

    consumeCategory(category) {
        if (!this.q.categories) this.q.categories = { ...DEFAULTS.categories };
        if (!this.q.categories[category]) {
            this.q.categories[category] = { used: 0, limit: 1500 };
        }
        this.q.categories[category].used++;
        this._save();
        return this.q.categories[category].used;
    }

    categoryStatus() {
        if (!this.q.categories) return {};
        const result = {};
        for (const [cat, data] of Object.entries(this.q.categories)) {
            result[cat] = { used: data.used || 0, limit: data.limit || 0, str: `${data.used}/${data.limit}` };
        }
        return result;
    }

    // ── DREAM MODE ───────────────────────────────────────────────────────────
    shouldRunDream() {
        if (!this.q.lastDream) return true;
        const last = new Date(this.q.lastDream);
        const now = new Date();
        const hoursSince = (now - last) / (1000 * 60 * 60);
        return hoursSince >= 23; // Una vez cada 23h (no exactamente medianoche para evitar conflictos)
    }

    markDreamRun() {
        this.q.lastDream = new Date().toISOString();
        this._save();
    }

    // ── RPM RESET ────────────────────────────────────────────────────────────
    _checkRpmReset() {
        const now = Date.now();
        if (now - this.q.rpm.lastMinute > 60000) {
            this.q.rpm.gemma = 0;
            this.q.rpm.workhorse = 0;
            this.q.rpm.lastMinute = now;
            this._save();
        }
    }

    // ── STATUS ───────────────────────────────────────────────────────────────
    status() {
        const wh = this.q.workhorse || { used: 0, limit: 480 };
        const lt = this.q.lite || { used: 0, limit: 18 };
        const f3 = this.q.flash3 || { used: 0, limit: 18 };
        return {
            date: this.q.date,
            workhorse: `${wh.used}/${wh.limit} RPD (3.1 Flash Lite — PRIMARY)`,
            flash20: 'unlimited (2.0 Flash — FALLBACK)',
            gemini: `${this.q.gemini.used}/${this.q.gemini.limit} RPD ${this.isSaverMode() ? '⚠️ SAVER MODE' : '✅'} (2.5 Flash — SNIPER)`,
            lite: `${lt.used}/${lt.limit} RPD (2.5 Flash Lite — OVERFLOW)`,
            flash3: `${f3.used}/${f3.limit} RPD (3 Flash — OVERFLOW)`,
            gemma: `${this.q.gemma.used}/${this.q.gemma.limit} RPD (Gemma 4 — RESERVE)`,
            embed: `${this.q.embed.used}/${this.q.embed.limit} RPD`,
            lastDream: this.q.lastDream,
            dreamReady: this.shouldRunDream(),
            categories: this.categoryStatus()
        };
    }
}

export const quota = new QuotaManager();
