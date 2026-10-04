module.exports = {
    name: 'limparadv',
    aliases: ['clearwarn', 'clearadv', 'unwarn', 'desadvertir', 'limparadvertencia'],
    description: 'Limpa advertências de um membro. Use marcando ou citando.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN, fullArgsText }) {
        if (!isGroup) return;

        const admins = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, admins);

        if (!isSenderAdmin) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        const ctx = m.message.extendedTextMessage?.contextInfo || utils.getContextInfo(m.message) || {};
        let participant = '';
        if (ctx.mentionedJid?.length > 0) {
            participant = ctx.mentionedJid[0];
        } else if (ctx.participant) {
            participant = ctx.participant;
        }

        const groupData = utils.getGroupData(from);
        if (!groupData.warnings) groupData.warnings = {};

        // Se marcou alguém específico
        if (participant) {
            const identity = require('../services/identity');
            let keys = [participant];
            try {
                const k = await identity.targetKeys(sock, utils, from, participant);
                if (k && Array.isArray(k.all) && k.all.length) keys = k.all;
            } catch (_) {}
            const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');
            const count = identity.warnCount(groupData.warnings, keys);
            if (count === 0) {
                return await sock.sendMessage(from, { text: `ℹ️ ${label} não possui advertências.`, mentions: [participant] }, { quoted: m });
            }
            identity.warnDeleteAll(groupData.warnings, keys);
            utils.setGroupData(from, groupData);
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ Advertências de ${label} foram limpas. (${count} → 0)`, mentions: [participant] }, { quoted: m });
        }

        // Sem marcação: verifica se quer limpar todos
        const arg = (fullArgsText || '').trim().toLowerCase();
        if (arg === 'all' || arg === 'todos' || arg === 'tudo') {
            const total = Object.keys(groupData.warnings).length;
            if (total === 0) {
                return await sock.sendMessage(from, { text: 'ℹ️ Nenhuma advertência para limpar neste grupo.' }, { quoted: m });
            }
            groupData.warnings = {};
            utils.setGroupData(from, groupData);
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ Todas as advertências do grupo foram limpas. (${total} usuário(s))` }, { quoted: m });
        }

        return await sock.sendMessage(from, { text: '❌ Você precisa marcar ou citar alguém para limpar advertências.\n\nEx: *!limparadv @usuário* ou responda a mensagem da pessoa com *!limparadv*\nUse *!limparadv all* para limpar todos.' }, { quoted: m });
    }
};
