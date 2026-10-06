const memeStore = require('../services/memeStore');

module.exports = {
    name: 'delmeme',
    aliases: ['deletememe', 'apagarmeme', 'del-meme'],
    category: 'admin',
    description: 'Apaga um meme do acervo (só admins): !delmeme <ID>',
    async execute(sock, m, { from, isGroup, sender, args, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getAdmins, isUserAdmin } = utils;
        if (!isGroup) {
            await sock.sendMessage(from, { text: '❌ Apenas em grupos.' }, { quoted: m });
            return lastBotResponse;
        }
        let allowed = false;
        try {
            const admins = await getAdmins(sock, from);
            allowed = isUserAdmin(sender, admins);
        } catch (_) {}
        // Dono do bot sempre pode
        try {
            if (m.key.fromMe) allowed = true;
        } catch (_) {}
        if (!allowed) {
            await sock.sendMessage(from, { text: '❌ Apenas admins podem apagar memes.' }, { quoted: m });
            return lastBotResponse;
        }
        const id = Number(String(args[0] || '').replace('#', ''));
        if (!Number.isFinite(id) || id <= 0) {
            const recent = memeStore.listRecentMemes(10);
            if (!recent.length) {
                await sock.sendMessage(from, { text: '📭 Nenhum meme no acervo.' }, { quoted: m });
                return lastBotResponse;
            }
            let txt = `🗑️ *Apagar meme*\n\nUso: *${config.prefix}delmeme <ID>*\nEx: *${config.prefix}delmeme 3*\n\n*Últimos:*\n`;
            for (const r of recent) {
                txt += `• #${r.id} — ${r.sender_name || '?'}${r.sender_phone ? ` (${r.sender_phone})` : ''} • ${memeStore.formatDateBR(r.created_at)}\n`;
            }
            await sock.sendMessage(from, { text: txt }, { quoted: m });
            return lastBotResponse;
        }
        const res = memeStore.deleteMeme(id);
        if (!res.ok) {
            await sock.sendMessage(from, { text: `❌ Meme #${id} não encontrado.` }, { quoted: m });
            return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
        }
        await sock.sendMessage(from, { text: `🗑️ Meme #${id} apagado.` }, { quoted: m });
        return await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
    }
};
