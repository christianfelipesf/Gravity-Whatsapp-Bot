module.exports = {
    name: 'listalogins',
    aliases: ['listlogin', 'listarlogins', 'verlogins', 'loginspermitidos'],
    category: 'admin',
    description: 'Lista números do privado autorizados a usar !login. Só o dono, só no privado.',
    async execute(sock, m, { from, isGroup, sender, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;

        const meId = utils.normalizeJid(sock.user.id);
        const senderNorm = utils.normalizeJid(sender);
        const isBotOwner = m.key.fromMe === true || sender === meId || senderNorm === meId;
        if (!isBotOwner) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono do bot pode usar este comando.' }, { quoted: m });
        }

        if (isGroup) {
            return await sock.sendMessage(from, { text: '❌ Use este comando apenas no privado do bot.' }, { quoted: m });
        }

        let currentBotResponse = await react(sock, m, '📋', lastBotResponse, GLOBAL_COOLDOWN);

        const list = utils.listLoginAllowed();
        if (!list.length) {
            await sock.sendMessage(from, { text: '📋 *Logins autorizados*\n\n_Nenhum. Autorize com !addlogin 5511999999999._' }, { quoted: m });
            return currentBotResponse;
        }

        const identity = require('../services/identity');
        const groups = identity.groupsForSearch(utils, from, 15);
        let lidMap = new Map();
        try {
            lidMap = await identity.buildLidPhoneMap(sock, utils, groups, 15);
        } catch (_) {}

        const lines = [];
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            const real = lidMap.get(r.phone) || r.phone;
            const d = await identity.displayPerson(sock, utils, from, real, lidMap);
            const who = d.name ? `*${d.name}* — ${identity.formatPhoneDisplay(d.phone)}` : `\`${d.phone}\``;
            let date = '';
            try { date = r.added_at ? new Date(Number(r.added_at)).toLocaleString('pt-BR') : ''; } catch (_) {}
            lines.push(`${i + 1}. ${who}${date ? ` — ${date}` : ''}`);
        }

        await sock.sendMessage(from, {
            text: `📋 *Logins autorizados (${list.length})*\n\n${lines.join('\n')}\n\n💡 Esses números podem usar *!login* no privado sem ser dono.\n➕ *!addlogin <numero>* • ➖ *!removerlogin <numero>*`
        }, { quoted: m });

        return await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
    }
};
