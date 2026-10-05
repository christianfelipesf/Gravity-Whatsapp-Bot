const { describe, it, after } = require('node:test');
const assert = require('node:assert');

const msg = require('../src/events/partial.js');

const G = 'test-partial-g@s.us';

after(() => {
    try {
        const db = require('../src/database/db').db;
        db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(G);
        db.prepare('DELETE FROM active_groups WHERE jid = ?').run(G);
    } catch (_) {}
    try { msg.cancelPartialPendingForGroup(G); } catch (_) {}
});

describe('modo parcial — filtro de comandos', () => {
    it('libera categoria mídia (!s, !play, !toimg, !download)', () => {
        assert.strictEqual(msg.isPartialAllowed({ name: 's', category: 'mídia' }), true);
        assert.strictEqual(msg.isPartialAllowed({ name: 'play', category: 'mídia' }), true);
        assert.strictEqual(msg.isPartialAllowed({ name: 'toimg', category: 'mídia' }), true);
        assert.strictEqual(msg.isPartialAllowed({ name: 'download', category: 'mídia' }), true);
    });

    it('libera categoria interação (!abraco e afins)', () => {
        assert.strictEqual(msg.isPartialAllowed({ name: 'abraco', category: 'interação' }), true);
        assert.strictEqual(msg.isPartialAllowed({ name: 'beijar', category: 'interação' }), true);
    });

    it('libera !tts via allowlist mesmo sendo utilidades', () => {
        assert.strictEqual(msg.isPartialAllowed({ name: 'tts', aliases: ['falar', 'voz'], category: 'utilidades' }), true);
        assert.strictEqual(msg.isPartialAllowed({ name: 'falar', category: 'utilidades' }), true);
    });

    it('bloqueia utilidades fora da allowlist (!divulgar, !setlink)', () => {
        assert.strictEqual(msg.isPartialAllowed({ name: 'divulgar', category: 'utilidades' }), false);
        assert.strictEqual(msg.isPartialAllowed({ name: 'setlink', category: 'utilidades' }), false);
    });

    it('bloqueia admin/geral/config mesmo fora da blocklist explícita', () => {
        assert.strictEqual(msg.isPartialAllowed({ name: 'ban', category: 'admin' }), false);
        assert.strictEqual(msg.isPartialAllowed({ name: 'menu', category: 'geral' }), false);
        assert.strictEqual(msg.isPartialAllowed({ name: 'rank', category: 'geral' }), false);
        assert.strictEqual(msg.isPartialAllowed({ name: 'config', category: 'config' }), false);
    });

    it('bypass contém controle+status e BLOCKED não contém status', () => {
        for (const c of ['ativar', 'desativar', 'ativarp', 'desativarp', 'status', 'statusp', 'dashboard', 'dash', 'painel']) {
            assert.ok(msg.PARTIAL_BYPASS_COMMANDS.has(c), `bypass deveria conter ${c}`);
        }
        assert.ok(!msg.PARTIAL_BLOCKED_COMMANDS.has('status'), 'status não pode estar no BLOCKED (bypass vence)');
        assert.ok(!msg.PARTIAL_BLOCKED_COMMANDS.has('statusp'), 'statusp não pode estar no BLOCKED (bypass vence)');
    });
});

describe('modo parcial — pendências e reação', () => {
    it('outro bot reagindo cancela (reacted:true)', async () => {
        const jid = G + '-reagiu';
        const p = msg.registerPartialPending(jid, 'm1', 'play', '111@s.whatsapp.net');
        assert.ok(p, 'deveria registrar pendência');
        msg.setPartialTimer(jid, 'm1', 5000);
        const done = p.then(r => r);
        const ok = msg.notifyPartialReaction(jid, 'm1', '222@s.whatsapp.net', false);
        assert.strictEqual(ok, true);
        const res = await done;
        assert.strictEqual(res.reacted, true);
    });

    it('reação do próprio bot (mesmo número ou fromMe) NÃO cancela', () => {
        const jid = G + '-proprio';
        msg.registerPartialPending(jid, 'm2', 's', '111@s.whatsapp.net');
        assert.strictEqual(msg.notifyPartialReaction(jid, 'm2', '111@s.whatsapp.net', false), false);
        assert.strictEqual(msg.notifyPartialReaction(jid, 'm2', '999@s.whatsapp.net', true), false);
        msg.cancelPartialPendingForGroup(jid);
    });

    it('timer expira com reacted:false', async () => {
        const jid = G + '-timer';
        const p = msg.registerPartialPending(jid, 'm3', 'toimg', '111@s.whatsapp.net');
        msg.setPartialTimer(jid, 'm3', 20);
        const res = await p;
        assert.strictEqual(res.reacted, false);
    });

    it('cancelPartialPendingForGroup limpa só o grupo alvo', () => {
        const a = G + '-A';
        const b = G + '-B';
        msg.registerPartialPending(a, 'x1', 'play', 'bot@s.whatsapp.net');
        msg.registerPartialPending(b, 'x1', 'play', 'bot@s.whatsapp.net');
        const n = msg.cancelPartialPendingForGroup(a);
        assert.strictEqual(n, 1);
        // b continua pendente (reação ainda cancela) e depois é limpa
        assert.strictEqual(msg.notifyPartialReaction(b, 'x1', 'outro@s.whatsapp.net', false), true);
    });
});

describe('modo parcial — utils (db)', () => {
    it('partialWaitMs padrão é 10000 e roundtrip funciona', () => {
        const utils = require('../src/database/utils.js');
        const prev = utils.getPartialWaitMs();
        try {
            assert.strictEqual(utils.setPartialWaitMs(10000), 10000);
            assert.strictEqual(utils.getPartialWaitMs(), 10000);
        } finally {
            try { utils.setPartialWaitMs(prev); } catch (_) {}
        }
    });

    it('activate/deactivate parcial são idempotentes', () => {
        const utils = require('../src/database/utils.js');
        assert.strictEqual(utils.activatePartial(G), true);
        assert.strictEqual(utils.isPartialActive(G), true);
        assert.strictEqual(utils.activatePartial(G), true, 'segunda ativação deve ser sucesso');
        assert.strictEqual(utils.deactivatePartial(G), true);
        assert.strictEqual(utils.isPartialActive(G), false);
        assert.strictEqual(utils.deactivatePartial(G), true, 'desativar de novo deve ser sucesso');
    });
});
