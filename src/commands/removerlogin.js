module.exports = {
    name: 'removerlogin',
    aliases: ['removerlogins', 'removelogin', 'dellogin', 'rmlogin', 'deletarlogin'],
    category: 'admin',
    description: 'Remove autorização de número para usar !login. Só o dono, só no privado.',
    async execute(sock, m, { from, isGroup, sender, args, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
        if (!isBotOwner) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono do bot pode usar este comando.' }, { quoted: m });
        }

        if (isGroup) {
            return await sock.sendMessage(from, { text: '❌ Use este comando apenas no privado do bot.' }, { quoted: m });
        }

        const lower = String(fullArgsText || '').toLowerCase().trim();

        // Limpar todos: !removerlogin all | todos | tudo | limpar
        if (['all', 'todos', 'tudo', 'limpar', 'clear', 'clean', 'todas'].includes(lower)) {
            const list = utils.listLoginAllowed();
            if (!list.length) {
                return await sock.sendMessage(from, { text: 'ℹ️ Nenhum número autorizado para remover.' }, { quoted: m });
            }
            const n = utils.clearLoginAllowed();
            let current = await react(sock, m, '🧹', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(from, { text: `🧹 *${n} número(s) removido(s)!*\n\nNinguém mais pode usar !login sem ser dono.` }, { quoted: m });
            return await react(sock, m, '✅', current, GLOBAL_COOLDOWN);
        }

        // Extrai candidato: menção, citação ou dígitos digitados
        let candidate = null;
        try {
            const ctx = m.message?.extendedTextMessage?.contextInfo || utils.getContextInfo?.(m.message) || {};
            if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) {
                candidate = ctx.mentionedJid[0];
            } else if (ctx.participant) {
                candidate = ctx.participant;
            }
        } catch (_) {}
        if (!candidate && fullArgsText) {
            candidate = utils.extractPhoneFromText
                ? utils.extractPhoneFromText(fullArgsText)
                : String(fullArgsText).replace(/\D/g, '');
        }
        if (!candidate && Array.isArray(args)) {
            for (const a of args) {
                const d = utils.normalizePhoneNumber ? utils.normalizePhoneNumber(a, { min: 10 }) : String(a).replace(/\D/g, '');
                if (d) { candidate = d; break; }
            }
        }
        // Sem número: usa o contato do privado atual automaticamente
        if (!candidate && !isGroup && from && !String(from).endsWith('@g.us') && !String(from).endsWith('@lid')) {
            candidate = from;
        }

        if (!candidate) {
            return await sock.sendMessage(from, { text: '❌ Use: !removerlogin 5511999999999\n\n💡 No privado, basta digitar *!removerlogin* sem número para remover o contato da conversa.\nOu *!removerlogin all* para remover todos.\nVeja a lista com *!listalogins*.' }, { quoted: m });
        }

        const identity = require('../services/identity');
        let { phone, reason } = await identity.resolveCandidateToPhone(sock, utils, candidate, from);
        if (!phone) {
            // Sem resolução (ex: @lid sem telefone visível): tenta o bruto para
            // ao menos dar a mensagem de erro correta em vez de salvar LID.
            const raw = utils.normalizeLoginPhone
                ? utils.normalizeLoginPhone(String(candidate).split('@')[0] || candidate)
                : null;
            if (!raw) {
                return await sock.sendMessage(from, { text: '❌ Número inválido. Use: !removerlogin 5511999999999' }, { quoted: m });
            }
            phone = raw;
        }

        let currentBotResponse = await react(sock, m, '➖', lastBotResponse, GLOBAL_COOLDOWN);

        let res = utils.removeLoginAllowed(phone);
        // Compat LID: cruza telefone<->LID via metadados (ver identity).
        if (!res.ok && res.error === 'não encontrado') {
            try {
                const stored = (utils.listLoginAllowed ? utils.listLoginAllowed() : []).map((r) => r.phone);
                const match = await identity.findStoredMatch(sock, utils, stored, phone, from);
                if (match) res = utils.removeLoginAllowed(match);
            } catch (_) {}
        }
        if (!res.ok) {
            if (res.error === 'não encontrado') {
                await sock.sendMessage(from, { text: `ℹ️ O número *${phone}* não está na lista de autorizados.\nVeja com *!listalogins*.` }, { quoted: m });
                return await react(sock, m, '⚠️', currentBotResponse, GLOBAL_COOLDOWN);
            }
            await sock.sendMessage(from, { text: `❌ Falha ao remover: ${res.error}` }, { quoted: m });
            return await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }

        await sock.sendMessage(from, { text: `✅ Número *${res.phone}* removido!\n\nEle não pode mais usar !login.` }, { quoted: m });
        return await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
    }
};
