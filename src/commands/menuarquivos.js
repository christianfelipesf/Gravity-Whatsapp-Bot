module.exports = {
    name: 'menuarquivos',
    aliases: ['menu_arquivos', 'arquivos', 'arquivo'],
    category: 'geral',
    description: 'Exibe comandos arquivados, ocultos do !menu (ex.: !apuracao)',
    async execute(sock, m, { from, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getBotName } = utils;
        const botName = getBotName(from, config);
        const p = config.prefix;

        let currentBotResponse = lastBotResponse;
        try { currentBotResponse = await react(sock, m, '🗂️', lastBotResponse, GLOBAL_COOLDOWN); } catch (_) {}

        const text = `*${botName} — Menu Arquivos* 🗂️\n_comandos arquivados, ocultos do !menu_\n\n` +
            `╭─── *ELEIÇÃO* ───\n` +
            `│ 🗳️ *${p}apuracao* [UF] — presidente em tempo real, com foto (alias ${p}eleicao)\n` +
            `╰───────────────`;

        await sock.sendMessage(from, { text }, { quoted: m });
        return currentBotResponse;
    }
};
