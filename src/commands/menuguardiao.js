const identity = require('../services/identity');

module.exports = {
    name: 'menuguardiao',
    aliases: ['menuguardian', 'menu-guardiao', 'menuguardioes', 'guardiaomenu', 'listguardioes', 'listguardians', 'guardioes', 'listaguardioes', 'guardians'],
    category: 'admin',
    description: 'Menu dos guardiões: lista quem é guardião e os comandos liberados (dono, sub-donos e guardiões).',
    async execute(sock, m, { from, sender, config, utils }) {
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

        const p = (config && config.prefix) || '!';
        const list = utils.getGuardioes ? utils.getGuardioes() : [];

        let guardSection = '';
        if (!list.length) {
            guardSection = `📋 *Guardiões (0)* 🛡️\nAinda não tem nenhum guardião por aqui.\n➕ *${p}addguardiao <numero>* (dono ou subdono)\n`;
        } else {
            try {
                const groups = identity.groupsForSearch(utils, from, 15);
                let lidMap = new Map();
                try { lidMap = await identity.buildLidPhoneMap(sock, utils, groups, 15); } catch (_) {}
                try {
                    if (lidMap.size && typeof utils.readConfig === 'function' && typeof utils.writeConfig === 'function') {
                        const cur = utils.getGuardioes ? utils.getGuardioes() : [];
                        const { next, changed } = identity.healPhoneList(cur, lidMap);
                        if (changed && next.length) {
                            const cfg = utils.readConfig();
                            utils.writeConfig({ ...cfg, guardioes: next });
                        }
                    }
                } catch (_) {}
                const shown = utils.getGuardioes ? utils.getGuardioes() : list;
                const lines = [];
                for (let i = 0; i < shown.length; i++) {
                    const d = await identity.displayPerson(sock, utils, from, shown[i], lidMap);
                    lines.push(`${i + 1}. ${d.lines.join('\n')}`);
                }
                guardSection = `📋 *Guardiões (${shown.length})* 🛡️💛\n${lines.join('\n')}\n`;
            } catch (_) {
                guardSection = `📋 *Guardiões (${list.length})* 🛡️💛\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n`;
            }
        }

        const text = `🛡️ *Menu Guardião* 🛡️💛\n_poderes confiados pelo dono_\n\n` +
            guardSection + `\n` +
            `╭─── *PODERES DO GUARDIÃO* ───\n` +
            `│ ✅ *${p}ativar* / *${p}desativar* — liga/desliga o bot no grupo\n` +
            `│ ⚙️ *${p}ativarp* / *${p}desativarp* — modo parcial (mídia + interação)\n` +
            `│ 📰 *${p}news* — ativa/desativa notícias do grupo\n` +
            `│ 🕵️ *${p}investigar* <texto> — investiga pessoas/grupos (todos)\n` +
            `│ 🔎 *${p}investigartudo* <texto> — investigação profunda (só dono/sub/guardião)\n` +
            `│ 💬 *${p}autoresponder* on|off — bate-papo automático\n` +
            `│ 🔇 *${p}mutar* @user — silencia (apaga msgs, bot precisa ser admin)\n` +
            `│ 🔊 *${p}desmutar* @user — dessilencia\n` +
            `│ 🗑️ *${p}d* (responda msg do bot) — apaga msg do bot (mesmo sem admin)\n` +
            `│ 🏷️ *${p}tag* on|off — tag global (🤡 dono/sub, 🦅 guardião)\n` +
            `│ 🌐 *${p}redegravity* — links dos grupos onde o bot é admin\n` +
            `│ 📊 *${p}statusgrupos* — métricas de hoje de todos os grupos\n` +
            `╰───────────────\n\n` +
            `➕ *${p}addguardiao <numero>* • ➖ *${p}remguardiao <numero>* (só dono/subdono)`;

        await sock.sendMessage(from, { text }, { quoted: m });
    }
};
