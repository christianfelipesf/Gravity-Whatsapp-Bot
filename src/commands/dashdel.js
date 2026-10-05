const dashboard = require('../services/dashboardStub');

module.exports = {
    name: 'dashdel',
    aliases: ['dashremover', 'dashremove'],
    category: 'admin',
    description: 'Remove um grupo/chat do dashboard pelo JID. Ex: !dashdel 120363427130222764',
    async execute(sock, m, { args, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, normalizeJid, setDashboardEnabled, deleteDashboardGroupInfo, deleteDashboardLogsByJid } = utils;

        const meId = normalizeJid(sock.user.id);
        const senderNorm = normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

        if (!isBotOwner) {
            return await sock.sendMessage(m.key.remoteJid,
                { text: '❌ Apenas o dono do bot pode remover grupos do dashboard.' },
                { quoted: m });
        }

        if (!args || !args.length) {
            return await sock.sendMessage(m.key.remoteJid,
                { text: '❌ Use: !dashdel <jid>\nEx: !dashdel 120363427130222764\n(O JID fica abaixo do nome do grupo no painel)' },
                { quoted: m });
        }

        let jid = args[0].trim();
        if (!jid.includes('@')) jid += '@g.us';

        const wasEnabled = setDashboardEnabled(jid, false);
        deleteDashboardGroupInfo(jid);
        deleteDashboardLogsByJid(jid);

        try { dashboard.pushGroupsSnapshot(); } catch (_) {}

        const clean = jid.split('@')[0];
        console.log(`🗑️ [DASHDEL] ${jid} removido do dashboard por @${senderNorm.split('@')[0]}`);
        await sock.sendMessage(m.key.remoteJid, {
            text: `🗑️ *${clean}* removido do dashboard!\n\n📋 Logs apagados: ${wasEnabled ? 'sim' : 'não estava ativo'}`
        }, { quoted: m });
        return await react(sock, m, '🗑️', lastBotResponse, GLOBAL_COOLDOWN);
    }
};
