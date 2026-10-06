const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const si = require('../../src/services/singleInstance');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test-'));
let n = 0;
function lockPath() { return path.join(tmpDir, `lock-${++n}`); }

after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('singleInstance', () => {
    it('detecta processo vivo e morto', () => {
        assert.strictEqual(si.isProcessAlive(process.pid), true);
        assert.strictEqual(si.isProcessAlive(0), false);
        assert.strictEqual(si.isProcessAlive(999999999), false);
        assert.strictEqual(si.isProcessAlive(null), false);
    });

    it('adquire o lock e grava pid/token', () => {
        const lp = lockPath();
        const r = si.acquire({ lockPath: lp, waitMs: 100 });
        assert.strictEqual(r.ok, true);
        const data = si.readLock(lp);
        assert.strictEqual(data.pid, process.pid);
        assert.strictEqual(data.token, si.TOKEN);
        fs.rmSync(lp, { force: true });
    });

    it('retoma lock obsoleto (processo morto)', () => {
        const lp = lockPath();
        fs.writeFileSync(lp, JSON.stringify({ pid: 999999999, token: 'morto', pm2: false }));
        const r = si.acquire({ lockPath: lp, waitMs: 100 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(si.readLock(lp).pid, process.pid);
        fs.rmSync(lp, { force: true });
    });

    it('recusa quando outra instância viva segura o lock', () => {
        const lp = lockPath();
        fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, token: 'outro', pm2: false }));
        const r = si.acquire({ lockPath: lp, waitMs: 30, pollMs: 10 });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.holder.token, 'outro');
        fs.rmSync(lp, { force: true });
    });
});
