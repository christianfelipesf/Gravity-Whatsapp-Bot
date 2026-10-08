module.exports = {
    name: 'deletarmsg',
    aliases: ['d', 'deletemsg', 'apagarmsg', 'delmsg', 'deletar', 'apagarmensagem'],
    description: 'Apaga a mensagem marcada (responda a mensagem com o comando).',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) {
            return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
        }

        const admins = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, admins);
        const meId = utils.normalizeJid(sock.user?.id || '');
        const senderNorm = utils.normalizeJid(sender);
        const isOwner = m.key.fromMe || sender === meId || senderNorm === meId;

        let isGuardian = false;
        if (!isSenderAdmin && !isOwner && typeof utils.canGuardianActAsync === 'function') {
            try { if ((await utils.canGuardianActAsync(sock, m, sender, from)).ok) isGuardian = true; } catch (_) {}
        }

        if (!isSenderAdmin && !isOwner && !isGuardian) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores ou guardiões podem usar este comando.' }, { quoted: m });
        }

        const ctx = m.message.extendedTextMessage?.contextInfo;
        const stanzaId = ctx?.stanzaId;
        const participant = ctx?.participant;
        const quotedMessage = ctx?.quotedMessage;

        if (!stanzaId || !quotedMessage) {
            return await sock.sendMessage(from, { text: '❌ Você precisa *responder/marcar* a mensagem que deseja apagar.\n\nEx: responda a mensagem com *!deletarmsg*' }, { quoted: m });
        }

        const isQuotedFromMe = participant ? utils.normalizeJid(participant) === meId : false;

        // Sem participant não dá pra montar a chave em grupo — o WhatsApp
        // ignora o delete em silêncio. Falha com mensagem clara em vez disso.
        if (!isQuotedFromMe && !participant) {
            return await sock.sendMessage(from, { text: '❌ Não consegui identificar o autor da mensagem marcada. Tente responder a mensagem de novo.' }, { quoted: m });
        }

        // Mensagem do próprio bot: o WhatsApp deixa o bot apagar a própria msg
        // mesmo sem ser admin (delete fromMe). Só msg de terceiros exige bot-admin.
        if (!isQuotedFromMe) {
            const isBotAdmin = await utils.botIsAdmin(sock, from);
            if (!isBotAdmin) {
                return await sock.sendMessage(from, { text: '❌ Eu preciso ser administrador para apagar mensagens de outras pessoas.\n\n💡 Mensagens do próprio bot eu consigo apagar mesmo sem admin — responda a msg do bot com *!d*.' }, { quoted: m });
            }
        }

        try {
            const key = {
                remoteJid: from,
                id: stanzaId,
                participant: participant || undefined,
                fromMe: isQuotedFromMe
            };

            await utils.sendMessageSafe(sock, from, { delete: key }, { maxRetries: 2 });
            await utils.react(sock, m, '🗑️', lastBotResponse, GLOBAL_COOLDOWN);
            try {
                const partDomain = String(participant || '').split('@')[1] || (isQuotedFromMe ? 'bot' : 'ausente');
                console.log(`🗑️ [deletarmsg] alvo stanza=${String(stanzaId).slice(-8)} part=${partDomain} fromMe=${isQuotedFromMe} por ${isOwner ? 'dono' : isSenderAdmin ? 'admin' : 'guardião'}`);
            } catch (_) {}

            // Limpa o comando do usuário — EXCETO quando quem usou foi admin
            // do grupo ou o dono: a mensagem do !d deles é mantida no chat.
            if (!isSenderAdmin && !isOwner) {
                try {
                    await utils.sendMessageSafe(sock, from, { delete: m.key }, { maxRetries: 1 });
                } catch (_) {}
            }

            return;
        } catch (e) {
            console.error('[deletarmsg] falha:', e.message);
            const msg = e.message?.includes('rate-overlimit') || e.data?.statusCode === 429
                ? '❌ Falha por limite de requisições. Tente novamente em alguns segundos.'
                : '❌ Não foi possível apagar essa mensagem. Ela pode ser muito antiga ou de outro bot.';
            return await sock.sendMessage(from, { text: msg }, { quoted: m });
        }
    }
};
