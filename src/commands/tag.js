module.exports = {
    name: 'tag',
    aliases: ['tagmode', 'tags'],
    description: 'Liga/desliga o modo tag global: reage a msgs normais (dono/sub 🤡, guardião 🦅).',
    category: 'admin',
    async execute(sock, m, { sender, args, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, readConfig, writeConfig } = utils;

        let allowed = false;
        try {
            if (typeof utils.canConfigureBot === 'function' && utils.canConfigureBot(sock, m, sender, m.key?.remoteJid).ok) allowed = true;
        } catch (_) {}
        if (!allowed && typeof utils.canGuardianActAsync === 'function') {
            try { if ((await utils.canGuardianActAsync(sock, m, sender, m.key?.remoteJid)).ok) allowed = true; } catch (_) {}
        }
        if (!allowed) {
            return await sock.sendMessage(m.key?.remoteJid, { text: '❌ Apenas o dono, sub-donos ou guardiões podem usar este comando.' }, { quoted: m });
        }

        const sub = String(args[0] || '').toLowerCase();
        const p = config.prefix;
        const { TAG_OWNER_EMOJI, TAG_GUARDIAN_EMOJI } = require('../services/tagReact');

        const statusText = () => {
            const st = readConfig().tagMode === true;
            return `🏷️ *Modo Tag ${st ? '🟢 ATIVADO' : '🔴 DESATIVADO'}* (global)\n\n` +
                `Quando ativado, reajo a mensagens normais (não-comandos) em todos os grupos:\n` +
                `│ ${TAG_OWNER_EMOJI} dono / sub-donos\n` +
                `│ ${TAG_GUARDIAN_EMOJI} guardiões\n` +
                `│ 🚫 membro comum: sem reação\n\n` +
                `Uso: *${p}tag on* • *${p}tag off* • *${p}tag status*`;
        };

        if (!sub || sub === 'status' || sub === 'ver') {
            await sock.sendMessage(m.key?.remoteJid, { text: statusText() }, { quoted: m });
            return lastBotResponse;
        }
        if (sub === 'on' || sub === 'ativar' || sub === '1' || sub === 'true' || sub === 'sim') {
            const cfg = readConfig();
            writeConfig({ ...cfg, tagMode: true });
            const r = await react(sock, m, '🏷️', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(m.key?.remoteJid, { text: `🏷️ *Modo Tag ATIVADO!* ✅ (global)\n\nAgora reajo a msgs normais:\n│ ${TAG_OWNER_EMOJI} dono/sub • ${TAG_GUARDIAN_EMOJI} guardião` }, { quoted: m });
            return r;
        }
        if (sub === 'off' || sub === 'desativar' || sub === 'desligar' || sub === '0' || sub === 'false' || sub === 'nao' || sub === 'não') {
            const cfg = readConfig();
            writeConfig({ ...cfg, tagMode: false });
            const r = await react(sock, m, '🔇', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(m.key?.remoteJid, { text: '🔇 *Modo Tag DESATIVADO.* (global)\n\nVolto a não reagir às mensagens.' }, { quoted: m });
            return r;
        }
        await sock.sendMessage(m.key?.remoteJid, { text: `❌ Use: *${p}tag on|off|status*\n\n${statusText()}` }, { quoted: m });
        return lastBotResponse;
    }
};
