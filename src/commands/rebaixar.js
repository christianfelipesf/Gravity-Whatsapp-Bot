module.exports = {
    name: 'rebaixar',
    aliases: ['demote', 'tiraradm', 'tiraradmin', 'removeradm', 'rebaixaradmin'],
    description: 'Remove o admin de um membro do grupo.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, admins);
        const isBotAdmin = utils.isUserAdmin(sock.user.id, admins);

        if (!isSenderAdmin) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        if (!isBotAdmin) {
            return await sock.sendMessage(from, { text: '❌ Eu preciso ser administrador para rebaixar membros.' }, { quoted: m });
        }

        let participant = '';
        if (m.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            participant = m.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (m.message.extendedTextMessage?.contextInfo?.participant) {
            participant = m.message.extendedTextMessage.contextInfo.participant;
        }

        if (!participant) {
            return await sock.sendMessage(from, { text: '❌ Você precisa marcar ou citar alguém para rebaixar.' }, { quoted: m });
        }

        if (!utils.isUserAdmin(participant, admins)) {
            return await sock.sendMessage(from, { text: 'ℹ️ Este usuário não é administrador.' }, { quoted: m });
        }

        const botJid = typeof utils.getBotJid === 'function' ? utils.getBotJid(sock) : utils.normalizeJid(sock.user.id);
        if (utils.normalizeJid(participant) === utils.normalizeJid(botJid)) {
            return await sock.sendMessage(from, { text: '❌ Eu não posso remover meu próprio admin.' }, { quoted: m });
        }

        try {
            await sock.groupParticipantsUpdate(from, [participant], 'demote');
            if (typeof utils.clearGroupMetadataCache === 'function') utils.clearGroupMetadataCache(from);
        } catch (e) {
            return await sock.sendMessage(from, { text: '❌ Não consegui rebaixar este usuário. Verifique se ele ainda está no grupo e se eu sou administrador.' }, { quoted: m });
        }

        await utils.reactStatus(sock, m, from, true, '✅', '❌', lastBotResponse, GLOBAL_COOLDOWN);
        const identity = require('../services/identity');
        const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');
        return await sock.sendMessage(from, { text: `✅ ${label} não é mais administrador.`, mentions: [participant] }, { quoted: m });
    }
};
