function parseIntervalMs(v) {
    if (v == null) return 15 * 60 * 1000;
    if (typeof v === 'string') {
        const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
        if (m) {
            const num = parseFloat(m[1]);
            const unit = m[2] || 'm';
            if (unit === 'ms') return Math.round(num);
            if (unit === 's') return Math.round(num * 1000);
            if (unit === 'm') return Math.round(num * 60 * 1000);
            if (unit === 'h') return Math.round(num * 60 * 60 * 1000);
        }
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        return 15 * 60 * 1000;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 15 * 60 * 1000;
    return Math.round(n * 60 * 1000);
}

// Formata um valor de intervalo (em minutos) para exibição amigável.
// Aceita number (minutos) ou string com sufixo ("60s", "45m", "1h").
function formatInterval(v) {
    if (v == null) return '15 min';
    const totalMs = parseIntervalMs(v);
    if (totalMs < 60 * 1000) return `${Math.max(1, Math.round(totalMs / 1000))}s`;
    const minutes = totalMs / 60000;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${Math.round(minutes)} min`;
}

module.exports = {
    name: 'news',
    aliases: ['noticias', 'feed'],
    category: 'grupos',
    description: 'Ativa/desativa o feed automático de notícias no grupo',
    async execute(sock, m, { from, isGroup, sender, config, utils, fullArgsText, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, setNewsEnabled, isNewsEnabled, listNewsGroups, readConfig, normalizeJid, getAdmins, isUserAdmin, canAdminControl, canActivateBotAsync, canConfigureBot, canGuardianActAsync } = utils;

        if (!isGroup) {
            const _sub0 = (fullArgsText || '').trim().split(/ +/)[0].toLowerCase();
            // Desliga o feed em TODOS os grupos de uma vez (só dono; funciona
            // no PV). O poll seguinte já volta a ficar quieto (lista vazia).
            if (_sub0 === 'desativar-todos' || _sub0 === 'desativar-tudo' || _sub0 === 'todos-off' || _sub0 === 'all-off') {
                const meId = normalizeJid(sock.user.id);
                const senderNorm = normalizeJid(sender);
                let allowed = m.key.fromMe === true || sender === meId || senderNorm === meId;
                // Sub-dono também pode (dono real ou sub-dono).
                if (!allowed) {
                    try { if (typeof canConfigureBot === 'function' && canConfigureBot(sock, m, sender, from).ok) allowed = true; } catch (_) {}
                }
                if (!allowed) {
                    await sock.sendMessage(from, { text: '❌ Apenas o dono e sub-donos podem desativar o feed em todos os grupos.' }, { quoted: m });
                    return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
                }
                const all = listNewsGroups();
                if (all.length === 0) {
                    await sock.sendMessage(from, { text: '📴 O feed já está desativado em todos os grupos.' }, { quoted: m });
                    return await react(sock, m, '📴', lastBotResponse, GLOBAL_COOLDOWN);
                }
                let off = 0;
                for (const jid of all) {
                    try { if (setNewsEnabled(jid, false)) off++; } catch (_) {}
                }
                await sock.sendMessage(from, { text: `📴 *Feed desativado em ${off} grupo(s).* O terminal volta a ficar quieto no próximo ciclo.` }, { quoted: m });
                return await react(sock, m, '🔴', lastBotResponse, GLOBAL_COOLDOWN);
            }
            await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
            return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
        }

        const sub = (fullArgsText || '').trim().split(/ +/)[0].toLowerCase();

        if (sub === 'desativar-todos' || sub === 'desativar-tudo' || sub === 'todos-off' || sub === 'all-off') {
            const meId0 = normalizeJid(sock.user.id);
            const senderNorm0 = normalizeJid(sender);
            let allowed0 = m.key.fromMe === true || sender === meId0 || senderNorm0 === meId0;
            // Sub-dono também pode (dono real ou sub-dono).
            if (!allowed0) {
                try { if (typeof canConfigureBot === 'function' && canConfigureBot(sock, m, sender, from).ok) allowed0 = true; } catch (_) {}
            }
            if (!allowed0) {
                await sock.sendMessage(from, { text: '❌ Apenas o dono e sub-donos podem desativar o feed em todos os grupos.' }, { quoted: m });
                return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
            }
            const all0 = listNewsGroups();
            if (all0.length === 0) {
                await sock.sendMessage(from, { text: '📴 O feed já está desativado em todos os grupos.' }, { quoted: m });
                return await react(sock, m, '📴', lastBotResponse, GLOBAL_COOLDOWN);
            }
            let off0 = 0;
            for (const jid of all0) {
                try { if (setNewsEnabled(jid, false)) off0++; } catch (_) {}
            }
            await sock.sendMessage(from, { text: `📴 *Feed desativado em ${off0} grupo(s).*` }, { quoted: m });
            return await react(sock, m, '🔴', lastBotResponse, GLOBAL_COOLDOWN);
        }

        if (sub === 'ativar' || sub === 'on' || sub === 'ligar') {
            const meId = normalizeJid(sock.user.id);
            const senderNorm = normalizeJid(sender);
            const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

            let allowed = isBotOwner;
            // Sub-dono ou guardião pode ativar (com fallback LID->telefone).
            if (!allowed) {
                try {
                    if (typeof canActivateBotAsync === 'function') {
                        if ((await canActivateBotAsync(sock, m, sender, from)).ok) allowed = true;
                    } else if (typeof canConfigureBot === 'function') {
                        if (canConfigureBot(sock, m, sender, from).ok) allowed = true;
                    }
                    if (!allowed && typeof canGuardianActAsync === 'function') {
                        if ((await canGuardianActAsync(sock, m, sender, from)).ok) allowed = true;
                    }
                } catch (_) {}
            }
            if (!allowed && canAdminControl()) {
                try {
                    const adminsRaw = await getAdmins(sock, from);
                    allowed = isUserAdmin(sender, adminsRaw);
                } catch (_) {}
            }

            if (!allowed) {
                const msg = canAdminControl()
                    ? '❌ Apenas o dono do bot, sub-donos, guardiões ou admins do grupo podem ativar o feed de notícias.'
                    : '❌ Apenas o dono do bot, sub-donos ou guardiões podem ativar o feed de notícias neste grupo.';
                await sock.sendMessage(from, { text: msg }, { quoted: m });
                return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
            }

            const cfg = readConfig();

            setNewsEnabled(from, true);
            await sock.sendMessage(from, {
                text: `📰 *Feed de notícias ativado!*\n\n⏱️ Intervalo: ${formatInterval(cfg.newsPollIntervalMinutes ?? 15)}\n\nUse *${config.prefix}news desativar* para parar.`
            }, { quoted: m });
            return await react(sock, m, '🟢', lastBotResponse, GLOBAL_COOLDOWN);
        }

        if (sub === 'desativar' || sub === 'off' || sub === 'desligar') {
            const meId = normalizeJid(sock.user.id);
            const senderNorm = normalizeJid(sender);
            const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

            let allowed = isBotOwner;
            // Sub-dono ou guardião pode desativar (com fallback LID->telefone).
            if (!allowed) {
                try {
                    if (typeof canActivateBotAsync === 'function') {
                        if ((await canActivateBotAsync(sock, m, sender, from)).ok) allowed = true;
                    } else if (typeof canConfigureBot === 'function') {
                        if (canConfigureBot(sock, m, sender, from).ok) allowed = true;
                    }
                    if (!allowed && typeof canGuardianActAsync === 'function') {
                        if ((await canGuardianActAsync(sock, m, sender, from)).ok) allowed = true;
                    }
                } catch (_) {}
            }
            if (!allowed && canAdminControl()) {
                try {
                    const adminsRaw = await getAdmins(sock, from);
                    allowed = isUserAdmin(sender, adminsRaw);
                } catch (_) {}
            }

            if (!allowed) {
                const msg = canAdminControl()
                    ? '❌ Apenas o dono do bot, sub-donos, guardiões ou admins do grupo podem desativar o feed de notícias.'
                    : '❌ Apenas o dono do bot, sub-donos ou guardiões podem desativar o feed de notícias neste grupo.';
                await sock.sendMessage(from, { text: msg }, { quoted: m });
                return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
            }

            setNewsEnabled(from, false);
            await sock.sendMessage(from, { text: '📴 Feed de notícias desativado neste grupo.' }, { quoted: m });
            return await react(sock, m, '🔴', lastBotResponse, GLOBAL_COOLDOWN);
        }

        if (sub === 'status') {
            const cfg = readConfig();
            const enabled = isNewsEnabled(from);
            const totalGroups = listNewsGroups().length;
            await sock.sendMessage(from, {
                text: `📰 *Status do Feed de Notícias*\n\n📡 Estado neste grupo: ${enabled ? '🟢 Ativado' : '🔴 Desativado'}\n⏱️ Intervalo: ${formatInterval(cfg.newsPollIntervalMinutes ?? 15)}\n👥 Grupos com feed: ${totalGroups}\n\nUse *${config.prefix}news ativar* ou *${config.prefix}news desativar*.`
            }, { quoted: m });
            return await react(sock, m, 'ℹ️', lastBotResponse, GLOBAL_COOLDOWN);
        }

        const cfg = readConfig();
        const enabled = isNewsEnabled(from);

        await sock.sendMessage(from, {
            text: `📰 *Feed de Notícias*\n\n📡 Estado: ${enabled ? '🟢 Ativado' : '🔴 Desativado'}\n\nComandos:\n│ 🟢 *${config.prefix}news ativar*\n│ 🔴 *${config.prefix}news desativar*\n│ 🔴 *${config.prefix}news desativar-todos* (dono, todos os grupos)\n│ ℹ️ *${config.prefix}news status*\n\nNovos posts são publicados automaticamente no grupo, com imagem(ns), vídeo e legenda.`
        }, { quoted: m });
        return await react(sock, m, '📰', lastBotResponse, GLOBAL_COOLDOWN);
    }
};
