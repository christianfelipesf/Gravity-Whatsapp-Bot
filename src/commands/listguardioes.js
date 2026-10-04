const identity = require('../services/identity');

module.exports = {
    name: 'listguardioes',
    aliases: ['listguardians', 'guardioes', 'listaguardioes', 'guardians'],
    category: 'admin',
    description: 'Lista os guardiões autorizados. Dono, sub-donos e guardiões podem ver.',
    async execute(sock, m, { from, sender, utils }) {
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

        const list = utils.getGuardioes ? utils.getGuardioes() : [];
        if (!list.length) {
            return await sock.sendMessage(from, { text: '📋 *Guardiões (0)* 🛡️\n\nAinda não tem nenhum guardião por aqui.\nQue tal confiar alguém pra ajudar a cuidar do bot? 💛\n➕ *!addguardiao <numero>* (dono ou subdono)' }, { quoted: m });
        }

        // Resolve LIDs legados para o telefone real (uma varredura só nos grupos).
        const groups = identity.groupsForSearch(utils, from, 15);
        let lidMap = new Map();
        try {
            lidMap = await identity.buildLidPhoneMap(sock, utils, groups, 15);
        } catch (_) {}

        // Auto-cura: troca LID resolvido pelo telefone real (sem duplicar).
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
        const text = `📋 *Guardiões (${shown.length})* 🛡️💛\n\n${lines.join('\n')}\n\n✨ Com esse papel, eles podem:\n✅ Ligar e desligar o bot nos grupos (*!ativar* / *!desativar*)\n✅ Usar o modo parcial (*!ativarp* / *!desativarp*)\n✅ Cuidar das notícias do grupo (*!news*)\n✅ Conversar com a IA do dono (*!aidono*)\n✅ Ligar o bate-papo automático (*!autoresponder*)\n\n➕ *!addguardiao <numero>* • ➖ *!remguardiao <numero>* (dono ou subdono)`;
        await sock.sendMessage(from, { text }, { quoted: m });
    }
};
