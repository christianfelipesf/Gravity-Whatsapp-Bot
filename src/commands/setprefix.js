module.exports = {
    name: 'setprefix',
    aliases: ['prefixo', 'prefix', 'definirprefixo'],
    category: 'config',
    description: 'Altera o prefixo dos comandos do bot',
    async execute(sock, m, { from, isGroup, sender, args, config, utils, ai, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, writeConfig, readConfig, getAdmins, isUserAdmin, setGroupPrefix, clearGroupPrefix, getPrefixForJid } = utils;
        const { setupAI } = ai;

        const effectivePrefix = isGroup && typeof getPrefixForJid === 'function' ? getPrefixForJid(from) : config.prefix;
        const botName = config.botName || 'Bot';

        // === Grupo: cada ADM altera prefixo do seu próprio grupo ===
        // Dono, sub-dono e guardiões também podem, mesmo sem ser ADM do grupo.
        if (isGroup) {
            let isAllowed = false;
            try {
                const meId = utils.normalizeJid(sock.user.id);
                const senderNorm = utils.normalizeJid(sender);
                const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
                if (isBotOwner) isAllowed = true;
                if (!isAllowed && typeof utils.canConfigureBot === 'function') {
                    try { if (utils.canConfigureBot(sock, m, sender, from).ok) isAllowed = true; } catch (_) {}
                }
                if (!isAllowed && typeof utils.canGuardianActAsync === 'function') {
                    try { if ((await utils.canGuardianActAsync(sock, m, sender, from)).ok) isAllowed = true; } catch (_) {}
                }
                if (!isAllowed) {
                    const admins = await getAdmins(sock, from);
                    if (isUserAdmin(sender, admins)) isAllowed = true;
                }
            } catch (_) {}
            if (!isAllowed) {
                return await sock.sendMessage(from, { text: '❌ Apenas administradores do grupo, dono, sub-donos ou guardiões podem alterar o prefixo deste grupo.' }, { quoted: m });
            }

            const raw = (args[0] || '').trim();
            if (!raw) {
                const usageText = `*${botName} — Prefixo* ⌨️\n\n` +
                    `╭─── *USO* ───\n` +
                    `│ ❌ *Use:* ${effectivePrefix}setprefix <novo prefixo>\n` +
                    `│ 💡 *Reset:* ${effectivePrefix}setprefix reset (volta ao padrão !)\n` +
                    `╰───────────────`;
                await sock.sendMessage(from, { text: usageText }, { quoted: m });
                return lastBotResponse;
            }

            if (raw.toLowerCase() === 'reset' || raw.toLowerCase() === 'padrao' || raw.toLowerCase() === 'padrão' || raw.toLowerCase() === 'default') {
                if (typeof clearGroupPrefix === 'function') clearGroupPrefix(from);
                let currentBotResponse = await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
                const globalPrefix = (readConfig().prefix || '!');
                const okText = `*${botName} — Prefixo* ⌨️\n_atualizado_\n\n` +
                    `╭─── *CONFIG* ───\n` +
                    `│ ✅ *Prefixo do grupo restaurado para o padrão:* *${globalPrefix}*\n` +
                    `╰───────────────`;
                await sock.sendMessage(from, { text: okText }, { quoted: m });
                return currentBotResponse;
            }

            const prefixChar = raw[0];
            if (!prefixChar || /\s/.test(prefixChar)) {
                await sock.sendMessage(from, { text: `❌ Prefixo inválido.` }, { quoted: m });
                return lastBotResponse;
            }

            if (typeof setGroupPrefix === 'function') setGroupPrefix(from, prefixChar);
            let currentBotResponse = await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            const okText = `*${botName} — Prefixo* ⌨️\n_atualizado_\n\n` +
                `╭─── *CONFIG* ───\n` +
                `│ ✅ *Novo prefixo deste grupo:* *${prefixChar}*\n` +
                `╰───────────────`;
            await sock.sendMessage(from, { text: okText }, { quoted: m });
            return currentBotResponse;
        }

        // === Privado / não-grupo: altera prefixo global (dono + sub-dono) ===
        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const cfgAccess = typeof utils.canConfigureBot === 'function'
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: m.key.fromMe === true || sender === meId || senderNorm === meId };
        if (!cfgAccess.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono ou sub-donos podem alterar o prefixo global.' }, { quoted: m });
        }

        const newPrefix = (args[0] || '').trim();
        if (!newPrefix) {
            const usageText = `*${botName} — Prefixo* ⌨️\n\n` +
                `╭─── *USO* ───\n` +
                `│ ❌ *Use:* ${effectivePrefix}setprefix <novo prefixo>\n` +
                `╰───────────────`;
            await sock.sendMessage(from, { text: usageText }, { quoted: m });
            return lastBotResponse;
        }

        const prefixChar = newPrefix[0];
        config.prefix = prefixChar;
        writeConfig(config);
        const newConfig = readConfig();
        setupAI(newConfig);

        let currentBotResponse = await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
        const okText = `*${botName} — Prefixo* ⌨️\n_atualizado_\n\n` +
            `╭─── *CONFIG* ───\n` +
            `│ ✅ *Prefixo global atualizado para:* *${prefixChar}*\n` +
            `│ 💡 *Padrão:* ! (grupos sem prefixo próprio herdam o global)\n` +
            `╰───────────────`;
        await sock.sendMessage(from, { text: okText }, { quoted: m });
        return currentBotResponse;
    }
};
