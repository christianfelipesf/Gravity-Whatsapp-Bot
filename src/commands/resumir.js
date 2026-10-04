module.exports = {
    name: 'resumir',
    aliases: ['resumo', 'resuma'],
    category: 'ai',
    description: 'Resume as últimas mensagens do chat',
    async execute(sock, m, { from, isGroup, fullArgsText, config, utils, model, lastBotResponse, GLOBAL_COOLDOWN, abortSignal }) {
        const { react, getBotName, getMessageText, getChatHistory } = utils;
        
        if (!isGroup) return await react(sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);
        if (!model) {
            await sock.sendMessage(from, { text: '❌ IA não configurada.' }, { quoted: m });
            return lastBotResponse;
        }
        
        let currentBotResponse = await react(sock, m, '📝', lastBotResponse, GLOBAL_COOLDOWN);
        try {
            let contentToSummarize = '';
            const quotedInfo = m.message.extendedTextMessage?.contextInfo;
            const quotedMsg = quotedInfo?.quotedMessage;

            let basePrompt = config.summaryPrompt || "Resuma as mensagens:";
            const botNameForAI = getBotName(from, config);
            
            if (quotedMsg) {
                const quotedText = getMessageText(quotedMsg);
                if (!quotedText) {
                    await sock.sendMessage(from, { text: '❌ Mensagem sem texto.' }, { quoted: m });
                    return currentBotResponse;
                }
                const quotedSender = quotedInfo.pushName || 'Usuário';
                contentToSummarize = `Contexto da mensagem de ${quotedSender}: "${quotedText}"\n\nInstrução: ${fullArgsText || 'Resuma o texto.'}`;
                basePrompt = (config.aiPrompt || "Você é uma IA útil.").replace(/{botName}/g, botNameForAI);
            } else {
                const history = getChatHistory(from, config.summaryLimit || 20);
                if (!history || history.length === 0) {
                    await sock.sendMessage(from, { text: '❌ Sem histórico.' }, { quoted: m });
                    return currentBotResponse;
                }
                contentToSummarize = history.map(msg => {
                    const time = new Date(msg.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    return `[${time}] ${msg.pushName}: ${msg.text}`;
                }).join('\n');
                basePrompt = basePrompt.replace(/{botName}/g, botNameForAI);
            }

            const maxPromptLength = Number(config?.aiMaxPromptLength) || 2000;
            // Estilo WhatsApp aplicado de leve mesmo com prompt customizado
            const styleSuffix = '\n\n[Estilo: parágrafos narrativos curtos, sem lista. Formatação WhatsApp de leve — *negrito* em nomes/palavras-chave, _itálico_ em observações, > citação para no máx. 1 frase marcante, `código` só se precisar. Use de 4 a 8 emojis no texto 📝✨😂🔥🤖👀, sem exagerar.]';
            let finalPrompt = `${basePrompt}\n\n${contentToSummarize}${styleSuffix}`;
            if (finalPrompt.length > maxPromptLength) {
                const maxContentLength = maxPromptLength - basePrompt.length - styleSuffix.length - 200;
                if (maxContentLength > 100) {
                    contentToSummarize = contentToSummarize.slice(0, maxContentLength) + '\n\n[Nota: histórico truncado por limite de tokens.]';
                    finalPrompt = `${basePrompt}\n\n${contentToSummarize}${styleSuffix}`;
                }
            }
            const result = await model.generateContent(finalPrompt, { signal: abortSignal });
            const responseText = result.response.text();
            
            if (!responseText) throw new Error('Resposta vazia da IA');
            const styledText = `📝 *Resumo do chat* ✨\n\n${responseText.trim()}\n\n> _resumo automático 🤖_`;
            await sock.sendMessage(from, { text: styledText }, { quoted: m }); 
            return await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            if (e?.code === 'ABORTED' || abortSignal?.aborted) return currentBotResponse;
            console.error('❌ [RESUMO] Erro:', e?.response?.data || e.message || e);
            await sock.sendMessage(from, { text: '❌ Falha ao resumir. Verifique a chave da IA ou o limite de uso.' }, { quoted: m }); 
            return currentBotResponse;
        }
    }
};
