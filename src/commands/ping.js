const https = require('https');

function httpsPing(timeoutMs = 5000) {
    return new Promise((resolve) => {
        const start = process.hrtime.bigint();
        const req = https.request({
            hostname: 'www.google.com',
            path: '/generate_204',
            method: 'HEAD',
            timeout: timeoutMs,
        }, (res) => {
            const end = process.hrtime.bigint();
            const ms = Math.round(Number(end - start) / 1e6);
            // qualquer status 2xx/3xx indica conectividade
            res.resume();
            resolve({ ok: true, ms });
        });
        req.on('error', (e) => resolve({ ok: false, ms: null, error: e.message }));
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
            resolve({ ok: false, ms: null, error: 'timeout' });
        });
        req.end();
    });
}

async function measureGooglePing() {
    const overallStart = process.hrtime.bigint();
    // tenta via fetch primeiro (se disponível), fallback https
    if (typeof fetch === 'function') {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 5000);
            const start = process.hrtime.bigint();
            const res = await fetch('https://www.google.com/generate_204', {
                method: 'HEAD',
                signal: controller.signal,
                cache: 'no-store',
            });
            clearTimeout(t);
            const end = process.hrtime.bigint();
            const ms = Math.round(Number(end - start) / 1e6);
            if (res && (res.ok || res.status === 204 || res.status === 200 || res.status === 301 || res.status === 302)) {
                return { ok: true, ms };
            }
            // se fetch retornou mas status estranho, ainda considera ms e cai pro https
        } catch (_) {
            // ignora e tenta https
        }
    }
    // fallback https nativo
    const r = await httpsPing(5000);
    if (r.ok) return r;

    // segunda tentativa https com path raiz
    return new Promise((resolve) => {
        const start = process.hrtime.bigint();
        const req = https.request({ hostname: 'www.google.com', path: '/', method: 'HEAD', timeout: 5000 }, (res) => {
            const end = process.hrtime.bigint();
            const ms = Math.round(Number(end - start) / 1e6);
            res.resume();
            resolve({ ok: true, ms });
        });
        req.on('error', (e) => resolve({ ok: false, ms: null, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: null, error: 'timeout' }); });
        req.end();
    });
}

function classifyPing(ms) {
    if (ms == null) return '❌ Offline';
    if (ms < 100) return '✅ Excelente';
    if (ms < 200) return '✅ Bom';
    if (ms < 400) return '⚠️ Médio';
    return '🐢 Lento';
}

module.exports = {
    name: 'ping',
    aliases: ['info'],
    category: 'geral',
    description: 'Verifica latência real com o Google',
    async execute(sock, m, { from, config, utils, lastBotResponse, GLOBAL_COOLDOWN, startTime }) {
        const { react, getBotName, getGroupData, getThemeForJid, groupMetadataCached, formatUptime, readStats, getVersion } = utils;
        const { getTheme, themeBullets } = require('../services/themes');
        const themeId = (typeof getThemeForJid === 'function' ? getThemeForJid(from) : ((getGroupData(from).theme) || 'default'));
        const theme = getTheme(themeId);

        let currentBotResponse = await react(sock, m, theme.react || '🏓', lastBotResponse, GLOBAL_COOLDOWN);

        const t0 = process.hrtime.bigint();

        // mede ping real com Google
        const google = await measureGooglePing();

        const t1 = process.hrtime.bigint();
        const respostaMs = Math.round(Number(t1 - t0) / 1e6);
        const botName = getBotName(from, config);
        const stats = readStats();
        const version = getVersion();
        const uptime = formatUptime((Date.now() - startTime) / 1000);
        const plataforma = process.platform === 'win32' ? 'Windows' : 'Linux';

        const googleLinha = google.ok
            ? `${theme.bullet || '│'} 🌐 *Google:* ${google.ms}ms ${classifyPing(google.ms)}`
            : `${theme.bullet || '│'} 🌐 *Google:* falha (${google.error || 'sem resposta'}) ${theme.err || '❌'}`;

        const statusLinha = google.ok
            ? classifyPing(google.ms).includes('❌') ? `${theme.bullet || '│'} 📡 *Status:* Instável ⚠️` : `${theme.bullet || '│'} 📡 *Status:* Online ${theme.ok || '✅'}`
            : `${theme.bullet || '│'} 📡 *Status:* Offline ${theme.err || '❌'}`;

        let pingText = `*${botName} — Ping* ${theme.header}\n_teste de conexão_\n\n` +
            `╭─── *LATÊNCIA* ───\n` +
            `${theme.bullet || '│'} ⚡ *Resposta:* ${respostaMs}ms\n` +
            `${googleLinha}\n` +
            `${statusLinha}\n` +
            `╰───────────────\n\n` +
            `╭─── *SISTEMA* ───\n` +
            `${theme.bullet || '│'} ⏱️ *Uptime:* ${uptime}\n` +
            `${theme.bullet || '│'} 🖥️ *Plataforma:* ${plataforma}\n` +
            `${theme.bullet || '│'} 🆔 *Versão:* ${version}\n` +
            `${theme.bullet || '│'} ⌨️ *Comandos:* ${stats.totalCommands}\n` +
            `${theme.bullet || '│'} 🔄 *Reinícios:* ${stats.restarts}\n` +
            `╰───────────────`;
        pingText = themeBullets(pingText, theme);

        // Card 21:9 gerado como no !menu/!rank: foto do grupo + latência + cores do tema.
        // Fallback: foto cortada/antiga; por último, só texto.
        if (config.showLogoInMenu) {
            const groupData = getGroupData(from);
            const { generateMenuImage, getRawGroupBuffer, resolveMenuImageBuffer } = require('../services/menuImage');
            let groupName = 'Grupo';
            let avatarRaw = null;
            if (from && from.endsWith('@g.us')) {
                try {
                    const meta = await groupMetadataCached(sock, from).catch(() => null);
                    if (meta?.subject) groupName = meta.subject;
                } catch (_) {}
                try { avatarRaw = await getRawGroupBuffer(sock, from); } catch (_) { avatarRaw = null; }
            }
            const latencyLabel = google.ok ? `${respostaMs}ms • Google ${google.ms}ms` : `${respostaMs}ms • offline`;
            try {
                const card = await generateMenuImage({
                    title: 'PING',
                    headerEmoji: theme.header,
                    groupName,
                    memberLabel: latencyLabel,
                    tagline: 'teste de conexão',
                    footer: 'Menu Principal',
                    badge: 'PING',
                    theme,
                    avatarRaw
                });
                if (card) {
                    await sock.sendMessage(from, { image: card, caption: pingText }, { quoted: m });
                    return currentBotResponse;
                }
            } catch (_) {}
            try {
                const legacy = await resolveMenuImageBuffer(sock, { groupJid: from, groupMenuImage: groupData.menuImage, themeId: theme.id });
                if (legacy) {
                    await sock.sendMessage(from, { image: legacy, caption: pingText }, { quoted: m });
                    return currentBotResponse;
                }
            } catch (_) {}
        }

        await sock.sendMessage(from, { text: pingText }, { quoted: m });

        return currentBotResponse;
    }
};
