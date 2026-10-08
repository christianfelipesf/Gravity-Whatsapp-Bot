module.exports = {
    name: 'menuadmin',
    aliases: ['adminmenu', 'adminhelp', 'menugp'],
    category: 'admin',
    description: 'Exibe comandos de administrador (ocultos do !menu)',
    async execute(sock, m, { from, isGroup, sender, config, utils }) {
        const { getAdmins, isUserAdmin, normalizeJid, getBotName } = utils;
        const botName = getBotName(from, config);
        const p = config.prefix;

        if (!isGroup) {
            return sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
        }

        const meId = normalizeJid(sock.user?.id || '');
        const senderNorm = normalizeJid(sender);
        const isOwner = m.key.fromMe || sender === meId || senderNorm === meId;

        let isAdmin = isOwner;
        if (!isAdmin) {
            try {
                const admins = await getAdmins(sock, from);
                isAdmin = isUserAdmin(sender, admins);
            } catch (_) { isAdmin = false; }
        }

        if (!isAdmin) {
            return sock.sendMessage(from, { text: '❌ Apenas *admins* do grupo podem usar este comando.' }, { quoted: m });
        }

        const text = `*${botName} — Menu Admin* 🛡️\n_comandos de administração_\n\n` +
            `╭─── *MODERAÇÃO* ───\n` +
            `│ 🚫 *${p}ban* (marque/responda) — remove membro\n` +
            `│ 👑 *${p}promover* (marque/responda) — vira admin\n` +
            `│ 📉 *${p}rebaixar* (marque/responda) — tira admin\n` +
            `│ ➕ *${p}add* <número> — adiciona membro\n` +
            `│ 🔒 *${p}fechar* / *${p}abrir* — fecha/abre o grupo\n` +
            `│ 👑 *${p}admins* — lista e marca admins\n` +
            `│ ⛔ *${p}listanegra* [@/nº] — lista negra com auto-ban ao voltar\n` +
            `│ ⚠️ *${p}adv* (marque) — advertência 3/3 = ban\n` +
            `│ 🔍 *${p}veradv* [@user] — consulta advertências\n` +
            `│ ✅ *${p}limparadv* [@user|all] — limpa advertências\n` +
            `│ 🛡️ *${p}antilink* — ativa/desativa filtro de links\n` +
            `│ 🔓 *${p}revelaradmin* — só admins revelam view-once (padrão: todos)\n` +
            `│ 🚨 *${p}antiflood* — ativa/configura antiflood (admin desligado por padrão)\n` +
            `│ 🔇 *${p}mute* @user — silencia\n` +
            `│ 🔊 *${p}desmute* @user — dessilencia\n` +
            `│ 🗑️ *${p}d* (responda msg) — apaga msg do bot ou de pessoas\n` +
            `│ 🧹 *${p}limpar* [n] — apaga mensagens\n` +
            `│ 🗑️ *${p}deletarmsg* (responda) — apaga mensagem marcada\n` +
            `╰───────────────\n\n` +
            `╭─── *FEEDBACK* ───\n` +
            `│ 📋 *${p}feedbacklog* — TXT único com bugs+sugestões (marca tipo)\n` +
            `│ 🧹 *${p}limparfeedback* [bug|sugestao|all] — limpa logs\n` +
            `╰───────────────\n\n` +
            `╭─── *GRUPO* ───\n` +
            `│ 📊 *${p}infogrupo* — análise do grupo (alias ${p}analise, ${p}grupo)\n` +
            `│ 📜 *${p}regras* — vê regras (admin: ${p}regras set <texto>)\n` +
            `│ 🔔 *${p}avisosgrupo* on|off|ver — saída, promoção, rebaixamento e mudanças\n` +
            `│ 👋 *${p}bemvindo* on|off|msg|teste — só boas-vindas (entrada)\n` +
            `│ 💡 *${p}splash* status|teste|reset — curiosidade automática (on/off: só dono)\n` +
            `│ 📊 *${p}enquete* pergunta | op1 ; op2 — votação nativa\n` +
            `│ 👻 *${p}inativos* [n] — lista fantasmas do mês\n` +
            `│ 📢 *${p}mencionar* [texto] — marca todos\n` +
            `│ 💬 *${p}cita* (responda mensagem) — reescreve marcando todos\n` +
            `│ 🏷️ *${p}nome* <nome> — nome do bot no grupo\n` +
            `│ 🎨 *${p}tema* <hell\|natal\|festa\|fofo\|reset> — tema do grupo\n` +
            `│ 🖼️ *${p}imagem* (responda imagem) — imagem do menu\n` +
            `│ 🔗 *${p}linkgp* — pega link do grupo (bot precisa ser admin)\n` +
            `│ 🔗 *${p}setlink* <link> — define link p/ !divulgar\n` +
            `│ 🤖 *${p}autoresponder* on|off — chat automático (tom do grupo, sem moderar)\n` +
            `╰───────────────\n\n` +
            `_Use ${p}menudono para comandos do dono do bot • ${p}menuguardiao para poderes dos guardiões._`;

        return sock.sendMessage(from, { text }, { quoted: m });
    }
};
