const { getTheme, themeBullets } = require('../services/themes');
const { resolveMenuImageBuffer, generateMenuImage, getRawGroupBuffer } = require('../services/menuImage');

module.exports = {
    name: 'menu',
    aliases: ['help', 'comandos'],
    category: 'geral',
    description: 'Exibe o menu de comandos',
    async execute(sock, m, { from, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getBotName, getGroupData, getThemeForJid, groupMetadataCached } = utils;

        const themeId = (typeof getThemeForJid === 'function' ? getThemeForJid(from) : (getGroupData(from).theme || 'default'));
        const theme = getTheme(themeId);

        let currentBotResponse = await react(sock, m, theme.react || '📖', lastBotResponse, GLOBAL_COOLDOWN);
        const currentBotName = getBotName(from, config);
        const groupData = getGroupData(from);
        const isGroup = from && from.endsWith('@g.us');

        const p = config.prefix;
        const B = theme.bullet || '│';
        let menuText = `*${currentBotName}* ${theme.header}\n_comandos principais_\n\n` +
            `╭─── *GERAL* ───\n` +
            `${B} 🏆 *${p}rank* — top 10 ativos do mês (alias ${p}rankativos)\n` +
            `${B} 🌍 *${p}rankglobal* — top global + foto dos grupos\n` +
            `${B} 👤 *${p}perfil* — foto do perfil\n` +
            `${B} 📊 *${p}status* — info do bot\n` +
            `${B} 🤖 *${p}ai* <texto> — conversa com IA\n` +
            `${B} 🌐 *${p}traduzir* <texto> — traduz\n` +
            `${B} 📖 *${p}tutorial* — guia de uso\n` +
            `${B} 📝 *${p}resumir* — resume conversa\n` +
            `${B} 🎲 *${p}sortear* — sorteia um membro de grupo aleatório\n` +
            `${B} 📝 *${p}relatar* bug|sugestao <msg> — reportar (atalhos ${p}bug, ${p}sugestao)\n` +
            `${B} 🎨 *${p}tema* <nome|reset> — troca o tema (só admin)\n` +
            `╰───────────────\n\n` +
            `╭─── *MÍDIA* ───\n` +
            `${B} 🖼️ *${p}s* — cria sticker\n` +
            `${B} 🏷️ *${p}rename* pack/autor — pack e autor do sticker\n` +
            `${B} 🔓 *${p}revelar* — revela view once\n` +
            `${B} 🔄 *${p}toimg* — sticker → mídia (alias: togif/gif)\n` +
            `${B} ✨ *${p}stexto* <texto> — sticker de texto\n` +
            `${B} 🎵 *${p}play* <nome> — baixa música\n` +
            `${B} 📥 *${p}dl* <link> — download\n` +
            `${B} 📥 *${p}dhd* <link> — download HD\n` +
            `${B} 🗣️ *${p}tts* <texto> — texto → áudio\n` +
            `${B} 🎙️ *${p}transcrever* — áudio/vídeo → texto (marque o áudio)\n` +
             `${B} ⚡ *${p}acelerar* • 🐌 *${p}desacelerar* — áudio/vídeo\n` +
             `${B} 😂 *${p}meme* — meme aleatório • *${p}postarmeme* adiciona (marque a foto)\n` +
            `╰───────────────\n\n` +
            `╭─── *INTERAÇÃO* ───\n` +
            `${B} 💞 *${p}comandosinteracao* — beijar, abraço etc\n` +
            `╰───────────────\n\n` +
            `╭─── *OUTROS* ───\n` +
            `${B} 📖 *${p}menuadmin* — comandos de admin\n` +
            `${B} 🛡️ *${p}menuguardiao* — menu dos guardiões\n` +
            `${B} 👑 *${p}menudono* — comandos do dono (inclui 🤖 anti-ban)\n` +
            `╰───────────────`;
        menuText = themeBullets(menuText, theme);

        // Card 21:9 gerado como no !rank: foto do grupo + infos + cores do tema.
        // Fallback: foto cortada/antiga; por último, só texto.
        if (config.showLogoInMenu) {
            let groupName = 'Grupo';
            let memberLabel = '';
            let avatarRaw = null;
            if (isGroup) {
                try {
                    const meta = await groupMetadataCached(sock, from).catch(() => null);
                    if (meta?.subject) groupName = meta.subject;
                    const n = Array.isArray(meta?.participants) ? meta.participants.length : 0;
                    if (n > 0) memberLabel = `${n} membros`;
                } catch (_) {}
                try { avatarRaw = await getRawGroupBuffer(sock, from); } catch (_) { avatarRaw = null; }
            }
            try {
                const card = await generateMenuImage({
                    title: currentBotName,
                    headerEmoji: theme.header,
                    groupName,
                    memberLabel,
                    tagline: 'comandos principais',
                    footer: 'Menu Principal',
                    badge: 'MENU',
                    theme,
                    avatarRaw
                });
                if (card) {
                    await sock.sendMessage(from, { image: card, caption: menuText }, { quoted: m });
                    return currentBotResponse;
                }
            } catch (_) {}
            try {
                const legacy = await resolveMenuImageBuffer(sock, { groupJid: from, groupMenuImage: groupData.menuImage, themeId: theme.id });
                if (legacy) {
                    await sock.sendMessage(from, { image: legacy, caption: menuText }, { quoted: m });
                    return currentBotResponse;
                }
            } catch (_) {}
        }

        await sock.sendMessage(from, { text: menuText }, { quoted: m });

        return currentBotResponse;
    }
};
