module.exports = {
    name: 'multiprefixo',
    aliases: ['multiprefix', 'multiprefixos', 'prefixos'],
    category: 'config',
    description: 'Liga/desliga vários prefixos neste grupo (on/off)',
    async execute(sock, m, { from, isGroup, sender, args, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const {
            react, readConfig, getAdmins, isUserAdmin,
            getPrefixForJid, getAllPrefixesForJid, getMultiprefixes,
            isMultiprefixEnabled, setMultiprefixEnabled,
            setMultiprefixes, clearMultiprefixes, normalizeJid
        } = utils;

        if (!isGroup) {
            await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
            return lastBotResponse;
        }

        const effectivePrefix = typeof getPrefixForJid === 'function' ? getPrefixForJid(from) : config.prefix;
        const botName = config.botName || 'Bot';
        const globalPrefix = (() => { try { return String(readConfig().prefix || '!')[0]; } catch (_) { return '!'; } })();

        // Dono, sub-dono e guardiões podem mexer mesmo sem ser ADM do grupo.
        // Só admin do grupo (ou dono/sub-dono/guardião do bot) pode mexer.
        let isAllowed = false;
        try {
            const meId = normalizeJid(sock.user.id);
            const senderNorm = normalizeJid(sender);
            const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
            if (isBotOwner) isAllowed = true;
            if (!isAllowed && typeof utils.canConfigureBot === 'function') {
                try { if (utils.canConfigureBot(sock, m, sender, from).ok) isAllowed = true; } catch (_) {}
            }
            if (!isAllowed && typeof utils.canGuardianActAsync === 'function') {
                try { if ((await utils.canGuardianActAsync(sock, m, sender, from)).ok) isAllowed = true; } catch (_) {}
            }
            if (!isAllowed) {
                const admins = await getAdmins(sock, from);
                if (isUserAdmin(sender, admins)) isAllowed = true;
            }
        } catch (_) {}
        if (!isAllowed) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores do grupo, dono, sub-donos ou guardiões podem configurar o multiprefixo.' }, { quoted: m });
        }

        const showStatus = async (extra = '') => {
            const enabled = isMultiprefixEnabled(from);
            const all = getAllPrefixesForJid(from);
            const extras = getMultiprefixes(from);
            const primary = getPrefixForJid(from);
            // Backticks p/ não quebrar formatação com prefixos como * ' " ( ) etc.
            const fmt = (l) => (l.length ? l.map((p) => `\`${p}\``).join(' ') : '_nenhum_');
            const text = `*${botName} — Multiprefixo* ⌨️\n\n` +
                `╭─── *STATUS* ───\n` +
                `│ 🔀 *Multiprefixo:* ${enabled ? '🟢 ATIVADO' : '🔴 DESATIVADO'}\n` +
                `│ ⌨️ *Principal:* \`${primary}\` (via ${effectivePrefix}setprefix)\n` +
                `│ ➕ *Extras:* ${fmt(extras)}\n` +
                `│ ✅ *Aceitos agora:* ${fmt(all)}\n` +
                `╰───────────────\n\n` +
                `╭─── *USO* ───\n` +
                `│ 🟢 *${effectivePrefix}multiprefixo on* — ativa todos:\n` +
                `│ \`, . ; / " = + [ ] ´ * ( ) ' # - ? $ % & : _ ^ ~ @ { } < > | \\\n` +
                `│ 🔴 *${effectivePrefix}multiprefixo off* — desativa (volta só ao principal)\n` +
                `╰───────────────` + (extra ? `\n\n${extra}` : '');
            await sock.sendMessage(from, { text }, { quoted: m });
            return lastBotResponse;
        };

        // Padrão do ON: lista completa de símbolos (o "!" e o principal/global
        // entram via getAllPrefixesForJid mesmo fora dos extras).
        const DEFAULT_EXTRAS = [',', '.', ';', '/', '"', '=', '+', '[', ']', '´', '*', '(', ')', "'", '#', '-', '?', '$', '%', '&', ':', '_', '`', '^', '~', '@', '{', '}', '<', '>', '|', '\\'];

        const rawAction = String(args[0] || '').toLowerCase();
        const restRaw = (args || []).slice(1).join(' ');
        // Aceita os prefixos colados (ex.: "!./") ou separados (ex.: "! . /").
        const parseChars = (s) => {
            const out = [];
            for (const ch of String(s || '')) {
                if (!ch || /\s/.test(ch)) continue;
                if (!out.includes(ch)) out.push(ch);
            }
            return out;
        };

        if (!rawAction || ['status', 'list', 'lista', 'ver', 'info', 'ajuda', 'help'].includes(rawAction)) {
            return await showStatus();
        }

        if (['on', 'ativar', 'ligar', 'enable', 'enabled', '1', 'sim'].includes(rawAction)) {
            // ON puro (sem lista): garante os extras padrão p/ aceitar
            // * ( ) ! ' " . / # de imediato. Se já havia lista, mantém.
            // ON com lista junto ("!multiprefixo on ! . /") soma à atual.
            const extra = parseChars(restRaw);
            const cur = getMultiprefixes(from);
            if (extra.length) {
                setMultiprefixes(from, [...cur, ...extra]);
            } else if (!cur.length) {
                setMultiprefixes(from, DEFAULT_EXTRAS);
            }
            setMultiprefixEnabled(from, true);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus('✅ Multiprefixo *ativado* neste grupo.');
        }

        if (['off', 'desativar', 'desligar', 'disable', 'disabled', '0', 'nao', 'não'].includes(rawAction)) {
            setMultiprefixEnabled(from, false);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus('🔴 Multiprefixo *desativado* — vale só o prefixo principal.');
        }

        if (['add', 'adicionar', 'mais', '+', 'incluir'].includes(rawAction)) {
            const chars = parseChars(restRaw);
            if (!chars.length) {
                await sock.sendMessage(from, { text: `❌ Informe quais adicionar.\nEx.: *${effectivePrefix}multiprefixo add ! . /*` }, { quoted: m });
                return lastBotResponse;
            }
            const cur = getMultiprefixes(from);
            const next = [...cur];
            for (const c of chars) if (!next.includes(c)) next.push(c);
            if (next.length > 32) {
                await sock.sendMessage(from, { text: '❌ Máximo de 32 prefixos extras.' }, { quoted: m });
                return lastBotResponse;
            }
            setMultiprefixes(from, next);
            setMultiprefixEnabled(from, true);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus(`➕ Adicionado(s): ${chars.map((c) => `\`${c}\``).join(' ')} (multiprefixo ativado)`);
        }

        if (['del', 'rem', 'remove', 'remover', 'rm', 'tirar', '-', 'excluir'].includes(rawAction)) {
            const chars = parseChars(restRaw);
            if (!chars.length) {
                await sock.sendMessage(from, { text: `❌ Informe quais remover.\nEx.: *${effectivePrefix}multiprefixo del .*` }, { quoted: m });
                return lastBotResponse;
            }
            const cur = getMultiprefixes(from);
            const next = cur.filter((c) => !chars.includes(c));
            setMultiprefixes(from, next);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus(`➖ Removido(s): ${chars.map((c) => `\`${c}\``).join(' ')}`);
        }

        if (['set', 'definir', 'configurar', '='].includes(rawAction)) {
            const chars = parseChars(restRaw);
            if (!chars.length) {
                await sock.sendMessage(from, { text: `❌ Informe a lista.\nEx.: *${effectivePrefix}multiprefixo set ! . /*` }, { quoted: m });
                return lastBotResponse;
            }
            if (chars.length > 32) {
                await sock.sendMessage(from, { text: '❌ Máximo de 32 prefixos extras.' }, { quoted: m });
                return lastBotResponse;
            }
            setMultiprefixes(from, chars);
            setMultiprefixEnabled(from, true);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus(`📝 Lista definida + multiprefixo *ativado*. (Global \`${globalPrefix}\` sempre incluso quando ativado)`);
        }

        if (['reset', 'limpar', 'clear', 'zerar', 'padrao', 'padrão', 'default'].includes(rawAction)) {
            clearMultiprefixes(from);
            await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await showStatus('🧹 Extras *limpos*. Use *on* para reativar o padrão.');
        }

        return await showStatus();
    }
};
