/**
 * singleInstance — garante UM único processo do bot por diretório.
 *
 * Sem isso, dois processos (ex.: pm2 + `npm start` órfão, ou dois apps no pm2)
 * abrem o MESMO número no Baileys: cada conexão derruba a outra com close 440
 * (connectionReplaced), gerando o loop infinito de reconexão e a "sessão
 * fantasma". Este guard usa um lock atômico (open 'wx') com PID + verificação
 * de vida. Processo morto = lock obsoleto, retomado na hora.
 *
 * Sem dependências nativas; funciona em Windows/Linux/Docker.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Caminho absoluto a partir do módulo (não do cwd): pm2 pode iniciar o app com
// cwd diferente do shell e, com cwd relativo, cada um criaria um lock distinto —
// a proteção contra sessão fantasma simplesmente não valeria.
const DEFAULT_LOCK_PATH = process.env.BOT_INSTANCE_LOCK
    || path.join(__dirname, '..', '..', 'session', '.instance.lock');
const TOKEN = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
// PM2 marca o processo filho com pm_id / NODE_APP_INSTANCE.
const IS_PM2 = process.env.pm_id != null || process.env.NODE_APP_INSTANCE != null;

let _released = false;
let _registered = false;

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e && e.code === 'EPERM'; }
}

function readLock(lockPath = DEFAULT_LOCK_PATH) {
    try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!data || !Number.isInteger(data.pid)) return null;
        return data;
    } catch (_) { return null; }
}

function removeLock(lockPath = DEFAULT_LOCK_PATH) {
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
}

function writeLock(lockPath = DEFAULT_LOCK_PATH) {
    const fd = fs.openSync(lockPath, 'wx'); // falha com EEXIST se já existe
    try {
        fs.writeSync(fd, JSON.stringify({
            pid: process.pid,
            pmId: process.env.pm_id != null ? Number(process.env.pm_id) : null,
            pm2: IS_PM2,
            token: TOKEN,
            startedAt: new Date().toISOString(),
            cwd: process.cwd()
        }));
    } finally {
        try { fs.closeSync(fd); } catch (_) {}
    }
}

function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (_) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

function killProcess(pid) {
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
        return true;
    } catch (_) { return false; }
}

function release(lockPath = DEFAULT_LOCK_PATH) {
    if (_released) return;
    _released = true;
    const holder = readLock(lockPath);
    if (!holder || holder.token === TOKEN) removeLock(lockPath);
}

function registerRelease(lockPath) {
    if (_registered) return;
    _registered = true;
    // 'exit' dispara sempre, inclusive nos process.exit() de outros módulos.
    try { process.on('exit', () => release(lockPath)); } catch (_) {}
}

/**
 * Tenta adquirir o lock.
 * Retorna:
 *   { ok: true }                 -> pode iniciar (única instância)
 *   { ok: true, degraded: true } -> falha inesperada do lock; segue (fail-open)
 *   { ok: false, holder }        -> outra instância VIVA; NÃO abrir sockets
 */
function acquire(opts = {}) {
    const lockPath = opts.lockPath || DEFAULT_LOCK_PATH;
    const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 30000;
    const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 1000;
    const killOrphan = opts.killOrphan !== false;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (_) {}

    const deadline = Date.now() + waitMs;
    let killed = false;
    try {
        while (true) {
            try {
                writeLock(lockPath);
                registerRelease(lockPath);
                return { ok: true };
            } catch (e) {
                if (!e || e.code !== 'EEXIST') throw e;
            }
            const holder = readLock(lockPath);
            if (!holder || !isProcessAlive(holder.pid)) {
                removeLock(lockPath); // lock obsoleto (processo morto)
                continue;
            }
            // Instância órfã (fora do pm2) segurando o número: o pm2 é dono.
            if (killOrphan && !killed && IS_PM2 && !holder.pm2) {
                log(`instância órfã viva (pid=${holder.pid}) — encerrando para assumir`);
                killed = killProcess(holder.pid);
                sleepSync(500);
                removeLock(lockPath);
                continue;
            }
            if (Date.now() >= deadline) return { ok: false, holder };
            sleepSync(pollMs);
        }
    } catch (e) {
        return { ok: true, degraded: true, error: e };
    }
}

module.exports = {
    acquire,
    release,
    readLock,
    isProcessAlive,
    killProcess,
    DEFAULT_LOCK_PATH,
    TOKEN,
    IS_PM2
};
