const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');

const utils = require('../src/database/utils.js');
const { db } = require('../src/database/db');

const G = 'test-sync-member-g@g.us';

// O reconcile varre o banco TODO (é o comportamento de produção no PULL).
// Para não tocar em grupos reais durante o teste: salva duplicados
// pré-existentes, remove durante a suíte e restaura no fim.
let savedDupes = [];
before(() => {
    savedDupes = db.prepare(`
        SELECT a.jid AS jid, a.activated_at AS a_at, p.activated_at AS p_at
        FROM active_groups a JOIN active_groups_partial p ON p.jid = a.jid
    `).all();
    for (const r of savedDupes) {
        db.prepare('DELETE FROM active_groups WHERE jid = ?').run(r.jid);
        db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(r.jid);
    }
});

after(() => {
    clean();
    for (const r of savedDupes) {
        db.prepare('INSERT OR REPLACE INTO active_groups (jid, activated_at) VALUES (?, ?)').run(r.jid, r.a_at);
        db.prepare('INSERT OR REPLACE INTO active_groups_partial (jid, activated_at) VALUES (?, ?)').run(r.jid, r.p_at);
    }
});

function clean() {
    try { db.prepare('DELETE FROM active_groups WHERE jid = ?').run(G); } catch (_) {}
    try { db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(G); } catch (_) {}
}

function seedBoth(aAt, pAt) {
    clean();
    db.prepare('INSERT OR REPLACE INTO active_groups (jid, activated_at) VALUES (?, ?)').run(G, aAt);
    db.prepare('INSERT OR REPLACE INTO active_groups_partial (jid, activated_at) VALUES (?, ?)').run(G, pAt);
}

function getAt(table) {
    const r = db.prepare(`SELECT activated_at AS t FROM "${table}" WHERE jid = ?`).get(G);
    return r ? Number(r.t) : null;
}

afterEach(clean);

describe('sync total/parcial — timestamps e exclusividade', () => {
    it('activateGroup remove parcial e atualiza activated_at ao re-ativar', () => {
        clean();
        assert.strictEqual(utils.activatePartial(G), true);
        const p1 = getAt('active_groups_partial');
        assert.ok(p1, 'parcial deveria existir');
        assert.strictEqual(utils.activateGroup(G), true);
        assert.strictEqual(utils.isPartialActive(G), false, '!ativar deve limpar o parcial');
        assert.strictEqual(utils.isActiveGroup(G), true);
        // Re-ativar "bumpa" o timestamp (rastro p/ desempate no PULL).
        const t1 = getAt('active_groups');
        while (Date.now() <= t1) { /* espera virar o ms */ }
        assert.strictEqual(utils.activateGroup(G), true);
        const t2 = getAt('active_groups');
        assert.ok(t2 > t1, `activated_at deveria avançar (${t1} -> ${t2})`);
    });

    it('activatePartial remove total e atualiza activated_at ao re-ativar', () => {
        clean();
        assert.strictEqual(utils.activateGroup(G), true);
        assert.strictEqual(utils.activatePartial(G), true);
        assert.strictEqual(utils.isActiveGroup(G), false, '!ativarp deve limpar o total');
        assert.strictEqual(utils.isPartialActive(G), true);
        const t1 = getAt('active_groups_partial');
        while (Date.now() <= t1) { /* espera virar o ms */ }
        assert.strictEqual(utils.activatePartial(G), true);
        const t2 = getAt('active_groups_partial');
        assert.ok(t2 > t1, `activated_at deveria avançar (${t1} -> ${t2})`);
    });

    it('deactivateGroup limpa as duas tabelas', () => {
        seedBoth(1000, 2000);
        assert.strictEqual(utils.deactivateGroup(G), true);
        assert.strictEqual(utils.isActiveGroup(G), false);
        assert.strictEqual(utils.isPartialActive(G), false);
    });
});

describe('sync total/parcial — reconcile pós-PULL', () => {
    it('sem duplicados: fixed 0 e não mexe em nada', () => {
        clean();
        db.prepare('INSERT OR REPLACE INTO active_groups (jid, activated_at) VALUES (?, ?)').run(G, 1000);
        const r = utils.reconcileActivePartial();
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.fixed, 0);
        assert.strictEqual(utils.isActiveGroup(G), true);
    });

    it('parcial mais recente vence (caso real do bug)', () => {
        seedBoth(1000, 2000);
        const r = utils.reconcileActivePartial();
        assert.strictEqual(r.fixed, 1);
        assert.strictEqual(utils.isPartialActive(G), true);
        assert.strictEqual(utils.isActiveGroup(G), false);
    });

    it('total mais recente vence', () => {
        seedBoth(3000, 2000);
        const r = utils.reconcileActivePartial();
        assert.strictEqual(r.fixed, 1);
        assert.strictEqual(utils.isActiveGroup(G), true);
        assert.strictEqual(utils.isPartialActive(G), false);
    });

    it('empate: total vence (evita bot mudo por engano)', () => {
        seedBoth(5000, 5000);
        const r = utils.reconcileActivePartial();
        assert.strictEqual(r.fixed, 1);
        assert.strictEqual(utils.isActiveGroup(G), true);
        assert.strictEqual(utils.isPartialActive(G), false);
    });
});
