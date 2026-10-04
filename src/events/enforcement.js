const { getGroupData, isMuted, botIsAdmin, isUserAdmin, getAdmins, normalizeJid, setGroupData, recordModEvent } = require('../database/utils');
const { enforceAntiflood } = require('../services/antiflood');
const identity = require('../services/identity');

// Cache do nome do grupo do convite (código -> { subject, at). Evita 1 lookup
// de rede por repost do mesmo link. TTL 5min.
const _inviteSubjectCache = new Map();
const INVITE_CACHE_TTL = 5 * 60 * 1000;

function _extractInviteCode(text) {
    try {
        const m = String(text || '').match(/chat\.whatsapp\.com\/([a-zA-Z0-9]{10,})/);
        return m ? m[1] : null;
    } catch (_) { return null; }
}

async function _resolveInviteSubject(sock, code) {
    if (!code) return null;
    try {
        const hit = _inviteSubjectCache.get(code);
        if (hit && Date.now() - hit.at < INVITE_CACHE_TTL) return hit.subject;
    } catch (_) {}
    try {
        if (sock && typeof sock.groupGetInviteInfo === 'function') {
            const info = await Promise.race([
                sock.groupGetInviteInfo(code),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
            ]);
            const subject = info?.subject || info?.groupSubject || null;
            if (subject) {
                try {
                    _inviteSubjectCache.set(code, { subject: String(subject), at: Date.now() });
                    if (_inviteSubjectCache.size > 100) {
                        const first = _inviteSubjectCache.keys().next().value;
                        _inviteSubjectCache.delete(first);
                    }
                } catch (_) {}
                return String(subject);
            }
        }
    } catch (_) {}
    return null;
}

async function _currentGroupName(sock, from) {
    try {
        const { groupMetadataCached } = require('../database/utils');
        if (typeof groupMetadataCached === 'function') {
            const meta = await groupMetadataCached(sock, from).catch(() => null);
            if (meta?.subject) return String(meta.subject);
        }
    } catch (_) {}
    return null;
}

async function enforceMuteAndAntilink(sock, m, from, sender, text) {
    // Dono (aparelho do bot) nunca é bloqueado: senão comandos do próprio
    // número caem em 'muted'/'antiflood' silencioso e parecem "ignorados".
    // fromMe é a fonte da verdade; isBotOwner cobre LID/PN divergente.
    try {
        if (m?.key?.fromMe === true) return null;
        const { isBotOwner } = require('../database/utils');
        if (typeof isBotOwner === 'function' && isBotOwner(sock, m, sender)) return null;
    } catch (_) {}
    const groupData = getGroupData(from);
    const utilsRef = require('../database/utils');
    const adminsRaw = await getAdmins(sock, from);
    const senderNorm = normalizeJid(sender);
    const senderUser = senderNorm.split('@')[0];
    const isSenderAdmin = adminsRaw.some(p => {
        const candidates = [p.id, p.jid, p.lid].filter(Boolean).map(j => utilsRef.normalizeJid(j));
        return candidates.some(c => c.split('@')[0] === senderUser);
    });
    const isBotAdmin = await botIsAdmin(sock, from);

    // Mute vale em qualquer formato (telefone<->LID) via chaves da mensagem (sem rede).
    let mutedHit = false;
    try {
        const utilsRef2 = require('../database/utils');
        if (typeof utilsRef2.isMutedAny === 'function') {
            mutedHit = utilsRef2.isMutedAny(from, identity.messageAliasKeys(m, sender).jids);
        } else {
            mutedHit = isMuted(from, sender);
        }
    } catch (_) { mutedHit = false; }
    if (!isSenderAdmin && mutedHit) {
        if (isBotAdmin) {
            try { await sock.sendMessage(from, { delete: m.key }); } catch (delErr) { console.error('❌ Falha ao apagar mensagem de mutado:', delErr.message); }
            try { recordModEvent(from, 'spam'); } catch (_) {}
        }
        return 'muted';
    }

    if (groupData.antilink && !isSenderAdmin && isBotAdmin) {
        const groupLinkRegex = /chat\.whatsapp\.com\/[a-zA-Z0-9]/;
        if (groupLinkRegex.test(text)) {
            try {
                await sock.sendMessage(from, { delete: m.key });
            } catch (delErr) {
                // Bot perdeu admin em corrida: não aborta o handler, só loga.
                console.error('❌ Falha ao apagar mensagem de antilink:', delErr?.message || delErr);
                return 'antilink';
            }
            try { recordModEvent(from, 'spam'); } catch (_) {}
            if (!groupData.warnings) groupData.warnings = {};
            // Advertência nas chaves telefone+LID (leitura gratuita, sem rede).
            const wKeys = identity.messageAliasKeys(m, sender).jids;
            const count = identity.warnCount(groupData.warnings, wKeys) + 2;
            identity.warnSetAll(groupData.warnings, wKeys, count);
            setGroupData(from, groupData);
            // Rótulo seguro (nome > telefone; nunca LID cru).
            let who = 'membro';
            try {
                const utilsFull = require('../database/utils');
                who = await identity.personLabel(sock, utilsFull, from, sender).catch(() => 'membro');
            } catch (_) {}
            // Detalhe do convite: qual grupo estavam divulgando + onde.
            // Lookup com fallback — convite revogado/expirado não quebra o aviso.
            let inviteName = null;
            try { inviteName = await _resolveInviteSubject(sock, _extractInviteCode(text)); } catch (_) {}
            let hereName = null;
            try { hereName = await _currentGroupName(sock, from); } catch (_) {}
            const invitePart = inviteName ? ` do grupo "*${inviteName}"` : ' de grupo';
            const herePart = hereName ? ` aqui em "*${hereName}"` : '';
            if (count >= 3) {
                try {
                    await sock.groupParticipantsUpdate(from, [sender], 'remove');
                } catch (rmErr) {
                    console.error('❌ Falha ao remover por antilink:', rmErr?.message || rmErr);
                    return 'antilink';
                }
                try {
                    const gd2 = getGroupData(from) || {};
                    if (gd2.warnings) { identity.warnDeleteAll(gd2.warnings, wKeys); setGroupData(from, gd2); }
                } catch (_) {}
                try { await sock.sendMessage(from, { text: `🚫 ${who} enviou link${invitePart}${herePart}, atingiu ${count}/3 advertências e foi banido.`, mentions: [sender] }); } catch (_) {}
            } else {
                try { await sock.sendMessage(from, { text: `⚠️ ${who} enviou link${invitePart}${herePart} e recebeu advertência. (${count}/3)`, mentions: [sender] }); } catch (_) {}
            }
            return 'antilink';
        }
    }

    // Antiflood (respeita flag de admin)
    const flood = await enforceAntiflood(sock, m, from, sender, isSenderAdmin, isBotAdmin);
    if (flood) { try { recordModEvent(from, 'spam'); } catch (_) {} return flood; }

    return null;
}

module.exports = { enforceMuteAndAntilink };
