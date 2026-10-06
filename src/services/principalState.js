const EV = require('events');

const emitter = new EV();
let _connected = false;
let _version = null;
let _phone = null;
let _connectedAt = null;
let _sock = null;
let _qr = null;
// Sync pós-reconnect (barra de progresso): ativo entre connecting/open e
// fim do dreno do backlog. Não muda _connected — só o status exposto.
let _syncActive = false;
let _syncPct = 0;
let _syncEtapa = null;

function setQr(qr) { _qr = qr || null; }
function clearQr() { _qr = null; }

function setSock(sock) { _sock = sock || null; }
function getSock() { return _sock; }
function clearSock() { _sock = null; }

function setConnected(meta = {}) {
    const wasConnected = _connected;
    _connected = true;
    _version = meta.version || _version;
    _phone = meta.phone || _phone;
    _connectedAt = _connectedAt || new Date();
    _qr = null;
    // open() inicia o dreno do backlog: marca syncing em vez de
    // "connected" imediato — /status e watchdog veem o progresso.
    _syncActive = true;
    _syncPct = 0;
    _syncEtapa = 'draining';
    if (!wasConnected) emitter.emit('connected', getState());
    else emitter.emit('sync', getState());
}

function setSyncing(pct = 0, etapa = 'draining') {
    _syncActive = true;
    _syncPct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    _syncEtapa = String(etapa || 'draining').slice(0, 40);
    emitter.emit('sync', getState());
}

function finishSync() {
    _syncActive = false;
    _syncPct = 100;
    _syncEtapa = null;
    emitter.emit('sync', getState());
}

function setDisconnected() {
    _connected = false;
    _syncActive = false;
    _syncPct = 0;
    _syncEtapa = null;
    emitter.emit('disconnected');
}

function getState() {
    let status;
    if (_qr) status = 'qr';
    else if (_syncActive) status = _connected ? 'syncing' : 'connecting';
    else status = _connected ? 'connected' : 'disconnected';
    return {
        connected: _connected,
        status,
        version: _version,
        phone: _phone,
        qr: _qr,
        connectedAt: _connectedAt,
        syncActive: _syncActive,
        syncPct: _syncPct,
        syncEtapa: _syncEtapa
    };
}

function waitForConnection(timeoutMs = 60000) {
    if (_connected) return Promise.resolve(getState());
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            emitter.off('connected', onConn);
            reject(new Error('timeout esperando bot principal conectar'));
        }, timeoutMs);
        const onConn = (state) => {
            clearTimeout(t);
            resolve(state);
        };
        emitter.once('connected', onConn);
    });
}

function isConnected() { return _connected; }

function getVersion() { return _version; }

module.exports = {
    setConnected,
    setSyncing,
    finishSync,
    setDisconnected,
    setQr,
    clearQr,
    getState,
    waitForConnection,
    isConnected,
    getVersion,
    setSock,
    getSock,
    clearSock,
    emitter
};
