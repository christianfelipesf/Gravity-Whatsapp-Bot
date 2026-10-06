// Limpa grupos MORTOS: bot fora (saiu/removido/banido) mas com linhas no banco.
// Varre ativos+parciais+news, compara com groupFetchAllParticipating e, após
// confirmação do dono, purga TUDO (ativação, news, dashboard, group_state,
// logs, mensagens, stats) via utils.purgeDeadGroup.
const pendingPurges = new Map(); // `${sender}:${from}` -> { jids, expiresAt }
const CONFIRM_MS = 5 * 60 * 1000;

function _key(sender, from) {
    return `${sender || '?'}:${from || '?'}`;
}

module.exports = {
    name: 'limparmortos',
    aliases: ['gruposmortos', 'limpargruposmortos'],
    category: 'admin',
    description: 'Dono: lista grupos que o bot não participa mais e purga os dados (com confirmar)',
    async execute(sock, m, { from, sender, config, utils, fullArgsText, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, normalizeJid, listActiveGroups, listPartialGroups, listNewsGroups,
            isActiveGroup, isPartialActive, isNewsEnabled, purgeDeadGroup, canConfigureBot } = utils;

        const meId = normalizeJid(sock?.user?.id);
        const senderNorm = normalizeJid(sender);
        let allowed = m.key.fromMe === true || sender === meId || senderNorm === meId;
        // Sub-dono também pode (dono real ou sub-dono).
        if (!allowed) {
            try { if (typeof canConfigureBot === 'function' && canConfigureBot(sock, m, sender, from).ok) allowed = true; } catch (_) {}
        }
        if (!allowed) {
            await sock.sendMessage(from, { text: '❌ Apenas o dono e sub-donos podem limpar grupos mortos.' }, { quoted: m });
            return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
        }

        const key = _key(sender, from);
        const arg0 = String(fullArgsText || '').trim().toLowerCase();

        // --- 2ª etapa: confirmar e purgar ---
        if (arg0 === 'confirmar') {
            const pend = pendingPurges.get(key);
            pendingPurges.delete(key);
            if (!pend || Date.now() > pend.expiresAt) {
                await sock.sendMessage(from, { text: '⚠️ Nada pendente (ou expirou). Rode *!limparmortos* de novo para varrer.' }, { quoted: m });
                return await react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);
            }
            let purged = 0;
            let logs = 0;
            const lines = [];
            for (const jid of pend.jids) {
                try {
                    const r = purgeDeadGroup(jid);
                    if (r && r.ok) {
                        purged++;
                        const nLogs = Number(r.removed?.dashboard_logs) || 0;
                        logs += nLogs;
                        lines.push(`• ${jid.split('@')[0]} (logs ${nLogs})`);
                    }
                } catch (e) {
                    lines.push(`• ${jid.split('@')[0]} — falha: ${e?.message || e}`);
                }
            }
            await sock.sendMessage(from, {
                text: `🧹 *Limpeza concluída*\n\n✅ ${purged} grupo(s) purgado(s) • ${logs} log(s) apagado(s)\n${lines.slice(0, 30).join('\n')}${lines.length > 30 ? `\n…(+${lines.length - 30})` : ''}`
            }, { quoted: m });
            return await react(sock, m, '🧹', lastBotResponse, GLOBAL_COOLDOWN);
        }

        // --- 1ª etapa: varrer e listar ---
        await react(sock, m, '🔍', lastBotResponse, GLOBAL_COOLDOWN).catch(() => {});
        const candidates = [...new Set([
            ...listActiveGroups(),
            ...listPartialGroups(),
            ...listNewsGroups()
        ].filter((j) => j && String(j).endsWith('@g.us')))];

        if (!candidates.length) {
            await sock.sendMessage(from, { text: '✅ Nenhum grupo registrado no banco. Nada a limpar.' }, { quoted: m });
            return lastBotResponse;
        }

        let participating = null;
        try {
            if (sock && typeof sock.groupFetchAllParticipating === 'function') {
                const p = await sock.groupFetchAllParticipating();
                if (p && typeof p === 'object') participating = new Set(Object.keys(p));
            }
        } catch (_) { participating = null; }

        if (!participating) {
            await sock.sendMessage(from, { text: '⚠️ Não consegui ler a lista de grupos do WhatsApp agora (sem conexão?). Nada foi apagado — tente de novo em alguns segundos.' }, { quoted: m });
            return lastBotResponse;
        }

        const dead = candidates.filter((j) => !participating.has(j));
        if (!dead.length) {
            await sock.sendMessage(from, { text: `✅ Nenhum grupo morto: ${candidates.length} registrado(s), todos com o bot dentro. 🎉` }, { quoted: m });
            return lastBotResponse;
        }

        const flags = (j) => {
            const f = [];
            try { if (isActiveGroup(j)) f.push('ativo'); } catch (_) {}
            try { if (isPartialActive(j)) f.push('parcial'); } catch (_) {}
            try { if (isNewsEnabled(j)) f.push('news'); } catch (_) {}
            return f.length ? ` [${f.join('/')}]` : '';
        };
        pendingPurges.set(key, { jids: dead, expiresAt: Date.now() + CONFIRM_MS });
        try {
            const t = setTimeout(() => { if ((pendingPurges.get(key) || {}).expiresAt <= Date.now()) pendingPurges.delete(key); }, CONFIRM_MS + 5000);
            if (t.unref) t.unref();
        } catch (_) {}

        const prefix = (config && config.prefix) || '!';
        await sock.sendMessage(from, {
            text: `🧹 *Grupos mortos* (${dead.length} — bot fora, dados no banco):\n\n` +
                dead.slice(0, 30).map((j) => `• ${j.split('@')[0]}${flags(j)}`).join('\n') +
                (dead.length > 30 ? `\n…(+${dead.length - 30})` : '') +
                `\n\n⚠️ A purga apaga ativação, news, dashboard, rank, logs e mensagens desses grupos (irreversível).` +
                `\nConfirme com *${prefix}limparmortos confirmar* (5 min).`
        }, { quoted: m });
        return lastBotResponse;
    }
};
