const subSessions = require('../services/subSessions');

module.exports = {
    name: 'logins',
    aliases: ['sessions', 'subsessoes'],
    category: 'admin',
    description: 'Lista as sub-sessões Baileys ativas',
    async execute(sock, m, { from, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
        if (!isBotOwner) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono do bot pode usar este comando.' }, { quoted: m });
        }

        let currentBotResponse = await react(sock, m, '📋', lastBotResponse, GLOBAL_COOLDOWN);

        const list = subSessions.listSessions();
        if (list.length === 0) {
            await sock.sendMessage(from, {
                text: '📋 *Sub-sessões ativas*\n\n_Nenhuma. Use !login para criar uma._'
            }, { quoted: m });
            return currentBotResponse;
        }

        const identity = require('../services/identity');
        const lines = [];
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const phone = s.phoneNumber ? `+${s.phoneNumber}` : '?';
            const status = s.connected ? '🟢 online' : '🟡 iniciando';
            const since = new Date(s.startedAt).toLocaleString('pt-BR');
            const ownerLabel = await identity.personLabel(sock, utils, null, s.ownerJid).catch(() => 'membro');
            lines.push(`${i + 1}. ${status} — \`${phone}\` (${ownerLabel})\n   Prefixo: \`${s.prefix}\` • desde ${since}`);
        }

        await sock.sendMessage(from, {
            text: `📋 *Sub-sessões ativas (${list.length})*\n\n${lines.join('\n\n')}\n\n💡 Use *!logoff* para encerrar a sua.`
        }, { quoted: m });

        currentBotResponse = await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
        return currentBotResponse;
    }
};
