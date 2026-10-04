module.exports = {
    name: 'admins',
    aliases: ['adms', 'listadmins', 'marcaradmins', 'listaradmins'],
    description: 'Lista e marca os administradores do grupo.',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, utils }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        if (!utils.isUserAdmin(sender, admins)) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        if (!admins || admins.length === 0) {
            return await sock.sendMessage(from, { text: 'ℹ️ Nenhum administrador encontrado.' }, { quoted: m });
        }

        const jids = admins.map(a => a.id || a.jid).filter(Boolean);
        const identity = require('../services/identity');
        const lines = [];
        for (let i = 0; i < jids.length; i++) {
            const label = await identity.personLabel(sock, utils, from, jids[i]).catch(() => 'membro');
            lines.push(`${i + 1}. ${label}`);
        }
        return await sock.sendMessage(from, { text: `👑 *Admins (${jids.length})*\n${lines.join('\n')}`, mentions: jids }, { quoted: m });
    }
};
