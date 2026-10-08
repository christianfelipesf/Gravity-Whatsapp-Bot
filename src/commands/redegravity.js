const { listCandidateGroupJids, checkGroup, getGroupInviteLink } = require('../services/adminGroups');

module.exports = {
    name: 'redegravity',
    aliases: ['redegravidade', 'redegrav', 'rede-gravity', 'gruposgravity'],
    category: 'admin',
    description: 'Lista os links dos grupos onde o bot está e é admin. Dono, sub-donos e guardiões.',
    async execute(sock, m, { from, sender, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

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

        // 1) Universo de grupos (socket + listas locais + dashboard).
        const jids = await listCandidateGroupJids(sock, utils).catch(() => []);

        if (!jids.length) {
            return await sock.sendMessage(from, { text: '🌐 *Rede Gravity* 🪐\n\nNão achei nenhum grupo (bot fora de grupos ou sem conexão). Tente de novo em alguns segundos.' }, { quoted: m });
        }

        // 2) Checa admin (robusto a LID x número) e puxa o invite.
        const ok = [];
        let semAdmin = 0;
        let inacessiveis = 0;
        const semLink = [];
        for (const jid of jids) {
            let info = null;
            try { info = await checkGroup(sock, jid, utils); } catch (_) { info = null; }
            if (!info || !info.reachable) { inacessiveis++; continue; }
            if (!info.admin) { semAdmin++; continue; }
            const link = await getGroupInviteLink(sock, jid);
            if (link) ok.push({ jid, subject: info.subject, members: info.memberCount, link });
            else semLink.push({ jid, subject: info.subject });
        }

        if (!ok.length) {
            const detalhe = semLink.length
                ? `\n\n⚠️ *Com admin mas sem link:* ${semLink.map((g) => g.subject).join(' • ')} _(convite bloqueado?)_`
                : '';
            return await sock.sendMessage(from, {
                text: `🌐 *Rede Gravity* 🪐\n\nVerifiquei *${jids.length}* grupo(s), mas *nenhum com link* — ${semAdmin} sem admin${inacessiveis ? `, ${inacessiveis} inacessível(is)` : ''}.\n\n💡 Promova o bot a admin nos grupos para aparecerem aqui.${detalhe}`
            }, { quoted: m });
        }

        ok.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || ''), 'pt-BR'));

        const lines = ok.map((g, i) => `${i + 1}. *${g.subject}*${g.members != null ? ` (${g.members})` : ''}\n   🔗 ${g.link}`);
        const header = `🌐 *Rede Gravity* 🪐 (${ok.length})\n_links dos grupos onde sou admin_\n\n`;
        const footer = `\n\n📊 ${jids.length} verificado(s) • ✅ ${ok.length} com link${semAdmin ? ` • 🙈 ${semAdmin} sem admin` : ''}${semLink.length ? ` • ⚠️ ${semLink.length} sem link: ${semLink.map((g) => g.subject).join(' • ')}` : ''}${inacessiveis ? ` • ❓ ${inacessiveis} inacessível(is)` : ''}`;
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
