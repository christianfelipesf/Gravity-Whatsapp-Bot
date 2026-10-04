module.exports = {
    name: 'veradv',
    aliases: ['warns', 'veradvertencia', 'veradvertencias', 'advlist'],
    description: 'Consulta advertências: marque/cite alguém ou use sem alvo para ver o top.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        if (!utils.isUserAdmin(sender, admins)) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        let participant = '';
        if (m.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            participant = m.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (m.message.extendedTextMessage?.contextInfo?.participant) {
            participant = m.message.extendedTextMessage.contextInfo.participant;
        }

        const gd = utils.getGroupData(from) || {};
        const warnings = (gd.warnings && typeof gd.warnings === 'object') ? gd.warnings : {};
        const identity = require('../services/identity');

        if (participant) {
            let keys = [participant];
            try {
                const k = await identity.targetKeys(sock, utils, from, participant);
                if (k && Array.isArray(k.all) && k.all.length) keys = k.all;
            } catch (_) {}
            const count = identity.warnCount(warnings, keys);
            const label = await identity.personLabel(sock, utils, from, participant).catch(() => 'membro');
            if (count <= 0) {
                return await sock.sendMessage(from, { text: `✅ ${label} não tem advertências.`, mentions: [participant] }, { quoted: m });
            }
            return await sock.sendMessage(from, { text: `⚠️ ${label} tem ${count}/3 advertências.`, mentions: [participant] }, { quoted: m });
        }

        const canonOf = (jid) => {
            const d = identity.digitsOf(jid);
            return identity.isLidJid(jid) ? `lid:${d}` : `tel:${d}`;
        };
        // Agrupa por pessoa (telefone+LID somem na mesma linha).
        const merged = new Map();
        for (const [jid, c] of Object.entries(warnings)) {
            const n = Number(c) || 0;
            if (n <= 0) continue;
            const key = canonOf(jid);
            const cur = merged.get(key) || { count: 0, jids: [] };
            if (n > cur.count) cur.count = n;
            cur.jids.push(jid);
            merged.set(key, cur);
        }
        // Tenta fundir pares telefone<->LID resolvendo os LIDs do grupo.
        try {
            const groups = identity.groupsForSearch(utils, from, 15);
            const lidMap = await identity.buildLidPhoneMap(sock, utils, groups, 15);
            if (lidMap.size) {
                for (const [lid, phone] of lidMap) {
                    const a = merged.get(`lid:${lid}`);
                    const b = merged.get(`tel:${phone}`);
                    if (a && b) {
                        merged.set(`tel:${phone}`, { count: Math.max(a.count, b.count), jids: [...a.jids, ...b.jids] });
                        merged.delete(`lid:${lid}`);
                    } else if (a && !b) {
                        merged.set(`tel:${phone}`, a);
                        merged.delete(`lid:${lid}`);
                    }
                }
            }
        } catch (_) {}
        const entries = [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 20);
        if (entries.length === 0) {
            return await sock.sendMessage(from, { text: '✅ Ninguém tem advertências neste grupo.' }, { quoted: m });
        }
        const lines = [];
        const mentions = [];
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const rep = e.jids[0];
            const label = await identity.personLabel(sock, utils, from, rep).catch(() => 'membro');
            lines.push(`${i + 1}. ${label} — ${e.count}/3`);
            for (const j of e.jids) mentions.push(j);
        }
        return await sock.sendMessage(from, { text: `⚠️ *Advertências ativas*\n${lines.join('\n')}`, mentions: [...new Set(mentions)] }, { quoted: m });
    }
};
