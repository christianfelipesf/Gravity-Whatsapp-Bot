const fs = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
}

const RING_MAX = 100;
const ring = [];

const { isLibsignalNoise: _isLibsignalNoise, pad, tsLabel, fileLabel } = require('./logFilter');

// Diagnóstico de sessão: mesmo que isLibsignalNoise filtre console, terminalLog deve guardar esses sinais
const _SESSION_DIAG_RE = /(closing session|decrypted message with closed session|bad mac|session error)/i;
function _isSessionDiag(text) {
    try { return _SESSION_DIAG_RE.test(String(text||'')); } catch(_) { return false; }
}

// Janela de agregação p/ diag de sessão (evita 1,6M linhas/dia no arquivo)
let _sessDiagWinStart = 0;
let _sessDiagCount = 0;
let _sessDiagSample = '';

function getSessionLogFile(d) {
    // Nome do arquivo em data SP (antes era UTC e confundia "quebrou às 21h").
    try {
        const t = new Date(d.getTime() - 3 * 3600 * 1000);
        return path.join(logsDir, `terminal_${t.toISOString().slice(0, 10)}.log`);
    } catch (_) {
        return path.join(logsDir, `terminal_${fileLabel(d)}.log`);
    }
}

function serialize(args) {
    try {
        return args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ');
    } catch (_) {
        return String(args);
    }
}

// Buffer de logs para evitar fs.appendFileSync por chamada
const _logBuffer = [];
const _LOG_FLUSH_INTERVAL = 3000;

function _flushLogBuffer() {
    if (!_logBuffer.length) return;
    const lines = _logBuffer.splice(0);
    try {
        const now = new Date();
        fs.appendFileSync(getSessionLogFile(now), lines.join(''));
    } catch (_) {}
}

let _logFlushTimer = null;
function _scheduleLogFlush() {
    if (_logFlushTimer) return;
    _logFlushTimer = setTimeout(() => {
        _logFlushTimer = null;
        _flushLogBuffer();
    }, _LOG_FLUSH_INTERVAL);
}

function push(level, args) {
    const text = serialize(args);
    if (!text) return;
    if (_isLibsignalNoise(text) && !_isSessionDiag(text)) return;
    // Session diag (ex: "Over 2000 messages into the future") chega aos milhões/dia
    // e afoga o bug real. Troca por 1 linha/min com contador.
    if (_isSessionDiag(text)) {
        const nowMs = Date.now();
        if (nowMs - _sessDiagWinStart > 60000) {
            if (_sessDiagCount > 0) {
                const line = `[${tsLabel(new Date())}] [WARN] [session] ${_sessDiagCount} erros de sessão suprimidos em 60s (ex: ${_sessDiagSample})\n`;
                try { _logBuffer.push(line); if (_logBuffer.length >= 20) { _flushLogBuffer(); } else { _scheduleLogFlush(); } } catch (_) {}
            }
            _sessDiagWinStart = nowMs;
            _sessDiagCount = 0;
            _sessDiagSample = text.slice(0, 80).replace(/[\r\n]+/g, ' ');
        }
        _sessDiagCount++;
        if (_sessDiagCount === 1) _sessDiagSample = text.slice(0, 80).replace(/[\r\n]+/g, ' ');
        // Guarda no ring só o 1º da janela p/ dashboard não lotar
        if (_sessDiagCount > 1) return;
    }
    const now = new Date();
    const entry = {
        ts: now.getTime(),
        time: tsLabel(now),
        level,
        text
    };
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
    _logBuffer.push(`[${tsLabel(now)}] [${level.toUpperCase()}] ${text}\n`);
    if (_logBuffer.length >= 20) { _flushLogBuffer(); } else { _scheduleLogFlush(); }
}

function flushSync() {
    try { _flushLogBuffer(); } catch(_) {}
    // drain any remaining scheduled timer
    try { if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; _flushLogBuffer(); } } catch(_) {}
}

// Flush no exit / SIGTERM / SIGINT — garante que close reason não se perca
process.on('beforeExit', flushSync);
try { process.on('exit', flushSync); } catch(_) {}
try { process.on('SIGTERM', () => { flushSync(); }); } catch(_) {}
try { process.on('SIGINT', () => { flushSync(); }); } catch(_) {}

function getLast(n = 15) {
    const limit = Math.max(1, Math.min(RING_MAX, Number(n) || 15));
    return ring.slice(-limit);
}

function getBufferSize() { return ring.length; }
function getRingMax() { return RING_MAX; }
function getLogsDir() { return logsDir; }

let initialized = false;
function init() {
    if (initialized) return;
    initialized = true;

    // Pré-carrega últimos logs do arquivo no ring, pra dashboard ver histórico pós-restart
    try {
        const logFile = getSessionLogFile(new Date());
        if (fs.existsSync(logFile)) {
            const content = fs.readFileSync(logFile, 'utf8');
            const lines = content.split('\n').filter(Boolean).slice(-RING_MAX);
            for (const line of lines) {
                const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] \[(\w+)\] (.+)$/);
                if (m) ring.push({ ts: Date.now(), time: m[1], level: m[2].toLowerCase(), text: m[3] });
            }
        }
    } catch (_) {}

    const wrap = (level, orig) => function (...args) {
        try { push(level, args); } catch (_) {}
        return orig.apply(console, args);
    };

    const origLog = console.log.bind(console);
    const origInfo = (console.info || console.log).bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = wrap('log', origLog);
    console.info = wrap('info', origInfo);
    console.warn = wrap('warn', origWarn);
    console.error = wrap('error', origError);

    console.log('🚀 [SISTEMA] Bot iniciado — painel online');

    // Higiene deferida (não bloqueia boot): prune 7d + gzip terminal de ontem.
    try {
        setTimeout(() => {
            try { require('./agentLog').pruneOldLogs({ maxDays: 7 }); } catch (_) {}
            try { require('./agentLog').gzipYesterdayTerminal(); } catch (_) {}
        }, 30000).unref?.();
    } catch (_) {}
}

module.exports = {
    init,
    getLast,
    getBufferSize,
    getRingMax,
    getLogsDir,
    flushSync,
    _flushLogBuffer
};
