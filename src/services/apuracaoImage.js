'use strict';

/**
 * apuracaoImage.js — Card da apuração presidencial no mesmo padrão visual do !rank
 * (sharp + SVG + avatares circulares compostos, saída JPEG 1080px).
 */

const sharp = require('sharp');

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
    return s.slice(0, n - 1) + '…';
}

const MEDALS = ['🥇', '🥈', '🥉'];

const COLORS = {
    bg0: '#0d1526',
    bg1: '#101a30',
    headerBg: '#0a1f16',
    gold: '#FFD700',
    silver: '#C0C0C0',
    bronze: '#CD7F32',
    rowAlt: '#141d33',
    row: '#182441',
    text: '#ffffff',
    sub: '#a8b4cc',
    accent: '#009c3b',
    accent2: '#ffdf00'
};

const AVATAR_SIZE = 56;

/** Buffer circular a partir de imagem quadrada. */
async function toCircularAvatar(buf, size) {
    const sz = size || AVATAR_SIZE;
    try {
        const resized = await sharp(buf, { failOn: 'none' }).resize(sz, sz, { fit: 'cover' }).png().toBuffer();
        const mask = `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><circle cx="${sz / 2}" cy="${sz / 2}" r="${sz / 2}" fill="white"/></svg>`;
        return await sharp(resized).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
    } catch (_) {
        return null;
    }
}

/** Placeholder com iniciais + cor determinística (número de urna). */
async function placeholderAvatar(label, size) {
    const sz = size || AVATAR_SIZE;
    const letter = String(label || '?').trim().replace(/^\D+/, '').slice(0, 2) || '?';
    let hash = 0;
    const src = String(label || '?');
    for (let i = 0; i < src.length; i++) hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
    const hues = [150, 45, 210, 200, 340, 260, 20];
    const hue = hues[hash % hues.length];
    const bg = `hsl(${hue}, 65%, 42%)`;
    const svg = `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><circle cx="${sz / 2}" cy="${sz / 2}" r="${sz / 2}" fill="${bg}"/><text x="${sz / 2}" y="${sz / 2 + 7}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(sz * 0.38)}" font-weight="800" fill="white">${escapeXml(letter)}</text></svg>`;
    try {
        return await sharp(Buffer.from(svg)).png().toBuffer();
    } catch (_) {
        return null;
    }
}

/**
 * Gera o card da apuração.
 * @param {Object} opts
 * @param {Array} opts.candidatos [{ nomeUrna, numero, partido, vice, votos, votosFmt, pct, avatar?:Buffer }]
 * @param {number} opts.turno 1 | 2
 * @param {string} opts.abrangenciaNome ex "BRASIL"
 * @param {string} opts.secoesPct ex "41,57"
 * @param {number} opts.secoesPctNum 0-100
 * @param {string} opts.atualizacao ex "18:43:29"
 * @param {Object} opts.resumo { brancos, brancosPct, nulos, nulosPct, validos }
 * @param {string} opts.botName
 * @param {boolean} opts.finalizada
 */
async function generateApuracaoImage(opts) {
    const o = opts || {};
    const cands = Array.isArray(o.candidatos) ? o.candidatos.slice(0, 14) : [];
    const turno = o.turno === 2 ? 2 : 1;
    const C = { ...COLORS };
    const W = 1080;
    const HEADER_H = 250;
    const ROW_H = 80;
    const PAD = 32;
    const FOOTER_H = 96;
    const H = HEADER_H + Math.max(cands.length, 1) * ROW_H + FOOTER_H + PAD;

    const maxVotos = (cands[0] && cands[0].votos) || 1;
    const pctNum = Math.max(0, Math.min(100, Number(o.secoesPctNum) || 0));

    const rowsSvg = cands.length === 0
        ? `<text x="${W / 2}" y="${HEADER_H + 90}" text-anchor="middle" font-family="sans-serif" font-size="28" fill="${C.sub}">Aguardando início da apuração… 🗳️</text>`
        : cands.map((c, i) => {
            const y = HEADER_H + i * ROW_H;
            const isTop3 = i < 3;
            const bg = i % 2 === 0 ? C.row : C.rowAlt;
            const border = i === 0 ? C.gold : i === 1 ? C.silver : i === 2 ? C.bronze : 'transparent';
            const medal = i < 3 ? MEDALS[i] : `#${i + 1}`;
            const name = escapeXml(truncate(c.nomeUrna || c.nome || 'Candidato', 22));
            const sub = escapeXml(truncate(`${c.numero || ''}${c.partido ? ' • ' + c.partido : ''}${c.vice ? ' • Vice: ' + c.vice : ''}`, 40));
            const pctLabel = escapeXml(c.pct || '0,00%');
            const votosLabel = escapeXml(c.votosFmt || String(c.votos || 0));
            const barW = Math.max(40, Math.round(((Number(c.votos) || 0) / maxVotos) * 220));
            const medalX = 36;
            const avatarX = 84;
            const nameX = 162;
            const pctX = W - 170;
            const avatarBorder = isTop3 ? border : '#2a3550';
            return `
            <g>
                <rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${ROW_H - 8}" rx="14" fill="${bg}" stroke="${border}" stroke-width="${isTop3 ? 2 : 0}"/>
                <text x="${medalX}" y="${y + 48}" font-family="sans-serif" font-size="${i < 3 ? 34 : 24}" font-weight="700" fill="${isTop3 ? border : C.sub}">${escapeXml(medal)}</text>
                <circle cx="${avatarX + AVATAR_SIZE / 2}" cy="${y + (ROW_H - 8) / 2}" r="${AVATAR_SIZE / 2 + 2}" fill="none" stroke="${avatarBorder}" stroke-width="2"/>
                <text x="${nameX}" y="${y + 33}" font-family="sans-serif" font-size="26" font-weight="700" fill="${C.text}">${name}</text>
                <text x="${nameX}" y="${y + 57}" font-family="sans-serif" font-size="15" fill="${C.sub}">${sub}</text>
                <text x="${pctX}" y="${y + 34}" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="900" fill="${i === 0 ? C.accent2 : C.text}">${pctLabel}%</text>
                <text x="${pctX}" y="${y + 54}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">${votosLabel} votos</text>
                <rect x="${pctX - 110}" y="${y + 60}" width="220" height="6" rx="3" fill="#232e4d"/>
                <rect x="${pctX - 110}" y="${y + 60}" width="${barW}" height="6" rx="3" fill="${isTop3 ? border : C.accent}" opacity="0.95"/>
            </g>`;
        }).join('\n');

    const turnoLabel = turno === 2 ? '2º TURNO' : '1º TURNO';
    const statusLabel = o.finalizada ? 'TOTALIZADO' : 'APURANDO';
    const abr = escapeXml(truncate(o.abrangenciaNome || 'BRASIL', 26));
    const urnasLabel = escapeXml(`URNAS APURADAS ${o.secoesPct || '0,00'}%`);
    const atualLabel = escapeXml(o.atualizacao ? `atualizado às ${o.atualizacao}` : 'fonte: TSE');
    const barFillW = Math.max(8, Math.round(((W - PAD * 2) * pctNum) / 100));

    const headerSvg = `
        <rect x="0" y="0" width="${W}" height="${HEADER_H}" rx="0" fill="${C.headerBg}"/>
        <rect x="0" y="0" width="${W}" height="8" fill="${C.accent}"/>
        <rect x="0" y="8" width="${W}" height="4" fill="${C.accent2}" opacity="0.9"/>
        <text x="${PAD}" y="80" font-family="sans-serif" font-size="60">🇧🇷</text>
        <text x="116" y="66" font-family="sans-serif" font-size="38" font-weight="900" fill="${C.text}">APURAÇÃO — PRESIDENTE 2026</text>
        <text x="116" y="100" font-family="sans-serif" font-size="21" font-weight="600" fill="${C.sub}">${abr} • ${escapeXml(statusLabel)} • ${atualLabel}</text>
        <rect x="${W - 268}" y="34" width="236" height="44" rx="22" fill="${C.accent}"/>
        <text x="${W - 150}" y="63" text-anchor="middle" font-family="sans-serif" font-size="19" font-weight="900" fill="#fff">${escapeXml(turnoLabel)}</text>
        <rect x="${W - 268}" y="86" width="236" height="36" rx="18" fill="none" stroke="${C.accent2}" stroke-width="2"/>
        <text x="${W - 150}" y="110" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="800" fill="${C.accent2}">${urnasLabel}</text>
        <text x="${PAD}" y="150" font-family="sans-serif" font-size="17" font-weight="700" fill="${C.sub}">${escapeXml(`${o.secoesApuradasFmt || ''}${o.secoesTotalFmt ? ' de ' + o.secoesTotalFmt + ' seções' : ''}`)}</text>
        <rect x="${PAD}" y="166" width="${W - PAD * 2}" height="16" rx="8" fill="#0a1224"/>
        <rect x="${PAD}" y="166" width="${barFillW}" height="16" rx="8" fill="${C.accent}"/>
        <rect x="${PAD}" y="${HEADER_H - 12}" width="${W - PAD * 2}" height="1" fill="#2a3550"/>
    `;

    const r = o.resumo || {};
    const footerSvg = `
        <text x="${W / 2}" y="${H - 52}" text-anchor="middle" font-family="sans-serif" font-size="17" fill="${C.sub}">✔️ Válidos ${escapeXml(r.validos || '—')} • ⚪ Brancos ${escapeXml(r.brancos || '—')} (${escapeXml(r.brancosPct || '—')}%) • ❌ Nulos ${escapeXml(r.nulos || '—')} (${escapeXml(r.nulosPct || '—')}%)</text>
        <text x="${W / 2}" y="${H - 26}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">Fonte: TSE • Use !apuracao ou !apuracao &lt;UF&gt; para atualizar • ${escapeXml(o.botName || '')}</text>
    `;

    const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${C.bg0}"/>
                <stop offset="100%" stop-color="${C.bg1}"/>
            </linearGradient>
        </defs>
        <rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
        ${headerSvg}
        ${rowsSvg}
        ${footerSvg}
    </svg>`;

    let buf = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    let scale = 144 / 72;
    try {
        const meta = await sharp(buf).metadata();
        if (meta.width && W) scale = meta.width / W;
    } catch (_) {}
    if (!scale || !isFinite(scale) || scale <= 0) scale = 2;

    const composites = [];
    if (cands.length > 0) {
        try {
            const sizeScaled = Math.max(1, Math.round(AVATAR_SIZE * scale));
            for (let i = 0; i < cands.length; i++) {
                const raw = cands[i] && cands[i].avatar && Buffer.isBuffer(cands[i].avatar) ? cands[i].avatar : null;
                let circ = null;
                if (raw) circ = await toCircularAvatar(raw, sizeScaled);
                if (!circ) circ = await placeholderAvatar(cands[i].numero || cands[i].nomeUrna, sizeScaled);
                if (!circ) continue;
                const y = HEADER_H + i * ROW_H;
                const avatarX = 84;
                const avatarY = y + Math.round(((ROW_H - 8) - AVATAR_SIZE) / 2);
                composites.push({ input: circ, left: Math.round(avatarX * scale), top: Math.round(avatarY * scale) });
            }
        } catch (e) {
            console.warn('⚠️ [apuracaoImage] falha composite avatares:', e.message);
        }
    }
    try {
        if (composites.length) buf = await sharp(buf).composite(composites).png().toBuffer();
    } catch (e) {
        console.warn('⚠️ [apuracaoImage] falha composite geral:', e.message);
    }

    buf = await sharp(buf).resize({ width: 1080 }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    return buf;
}

module.exports = { generateApuracaoImage };
