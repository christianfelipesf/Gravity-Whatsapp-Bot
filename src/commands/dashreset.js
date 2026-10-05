const dashboard = require('../services/dashboardStub');

module.exports = {
    name: 'dashreset',
    aliases: ['resetdash'],
    category: 'admin',
    description: 'Reseta o dashboard (logs, mídias, cache) e ajusta o limite para 500. Apenas dono do bot.',
    async execute(sock, m, { sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, normalizeJid } = utils;

        const meId = normalizeJid(sock.user.id);
        const senderNorm = normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;

        if (!isBotOwner) {
            return await sock.sendMessage(m.key.remoteJid,
                { text: '❌ Apenas o dono do bot pode resetar o dashboard.' },
                { quoted: m });
        }

        const result = dashboard.resetDashboard();
        console.log(`🧹 [DASHBOARD] resetado por @${senderNorm.split('@')[0]} — logs=${result.removedLogs} midia=${result.removedMediaFiles} temp=${result.removedTempFiles} logsDir=${result.removedLogsDirFiles} limite=${result.newLimit}`);
        await sock.sendMessage(m.key.remoteJid, {
            text: `🧹 *Dashboard resetado!*\n\n` +
                  `📋 Logs SQLite: ${result.removedLogs}\n` +
                  `📁 Mídias (dashboard_media): ${result.removedMediaFiles}\n` +
                  `🗂️ Temp (zips/txts): ${result.removedTempFiles}\n` +
                  `📜 Logs dir (terminal_*.log): ${result.removedLogsDirFiles}\n` +
                  `📊 Novo limite: ${result.newLimit}`
        }, { quoted: m });
        return await react(sock, m, '🧹', lastBotResponse, GLOBAL_COOLDOWN);
    }
};