const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

const DOWNLOAD_TIMEOUT = Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS) || 30000;

const { withTimeout } = require('../services/timeout');

function downloadWithTimeout(msg, opts, timeoutMs = DOWNLOAD_TIMEOUT) {
    // Baileys downloadMediaMessage não aceita AbortSignal — o download órfão
    // não pode ser cancelado de verdade. O que corrigimos aqui vs. versão
    // anterior (Promise.race + dl.catch(()=>{})):
    // 1) timer sempre limpo (sem leak), 2) erro tipado TimeoutError,
    // 3) rejeição da perdedora preservada (sem engolir 404/rate-limit),
    // 4) warn quando o órfão termina após o timeout (vazamento visível).
    const label = `download-mídia ${msg?.key?.id || '?'}`;
    let timedOut = false;
    const dl = downloadMediaMessage(msg, 'buffer', {}, opts).then(
        (buf) => {
            if (timedOut) console.warn(`⚠️ [REVELAR] ${label} concluiu após timeout (órfão, ${buf?.length || 0} bytes descartados)`);
            if (!buf || buf.length === 0) throw new Error('download-vazio');
            return buf;
        },
        (e) => {
            const clean = String(e?.message || e).slice(0, 150);
            if (timedOut) console.warn(`⚠️ [REVELAR] ${label} falhou após timeout (órfão): ${clean}`);
            throw new Error(`download-falhou: ${clean}`);
        }
    );
    const wrapped = withTimeout(dl, timeoutMs, label);
    wrapped.catch(() => { timedOut = true; });
    return wrapped;
}
const {
    getMediaMessage, react, reactStatus, isViewOnce, getMessageText,
    stickerToMedia, getBotName, mediaToSticker,
    changeSpeed, mediaToGif, mediaToGifVideo,
    isDashboardEnabled, groupMetadataCached, getGroupParticipantName,
    getGroupData, canUseViewOnce, viewOnceBlockedMessage, getThemeForJid
} = require('../database/utils');
const { getTheme } = require('../services/themes');
const stickerLog = (()=>{ try{ return require('../services/stickerLog'); }catch(_){ return null; } })();
const { withChannelContext } = require('../services/channelPromo');

function isLidJid(jid) { return typeof jid === 'string' && jid.endsWith('@lid'); }
function resolveDisplayNum(jid, fallbackPn) {
    if (!jid) return null;
    if (isLidJid(jid)) {
        if (fallbackPn && String(fallbackPn).endsWith('@s.whatsapp.net')) {
            const p = String(fallbackPn).split('@')[0].split(':')[0];
            if (/^\d{8,15}$/.test(p)) return p;
        }
        return null;
    }
    const p = String(jid).split('@')[0].split(':')[0];
    if (/^\d{8,15}$/.test(p)) return p;
    return null;
}

async function revealViewOnce(sock, from, m, lastBotResponse, GLOBAL_COOLDOWN, explicitOpts = {}) {
    const sender = m.key.participant || m.key.remoteJid;
    const explicitName = explicitOpts.senderName || null;
    try {
        const mediaMessage = getMediaMessage(m.message);
        if (!mediaMessage) return lastBotResponse;
        const isVideo = !!mediaMessage.videoMessage;
        const isAudio = !!mediaMessage.audioMessage;
        const originalCaption = mediaMessage.imageMessage?.caption || mediaMessage.videoMessage?.caption || '';

        lastBotResponse = await react(sock, m, '👀', lastBotResponse, GLOBAL_COOLDOWN);

        // Usa a mensagem COM wrapper (m.message) — o download desembrulha
        // sozinho e o reupload precisa do contexto original da view-once.
        let buffer = await downloadWithTimeout(
            { key: m.key, message: m.message },
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        ).catch(() => null);
        // Fallback DM: inverte fromMe uma vez (chave citada em privado nem
        // sempre indica o autor; palpite trocado = reupload 404).
        if (!buffer && m?.key && typeof from === 'string' && !from.endsWith('@g.us')) {
            try {
                const flipKey = { ...m.key, fromMe: !m.key.fromMe };
                buffer = await downloadWithTimeout(
                    { key: flipKey, message: m.message },
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                ).catch(() => null);
                if (buffer) m.key = flipKey;
            } catch (_) { /* mantém null */ }
        }

        if (!buffer) {
            try {
                const hasMedia = !!mediaMessage;
                const keys = m?.message ? Object.keys(m.message).join(',') : 'sem-message';
                console.warn(`⚠️ [REVELAR] download falhou from=${from} hasMedia=${hasMedia} keys=${keys} keyId=${m?.key?.id || '?'} fromMe=${!!m?.key?.fromMe} temParticipant=${!!m?.key?.participant}`);
            } catch (_) {}
            return await reactStatus(sock, m, from, false, '🔓', '❌', lastBotResponse, GLOBAL_COOLDOWN);
        }

        let pushForLookup = m.pushName || null;
        if (!pushForLookup && explicitName && explicitOpts.senderJid && sender === explicitOpts.senderJid) {
            pushForLookup = explicitName;
        } else if (!pushForLookup && explicitName && !explicitOpts.senderJid) {
            pushForLookup = explicitName;
        }
        let senderName = await getGroupParticipantName(sock, from, sender, pushForLookup);
        if (!senderName || senderName === 'Usuário') {
            senderName = 'Usuário';
        }
        // visual igual ao de mídia convertida (╭─── / │ / ╰───────────────)
        const botNameForReveal = (() => {
            try {
                const cfg = explicitOpts.config || require('../database/utils').readConfig();
                return getBotName(from, cfg);
            } catch (_) { return 'Bot'; }
        })();
        const fallbackPnReveal = m.key?.participantPn || m.key?.senderPn || null;
        const resolvedNumReveal = resolveDisplayNum(sender, fallbackPnReveal);
        const displayReveal = (senderName && !['usuario','usuário'].includes(String(senderName).trim().toLowerCase()))
            ? String(senderName).trim().slice(0,30)
            : (resolvedNumReveal ? `@${resolvedNumReveal}` : 'Usuário');
        const captionLegenda = originalCaption ? String(originalCaption).trim().slice(0, 900) : '';
        let revealCaption;
        if (captionLegenda) {
            revealCaption = `╭─── *🔓 MÍDIA REVELADA* ───\n` +
                `│ 👤 *De:* ${displayReveal}\n` +
                `│ 🤖 *Por:* ${botNameForReveal}\n` +
                `│ 💬 *Legenda:* ${captionLegenda}\n` +
                `╰───────────────`;
        } else {
            revealCaption = `╭─── *🔓 MÍDIA REVELADA* ───\n` +
                `│ 👤 *De:* ${displayReveal}\n` +
                `│ 🤖 *Por:* ${botNameForReveal}\n` +
                `╰───────────────`;
        }
        const revealConfig = explicitOpts.config || null;
        const opts = { quoted: m };

        const dashboardOn = isDashboardEnabled(from);
        const groupMetadata = from.endsWith('@g.us') ? await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' })) : { subject: 'Privado' };
        const mediaType = isAudio ? 'audio' : (isVideo ? 'video' : 'image');

        if (dashboardOn) {
            const dataBase64 = buffer.toString('base64');
            const mime = isAudio ? 'audio/mp4' : (isVideo ? 'video/mp4' : 'image/jpeg');
            const store = require('../history/store');
            let mediaInfo;
            try {
                mediaInfo = store.persistReceivedMedia(
                    { type: mediaType, url: `data:${mime};base64,${dataBase64}` },
                    m.key?.id
                );
            } catch (_) {
                // Fallback sem base64: embedar o data: URL aqui gravaria
                // centenas de KB no media_json do banco (foi o bug dos 47MB).
                mediaInfo = { type: mediaType, url: null };
            }

            const phoneReveal = resolveDisplayNum(sender, fallbackPnReveal) || null;
            store.writeLog('action', groupMetadata.subject, `Mídia Revelada (${mediaType})`, senderName, phoneReveal, mediaInfo, { toJid: from, messageId: m.key?.id, senderJid: sender, fromMe: !!m.key?.fromMe, hidden: true });
        }

        if (isAudio) await sock.sendMessage(from, withChannelContext({ audio: buffer, mimetype: 'audio/mp4', ptt: true, mentions: [sender] }, revealConfig), opts);
        else if (isVideo) await sock.sendMessage(from, withChannelContext({ video: buffer, caption: revealCaption, mentions: [sender] }, revealConfig), opts);
        else await sock.sendMessage(from, withChannelContext({ image: buffer, caption: revealCaption, mentions: [sender] }, revealConfig), opts);

        return await reactStatus(sock, m, from, true, '🔓', '❌', lastBotResponse, GLOBAL_COOLDOWN);
    } catch (error) {
        return await reactStatus(sock, m, from, false, '🔓', '❌', lastBotResponse, GLOBAL_COOLDOWN);
    }
}

function buildConvertedCaption(senderJid, botName, senderName, fallbackPn) {
    const bot = botName || 'Bot';
    const isGeneric = (n) => !n || ['usuario','usuário'].includes(String(n).trim().toLowerCase());
    let display = null;
    if (senderName && !isGeneric(senderName)) display = String(senderName).trim().slice(0,30);
    if (!display) {
        const num = resolveDisplayNum(senderJid, fallbackPn);
        display = num ? `@${num}` : 'Usuário';
    } else {
        // nome já resolve — sem @, evita número aleatório de LID
        display = display;
    }
    // Se display é @numero, mantém @; se é nome, sem @
    const line = `│ 👤 *Solicitado por:* ${display}`;
    return `╭─── *📱 MÍDIA CONVERTIDA* ───\n${line}\n│ 🤖 *Por:* ${bot}\n╰───────────────`;
}

async function shouldBlockViewOnceReuse({ sock, from, requesterMsg, quotedMsg, quotedParticipant, action, deps = {} }) {
    if (action === 'reveal' || !quotedMsg) return { blocked: false, reason: null };
    const _isViewOnce = deps.isViewOnce || isViewOnce;
    const _getMessageText = deps.getMessageText || getMessageText;
    const _canUseViewOnce = deps.canUseViewOnce || canUseViewOnce;
    let kind = null;
    if (_isViewOnce(quotedMsg)) {
        kind = 'viewonce';
    } else {
        try {
            const meNum = String(sock?.user?.id || '').split(':')[0].split('@')[0];
            const qpNum = String(quotedParticipant || '').split(':')[0].split('@')[0];
            const cap = _getMessageText(quotedMsg) || '';
            if (meNum && qpNum && meNum === qpNum && cap.includes('MÍDIA REVELADA')) kind = 'revealed-copy';
        } catch (_) { /* sem marcador = foto normal */ }
    }
    if (!kind) return { blocked: false, reason: null };
    try {
        const allowed = await _canUseViewOnce(sock, from, requesterMsg);
        if (!allowed) return { blocked: true, reason: kind };
    } catch (_) { /* em erro mantém liberado (padrão anterior) */ }
    return { blocked: false, reason: null };
}

async function handleMediaCommand(sock, from, m, action, config, lastBotResponse, GLOBAL_COOLDOWN, speedOrOpts = 1.0) {
    let speed = 1.0;
    let explicitOpts = {};
    // Reações seguem o tema do grupo (global > padrão): ex. 🎃 no halloween.
    let okEmoji = '✅', errEmoji = '❌';
    try {
        const theme = getTheme(typeof getThemeForJid === 'function' ? getThemeForJid(from) : 'default');
        okEmoji = theme.ok || okEmoji;
        errEmoji = theme.err || errEmoji;
    } catch (_) {}
    if (typeof speedOrOpts === 'object' && speedOrOpts !== null) {
        explicitOpts = speedOrOpts;
        speed = explicitOpts.speed ?? 1.0;
    } else {
        speed = speedOrOpts;
    }
    try {
        let mediaMessage = null;
        const quotedInfo = m.message.extendedTextMessage?.contextInfo;
        const quotedMsg = quotedInfo?.quotedMessage;
        let targetMsg = null;

        if (quotedMsg) {
            mediaMessage = getMediaMessage(quotedMsg);
            if (mediaMessage) {
                const stanzaId = quotedInfo.stanzaId;
                const isGroupChat = typeof from === 'string' && from.endsWith('@g.us');
                let key;
                if (isGroupChat) {
                    // Grupo: participant é obrigatório e vem no contextInfo.
                    key = {
                        remoteJid: from,
                        id: stanzaId,
                        participant: quotedInfo.participant || from
                    };
                    // fromMe só true se a citada foi enviada pelo próprio bot.
                    try {
                        const meNum = String(sock?.user?.id || '').split(':')[0].split('@')[0];
                        const qpNum = String(quotedInfo.participant || '').split(':')[0].split('@')[0];
                        if (meNum && qpNum && meNum === qpNum) key.fromMe = true;
                        else key.fromMe = false;
                    } catch (_) { key.fromMe = false; }
                } else {
                    // Privado (DM / LID): participant DEVE ser omitido.
                    // Com participant setado (= from) o reupload (updateMediaMessage)
                    // falha e o download da view-once retorna 404/timeout.
                    // Por isso em grupo funcionava e no privado não.
                    let fromMe = false;
                    try {
                        const meRaw = String(sock?.user?.id || '').split(':')[0];
                        const meNum = meRaw.split('@')[0];
                        const qpRaw = String(quotedInfo.participant || '').split(':')[0];
                        const qpNum = qpRaw.split('@')[0];
                        if (qpNum && meNum && qpNum === meNum) fromMe = true;
                        // Sem participant no contextInfo (comum em DM): assume
                        // mensagem do outro lado (fromMe=false) — caso mais
                        // comum do !revelar no privado (usuário cita o próprio
                        // view-once enviado ao bot/sub).
                        else fromMe = false;
                    } catch (_) { fromMe = false; }
                    key = { remoteJid: from, id: stanzaId, fromMe };
                }
                targetMsg = {
                    key,
                    // Passa a mensagem CITADA COM o wrapper viewOnce/ephemeral,
                    // não só o imageMessage desembrulhado: o downloadMediaMessage
                    // desembrulha sozinho e o reupload precisa do contexto original.
                    message: quotedMsg,
                    pushName: quotedInfo.pushName
                };
            }
        } else {
            mediaMessage = getMediaMessage(m.message);
            if (mediaMessage) targetMsg = m;
        }

        if (!mediaMessage || !targetMsg) {
            return await reactStatus(sock, m, from, false, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
        }

        const isSticker = !!mediaMessage.stickerMessage;
        // Trava revealAdminOnly: view-once reaproveitada via sticker/toimg/
        // togif/speed também exige admin (senão o !revelar seria burlado).
        // Vale p/ o original (wrapper viewOnce) e p/ a cópia revelada pelo bot.
        if (action !== 'reveal') {
            try {
                const gate = await shouldBlockViewOnceReuse({
                    sock, from, requesterMsg: m,
                    quotedMsg: quotedMsg || targetMsg.message,
                    quotedParticipant: quotedInfo?.participant, action
                });
                if (gate.blocked) {
                    console.warn(`🔒 [viewonce-gate] bloqueado from=${from} action=${action} kind=${gate.reason}`);
                    try { await sock.sendMessage(from, { text: viewOnceBlockedMessage() }, { quoted: m }); } catch (_) {}
                    return await reactStatus(sock, m, from, false, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
                }
            } catch (_) { /* em erro mantém liberado (padrão) */ }
        }

        lastBotResponse = await react(sock, m, '⏳', lastBotResponse, GLOBAL_COOLDOWN);

        if (action === 'reveal') {
            // Reveal faz o próprio download (1x só) — evita download duplo.
            const revealOpts = { ...explicitOpts, config };
            return await revealViewOnce(sock, from, targetMsg, lastBotResponse, GLOBAL_COOLDOWN, revealOpts);
        }

        let buffer = null;
        try {
            buffer = await downloadWithTimeout(
                targetMsg,
                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
        } catch (_) { buffer = null; }
        // Fallback DM: inverte fromMe uma vez (quoted sem participant não diz
        // quem enviou; o palpite inicial pode estar trocado e o reupload falha).
        if (!buffer && targetMsg?.key && typeof from === 'string' && !from.endsWith('@g.us')) {
            try {
                targetMsg.key = { ...targetMsg.key, fromMe: !targetMsg.key.fromMe };
                buffer = await downloadWithTimeout(
                    targetMsg,
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
            } catch (_) { buffer = null; }
        }

        if (!buffer) throw new Error('download-falhou');

        // caption padrão para mídias convertidas (estilo menu) — usa nome, evita LID aleatório
        const senderJid = m.key.participant || m.key.remoteJid || from;
        const fallbackPn = m.key?.participantPn || m.key?.senderPn || null;
        const senderNameForCaption = m.pushName || null;
        const botNameForCaption = getBotName(from, config);
        const captionConvertido = buildConvertedCaption(senderJid, botNameForCaption, senderNameForCaption, fallbackPn);

        if (action === 'toimg') {

            if (isSticker) {
                console.log(`[STICKER-LOG] handleMediaCommand toimg isAnimated=${!!mediaMessage.stickerMessage.isAnimated} quotedBuffer=${buffer.length} bytes`);
                const converted = await stickerToMedia(buffer, !!mediaMessage.stickerMessage.isAnimated);
                console.log(`[STICKER-LOG] handleMediaCommand toimg converted mime=${converted.mime} bytes=${converted.buffer.length}`);
                await sock.sendMessage(from, withChannelContext({ [converted.mime.startsWith('image/') ? 'image' : 'video']: converted.buffer, caption: captionConvertido }, config), { quoted: m });
            } else {
                await sock.sendMessage(from, withChannelContext({ [mediaMessage.imageMessage ? 'image' : 'video']: buffer, caption: captionConvertido }, config), { quoted: m });
            }
        } else if (action === 'sticker') {
            if (isSticker) {
                const converted = await stickerToMedia(buffer, !!mediaMessage.stickerMessage.isAnimated);
                await sock.sendMessage(from, withChannelContext({ [converted.mime.startsWith('image/') ? 'image' : 'video']: converted.buffer, caption: captionConvertido }, config), { quoted: m });
            } else {
                const detectedMime = mediaMessage.videoMessage
                    ? (mediaMessage.videoMessage.mimetype || 'video/mp4')
                    : (mediaMessage.imageMessage?.mimetype || 'image/jpeg');
                // pack/author: 1) explícito via !s pack/autor, 2) per-grupo se configurado, 3) fallback requester/bot
                // Antes buscava getStickerPackForJid que sempre retorna "Gravity Bot🪐" (global default) e mascarava pushName
                let pack = explicitOpts.pack || null;
                let author = explicitOpts.author || null;
                let packSource = explicitOpts.pack ? 'explicit' : null;
                let authorSource = explicitOpts.author ? 'explicit' : null;
                if (!pack) {
                    try {
                        const gd = getGroupData(from);
                        if (gd && gd.stickerPack) { pack = String(gd.stickerPack).slice(0, 30) || null; packSource = 'group'; }
                    } catch (_) {}
                }
                if (!author) {
                    try {
                        const gd = getGroupData(from);
                        if (gd && gd.stickerAuthor) { author = String(gd.stickerAuthor).slice(0, 30) || null; authorSource = 'group'; }
                    } catch (_) {}
                }
                if (!pack) { pack = (m.pushName || 'Usuário').slice(0, 30) || 'Usuário'; packSource = m.pushName ? 'fallback:pushName' : 'fallback:Usuário'; }
                if (!author) { author = getBotName(from, config); authorSource = 'fallback:botName'; }
                const requesterName = pack;
                const botName = author;
                const _stickerStart = Date.now();
                let _stickerSuccess = false;
                let _stickerError = null;
                let _stickerOutputBytes = 0;
                let _stickerExifLen = 0;
                const _quotedSender = quotedInfo?.participant || null;
                const _mediaType = mediaMessage.videoMessage ? 'video' : (mediaMessage.imageMessage ? 'image' : 'unknown');
                // pega nome do grupo para log
                let _groupName = null;
                try { const gm = await groupMetadataCached(sock, from).catch(()=>null); _groupName = gm?.subject || null; } catch(_){}
                try {
                    console.log(`[STICKER-LOG] handleMediaCommand sticker input mime=${detectedMime} bytes=${buffer.length} from=${from} by=${requesterName} pack="${pack}" author="${author}" explicit=${JSON.stringify(explicitOpts)}`); 
                    const stickerBuffer = await mediaToSticker(buffer, detectedMime, pack, author);
                    console.log(`[STICKER-LOG] handleMediaCommand sticker gerado ${stickerBuffer.length} bytes header=${stickerBuffer.slice(0,4).toString()} WEBP=${stickerBuffer.slice(8,12).toString()}`);
                    try { const { Image } = require('node-webpmux'); const im = new Image(); await im.load(stickerBuffer); _stickerExifLen = im.exif ? im.exif.length : 0; } catch(_){}
                    _stickerSuccess = true;
                    _stickerOutputBytes = stickerBuffer.length;
                    // log dedicado para diagnóstico de pack vazio (imagem vs vídeo)
                    try {
                        const emptyPack = !pack || !String(pack).trim();
                        const emptyAuthor = !author || !String(author).trim();
                        if (emptyPack || emptyAuthor) console.warn(`⚠️ [STICKER-HISTORY] pack/author vazio detectado! pack="${pack}" author="${author}" mediaType=${_mediaType} mime=${detectedMime} explicit=${JSON.stringify(explicitOpts)} pushName="${m.pushName}" groupPack="${(() => { try{ return getGroupData(from).stickerPack||'' }catch{return ''}})()}"`);
                    } catch(_){}
                    try {
                        if (stickerLog) stickerLog.logSticker({
                            from, groupName: _groupName, senderJid: m.key.participant || m.key.remoteJid, senderName: m.pushName || null, quotedSender: _quotedSender,
                            mediaType: _mediaType, mime: detectedMime, detectedMime,
                            pack, author, packSource, authorSource, explicitOpts,
                            inputBytes: buffer.length, outputBytes: _stickerOutputBytes, exifLen: _stickerExifLen,
                            success: true, tempId: null, durationMs: Date.now()-_stickerStart
                        });
                    } catch(_){}
                    if (!stickerBuffer || stickerBuffer.length < 64) throw new Error('Sticker gerado vazio');
                    if (stickerBuffer.length > 1024 * 1024) throw new Error('Sticker muito grande (>1MB)');
                    const header = Buffer.isBuffer(stickerBuffer) ? stickerBuffer.slice(0, 12) : null;
                    if (header && (header.slice(0, 4).toString() !== 'RIFF' || header.slice(8, 12).toString() !== 'WEBP')) {
                        throw new Error('Sticker gerado inválido');
                    }
                    await sock.sendMessage(from, withChannelContext({ sticker: stickerBuffer }, config), { quoted: m });
                    return await reactStatus(sock, m, from, true, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
                } catch (stickerErr) {
                    _stickerError = stickerErr.message;
                    _stickerSuccess = false;
                    try {
                        if (stickerLog) stickerLog.logSticker({
                            from, groupName: _groupName, senderJid: m.key.participant || m.key.remoteJid, senderName: m.pushName || null, quotedSender: _quotedSender,
                            mediaType: _mediaType, mime: detectedMime, detectedMime,
                            pack, author, packSource, authorSource, explicitOpts,
                            inputBytes: buffer.length, outputBytes: _stickerOutputBytes, exifLen: _stickerExifLen,
                            success: false, error: _stickerError, durationMs: Date.now()-_stickerStart
                        });
                    } catch(_){}
                    console.error('❌ [STICKER] Falha ao gerar:', stickerErr.message);
                    await sock.sendMessage(from, { text: '❌ Não foi possível gerar o sticker desse vídeo. Tente outro ou envie uma imagem.' }, { quoted: m });
                    throw stickerErr;
                }
            }
        } else if (action === 'togif') {
            const isSticker = !!mediaMessage.stickerMessage;
            if (!isSticker && !mediaMessage.videoMessage) {
                await sock.sendMessage(from, { text: '❌ Marque um vídeo ou sticker animado.' }, { quoted: m });
                return lastBotResponse;
            }
            // Detecta sticker animado de verdade (ANIM chunk) — estático falha de forma silenciosa antes
            let isAnimatedSticker = !!mediaMessage.stickerMessage?.isAnimated;
            try { if (isSticker && buffer && buffer.includes(Buffer.from('ANIM'))) isAnimatedSticker = true; } catch (_) {}
            if (isSticker && !isAnimatedSticker) {
                await sock.sendMessage(from, { text: '❌ Esse sticker é estático. Use *!toimg* para converter estáticos e *!togif* apenas em stickers animados/vídeos.' }, { quoted: m });
                return await reactStatus(sock, m, from, false, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
            }
            const mimeType = isSticker ? 'sticker/webp' : (mediaMessage.videoMessage?.mimetype || 'video/mp4');
            let gifVideo;
            try {
                gifVideo = await mediaToGifVideo(buffer, mimeType);
            } catch (e) {
                console.error(`❌ [TOGIF] mediaToGifVideo falhou isSticker=${isSticker} mime=${mimeType} bytes=${buffer.length} err=${e.message}`);
                const msg = String(e.message||'');
                if (msg.includes('muito grande')) await sock.sendMessage(from, { text: '❌ Mídia muito grande (max 20MB).' }, { quoted: m });
                else if (msg.includes('timeout')) await sock.sendMessage(from, { text: '❌ Tempo esgotado ao converter. Tente um vídeo mais curto.' }, { quoted: m });
                else if (msg.includes('sem frames')) await sock.sendMessage(from, { text: '❌ Não consegui ler os frames desse sticker. Tente outro.' }, { quoted: m });
                else await sock.sendMessage(from, { text: `❌ Falha ao converter para GIF: ${msg.slice(0,120)}` }, { quoted: m });
                throw e;
            }
            await sock.sendMessage(from, withChannelContext({ video: gifVideo, gifPlayback: true, mimetype: 'video/mp4', caption: captionConvertido }, config), { quoted: m });
        } else if (action === 'speed') {
            if (!mediaMessage.videoMessage && !mediaMessage.audioMessage) {
                await sock.sendMessage(from, { text: '❌ Marque um vídeo ou áudio.' }, { quoted: m });
                return lastBotResponse;
            }
            const processed = await changeSpeed(buffer, mediaMessage.videoMessage ? 'video/mp4' : 'audio/mp4', speed);
            if (mediaMessage.videoMessage) await sock.sendMessage(from, withChannelContext({ video: processed, caption: captionConvertido }, config), { quoted: m });
            else await sock.sendMessage(from, withChannelContext({ audio: processed, mimetype: 'audio/ogg; codecs=opus', ptt: true }, config), { quoted: m });
        }

        return await reactStatus(sock, m, from, true, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
    } catch (error) {
        console.error(`❌ [handleMediaCommand:${action}] erro: ${error.message} | stack=${error.stack?.split('\n')[1]?.trim()||''}`);
        try { require('../history/store').writeLog('error', 'MÍDIA', `❌ ${action} falhou: ${error.message.slice(0,180)}`, 'Sistema', '—'); } catch (_) {}
        return await reactStatus(sock, m, from, false, okEmoji, errEmoji, lastBotResponse, GLOBAL_COOLDOWN);
    }
}

module.exports = { revealViewOnce, handleMediaCommand, shouldBlockViewOnceReuse };
