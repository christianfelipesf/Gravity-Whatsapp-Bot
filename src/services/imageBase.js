'use strict';

/**
 * imageBase.js — módulo central dos cards (menu/rank/apuração/infogrupo/welcome/música).
 *
 * Por que existe:
 * - antes cada `*Image.js` copiava `escapeXml/truncate/toCircularAvatar/placeholderAvatar`
 *   e cada um tratava `theme` de um jeito (música e apuração IGNORAVAM o tema).
 * - layouts usavam `truncate(n)` fixo + `y` fixo, então título longo + badge no canto
 *   direito se sobrepunham, e linhas extras estouravam a altura do card.
 *
 * O que centraliza:
 * 1. Tema: `getColors(theme, fallback)` — merge `theme.colors` sobre defaults.
 * 2. Texto seguro: `escapeXml`, `truncate`, `wrapLines`, `fitToWidth` (anti-overlap).
 * 3. Avatares: `toCircularAvatar`, `placeholderAvatar` (1 implementação).
 * 4. Sharp: `svgToPng`, `applyCover`, `finalizeJpeg`, `cardBase`.
 */

const sharp = require('sharp');

const DEFAULT_COLORS = {
    bg0: '#0f0f14',
    bg1: '#141420',
    headerBg: '#1a1a24',
    accent: '#6c5ce7',
    gold: '#FFD700',
    silver: '#C0C0C0',
    bronze: '#CD7F32',
    row: '#1e1e2a',
    rowAlt: '#17171f',
    text: '#ffffff',
    sub: '#a0a0b2',
    badgeText: '#ffffff',
    green: '#22c55e',
    red: '#ef4444'
};

// Layout padrão do badge no canto superior direito (cards 1080px).
const BADGE = { w: 212, h: 48, marginRight: 48, top: 40, gap: 24 };

function escapeXml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function truncate(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** Quebra texto em linhas sem cortar palavras. */
function wrapLines(s, maxChars, maxLines) {
    const words = String(s || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (next.length <= maxChars) {
            cur = next;
        } else {
            if (cur) lines.push(cur);
            cur = w.length > maxChars ? w.slice(0, Math.max(0, maxChars - 1)) + '…' : w;
            if (lines.length >= maxLines) break;
        }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines.slice(0, Math.max(0, maxLines));
}

/**
 * Merge de cores: defaults <- fallback <- theme.colors.
 * Garante que todo card tenha as chaves que usa, mesmo com tema parcial.
 */
function getColors(theme, fallback) {
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    const tc = theme && theme.colors && typeof theme.colors === 'object' ? theme.colors : {};
    return { ...DEFAULT_COLORS, ...fb, ...tc };
}

/** Largura máxima do texto antes do badge (para não ficar por cima). */
function contentMaxX(W, hasBadge, rightPad) {
    const pad = Number.isFinite(Number(rightPad)) ? Number(rightPad) : 64;
    if (hasBadge) return W - BADGE.marginRight - BADGE.w - BADGE.gap;
    return W - pad;
}

/**
 * Estimativa conservadora da largura do texto em px (sans-serif).
 * Evita medir com canvas: usa fator por peso + margem de segurança.
 */
function estimateWidth(text, fontSize, weight) {
    const s = String(text || '');
    if (!s) return 0;
    const w = Number(weight) || 0;
    const factor = w >= 900 ? 0.62 : w >= 800 ? 0.60 : w >= 700 ? 0.58 : 0.52;
    // Emojis ocupam ~1 célula cheia: conta 0.4 extra por codepoint fora do ASCII.
    let wide = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp > 0x2500) wide++;
    }
    return s.length * fontSize * factor + wide * fontSize * 0.4;
}

/**
 * Ajusta texto para caber em maxWidthPx:
 * - primeiro trunca pelos caracteres que cabem,
 * - se mesmo com 4 chars estourar, reduz fontSize até minSize.
 * Retorna { text (NÃO escapado), fontSize }.
 */
function fitToWidth(raw, maxWidthPx, fontSize, opts) {
    const o = opts || {};
    const minSize = Math.max(10, Number(o.minSize) || Math.round(fontSize * 0.7));
    const weight = o.weight || 700;
    let size = Math.max(minSize, Math.round(Number(fontSize) || 24));
    let s = String(raw == null ? '' : raw);
    if (maxWidthPx == null || !(maxWidthPx > 0)) return { text: s, fontSize: size };
    const maxCharsHard = Number(o.maxChars) || 0;

    const fits = (t, fs) => estimateWidth(t, fs, weight) <= maxWidthPx;
    // Teto de chars pela largura (evita loop longo em strings gigantes).
    const capByWidth = Math.max(4, Math.floor(maxWidthPx / (size * 0.55)));
    let cap = maxCharsHard > 0 ? Math.min(maxCharsHard, capByWidth) : capByWidth;
    if (s.length > cap) s = truncate(s, cap);
    let guard = 0;
    while (!fits(s, size) && guard++ < 12) {
        if (s.length > 5) {
            s = truncate(s, Math.max(4, s.length - 2));
        } else if (size > minSize) {
            size = Math.max(minSize, size - 2);
        } else {
            break;
        }
    }
    return { text: s, fontSize: size };
}

/** Texto já escapado + ajustado à largura (atalho mais usado nos headers). */
function fitText(raw, maxWidthPx, fontSize, opts) {
    const r = fitToWidth(raw, maxWidthPx, fontSize, opts);
    return { text: escapeXml(r.text), fontSize: r.fontSize };
}

async function toCircularAvatar(buf, size) {
    const sz = Math.max(1, Math.round(Number(size) || 56));
    try {
        if (!Buffer.isBuffer(buf) || buf.length < 100) return null;
        const resized = await sharp(buf, { failOn: 'none' }).rotate().resize(sz, sz, { fit: 'cover' }).png().toBuffer();
        const mask = `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><circle cx="${sz / 2}" cy="${sz / 2}" r="${sz / 2}" fill="white"/></svg>`;
        return await sharp(resized).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
    } catch (_) { return null; }
}

async function placeholderAvatar(name, size) {
    const sz = Math.max(1, Math.round(Number(size) || 56));
    const clean = String(name || '').replace(/^@+/, '').trim();
    const m = clean.match(/[\p{L}\p{N}]/u);
    const letter = (m ? m[0] : '?').toUpperCase();
    let hash = 0;
    const src = String(name || '?');
    for (let i = 0; i < src.length; i++) hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
    const hues = [260, 200, 160, 340, 30, 45, 280];
    const hue = hues[hash % hues.length];
    const svg = `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><circle cx="${sz / 2}" cy="${sz / 2}" r="${sz / 2}" fill="hsl(${hue}, 68%, 48%)"/><text x="${sz / 2}" y="${sz / 2 + Math.round(sz * 0.13)}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(sz * 0.5)}" font-weight="800" fill="white">${escapeXml(letter)}</text></svg>`;
    try { return await sharp(Buffer.from(svg)).png().toBuffer(); } catch (_) { return null; }
}

async function svgToPng(svgString, density) {
    return await sharp(Buffer.from(String(svgString)), { density: Number(density) || 144 }).png().toBuffer();
}

/** Fundo em gradiente do tema. */
async function cardBase(W, H, C) {
    const bg0 = (C && C.bg0) || DEFAULT_COLORS.bg0;
    const bg1 = (C && C.bg1) || DEFAULT_COLORS.bg1;
    const baseSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg0}"/><stop offset="100%" stop-color="${bg1}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/></svg>`;
    return await sharp(Buffer.from(baseSvg)).png().toBuffer();
}

/** Aplica foto de fundo esmaecida + véu escuro (padrão menu/welcome/música). */
async function applyCover(buf, coverRaw, W, H, opts) {
    const o = opts || {};
    if (!coverRaw || !Buffer.isBuffer(coverRaw)) return buf;
    try {
        const opacity = Number.isFinite(Number(o.opacity)) ? Number(o.opacity) : 0.25;
        const scrim = Number.isFinite(Number(o.scrim)) ? Number(o.scrim) : 0.45;
        const cover = await sharp(coverRaw, { failOn: 'none' }).rotate().resize({ width: W, height: H, fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        let out = await sharp(buf).composite([{ input: cover, opacity }]).png().toBuffer();
        const scrimSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="black" opacity="${scrim}"/></svg>`;
        out = await sharp(out).composite([{ input: Buffer.from(scrimSvg) }]).png().toBuffer();
        return out;
    } catch (_) { return buf; }
}

async function finalizeJpeg(buf, width) {
    const w = Math.max(1, Math.round(Number(width) || 1080));
    return await sharp(buf).resize({ width: w }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
}

/** SVG do badge superior direito (ou '' se sem label). */
function badgeSvg(W, label, C) {
    const s = String(label || '').trim();
    if (!s) return '';
    const accent = (C && C.accent) || DEFAULT_COLORS.accent;
    const fg = (C && (C.badgeText || C.text)) || '#fff';
    const x = W - BADGE.marginRight - BADGE.w;
    return `<rect x="${x}" y="${BADGE.top}" width="${BADGE.w}" height="${BADGE.h}" rx="24" fill="${accent}"/><text x="${x + BADGE.w / 2}" y="${BADGE.top + 32}" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="800" fill="${fg}">${escapeXml(truncate(s, 14))}</text>`;
}

/**
 * Resolve tema do grupo a partir de utils (getThemeForJid) — helper p/ comandos.
 * Nunca joga exceção; retorna null se não der.
 */
function resolveGroupTheme(utils, from) {
    try {
        const id = typeof utils?.getThemeForJid === 'function' ? utils.getThemeForJid(from) : 'default';
        return require('./themes').getTheme(id);
    } catch (_) { return null; }
}

module.exports = {
    DEFAULT_COLORS,
    BADGE,
    escapeXml,
    truncate,
    wrapLines,
    getColors,
    contentMaxX,
    estimateWidth,
    fitToWidth,
    fitText,
    toCircularAvatar,
    placeholderAvatar,
    svgToPng,
    cardBase,
    applyCover,
    finalizeJpeg,
    badgeSvg,
    resolveGroupTheme
};
