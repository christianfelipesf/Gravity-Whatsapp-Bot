module.exports = {
    name: 'statusgrupos',
    aliases: ['statusgroups', 'gruposstatus', 'metricasgrupos', 'statusgps', 'painelgrupos'],
    category: 'admin',
    description: 'Métricas de hoje de todos os grupos: mensagens, comandos e top falante. Dono, sub-donos e guardiões.',
    async execute(sock, m, { from, sender, config, utils, fullArgsText, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, groupMetadataCached, botIsAdmin, getGroupMsgsToday, getGroupCommandsToday, getMonthlyRank, isActiveGroup, isPartialActive } = utils;

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
        try { currentBotResponse = await react(sock, m, '📊', lastBotResponse, GLOBAL_COOLDOWN); } catch (_) {}

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
            return await sock.sendMessage(from, { text: '📊 *Status dos Grupos*\n\nNão achei nenhum grupo (bot fora de grupos ou sem conexão). Tente de novo em alguns segundos.' }, { quoted: m });
        }

        const filter = String(fullArgsText || '').trim().toLowerCase();

        // 2) Coleta métricas e separa com/sem admin.
        const adminGroups = [];
        const noAdminGroups = [];
        for (const jid of jids) {
            let subject = 'Grupo';
            let members = null;
            try {
                const meta = await groupMetadataCached(sock, jid).catch(() => null);
                if (meta?.subject) subject = meta.subject;
                if (Array.isArray(meta?.participants)) members = meta.participants.length;
            } catch (_) {}
            if (filter && !String(subject).toLowerCase().includes(filter)) continue;
            let isAdmin = false;
            try { isAdmin = await botIsAdmin(sock, jid); } catch (_) { isAdmin = false; }
            let state = 'off';
            try {
                if (typeof isActiveGroup === 'function' && isActiveGroup(jid)) state = 'ativo';
                else if (typeof isPartialActive === 'function' && isPartialActive(jid)) state = 'parcial';
            } catch (_) {}
            if (!isAdmin) {
                noAdminGroups.push({ jid, subject, members, state });
                continue;
            }
            let msgs = 0, cmds = 0, topName = null, topCount = 0;
            try { msgs = typeof getGroupMsgsToday === 'function' ? getGroupMsgsToday(jid) : 0; } catch (_) {}
            try { cmds = typeof getGroupCommandsToday === 'function' ? getGroupCommandsToday(jid) : 0; } catch (_) {}
            try {
                const rank = typeof getMonthlyRank === 'function' ? getMonthlyRank(jid, 1) : [];
                if (rank && rank[0]) { topName = rank[0].name || 'Usuário'; topCount = Number(rank[0].count) || 0; }
            } catch (_) {}
            adminGroups.push({ jid, subject, members, state, msgs: Number(msgs) || 0, cmds: Number(cmds) || 0, topName, topCount });
        }

        if (!adminGroups.length && !noAdminGroups.length) {
            return await sock.sendMessage(from, { text: `📊 *Status dos Grupos*\n\nNenhum grupo bate com "${fullArgsText}".` }, { quoted: m });
        }

        adminGroups.sort((a, b) => (b.msgs - a.msgs) || String(a.subject).localeCompare(String(b.subject), 'pt-BR'));
        noAdminGroups.sort((a, b) => String(a.subject).localeCompare(String(b.subject), 'pt-BR'));

        const stateIcon = (s) => (s === 'ativo' ? '🟢' : s === 'parcial' ? '🟡' : '⚪');
        const lines = [];
        lines.push(`📊 *Status dos Grupos* — hoje`);
        lines.push(`_mensagens do dia • comandos do dia • top do mês_`);
        lines.push(``);
        lines.push(`╭─── *✅ COM ADMIN (${adminGroups.length})* ───`);
        if (!adminGroups.length) {
            lines.push(`│ (nenhum)`);
        } else {
            adminGroups.forEach((g, i) => {
                const top = g.topName ? ` • 🏆 ${g.topName} (${g.topCount})` : '';
                lines.push(`│ ${i + 1}. *${g.subject}*${g.members != null ? ` (${g.members})` : ''} ${stateIcon(g.state)}`);
                lines.push(`│    💬 ${g.msgs} hoje • ⌨️ ${g.cmds} cmds${top}`);
            });
        }
        lines.push(`╰───────────────`);
        lines.push(``);
        lines.push(`╭─── *⚠️ SEM ADMIN (${noAdminGroups.length})* ───`);
        lines.push(`│ ⚠️ *ATENÇÃO — bot sem admin: sem mutar/apagar/links*`);
        if (!noAdminGroups.length) {
            lines.push(`│ (nenhum — tudo certo 🎉)`);
        } else {
            noAdminGroups.forEach((g, i) => {
                lines.push(`│ ⚠️ ${i + 1}. *${g.subject}*${g.members != null ? ` (${g.members})` : ''} ${stateIcon(g.state)} — promova o bot a admin`);
            });
        }
        lines.push(`╰───────────────`);

        const totMsgs = adminGroups.reduce((s, g) => s + (Number(g.msgs) || 0), 0);
        const totCmds = adminGroups.reduce((s, g) => s + (Number(g.cmds) || 0), 0);
        lines.push(``);
        lines.push(`📊 Total: 💬 ${totMsgs} msgs hoje • ⌨️ ${totCmds} cmds hoje em ${adminGroups.length} grupo(s) com admin${noAdminGroups.length ? ` • ⚠️ ${noAdminGroups.length} sem admin` : ''}`);

        const full = lines.join('\n');
        if (full.length > 3800) {
            await sock.sendMessage(from, {
                document: Buffer.from(full, 'utf8'),
                fileName: 'status-grupos.txt',
                mimetype: 'text/plain',
                caption: `📊 *Status dos Grupos* — ${adminGroups.length} com admin • ⚠️ ${noAdminGroups.length} sem admin • 💬 ${totMsgs} msgs • ⌨️ ${totCmds} cmds (lista completa em anexo).`
            }, { quoted: m });
        } else {
            await sock.sendMessage(from, { text: full }, { quoted: m });
        }
        try { await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN); } catch (_) {}
        return currentBotResponse;
    }
};
