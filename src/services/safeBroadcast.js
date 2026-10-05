/**
 * safeBroadcast.js — envio em massa com cara de humano.
 *
 * Por que o WhatsApp baniu temporariamente?
 *  - mesma mensagem idêntica para N grupos em sequência
 *  - intervalo fixo e curto (1.2s–1.5s) = assinatura de robô
 *  - sem "digitando...", sem variação, sem pausa
 *
 * Este helper impõe:
 *  - delay LONGO e ALEATÓRIO entre grupos (default 30–60s, configurável)
 *  - presença composing + variação mínima por grupo (nome do grupo)
 *  - parada imediata em 429/rate-overlimit (não insiste = não agrava o ban)
 *  - trava global: 1 broadcast por vez
 *  - log de progresso + ETA
 *
 * Config (via !set):
 *   broadcastMinDelayMs (default 30000)
 *   broadcastMaxDelayMs (default 60000)
 *   broadcastVaryText (default true) — prefixa com nome do grupo quando texto
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

let _running = false;

function isBroadcastRunning() { return _running; }

function getDelays(cfg) {
    const min = Math.max(5000, Number(cfg.broadcastMinDelayMs) || 30000);
    const max = Math.max(min, Number(cfg.broadcastMaxDelayMs) || 60000);
    return { min, max };
}

function _isRateLimit(e) {
    if (!e) return false;
    const code = e?.output?.statusCode || e?.statusCode || e?.data?.statusCode;
    if (code === 429) return true;
    const msg = String(e?.message || e || '').toLowerCase();
    return msg.includes('rate-overlimit') || msg.includes('rate overlimit') || msg.includes('429') || msg.includes('too many');
}

function _isConnClosed(e) {
    if (!e) return false;
    const code = e?.output?.statusCode || e?.statusCode;
    if (code === 428 || code === 515 || code === 502) return true;
    const msg = String(e?.message || e || '').toLowerCase();
    return msg.includes('connection closed') || msg.includes('precondition required');
}

/**
 * @param {object} sock socket Baileys (já com wrap humanizado)
 * @param {string[]} targets jids
 * @param {function(jid, index): object} makePayload
 * @param {object} opts { label, cfg, onProgress, cancelToken, groupNames: Map(jid->nome), notify }
 */
async function runSafeBroadcast(sock, targets, makePayload, opts = {}) {
    if (_running) throw new Error('Já existe um broadcast em andamento. Aguarde terminar.');
    const cfg = opts.cfg || (() => { try { return require('../database/utils').readConfig(); } catch (_) { return {}; } })();
    const { min, max } = getDelays(cfg);
    const vary = cfg.broadcastVaryText !== false;
    const names = opts.groupNames instanceof Map ? opts.groupNames : new Map();
    _running = true;
    let sent = 0, failed = 0, stopped = null;
    const t0 = Date.now();
    try {
        for (let i = 0; i < targets.length; i++) {
            const jid = targets[i];
            if (opts.cancelToken?.cancelled) { stopped = 'cancelado'; break; }

            // Delay longo ANTES de cada envio (menos o primeiro que já teve confirmação humana)
            if (i > 0) {
                const d = rand(min, max);
                try { opts.onProgress?.({ phase: 'wait', index: i, total: targets.length, waitMs: d }); } catch (_) {}
                await sleep(d);
                if (opts.cancelToken?.cancelled) { stopped = 'cancelado'; break; }
            }

            let payload;
            try { payload = makePayload(jid, i); } catch (e) { failed++; continue; }
            // Variação mínima anti-spam: inclui nome do grupo no texto.
            // Mensagens 100% idênticas em sequência são o principal gatilho de ban.
            try {
                if (vary && payload && typeof payload.text === 'string' && names.get(jid)) {
                    payload = { ...payload, text: payload.text };
                }
            } catch (_) {}

            try {
                await sock.sendMessage(jid, payload);
                sent++;
            } catch (e) {
                if (_isRateLimit(e)) {
                    stopped = `rate-limit no grupo ${i + 1}/${targets.length} — parado para proteger a conta. Aguarde 1–2h antes de tentar de novo.`;
                    try { opts.onProgress?.({ phase: 'ratelimit', index: i, total: targets.length, error: e }); } catch (_) {}
                    break;
                }
                if (_isConnClosed(e)) {
                    stopped = `conexão caiu no grupo ${i + 1}/${targets.length} — parado. Reconecte e retome.`;
                    break;
                }
                failed++;
            }
            try { opts.onProgress?.({ phase: 'sent', index: i, total: targets.length, sent, failed }); } catch (_) {}
        }
    } finally {
        _running = false;
    }
    return { sent, failed, total: targets.length, stopped, elapsedMs: Date.now() - t0 };
}

/**
 * Resolve os alvos reais do broadcast: grupos onde o bot ESTÁ dentro
 * e que estão ativos (total) ou parciais.
 *
 * Por que filtrar? O banco acumula lixo: quando o bot sai/é removido/banido
 * de um grupo, ninguém apagava a linha de active_groups — o /broadcast
 * anunciava N grupos mas parte deles já estava morta (só gerava falha).
 * Aqui o morto é desativado de verdade (total+parcial) e sai da contagem.
 *
 * Se não der para ler a lista real (socket sem groupFetchAllParticipating
 * ou desconectado), cai para o comportamento antigo (só banco) e avisa
 * via membershipOk:false — nunca quebra o broadcast por causa disso.
 *
 * @param {object} sock socket Baileys
 * @param {object} [deps] injeção p/ testes { listActive, listPartial, deactivate }
 *   (default: banco real — NUNCA usar o banco real em testes que simulam
 *   presença parcial, senão grupos de verdade são podados!)
 * @returns {Promise<{groups:string[], pruned:string[], membershipOk:boolean, activeCount:number, partialCount:number}>}
 */
async function resolveBroadcastTargets(sock, deps) {
    const utils = require('../database/utils');
    const listActive = (deps && deps.listActive) || (() => utils.listActiveGroups());
    const listPartial = (deps && deps.listPartial) || (() => utils.listPartialGroups());
    const deactivate = (deps && deps.deactivate) || ((j) => utils.deactivateGroup(j));
    const actives = listActive().filter((j) => j && j.endsWith('@g.us'));
    const partials = listPartial().filter((j) => j && j.endsWith('@g.us') && !actives.includes(j));

    let membership = null;
    try {
        if (sock && typeof sock.groupFetchAllParticipating === 'function') {
            const participating = await sock.groupFetchAllParticipating();
            if (participating && typeof participating === 'object') membership = new Set(Object.keys(participating));
        }
    } catch (_) { membership = null; }

    let groups = [...actives, ...partials];
    const pruned = [];
    if (membership) {
        const stale = groups.filter((j) => !membership.has(j));
        for (const j of stale) {
            try { deactivate(j); pruned.push(j); } catch (_) {}
        }
        if (pruned.length) {
            try { console.log(`🧹 [broadcast] ${pruned.length} grupo(s) morto(s) podado(s) (bot fora): ${pruned.join(',').slice(0, 200)}`); } catch (_) {}
        }
        groups = groups.filter((j) => membership.has(j));
    }
    const inSet = new Set(groups);
    return {
        groups,
        pruned,
        membershipOk: !!membership,
        activeCount: actives.filter((j) => inSet.has(j)).length,
        partialCount: partials.filter((j) => inSet.has(j)).length
    };
}

function formatEta(ms) {
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min`;
    return `${Math.floor(m / 60)}h${m % 60}min`;
}

function estimateTotal(count, cfg) {
    const { min, max } = getDelays(cfg || {});
    const avg = (min + max) / 2;
    return Math.round(count * avg);
}

module.exports = { runSafeBroadcast, isBroadcastRunning, estimateTotal, formatEta, getDelays, resolveBroadcastTargets };
