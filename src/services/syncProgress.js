/**
 * syncProgress — barra de progresso da sincronização pós-reconnect.
 *
 * Problema: após horas offline o WhatsApp despeja fila offline + app-state
 * de uma vez. O bot já descartava esse backlog (startTime + 5min replay em
 * events/message.js), mas de forma silenciosa e lenta — parecia "travado".
 *
 * Este módulo:
 *  - conta received/discarded/processed durante a janela de dreno
 *  - renderiza barra no terminal via stdout.write(\r) throttled (sem poluir
 *    o ring do terminalLog nem o arquivo de logs)
 *  - edita UMA mensagem no Telegram (sem flood) a cada 10% ou 5s
 *  - decide fast-discard: msg anterior ao drainStart => descarta sem
 *    groupMetadata/humanize/DB (só contador)
 */

const DRAIN_WINDOW_MS = Math.max(
    5000,
    Number(process.env.SYNC_DRAIN_MS) || 20000
);
const TERM_THROTTLE_MS = 500;
const TG_MIN_EDIT_MS = 5000;
const TG_MIN_PCT_DELTA = 10;

let _phase = 'idle'; // idle|connecting|draining|ready|failed
let _received = 0;
let _discarded = 0;
let _processed = 0; // msgs novas (não descartadas) vistas no dreno
let _drainStartAt = 0;
let _readyAt = 0;
let _failReason = null;
let _lastTermAt = 0;
let _lastTgAt = 0;
let _lastTgPct = -1;

function renderBar(pct, width = 20) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const w = Math.max(5, Math.min(40, width | 0 || 20));
    const filled = Math.round((p / 100) * w);
    return '█'.repeat(filled) + '░'.repeat(w - filled);
}

function _pct() {
    const total = _received || 1;
    const done = _discarded + _processed;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function _termBar() {
    const pct = _phase === 'ready' ? 100 : _pct();
    const bar = renderBar(pct);
    const total = _received;
    const done = _discarded + _processed;
    return `🔄 [SYNC] ${bar} ${pct}% (${done}/${total} • desc ${ _discarded} novos ${_processed}) fase=${_phase}`;
}

function _drawTerminal(force = false) {
    try {
        const now = Date.now();
        if (!force && now - _lastTermAt < TERM_THROTTLE_MS) return;
        _lastTermAt = now;
        // stdout.write com \r não passa pelo console.log => não polui ring/arquivo
        if (process.stdout && process.stdout.write) {
            const line = _termBar();
            const width = (process.stdout.columns || 100) - 1;
            process.stdout.write(`\r${line.slice(0, width)}${' '.repeat(Math.max(0, width - line.length))}`);
            if (_phase === 'ready' || _phase === 'failed') process.stdout.write('\n');
        }
    } catch (_) {}
}

function _pushTelegram(force = false) {
    try {
        const tg = require('./telegramAlerts');
        if (!tg.isConfigured || !tg.isConfigured()) return;
        const pct = _phase === 'ready' ? 100 : _pct();
        const now = Date.now();
        const pctDelta = Math.abs(pct - _lastTgPct);
        if (!force && (now - _lastTgAt < TG_MIN_EDIT_MS) && pctDelta < TG_MIN_PCT_DELTA) return;
        // Só edita após o start ter criado a msg; throttle real fica no telegramAlerts
        if (_phase === 'connecting' || _phase === 'draining') {
            _lastTgAt = now;
            _lastTgPct = pct;
            tg.notifySyncProgress({
                pct,
                received: _received,
                discarded: _discarded,
                processed: _processed,
                phase: _phase
            }).catch(() => {});
        }
    } catch (_) {}
}

function _syncStateToPrincipal() {
    try {
        const ps = require('./principalState');
        if (ps && typeof ps.setSyncing === 'function') {
            if (_phase === 'draining' || _phase === 'connecting') {
                ps.setSyncing(_phase === 'ready' ? 100 : _pct(), _phase);
            }
        }
    } catch (_) {}
}

function start(stage = 'connecting') {
    _phase = stage === 'draining' ? 'draining' : 'connecting';
    _received = 0;
    _discarded = 0;
    _processed = 0;
    _failReason = null;
    _readyAt = 0;
    _lastTgPct = -1;
    _lastTgAt = 0;
    if (_phase === 'connecting') _drainStartAt = 0;
    _drawTerminal(true);
    _syncStateToPrincipal();
    try {
        const tg = require('./telegramAlerts');
        if (tg.isConfigured && tg.isConfigured() && tg.notifySyncStart) {
            tg.notifySyncStart({ phase: _phase }).catch(() => {});
        }
    } catch (_) {}
}

function startDraining() {
    _phase = 'draining';
    _drainStartAt = Date.now();
    _received = 0;
    _discarded = 0;
    _processed = 0;
    _lastTgPct = -1;
    _lastTgAt = 0;
    _drawTerminal(true);
    _pushTelegram(true);
    _syncStateToPrincipal();
}

/** Chamado no início de cada messages.upsert — conta o lote. */
function onBatch(count) {
    if (_phase !== 'draining' && _phase !== 'connecting') return;
    if (_phase === 'connecting') return; // ainda sem open: ignora contagem
    _received += Math.max(0, Number(count) || 0);
    _checkDrainTimeout();
    _drawTerminal(false);
    _pushTelegram(false);
    _syncStateToPrincipal();
}

/**
 * Fast-discard: true => msg é backlog anterior ao reconnect, pule tudo.
 * fromMe nunca é descartado aqui (deixa o fluxo normal decidir).
 */
function shouldFastDiscard(messageTimeSec, fromMe = false) {
    if (_phase !== 'draining') return false;
    if (fromMe) return false;
    if (!_drainStartAt) return false;
    const ts = Number(messageTimeSec) || 0;
    if (!ts) return false;
    const ms = ts > 1e12 ? ts : ts * 1000;
    // Compara em segundos (timestamp do WhatsApp tem precisão de 1s e o
    // drainStart tem ms): msg do mesmo segundo do open é NOVA, não backlog.
    try {
        return Math.floor(ms / 1000) < Math.floor(_drainStartAt / 1000);
    } catch (_) {
        return ms < _drainStartAt;
    }
}

function countDiscarded(n = 1) {
    if (_phase !== 'draining') return;
    _discarded += n;
    _checkDrainTimeout();
    _drawTerminal(false);
    _pushTelegram(false);
    _syncStateToPrincipal();
}

function countProcessed(n = 1) {
    if (_phase !== 'draining') return;
    _processed += n;
    _checkDrainTimeout();
    _drawTerminal(false);
    _pushTelegram(false);
    _syncStateToPrincipal();
}

function _checkDrainTimeout() {
    if (_phase !== 'draining' || !_drainStartAt) return;
    if (Date.now() - _drainStartAt >= DRAIN_WINDOW_MS) finish('timeout');
}

function finish(reason = 'dreno concluído') {
    if (_phase === 'ready' || _phase === 'idle') return getState();
    _phase = 'ready';
    _readyAt = Date.now();
    _drawTerminal(true);
    try {
        const tg = require('./telegramAlerts');
        if (tg.isConfigured && tg.isConfigured() && tg.notifySyncDone) {
            tg.notifySyncDone({
                received: _received,
                discarded: _discarded,
                processed: _processed,
                reason
            }).catch(() => {});
        }
    } catch (_) {}
    try {
        const ps = require('./principalState');
        if (ps && typeof ps.finishSync === 'function') ps.finishSync();
    } catch (_) {}
    return getState();
}

function fail(reason = 'falha') {
    _phase = 'failed';
    _failReason = String(reason || 'falha').slice(0, 200);
    try {
        if (process.stdout && process.stdout.write) process.stdout.write('\n');
    } catch (_) {}
    try {
        console.warn(`⚠️ [SYNC] falhou: ${_failReason} (rec ${_received} desc ${_discarded})`);
    } catch (_) {}
    try {
        const tg = require('./telegramAlerts');
        if (tg.isConfigured && tg.isConfigured() && tg.notifySyncDone) {
            tg.notifySyncDone({
                received: _received,
                discarded: _discarded,
                processed: _processed,
                reason: `falha: ${_failReason}`
            }).catch(() => {});
        }
    } catch (_) {}
    try {
        const ps = require('./principalState');
        if (ps && typeof ps.finishSync === 'function') ps.finishSync();
    } catch (_) {}
    return getState();
}

function isDraining() {
    _checkDrainTimeout();
    return _phase === 'draining';
}

function getDrainStart() {
    return _drainStartAt;
}

function getState() {
    return {
        phase: _phase,
        received: _received,
        discarded: _discarded,
        processed: _processed,
        pct: _phase === 'ready' ? 100 : _pct(),
        drainStartAt: _drainStartAt,
        drainWindowMs: DRAIN_WINDOW_MS,
        readyAt: _readyAt,
        failReason: _failReason
    };
}

// Para testes: reseta sem efeitos colaterais de rede
function _reset() {
    _phase = 'idle';
    _received = 0;
    _discarded = 0;
    _processed = 0;
    _drainStartAt = 0;
    _readyAt = 0;
    _failReason = null;
    _lastTermAt = 0;
    _lastTgAt = 0;
    _lastTgPct = -1;
}

module.exports = {
    renderBar,
    start,
    startDraining,
    onBatch,
    shouldFastDiscard,
    countDiscarded,
    countProcessed,
    finish,
    fail,
    isDraining,
    getDrainStart,
    getState,
    _reset,
    DRAIN_WINDOW_MS
};
