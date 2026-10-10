const safeDashboardLog = (...args) => { try { require('../history/store').writeLog(...args); } catch (_) {} };

module.exports = {
    name: 'ativarp',
    category: 'grupos',
    description: 'Liga o bot no grupo em modo parcial (mídia + interação + tts; espera 10s antes de responder)',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, activatePartial, getPartialWaitMs, normalizeJid, canActivateBotAsync, canConfigureBot, canGuardianActAsync } = utils;
        if (!isGroup) return await react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);

        const meId = normalizeJid(sock.user.id);
        const senderNorm = normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

        // Dono, sub-dono ou guardião pode ativar. Admin de grupo NÃO ativa.
        let allowed = isBotOwner;
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

        if (!allowed) {
            const msg = '❌ Apenas o dono, sub-donos ou guardiões podem ativar o bot neste grupo.';
            return await sock.sendMessage(from, { text: msg }, { quoted: m });
        }

        const already = (() => { try { return utils.isPartialActive(from); } catch (_) { return false; } })();
        const success = activatePartial(from);
        const waitSec = Math.round(getPartialWaitMs() / 1000);
        console.log(`🟡 [BOT-PARCIAL] ativado em ${from} por @${senderNorm.split('@')[0]} (wait=${waitSec}s)`);
        try {
            const gm = await sock.groupMetadata(from).catch(() => ({ subject: 'Grupo' }));
            safeDashboardLog('action', gm.subject, `🟡 Ativamento Parcial ativado (wait=${waitSec}s)`, senderNorm.split('@')[0], senderNorm.split('@')[0], null, { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe });
        } catch (_) {}
        if (!success) {
            return await react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);
        }
        try {
            await sock.sendMessage(from, {
                text: `🟡 *Ativamento Parcial* ativado!${already ? ' (já estava ativo)' : ''}\n\n⏱️ Tempo de espera: ${waitSec}s\n🎬 Comandos permitidos: mídia + interação (!s, !toimg, !abraco, etc.) + voz (!tts)\n👑 Downloads (!play, !dl/!download, !tiktok) só dono/sub-donos.\n🚫 Demais comandos (admin/geral) são ignorados em silêncio.\n🛡️ Moderação (mute/antilink/antiflood) fica pausada no parcial.\n\n💡 O bot só responde se nenhum outro bot reagir em ${waitSec}s.\n\nPara voltar ao modo total, use ${utils.readConfig ? `${utils.readConfig().prefix}` : '!'}ativar.`
            }, { quoted: m });
        } catch (err) {
            console.error('❌ [BOT-PARCIAL] falhou ao enviar mensagem de ativamento:', err.message);
            return await react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);
        }
        return await react(sock, m, '🟡', lastBotResponse, GLOBAL_COOLDOWN);
    }
};
