// adan-llm-router.js — v9.0 DISTRIBUTED INTELLIGENCE
// Inverted pyramid: Flash models (250K TPM) are primary, Gemma (15K TPM) is reserve
// Load distributed across ALL available free models

import { GoogleGenerativeAI } from '@google/generative-ai';
import { quota } from './src/core/quota_manager.js';

let _genAI = null;
function getGenAI() {
    if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return _genAI;
}

const MODELS = {
    // === PRIMARY FLEET (250K TPM each) ===
    WORKHORSE: 'gemini-3.1-flash-lite',           // 15 RPM, 250K TPM, 500 RPD — PRIMARY BRAIN
    FAST: 'gemini-3.5-flash',                     // 5 RPM, 250K TPM, 20 RPD — FALLBACK #1 (replaces dead 2.0-flash)
    SNIPER: 'gemini-2.5-flash',                   // 5 RPM, 250K TPM, 20 RPD — CRITICAL ONLY
    LITE: 'gemini-2.5-flash-lite',                // 10 RPM, 250K TPM, 20 RPD — OVERFLOW
    FLASH3: 'gemini-3-flash',                     // 5 RPM, 250K TPM, 20 RPD — OVERFLOW #2
    // === RESERVE FLEET (Gemma 4 — Unlimited TPM, 1.5K RPD each) ===
    GEMMA_31B: 'gemma-4-31b',                     // 15 RPM, Unlimited TPM, 1.5K RPD
    GEMMA_26B: 'gemma-4-26b',                     // 15 RPM, Unlimited TPM, 1.5K RPD
    // === EMBEDDINGS ===
    EMBEDDER: 'gemini-embedding-002',             // 100 RPM, 30K TPM, 1K RPD
    EMBEDDER_LEGACY: 'gemini-embedding-001',
};

// Round-robin counter for load distribution
let _callCounter = 0;

async function withRetry(fn, maxRetries = 3, label = '') {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable = err.message?.includes('429') || err.message?.includes('Resource Exhausted') || err.message?.includes('503');
            if (isRetryable && i < maxRetries - 1) {
                const wait = Math.pow(2, i + 1) * 1000;
                console.warn(`[ROUTER] 429/503 en ${label}. Wait ${wait}ms...`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            if (isRetryable) { console.error(`[ROUTER] ${label} agotado. Fallback SKIP.`); return null; }
            throw err;
        }
    }
}

// ── HELPER: Call any model by name with fallback chain ──
async function callModel(modelName, prompt, options = {}, label = '') {
    const model = getGenAI().getGenerativeModel({
        model: modelName,
        generationConfig: {
            temperature: options.temperature ?? 0.1,
            topP: options.topP ?? 0.9,
            maxOutputTokens: options.maxTokens ?? 1024,
        }
    });
    const result = await withRetry(() => model.generateContent(prompt), 3, label || modelName);
    if (!result) return null;

    const usage = result.response.usageMetadata;
    const tokens = usage ? usage.promptTokenCount : Math.round(prompt.length / 4);
    console.log(`[ROUTER] ${label || modelName}: ${tokens} tokens${usage ? '' : ' (est)'}`);
    return result.response.text();
}

// ── PRIMARY: Distributed call across available fleet ──
// Priority: Gemma 4 31B (Unlimited TPM, 1.5K RPD) → Gemma 4 26B → Workhorse (3.1 Flash Lite) → Flash3 → Lite → Flash3.5
async function callDistributed(prompt, options = {}) {
    _callCounter++;

    // Route #1: Gemma 4 31B (1.5K RPD, 15 RPM, Unlimited TPM) — THE HEAVY BRAIN
    if (quota.canUseGemma()) {
        const r1 = await callModel(MODELS.GEMMA_31B, prompt, options, '🧠 Gemma4-31B');
        if (r1) { quota.consumeGemma(); return r1; }
    }

    // Route #2: Gemma 4 26B (1.5K RPD, 15 RPM, Unlimited TPM) — SECONDARY BRAIN
    if (quota.canUseGemma()) {
        const r2 = await callModel(MODELS.GEMMA_26B, prompt, options, '🧒 Gemma4-26B');
        if (r2) { quota.consumeGemma(); return r2; }
    }

    // Route #3: Workhorse — Gemini 3.1 Flash Lite (500 RPD, 15 RPM, 250K TPM) — FAST FALLBACK
    if (quota.canUseWorkhorse()) {
        const result = await callModel(MODELS.WORKHORSE, prompt, options, '🐎 Workhorse-3.1');
        if (result) { quota.consumeWorkhorse(); return result; }
    }

    // Route #4: Gemini 3 Flash (20 RPD, 250K TPM)
    if (quota.canUseFlash3()) {
        const r4 = await callModel(MODELS.FLASH3, prompt, options, '🔥 Flash-3');
        if (r4) { quota.consumeFlash3(); return r4; }
    }

    // Route #5: Gemini 2.5 Flash Lite (20 RPD, 250K TPM)
    if (quota.canUseLite()) {
        const r5 = await callModel(MODELS.LITE, prompt, options, '💡 Lite-2.5');
        if (r5) { quota.consumeLite(); return r5; }
    }

    // Route #6: Gemini 3.5 Flash — last resort
    const r6 = await callModel(MODELS.FAST, prompt, options, '⚡ Flash-3.5-lastresort');
    if (r6) return r6;

    console.error('[ROUTER] ALL MODELS EXHAUSTED — no response possible');
    return null;
}

// ── callGemma: Directly calls distributed now that Gemma is primary ──
async function callGemma(prompt, options = {}) {
    return callDistributed(prompt, options);
}

// ── callFast: Quick route — Workhorse first, then distributed ──
async function callFast(prompt, options = {}) {
    // Workhorse (3.1 Flash Lite) is the fastest available with quota
    if (quota.canUseWorkhorse()) {
        const result = await callModel(MODELS.WORKHORSE, prompt, options, '🐎 Fast-Workhorse');
        if (result) { quota.consumeWorkhorse(); return result; }
    }
    return callDistributed(prompt, options);
}

// ── callGemini: Sniper for critical decisions (20 RPD) ──
async function callGemini(prompt, reason = 'unknown', options = {}) {
    if (!quota.canUseGemini()) return callDistributed(prompt, options);
    if (quota.isSaverMode() && reason !== 'dream_mode') return callDistributed(prompt, options);

    const result = await callModel(MODELS.SNIPER, prompt, { ...options, maxTokens: options.maxTokens ?? 2048 }, '🎯 Sniper-2.5');
    if (!result) return callDistributed(prompt, options);

    quota.consumeGemini(reason);
    return result;
}

export async function getEmbedding(text) {
    if (!quota.canEmbed()) return null;
    // Use Gemini Embedding 2 (newer, better) with legacy fallback
    const model = getGenAI().getGenerativeModel({ model: MODELS.EMBEDDER });
    const result = await withRetry(() => model.embedContent(text.slice(0, 2000)), 3, 'Embed-v2');
    if (!result) {
        // Fallback to legacy embedder
        const legacy = getGenAI().getGenerativeModel({ model: MODELS.EMBEDDER_LEGACY });
        const r2 = await withRetry(() => legacy.embedContent(text.slice(0, 2000)), 3, 'Embed-legacy');
        if (!r2) return null;
        quota.consumeEmbed();
        return r2.embedding.values;
    }
    quota.consumeEmbed();
    return result.embedding.values;
}

export async function routeLLM({ prompt, systemPrompt, userPrompt, weight = 'Heavy', reason = 'cycle' }) {
    // If systemPrompt/userPrompt provided, join them
    let finalPrompt = prompt;
    if (!finalPrompt && systemPrompt && userPrompt) {
        finalPrompt = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;
    }

    // ── SAFETY TIMEOUT: Never hang the main loop ──
    const LLM_TIMEOUT_MS = 60_000;
    const withTimeout = (promise) => Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[LLM TIMEOUT] ${reason}/${weight} exceeded ${LLM_TIMEOUT_MS/1000}s`)), LLM_TIMEOUT_MS)
        )
    ]);

    try {
        // v9.0: Distributed Intelligence — Flash fleet is primary (250K TPM)
        // Gemma (15K TPM) is RESERVE only
        switch (weight) {
            case 'Heavy':
                return await withTimeout(callGemini(finalPrompt, reason));
            case 'Dream':
                return await withTimeout(callGemini(finalPrompt, 'dream_mode', { maxTokens: 2048, temperature: 0.3 }));
            case 'Light':
                return await withTimeout(callDistributed(finalPrompt, { temperature: 0.05 }));
            case 'UltraLight':
                return await withTimeout(callFast(finalPrompt, { temperature: 0.1, maxTokens: 512 }));
            case 'Child':
                // For children, try the faster/lighter Gemma 4 26B first
                if (quota.canUseGemma()) {
                    const r = await withTimeout(callModel(MODELS.GEMMA_26B, finalPrompt, { temperature: 0.05 }, '🧒 Gemma4-26B'));
                    if (r) { quota.consumeGemma(); return r; }
                }
                return await withTimeout(callDistributed(finalPrompt, { temperature: 0.05 }));
            default:
                return await withTimeout(callDistributed(finalPrompt));
        }
    } catch (e) {
        console.error(`[ROUTER] ${e.message}`);
        return null;
    }
}

export function parseAIResponse(text) {
    if (!text) return null;
    try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        if (cleaned.startsWith('{') || cleaned.startsWith('[')) return JSON.parse(cleaned);
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        return { raw: text };
    } catch { return { raw: text }; }
}

export { callGemma, callGemini, callFast, callDistributed, callModel, MODELS };
