const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const base = require('./imageBase');

const escapeXml = base.escapeXml;
const truncate = base.truncate;

const MEDALS = ['🥇', '🥈', '🥉'];
const COLORS = {
    bg: '#0f0f14',
    headerBg: '#1a1a24',
    gold: '#FFD700',
    silver: '#C0C0C0',
    bronze: '#CD7F32',
    rowAlt: '#17171f',
    row: '#1e1e2a',
    text: '#ffffff',
    sub: '#a0a0b2',
    accent: '#6c5ce7'
};

const AVATAR_SIZE = 56;

// Gera buffer circular a partir de imagem quadrada
async function toCircularAvatar(buf, size = AVATAR_SIZE) {
    return base.toCircularAvatar(buf, size || AVATAR_SIZE);
}

async function placeholderAvatar(name, size = AVATAR_SIZE) {
    return base.placeholderAvatar(name, size || AVATAR_SIZE);
}

/**
 * Gera imagem do rank mensal (top 10).
 * @param {Object} opts
 * @param {string} opts.groupName
 * @param {string} opts.botName
 * @param {string} opts.monthLabel - ex: "setembro de 2026"
 * @param {Array<{name:string,count:number, avatar?:Buffer, avatarUrl?:string}>} opts.ranking - já ordenado desc
 * @param {string} opts.monthKey - "2026-09" para debug
 * @param {Array<Buffer>} opts._avatarBuffers - interno: já circulares (opcional)
 */
async function generateRankImage({ groupName, botName, monthLabel, ranking, monthKey, theme, groupAvatar }) {
    const top = Array.isArray(ranking) ? ranking.slice(0, 10) : [];
    const C = base.getColors(theme, COLORS);
    const rankTitleRaw = (theme && theme.rankTitle) || 'RANK MENSAL — TOP 10 ATIVOS';
    const rankIcon = (theme && theme.rankIcon) || '🏆';
    const emptyLine = (theme && theme.rankEmpty) || 'Nenhum registro este mês. Seja o primeiro a falar! 💬';
    const W = 1080;
    const HEADER_H = 210;
    const ROW_H = 72;
    const PAD = 32;
    const FOOTER_H = 70;
    const H = HEADER_H + Math.max(top.length, 1) * ROW_H + FOOTER_H + PAD;
    const GROUP_AVATAR_SIZE = 110;
    const hasGroupAvatar = Buffer.isBuffer(groupAvatar) && groupAvatar.length > 100;
    // Com foto do grupo: avatar circular à esquerda, título deslocado p/ direita.
    // Sem foto: mantém layout antigo (troféu emoji + título em x=110).
    const titleX = hasGroupAvatar ? 170 : 110;
    const groupAvatarCX = PAD + GROUP_AVATAR_SIZE / 2;
    const groupAvatarCY = 78;
    // Anti-overlap: título do header nunca invade o badge do mês.
    const rankTitleFit = base.fitText(rankTitleRaw, Math.max(200, base.contentMaxX(W, true) - titleX), 38, { weight: 900, maxChars: 40 });
    const rankTitle = rankTitleFit.text;
    const rankTitleSize = rankTitleFit.fontSize;

    // Guarda avatares crus para gerar depois do scale (precisa do scale do density)
    const rawAvatars = top.map(u => (u.avatar && Buffer.isBuffer(u.avatar) ? u.avatar : null));
    const avatarNames = top.map(u => u.name);

    const rowsSvg = top.length === 0
        ? `<text x="${W/2}" y="${HEADER_H + 80}" text-anchor="middle" font-family="sans-serif" font-size="28" fill="${C.sub}">${escapeXml(emptyLine)}</text>`
        : top.map((u, i) => {
            const y = HEADER_H + i * ROW_H;
            const isTop3 = i < 3;
            const bg = i % 2 === 0 ? C.row : C.rowAlt;
            const borderColor = i === 0 ? C.gold : i === 1 ? C.silver : i === 2 ? C.bronze : 'transparent';
            const medal = i < 3 ? MEDALS[i] : `#${i + 1}`;
            const name = escapeXml(truncate(u.name, 24));
            const count = Number(u.count) || 0;
            const countLabel = count === 1 ? '1 msg' : `${count} msgs`;
            // barra proporcional ao top 1
            const max = top[0]?.count || 1;
            const barW = Math.max(40, Math.round((count / max) * 220));

            // posição: medal | avatar | nome | count (nome limitado p/ não invadir o count)
            const medalX = 36;
            const avatarX = 84; // avatar 56px, deixa medal + gap
            const nameX = 160;
            const countX = W - 180;
            const avatarBorder = isTop3 ? borderColor : '#2a2a3a';
            const nameFit = base.fitText(truncate(u.name, 24), Math.max(120, countX - 130 - nameX), 26, { weight: 700, maxChars: 26 });

            return `
            <g>
                <rect x="${PAD}" y="${y}" width="${W - PAD*2}" height="${ROW_H - 8}" rx="14" fill="${bg}" stroke="${borderColor}" stroke-width="${isTop3 ? 2 : 0}"/>
                <!-- medal -->
                <text x="${medalX}" y="${y + 44}" font-family="sans-serif" font-size="${i < 3 ? 34 : 24}" font-weight="700" fill="${isTop3 ? borderColor : C.sub}">${escapeXml(medal)}</text>
                <!-- avatar placeholder border (imagem real vem via composite) -->
                <circle cx="${avatarX + AVATAR_SIZE/2}" cy="${y + (ROW_H-8)/2}" r="${AVATAR_SIZE/2 + 2}" fill="none" stroke="${avatarBorder}" stroke-width="2"/>
                <!-- nome -->
                <text x="${nameX}" y="${y + 32}" font-family="sans-serif" font-size="${nameFit.fontSize}" font-weight="700" fill="${C.text}">${nameFit.text}</text>
                <text x="${nameX}" y="${y + 54}" font-family="sans-serif" font-size="16" fill="${C.sub}">${isTop3 ? '★ TOP '+ (i+1) : 'ativo do mês'}</text>
                <!-- count -->
                <text x="${countX}" y="${y + 40}" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="800" fill="${C.text}">${escapeXml(countLabel)}</text>
                <!-- barra -->
                <rect x="${countX - 110}" y="${y + 48}" width="${barW}" height="6" rx="3" fill="${isTop3 ? borderColor : C.accent}" opacity="0.95"/>
            </g>`;
        }).join('\n');

    const headerSvg = `
        <rect x="0" y="0" width="${W}" height="${HEADER_H}" rx="0" fill="${C.headerBg}"/>
        <rect x="0" y="0" width="${W}" height="6" fill="${C.accent}"/>
        ${hasGroupAvatar ? `<circle cx="${groupAvatarCX}" cy="${groupAvatarCY}" r="${GROUP_AVATAR_SIZE / 2 + 3}" fill="none" stroke="${C.accent}" stroke-width="3"/>` : `<!-- ícone troféu -->
        <text x="${PAD}" y="85" font-family="sans-serif" font-size="56">${escapeXml(rankIcon)}</text>`}
        <text x="${titleX}" y="70" font-family="sans-serif" font-size="${rankTitleSize}" font-weight="900" fill="${C.text}">${rankTitle}</text>
        <text x="${titleX}" y="105" font-family="sans-serif" font-size="22" font-weight="600" fill="${C.sub}">${base.fitText(`${truncate(groupName || 'Grupo', 42)} • ${monthLabel || ''}`, Math.max(200, base.contentMaxX(W, true) - titleX), 22, { weight: 600, maxChars: 56 }).text}</text>
        <text x="${titleX}" y="135" font-family="sans-serif" font-size="16" fill="${C.sub}">${escapeXml(botName || 'Bot')} • reseta todo dia 1 • ${escapeXml(monthKey || '')}</text>
        <!-- badge mês -->
        <rect x="${W - 240}" y="32" width="208" height="42" rx="21" fill="${C.accent}"/>
        <text x="${W - 136}" y="60" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="800" fill="${C.badgeText || '#fff'}">${escapeXml((monthLabel || '').toUpperCase().slice(0,22))}</text>
        <!-- linha divisória -->
        <rect x="${PAD}" y="${HEADER_H - 12}" width="${W - PAD*2}" height="1" fill="#2a2a3a"/>
    `;

    const footerSvg = `
        <text x="${W/2}" y="${H - 28}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">Use !rank ou !rankativos para ver este ranking • ${escapeXml(botName || '')}</text>
    `;

    const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${C.bg0 || '#0f0f14'}"/>
                <stop offset="100%" stop-color="${C.bg1 || '#141420'}"/>
            </linearGradient>
        </defs>
        <rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
        ${headerSvg}
        ${rowsSvg}
        ${footerSvg}
    </svg>`;

    // Render via sharp - density 144 (2x) para supersampling, depois resize fixo 800px
    let buf = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    let scale = 1;
    try {
        const meta = await sharp(buf).metadata();
        if (meta.width && W) scale = meta.width / W;
    } catch (_) {}
    if (!scale || !isFinite(scale) || scale <= 0) scale = 144 / 72;

    // Compõe avatares circulares - precisa escalar coordenadas e tamanho para bater com o buffer density
    const composites = [];
    // Foto do grupo no cabeçalho (igual ao rankglobal faz com os top 3 grupos)
    if (hasGroupAvatar) {
        try {
            const gSize = Math.max(1, Math.round(GROUP_AVATAR_SIZE * scale));
            const circ = await toCircularAvatar(groupAvatar, gSize);
            if (circ) {
                const left = Math.round((groupAvatarCX - GROUP_AVATAR_SIZE / 2) * scale);
                const topPos = Math.round((groupAvatarCY - GROUP_AVATAR_SIZE / 2) * scale);
                composites.push({ input: circ, left, top: topPos });
            }
        } catch (e) {
            console.warn('⚠️ [rankImage] falha composite foto grupo:', e.message);
        }
    }
    if (top.length > 0) {
        try {
            const avatarSizeScaled = Math.max(1, Math.round(AVATAR_SIZE * scale));
            for (let i = 0; i < top.length; i++) {
                const raw = rawAvatars[i];
                const name = avatarNames[i];
                let circ = null;
                if (raw) circ = await toCircularAvatar(raw, avatarSizeScaled);
                if (!circ) circ = await placeholderAvatar(name, avatarSizeScaled);
                if (!circ) continue;
                const y = HEADER_H + i * ROW_H;
                const avatarX = 84;
                const avatarY = y + Math.round(((ROW_H - 8) - AVATAR_SIZE) / 2);
                const left = Math.round(avatarX * scale);
                const topPos = Math.round(avatarY * scale);
                composites.push({ input: circ, left, top: topPos });
            }
        } catch (e) {
            console.warn('⚠️ [rankImage] falha composite avatares:', e.message);
        }
    }
    try {
        if (composites.length) buf = await sharp(buf).composite(composites).png().toBuffer();
    } catch (e) {
        console.warn('⚠️ [rankImage] falha composite geral:', e.message);
    }

    // Mantém 1080px (máximo útil) mas com JPEG otimizado — antes era 3300px por density 220
    buf = await base.finalizeJpeg(buf);

    return buf;
}

/**
 * Gera imagem do RANK GLOBAL (top 10 pessoas + top 3 grupos com foto).
 * @param {Object} opts
 * @param {string} opts.botName
 * @param {string} opts.monthLabel
 * @param {string} opts.monthKey
 * @param {Array} opts.ranking - top 10 global [{name,count,avatar}]
 * @param {Array} opts.topGroups - top 3 grupos [{name,total,members,avatar}]
 * @param {Object} opts.theme
 */
async function generateRankGlobalImage({ botName, monthLabel, monthKey, ranking, topGroups, theme }) {
    const top = Array.isArray(ranking) ? ranking.slice(0, 10) : [];
    const groups = Array.isArray(topGroups) ? topGroups.slice(0, 3) : [];
    const C = base.getColors(theme, COLORS);
    const rankTitleFit = base.fitText('RANK GLOBAL — TOP 10', Math.max(200, base.contentMaxX(1080, true) - 110), 38, { weight: 900, maxChars: 40 });
    const rankTitle = rankTitleFit.text;
    const rankTitleSize = rankTitleFit.fontSize;
    const rankIcon = (theme && theme.rankIcon) || '🌍';
    const W = 1080;
    const HEADER_H = 200;
    const GROUPS_H = groups.length > 0 ? 240 : 0;
    const ROW_H = 72;
    const PAD = 32;
    const FOOTER_H = 70;
    const H = HEADER_H + GROUPS_H + Math.max(top.length, 1) * ROW_H + FOOTER_H + PAD;

    const GROUP_AVATAR = 110;
    const rawAvatars = top.map(u => (u.avatar && Buffer.isBuffer(u.avatar) ? u.avatar : null));
    const avatarNames = top.map(u => u.name);
    const rawGroupAvatars = groups.map(g => (g.avatar && Buffer.isBuffer(g.avatar) ? g.avatar : null));
    const groupNames = groups.map(g => g.name);

    const groupSectionY = HEADER_H;
    const rowsStartY = HEADER_H + GROUPS_H;

    // Cards dos top 3 grupos (3 colunas)
    let groupsSvg = '';
    if (groups.length > 0) {
        const cardW = Math.floor((W - PAD * 2 - 16 * 2) / 3);
        const medalFor = ['🥇', '🥈', '🥉'];
        groupsSvg = groups.map((g, i) => {
            const x = PAD + i * (cardW + 16);
            const y = groupSectionY + 10;
            const h = GROUPS_H - 20;
            const border = i === 0 ? C.gold : i === 1 ? C.silver : C.bronze;
            const name = escapeXml(truncate(g.name || 'Grupo', 18));
            const total = Number(g.total) || 0;
            const totalLabel = total === 1 ? '1 msg' : `${total} msgs`;
            const membersLabel = `${Number(g.members) || 0} ativos`;
            return `
            <g>
                <rect x="${x}" y="${y}" width="${cardW}" height="${h}" rx="16" fill="${i % 2 === 0 ? C.row : C.rowAlt}" stroke="${border}" stroke-width="2"/>
                <text x="${x + 14}" y="${y + 34}" font-family="sans-serif" font-size="26">${medalFor[i] || `#${i + 1}`}</text>
                <text x="${x + cardW - 14}" y="${y + 32}" text-anchor="end" font-family="sans-serif" font-size="15" font-weight="800" fill="${border}">TOP ${i + 1} GRUPO</text>
                <circle cx="${x + cardW / 2}" cy="${y + 100}" r="${GROUP_AVATAR / 2 + 3}" fill="none" stroke="${border}" stroke-width="3"/>
                <text x="${x + cardW / 2}" y="${y + 172}" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="800" fill="${C.text}">${name}</text>
                <text x="${x + cardW / 2}" y="${y + 196}" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="700" fill="${C.sub}">${escapeXml(totalLabel)} • ${escapeXml(membersLabel)}</text>
            </g>`;
        }).join('\n');
        // título da seção
        groupsSvg = `<text x="${PAD}" y="${groupSectionY - 2}" font-family="sans-serif" font-size="17" font-weight="800" fill="${C.sub}">🏆 TOP 3 GRUPOS MAIS ATIVOS</text>\n` + groupsSvg;
        // reposiciona: aumenta um pouco o header da seção
    }

    const rowsSvg = top.length === 0
        ? `<text x="${W/2}" y="${rowsStartY + 80}" text-anchor="middle" font-family="sans-serif" font-size="28" fill="${C.sub}">${escapeXml((theme && theme.rankEmpty) || 'Sem registros este mês. 💬')}</text>`
        : top.map((u, i) => {
            const y = rowsStartY + i * ROW_H;
            const isTop3 = i < 3;
            const bg = i % 2 === 0 ? C.row : C.rowAlt;
            const borderColor = i === 0 ? C.gold : i === 1 ? C.silver : i === 2 ? C.bronze : 'transparent';
            const medal = i < 3 ? MEDALS[i] : `#${i + 1}`;
            const name = escapeXml(truncate(u.name, 24));
            const count = Number(u.count) || 0;
            const countLabel = count === 1 ? '1 msg' : `${count} msgs`;
            const max = top[0]?.count || 1;
            const barW = Math.max(40, Math.round((count / max) * 220));
            const medalX = 36;
            const avatarX = 84;
            const nameX = 160;
            const countX = W - 180;
            const avatarBorder = isTop3 ? borderColor : '#2a2a3a';
            const extra = (u.groups && Number(u.groups) > 1) ? ` • ${u.groups} grupos` : ' • global';
            const nameFitG = base.fitText(truncate(u.name, 24), Math.max(120, countX - 130 - nameX), 26, { weight: 700, maxChars: 26 });
            return `
            <g>
                <rect x="${PAD}" y="${y}" width="${W - PAD*2}" height="${ROW_H - 8}" rx="14" fill="${bg}" stroke="${borderColor}" stroke-width="${isTop3 ? 2 : 0}"/>
                <text x="${medalX}" y="${y + 44}" font-family="sans-serif" font-size="${i < 3 ? 34 : 24}" font-weight="700" fill="${isTop3 ? borderColor : C.sub}">${escapeXml(medal)}</text>
                <circle cx="${avatarX + AVATAR_SIZE/2}" cy="${y + (ROW_H-8)/2}" r="${AVATAR_SIZE/2 + 2}" fill="none" stroke="${avatarBorder}" stroke-width="2"/>
                <text x="${nameX}" y="${y + 32}" font-family="sans-serif" font-size="${nameFitG.fontSize}" font-weight="700" fill="${C.text}">${nameFitG.text}</text>
                <text x="${nameX}" y="${y + 54}" font-family="sans-serif" font-size="16" fill="${C.sub}">${isTop3 ? '★ TOP '+ (i+1) : 'top global'}${escapeXml(truncate(extra, 24))}</text>
                <text x="${countX}" y="${y + 40}" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="800" fill="${C.text}">${escapeXml(countLabel)}</text>
                <rect x="${countX - 110}" y="${y + 48}" width="${barW}" height="6" rx="3" fill="${isTop3 ? borderColor : C.accent}" opacity="0.95"/>
            </g>`;
        }).join('\n');

    const headerSvg = `
        <rect x="0" y="0" width="${W}" height="${HEADER_H}" rx="0" fill="${C.headerBg}"/>
        <rect x="0" y="0" width="${W}" height="6" fill="${C.accent}"/>
        <text x="${PAD}" y="85" font-family="sans-serif" font-size="56">${escapeXml(rankIcon)}</text>
        <text x="110" y="70" font-family="sans-serif" font-size="${rankTitleSize}" font-weight="900" fill="${C.text}">${rankTitle}</text>
        <text x="110" y="105" font-family="sans-serif" font-size="22" font-weight="600" fill="${C.sub}">${base.fitText(`Top 10 pessoas mais conversadoras • ${monthLabel || ''}`, Math.max(200, base.contentMaxX(W, true) - 110), 22, { weight: 600, maxChars: 56 }).text}</text>
        <text x="110" y="135" font-family="sans-serif" font-size="16" fill="${C.sub}">${escapeXml(botName || 'Bot')} • todos os grupos • reseta dia 1 • ${escapeXml(monthKey || '')}</text>
        <rect x="${W - 240}" y="32" width="208" height="42" rx="21" fill="${C.accent}"/>
        <text x="${W - 136}" y="60" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="800" fill="${C.badgeText || '#fff'}">${escapeXml((monthLabel || '').toUpperCase().slice(0,22))}</text>
        <rect x="${PAD}" y="${HEADER_H - 12}" width="${W - PAD*2}" height="1" fill="#2a2a3a"/>
    `;

    const footerSvg = `
        <text x="${W/2}" y="${H - 28}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">Use !rankglobal para ver este ranking • ${escapeXml(botName || '')}</text>
    `;

    const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${C.bg0 || '#0f0f14'}"/>
                <stop offset="100%" stop-color="${C.bg1 || '#141420'}"/>
            </linearGradient>
        </defs>
        <rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
        ${headerSvg}
        ${groupsSvg}
        ${rowsSvg}
        ${footerSvg}
    </svg>`;

    let buf = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    let scale = 1;
    try {
        const meta = await sharp(buf).metadata();
        if (meta.width && W) scale = meta.width / W;
    } catch (_) {}
    if (!scale || !isFinite(scale) || scale <= 0) scale = 144 / 72;

    try {
        const composites = [];
        // avatares dos grupos (topo)
        if (groups.length > 0) {
            const cardW = Math.floor((W - PAD * 2 - 16 * 2) / 3);
            const gSize = Math.max(1, Math.round(GROUP_AVATAR * scale));
            for (let i = 0; i < groups.length; i++) {
                const raw = rawGroupAvatars[i];
                let circ = null;
                if (raw) circ = await toCircularAvatar(raw, gSize);
                if (!circ) circ = await placeholderAvatar(groupNames[i], gSize);
                if (!circ) continue;
                const x = PAD + i * (cardW + 16);
                const y = groupSectionY + 10;
                const cx = x + cardW / 2;
                const cy = y + 100;
                const left = Math.round((cx - GROUP_AVATAR / 2) * scale);
                const topPos = Math.round((cy - GROUP_AVATAR / 2) * scale);
                composites.push({ input: circ, left, top: topPos });
            }
        }
        // avatares do top 10
        if (top.length > 0) {
            const avatarSizeScaled = Math.max(1, Math.round(AVATAR_SIZE * scale));
            for (let i = 0; i < top.length; i++) {
                const raw = rawAvatars[i];
                const name = avatarNames[i];
                let circ = null;
                if (raw) circ = await toCircularAvatar(raw, avatarSizeScaled);
                if (!circ) circ = await placeholderAvatar(name, avatarSizeScaled);
                if (!circ) continue;
                const y = rowsStartY + i * ROW_H;
                const avatarX = 84;
                const avatarY = y + Math.round(((ROW_H - 8) - AVATAR_SIZE) / 2);
                composites.push({ input: circ, left: Math.round(avatarX * scale), top: Math.round(avatarY * scale) });
            }
        }
        if (composites.length) buf = await sharp(buf).composite(composites).png().toBuffer();
    } catch (e) {
        console.warn('⚠️ [rankGlobalImage] falha composite avatares:', e.message);
    }

    buf = await base.finalizeJpeg(buf);
    return buf;
}

module.exports = { generateRankImage, generateRankGlobalImage };
