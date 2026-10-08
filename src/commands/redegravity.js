module.exports = {
    name: 'redegravity',
    aliases: ['redegravidade', 'redegrav', 'rede-gravity', 'gruposgravity'],
    category: 'admin',
    description: 'Lista os links dos grupos onde o bot está e é admin. Dono, sub-donos e guardiões.',
    async execute(sock, m, { from, sender, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, groupMetadataCached, botIsAdmin } = utils;

        let access = utils.canConfigureBot
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: utils.isBotOwner(sock, m, sender) };
        if (!access.ok && typeof utils.canGuardianActAsync === 'function') {
            try {
                const g = await utils.canGuardianActAsync(sock, m, sender, from);
                if (g && g.ok) access = { ok: true };
            } catch (_) {}
        }
        if (!access.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono, sub-donos ou guardiões podem usar este comando.' }, { quoted: m });
        }

        let currentBotResponse = lastBotResponse;
        try { currentBotResponse = await react(sock, m, '🌐', lastBotResponse, GLOBAL_COOLDOWN); } catch (_) {}

        // 1) Descobre os grupos onde o bot está.
        let jids = [];
        try {
            if (sock && typeof sock.groupFetchAllParticipating === 'function') {
                const p = await sock.groupFetchAllParticipating();
                if (p && typeof p === 'object') jids = Object.keys(p);
            }
        } catch (_) {}
        if (!jids.length) {
            try {
                const extra = [
                    ...(typeof utils.listActiveGroups === 'function' ? utils.listActiveGroups() : []),
                    ...(typeof utils.listPartialGroups === 'function' ? utils.listPartialGroups() : []),
                    ...(typeof utils.listNewsGroups === 'function' ? utils.listNewsGroups() : []),
                ];
                jids = [...new Set(extra.filter((j) => j && String(j).endsWith('@g.us')))];
            } catch (_) {}
        }
        jids = [...new Set((jids || []).filter((j) => j && String(j).endsWith('@g.us')))];

        if (!jids.length) {
            return await sock.sendMessage(from, { text: '🌐 *Rede Gravity* 🪐\n\nNão achei nenhum grupo (bot fora de grupos ou sem conexão). Tente de novo em alguns segundos.' }, { quoted: m });
        }

        // 2) Filtra só onde o bot é admin e puxa o invite.
        const ok = [];
        let semAdmin = 0;
        const falhas = [];
        for (const jid of jids) {
            let isAdmin = false;
            try { isAdmin = await botIsAdmin(sock, jid); } catch (_) { isAdmin = false; }
            if (!isAdmin) { semAdmin++; continue; }
            let subject = 'Grupo';
            let members = null;
            try {
                const meta = await groupMetadataCached(sock, jid).catch(() => null);
                if (meta?.subject) subject = meta.subject;
                if (Array.isArray(meta?.participants)) members = meta.participants.length;
            } catch (_) {}
            try {
                const code = await sock.groupInviteCode(jid);
                ok.push({ jid, subject, members, link: `https://chat.whatsapp.com/${code}` });
            } catch (e) {
                falhas.push({ jid, subject });
            }
        }

        if (!ok.length) {
            return await sock.sendMessage(from, {
                text: `🌐 *Rede Gravity* 🪐\n\nEstou em *${jids.length}* grupo(s), mas *não sou admin em nenhum* — por isso não consigo gerar links.\n\n💡 Promova o bot a admin nos grupos para aparecerem aqui.\n${falhas.length ? `\n⚠️ ${falhas.length} grupo(s) com admin mas sem link (convite bloqueado?).` : ''}`
            }, { quoted: m });
        }

        ok.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || ''), 'pt-BR'));

        const lines = ok.map((g, i) => `${i + 1}. *${g.subject}*${g.members != null ? ` (${g.members})` : ''}\n   🔗 ${g.link}`);
        const header = `🌐 *Rede Gravity* 🪐 (${ok.length})\n_links dos grupos onde sou admin_\n\n`;
        const footer = `\n\n📊 ${jids.length} grupo(s) no total • ✅ ${ok.length} com link${semAdmin ? ` • 🙈 ${semAdmin} sem admin` : ''}${falhas.length ? ` • ⚠️ ${falhas.length} falha(s)` : ''}`;
        const full = header + lines.join('\n') + footer;

        // Mensagem longa demais vira arquivo .txt para não estourar o limite.
        if (full.length > 3800) {
            const buf = Buffer.from(full, 'utf8');
            await sock.sendMessage(from, {
                document: buf,
                fileName: 'rede-gravity.txt',
                mimetype: 'text/plain',
                caption: `🌐 *Rede Gravity* 🪐 — ${ok.length} link(s) em anexo (lista grande demais p/ mensagem).` + footer
            }, { quoted: m });
        } else {
            await sock.sendMessage(from, { text: full }, { quoted: m });
        }
        try { await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN); } catch (_) {}
        return currentBotResponse;
    }
};
