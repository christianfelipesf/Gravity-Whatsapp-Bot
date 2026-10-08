const { resolveTargets, buildEvidence, buildComparisonEvidence, matchFactual, wantsLogs, wantsProfileSummary, evidenceIsEmpty, extractTimeRange, rangesForComparison } = require('../services/ownerEvidence');

// Confirmações pendentes do modo tudo: chave `${from}::${sender}`.
// Evita rodar investigação cara (multi-chamadas de IA) sem querer.
const _pendingInvestigations = new Map();
const CONFIRM_TTL_MS = 2 * 60 * 1000;

function pendingKey(from, sender) {
    return `${String(from || '')}::${String(sender || '')}`;
}

function getPending(from, sender) {
    const k = pendingKey(from, sender);
    const p = _pendingInvestigations.get(k);
    if (!p) return null;
    if (Date.now() > p.expiresAt) {
        _pendingInvestigations.delete(k);
        return null;
    }
    return p;
}

function setPending(from, sender, question) {
    const k = pendingKey(from, sender);
    _pendingInvestigations.set(k, { question, expiresAt: Date.now() + CONFIRM_TTL_MS });
    try {
        const t = setTimeout(() => _pendingInvestigations.delete(k), CONFIRM_TTL_MS + 5000);
        if (t && typeof t.unref === 'function') t.unref();
    } catch (_) {}
}

function clearPending(from, sender) {
    _pendingInvestigations.delete(pendingKey(from, sender));
}

async function doInvestigate(sock, m, { from, isGroup, sender, config, utils, model, lastBotResponse, GLOBAL_COOLDOWN, abortSignal, log, prefix }, investigation) {
    const { react, reactStatus } = utils;
    let currentBotResponse = await react(sock, m, '🔎', lastBotResponse, GLOBAL_COOLDOWN);
    const { runInvestigativeLoop } = require('../services/ownerAgent');
    const { answer, partial, usage } = await runInvestigativeLoop({
        model, sock, question: investigation, from, isGroup,
        requesterName: m.pushName || sender, utils, signal: abortSignal, log
    });
    const header = partial ? '🔎 *Investigação (parcial)*\n\n' : '🔎 *Investigação*\n\n';
    await sock.sendMessage(from, { text: header + answer }, { quoted: m });
    try { log?.('investigar fim', `${usage.rounds} rounds`); } catch (_) {}
    return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
}

const OWNER_SYSTEM = 'Você é o investigador do bot 🤖. Responda com emojis ✨, de forma direta e objetiva, com base APENAS nas evidências abaixo (mensagens reais, advertências e atividade). ⚠️ Só mencione advertências se perguntarem sobre isso — nunca traga esse assunto por conta própria. Quando a evidência disser "no histórico todo (amostra distribuída)", é um RESUMÃO do período inteiro: faça perfil completo com temas recorrentes, gostos/interesses que aparecem nas falas (comida, música, time, hobbies etc.), jeito/tom da pessoa e exemplos — nunca resuma só as 2-3 últimas linhas. Se houver mensagens na evidência, SEMPRE faça o resumo do jeito/tom da pessoa com o que tem: nunca diga "não há dados suficientes" só porque falta um detalhe (ex.: gostos específicos); nesse caso resuma o que dá pra ver e diga com emoji o que não deu pra saber 🤷. Só diga que não há dados suficientes quando a evidência estiver realmente vazia (zero mensagens). Nunca invente nomes, números ou fatos. Identificadores técnicos (jids como "123@lid"/"456@s.whatsapp.net" ou sequências numéricas longas) são internos: NUNCA os repita na resposta; refira-se às pessoas só pelo nome, ou "a pessoa"/"pessoa A, B" quando o nome for desconhecido. Você só responde perguntas, nunca executa ações.';

// Sem prompt (só marcação): "!investigar @a" vira resumão,
// "!investigar @a @b" vira relação entre elas.
function _escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function stripPromptForEmptiness(question, targets) {
    let s = String(question || '');
    s = s.replace(/@\S+/g, ' ');
    s = s.replace(/\d{8,}/g, ' ');
    try {
        for (const g of (targets?.groups || [])) {
            if (g?.subject && String(g.subject).trim().length >= 2) {
                s = s.replace(new RegExp(_escapeRegExp(String(g.subject).trim()), 'ig'), ' ');
            }
        }
    } catch (_) {}
    s = s.replace(/\b(grupo|gp|pessoa|usu[aá]rio)\b/gi, ' ');
    s = s.replace(/[?.!,;:\-—*`"'()\[\]{}]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}
function defaultQuestionFor(targets) {
    const n = (targets?.people || []).length;
    if (n === 1) return 'Faça um resumo geral sobre essa pessoa: tudo que ela já digitou, temas recorrentes, gostos/interesses que aparecem nas falas, jeito/tom dela, com exemplos.';
    if (n >= 2) return `Mostre a relação entre essas ${n} pessoas: interações entre elas, assuntos em comum ou divergências, quem fala mais, tom/jeito de cada uma, com exemplos.`;
    if ((targets?.groups || []).length > 0) return 'Faça um resumo geral: clima, temas recorrentes, quem mais fala, tom do grupo, com exemplos.';
    return null;
}

// Formato do perfil/resumão: INSPIRAÇÃO p/ a IA, nunca template rígido.
// A IA deve variar títulos, ordem e eixos conforme o caso — o que vale
// é o espírito (cabeçalho, pitch, bullets, fechamento, lacunas).
// Só entra em pergunta de perfil/relação — lista de falas, comparação
// de janelas e factual continuam diretos como antes.
const SINGLE_FORMAT_HINT = '\n\n[Jeito de responder — inspiração, NÃO siga ao pé da letra: varie títulos, ordem e eixos, use suas palavras]\n' +
    '• Abra identificando a pessoa com um emoji temático\n' +
    '• Dê um pitaco inicial de 1 frase resumindo a personalidade\n' +
    '• Desenvolva em bullets curtos por eixos (ex.: jeito/tom, temas recorrentes, interação, estilo social) com a palavra-chave em *negrito*\n' +
    '• Feche com 1 linha de conclusão e seja honesto sobre o que não deu pra mapear 🤷\n' +
    'Estilo: conversacional e descontraído, gíria leve de internet, bastante emoji no fim das frases, frases curtas e diretas, cite falas reais entre aspas como prova. Só use as evidências, nunca invente.';

const MULTI_FORMAT_HINT = '\n\n[Jeito de responder — inspiração, NÃO siga ao pé da letra: varie títulos, ordem e eixos, use suas palavras]\n' +
    '• Abra identificando as pessoas com um emoji temático\n' +
    '• Dê 1 frase resumindo cada uma\n' +
    '• Desenvolva em bullets curtos (ex.: interações, assuntos em comum/divergências, quem fala mais, tom de cada uma) com a palavra-chave em *negrito*\n' +
    '• Feche com 1 linha sobre a relação e seja honesto sobre o que não deu pra mapear 🤷\n' +
    'Estilo: conversacional e descontraído, gíria leve de internet, bastante emoji no fim das frases, frases curtas e diretas, cite falas reais entre aspas como prova. Só use as evidências, nunca invente.';

function usage(prefix) {
    return `🕵️ *!investigar — IA investigativa*\n\n` +
        `Pergunte sobre pessoas ou grupos citando dados reais:\n` +
        `• \`${prefix}investigar @fulano o que acha dele?\`\n` +
        `• \`${prefix}investigar @fulano\` (sem pergunta: resumão geral da pessoa)\n` +
        `• \`${prefix}investigar @a @b quem fala mais? (várias menções ok)\`\n` +
        `• \`${prefix}investigar @a @b\` (sem pergunta: relação entre elas)\n` +
        `• \`${prefix}investigar @fulano o que falou há 3 dias? / ontem? / nessa semana?\`\n` +
        `• \`${prefix}investigar @fulano o que falou ontem tem a ver com hoje?\`\n` +
        `• \`${prefix}investigar quantas adv tem @fulano?\` (resposta direta, sem IA)\n` +
        `• \`${prefix}investigar grupo Amigos como está o clima?\`\n` +
        `• \`${prefix}investigar quais erros deram hoje?\` / \`${prefix}investigar quais comandos rodaram?\`\n` +
        `• Responda a mensagem de alguém com \`${prefix}investigar resume essa pessoa\`\n` +
        `• \`${prefix}investigar tudo quem está causando briga no grupo?\` (modo pesado, pede confirmação antes)\n\n` +
        `Aberto a todos. Somente leitura — nunca pune nem executa ações.`;
}

module.exports = {
    name: 'investigar',
    aliases: ['aidono', 'iadono'],
    category: 'ai',
    description: 'IA investigativa: pergunta sobre pessoas/grupos com base nas mensagens (aberto a todos)',
    async execute(sock, m, { from, isGroup, sender, fullArgsText, config, utils, model, lastBotResponse, GLOBAL_COOLDOWN, abortSignal, log }) {
        const { react, reactStatus } = utils;

        const prefix = config.prefix || '!';
        const question = String(fullArgsText || '').trim();
        if (!model) {
            try { require('../services/safeDebug').reportSensitive({ title: 'IA sem chave', detail: 'Comando !investigar chamado sem modelo configurado (OPENROUTER_API_KEY ausente).', key: 'ia-sem-chave', cooldownMs: 60 * 60 * 1000 }); } catch (_) {}
            await sock.sendMessage(from, { text: '❌ IA indisponível no momento. Fale com o dono do bot.' }, { quoted: m });
            return lastBotResponse;
        }

        let currentBotResponse = await react(sock, m, '🕵️', lastBotResponse, GLOBAL_COOLDOWN);
        try {
            const qLower = question.toLowerCase().trim();

            // Resposta a uma confirmação pendente do modo tudo.
            const pending = getPending(from, sender);
            if (pending && /^(sim|confirmar|confirmo|confirmado|vai|pode ir|ok|yes|bora|s)\s*[.!?]*$/.test(qLower)) {
                clearPending(from, sender);
                return await doInvestigate(sock, m, { from, isGroup, sender, config, utils, model, lastBotResponse: currentBotResponse, GLOBAL_COOLDOWN, abortSignal, log, prefix }, pending.question);
            }
            if (pending && /^(não|nao|n|cancela|cancelar|cancelado|para|stop|melhor não)\s*[.!?]*$/.test(qLower)) {
                clearPending(from, sender);
                await sock.sendMessage(from, { text: '👍 Investigação cancelada. Nada foi executado.' }, { quoted: m });
                return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            // Modo pesado: NÃO roda direto — pede confirmação primeiro
            // (são várias chamadas de IA; evita gasto por digitação errada).
            // Aceita `tudo` (novo) e `investigar` (compat com o antigo !aidono).
            const invMatch = question.match(/^(?:tudo|investigar)\s+(.+)/is);
            if (invMatch) {
                const investigation = String(invMatch[1] || '').trim();
                if (!investigation) {
                    await sock.sendMessage(from, { text: `❌ Descreva o que investigar.\nEx.: \`${prefix}investigar tudo quem está causando briga?\`` }, { quoted: m });
                    return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
                }
                setPending(from, sender, investigation);
                currentBotResponse = await react(sock, m, '❓', currentBotResponse, GLOBAL_COOLDOWN);
                await sock.sendMessage(from, {
                    text: `🔎 *Confirmar investigação?*\n\n📌 *Alvo:* ${investigation.slice(0, 300)}\n\n` +
                        `• Até 4 rodadas de busca + resposta (leva ~1 min)\n` +
                        `• Custo estimado: ~$0,001–0,003\n` +
                        `• Somente leitura — nada será alterado\n\n` +
                        `Responda \`${prefix}investigar sim\` para confirmar ou \`${prefix}investigar não\` para cancelar (vale por 2 min).`
                }, { quoted: m });
                return currentBotResponse;
            }

            const targets = await resolveTargets(sock, m, question, utils, from);
            const explicitPeople = targets.people.length;
            const explicitGroups = targets.groups.length;
            // Sem prompt + só marcação: "!investigar @a" (resumão),
            // "!investigar @a @b" (relação). Também vale p/ resposta
            // sem texto (quoted) — o alvo vem do contextInfo.
            // Bare "!investigar" sem alvo continua mostrando o ajuda.
            if (!question && explicitPeople === 0 && explicitGroups === 0) {
                await sock.sendMessage(from, { text: usage(prefix) }, { quoted: m });
                return lastBotResponse;
            }
            // Sem alvo explícito em grupo: usa o grupo atual como contexto.
            // (Só quando há pergunta — bare já saiu acima.)
            if (targets.people.length === 0 && targets.groups.length === 0 && isGroup && question) {
                let subject = 'Grupo';
                try {
                    const gm = await utils.groupMetadataCached(sock, from).catch(() => null);
                    if (gm?.subject) subject = gm.subject;
                } catch (_) {}
                targets.groups.push({ jid: from, subject });
            }
            let questionEff = question;
            let isDefaultSummary = false;
            if (targets.people.length > 0 || explicitGroups > 0) {
                const stripped = stripPromptForEmptiness(question, targets);
                // Resposta citada sem texto também cai aqui (question === '').
                if (!stripped) {
                    const def = defaultQuestionFor(targets);
                    if (def) {
                        questionEff = def;
                        isDefaultSummary = true;
                    }
                }
            }
            // Pergunta só sobre logs não precisa de pessoa/grupo.
            const logOnly = targets.people.length === 0 && targets.groups.length === 0 && wantsLogs(questionEff);
            if (targets.people.length === 0 && targets.groups.length === 0 && !logOnly) {
                await sock.sendMessage(from, { text: `❌ Não identifiquei pessoa nem grupo.\n\n${usage(prefix)}` }, { quoted: m });
                return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            const maxPromptLength = Number(config?.aiMaxPromptLength) || 8000;
            const qShort = questionEff.slice(0, 800);
            // Janela de tempo ("há 3 dias", "ontem"): responde com as falas da
            // janela, direto do histórico de 7 dias (fast-path, sem IA).
            // Comparação ("ontem tem a ver com hoje?"): duas janelas curtas
            // fundidas p/ a IA julgar (fast-path nunca julga).
            const cmpRanges = rangesForComparison(questionEff);
            const timeRange = cmpRanges ? cmpRanges[0] : extractTimeRange(questionEff);
            // Build ÚNICO (antes eram até 4 rebuilds [14,10,6,3] que varriam o
            // banco 4x com muito dado). Se estourar o teto, corta o texto
            // mantendo as linhas mais novas — sem re-consultar o SQLite.
            const fitBudget = (text) => OWNER_SYSTEM.length + text.length + qShort.length + 60 <= maxPromptLength;
            let evidence = null;
            if (cmpRanges && (targets.people.length > 0 || targets.groups.length > 0)) {
                evidence = await buildComparisonEvidence(sock, targets, { from, isGroup, utils, question: questionEff, ranges: cmpRanges, msgLimit: 12 });
                if (!fitBudget(evidence.text)) {
                    const budget = Math.max(500, maxPromptLength - OWNER_SYSTEM.length - qShort.length - 60);
                    const lines = evidence.text.split('\n');
                    let acc = 0;
                    const kept = [];
                    for (let i = lines.length - 1; i >= 0; i--) {
                        acc += lines[i].length + 1;
                        if (acc > budget) break;
                        kept.unshift(lines[i]);
                    }
                    evidence = { ...evidence, text: kept.join('\n'), truncated: true };
                }
            } else {
                // Perfil/resumão sem janela ("o que ela gosta?", "resume essa
                // pessoa"): amostra maior e espalhada no período — não só as
                // últimas. Linhas mais curtas p/ caber ~30 no mesmo teto.
                // Resumo padrão (sem prompt) sempre usa esse modo.
                const isProfile = !timeRange && targets.people.length > 0 && (isDefaultSummary || wantsProfileSummary(questionEff));
                evidence = await buildEvidence(sock, targets, {
                    from, isGroup, utils,
                    msgLimit: isProfile ? 30 : 20,
                    msgChars: isProfile ? 160 : 220,
                    groupMsgChars: 180, question: questionEff, timeRange
                });
                if (!fitBudget(evidence.text)) {
                    const budget = Math.max(500, maxPromptLength - OWNER_SYSTEM.length - qShort.length - 60);
                    const sampled = (evidence.stats?.people || []).some((p) => p.sampled);
                    if (sampled) {
                        // Thin distribuído: mantém cabeçalhos e afina as linhas
                        // de mensagem de forma espaçada (não só as mais novas,
                        // senão o resumão vira "recente" de novo).
                        const lines = evidence.text.split('\n');
                        const header = lines.filter((l) => !l.startsWith('  ['));
                        const msgs = lines.filter((l) => l.startsWith('  ['));
                        const headerLen = header.join('\n').length + 1;
                        let keep = msgs;
                        // reduz espaçadamente até caber (passo simples e seguro)
                        while (keep.length > 5 && (headerLen + keep.join('\n').length) > budget) {
                            keep = keep.filter((_, i) => i % 2 === 0);
                        }
                        // se ainda estourar, corta do meio (mantém início e fim)
                        if ((headerLen + keep.join('\n').length) > budget && keep.length > 5) {
                            let acc = headerLen;
                            const out = [];
                            const half = Math.ceil(keep.length / 2);
                            const first = keep.slice(0, half);
                            const last = keep.slice(half);
                            for (const l of first) {
                                if (acc + l.length + 1 > budget) break;
                                out.push(l); acc += l.length + 1;
                            }
                            const tail = [];
                            for (let i = last.length - 1; i >= 0; i--) {
                                if (acc + last[i].length + 1 > budget) break;
                                tail.unshift(last[i]); acc += last[i].length + 1;
                            }
                            keep = [...out, ...tail];
                        }
                        evidence = { ...evidence, text: [...header, ...keep].join('\n'), truncated: true };
                    } else {
                        const lines = evidence.text.split('\n');
                        let acc = 0;
                        const kept = [];
                        for (let i = lines.length - 1; i >= 0; i--) {
                            acc += lines[i].length + 1;
                            if (acc > budget) break;
                            kept.unshift(lines[i]);
                        }
                        evidence = { ...evidence, text: kept.join('\n'), truncated: true };
                    }
                }
            }
            try { log?.('investigar evidencia', `${evidence.text.length} chars${evidence.truncated ? ' (cortada p/ teto)' : ''} windowTotal=${JSON.stringify((evidence.stats?.people || []).map((p) => p.windowTotal))}`); } catch (_) {}
            if (!evidence.text || evidenceIsEmpty(evidence.stats)) {
                const who = (evidence.stats?.people || []).map((p) => p.label).filter(Boolean).join(', ');
                const win = cmpRanges ? ` ${cmpRanges[0].label} × ${cmpRanges[1].label}` : (timeRange ? ` ${timeRange.label}` : '');
                const mediaOnly = (evidence.stats?.people || []).filter((p) => (p.mediaOnly || 0) > 0 && (p.windowTotal || 0) === 0);
                const mediaHint = mediaOnly.length > 0
                    ? `\n• 📎 ${mediaOnly.map((p) => `${p.label} só tem ${p.mediaOnly} mídia sem texto`).join('; ')} — peça para a pessoa escrever algo.`
                    : '';
                await sock.sendMessage(from, {
                    text: `❌ Sem dados${who ? ` sobre ${who}` : ''}${win} no histórico.\n\n` +
                        `💡 Verifiquei: nome nos logs, mensagens (painel + geral), atividade, advertências e logs do bot.\n` +
                        `• Isso acontece quando a pessoa nunca falou em grupo com o bot ativo, ou só antes do bot chegar.${mediaHint}\n` +
                        `• Para registrar daqui pra frente: ative o bot (e o painel) nos grupos dela.`
                }, { quoted: m });
                return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            // Fast-path factual (R$0, sem IA).
            // Resumo padrão nunca vai no fast-path: sempre gera perfil/relação via IA.
            const factual = isDefaultSummary ? null : matchFactual(questionEff, evidence, { isGroup, from, utils });
            if (factual) {
                await sock.sendMessage(from, { text: factual }, { quoted: m });
                return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            const finalPrompt = `${OWNER_SYSTEM}\n\n[Evidências]\n${evidence.text}\n\nPergunta:\n${qShort}${((isDefaultSummary || wantsProfileSummary(questionEff)) && !cmpRanges) ? (targets.people.length >= 2 ? MULTI_FORMAT_HINT : SINGLE_FORMAT_HINT) : ''}`;
            const result = await model.generateContent(finalPrompt, { signal: abortSignal });
            if (abortSignal?.aborted) return currentBotResponse;
            const text = String(result.response.text() ?? '').trim();
            if (!text) throw new Error('Resposta vazia da IA');
            if (abortSignal?.aborted) return currentBotResponse;
            await sock.sendMessage(from, { text }, { quoted: m });
            return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            if (e?.code === 'ABORTED' || abortSignal?.aborted) return currentBotResponse;
            console.error('❌ [INVESTIGAR] Erro:', e?.response?.data || e.message || e);
            const msg = String(e?.message || '');
            await sock.sendMessage(from, { text: /resposta vazia/i.test(msg) ? '❌ A IA retornou resposta vazia. Tente de novo.' : '❌ Falha ao consultar. Tente novamente.' }, { quoted: m });
            return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }
    }
};
