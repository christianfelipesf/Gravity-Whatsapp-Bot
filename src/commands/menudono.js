module.exports = {
    name: 'menudono',
    aliases: ['menubot', 'donoh', 'menuowner'],
    category: 'geral',
    description: 'Exibe comandos exclusivos do dono do bot (ocultos do !menu)',
    async execute(sock, m, { from, sender, config, utils }) {
        const { normalizeJid, getBotName } = utils;
        const botName = getBotName(from, config);
        const p = config.prefix;

        const meId = normalizeJid(sock.user?.id || '');
        const senderNorm = normalizeJid(sender);
        const isOwner = m.key.fromMe || sender === meId || senderNorm === meId;
        const subAccess = !isOwner && typeof utils.canConfigureBot === 'function'
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: isOwner };
        const isSub = !isOwner && subAccess.ok;

        if (!isOwner && !isSub) {
            return sock.sendMessage(from, { text: '❌ Apenas o *dono do bot* pode usar este comando.' }, { quoted: m });
        }

        const text = `*${botName} — Menu Dono* 👑\n_comandos ocultos do !menu_${isSub ? '\n👤 _você é sub-dono: pode usar !set / !config / !setprefix_' : ''}\n\n` +
            `╭─── *CONFIG (dono + sub-dono)* ───\n` +
            `│ 🔧 *${p}set* <param> <valor> — variáveis do bot\n` +
            `│ ⚙️ *${p}config* — ver configs\n` +
            `│ ⌨️ *${p}setprefix* <prefix> — prefixo global\n` +
            `│ 🌍 *${p}temaglobal* <nome|off> — tema global (sobrescreve o padrão)\n` +
            `╰───────────────\n\n` +
            `╭─── *SUB-DONOS (só dono)* ───\n` +
            `│ ➕ *${p}addsubdono* <numero> — autoriza sub-dono\n` +
            `│ ➖ *${p}remsubdono* <numero|all> — remove sub-dono\n` +
            `│ 📋 *${p}listsubdonos* — lista sub-donos\n` +
            `╰───────────────\n\n` +
            `╭─── *GUARDIÕES (dono + sub-dono)* ───\n` +
            `│ 🛡️ *${p}addguardiao* <numero> — dá poder de guardião: ativar, parcial, news e aidono ✨\n` +
            `│ ➖ *${p}remguardiao* <numero|all> — remove guardião\n` +
            `│ 📋 *${p}listguardioes* — lista guardiões\n` +
            `╰───────────────\n\n` +
            `╭─── *ATIVAÇÃO* ───\n` +
            `│ ✅ *${p}ativar* / *${p}desativar* — liga/desliga bot no grupo\n` +
            `│ ⚙️ *${p}ativarp* / *${p}desativarp* — modo parcial (mídia + interação + tts, 10s, sem moderação)\n` +
            `╰───────────────\n\n` +
            `╭─── *DASHBOARD* ───\n` +
            `│ 📊 *${p}dashboard* / *${p}dash* — ativa/desativa log do grupo\n` +
            `│ 🔌 *${p}dashboardativar* / *${p}dashboarddesativar* — global\n` +
            `│ 🗑️ *${p}dashdel* <jid> — remove grupo do painel\n` +
            `│ 📋 *${p}dashlist* — lista acessos ao painel\n` +
            `│ ♻️ *${p}dashreset* — reseta logs/mídias\n` +
            `╰───────────────\n\n` +
            `╭─── *DIVULGAÇÃO* ───\n` +
            `│ 📢 *${p}divulgar* / *${p}divulgar confirmar* — envia link por DM\n` +
            `│ 🔗 *${p}setlink* <link> — define link do divulgar\n` +
            `╰───────────────\n\n` +
            `╭─── *SUB-SESSÕES* ───\n` +
            `│ 🔐 *${p}login* — parear sub-sessão (QR/código)\n` +
            `│ ➕ *${p}addlogin* <numero> — autoriza privado p/ !login\n` +
            `│ ➖ *${p}removerlogin* <numero|all> — remove autorização\n` +
            `│ 📋 *${p}listalogins* — lista autorizados (privado)\n` +
            `│ 📃 *${p}logins* — lista sub-sessões ativas\n` +
            `│ 🚪 *${p}logoff* — encerra sua sub-sessão\n` +
            `│ 🧹 *${p}subclean* — limpa sub-sessão do disco\n` +
            `│ 🧹 *${p}subcleanall* — limpa todas\n` +
            `│ 🐛 *${p}subdebug* — diagnóstico\n` +
            `╰───────────────\n\n` +
            `╭─── *FEED / NEWS* ───\n` +
            `│ 📰 *${p}news* — ativa/desativa no grupo\n` +
            `│ 📰 *${p}news desativar-todos* — desliga em todos (dono)\n` +
            `│ 📰 *${p}newsativar* / *${p}newsdesativar* — global\n` +
            `│ 🗑️ *${p}newsreset* — reseta posts vistos\n` +
            `╰───────────────\n\n` +
            `╭─── *SISTEMA* ───\n` +
            `│ 🔄 *${p}restart* — reinicia via pm2\n` +
            `│ 📥 *${p}update* / *${p}updateres* — git pull + restart\n` +
            `│ 📄 *${p}log* — envia logs do terminal\n` +
            `│ 🔧 *${p}setprefix* <prefix> / *${p}set* — configs\n` +
            `│ 📦 *${p}dump* / *${p}grupos* — diagnóstico\n` +
            `│ 🧹 *${p}limparmortos* / *${p}limparmortos confirmar* — purga grupos que o bot saiu\n` +
            `╰───────────────\n\n` +
            `╭─── *ANTI-BAN* ───\n` +
            `│ 🤖 *${p}humanizar* on/off/status — modo humano (só dono, salvo no banco)\n` +
            `│ ⏱️ *${p}set* broadcastMinDelayMs/MaxDelayMs — delay entre grupos\n` +
            `╰───────────────\n\n` +
            `╭─── *TRANSMISSÃO* ───\n` +
            `│ 📣 *${p}transmitir* / *${p}transmitirall* — broadcast\n` +
            `╰───────────────`;

        return sock.sendMessage(from, { text }, { quoted: m });
    }
};
