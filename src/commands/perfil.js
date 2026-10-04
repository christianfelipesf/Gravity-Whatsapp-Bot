const axios = require('axios');

// resolve @lid -> @s.whatsapp.net via metadados (profilePictureUrl costuma falhar com lid puro)
function resolvePhoneJid(target, participants) {
    if (!target || !Array.isArray(participants)) return null;
    const norm = String(target).split('@')[0].split(':')[0];
    for (const p of participants) {
        const cands = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean);
        for (const c of cands) {
            if (String(c).split('@')[0].split(':')[0] === norm) {
                if (p.id && p.id.endsWith('@s.whatsapp.net')) return p.id;
                if (p.jid && p.jid.endsWith('@s.whatsapp.net')) return p.jid;
                if (p.phoneNumber && String(p.phoneNumber).includes('@')) return String(p.phoneNumber);
            }
        }
    }
    return null;
}

function onlyDigits(s) {
    return String(s || '').replace(/\D/g, '');
}

// Normaliza número digitado em vários formatos:
// 5511999998888 | +55 11 99999-8888 | (11) 99999-8888 | 11 99999-8888 |
// 11999998888 | 11 98888-8888 | 0055... | @5511... | 55-11-99999-8888
// Retorna só dígitos com DDI (ex: '5511999998888') ou null se inválido.
function normalizePhoneInput(raw) {
    let d = onlyDigits(raw);
    if (!d) return null;
    // discagem internacional com 00 (ex: 0055...)
    if (d.startsWith('00') && d.length > 4) d = d.slice(2);
    // zero de tronco (ex: 0119...) — remove zeros à esquerda
    d = d.replace(/^0+/, '');
    if (!d) return null;
    if (d.length < 10) return null; // nem DDD+número tem
    if (d.length === 10 || d.length === 11) {
        // número nacional BR sem DDI (DDD + 8/9 dígitos) → assume 55
        return '55' + d;
    }
    if (d.length >= 7 && d.length <= 15) return d; // BR completo ou internacional
    return null;
}

function extractVcardInfo(vcard) {
    if (!vcard || typeof vcard !== 'string') return null;
    const waidM = vcard.match(/waid\s*=\s*(\d{7,15})/i);
    const fnM = vcard.match(/^FN[^:]*:(.+)$/im);
    const name = fnM ? String(fnM[1]).trim().slice(0, 30) : null;
    if (waidM) return { number: normalizePhoneInput(waidM[1]) || onlyDigits(waidM[1]), name };
    // fallback: primeiro TEL com dígitos
    const telM = vcard.match(/TEL[^:]*:([+\d\s().\-]+)/i);
    if (telM) {
        const n = normalizePhoneInput(telM[1]);
        if (n) return { number: n, name };
    }
    return null;
}

function unwrapMessage(msg) {
    let m = msg;
    for (let i = 0; i < 5 && m; i++) {
        if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
        else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
        else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
        else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
        else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
        else break;
    }
    return m;
}

// Contatos citados (responder um contato compartilhado com !perfil).
// Cobre contactMessage e contactsArrayMessage, com ou sem wrapper ephemeral/viewOnce.
function getQuotedContacts(qInfo) {
    try {
        const out = [];
        const qm0 = qInfo?.quotedMessage;
        if (!qm0) return out;
        const qm = unwrapMessage(qm0) || {};
        if (qm.contactMessage?.vcard) {
            const info = extractVcardInfo(qm.contactMessage.vcard);
            if (info?.number) out.push(info);
            else if (qm.contactMessage.displayName) out.push({ number: null, name: String(qm.contactMessage.displayName).slice(0, 30) });
        }
        const arr = qm.contactsArrayMessage?.contacts;
        if (Array.isArray(arr)) {
            for (const c of arr) {
                const info = extractVcardInfo(c?.vcard);
                if (info?.number && !out.some(o => o.number === info.number)) out.push(info);
            }
        }
        // contactShareMessage (alguns clientes usam esse nome)
        if (qm.contactShareMessage?.vcard) {
            const info = extractVcardInfo(qm.contactShareMessage.vcard);
            if (info?.number) out.push(info);
        }
        return out;
    } catch (_) { return []; }
}
function isImageBuffer(buf) {
    if (!buf || buf.length < 100) return false;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true; // jpeg
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // png
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // webp (RIFF....WEBP)
    return false;
}

async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).catch(() => null);
        if (!res || !res.data) return null;
        const buf = Buffer.from(res.data);
        return isImageBuffer(buf) ? buf : null;
    } catch (_) { return null; }
}

module.exports = {
    name: 'perfil',
    aliases: ['pp', 'profile'],
    category: 'geral',
    description: 'Exibe a foto de perfil + região/clima/país pelo número (DDD/DDI)',
    async execute(sock, m, { from, sender, config, utils, lastBotResponse, GLOBAL_COOLDOWN, args, fullArgsText }) {
        const { react, getBotName } = utils;
        let currentBotResponse = await react(sock, m, '👤', lastBotResponse, GLOBAL_COOLDOWN);

        try {
            // contextInfo pode estar em extendedText/image/video (resposta a contato, menção etc.)
            let qInfo = null;
            try {
                const media = require('../database/media');
                qInfo = (media.getContextInfo && media.getContextInfo(m.message)) || null;
            } catch (_) {}
            qInfo = qInfo || m.message?.extendedTextMessage?.contextInfo || null;
            const mentioned = qInfo?.mentionedJid?.[0] || null;

            // 1) contato compartilhado citado (responder o contato com !perfil)
            const quotedContacts = getQuotedContacts(qInfo);
            // contato enviado junto na própria mensagem (forward com legenda, alguns clientes)
            try {
                const cur = unwrapMessage(m.message) || {};
                if (cur.contactMessage?.vcard) {
                    const info = extractVcardInfo(cur.contactMessage.vcard);
                    if (info?.number && !quotedContacts.some(o => o.number === info.number)) quotedContacts.push(info);
                }
                const arr = cur.contactsArrayMessage?.contacts;
                if (Array.isArray(arr)) {
                    for (const c of arr) {
                        const info = extractVcardInfo(c?.vcard);
                        if (info?.number && !quotedContacts.some(o => o.number === info.number)) quotedContacts.push(info);
                    }
                }
            } catch (_) {}

            // 2) número digitado: !perfil 11999998888 | +55 11 99999-8888 | (11) 99999-8888 ...
            const rawTyped = String(fullArgsText || (Array.isArray(args) ? args.join(' ') : '') || '').trim();
            const typedDigits = normalizePhoneInput(rawTyped);
            if (rawTyped && !typedDigits && !mentioned && !quotedContacts.length && !qInfo?.participant) {
                const prefix = (config && config.prefix) || '!';
                await sock.sendMessage(from, {
                    text: `╭─── *👤 PERFIL* ───\n│ ❓ Número não reconhecido: *${rawTyped.slice(0, 40)}*\n│ 💡 *Use:*\n│ • *${prefix}perfil* (você)\n│ • *${prefix}perfil @pessoa* (menção)\n│ • *${prefix}perfil 11999998888*\n│ • *${prefix}perfil (11) 99999-8888*\n│ • *${prefix}perfil +55 11 99999-8888*\n│ • responda um contato compartilhado com *${prefix}perfil*\n╰───────────────`
                }, { quoted: m });
                return currentBotResponse;
            }

            let target = mentioned || qInfo?.participant || sender;
            let forcedPhone = null; // jid @s.whatsapp.net vindo de contato/arg
            let forcedName = null;  // FN do vcard
            if (!mentioned) {
                if (quotedContacts.length && quotedContacts[0].number) {
                    forcedPhone = `${quotedContacts[0].number}@s.whatsapp.net`;
                    forcedName = quotedContacts[0].name || null;
                    target = forcedPhone;
                } else if (typedDigits) {
                    // Dígitos de LID colado: converte p/ telefone real; se tem cara
                    // de LID (>=14 dígitos) e não resolve, rejeita em vez de montar JID falso.
                    let digits = typedDigits;
                    try {
                        const identity = require('../services/identity');
                        const r = await identity.resolveCandidateToPhone(sock, utils, typedDigits, from);
                        if (r.phone && r.phone !== typedDigits) digits = r.phone;
                        else if (typedDigits.length >= 14 && !r.resolvedFromLid) digits = null;
                    } catch (_) {}
                    if (!digits) {
                        const prefix = (config && config.prefix) || '!';
                        await sock.sendMessage(from, {
                            text: `╭─── *👤 PERFIL* ───\n│ ❓ Isso parece um ID interno (@lid), não um número.\n│ 💡 Use *${prefix}perfil @pessoa* ou digite o número com DDI+DDD.\n╰───────────────`
                        }, { quoted: m });
                        return currentBotResponse;
                    }
                    forcedPhone = `${digits}@s.whatsapp.net`;
                    target = forcedPhone;
                }
            }
            // tenta jid original + equivalente @s.whatsapp.net (caso @lid)
            let participants = [];
            try {
                if (from && from.endsWith('@g.us')) {
                    const meta = await utils.groupMetadataCached(sock, from).catch(() => null);
                    if (Array.isArray(meta?.participants)) participants = meta.participants;
                }
            } catch (_) {}
            const tries = [target];
            const phone = resolvePhoneJid(target, participants);
            if (phone && phone !== target) tries.push(phone);

            let ppBuffer = null;
            for (const t of tries) {
                try {
                    const url = await sock.profilePictureUrl(t, 'image').catch(() => null);
                    if (!url) continue;
                    ppBuffer = await fetchImageBuffer(url);
                    if (ppBuffer) break;
                } catch (_) { continue; }
            }

            const botName = getBotName(from, config || {});
            const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
            const GENERIC_NAMES = new Set(['usuario', 'usuário', 'utilizador', 'user', 'desconhecido', 'nao identificado', 'não identificado', 'null', 'undefined']);
            const cleanName = (n) => {
                const s = String(n || '').trim().slice(0, 30);
                if (s.length < 2) return null;
                if (GENERIC_NAMES.has(s.toLowerCase())) return null;
                if (!/[\p{L}]/u.test(s)) return null; // só dígitos/símbolos não é nome
                return s;
            };
            const phoneOf = (jid) => {
                if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
                const num = jid.split('@')[0].split(':')[0];
                return /^\d{8,15}$/.test(num) ? jid : null;
            };
            // Exibe nome real quando existe; senão o @número; nunca o genérico "Usuário"
            // (era isso que gerava o "Usuário: Usuário").
            const toDisplay = (jid, phoneJid, fallbackName) => {
                const name = cleanName(fallbackName);
                if (name) return name;
                const pj = phoneOf(phoneJid) || phoneOf(jid);
                if (pj) return `@${pj.split('@')[0].split(':')[0]}`;
                if (!isLid(jid)) {
                    const num = String(jid || '').split('@')[0].split(':')[0];
                    if (/^\d{8,15}$/.test(num)) return `@${num}`;
                }
                return 'não identificado';
            };
            // tenta pegar nome via pushName se disponível no m
            const pushName = m.pushName || null;
            const quotedName = qInfo?.pushName || null;
            // Telefone do remetente: sender pode vir como @lid — o nº real vem no Pn da chave
            const msgPn = m.key?.participantPn || m.key?.senderPn || null;
            const senderPhone = phoneOf(sender) || phoneOf(msgPn);
            const targetNorm = String(target || '').split('@')[0].split(':')[0];
            const senderNorm = String(sender || '').split('@')[0].split(':')[0];
            // Telefone do alvo: forçado (contato/arg) > metadados > próprio JID > Pn (só quando o alvo é o remetente)
            let targetPhone = forcedPhone || phone || phoneOf(target);
            if (!targetPhone && senderPhone && targetNorm && targetNorm === senderNorm) targetPhone = senderPhone;
            const targetDisplay = toDisplay(target, targetPhone, forcedName || quotedName || (targetNorm === senderNorm ? pushName : null));
            const senderDisplay = toDisplay(sender, senderPhone, pushName || null);
            const targetPhoneDigits = targetPhone ? String(targetPhone).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
            const senderPhoneDigits = senderPhone ? String(senderPhone).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
            const isSelf = targetPhoneDigits && senderPhoneDigits
                ? targetPhoneDigits === senderPhoneDigits
                : String(target || '').split('@')[0] === String(sender || '').split('@')[0];

            // Região / clima / país pelo número (DDD cobre a área, não a cidade exata)
            let regiaoLines = [];
            try {
                const { getRegiaoInfo, formatRegiaoLines } = require('../services/regiao');
                const numJid = targetPhone || ((typeof target === 'string' && target.endsWith('@s.whatsapp.net')) ? target : null);
                const digits = numJid ? String(numJid).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
                regiaoLines = formatRegiaoLines(digits ? getRegiaoInfo(digits) : null);
            } catch (_) { regiaoLines = []; }
            const regiaoBlock = regiaoLines.length ? `\n${regiaoLines.join('\n')}` : '';

            // visual igual ao de mídia convertida (╭─── / │ / ╰───────────────)
            const caption = isSelf
                ? `╭─── *👤 PERFIL* ───\n` +
                  `│ 👤 *Usuário:* ${targetDisplay}${regiaoBlock}\n` +
                  `│ 🤖 *Por:* ${botName}\n` +
                  `╰───────────────`
                : `╭─── *👤 PERFIL* ───\n` +
                  `│ 👤 *Usuário:* ${targetDisplay}${regiaoBlock}\n` +
                  `│ 👥 *Solicitado por:* ${senderDisplay}\n` +
                  `│ 🤖 *Por:* ${botName}\n` +
                  `╰───────────────`;

            const _mentions = isSelf ? [target, targetPhone] : [target, targetPhone, sender, senderPhone];
            const mentions = [...new Set(_mentions.filter(Boolean))];

            if (!ppBuffer) {
                await sock.sendMessage(from, {
                    text: caption + `\n│ 🖼️ *Foto:* sem foto visível (privada ou inexistente) 🙈`,
                    mentions
                }, { quoted: m });
                return currentBotResponse;
            }

            await sock.sendMessage(from, {
                image: ppBuffer,
                caption,
                mentions
            }, { quoted: m });
        } catch (e) {
            currentBotResponse = await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }

        return currentBotResponse;
    }
};

// helpers expostos p/ teste (não afeta o loader)
module.exports._helpers = { normalizePhoneInput, extractVcardInfo, getQuotedContacts, unwrapMessage, onlyDigits };
