module.exports = {
    name: 'addguardiao',
    aliases: ['addguardian', 'adicionarguardiao', 'setguardiao'],
    category: 'admin',
    description: 'Dá poder de guardião: ativar/desativar, parcial, news, investigartudo, autoresponder, mutar, apagar e redegravity. Dono e sub-donos.',
    async execute(sock, m, { from, sender, args, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

        const access = typeof utils.canConfigureBot === 'function'
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: false };
        if (!access.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono ou sub-donos podem adicionar guardiões.' }, { quoted: m });
        }

        // Extrai candidato: prioriza dígitos digitados (à prova de @lid).
        let candidate = null;
        let mentionedRaw = null;
        try {
            const ctx = m.message?.extendedTextMessage?.contextInfo || utils.getContextInfo?.(m.message) || {};
            if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) {
                mentionedRaw = ctx.mentionedJid[0];
            } else if (ctx.participant) {
                mentionedRaw = ctx.participant;
            }
        } catch (_) {}
        if (fullArgsText) {
            const fromText = utils.extractPhoneFromText
                ? utils.extractPhoneFromText(fullArgsText)
                : String(fullArgsText).replace(/\D/g, '');
            if (fromText) candidate = fromText;
        }
        if (!candidate && Array.isArray(args)) {
            for (const a of args) {
                const d = utils.normalizePhoneNumber ? utils.normalizePhoneNumber(a, { min: 10 }) : String(a).replace(/\D/g, '');
                if (d) { candidate = d; break; }
            }
        }
        if (!candidate && mentionedRaw) {
            // @lid nunca é salvo cru: resolve para o telefone real (ver identity).
            candidate = mentionedRaw;
        }

        if (!candidate) {
            return await sock.sendMessage(from, { text: '❌ Use: !addguardiao 5598989138217\n\n💡 Você também pode marcar (@) ou responder a mensagem da pessoa.' }, { quoted: m });
        }

        const identity = require('../services/identity');
        const { phone, reason } = await identity.resolveCandidateToPhone(sock, utils, candidate, from);
        if (!phone) {
            if (reason === 'lid-sem-telefone') {
                return await sock.sendMessage(from, { text: '❌ Não consegui identificar o número (menção @lid sem telefone visível).\n\n💡 Use: !addguardiao 5598989138217 (digite o número com DDI+DDD).' }, { quoted: m });
            }
            return await sock.sendMessage(from, { text: '❌ Número inválido. Use: !addguardiao 5598989138217' }, { quoted: m });
        }

        let currentBotResponse = await react(sock, m, '➕', lastBotResponse, GLOBAL_COOLDOWN);

        const res = utils.addGuardiao(phone);
        if (!res.ok) {
            if (res.error === 'duplicado') {
                await sock.sendMessage(from, { text: `ℹ️ O número *${phone}* já é guardião.` }, { quoted: m });
                return await react(sock, m, '⚠️', currentBotResponse, GLOBAL_COOLDOWN);
            }
            await sock.sendMessage(from, { text: `❌ Falha ao adicionar: ${res.error}` }, { quoted: m });
            return await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }

        await sock.sendMessage(from, { text: `✅ *${res.phone}* agora é *guardião* do bot! 🛡️💛\n\nCom essa confiança ele vai poder:\n✅ Ligar e desligar o bot nos grupos (*!ativar* / *!desativar*)\n✅ Usar o modo parcial (*!ativarp* / *!desativarp*)\n✅ Cuidar das notícias (*!news ativar/desativar*)\n✅ Conversar com a IA investigativa (*!investigar*) e investigação profunda (*!investigartudo*)\n✅ Ligar e desligar o bate-papo automático (*!autoresponder on/off*)\n✅ Mutar/desmutar pessoas (*!mutar* / *!desmutar*)\n✅ Apagar msgs do bot (mesmo sem admin) e de pessoas (*!d* respondendo)\n✅ Ver a rede de grupos (*!redegravity*)\n✅ Ver métricas dos grupos (*!statusgrupos*)\n\nObrigado por ajudar a cuidar da comunidade! ✨\n💡 Veja tudo com *!menuguardiao*` }, { quoted: m });
        return await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
    }
};
