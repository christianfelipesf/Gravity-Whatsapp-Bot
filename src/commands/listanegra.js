module.exports = {
    name: 'listanegra',
    aliases: ['blacklist', 'bl', 'lista-negra'],
    description: 'Gerencia lista negra do grupo — membros banidos automaticamente ao tentar voltar.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, args, fullArgsText, config, utils }) {
        if (!isGroup) {
            return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
        }

        const admins = await utils.getAdmins(sock, from);
        const isSenderAdmin = utils.isUserAdmin(sender, admins);
        if (!isSenderAdmin) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        const p = config.prefix || '!';
        const identity = require('../services/identity');
        const blacklist = utils.getBlacklist(from);

        // Aliases telefone<->LID do alvo (p/ checar a lista em qualquer formato).
        async function aliasOf(jid) {
            try {
                const k = await identity.targetKeys(sock, utils, from, jid);
                if (k && Array.isArray(k.all) && k.all.length) return k.all;
            } catch (_) {}
            return [jid];
        }

        // Rótulo seguro p/ exibição (nome > telefone formatado; nunca LID/JID cru).
        async function labelOf(jid) {
            try {
                return await identity.personLabel(sock, utils, from, jid);
            } catch (_) {
                return identity.digitsOf(jid) || 'membro';
            }
        }
        async function listLines(rows) {
            const out = [];
            for (let i = 0; i < rows.length; i++) {
                out.push(`${i + 1}. ${await labelOf(rows[i].user_jid)}`);
            }
            return out;
        }

        async function formatListAsync(rows) {
            const list = Array.isArray(rows) ? rows : utils.getBlacklist(from);
            if (!list.length) return '_Lista vazia — nenhum número na lista negra._';
            return (await listLines(list)).join('\n');
        }

        async function helpText() {
            return `*🚫 Lista Negra — ${utils.getBlacklist(from).length} número(s)*\n` +
                `_${await formatListAsync()}_\n\n` +
                `╭─── *COMO USAR* ───\n` +
                `│ 📋 *${p}listanegra* — mostra esta lista e instruções\n` +
                `│ ➕ *${p}listanegra @usuario* — marca/menciona para banir e adicionar à lista\n` +
                `│ 💬 *${p}listanegra* (responda msg) — cita mensagem da pessoa\n` +
                `│ 🔢 *${p}listanegra 5511999999999* — digite o número completo com DDD e país\n` +
                `│ ➖ *${p}listanegra remover @usuario* — remove da lista negra\n` +
                `│ ➖ *${p}listanegra remover 5511999999999* — remove número\n` +
                `│ 🧹 *${p}listanegra limpar* — limpa toda a lista negra\n` +
                `╰───────────────\n\n` +
                `*Efeito:* quem está na lista negra é *banido instantaneamente* se tentar voltar ao grupo (mesmo que saia e entre novamente). Válido apenas para este grupo.\n` +
                `*Obs:* O bot precisa ser *admin* para banir automaticamente.`;
        }

        // Sem argumentos -> mostra instruções + lista
        if (!args || args.length === 0) {
            return await sock.sendMessage(from, { text: await helpText() }, { quoted: m });
        }

        const lowerArgs = args.map(a => String(a).toLowerCase());
        const isRemoveIntent = lowerArgs.includes('remover') || lowerArgs.includes('remove') || lowerArgs.includes('rem') || lowerArgs.includes('del') || lowerArgs.includes('tirar') || lowerArgs.includes('rm');
        const isClearIntent = lowerArgs.includes('limpar') || lowerArgs.includes('clear') || lowerArgs.includes('clean');

        // Limpar toda a lista
        if (isClearIntent && !isRemoveIntent) {
            if (blacklist.length === 0) {
                return await sock.sendMessage(from, { text: 'ℹ️ A lista negra já está vazia.' }, { quoted: m });
            }
            // Se foi digitado "limpar" sem confirmação, pede confirmação ou limpa direto? Limpa direto com admin já validado.
            // Suporta "limpar" sozinho ou "limpar all"
            const removed = utils.clearBlacklist(from);
            return await sock.sendMessage(from, { text: `🧹 Lista negra limpa! ${removed} número(s) removido(s).` }, { quoted: m });
        }
        if (isClearIntent && isRemoveIntent && (lowerArgs.includes('all') || lowerArgs.includes('todos') || lowerArgs.includes('tudo'))) {
            if (blacklist.length === 0) {
                return await sock.sendMessage(from, { text: 'ℹ️ A lista negra já está vazia.' }, { quoted: m });
            }
            const removed = utils.clearBlacklist(from);
            return await sock.sendMessage(from, { text: `🧹 Lista negra limpa! ${removed} número(s) removido(s).` }, { quoted: m });
        }

        // Extrair alvos: menções, citação e números digitados
        const targets = [];
        const seenUsers = new Set();

        function pushTarget(jid) {
            if (!jid) return;
            const norm = utils.normalizeJid(jid);
            if (!norm) return;
            const user = norm.split('@')[0];
            if (!user || seenUsers.has(user)) return;
            seenUsers.add(user);
            // Ignora tokens que são comandos (remover etc) — já filtrado, mas garante
            targets.push(norm);
        }

        // Menções e citação
        const ctx = m.message?.extendedTextMessage?.contextInfo || utils.getContextInfo(m.message) || {};
        if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) {
            for (const j of ctx.mentionedJid) pushTarget(j);
        }
        if (ctx.participant) {
            pushTarget(ctx.participant);
        }

        // Números digitados — normaliza o texto INTEIRO (aceita "+55 13 93631-2912",
        // "(11) 99999-9999", "11 999999999"). NÃO usa match(/\d{8,15}/g) aqui:
        // ele quebra número formatado em pedaços (["13","93631","2912"]) e gera JID errado.
        // Múltiplos números: separar por vírgula, ponto-e-vírgula ou quebra de linha.
        if (fullArgsText) {
            const cleaned = String(fullArgsText).replace(/(remover|remove|rem|del|tirar|rm|limpar|clear|clean|all|todos|tudo)\b/gi, ' ');
            const chunks = cleaned.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            const parts = chunks.length ? chunks : [cleaned];
            for (const part of parts) {
                const digits = utils.normalizePhoneNumber
                    ? utils.normalizePhoneNumber(part)
                    : utils.parseNumberToJid(part)?.split('@')[0];
                if (digits) {
                    // Dígitos digitados podem ser um LID colado: converte p/ telefone.
                    let phone = digits;
                    try {
                        const r = await identity.resolveCandidateToPhone(sock, utils, digits, from);
                        if (r.phone) phone = r.phone;
                    } catch (_) {}
                    const jid = `${phone}@s.whatsapp.net`;
                    if (jid) pushTarget(jid);
                }
            }
            // Fallback: vários números separados por espaço ("5511... 5521...").
            // Só aqui o split por token é seguro (cada token já é só dígitos).
            if (targets.length === 0) {
                for (const tok of cleaned.split(/\s+/)) {
                    const digits = utils.normalizePhoneNumber ? utils.normalizePhoneNumber(tok, { min: 10 }) : null;
                    if (!digits) continue;
                    let phone = digits;
                    try {
                        const r = await identity.resolveCandidateToPhone(sock, utils, digits, from);
                        if (r.phone) phone = r.phone;
                    } catch (_) {}
                    pushTarget(`${phone}@s.whatsapp.net`);
                }
            }
        }

        // Se intenção é remover mas nenhum alvo encontrado
        if (isRemoveIntent) {
            if (targets.length === 0) {
                return await sock.sendMessage(from, { text: `❌ Você precisa marcar, citar ou digitar o número de quem deseja *remover* da lista negra.\n\nEx: *${p}listanegra remover @usuario* ou *${p}listanegra remover 5511999999999*` }, { quoted: m });
            }
            let removedCount = 0;
            let notFoundCount = 0;
            const notFoundLabels = [];
            for (const t of targets) {
                // Tenta o JID direto + aliases (telefone<->LID).
                let aliases = [t];
                try {
                    const k = await identity.targetKeys(sock, utils, from, t);
                    if (k && Array.isArray(k.all) && k.all.length) aliases = k.all;
                } catch (_) {}
                const ok = typeof utils.removeFromBlacklistAny === 'function'
                    ? utils.removeFromBlacklistAny(from, aliases)
                    : utils.removeFromBlacklist(from, t);
                if (ok) removedCount++;
                else { notFoundCount++; notFoundLabels.push(await labelOf(t)); }
            }
            let msg = '';
            if (removedCount > 0) msg += `✅ ${removedCount} número(s) removido(s) da lista negra.\n`;
            if (notFoundCount > 0) msg += `ℹ️ ${notFoundCount} não estava(m) na lista: ${notFoundLabels.join(', ')}\n`;
            msg += `\n*Lista atual:* ${utils.getBlacklist(from).length} número(s)\n${await formatListAsync()}`;
            return await sock.sendMessage(from, { text: msg.trim() }, { quoted: m });
        }

        // Caso contrário: intenção de adicionar à lista negra + banir
        if (targets.length === 0) {
            // Nenhum alvo válido mas tem args — mostra help + lista
            return await sock.sendMessage(from, { text: `❌ Você precisa *marcar*, *citar* (responder mensagem) ou *digitar o número* para adicionar à lista negra.\n\n` + await helpText() }, { quoted: m });
        }

        const isBotAdmin = await utils.botIsAdmin(sock, from);
        let metadata = null;
        try { metadata = await utils.groupMetadataCached(sock, from); } catch (_) {}

        const participantsSet = new Set();
        if (metadata && Array.isArray(metadata.participants)) {
            for (const pinfo of metadata.participants) {
                for (const f of [pinfo.id, pinfo.jid, pinfo.lid, pinfo.phoneNumber, pinfo.pn]) {
                    if (!f) continue;
                    const d = identity.digitsOf(f);
                    if (d) participantsSet.add(d);
                }
            }
        }
        // Está no grupo? (casa por qualquer formato: telefone ou LID)
        async function isInGroup(t) {
            try {
                for (const a of await aliasOf(t)) {
                    if (participantsSet.has(identity.digitsOf(a))) return true;
                }
            } catch (_) {}
            return false;
        }

        let added = 0;
        let already = 0;
        let adminSkipped = 0;
        let kicked = 0;
        const addedNumbers = [];
        const alreadyNumbers = [];
        const adminNumbers = [];

        for (const t of targets) {
            // Não permite adicionar admin
            if (utils.isUserAdmin(t, admins)) {
                adminSkipped++;
                adminNumbers.push(await labelOf(t));
                continue;
            }
            const alreadyListed = typeof utils.isBlacklistedAny === 'function'
                ? utils.isBlacklistedAny(from, await aliasOf(t))
                : utils.isBlacklisted(from, t);
            if (alreadyListed) {
                already++;
                alreadyNumbers.push(await labelOf(t));
                // Mesmo já estando na lista, tenta banir se ainda estiver no grupo
                if (isBotAdmin && await isInGroup(t)) {
                    try {
                        await sock.groupParticipantsUpdate(from, [t], 'remove');
                        kicked++;
                    } catch (_) {}
                }
                continue;
            }
            const ok = utils.addToBlacklist(from, t, sender);
            if (ok) {
                added++;
                addedNumbers.push(await labelOf(t));
                // Tenta banir instantaneamente se estiver no grupo
                if (isBotAdmin && await isInGroup(t)) {
                    try {
                        await sock.groupParticipantsUpdate(from, [t], 'remove');
                        kicked++;
                    } catch (e) {
                        console.error('[listanegra] falha ao banir:', e.message);
                    }
                }
            }
        }

        let response = '';
        if (added > 0) response += `🚫 *${added} número(s) adicionado(s) à lista negra:* ${addedNumbers.join(', ')}\n`;
        if (already > 0) response += `ℹ️ ${already} já estava(m) na lista: ${alreadyNumbers.join(', ')}\n`;
        if (adminSkipped > 0) response += `⚠️ ${adminSkipped} é/são admin e não pode(m) ser adicionado(s): ${adminNumbers.join(', ')}\n`;
        if (kicked > 0) response += `✅ ${kicked} usuário(s) banido(s) instantaneamente.\n`;
        if (added > 0 && !isBotAdmin) response += `⚠️ Bot não é admin — não foi possível banir agora, mas o auto-ban funcionará quando o bot for promovido e o usuário tentar voltar.\n`;
        if (added > 0 || already > 0) {
            const curList = utils.getBlacklist(from);
            response += `\n*Lista negra atual (${curList.length}):*\n${await formatListAsync(curList)}`;
        }

        if (!response) response = '❌ Nenhum número válido processado.';

        return await sock.sendMessage(from, { text: response.trim() }, { quoted: m });
    }
};
