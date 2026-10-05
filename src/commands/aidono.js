const { resolveTargets, buildEvidence, buildComparisonEvidence, matchFactual, wantsLogs, evidenceIsEmpty, extractTimeRange, rangesForComparison } = require('../services/ownerEvidence');

// Confirmações pendentes do modo investigar: chave `${from}::${sender}`.
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

const OWNER_SYSTEM = 'Você é o auxiliar privado do dono do bot 🤖. Responda com emojis ✨, de forma direta e objetiva, com base APENAS nas evidências abaixo (mensagens reais, advertências e atividade). ⚠️ Só mencione advertências se o dono perguntar sobre isso — nunca traga esse assunto por conta própria. Se houver mensagens na evidência, SEMPRE faça o resumo do jeito/tom da pessoa com o que tem: nunca diga "não há dados suficientes" só porque falta um detalhe (ex.: gostos específicos); nesse caso resuma o que dá pra ver e diga com emoji o que não deu pra saber 🤷. Só diga que não há dados suficientes quando a evidência estiver realmente vazia (zero mensagens). Nunca invente nomes, números ou fatos. Identificadores técnicos (jids como "123@lid"/"456@s.whatsapp.net" ou sequências numéricas longas) são internos: NUNCA os repita na resposta; refira-se às pessoas só pelo nome, ou "a pessoa"/"pessoa A, B" quando o nome for desconhecido. Você só responde perguntas, nunca executa ações.';

function usage(prefix) {
    return `🕵️ *!aidono — IA do dono*\n\n` +
        `Pergunte sobre pessoas ou grupos citando dados reais:\n` +
        `• \`${prefix}aidono @fulano o que acha dele?\`\n` +
        `• \`${prefix}aidono @a @b quem fala mais? (várias menções ok)\`\n` +
        `• \`${prefix}aidono @fulano o que falou há 3 dias? / ontem? / nessa semana?\`\n` +
        `• \`${prefix}aidono @fulano o que falou ontem tem a ver com hoje?\`\n` +
        `• \`${prefix}aidono quantas adv tem @fulano?\` (resposta direta, sem IA)\n` +
        `• \`${prefix}aidono grupo Amigos como está o clima?\`\n` +
        `• \`${prefix}aidono quais erros deram hoje?\` / \`${prefix}aidono quais comandos rodaram?\`\n` +
        `• Responda a mensagem de alguém com \`${prefix}aidono resume essa pessoa\`\n` +
        `• \`${prefix}aidono investigar quem está causando briga no grupo?\` (pede confirmação antes)\n\n` +
        `👑 Só dono/subdono/guardião. Somente leitura — nunca pune nem executa ações.`;
}

module.exports = {
    name: 'aidono',
    aliases: ['iadono'],
    category: 'ai',
    description: 'IA do dono: pergunta sobre pessoas/grupos com base nas mensagens (dono/subdono/guardião)',
    async execute(sock, m, { from, isGroup, sender, fullArgsText, config, utils, model, lastBotResponse, GLOBAL_COOLDOWN, abortSignal, log }) {
        const { react, reactStatus } = utils;

        let access = typeof utils.canConfigureBot === 'function'
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: false };
        if (!access.ok && typeof utils.canGuardianActAsync === 'function') {
            try {
                const g = await utils.canGuardianActAsync(sock, m, sender, from);
                if (g && g.ok) access = { ok: true, guardiao: true };
            } catch (_) {}
        }
        if (!access.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono, sub-donos ou guardiões podem usar este comando.' }, { quoted: m });
        }

        const prefix = config.prefix || '!';
        const question = String(fullArgsText || '').trim();
        if (!question) {
            await sock.sendMessage(from, { text: usage(prefix) }, { quoted: m });
            return lastBotResponse;
        }
        if (!model) {
            try { require('../services/safeDebug').reportSensitive({ title: 'IA sem chave', detail: 'Comando !aidono chamado sem modelo configurado (OPENROUTER_API_KEY ausente).', key: 'ia-sem-chave', cooldownMs: 60 * 60 * 1000 }); } catch (_) {}
            await sock.sendMessage(from, { text: '❌ IA indisponível no momento. Fale com o dono do bot.' }, { quoted: m });
            return lastBotResponse;
        }

        let currentBotResponse = await react(sock, m, '🕵️', lastBotResponse, GLOBAL_COOLDOWN);
        try {
            const qLower = question.toLowerCase().trim();

            // Resposta a uma confirmação pendente do modo investigar.
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

            // Modo investigativo: NÃO roda direto — pede confirmação primeiro
            // (são várias chamadas de IA; evita gasto por digitação errada).
            const invMatch = question.match(/^investigar\s+(.+)/is);
            if (invMatch) {
                const investigation = String(invMatch[1] || '').trim();
                if (!investigation) {
                    await sock.sendMessage(from, { text: `❌ Descreva o que investigar.\nEx.: \`${prefix}aidono investigar quem está causando briga?\`` }, { quoted: m });
                    return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
                }
                setPending(from, sender, investigation);
                currentBotResponse = await react(sock, m, '❓', currentBotResponse, GLOBAL_COOLDOWN);
                await sock.sendMessage(from, {
                    text: `🔎 *Confirmar investigação?*\n\n📌 *Alvo:* ${investigation.slice(0, 300)}\n\n` +
                        `• Até 4 rodadas de busca + resposta (leva ~1 min)\n` +
                        `• Custo estimado: ~$0,001–0,003\n` +
                        `• Somente leitura — nada será alterado\n\n` +
                        `Responda \`${prefix}aidono sim\` para confirmar ou \`${prefix}aidono não\` para cancelar (vale por 2 min).`
                }, { quoted: m });
                return currentBotResponse;
            }

            const targets = await resolveTargets(sock, m, question, utils, from);
            // Sem alvo explícito em grupo: usa o grupo atual como contexto.
            if (targets.people.length === 0 && targets.groups.length === 0 && isGroup) {
                let subject = 'Grupo';
                try {
                    const gm = await utils.groupMetadataCached(sock, from).catch(() => null);
                    if (gm?.subject) subject = gm.subject;
                } catch (_) {}
                targets.groups.push({ jid: from, subject });
            }
            // Pergunta só sobre logs não precisa de pessoa/grupo.
            const logOnly = targets.people.length === 0 && targets.groups.length === 0 && wantsLogs(question);
            if (targets.people.length === 0 && targets.groups.length === 0 && !logOnly) {
                await sock.sendMessage(from, { text: `❌ Não identifiquei pessoa nem grupo.\n\n${usage(prefix)}` }, { quoted: m });
                return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            const maxPromptLength = Number(config?.aiMaxPromptLength) || 2000;
            const qShort = question.slice(0, 500);
            // Janela de tempo ("há 3 dias", "ontem"): responde com as falas da
            // janela, direto do histórico de 7 dias (fast-path, sem IA).
            // Comparação ("ontem tem a ver com hoje?"): duas janelas curtas
            // fundidas p/ a IA julgar (fast-path nunca julga).
            const cmpRanges = rangesForComparison(question);
            const timeRange = cmpRanges ? cmpRanges[0] : extractTimeRange(question);
            // Encolhe evidência até caber no teto (mantém as msgs mais novas).
            // Comparação usa janelas curtas (6→2); normal começa folgado (14).
            let evidence = null;
            if (cmpRanges && (targets.people.length > 0 || targets.groups.length > 0)) {
                for (const lim of [6, 4, 2]) {
                    evidence = await buildComparisonEvidence(sock, targets, { from, isGroup, utils, question, ranges: cmpRanges, msgLimit: lim });
                    const total = OWNER_SYSTEM.length + evidence.text.length + qShort.length + 60;
                    if (total <= maxPromptLength || lim === 2) break;
                }
            } else {
                for (const lim of [14, 10, 6, 3]) {
                    evidence = await buildEvidence(sock, targets, { from, isGroup, utils, msgLimit: lim, question, timeRange });
                    const total = OWNER_SYSTEM.length + evidence.text.length + qShort.length + 60;
                    if (total <= maxPromptLength || lim === 3) break;
                }
            }
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
            const factual = matchFactual(question, evidence, { isGroup, from, utils });
            if (factual) {
                await sock.sendMessage(from, { text: factual }, { quoted: m });
                return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            const finalPrompt = `${OWNER_SYSTEM}\n\n[Evidências]\n${evidence.text}\n\nPergunta do dono:\n${qShort}`;
            const result = await model.generateContent(finalPrompt, { signal: abortSignal });
            if (abortSignal?.aborted) return currentBotResponse;
            const text = String(result.response.text() ?? '').trim();
            if (!text) throw new Error('Resposta vazia da IA');
            if (abortSignal?.aborted) return currentBotResponse;
            await sock.sendMessage(from, { text }, { quoted: m });
            return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            if (e?.code === 'ABORTED' || abortSignal?.aborted) return currentBotResponse;
            console.error('❌ [AIDONO] Erro:', e?.response?.data || e.message || e);
            const msg = String(e?.message || '');
            await sock.sendMessage(from, { text: /resposta vazia/i.test(msg) ? '❌ A IA retornou resposta vazia. Tente de novo.' : '❌ Falha ao consultar. Tente novamente.' }, { quoted: m });
            return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }
    }
};
