const identity = require('../services/identity');

module.exports = {
    name: 'listsubdonos',
    aliases: ['listsubowners', 'subdonos', 'listasubdonos'],
    category: 'admin',
    description: 'Lista os sub-donos autorizados a configurar o bot. Dono e sub-donos podem ver.',
    async execute(sock, m, { from, sender, utils }) {
        const access = utils.canConfigureBot
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: utils.isBotOwner(sock, m, sender) };
        if (!access.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono ou sub-donos podem usar este comando.' }, { quoted: m });
        }

        const list = utils.getSubOwners ? utils.getSubOwners() : [];
        if (!list.length) {
            return await sock.sendMessage(from, { text: '📋 *Sub-donos (0)*\n\nNenhum sub-dono cadastrado.\n➕ *!addsubdono <numero>* (só o dono)' }, { quoted: m });
        }

        // Resolve LIDs legados para o telefone real (uma varredura só).
        const groups = identity.groupsForSearch(utils, from, 15);
        let lidMap = new Map();
        try {
            lidMap = await identity.buildLidPhoneMap(sock, utils, groups, 15);
        } catch (_) {}

        // Auto-cura: troca LID resolvido pelo telefone real (sem duplicar).
        try {
            if (lidMap.size && typeof utils.readConfig === 'function' && typeof utils.writeConfig === 'function') {
                const cur = utils.getSubOwners ? utils.getSubOwners() : [];
                const { next, changed } = identity.healPhoneList(cur, lidMap);
                if (changed && next.length) {
                    const cfg = utils.readConfig();
                    utils.writeConfig({ ...cfg, subOwners: next });
                }
            }
        } catch (_) {}

        const shown = utils.getSubOwners ? utils.getSubOwners() : list;
        const lines = [];
        for (let i = 0; i < shown.length; i++) {
            const d = await identity.displayPerson(sock, utils, from, shown[i], lidMap);
            lines.push(`${i + 1}. ${d.lines.join('\n')}`);
        }
        const text = `📋 *Sub-donos (${shown.length})*\n\n${lines.join('\n')}\n\n💡 Eles podem usar *!set* e *!config*.\n➕ *!addsubdono <numero>* • ➖ *!remsubdono <numero>* (só o dono)`;
        await sock.sendMessage(from, { text }, { quoted: m });
    }
};
