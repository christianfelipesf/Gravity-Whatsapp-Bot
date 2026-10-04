module.exports = {
    name: 'remsubdono',
    aliases: ['remsubowner', 'removersubdono', 'delsubdono', 'removesubdono'],
    category: 'admin',
    description: 'Remove um sub-dono. Só o dono real.',
    async execute(sock, m, { from, sender, args, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
        if (!isBotOwner) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono do bot pode remover sub-donos.' }, { quoted: m });
        }

        let candidate = null;
        try {
            const ctx = m.message?.extendedTextMessage?.contextInfo || utils.getContextInfo?.(m.message) || {};
            if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) {
                candidate = ctx.mentionedJid[0];
            } else if (ctx.participant) {
                candidate = ctx.participant;
            }
        } catch (_) {}
        const rawText = String(fullArgsText || (Array.isArray(args) ? args.join(' ') : '') || '').trim();
        if (!candidate && rawText) candidate = rawText;

        if (!candidate) {
            return await sock.sendMessage(from, { text: '❌ Use: !remsubdono 5598989138217 (ou !remsubdono all para limpar todos)' }, { quoted: m });
        }

        let currentBotResponse = await react(sock, m, '🧹', lastBotResponse, GLOBAL_COOLDOWN);

        let res = utils.removeSubOwner(String(candidate).split('@')[0] || candidate);
        // Compat LID: cruza telefone<->LID via metadados (ver identity).
        if (!res.ok && res.error === 'não encontrado') {
            try {
                const identity = require('../services/identity');
                const stored = utils.getSubOwners ? utils.getSubOwners() : [];
                const match = await identity.findStoredMatch(sock, utils, stored, String(candidate).split('@')[0] || candidate, from);
                if (match) res = utils.removeSubOwner(match);
            } catch (_) {}
        }
        if (!res.ok) {
            await sock.sendMessage(from, { text: `❌ Falha ao remover: ${res.error}` }, { quoted: m });
            return await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }

        if (res.phone === 'all') {
            await sock.sendMessage(from, { text: `🧹 *${res.removed || 0} sub-dono(s) removido(s)!*` }, { quoted: m });
        } else {
            await sock.sendMessage(from, { text: `🧹 Número *${res.phone}* não é mais sub-dono!` }, { quoted: m });
        }
        return await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
    }
};
