const adminGroups = require('../services/adminGroups');
const { botUserParts } = adminGroups;

function _userOf(jid) {
    try { return String(jid || '').split('@')[0].split(':')[0].toLowerCase(); } catch (_) { return ''; }
}

function _digitsOf(jid) {
    const u = _userOf(jid);
    return /^\d{8,15}$/.test(u) ? u : null;
}

async function _fetchPhotoBuffer(url) {
    if (!url) return null;
    try {
        const axios = require('axios');
        const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        const buf = Buffer.from(data);
        return buf.length > 512 ? buf : null;
    } catch (_) { return null; }
}

module.exports = {
    name: 'sortear',
    aliases: ['aleatorio', 'sorteio', 'random'],
    category: 'geral',
    description: 'Sorteia um membro de um grupo aleatório onde o bot é admin (!sortear)',
    async execute(sock, m, { from, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;
        let current = await react(sock, m, '🎲', lastBotResponse, GLOBAL_COOLDOWN);

        let groups = [];
        try { groups = await adminGroups.getAdminGroups(sock, utils); } catch (_) { groups = []; }
        if (!groups.length) {
            await sock.sendMessage(from, { text: '🎲 Nenhum grupo com o bot admin para sortear.\n\n💡 Promova o bot a admin em ao menos um grupo.' }, { quoted: m });
            return current;
        }

        const picked = groups[Math.floor(Math.random() * groups.length)];
        let meta = null;
        try {
            meta = typeof utils.groupMetadataCached === 'function'
                ? await utils.groupMetadataCached(sock, picked.jid).catch(() => null)
                : await sock.groupMetadata(picked.jid).catch(() => null);
        } catch (_) { meta = null; }
        const parts = Array.isArray(meta?.participants) ? meta.participants : [];
        const subject = (meta?.subject || picked.subject || 'Grupo').slice(0, 60);

        // Fora o próprio bot (todas as identidades: número + LID).
        const botUsers = botUserParts(sock);
        const candidates = parts.filter((p) => {
            const ids = [p?.id, p?.jid, p?.lid, p?.pn, p?.phoneNumber].filter(Boolean);
            if (!ids.length) return false;
            return !ids.some((id) => botUsers.has(_userOf(id)));
        });
        if (!candidates.length) {
            await sock.sendMessage(from, { text: `🎲 *${subject}*\n\nNão achei membros para sortear neste grupo.` }, { quoted: m });
            return current;
        }

        const drawn = candidates[Math.floor(Math.random() * candidates.length)];
        const ids = [drawn?.id, drawn?.jid, drawn?.lid, drawn?.pn, drawn?.phoneNumber].filter(Boolean).map(String);
        const mainId = ids[0];

        // Número: número real direto ou resolvido do LID no grupo.
        let phone = null;
        for (const id of ids) {
            const d = _digitsOf(id);
            if (d && !String(id).toLowerCase().endsWith('@lid')) { phone = d; break; }
        }
        if (!phone) {
            const lidUser = ids.map(_userOf).find((u) => /^\d+$/.test(u));
            if (lidUser && typeof utils.resolveLidPhoneInGroup === 'function') {
                try {
                    const real = await utils.resolveLidPhoneInGroup(sock, lidUser, picked.jid).catch(() => null);
                    const d = real ? _digitsOf(real) : null;
                    if (d) phone = d;
                } catch (_) {}
            }
        }

        // Nome: notify do grupo > histórico/atividade > número.
        let name = null;
        try {
            const identity = require('../services/identity');
            if (typeof identity.resolvePersonName === 'function') {
                name = await identity.resolvePersonName(sock, utils, picked.jid, mainId).catch(() => null);
            }
        } catch (_) {}
        if (!name) {
            try {
                const raw = drawn?.notify || drawn?.name || drawn?.verifiedName || null;
                if (raw && String(raw).trim()) name = String(raw).trim().slice(0, 30);
            } catch (_) {}
        }
        if (!name) name = phone ? `+${phone}` : 'Membro do grupo';

        // Foto de perfil (se tiver e der pra baixar).
        let photoBuf = null;
        if (sock && typeof sock.profilePictureUrl === 'function') {
            for (const id of ids) {
                try {
                    const url = await sock.profilePictureUrl(id, 'image').catch(() => null);
                    photoBuf = await _fetchPhotoBuffer(url);
                    if (photoBuf) break;
                } catch (_) {}
            }
        }

        const prefix = config.prefix || '!';
        const caption = `🎲 *Sorteado!*\n\n` +
            `│ 🏷️ *Grupo:* ${subject}\n` +
            `│ 👤 *Nome:* ${name}\n` +
            `│ 📱 *Número:* ${phone ? `+${phone}` : 'não identificado'}\n` +
            `│ 👥 *Membros:* ${parts.length}\n` +
            `\n_Use *${prefix}sortear* para sortear de novo._`;
        try {
            if (photoBuf) {
                await sock.sendMessage(from, { image: photoBuf, caption, mentions: mainId ? [mainId] : [] }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: caption, mentions: mainId ? [mainId] : [] }, { quoted: m });
            }
        } catch (_) {
            await sock.sendMessage(from, { text: caption }, { quoted: m });
        }
        return await react(sock, m, '✅', current, GLOBAL_COOLDOWN);
    }
};
