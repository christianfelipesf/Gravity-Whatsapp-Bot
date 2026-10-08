const memeStore = require('../services/memeStore');

module.exports = {
    name: 'meme',
    aliases: ['memealeatorio', 'memerandom'],
    category: 'mídia',
    description: 'Sorteia um meme aleatório do acervo (!meme)',
    async execute(sock, m, { from, isGroup, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;
        let current = await react(sock, m, '😂', lastBotResponse, GLOBAL_COOLDOWN);

        const total = memeStore.countMemes();
        if (!total) {
            await sock.sendMessage(from, {
                text: `😂 *Nenhum meme ainda!*\n\nEnvie uma foto com a legenda *${config.prefix}postarmeme* ou marque uma foto com *${config.prefix}postarmeme* para adicionar o primeiro.`
            }, { quoted: m });
            return current;
        }

        // Sem delay/cooldown — sorteio imediato (pedido do dono).

        const { meme, cycled } = memeStore.pickRandomMeme(isGroup ? from : null);
        if (!meme) {
            await sock.sendMessage(from, { text: '❌ Falha ao sortear. Tente de novo.' }, { quoted: m });
            return await react(sock, m, '❌', current, GLOBAL_COOLDOWN);
        }
        const buf = memeStore.readMemeBuffer(meme.file_path);
        if (!buf) {
            await sock.sendMessage(from, { text: `⚠️ Arquivo do meme #${meme.id} sumiu. Peça a um admin para usar *${config.prefix}delmeme ${meme.id}*.` }, { quoted: m });
            return await react(sock, m, '❌', current, GLOBAL_COOLDOWN);
        }

        // Mostra o grupo de ORIGEM (onde foi postado) ou "privado" — não o grupo atual.
        const caption = memeStore.buildMemeCaption(meme)
            + (cycled ? `\n\n🔄 *Ciclo reiniciado — todos os memes já foram vistos aqui!*` : '');
        await sock.sendMessage(from, { image: buf, caption }, { quoted: m });
        if (isGroup) memeStore.recordMemeSend(from, meme.id);
        return await react(sock, m, '✅', current, GLOBAL_COOLDOWN);
    }
};
