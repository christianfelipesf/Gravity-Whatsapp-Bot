module.exports = {
    name: 'mute',
    aliases: ['mutar'],
    description: 'Muta um membro no grupo (suas mensagens serão apagadas). Funciona apenas enquanto o bot estiver ligado (em RAM).',
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
            return await sock.sendMessage(from, { text: '❌ Você precisa marcar ou citar alguém para mutar.' }, { quoted: m });
        }

        const isTargetAdmin = utils.isUserAdmin(participant, adminsRaw);
        if (isTargetAdmin) {
            return await sock.sendMessage(from, { text: '❌ Eu não posso mutar um administrador.' }, { quoted: m });
        }

        const isBotAdmin = await utils.botIsAdmin(sock, from);

        // Chaves telefone+LID: o mute vale em qualquer formato que chegar.
        const identity = require('../services/identity');
        let keys = [participant];
        try {
            const k = await identity.targetKeys(sock, utils, from, participant);
            if (k && Array.isArray(k.all) && k.all.length) keys = k.all;
        } catch (_) {}
        const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');

        let added = false;
        for (const k of keys) {
            try { if (utils.addMuted(from, k)) added = true; } catch (_) {}
        }

        await utils.react(sock, m, '🔇', lastBotResponse, GLOBAL_COOLDOWN);

        if (!isBotAdmin) {
            return await sock.sendMessage(from, {
                text: `⚠️ ${label} foi adicionado à lista de mute, mas *eu não sou administrador* deste grupo, portanto não consigo apagar as mensagens dele. Promova o bot a admin para que o mute funcione.`,
                mentions: [participant]
            }, { quoted: m });
        }

        return await sock.sendMessage(from, {
            text: added
                ? `🔇 ${label} foi mutado. As mensagens dele serão apagadas enquanto o bot estiver ligado.`
                : `ℹ️ ${label} já estava mutado.`,
            mentions: [participant]
        }, { quoted: m });
    }
};