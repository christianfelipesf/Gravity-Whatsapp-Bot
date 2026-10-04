module.exports = {
    name: 'desmute',
    aliases: ['desmutar'],
    description: 'Desmuta um membro no grupo (remove da lista em RAM).',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const adminsRaw = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, adminsRaw);

        if (!isSenderAdmin) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        let participant = '';
        if (m.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            participant = m.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (m.message.extendedTextMessage?.contextInfo?.participant) {
            participant = m.message.extendedTextMessage.contextInfo.participant;
        }

        if (!participant) {
            return await sock.sendMessage(from, { text: '❌ Você precisa marcar ou citar alguém para desmutar.' }, { quoted: m });
        }

        const identity = require('../services/identity');
        let keys = [participant];
        try {
            const k = await identity.targetKeys(sock, utils, from, participant);
            if (k && Array.isArray(k.all) && k.all.length) keys = k.all;
        } catch (_) {}
        const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');

        const wasMuted = typeof utils.isMutedAny === 'function'
            ? utils.isMutedAny(from, keys)
            : utils.isMuted(from, participant);
        for (const k of keys) {
            try { utils.removeMuted(from, k); } catch (_) {}
        }

        await utils.react(sock, m, '🔊', lastBotResponse, GLOBAL_COOLDOWN);
        return await sock.sendMessage(from, {
            text: wasMuted
                ? `🔊 ${label} foi desmutado.`
                : `ℹ️ ${label} não estava na lista de mute.`,
            mentions: [participant]
        }, { quoted: m });
    }
};