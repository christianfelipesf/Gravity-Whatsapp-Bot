const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const memeStore = require('../services/memeStore');

// Cadastro de meme: qualquer um pode enviar marcando uma imagem ou
// enviando a imagem com o comando na legenda. Só a imagem é salva.
module.exports = {
    name: 'postarmeme',
    aliases: ['novomeme', 'memenovo'],
    category: 'mídia',
    description: 'Adiciona um meme ao acervo (marque uma foto ou envie com legenda)',
    async execute(sock, m, { from, sender, senderName, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getMediaMessage } = utils;
        const ctx = m.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = ctx?.quotedMessage || null;

        let media = null;
        let targetKey = null;
        if (quotedMsg) {
            media = getMediaMessage(quotedMsg);
            if (media?.imageMessage) {
                targetKey = { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant || from };
            } else {
                media = null;
            }
        }
        if (!media) {
            const own = getMediaMessage(m.message);
            if (own?.imageMessage) { media = own; targetKey = m.key; }
        }
        if (!media?.imageMessage) {
            await sock.sendMessage(from, {
                text: `❌ *Marque ou envie uma foto.*\n\nUso:\n• marque a foto com *${config.prefix}postarmeme*\n• ou envie a foto com a legenda *${config.prefix}postarmeme*\n\nSó a imagem é salva (texto junto é ignorado).`
            }, { quoted: m });
            return lastBotResponse;
        }

        let current = await react(sock, m, '⏳', lastBotResponse, GLOBAL_COOLDOWN);
        let buffer = null;
        try {
            buffer = await downloadMediaMessage(
                { key: targetKey, message: media },
                'buffer',
                {},
                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Não consegui baixar a imagem. Tente de novo.' }, { quoted: m });
            return await react(sock, m, '❌', current, GLOBAL_COOLDOWN);
        }
        if (!buffer || !buffer.length) {
            await sock.sendMessage(from, { text: '❌ Imagem vazia. Tente de novo.' }, { quoted: m });
            return await react(sock, m, '❌', current, GLOBAL_COOLDOWN);
        }

        const senderJid = m.key.participant || m.key.remoteJid || sender || null;
        const phone = memeStore.extractPhone(sender || senderJid, m);
        let saved;
        try {
            saved = await memeStore.saveMeme(buffer, { senderJid, senderName: senderName || m.pushName || 'Usuário', senderPhone: phone });
        } catch (e) {
            await sock.sendMessage(from, { text: `❌ ${e?.message || 'Falha ao salvar.'}` }, { quoted: m });
            return await react(sock, m, '❌', current, GLOBAL_COOLDOWN);
        }
        if (saved.duplicate) {
            await sock.sendMessage(from, { text: `♻️ Esse meme já está no acervo como *#${saved.duplicate.id}*. Sem spam! Use *${config.prefix}meme* para sortear.` }, { quoted: m });
            return await react(sock, m, '♻️', current, GLOBAL_COOLDOWN);
        }
        const total = memeStore.countMemes();
        await sock.sendMessage(from, {
            text: `✅ *Meme #${saved.row.id} salvo!* (total: ${total})\n\n👤 *Enviado por:* ${saved.row.sender_name || senderName || 'Usuário'}${saved.row.sender_phone ? ` (${saved.row.sender_phone})` : ''}\n📅 *Data:* ${memeStore.formatDateBR(saved.row.created_at)}\n\nDigite *${config.prefix}meme* para sortear!`
        }, { quoted: m });
        return await react(sock, m, '✅', current, GLOBAL_COOLDOWN);
    }
};
