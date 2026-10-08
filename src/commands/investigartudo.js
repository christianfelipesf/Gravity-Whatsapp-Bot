// investigartudo.js — modo pesado multi-chamadas (agentic loop com tools).
// Guardião pra cima (dono/sub-dono/guardião). Somente leitura.

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

async function doInvestigate(sock, m, { from, isGroup, sender, utils, model, lastBotResponse, GLOBAL_COOLDOWN, abortSignal, log }, investigation) {
    const { react, reactStatus } = utils;
    let currentBotResponse = await react(sock, m, '🔎', lastBotResponse, GLOBAL_COOLDOWN);
    const { runInvestigativeLoop } = require('../services/ownerAgent');
    const { answer, partial, usage } = await runInvestigativeLoop({
        model, sock, question: investigation, from, isGroup,
        requesterName: m.pushName || sender, utils, signal: abortSignal, log
    });
    const header = partial ? '🔎 *Investigação (parcial)*\n\n' : '🔎 *Investigação*\n\n';
    await sock.sendMessage(from, { text: header + answer }, { quoted: m });
    try { log?.('investigartudo fim', `${usage.rounds} rounds`); } catch (_) {}
    return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
}

function usage(prefix) {
    return `🔎 *!investigartudo — investigação profunda*\n\n` +
        `Modo pesado com várias chamadas de IA (até 4 rodadas de busca + resposta).\n\n` +
        `• \`${prefix}investigartudo quem está causando briga no grupo?\`\n` +
        `• \`${prefix}investigartudo o que o @fulano falou essa semana?\`\n\n` +
        `Pede confirmação antes (custa ~$0,001–0,003 e leva ~1 min).\n` +
        `🛡️ Só dono, sub-donos ou guardiões. Somente leitura — nada é alterado.`;
}

module.exports = {
    name: 'investigartudo',
    aliases: ['investigar-geral', 'invgeral', 'investigartotal'],
    category: 'ai',
    description: 'Investigação profunda multi-chamadas (dono/subdono/guardião)',
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
            try { require('../services/safeDebug').reportSensitive({ title: 'IA sem chave', detail: 'Comando !investigartudo chamado sem modelo configurado (OPENROUTER_API_KEY ausente).', key: 'ia-sem-chave', cooldownMs: 60 * 60 * 1000 }); } catch (_) {}
            await sock.sendMessage(from, { text: '❌ IA indisponível no momento. Fale com o dono do bot.' }, { quoted: m });
            return lastBotResponse;
        }

        let currentBotResponse = await react(sock, m, '🔎', lastBotResponse, GLOBAL_COOLDOWN);
        try {
            const qLower = question.toLowerCase().trim();

            const pending = getPending(from, sender);
            if (pending && /^(sim|confirmar|confirmo|confirmado|vai|pode ir|ok|yes|bora|s)\s*[.!?]*$/.test(qLower)) {
                clearPending(from, sender);
                return await doInvestigate(sock, m, { from, isGroup, sender, utils, model, lastBotResponse: currentBotResponse, GLOBAL_COOLDOWN, abortSignal, log }, pending.question);
            }
            if (pending && /^(não|nao|n|cancela|cancelar|cancelado|para|stop|melhor não)\s*[.!?]*$/.test(qLower)) {
                clearPending(from, sender);
                await sock.sendMessage(from, { text: '👍 Investigação cancelada. Nada foi executado.' }, { quoted: m });
                return await reactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            setPending(from, sender, question);
            currentBotResponse = await react(sock, m, '❓', currentBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(from, {
                text: `🔎 *Confirmar investigação?*\n\n📌 *Alvo:* ${question.slice(0, 300)}\n\n` +
                    `• Até 4 rodadas de busca + resposta (leva ~1 min)\n` +
                    `• Custo estimado: ~$0,001–0,003\n` +
                    `• Somente leitura — nada será alterado\n\n` +
                    `Responda \`${prefix}investigartudo sim\` para confirmar ou \`${prefix}investigartudo não\` para cancelar (vale por 2 min).`
            }, { quoted: m });
            return currentBotResponse;
        } catch (e) {
            if (e?.code === 'ABORTED' || abortSignal?.aborted) return currentBotResponse;
            console.error('❌ [INVESTIGARTUDO] Erro:', e?.response?.data || e.message || e);
            await sock.sendMessage(from, { text: '❌ Falha ao investigar. Tente novamente.' }, { quoted: m });
            return await reactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }
    }
};
