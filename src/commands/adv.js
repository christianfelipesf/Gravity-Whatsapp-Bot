module.exports = {
    name: 'adv',
    aliases: ['advertencia'],
    description: 'Dá uma advertência a um membro. 3 advertências resultam em banimento.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, admins);

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
            return await sock.sendMessage(from, { text: '❌ Você precisa marcar ou citar alguém para dar uma advertência.' }, { quoted: m });
        }

        if (utils.isUserAdmin(participant, admins)) {
            return await sock.sendMessage(from, { text: '❌ Eu não posso advertir um administrador.' }, { quoted: m });
        }

        const identity = require('../services/identity');
        const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');
        // Chaves telefone+LID: a advertência vale em qualquer formato.
        let keys = [participant];
        try {
            const k = await identity.targetKeys(sock, utils, from, participant);
            if (k && Array.isArray(k.all) && k.all.length) keys = k.all;
        } catch (_) {}

        const groupData = utils.getGroupData(from);
        if (!groupData.warnings) groupData.warnings = {};

        const count = identity.warnCount(groupData.warnings, keys) + 1;
        identity.warnSetAll(groupData.warnings, keys, count);
        try { utils.recordModEvent(from, 'warn'); } catch (_) {}

        if (count >= 3) {
            const isBotAdmin = utils.isUserAdmin(sock.user.id, admins);
            if (isBotAdmin) {
                await sock.groupParticipantsUpdate(from, [participant], 'remove');
                identity.warnDeleteAll(groupData.warnings, keys);
                utils.setGroupData(from, groupData);
                try { utils.recordModEvent(from, 'ban'); } catch (_) {}
                return await sock.sendMessage(from, { text: `🚫 ${label} atingiu 3 advertências e foi banido.`, mentions: [participant] });
            } else {
                utils.setGroupData(from, groupData);
                return await sock.sendMessage(from, { text: `⚠️ ${label} atingiu 3 advertências, mas não sou admin para banir.`, mentions: [participant] });
            }
        }

        utils.setGroupData(from, groupData);
        await utils.react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);
        return await sock.sendMessage(from, { text: `⚠️ ${label} recebeu uma advertência. (${count}/3)`, mentions: [participant] }, { quoted: m });
    }
};
