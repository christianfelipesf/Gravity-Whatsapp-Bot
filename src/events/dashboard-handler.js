const {
    getMediaMessage, getContextInfo, getMessageText,
    insertDashboardLog, isDashboardEnabled, isViewOnce,
    groupMetadataCached
} = require('../database/utils');

const dashboard = require('../services/dashboardStub');
const { enqueueProcess } = require('../services/queue');
const safeDashboardLog = (...args) => { try { dashboard.log(...args); } catch (_) {} };
const safeDashboardCache = (...args) => { try { dashboard.cacheMedia(...args); } catch (_) {} };
const safeDashboardRememberGroup = (...args) => { try { dashboard.rememberGroupInfo(...args); } catch (_) {} };
const safeDashboardMediaReceived = (...args) => { try { return dashboard.mediaForLogReceived(...args); } catch (_) { return null; } };
const safeEmitMediaUpdate = (...args) => { try { dashboard.emitMediaUpdate(...args); } catch (_) {} };

async function handleDashboardLog(sock, m, from, sender, senderName, text, groupMetadata) {
    safeDashboardRememberGroup(from, {
        subject: groupMetadata.subject,
        memberCount: Array.isArray(groupMetadata.participants) ? groupMetadata.participants.length : undefined,
        ownerJid: groupMetadata.owner || groupMetadata.subjectOwner || null,
        desc: groupMetadata.desc || groupMetadata.description || null
    });

    const mediaMsg = getMediaMessage(m.message);
    let mediaInfo = null;
    let hidden = isViewOnce(m.message);
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
                    const { updateDashboardLogMedia } = require('../database/utils');
                    if (buffer) {
                        const persisted = safeDashboardMediaReceived({ type, url: `data:${mime};base64,${buffer.toString('base64')}` }, msgId);
                        const info = persisted || { type, url: `data:${mime};base64,${buffer.toString('base64')}` };
                        if (type === 'document') { info.fileName = inner.fileName || 'documento'; info.mime = mime; info.sizeBytes = inner.fileLength || buffer.length; }
                        try { safeDashboardCache(msgId, { bufferBase64: buffer.toString('base64'), mime, type, fileName: inner.fileName || null, text: inner.caption || null, fromJid: from }); } catch (_) {}
                        const updateType = isViewOnce(m.message) ? 'viewonce' : 'chat';
                        updateDashboardLogMedia(from, msgId, updateType, JSON.stringify(info));
                        safeEmitMediaUpdate(from, msgId, updateType, info);
                    } else {
                        updateDashboardLogMedia(from, msgId, 'chat', JSON.stringify({ type, url: null }));
                        safeEmitMediaUpdate(from, msgId, 'chat', { type, url: null });
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
    const phoneForLog = (() => {
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
    })();
    safeDashboardLog(logType, groupMetadata.subject,
        text || (mediaInfo ? `[${mediaInfo.type}${hidden ? ' • viewOnce' : ''}]` : ''),
        senderName, phoneForLog, mediaInfo,
        { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe, quoted: quotedInfo, hidden, ephemeral }
    );
}

async function handleProtocolMessage(sock, m, from, sender, senderName) {
    const protocolMsg = m.message?.protocolMessage || m.message?.ephemeralMessage?.message?.protocolMessage;
    if (!protocolMsg || protocolMsg.type !== 3) return false;
    const isGroup = from.endsWith('@g.us');
    const groupMetadata = isGroup
        ? await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' }))
        : { subject: senderName || 'Privado' };
    if (isGroup) {
        safeDashboardRememberGroup(from, {
            subject: groupMetadata.subject,
            memberCount: Array.isArray(groupMetadata.participants) ? groupMetadata.participants.length : undefined,
            ownerJid: groupMetadata.owner || groupMetadata.subjectOwner || null
        });
    }
    const phoneDel = (()=>{ if(!sender) return null; if(String(sender).endsWith('@lid')){ const pn=m.key?.participantPn||m.key?.senderPn||null; if(pn&&pn.endsWith('@s.whatsapp.net')){const ph=pn.split('@')[0].split(':')[0]; if(/^\d{8,15}$/.test(ph)) return ph;} return null;} const ph=String(sender).split('@')[0].split(':')[0]; return /^\d{8,15}$/.test(ph)?ph:null; })();
    safeDashboardLog('chat', groupMetadata.subject, '📑 [Apagou uma mensagem]', senderName, phoneDel, null,
        { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe, ephemeral: !!m.message?.ephemeralMessage }
    );
    return true;
}

async function handleReaction(sock, m, from, sender, senderName) {
    const reactionMsg = m.message?.reactionMessage || m.message?.ephemeralMessage?.message?.reactionMessage;
    if (!reactionMsg) return false;
    if (isDashboardEnabled(from)) {
        const targetId = reactionMsg.key.id;
        const emoji = reactionMsg.text || '';
        const { handleReaction: handleDashReaction } = require('../services/dashboardStub');
        handleDashReaction(targetId, emoji, sender, senderName);
    }
    return true;
}

module.exports = {
    handleDashboardLog,
    handleProtocolMessage,
    handleReaction,
    safeDashboardLog,
    safeDashboardRememberGroup
};
