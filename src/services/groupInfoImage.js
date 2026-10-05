const sharp = require('sharp');
const base = require('./imageBase');

const escapeXml = base.escapeXml;
const truncate = base.truncate;

const COLORS = {
    bg: '#0f0f14',
    headerBg: '#1a1a24',
    rowAlt: '#17171f',
    row: '#1e1e2a',
    text: '#ffffff',
    sub: '#a0a0b2',
    accent: '#6c5ce7',
    green: '#22c55e',
    red: '#ef4444',
    gold: '#FFD700'
};

const W = 1080;
const PAD = 32;

function secTitle(y, title, C) {
    return `<rect x="${PAD}" y="${y - 24}" width="6" height="30" rx="3" fill="${C.accent}"/>
    <text x="${PAD + 18}" y="${y}" font-family="sans-serif" font-size="28" font-weight="900" fill="${C.text}">${escapeXml(title)}</text>
    <rect x="${PAD}" y="${y + 12}" width="${W - PAD * 2}" height="1" fill="#2a2a3a"/>`;
}

function statBox(x, y, w, h, value, label, C, valueColor) {
    // Anti-overlap: valor longo (ex "+12/-34") reduz a fonte para caber na caixa.
    const v = String(value == null ? '' : value);
    const vSize = v.length > 12 ? 26 : v.length > 9 ? 32 : 40;
    const vFit = base.fitText(v, Math.max(60, w - 24), vSize, { weight: 900, maxChars: 20 });
    const lFit = base.fitText(label, Math.max(60, w - 24), 18, { weight: 600, maxChars: 26 });
    return `<g>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.row}" stroke="#2a2a3a" stroke-width="1"/>
        <text x="${x + w / 2}" y="${y + 52}" text-anchor="middle" font-family="sans-serif" font-size="${vFit.fontSize}" font-weight="900" fill="${valueColor || C.text}">${vFit.text}</text>
        <text x="${x + w / 2}" y="${y + 82}" text-anchor="middle" font-family="sans-serif" font-size="${lFit.fontSize}" font-weight="600" fill="${C.sub}">${lFit.text}</text>
    </g>`;
}

function infoLine(y, label, value, C) {
    // Valor ajustado à largura restante da linha (não invade a borda direita).
    const vFit = base.fitText(value, Math.max(120, W - (PAD + 230) - PAD), 24, { weight: 800, maxChars: 40 });
    return `<text x="${PAD}" y="${y}" font-family="sans-serif" font-size="24" font-weight="600" fill="${C.sub}">${escapeXml(label)}</text>
    <text x="${PAD + 230}" y="${y}" font-family="sans-serif" font-size="${vFit.fontSize}" font-weight="800" fill="${C.text}">${vFit.text}</text>`;
}

/**
 * Gera imagem do card de análise do grupo (estilo !rank).
 * @param {Object} opts
 */
async function generateGroupInfoImage(opts = {}) {
    const {
        groupName, botName, engLabel, memberCount = 0, sizeMax = 1024, creationDate = '—',
        avgHour = '0', avgDay = '0', peakLabel = '—', activeCount = 0, activePct = 0,
        topName = '—', topCount = '', perHour = [], hasReal = false,
        joins = 0, leaves = 0, bans = 0, warns = 0, warnsAtivos = 0, spams = 0,
        antilinkOn = false, antifloodOn = false, onlyAdmins = false, theme
    } = opts;

    const C = base.getColors(theme, COLORS);
    const accent = C.accent || COLORS.accent;

    let y = 0;
    let svg = '';

    // ===== Header (título + nome do grupo limitados à área antes do badge) =====
    const HEADER_H = 200;
    const headerMaxW = Math.max(200, (W - 250 - 24) - 60);
    const tGiTitle = base.fitText('ANÁLISE DO GRUPO', headerMaxW, 38, { weight: 900, maxChars: 28 });
    const tGiGroup = base.fitText(groupName || 'Grupo', headerMaxW, 22, { weight: 600, maxChars: 48 });
    svg += `
        <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${C.headerBg}"/>
        <rect x="0" y="0" width="${W}" height="6" fill="${accent}"/>
        <rect x="${PAD}" y="38" width="8" height="60" rx="4" fill="${accent}"/>
        <text x="60" y="66" font-family="sans-serif" font-size="${tGiTitle.fontSize}" font-weight="900" fill="${C.text}">${tGiTitle.text}</text>
        <text x="60" y="102" font-family="sans-serif" font-size="${tGiGroup.fontSize}" font-weight="600" fill="${C.sub}">${tGiGroup.text}</text>
        <text x="60" y="132" font-family="sans-serif" font-size="16" fill="${C.sub}">${escapeXml(truncate(botName || 'Bot', 48))}</text>
        <rect x="${W - 250}" y="30" width="218" height="42" rx="21" fill="${accent}"/>
        <text x="${W - 141}" y="58" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="800" fill="${C.badgeText || '#fff'}">${escapeXml(truncate(String(engLabel || '7 DIAS').toUpperCase(), 22))}</text>
        <rect x="${PAD}" y="${HEADER_H - 12}" width="${W - PAD * 2}" height="1" fill="#2a2a3a"/>`;
    y = HEADER_H + 40;

    // ===== Informações Gerais =====
    svg += secTitle(y, 'INFORMAÇÕES GERAIS', C);
    y += 56;
    svg += infoLine(y, 'Nome', truncate(groupName || 'Grupo', 30), C); y += 42;
    svg += infoLine(y, 'Membros', `${memberCount} / ${sizeMax}`, C); y += 42;
    svg += infoLine(y, 'Criado em', creationDate, C); y += 30;
    // barra de ocupação
    const barW = W - PAD * 2;
    const fillW = Math.max(8, Math.round(barW * Math.min(1, Number(memberCount) / (Number(sizeMax) || 1024))));
    svg += `<rect x="${PAD}" y="${y}" width="${barW}" height="10" rx="5" fill="#2a2a3a"/>
    <rect x="${PAD}" y="${y}" width="${fillW}" height="10" rx="5" fill="${accent}"/>`;
    y += 44;

    // ===== Engajamento =====
    svg += secTitle(y, `ENGAJAMENTO (${engLabel || '7 dias'})`, C);
    y += 56;
    const boxW = (W - PAD * 2 - 20) / 2;
    const boxH = 104;
    svg += statBox(PAD, y, boxW, boxH, String(avgHour), 'MÉDIA / HORA (msgs)', C, C.gold);
    svg += statBox(PAD + boxW + 20, y, boxW, boxH, String(avgDay), 'MÉDIA / DIA (msgs)', C, C.gold);
    y += boxH + 24;
    svg += infoLine(y, 'Horário de pico', peakLabel, C); y += 42;
    svg += infoLine(y, 'Membros ativos', `${activeCount} (${activePct}%)`, C); y += 42;
    svg += infoLine(y, 'Top falante', truncate(`${topName}${topCount ? ` — ${topCount}` : ''}`, 34), C); y += 44;

    // gráfico 24h (só com dados reais)
    if (hasReal && Array.isArray(perHour) && perHour.some(v => Number(v) > 0)) {
        const chartH = 130;
        const chartW = W - PAD * 2;
        const max = Math.max(1, ...perHour.map(v => Number(v) || 0));
        const slot = chartW / 24;
        const bw = Math.max(8, Math.floor(slot * 0.62));
        let bars = '';
        for (let h = 0; h < 24; h++) {
            const v = Number(perHour[h]) || 0;
            const bh = Math.max(v > 0 ? 6 : 2, Math.round((v / max) * (chartH - 30)));
            const x = PAD + Math.round(h * slot + (slot - bw) / 2);
            const isMax = v === max && max > 0;
            bars += `<rect x="${x}" y="${y + (chartH - 30) - bh}" width="${bw}" height="${bh}" rx="4" fill="${isMax ? C.gold : accent}" opacity="${isMax ? 1 : 0.65}"/>`;
        }
        // rótulos 0h 6h 12h 18h
        const labels = [0, 6, 12, 18, 23].map(h => {
            const x = PAD + Math.round(h * slot + slot / 2);
            return `<text x="${x}" y="${y + chartH - 14}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">${h}h</text>`;
        }).join('');
        svg += `<text x="${PAD}" y="${y - 8}" font-family="sans-serif" font-size="16" font-weight="600" fill="${C.sub}">ATIVIDADE POR HORA</text>`;
        svg += bars + labels;
        y += chartH + 52;
    } else {
        svg += `<text x="${PAD}" y="${y}" font-family="sans-serif" font-size="16" fill="${C.sub}">Coletando dados de atividade… estimativa baseada no rank mensal.</text>`;
        y += 36;
    }

    // ===== Moderação =====
    svg += secTitle(y, 'MODERAÇÃO (ÚLTIMOS 7 DIAS)', C);
    y += 56;
    const mBoxW = (W - PAD * 2 - 30) / 4;
    svg += statBox(PAD, y, mBoxW, boxH, `+${joins}/-${leaves}`, 'ENTROU / SAIU', C);
    svg += statBox(PAD + (mBoxW + 10), y, mBoxW, boxH, String(bans), 'BANIMENTOS', C);
    svg += statBox(PAD + (mBoxW + 10) * 2, y, mBoxW, boxH, warnsAtivos ? `${warns} (${warnsAtivos})` : String(warns), 'WARNS (ativos)', C);
    svg += statBox(PAD + (mBoxW + 10) * 3, y, mBoxW, boxH, String(spams), 'SPAMS BLOQ.', C);
    y += boxH + 30;

    // ===== Segurança =====
    svg += secTitle(y, 'SEGURANÇA ATIVA', C);
    y += 56;
    const pills = [
        { label: 'Anti-Link', on: !!antilinkOn },
        { label: 'Anti-Flood', on: !!antifloodOn },
        { label: 'Apenas Admins', on: !!onlyAdmins }
    ];
    const pillW = (W - PAD * 2 - 30) / 3;
    const pillH = 62;
    pills.forEach((p, i) => {
        const x = PAD + i * (pillW + 15);
        const bg = p.on ? C.green : C.red;
        svg += `<g>
            <rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="31" fill="${bg}" opacity="0.92"/>
            <text x="${x + pillW / 2}" y="${y + 39}" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="800" fill="#fff">${p.on ? '●' : '○'}  ${escapeXml(p.label)}</text>
        </g>`;
    });
    y += pillH + 34;

    const FOOTER_H = 56;
    const H = y + FOOTER_H;
    svg += `<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${C.sub}">Use !infogrupo para atualizar • ${escapeXml(botName || '')}</text>`;

    const full = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${C.bg0 || '#0f0f14'}"/>
                <stop offset="100%" stop-color="${C.bg1 || '#141420'}"/>
            </linearGradient>
        </defs>
        <rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
        ${svg}
    </svg>`;

    let buf = await base.svgToPng(full, 144);
    buf = await base.finalizeJpeg(buf);
    return buf;
}

module.exports = { generateGroupInfoImage };
