// Lembrete semanal de limpeza no Telegram (texto, sem botões).
// 1x/semana: conta grupos mortos (no banco, fora do WhatsApp) e, se houver,
// sugere /limparmortos. Silencioso quando não há nada (só log local).
// Estado em config.lastPurgeNagAt (sobrevive a restart, sincroniza).
// Kill-switch: TELEGRAM_PURGE_NAG_ENABLED=0.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 60 * 60 * 1000; // 1h pós-boot (dá tempo do Baileys conectar)

function isNagEnabled() {
    return process.env.TELEGRAM_PURGE_NAG_ENABLED !== '0';
}

function _getLastNagAt() {
    try {
        const { readConfig } = require('../database/utils');
        return Number(readConfig().lastPurgeNagAt) || 0;
    } catch (_) { return 0; }
}

function _setLastNagAt(ts) {
    try {
        const { readConfig, writeConfig } = require('../database/utils');
        const cfg = readConfig();
        cfg.lastPurgeNagAt = Number(ts) || Date.now();
        writeConfig(cfg);
    } catch (_) {}
}

async function findDeadGroups() {
    const utils = require('../database/utils');
    const sock = global.__baileysSock;
    const candidates = [...new Set([
        ...utils.listActiveGroups(),
        ...utils.listPartialGroups(),
        ...utils.listNewsGroups()
    ].filter((j) => j && String(j).endsWith('@g.us')))];
    if (!candidates.length) return { candidates, dead: [], membershipOk: true };
    let participating = null;
    try {
        if (sock && typeof sock.groupFetchAllParticipating === 'function') {
            const p = await sock.groupFetchAllParticipating();
            if (p && typeof p === 'object') participating = new Set(Object.keys(p));
        }
    } catch (_) { participating = null; }
    if (!participating) return { candidates, dead: [], membershipOk: false };
    return { candidates, dead: candidates.filter((j) => !participating.has(j)), membershipOk: true };
}

async function checkWeeklyNag({ reason = 'schedule' } = {}) {
    try {
        const last = _getLastNagAt();
        if (Date.now() - last < WEEK_MS) return { ok: false, reason: 'too-early' };
        const { dead, membershipOk, candidates } = await findDeadGroups();
        if (!membershipOk) return { ok: false, reason: 'no-membership' };
        _setLastNagAt(Date.now());
        if (!dead.length) {
            try { console.log(`🧹 [purgeNag] semanal ok (${candidates.length} grupos, nenhum morto) — silencioso`); } catch (_) {}
            return { ok: true, dead: 0, reason };
        }
        const tg = require('./telegramBot');
        const txt =
            `*🧹 Limpeza semanal recomendada*\n` +
            `───────────────\n` +
            `Encontrei *${dead.length} grupo(s)* que o bot não participa mais (saiu/removido), mas com dados no banco:\n\n` +
            dead.slice(0, 20).map((j) => `• \`${String(j).split('@')[0]}\``).join('\n') +
            (dead.length > 20 ? `\n…(+${dead.length - 20})` : '') +
            `\n───────────────\n` +
            `Use \`/limparmortos\` para ver e \`/limparmortos confirmar\` para purgar.`;
        const r = await tg.send(null, txt);
        try { console.log(`🧹 [purgeNag] lembrete enviado (${dead.length} mortos, motivo=${reason})`); } catch (_) {}
        return { ok: !!r.ok, dead: dead.length, reason };
    } catch (e) {
        try { console.error('❌ [purgeNag] erro:', e?.message || e); } catch (_) {}
        return { ok: false, error: e?.message || String(e) };
    }
}

let _started = false;

function startWeeklyPurgeNag() {
    if (_started) return { ok: false, reason: 'already-started' };
    if (!isNagEnabled()) {
        console.log('🧹 [purgeNag] desativado (TELEGRAM_PURGE_NAG_ENABLED=0)');
        return { ok: false, reason: 'disabled' };
    }
    const run = async () => {
        try { await checkWeeklyNag({ reason: 'schedule' }); } catch (_) {}
    };
    const t0 = setTimeout(() => {
        run();
        const t1 = setInterval(run, CHECK_MS);
        try { if (t1.unref) t1.unref(); } catch (_) {}
    }, FIRST_DELAY_MS);
    try { if (t0.unref) t0.unref(); } catch (_) {}
    _started = true;
    console.log('🧹 [purgeNag] ativo — checagem 1x/semana (primeira em ~1h)');
    return { ok: true };
}

module.exports = { startWeeklyPurgeNag, checkWeeklyNag, findDeadGroups, isNagEnabled, WEEK_MS };
