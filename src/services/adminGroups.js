// ============================================================
// adminGroups.js — grupos onde o bot é admin.
// Fonte única para !redegravity e !sortear.
//
// Dois problemas que este módulo resolve:
// 1) groupFetchAllParticipating nem sempre lista tudo (cache do socket)
//    -> une várias fontes locais (ativos, parcial, news, dashboard).
// 2) O bot pode aparecer como admin sob outra identidade (LID x número):
//    getBotJid só testa sock.user.id. Aqui testamos id + lid + jid.
// ============================================================

function _userOf(jid) {
    try { return String(jid || '').split('@')[0].split(':')[0].toLowerCase(); } catch (_) { return ''; }
}

// Todas as identidades conhecidas do bot (parte usuário).
function botUserParts(sock) {
    const out = new Set();
    try {
        const u = sock?.user || {};
        for (const cand of [u.id, u.lid, u.jid]) {
            const user = _userOf(cand);
            if (user) out.add(user);
        }
    } catch (_) {}
    return out;
}

// Checa admin direto no metadata (sem depender só de getBotJid).
// Compara TODOS os campos de identidade do participante.
function isBotAdminInMeta(meta, sock) {
    try {
        const parts = Array.isArray(meta?.participants) ? meta.participants : [];
        if (!parts.length) return false;
        const botUsers = botUserParts(sock);
        if (!botUsers.size) return false;
        return parts.some((p) => {
            const isAdm = p?.admin === 'admin' || p?.admin === 'superadmin' || p?.isAdmin || p?.isSuperAdmin;
            if (!isAdm) return false;
            const ids = [p?.id, p?.jid, p?.lid, p?.pn, p?.phoneNumber].filter(Boolean).map(_userOf);
            return ids.some((u) => u && botUsers.has(u));
        });
    } catch (_) { return false; }
}

// Universo candidato de grupos (várias fontes, sem duplicar).
async function listCandidateGroupJids(sock, utils) {
    const set = new Set();
    try {
        if (sock && typeof sock.groupFetchAllParticipating === 'function') {
            const p = await sock.groupFetchAllParticipating();
            if (p && typeof p === 'object') {
                for (const jid of Object.keys(p)) set.add(jid);
            }
        }
    } catch (_) {}
    try {
        const extra = [
            ...(typeof utils?.listActiveGroups === 'function' ? utils.listActiveGroups() : []),
            ...(typeof utils?.listPartialGroups === 'function' ? utils.listPartialGroups() : []),
            ...(typeof utils?.listNewsGroups === 'function' ? utils.listNewsGroups() : []),
        ];
        for (const j of extra) if (j) set.add(j);
    } catch (_) {}
    try {
        const infos = typeof utils?.listDashboardGroupInfos === 'function' ? utils.listDashboardGroupInfos() : [];
        for (const g of (Array.isArray(infos) ? infos : [])) {
            if (g?.jid) set.add(g.jid);
        }
    } catch (_) {}
    return [...set].filter((j) => j && String(j).endsWith('@g.us'));
}

// Checagem completa de UM grupo: alcançável? bot é admin? assunto? membros?
async function checkGroup(sock, jid, utils) {
    const base = { jid, reachable: false, admin: false, subject: 'Grupo', memberCount: null };
    let meta = null;
    try {
        meta = typeof utils?.groupMetadataCached === 'function'
            ? await utils.groupMetadataCached(sock, jid).catch(() => null)
            : await sock.groupMetadata(jid).catch(() => null);
    } catch (_) { meta = null; }
    const parts = Array.isArray(meta?.participants) ? meta.participants : [];
    if (!parts.length) return base;
    base.reachable = true;
    if (meta?.subject) base.subject = String(meta.subject);
    base.memberCount = parts.length;
    try {
        // Tenta o caminho robusto (todas as identidades do bot)...
        if (isBotAdminInMeta(meta, sock)) {
            base.admin = true;
            return base;
        }
        // ...e o caminho legado (compat com o resto do bot).
        if (typeof utils?.botIsAdmin === 'function') {
            base.admin = !!(await utils.botIsAdmin(sock, jid).catch(() => false));
        }
    } catch (_) {}
    return base;
}

// Todos os grupos onde o bot é admin (com assunto + nº de membros).
async function getAdminGroups(sock, utils) {
    const jids = await listCandidateGroupJids(sock, utils);
    const out = [];
    for (const jid of jids) {
        let info = null;
        try { info = await checkGroup(sock, jid, utils); } catch (_) { info = null; }
        if (info && info.reachable && info.admin) out.push(info);
    }
    return out;
}

// Link de convite (null quando o grupo bloqueia ou falha).
async function getGroupInviteLink(sock, jid) {
    try {
        if (!sock || typeof sock.groupInviteCode !== 'function') return null;
        const code = await sock.groupInviteCode(jid);
        if (!code) return null;
        return `https://chat.whatsapp.com/${code}`;
    } catch (_) { return null; }
}

module.exports = {
    botUserParts,
    isBotAdminInMeta,
    listCandidateGroupJids,
    checkGroup,
    getAdminGroups,
    getGroupInviteLink,
};
