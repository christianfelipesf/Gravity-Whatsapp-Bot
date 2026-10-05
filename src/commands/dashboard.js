const dashboard = require('../services/dashboardStub');

module.exports = {
    name: 'dashboard',
    aliases: ['dash', 'painel'],
    category: 'admin',
    description: 'Liga/desliga o log de mensagens do grupo no painel (independente de !ativar)',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, isDashboardEnabled, setDashboardEnabled, getAdmins, isUserAdmin, normalizeJid, canAdminControl, canConfigureBot } = utils;

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

        let allowed = isBotOwner;
        if (!allowed && typeof canConfigureBot === 'function') {
            try { if (canConfigureBot(sock, m, sender, from).ok) allowed = true; } catch (_) {}
        }
        if (!allowed && canAdminControl()) {
            try {
                const adminsRaw = await getAdmins(sock, from);
                allowed = isUserAdmin(sender, adminsRaw);
            } catch (_) {}
        }

        if (!allowed) {
            const msg = canAdminControl() && isGroup
                ? '❌ Apenas o dono, sub-donos ou admins do grupo podem ativar/desativar o log no painel.'
                : '❌ Apenas o dono ou sub-donos podem ativar/desativar o log no painel.';
            return await sock.sendMessage(from, { text: msg }, { quoted: m });
        }

        const next = !isDashboardEnabled(from);
        // Reação imediata: o bot entendeu o comando e vai executar
        lastBotResponse = await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
        const ok = setDashboardEnabled(from, next);
        if (!ok) return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);

        try { dashboard.pushGroupsSnapshot(); } catch (_) {}

        console.log(`${next ? '📊' : '📉'} [DASHBOARD] log ${next ? 'ATIVADO' : 'DESATIVADO'} em ${from} por @${senderNorm.split('@')[0]}`);
        return await react(sock, m, next ? '🟢' : '🔴', lastBotResponse, GLOBAL_COOLDOWN);
    }
};