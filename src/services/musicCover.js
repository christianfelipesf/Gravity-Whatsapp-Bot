// ============================================================
// Capa 21:9 da música (!play) estilo !menu: thumb do YouTube de
// fundo + avatar circular + título, duração, fonte e canal.
// ============================================================
const axios = require('axios');
const sharp = require('sharp');
const base = require('./imageBase');

const OUT_W = 1080;
const OUT_H = Math.round(OUT_W * 9 / 21); // 463

const escapeXml = base.escapeXml;
const truncate = base.truncate;

function thumbUrlFromVideo(video) {
    try {
        if (!video) return null;
        if (video.thumbnail) return typeof video.thumbnail === 'string' ? video.thumbnail : video.thumbnail.url;
        if (video.image) return typeof video.image === 'string' ? video.image : video.image.url;
        if (video.thumbnails && Array.isArray(video.thumbnails) && video.thumbnails.length) {
            const last = video.thumbnails[video.thumbnails.length - 1];
            if (last && last.url) return last.url;
        }
        if (video.videoId) return `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
        if (video.id) return `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`;
        if (video.url) {
            const m = String(video.url).match(/(?:v=|\/)([A-Za-z0-9_-]{11})/);
            if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
        }
    } catch (_) {}
    return null;
}

async function fetchThumbRaw(video) {
    const url = thumbUrlFromVideo(video);
    if (!url) return null;
    try {
        const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            maxContentLength: 8 * 1024 * 1024,
            maxBodyLength: 8 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!resp.data) return null;
        const buf = Buffer.from(resp.data);
        if (buf.length < 100) return null;
        return buf;
    } catch (_) { return null; }
}

async function toCircularAvatar(buf, size) {
    return base.toCircularAvatar(buf, size);
}

async function placeholderAvatar(size) {
    return base.placeholderAvatar('♪ música', size);
}

async function generateMusicCover({ title, duration, source, channelName, botName, thumbRaw, theme }) {
    const W = OUT_W;
    const H = OUT_H;
    // Antes ignorava o tema (cores fixas rosa). Agora usa o tema do grupo,
    // com fallback para a identidade antiga quando sem tema.
    const C = base.getColors(theme, { bg0: '#0f0f14', bg1: '#1a1030', accent: '#e1306c', text: '#ffffff', sub: '#c9c9d6' });
    const accent = C.accent;
    const text = C.text;
    const sub = C.sub;

    const AV = 190;
    const avX = 64;
    const avY = Math.round((H - AV) / 2);
    const txX = avX + AV + 40;

    // Badge fixo "MÚSICA": reserva a área direita (anti-overlap).
    const maxW = Math.max(120, base.contentMaxX(W, true) - txX);
    const tTitle = base.fitText(title || 'Música', maxW, 40, { weight: 900, maxChars: 40 });
    const tMeta = base.fitText(`⏱ ${duration || '--:--'} • ▶ ${source || 'YouTube'}`, maxW, 28, { weight: 700, maxChars: 52 });
    const tChannel = base.fitText(`📢 ${channelName || 'Canal Oficial'}`, maxW, 24, { weight: 400, maxChars: 52 });
    const tBot = base.fitText(`🤖 ${botName || 'Bot'}`, maxW, 19, { weight: 400, maxChars: 52 });

    let buf = await base.cardBase(W, H, C);
    buf = await base.applyCover(buf, thumbRaw, W, H, { opacity: 0.25, scrim: 0.45 });

    const textSvg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${W}" height="8" fill="${accent}"/>
        <circle cx="${avX + AV / 2}" cy="${avY + AV / 2}" r="${AV / 2 + 5}" fill="none" stroke="${accent}" stroke-width="5"/>
        <text x="${txX}" y="140" font-family="sans-serif" font-size="30" font-weight="800" fill="${sub}">🎵 TOCANDO AGORA</text>
        <text x="${txX}" y="200" font-family="sans-serif" font-size="${tTitle.fontSize}" font-weight="900" fill="${text}">${tTitle.text}</text>
        <text x="${txX}" y="252" font-family="sans-serif" font-size="${tMeta.fontSize}" font-weight="700" fill="${text}">${tMeta.text}</text>
        <text x="${txX}" y="302" font-family="sans-serif" font-size="${tChannel.fontSize}" fill="${sub}">${tChannel.text}</text>
        <text x="${txX}" y="344" font-family="sans-serif" font-size="${tBot.fontSize}" fill="${sub}">${tBot.text}</text>
        ${base.badgeSvg(W, 'MÚSICA', C)}
        <rect x="32" y="${H - 14}" width="${W - 64}" height="2" fill="${accent}" opacity="0.5"/>
    </svg>`;

    buf = await sharp(buf).composite([{ input: Buffer.from(textSvg) }]).png().toBuffer();

    try {
        let circ = null;
        if (thumbRaw && Buffer.isBuffer(thumbRaw)) circ = await toCircularAvatar(thumbRaw, AV);
        if (!circ) circ = await placeholderAvatar(AV);
        if (circ) buf = await sharp(buf).composite([{ input: circ, left: avX, top: avY }]).png().toBuffer();
    } catch (_) {}

    return await base.finalizeJpeg(buf);
}

module.exports = { generateMusicCover, fetchThumbRaw, OUT_W, OUT_H };
