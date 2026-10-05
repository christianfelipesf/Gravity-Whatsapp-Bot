module.exports = {
    name: 'ai',
    aliases: ['ia', 'grok', 'gemini', 'gpt', 'chatgpt'],
    category: 'ai',
    description: 'Pergunta para a inteligência artificial',
    async execute(sock, m, { from, isGroup, sender, senderName, commandName, fullArgsText, utils, model, config, lastBotResponse, GLOBAL_COOLDOWN, abortSignal }) {
        const { react, reactStatus, getMessageText } = utils;
        if (!model) {
            try { require('../services/safeDebug').reportSensitive({ title: 'IA sem chave', detail: 'Comando !ai chamado sem modelo configurado (OPENROUTER_API_KEY ausente).', key: 'ia-sem-chave', cooldownMs: 60 * 60 * 1000 }); } catch (_) {}
            await sock.sendMessage(from, { text: '❌ IA indisponível no momento. Fale com o dono do bot.' }, { quoted: m });
            return lastBotResponse;
        }
        
        try {
            let prompt = fullArgsText;
            const quotedInfo = m.message.extendedTextMessage?.contextInfo;
            const quotedMsg = quotedInfo?.quotedMessage;
            const maxPromptLength = Number(config?.aiMaxPromptLength) || 2000;

            if (quotedMsg) {
                const quotedText = getMessageText(quotedMsg);
                if (quotedText) {
                    const quotedSender = quotedInfo.pushName || 'Usuário';
                    prompt = `Contexto da mensagem de ${quotedSender}: "${quotedText}"\n\nPergunta/Comando: ${fullArgsText || 'Analise ou responda a esta mensagem.'}`;
                }
            }

            if (!prompt) {
                await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
                await sock.sendMessage(from, { text: '❌ Digite um texto para conversar com a IA.' }, { quoted: m });
                return lastBotResponse;
            }

            if (prompt.length > maxPromptLength * 2) {
                await sock.sendMessage(from, { text: `❌ Prompt muito longo (${prompt.length} caracteres). Máximo permitido: ${maxPromptLength * 2}.` }, { quoted: m });
                return lastBotResponse;
            }

            // Contexto de fundo (comandos, grupos, grupo atual, admin,
            // solicitante, 3 msgs anteriores) — só referência, não é assunto.
            let currentBotResponse = await react(sock, m, '🤖', lastBotResponse, GLOBAL_COOLDOWN);
            try {
                const { buildAIContextBlock } = require('../services/aiContext');
                const ctxBlock = await buildAIContextBlock(sock, { from, isGroup, sender, senderName, commandName, m, config, utils });
                if (ctxBlock) {
                    // Garante que bloco + pergunta caibam no teto do setupAI
                    // (maxPromptLength): corta a pergunta, nunca o contexto.
                    const budget = Math.max(500, maxPromptLength - ctxBlock.length - 50);
                    if (prompt.length > budget) {
                        prompt = prompt.slice(0, budget) + '\n[Nota: mensagem truncada para caber o contexto.]';
                    }
                    prompt = `${ctxBlock}\n\nPergunta:\n${prompt}`;
                }
            } catch (_) { /* sem contexto, segue só com a pergunta */ }

            const result = await model.generateContent(prompt, { signal: abortSignal });
            // Anti-zumbi: o dispatcher já avisou timeout e liberou o handler.
            // Se abortou durante a chamada, não envia a resposta tardia.
            if (abortSignal?.aborted) return lastBotResponse;
            const text = String(result.response.text() ?? '').trim();
            if (!text) throw new Error('Resposta vazia da IA');
            if (abortSignal?.aborted) return lastBotResponse;
            await sock.sendMessage(from, { text }, { quoted: m }); 
            return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            // ABORTED = o dispatcher (message.js) já avisou o timeout ao usuário; evita resposta zumbi duplicada
            if (e?.code === 'ABORTED' || abortSignal?.aborted) return lastBotResponse;
            console.error('❌ [IA] Erro:', e?.response?.data || e.message || e);
            const msg = String(e?.message || '');
            if (/resposta vazia/i.test(msg)) {
                await sock.sendMessage(from, { text: '❌ A IA retornou resposta vazia. Tente novamente com outra pergunta.' }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: '❌ Comandos de IA indisponíveis no momento.' }, { quoted: m });
            }
            return lastBotResponse;
        }
    }
};
