// src/history/handler.js — ponte do hot path para a camada de histórico.
//
// REGRA: eventos e comandos chamam este módulo, NUNCA o painel
// (`src/dashboard/dashboard`, arquivado — usar `dashboardStub` se precisar).
// Espelho via store.setMirror() segue disponível, sem consumidores.

const {
    getMediaMessage, getContextInfo, getMessageText,
    isViewOnce,
    groupMetadataCached
} = require('../database/utils');

const store = require('./store');
const { enqueueProcess } = require('../services/queue');

function _phoneOf(sender, m) {
    if (!sender) return null;
    if (String(sender).endsWith('@lid')) {
        const pn = m.key?.participantPn || m.key?.senderPn || null;
        if (pn && pn.endsWith('@s.whatsapp.net')) {
            const ph = pn.split('@')[0].split(':')[0];
            if (/^\d{8,15}$/.test(ph)) return ph;
        }
        return null;
    }
    const ph = String(sender).split('@')[0].split(':')[0];
    return /^\d{8,15}$/.test(ph) ? ph : null;
}

async function handleHistoryLog(sock, m, from, sender, senderName, text, groupMetadata) {
    store.rememberGroup(from, {
        subject: groupMetadata.subject,
        memberCount: Array.isArray(groupMetadata.participants) ? groupMetadata.participants.length : undefined,
        ownerJid: groupMetadata.owner || groupMetadata.subjectOwner || null,
        desc: groupMetadata.desc || groupMetadata.description || null
    });

    const mediaMsg = getMediaMessage(m.message);
    let mediaInfo = null;
    const hidden = isViewOnce(m.message);
    let ephemeral = false;

    if (mediaMsg) {
        const innerKey = Object.keys(mediaMsg).find(k => /Message$/.test(k));
        const inner = innerKey ? mediaMsg[innerKey] : null;
        const type = mediaMsg?.imageMessage ? 'image' :
                     mediaMsg?.videoMessage ? 'video' :
                     mediaMsg?.audioMessage ? 'audio' :
                     mediaMsg?.stickerMessage ? 'sticker' :
                     mediaMsg?.documentMessage ? 'document' : null;
        const mime = inner?.mimetype || 'application/octet-stream';

        if (type) {
            // Download em background via fila — não bloqueia o hot path
            const msgId = m.key.id;
            enqueueProcess(async () => {
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const pino = require('pino');
                    const buffer = await downloadMediaMessage(m, 'buffer', {}, {
                        logger: pino({ level: 'fatal' }),
                        reuploadRequest: sock.updateMediaMessage
                    }).catch(() => null);
                    if (buffer) {
                        const b64 = buffer.toString('base64');
                        const info = store.persistReceivedMedia(
                            { type, url: `data:${mime};base64,${b64}`, fileName: inner.fileName || null, sizeBytes: inner.fileLength || buffer.length },
                            msgId
                        ) || { type, url: null, sizeBytes: buffer.length };
                        if (type === 'document') { info.fileName = inner.fileName || 'documento'; info.mime = mime; info.sizeBytes = inner.fileLength || buffer.length; }
                        const updateType = isViewOnce(m.message) ? 'viewonce' : 'chat';
                        store.updateMedia(from, msgId, updateType, info);
                    } else {
                        store.updateMedia(from, msgId, 'chat', { type, url: null });
                    }
                } catch (e) {
                    console.error('Erro ao baixar mídia em background:', e.message);
                }
            });
            mediaInfo = { type, url: null };
        }
    }

    if (m.message?.ephemeralMessage) ephemeral = true;

    const qi = getContextInfo(m.message);
    let quotedInfo = null;
    if (qi?.quotedMessage) {
        const qText = qi.quotedMessage.conversation
            || qi.quotedMessage.extendedTextMessage?.text
            || qi.quotedMessage.imageMessage?.caption
            || qi.quotedMessage.videoMessage?.caption
            || qi.quotedMessage.documentMessage?.caption
            || '';
        const qSender = qi.participant || null;
        const isLidQ = typeof qSender === 'string' && qSender.endsWith('@lid');
        const qSenderName = (() => {
            try { const p = groupMetadata.participants?.find(pp => pp.id === qSender); return p?.name || p?.notify || (!isLidQ && qSender ? '@' + qSender.split('@')[0].split(':')[0] : null) || null; } catch (_) { return !isLidQ && qSender ? '@' + qSender.split('@')[0].split(':')[0] : null; }
        })();
        const qPhone = (() => {
            if (!qSender) return null;
            if (qSender.endsWith('@lid')) return null;
            const ph = qSender.split('@')[0].split(':')[0];
            return /^\d{8,15}$/.test(ph) ? ph : null;
        })();
        quotedInfo = { text: qText || null, hasMedia: !!(qi.quotedMessage.imageMessage || qi.quotedMessage.videoMessage || qi.quotedMessage.audioMessage || qi.quotedMessage.stickerMessage || qi.quotedMessage.documentMessage), senderJid: qSender, phone: qPhone, name: qSenderName };
    }

    const logType = hidden ? 'viewonce' : 'chat';
    store.writeLog(logType, groupMetadata.subject,
        text || (mediaInfo ? `[${mediaInfo.type}${hidden ? ' • viewOnce' : ''}]` : '') || getMessageText(m.message) || '',
        senderName, _phoneOf(sender, m), mediaInfo,
        { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe, quoted: quotedInfo, hidden, ephemeral }
    );
}

// Mensagem apagada (type 3): registra o evento no histórico.
async function handleProtocolMessage(sock, m, from, sender, senderName) {
    const protocolMsg = m.message?.protocolMessage || m.message?.ephemeralMessage?.message?.protocolMessage;
    if (!protocolMsg || protocolMsg.type !== 3) return false;
    const isGroup = from.endsWith('@g.us');
    const groupMetadata = isGroup
        ? await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' }))
        : { subject: senderName || 'Privado' };
    if (isGroup) {
        store.rememberGroup(from, {
            subject: groupMetadata.subject,
            memberCount: Array.isArray(groupMetadata.participants) ? groupMetadata.participants.length : undefined,
            ownerJid: groupMetadata.owner || groupMetadata.subjectOwner || null
        });
    }
    store.writeLog('chat', groupMetadata.subject, '📑 [Apagou uma mensagem]', senderName, _phoneOf(sender, m), null,
        { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe, ephemeral: !!m.message?.ephemeralMessage }
    );
    return true;
}

// Reação: atualiza o banco via store (o painel espelha se ativo).
async function handleReaction(sock, m, from, sender, senderName) {
    const reactionMsg = m.message?.reactionMessage || m.message?.ephemeralMessage?.message?.reactionMessage;
    if (!reactionMsg) return false;
    try {
        const targetId = reactionMsg.key.id;
        const emoji = reactionMsg.text || '';
        const msg = store.getHistoryByMessageId(targetId);
        if (msg) {
            const reactions = { ...(msg.reactions || {}) };
            if (emoji) reactions[sender] = emoji;
            else delete reactions[sender];
            store.updateReactions(msg.toJid, targetId, msg.type, reactions, { emoji, senderJid: sender, senderName });
        }
    } catch (_) {}
    return true;
}

// Alias compatível com o nome antigo (safeDashboardLog).
function safeHistoryLog(...args) {
    try { store.writeLog(...args); } catch (_) {}
}

module.exports = {
    handleHistoryLog,
    handleDashboardLog: handleHistoryLog,
    handleProtocolMessage,
    handleReaction,
    safeHistoryLog,
    safeDashboardLog: safeHistoryLog,
    safeDashboardRememberGroup: (...args) => { try { store.rememberGroup(...args); } catch (_) {} }
};
