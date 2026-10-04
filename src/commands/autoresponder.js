module.exports = {
    name: 'autoresponder',
    aliases: ['autoresposta', 'chatbot', 'autochat'],
    description: 'Liga/desliga o respondedor automático do grupo (personalidade automática, sem moderação)',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, args, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;
        if (!isGroup) {
            return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
        }

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

        let allowed = isBotOwner;
        if (!allowed && typeof utils.canConfigureBot === 'function') {
            try { if (utils.canConfigureBot(sock, m, sender, from).ok) allowed = true; } catch (_) {}
        }
        if (!allowed && typeof utils.canGuardianActAsync === 'function') {
            try { if ((await utils.canGuardianActAsync(sock, m, sender, from)).ok) allowed = true; } catch (_) {}
        }
        if (!allowed) {
            const admins = await utils.getAdmins(sock, from).catch(() => []);
            if (utils.isUserAdmin(sender, admins)) allowed = true;
        }
        if (!allowed) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores do grupo, dono, sub-donos ou guardiões podem usar este comando.' }, { quoted: m });
        }

        const auto = require('../services/autoResponder');
        const sub = String(args[0] || '').toLowerCase();
        const p = config.prefix;

        const statusText = () => {
            const st = auto.getState(from);
            return `🤖 *Autoresponder ${st.enabled ? '🟢 ATIVADO' : '🔴 DESATIVADO'}*\n\n` +
                `O bot participa como membro informal do grupo:\n` +
                `│ 🎭 personalidade *automática* (espelha o tom das últimas msgs)\n` +
                `│ 🚫 *nunca* modera, censura ou dá lição de moral\n` +
                `│ 💬 menção/reply ao bot = responde na hora\n` +
                `│ ⏳ resto = responde a cada 3–5 mensagens\n` +
                `│ 😀 às vezes só reage ou manda um follow-up\n` +
                `│ 📝 resumo do assunto atualizado sozinho\n\n` +
                `Uso: *${p}autoresponder on* • *${p}autoresponder off*`;
        };

        if (!sub || sub === 'status' || sub === 'ver') {
            await sock.sendMessage(from, { text: statusText() }, { quoted: m });
            return lastBotResponse;
        }
        if (sub === 'on' || sub === 'ativar' || sub === '1' || sub === 'true' || sub === 'sim') {
            auto.enable(from);
            const r = await react(sock, m, '🤖', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(from, { text: '🤖 *Autoresponder ATIVADO!* ✅\n\nVou conversar como membro do grupo, no tom da conversa. Sem moderar, sem censurar.' }, { quoted: m });
            return r;
        }
        if (sub === 'off' || sub === 'desativar' || sub === '0' || sub === 'false' || sub === 'nao' || sub === 'não') {
            auto.disable(from);
            const r = await react(sock, m, '🔇', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(from, { text: '🔇 *Autoresponder DESATIVADO.*\n\nVolto a ficar quieto (só respondo comandos).' }, { quoted: m });
            return r;
        }
        await sock.sendMessage(from, { text: `❌ Use: *${p}autoresponder on|off|status*\n\n${statusText()}` }, { quoted: m });
        return lastBotResponse;
    }
};
