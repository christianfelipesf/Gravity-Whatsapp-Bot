// ownerAgent.js — modo investigar do !aidono (agentic loop com tools).
// O modelo decide o que buscar em até MAX_ROUNDS rodadas; o executor roda
// tudo local (SQLite, R$0 por busca). Só leitura — nenhuma tool altera nada.

const { warningsOf, clean, safePersonLabel, jidFromDigits, extractTimeRange, mergeMsgLists } = require('./ownerEvidence');

const MAX_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 3;
const TOOL_RESULT_BUDGET = 900;

const OWNER_AGENT_SYSTEM = [
    'Você é o investigador privado do dono do bot de WhatsApp.',
    'Você tem ferramentas de consulta (somente leitura) sobre mensagens, advertências, atividade e logs.',
    'Método: faça UMA busca por vez nas primeiras rodadas, analise o resultado e decida o próximo passo.',
    'Quando tiver evidência suficiente, responda direto e objetivo, citando os dados (nomes, números, datas).',
    'Se não houver dados, diga que não há dados — nunca invente.',
    'Identificadores técnicos (jids, sequências numéricas longas) são internos: nunca os repita; use só nomes ou "a pessoa"/"pessoa A, B".',
    'Você só investiga e responde, nunca executa ações.'
].join(' ');

const OWNER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'buscar_mensagens_pessoa',
            description: 'Mensagens de uma pessoa (nome, telefone ou jid). Sem período = últimas; com período ("há 3 dias", "ontem", "última semana") = só da janela.',
            parameters: {
                type: 'object',
                properties: {
                    pessoa: { type: 'string', description: 'Nome, telefone ou jid da pessoa' },
                    limite: { type: 'integer', description: 'Quantas mensagens (1-20, padrão 12)' },
                    periodo: { type: 'string', description: 'Janela de tempo: "há 3 dias", "ontem", "últimos 5 dias", "dia 20/09" (opcional)' }
                },
                required: ['pessoa']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_mensagens_grupo',
            description: 'Mensagens de um grupo (nome ou jid). Use "atual" para o grupo onde a pergunta foi feita. Sem período = últimas; com período = só da janela.',
            parameters: {
                type: 'object',
                properties: {
                    grupo: { type: 'string', description: 'Nome do grupo, jid ou "atual"' },
                    limite: { type: 'integer', description: 'Quantas mensagens (1-20, padrão 15)' },
                    periodo: { type: 'string', description: 'Janela de tempo: "ontem", "há 3 dias", "última semana" (opcional)' }
                },
                required: ['grupo']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ver_advs',
            description: 'Advertências de uma pessoa (nome, telefone ou jid), opcionalmente num grupo específico.',
            parameters: {
                type: 'object',
                properties: {
                    pessoa: { type: 'string', description: 'Nome, telefone ou jid' },
                    grupo: { type: 'string', description: 'Nome do grupo (opcional)' }
                },
                required: ['pessoa']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ver_top_grupo',
            description: 'Quem mais fala num grupo (nome ou "atual").',
            parameters: {
                type: 'object',
                properties: { grupo: { type: 'string', description: 'Nome do grupo ou "atual"' } },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ver_logs',
            description: 'Logs recentes do próprio bot: erros ou comandos executados.',
            parameters: {
                type: 'object',
                properties: {
                    tipo: { type: 'string', enum: ['erros', 'comandos'], description: 'erros ou comandos' }
                },
                required: ['tipo']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'listar_grupos',
            description: 'Lista os grupos com bot ativo (nome e identificadores).',
            parameters: { type: 'object', properties: {} }
        }
    }
];

function clampLim(v, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(1, Math.min(20, Math.round(n)));
}

function fmtWhen(ts) {
    try {
        return new Date(Number(ts)).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    } catch (_) { return ''; }
}

// Resolve "Carlos" / "55119..." / jid -> { jid, alias, label }.
async function findPerson(sock, ident, ctx) {
    const { utils, from } = ctx;
    const raw = String(ident || '').trim();
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (/^\d{8,}$/.test(digits) && !/[a-zA-Z]/.test(raw)) {
        const jid = jidFromDigits(digits);
        if (!jid) return null;
        // Alias nos dois sentidos (histórico pode estar sob a outra identidade).
        let alias = null;
        try {
            const groupCtx = from && String(from).endsWith('@g.us') ? from : null;
            if (groupCtx && String(jid).endsWith('@s.whatsapp.net')) {
                alias = await utils?.resolvePhoneLidInGroup?.(sock, digits, groupCtx) || null;
                if (alias && typeof alias !== 'string') alias = null;
            } else if (groupCtx && String(jid).endsWith('@lid')) {
                const ph = await utils?.resolveLidPhoneInGroup?.(sock, digits, groupCtx) || null;
                const dd = String(ph || '').replace(/\D/g, '');
                if (/^\d{8,15}$/.test(dd)) alias = `${dd}@s.whatsapp.net`;
            }
        } catch (_) {}
        return { jid, alias, label: digits.length >= 14 ? `LID ${digits.slice(-6)}` : `@${digits}` };
    }
    if (/@(lid|s\.whatsapp\.net|g\.us)$/i.test(raw)) {
        return { jid: raw, alias: null, label: raw };
    }
    try {
        const hits = utils?.findPeopleByName?.(raw, 5) || [];
        if (hits.length === 0) return null;
        const h = hits[0];
        let alias = null;
        try {
            const groupCtx = from && String(from).endsWith('@g.us') ? from : null;
            if (String(h.senderJid).endsWith('@lid') && groupCtx) {
                alias = await utils?.resolveLidPhoneInGroup?.(sock, String(h.senderJid).split('@')[0], groupCtx) || null;
                if (alias && typeof alias !== 'string') {
                    const p = String(alias.pn || alias.phone || '').replace(/\D/g, '');
                    alias = /^\d{8,15}$/.test(p) ? `${p}@s.whatsapp.net` : null;
                }
            }
        } catch (_) {}
        return { jid: h.senderJid, alias, label: h.name || h.senderJid, alternatives: hits.slice(1, 3) };
    } catch (_) { return null; }
}

// Resolve nome de grupo -> { jid, subject }. "atual" = grupo do comando.
async function findGroup(sock, ident, ctx) {
    const { utils, from } = ctx;
    const raw = String(ident || '').trim().toLowerCase();
    if (!raw) return null;
    if (['atual', 'aqui', 'este', 'esse', 'grupo atual'].includes(raw)) {
        if (from && String(from).endsWith('@g.us')) {
            let subject = 'Grupo atual';
            try {
                const gm = await utils?.groupMetadataCached?.(sock, from).catch(() => null);
                if (gm?.subject) subject = gm.subject;
            } catch (_) {}
            return { jid: from, subject };
        }
        return null;
    }
    if (raw.endsWith('@g.us')) return { jid: ident, subject: ident };
    try {
        const infos = utils?.listDashboardGroupInfos?.() || [];
        const hit = infos.find((g) => String(g.subject || '').toLowerCase().includes(raw))
            || infos.find((g) => raw.includes(String(g.subject || '').toLowerCase()));
        if (hit) return { jid: hit.jid, subject: hit.subject || hit.jid };
    } catch (_) {}
    return null;
}

function msgLines(msgs, maxChars) {
    const out = [];
    for (const ml of msgs) {
        const txt = clean(ml.text, maxChars);
        if (!txt) continue;
        const who = ml.name ? ` ${clean(ml.name, 25)}:` : '';
        out.push(`[${fmtWhen(ml.timestamp)}]${who} ${txt}`);
    }
    return out;
}

async function executeTool(name, args, ctx) {
    const { sock, from, utils } = ctx;
    const a = args && typeof args === 'object' ? args : {};
    try {
        switch (name) {
            case 'buscar_mensagens_pessoa': {
                const p = await findPerson(sock, a.pessoa, ctx);
                if (!p) return `Pessoa "${clean(a.pessoa, 40)}" não encontrada no histórico. Tente o número com DDD.`;
                const personName = safePersonLabel(p.label, 'pessoa mencionada');
                let out = `Pessoa: ${personName}`;
                if (p.alternatives?.length) out += ` (também achei: ${p.alternatives.map((x, i) => safePersonLabel(x.name || x.senderJid, `pessoa ${String.fromCharCode(66 + (i % 25))}`)).join(', ')})`;
                const tr = a.periodo ? extractTimeRange(String(a.periodo)) : null;
                const winTag = tr ? ` ${tr.label}` : ' no histórico todo';
                const lim = clampLim(a.limite, 12);
                // Sem período: busca pool largo (100) p/ amostrar o período
                // todo — senão "resume a pessoa" vira só as últimas falas.
                const fetchLim = tr ? 20 : 100;
                let msgs = (tr && utils?.getMessagesBySenderRange)
                    ? (utils.getMessagesBySenderRange(p.jid, p.alias, tr.since, tr.until, 20) || [])
                    : (utils?.getMessagesBySender?.(p.jid, p.alias, fetchLim) || []);
                let approx = false;
                let where = '';
                // Fallback por nome SEMPRE (funde com dedupe): cobre grupos que
                // a busca exata não viu.
                {
                    const pname = p.label.includes('@') ? (utils?.getSenderName?.(p.jid) || null) : p.label;
                    if (pname && !pname.includes('@')) {
                        let scopes = [];
                        try {
                            scopes = (utils?.listDashboardGroupInfos?.() || []).map((g) => g.jid).filter(Boolean).slice(0, 30);
                        } catch (_) {}
                        if (from && String(from).endsWith('@g.us') && !scopes.includes(from)) scopes.unshift(from);
                        if (!scopes.length) scopes = [null];
                        const collected = [];
                        const likeFn = utils?.findMessagesByNameLike || utils?.getMessagesByPushName;
                        const rangeFn = tr && utils?.getMessagesByPushNameRange ? utils.getMessagesByPushNameRange.bind(utils) : null;
                        for (const gj of [...scopes, null]) {
                            if (rangeFn) {
                                const extra = rangeFn(gj, pname, tr.since, tr.until, 20) || [];
                                for (const r of extra) collected.push({ gj: r.jid || gj, r });
                                if (collected.length >= 40) break;
                            } else {
                                const extra = likeFn?.call(utils, gj, pname, tr ? lim : 100) || [];
                                for (const r of extra) collected.push({ gj: r.jid || gj, r });
                                if (collected.length >= (tr ? 24 : 200)) break;
                            }
                        }
                        let pool = collected;
                        if (tr && !rangeFn) pool = collected.filter((c) => (c.r.time || 0) >= tr.since && (c.r.time || 0) <= tr.until);
                        if (pool.length) {
                            pool.sort((x, y) => (x.r.time || 0) - (y.r.time || 0));
                            const distinct = [...new Set(pool.map((c) => c.gj || ''))].filter(Boolean);
                            const directGroups = [...new Set(msgs.map((x) => x.toJid).filter(Boolean))];
                            const allGroups = [...new Set([...distinct, ...directGroups])];
                            if (allGroups.length > 1) where = ` em ${allGroups.length} grupos`;
                            const fbRows = pool.map(({ r }) => ({ text: r.text, name: r.push_name, timestamp: r.time, fb: true }));
                            const merged = mergeMsgLists(msgs.map((x) => ({ ...x, fb: false })), fbRows);
                            if (merged.some((x) => x.fb)) approx = true;
                            if (!tr && merged.length > lim) {
                                // amostra distribuída antigas→recentes (não só últimas)
                                const step = merged.length / lim;
                                const sampled = [];
                                for (let i = 0; i < lim - 1; i++) sampled.push(merged[Math.floor(i * step)]);
                                sampled.push(merged[merged.length - 1]);
                                sampled.sort((x, y) => (Number(x.timestamp) || 0) - (Number(y.timestamp) || 0));
                                msgs = sampled;
                                where += ` (amostra ${lim} de ${merged.length})`;
                            } else {
                                msgs = merged.slice(-lim);
                            }
                        }
                    }
                }
                if (!msgs.length) return `${out}\nSem mensagens${winTag} no histórico.`;
                if (!tr && msgs.length > lim) {
                    const total = msgs.length;
                    const step = total / lim;
                    const sampled = [];
                    for (let i = 0; i < lim - 1; i++) sampled.push(msgs[Math.floor(i * step)]);
                    sampled.push(msgs[total - 1]);
                    sampled.sort((x, y) => (Number(x.timestamp) || 0) - (Number(y.timestamp) || 0));
                    msgs = sampled;
                    if (!/amostra/.test(where)) where += ` (amostra ${lim} de ${total})`;
                }
                return `${out} — ${msgs.length} msgs${winTag}${where}${approx ? ' (aproximado por nome)' : ''}:\n` + msgLines(msgs, 150).join('\n');
            }
            case 'buscar_mensagens_grupo': {
                const g = await findGroup(sock, a.grupo, ctx);
                if (!g) return `Grupo "${clean(a.grupo, 40)}" não encontrado. Use listar_grupos para ver os nomes.`;
                const gtr = a.periodo ? extractTimeRange(String(a.periodo)) : null;
                const gWin = gtr ? ` ${gtr.label}` : '';
                const glim = clampLim(a.limite, 15);
                let msgs = (gtr && utils?.getMessagesByGroupRange)
                    ? (utils.getMessagesByGroupRange(g.jid, gtr.since, gtr.until, 20) || [])
                    : (utils?.getMessagesByGroup?.(g.jid, glim) || []);
                // Fallback fundido com dedupe (mesmo motivo da pessoa).
                try {
                    let extra = [];
                    if (gtr && utils?.getGroupMessagesRange) {
                        extra = utils.getGroupMessagesRange(g.jid, gtr.since, gtr.until, 20) || [];
                    } else {
                        const all = utils?.getGroupMessages?.(g.jid, glim) || [];
                        extra = gtr ? all.filter((r) => (r.time || 0) >= gtr.since && (r.time || 0) <= gtr.until) : all;
                    }
                    if (extra.length) {
                        const fbRows = extra.map((r) => ({ text: r.text, name: r.push_name, senderJid: null, timestamp: r.time, fb: true }));
                        msgs = mergeMsgLists(msgs.map((x) => ({ ...x, fb: false })), fbRows).slice(-glim);
                    } else {
                        msgs = msgs.slice(-glim);
                    }
                } catch (_) {}
                let approx = msgs.some((x) => x.fb);
                if (!msgs.length) return `Grupo ${clean(g.subject, 40)}: sem mensagens${gWin} no histórico.`;
                return `Grupo ${clean(g.subject, 40)} — ${msgs.length} msgs${gWin}${approx ? ' (autores por nome)' : ''}:\n` + msgLines(msgs, 130).join('\n');
            }
            case 'ver_advs': {
                const p = await findPerson(sock, a.pessoa, ctx);
                if (!p) return `Pessoa "${clean(a.pessoa, 40)}" não encontrada.`;
                let groupJids = [];
                if (a.grupo) {
                    const g = await findGroup(sock, a.grupo, ctx);
                    if (g) groupJids = [g.jid];
                } else if (from && String(from).endsWith('@g.us')) {
                    groupJids = [from];
                } else {
                    try {
                        groupJids = (utils?.listDashboardGroupInfos?.() || []).map((g) => g.jid).filter(Boolean).slice(0, 30);
                    } catch (_) {}
                }
                const hits = [];
                for (const gj of groupJids) {
                    const c = warningsOf(utils, gj, p.jid) || 0;
                    if (c > 0) {
                        let gname = gj;
                        try {
                            const gi = utils?.getDashboardGroupInfo?.(gj);
                            if (gi?.subject) gname = gi.subject;
                        } catch (_) {}
                        hits.push(`${c}/3 em ${clean(gname, 30)}`);
                    }
                }
                const who = safePersonLabel(p.label, 'pessoa mencionada');
                return hits.length
                    ? `${who}: ${hits.join('; ')}`
                    : `${who}: nenhuma advertência.`;
            }
            case 'ver_top_grupo': {
                const g = await findGroup(sock, a.grupo || 'atual', ctx);
                if (!g) return 'Grupo não identificado. Informe o nome ou use "atual" em um grupo.';
                let top = null;
                try { top = utils?.getTopMember?.(g.jid) || null; } catch (_) {}
                return top ? `Top de ${clean(g.subject, 40)}: ${clean(top, 40)}` : `Sem dados de atividade em ${clean(g.subject, 40)}.`;
            }
            case 'ver_logs': {
                const kind = String(a.tipo || '').toLowerCase().startsWith('comand') ? 'action' : 'error';
                const logs = utils?.getRecentLogs?.(kind, 10) || [];
                const list = kind === 'action'
                    ? logs.filter((l) => /comando executado/i.test(l.text || '')).slice(-10)
                    : logs;
                if (!list.length) return kind === 'action' ? 'Nenhum comando registrado.' : 'Nenhum erro registrado.';
                return (kind === 'action' ? 'Comandos recentes:\n' : 'Erros recentes:\n')
                    + list.map((l) => `[${fmtWhen(l.timestamp)}] ${clean(l.text, 140)}`).join('\n');
            }
            case 'listar_grupos': {
                let infos = [];
                try { infos = utils?.listDashboardGroupInfos?.() || []; } catch (_) {}
                if (!infos.length) return 'Nenhum grupo com bot ativo.';
                return `Grupos (${infos.length}):\n` + infos.slice(0, 30).map((g) => `• ${clean(g.subject || g.jid, 45)}`).join('\n');
            }
            default:
                return `Ferramenta desconhecida: ${name}`;
        }
    } catch (e) {
        return `Falha ao executar ${name}: ${String(e?.message || e).slice(0, 120)}`;
    }
}

function truncateResult(s) {
    const t = String(s || '');
    return t.length > TOOL_RESULT_BUDGET ? t.slice(0, TOOL_RESULT_BUDGET) + '\n[…truncado]' : t;
}

function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)) || {}; } catch (_) { return { __parseError: true }; }
}

async function runInvestigativeLoop({ model, sock, question, from, isGroup, requesterName, utils, signal, log }) {
    const nowStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    let groupHint = '';
    if (isGroup && from) {
        try {
            const gm = await utils?.groupMetadataCached?.(sock, from).catch(() => null);
            if (gm?.subject) groupHint = ` A pergunta foi feita no grupo "${gm.subject}". "Atual" refere-se a ele.`;
        } catch (_) {}
    }
    const messages = [
        { role: 'system', content: OWNER_AGENT_SYSTEM },
        { role: 'user', content: `Pergunta do dono (${clean(requesterName || 'dono', 30)}, ${nowStr} BRT).${groupHint}\n${String(question).slice(0, 600)}` }
    ];
    const ctx = { sock, from, utils };
    const findings = [];
    let rounds = 0;
    let tokensIn = 0, tokensOut = 0;

    for (let r = 0; r < MAX_ROUNDS; r++) {
        if (signal?.aborted) break;
        rounds++;
        let res;
        try {
            res = await model.chatWithTools(messages, OWNER_TOOLS, { signal });
        } catch (e) {
            if (e?.code === 'ABORTED' || signal?.aborted) break;
            throw e;
        }
        tokensIn += res?.tokensIn || 0;
        tokensOut += res?.tokensOut || 0;
        const calls = Array.isArray(res?.toolCalls) ? res.toolCalls.slice(0, MAX_CALLS_PER_ROUND) : [];
        if (calls.length === 0) {
            const answer = String(res?.text || '').trim();
            if (answer) return { answer, rounds, partial: false, usage: { rounds, tokensIn, tokensOut } };
            break;
        }
        messages.push({ role: 'assistant', content: String(res?.text || ''), tool_calls: calls });
        for (const tc of calls) {
            const args = parseArgs(tc?.function?.arguments);
            let out;
            if (args.__parseError) out = 'Argumentos inválidos da ferramenta. Tente de novo com JSON válido.';
            else out = await executeTool(tc?.function?.name, args, ctx);
            out = truncateResult(out);
            findings.push(`[${tc?.function?.name}] ${out}`);
            messages.push({ role: 'tool', tool_call_id: tc?.id, content: out });
        }
        try { log?.(`investigar r${rounds}`, `${calls.length} tools`); } catch (_) {}
    }

    // Sem resposta final: resume o apurado (parcial).
    const partialNote = findings.length > 0
        ? `Apurei até aqui (parcial):\n${findings.join('\n\n').slice(0, 1500)}`
        : 'Não consegui apurar dados (tempo esgotado ou sem evidências).';
    return { answer: partialNote, rounds, partial: true, usage: { rounds, tokensIn, tokensOut } };
}

module.exports = {
    OWNER_TOOLS, OWNER_AGENT_SYSTEM, MAX_ROUNDS, MAX_CALLS_PER_ROUND, TOOL_RESULT_BUDGET,
    findPerson, findGroup, executeTool, runInvestigativeLoop
};
