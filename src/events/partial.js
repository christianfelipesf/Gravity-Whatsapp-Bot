// partial.js — lógica do modo parcial (!ativarp) sem dependências.
// Extraído de events/message.js para ser testável com `node --test`
// (message.js puxava o dashboard antigo, que criava setInterval sem unref
// e travaria o runner de testes — painel arquivado, stub não cria timers).

const partialPending = new Map();
const PARTIAL_PENDING_MAX = 200;
// Em parcial: mídia + interação (gifs) + tts (voz é mídia). 'utilidades' NÃO é
// liberada por categoria — só via allowlist abaixo (senão !divulgar/!setlink
// passariam). Decisão do dono: moderação off + bloqueio silencioso em parcial.
const PARTIAL_ALLOWED_CATEGORIES = new Set(['mídia', 'midia', 'interação', 'interacao']);
const PARTIAL_ALLOWED_COMMANDS = new Set(['tts', 'falar', 'voz', 'fala', 'speak']);
const PARTIAL_BLOCKED_COMMANDS = new Set([
    'ban', 'add', 'mute', 'mutar', 'desmute', 'desmutar', 'antilink', 'limpar', 'clear', 'purge', 'delete', 'apagar', 'del', 'clearchat',
    'd', 'deletemsg', 'deletarmsg', 'apagarmsg', 'delmsg', 'deletar', 'apagarmensagem',
    'divulgar', 'mencionar', 'set', 'setprefix', 'multiprefixo', 'multiprefix', 'prefixos', 'addguardiao', 'addguardian', 'remguardiao', 'remguardian', 'delguardiao', 'listguardioes', 'listguardians', 'guardioes', 'listaguardioes', 'guardians', 'menuguardiao', 'menuguardian', 'menu-guardiao', 'menuguardioes', 'guardiaomenu', 'redegravity', 'redegravidade', 'redegrav', 'rede-gravity', 'gruposgravity', 'statusgrupos', 'statusgroups', 'gruposstatus', 'metricasgrupos', 'statusgps', 'painelgrupos', 'temaglobal', 'globaltema', 'temaglob', 'setlink', 'dashreset', 'newsreset',
    'dashboardativar', 'dashboarddesativar', 'newsativar', 'newsdesativar', 'dump', 'config', 'nome', 'tema', 'theme',
    'log', 'logs', 'logsterminal', 'terminallog',
    'menu', 'help', 'comandos', 'prefixo', 'prefix', 'resumir', 'grupos', 'perfil', 'ai',
    'cadastrar-pessoa', 'cadastrar', 'addpessoa', 'editar-pessoa', 'editar', 'deletar-pessoa', 'delficha',
    'ficha', 'pessoa', 'listar-pessoas', 'fichas', 'aniversariantes', 'niver', 'radar-cidades', 'radar',
    'aleatorio', 'sortear', 'contato', 'pix',
    'postarmeme', 'novomeme', 'memenovo', 'delmeme', 'deletememe', 'apagarmeme'
]);
// Bypass passa mesmo em parcial (controle + status). 'status' NÃO está no
// BLOCKED de propósito — bypass vence e evita armadilha de manutenção.
const PARTIAL_BYPASS_COMMANDS = new Set(['ativar', 'desativar', 'ativarp', 'desativarp', 'status', 'statusp', 'dashboard', 'dash', 'painel']);

function _partialKey(jid, msgId) { return `${jid}:${msgId}`; }

function _normPartialUser(jid) {
    if (!jid) return '';
    try { return String(jid).split('@')[0].split(':')[0]; } catch (_) { return ''; }
}

function _isPartialAllowed(cmd) {
    if (!cmd) return false;
    if (PARTIAL_BLOCKED_COMMANDS.has(cmd.name)) return false;
    if (Array.isArray(cmd.aliases)) for (const a of cmd.aliases) if (PARTIAL_BLOCKED_COMMANDS.has(a)) return false;
    if (PARTIAL_ALLOWED_COMMANDS.has(cmd.name)) return true;
    if (Array.isArray(cmd.aliases)) for (const a of cmd.aliases) if (PARTIAL_ALLOWED_COMMANDS.has(a)) return true;
    return PARTIAL_ALLOWED_CATEGORIES.has(cmd.category);
}

function registerPartialPending(jid, msgId, commandName, botJid) {
    if (!jid || !msgId) return null;
    const k = _partialKey(jid, msgId);
    if (partialPending.has(k)) return null;
    if (partialPending.size >= PARTIAL_PENDING_MAX) {
        const oldest = partialPending.keys().next().value;
        try {
            const e = partialPending.get(oldest);
            if (e && e.timer) clearTimeout(e.timer);
            if (e && e.resolve) e.resolve({ reacted: false });
        } catch (_) {}
        partialPending.delete(oldest);
    }
    let resolveFn;
    const promise = new Promise(resolve => { resolveFn = resolve; });
    partialPending.set(k, { resolve: resolveFn, botJid, commandName, jid, isGroup: jid?.endsWith('@g.us'), createdAt: Date.now() });
    return promise;
}

function cancelPartialPending(jid, msgId) {
    const k = _partialKey(jid, msgId);
    const entry = partialPending.get(k);
    if (entry && entry.timer) clearTimeout(entry.timer);
    partialPending.delete(k);
    if (entry && entry.resolve) entry.resolve({ reacted: true });
}

function notifyPartialReaction(jid, msgId, reactorJid, isFromMe) {
    const k = _partialKey(jid, msgId);
    const entry = partialPending.get(k);
    if (!entry) return false;
    try {
        // Reação do próprio bot (fromMe ou JID igual) nunca cancela.
        if (isFromMe) return false;
        const reactorNorm = _normPartialUser(reactorJid);
        const botNorm = _normPartialUser(entry.botJid);
        if (reactorNorm && botNorm && reactorNorm === botNorm) return false;
    } catch (_) {}
    cancelPartialPending(jid, msgId);
    return true;
}

function setPartialTimer(jid, msgId, ms) {
    const k = _partialKey(jid, msgId);
    const entry = partialPending.get(k);
    if (!entry) return;
    entry.timer = setTimeout(() => {
        const cur = partialPending.get(k);
        if (!cur) return;
        partialPending.delete(k);
        try { cur.resolve({ reacted: false }); } catch (_) {}
    }, Math.max(0, ms || 0));
}

function cancelPartialPendingForGroup(jid) {
    if (!jid) return 0;
    let n = 0;
    for (const [k, entry] of partialPending.entries()) {
        if (entry && entry.jid === jid) {
            try { if (entry.timer) clearTimeout(entry.timer); } catch (_) {}
            partialPending.delete(k);
            try { entry.resolve && entry.resolve({ reacted: false, cancelled: true }); } catch (_) {}
            n++;
        }
    }
    return n;
}

setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, entry] of partialPending.entries()) {
        if (entry.createdAt && entry.createdAt < cutoff) {
            try { if (entry.timer) clearTimeout(entry.timer); } catch (_) {}
            partialPending.delete(k);
            try { entry.resolve && entry.resolve({ reacted: false }); } catch (_) {}
        }
    }
}, 60 * 1000).unref();

module.exports = {
    partialPending,
    PARTIAL_PENDING_MAX,
    PARTIAL_ALLOWED_CATEGORIES,
    PARTIAL_ALLOWED_COMMANDS,
    PARTIAL_BLOCKED_COMMANDS,
    PARTIAL_BYPASS_COMMANDS,
    isPartialAllowed: _isPartialAllowed,
    registerPartialPending,
    cancelPartialPending,
    notifyPartialReaction,
    setPartialTimer,
    cancelPartialPendingForGroup
};
