const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const { resolveMenuImage } = require('./themes');
const base = require('./imageBase');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OUT_W = 1080;
const OUT_H = Math.round(OUT_W * 9 / 21);

const escapeXml = base.escapeXml;
const truncate = base.truncate;
const toCircularAvatar = base.toCircularAvatar;
const placeholderAvatar = base.placeholderAvatar;

/**
 * Gera card 21:9 do menu/ping estilo rank: foto do grupo + infos + cores do tema.
 * @param {Object} opts
 * @param {string} opts.title - nome do bot em destaque
 * @param {string} opts.headerEmoji
 * @param {string} opts.groupName
 * @param {string} opts.memberLabel - ex: "128 membros"
 * @param {string} opts.tagline
 * @param {string} opts.footer - texto pequeno no rodapé (ex: "Menu Principal")
 * @param {string} opts.badge - ex: "HELL"
 * @param {Object} opts.theme - entrada do catálogo themes.js (usa .colors)
 * @param {Buffer} opts.avatarRaw - foto do grupo (opcional)
 * @param {boolean} opts.noCover - quando true, pula a foto de fundo + véu escuro
 *   (usado no card amarelo do modo parcial: fundo sólido claro + texto escuro).
 */
async function generateMenuImage({ title, headerEmoji, groupName, memberLabel, tagline, footer, badge, theme, avatarRaw, noCover }) {
    const W = OUT_W;
    const H = OUT_H;
    const C = base.getColors(theme);
    const accent = C.accent;
    const text = C.text;
    const sub = C.sub;

    const AV = 180;
    const avX = 64;
    const avY = Math.round((H - AV) / 2);
    const txX = avX + AV + 40;

    // Anti-overlap: textos nunca invadem a área do badge superior direito.
    const hasBadge = !!String(badge || '').trim();
    const maxX = base.contentMaxX(W, hasBadge);
    const maxW = Math.max(120, maxX - txX);
    const tTitle = base.fitText(title || 'MENU', maxW, 52, { weight: 900, maxChars: 30 });
    const groupLine = `${truncate(groupName || 'Grupo', 34)}${memberLabel ? ` • ${memberLabel}` : ''}`;
    const tGroup = base.fitText(groupLine, maxW, 28, { weight: 700, maxChars: 52 });
    const tTag = base.fitText(tagline || '', maxW, 21, { weight: 400, maxChars: 60 });
    const tFooter = base.fitText(footer || '', maxW, 18, { weight: 400, maxChars: 52 });
    const emojiSafe = escapeXml(headerEmoji || '');

    let buf = await base.cardBase(W, H, C);

    // foto do grupo como fundo esmaecido (pulada no modo noCover: fundo sólido claro)
    if (!noCover) buf = await base.applyCover(buf, avatarRaw, W, H, { opacity: 0.22, scrim: 0.45 });

    const textSvg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${W}" height="8" fill="${accent}"/>
        <circle cx="${avX + AV / 2}" cy="${avY + AV / 2}" r="${AV / 2 + 5}" fill="none" stroke="${accent}" stroke-width="5"/>
        <text x="${txX}" y="150" font-family="sans-serif" font-size="30" font-weight="800" fill="${sub}">${emojiSafe}</text>
        <text x="${txX}" y="205" font-family="sans-serif" font-size="${tTitle.fontSize}" font-weight="900" fill="${text}">${tTitle.text}</text>
        <text x="${txX}" y="255" font-family="sans-serif" font-size="${tGroup.fontSize}" font-weight="700" fill="${text}">${tGroup.text}</text>
        <text x="${txX}" y="305" font-family="sans-serif" font-size="${tTag.fontSize}" fill="${sub}">${tTag.text}</text>
        ${tFooter.text ? `<text x="${txX}" y="345" font-family="sans-serif" font-size="${tFooter.fontSize}" fill="${sub}">${tFooter.text}</text>` : ''}
        ${base.badgeSvg(W, badge, C)}
        <rect x="32" y="${H - 14}" width="${W - 64}" height="2" fill="${accent}" opacity="0.5"/>
    </svg>`;

    buf = await sharp(buf).composite([{ input: Buffer.from(textSvg) }]).png().toBuffer();

    // avatar circular do grupo por cima
    try {
        let circ = null;
        if (avatarRaw && Buffer.isBuffer(avatarRaw)) circ = await toCircularAvatar(avatarRaw, AV);
        if (!circ) circ = await placeholderAvatar(groupName, AV);
        if (circ) buf = await sharp(buf).composite([{ input: circ, left: avX, top: avY }]).png().toBuffer();
    } catch (_) {}

    return await base.finalizeJpeg(buf);
}
function cachePathFor(jid) {
    const hash = crypto.createHash('md5').update(String(jid || '')).digest('hex');
    return path.join(process.cwd(), 'temp', `menu_group_${hash}.jpg`);
}

function isCacheFresh(p) {
    try {
        if (!fs.existsSync(p)) return false;
        const age = Date.now() - fs.statSync(p).mtimeMs;
        return age < CACHE_TTL_MS;
    } catch (_) { return false; }
}

async function getRawGroupBuffer(sock, jid) {
    try {
        const url = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        if (!url) return null;
        const bustUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const resp = await axios.get(bustUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!resp.data) return null;
        const buf = Buffer.from(resp.data);
        if (buf.length < 100) return null;
        return buf;
    } catch (_) { return null; }
}

async function cropTo21x9(buffer) {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    if (w && h) {
        const target = 21 / 9;
        const current = w / h;
        let cropW, cropH, x, y;
        if (current > target) {
            cropH = h;
            cropW = Math.round(h * target);
            x = Math.round((w - cropW) / 2);
            y = 0;
        } else {
            cropW = w;
            cropH = Math.round(w / target);
            x = 0;
            y = Math.round((h - cropH) / 2);
        }
        if (cropW > 0 && cropH > 0) pipeline = pipeline.extract({ left: x, top: y, width: cropW, height: cropH });
    }
    return await pipeline
        .resize({ width: OUT_W, height: OUT_H, fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
}

async function getGroupMenuBuffer(sock, jid) {
    const cp = cachePathFor(jid);
    if (isCacheFresh(cp)) {
        try { return fs.readFileSync(cp); } catch (_) {}
    }
    const raw = await getRawGroupBuffer(sock, jid);
    if (!raw) return null;
    try {
        const out = await cropTo21x9(raw);
        try {
            const dir = path.dirname(cp);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(cp, out);
        } catch (_) {}
        return out;
    } catch (_) { return null; }
}

// Ordem de prioridade:
// 1. Imagem custom do grupo (!imagem) — crop 21:9
// 2. Foto do grupo cortada 21:9 (padrão novo)
// 3. Imagem do tema / aleatória / logo (fallback antigo)
async function resolveMenuImageBuffer(sock, { groupJid, groupMenuImage, themeId }) {
    if (groupMenuImage) {
        try {
            const p = path.isAbsolute(groupMenuImage) ? groupMenuImage : path.join(process.cwd(), groupMenuImage);
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p);
                return await cropTo21x9(raw);
            }
        } catch (_) {}
    }
    if (groupJid && groupJid.endsWith('@g.us') && sock) {
        const grp = await getGroupMenuBuffer(sock, groupJid);
        if (grp) return grp;
    }
    try {
        const fallbackPath = resolveMenuImage({ groupMenuImage: null, themeId });
        if (fallbackPath && fs.existsSync(fallbackPath)) {
            const raw = fs.readFileSync(fallbackPath);
            return await cropTo21x9(raw);
        }
    } catch (_) {}
    return null;
}

module.exports = {
    cropTo21x9,
    getGroupMenuBuffer,
    getRawGroupBuffer,
    resolveMenuImageBuffer,
    generateMenuImage,
    OUT_W,
    OUT_H
};
