// !news desativar-todos + !limparmortos (+ utils.purgeDeadGroup).
// Roda contra banco TEMPORÁRIO (BOT_DB_PATH) — nunca toca no bot.db real.
process.env.BOT_DB_PATH = require('path').join(require('os').tmpdir(), `bot-test-deadgroups-${process.pid}.db`);

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const utils = require('../../src/database/utils');
const { db } = require('../../src/database/db');
const newsCmd = require('../../src/commands/news');
const limparmortosCmd = require('../../src/commands/limparmortos');

// Isola a nuvem: sem isso cada purge tenta DELETE real (timeout de rede).
// Registra as chamadas p/ o teste anti-ressurreição conferir.
const _cloudCalls = [];
try {
    const sc = require('../../src/database/supabaseClient');
    sc.supaFetch = async (p, o) => { _cloudCalls.push([p, o && o.method]); return { ok: true }; };
    sc.isSupabaseEnabled = () => false;
} catch (_) {}

const BOT = 'bot@s.whatsapp.net';
const PV = 'dono@s.whatsapp.net';
const G_ALIVE = 'alive@g.us';
const G_DEAD1 = 'dead1@g.us';
const G_DEAD2 = 'dead2@g.us';

function mockSock(participating) {
    const sent = [];
    return {
        sent,
        user: { id: BOT },
        groupFetchAllParticipating: participating === null
            ? undefined
            : async () => Object.fromEntries(participating.map((j) => [j, {}])),
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; }
    };
}

function msg(fromMe = false) {
    return { key: { id: `m${Date.now()}${Math.random()}`, remoteJid: PV, fromMe } };
}

const ctxBase = {
    from: PV,
    isGroup: false,
    sender: BOT, // dono (sender === bot)
    config: { prefix: '!', botName: 'Bot' },
    utils,
    fullArgsText: '',
    args: [],
    lastBotResponse: 0,
    GLOBAL_COOLDOWN: 1000
};

function wipeGroups() {
    for (const j of [G_ALIVE, G_DEAD1, G_DEAD2]) {
        try { db.prepare('DELETE FROM active_groups WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM news_groups WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM group_state WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM dashboard_logs WHERE to_jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM messages WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM group_msg_stats WHERE jid = ?').run(j); } catch (_) {}
    }
}

after(() => {
    wipeGroups();
    for (const suf of ['', '-shm', '-wal', '-journal']) {
        try { fs.unlinkSync(process.env.BOT_DB_PATH + suf); } catch (_) {}
    }
});

describe('!news desativar-todos', () => {
    it('dono desliga o feed em todos os grupos (PV)', async () => {
        wipeGroups();
        utils.setNewsEnabled(G_ALIVE, true);
        utils.setNewsEnabled(G_DEAD1, true);
        assert.strictEqual(utils.listNewsGroups().length, 2);
        const sock = mockSock([G_ALIVE]);
        await newsCmd.execute(sock, msg(), { ...ctxBase, fullArgsText: 'desativar-todos' });
        assert.strictEqual(utils.listNewsGroups().length, 0);
        assert.ok(sock.sent.some((s) => String(s.content?.text || '').includes('2 grupo')));
    });

    it('lista vazia responde que já está tudo desligado', async () => {
        wipeGroups();
        const sock = mockSock([G_ALIVE]);
        await newsCmd.execute(sock, msg(), { ...ctxBase, fullArgsText: 'desativar-todos' });
        assert.ok(sock.sent.some((s) => String(s.content?.text || '').includes('já está desativado')));
    });

    it('sub-dono também pode desativar todos', async () => {
        wipeGroups();
        utils.addSubOwner('5511999999999');
        utils.setNewsEnabled(G_ALIVE, true);
        utils.setNewsEnabled(G_DEAD1, true);
        const sock = mockSock([G_ALIVE]);
        await newsCmd.execute(sock, msg(), { ...ctxBase, sender: '5511999999999@s.whatsapp.net', fullArgsText: 'desativar-todos' });
        assert.strictEqual(utils.listNewsGroups().length, 0, 'sub-dono pode desligar tudo');
        utils.removeSubOwner('5511999999999');
        wipeGroups();
    });

    it('não-dono é negado', async () => {
        wipeGroups();
        utils.setNewsEnabled(G_ALIVE, true);
        const sock = mockSock([G_ALIVE]);
        await newsCmd.execute(sock, msg(), { ...ctxBase, sender: 'intruso@s.whatsapp.net', fullArgsText: 'desativar-todos' });
        assert.strictEqual(utils.listNewsGroups().length, 1, 'intruso não pode desligar');
        wipeGroups();
    });
});

describe('utils.purgeDeadGroup', () => {
    it('apaga ativação, news, state, logs e stats com contagens', () => {
        wipeGroups();
        utils.activateGroup(G_DEAD1);
        utils.setNewsEnabled(G_DEAD1, true);
        utils.insertDashboardLog({ type: 'chat', group: 'G', text: 'oi', toJid: G_DEAD1, senderJid: 'u@s.whatsapp.net', timestamp: Date.now() });
        const r = utils.purgeDeadGroup(G_DEAD1);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(utils.isActiveGroup(G_DEAD1), false);
        assert.strictEqual(utils.isNewsEnabled(G_DEAD1), false);
        assert.strictEqual(r.removed.dashboard_logs, 1);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS v FROM group_state WHERE jid = ?').get(G_DEAD1).v, 0);
        const again = utils.purgeDeadGroup(G_DEAD1);
        assert.strictEqual(again.ok, true, 'idempotente');
    });

    it('rejeita jid inválido', () => {
        assert.strictEqual(utils.purgeDeadGroup('nao-grupo@s.whatsapp.net').ok, false);
        assert.strictEqual(utils.purgeDeadGroup(null).ok, false);
    });

    it('propaga deletes p/ nuvem (anti-ressurreição no PULL)', () => {
        const sc = require('../../src/database/supabaseClient');
        const origEnabled = sc.isSupabaseEnabled;
        sc.isSupabaseEnabled = () => true;
        _cloudCalls.length = 0;
        try {
            wipeGroups();
            utils.activateGroup(G_DEAD1);
            utils.purgeDeadGroup(G_DEAD1);
            const dels = _cloudCalls.filter((c) => c[1] === 'DELETE').map((c) => c[0]);
            assert.ok(dels.some((p) => p.startsWith('/dashboard_logs?to_jid=')), 'delete dashboard_logs: ' + JSON.stringify(dels));
            assert.ok(dels.some((p) => p.startsWith('/group_msg_stats?jid=')), 'delete group_msg_stats: ' + JSON.stringify(dels));
            assert.ok(dels.some((p) => p.startsWith('/group_modlog?jid=')), 'delete group_modlog: ' + JSON.stringify(dels));
        } finally {
            sc.isSupabaseEnabled = origEnabled;
            wipeGroups();
        }
    });
});

describe('!limparmortos', () => {
    it('lista mortos e purga após confirmar', async () => {
        wipeGroups();
        utils.activateGroup(G_ALIVE);
        utils.activateGroup(G_DEAD1);
        utils.activateGroup(G_DEAD2);
        utils.setNewsEnabled(G_DEAD2, true);
        utils.insertDashboardLog({ type: 'chat', group: 'G', text: 'x', toJid: G_DEAD2, senderJid: 'u@s.whatsapp.net', timestamp: Date.now() });

        const sock = mockSock([G_ALIVE]); // bot só está no ALIVE
        await limparmortosCmd.execute(sock, msg(), { ...ctxBase, fullArgsText: '' });
        const listMsg = sock.sent.map((s) => String(s.content?.text || '')).join('\n');
        assert.ok(listMsg.includes('dead1'), 'deve listar dead1');
        assert.ok(listMsg.includes('dead2'), 'deve listar dead2');
        assert.ok(!listMsg.includes('alive@g'), 'não pode listar grupo vivo');
        // nada apagado ainda (exige confirmar)
        assert.strictEqual(utils.isActiveGroup(G_DEAD1), true);

        await limparmortosCmd.execute(sock, msg(), { ...ctxBase, fullArgsText: 'confirmar' });
        assert.strictEqual(utils.isActiveGroup(G_DEAD1), false);
        assert.strictEqual(utils.isActiveGroup(G_DEAD2), false);
        assert.strictEqual(utils.isNewsEnabled(G_DEAD2), false);
        assert.strictEqual(utils.isActiveGroup(G_ALIVE), true, 'vivo preservado');
        const doneMsg = sock.sent.map((s) => String(s.content?.text || '')).join('\n');
        assert.ok(doneMsg.includes('Limpeza concluída'));
        wipeGroups();
    });

    it('sem membership não apaga nada (nunca purga no escuro)', async () => {
        wipeGroups();
        utils.activateGroup(G_DEAD1);
        const sock = mockSock(null); // sem groupFetchAllParticipating
        await limparmortosCmd.execute(sock, msg(), { ...ctxBase, fullArgsText: '' });
        assert.strictEqual(utils.isActiveGroup(G_DEAD1), true, 'sem lista real, nada é purgado');
        const t = sock.sent.map((s) => String(s.content?.text || '')).join('\n');
        assert.ok(t.includes('Não consegui ler'));
        wipeGroups();
    });

    it('sub-dono pode varrer mortos', async () => {
        wipeGroups();
        utils.addSubOwner('5511999999999');
        utils.activateGroup(G_DEAD1);
        const sock = mockSock([G_ALIVE]);
        await limparmortosCmd.execute(sock, msg(), { ...ctxBase, sender: '5511999999999@s.whatsapp.net', fullArgsText: '' });
        const t = sock.sent.map((s) => String(s.content?.text || '')).join('\n');
        assert.ok(t.includes('dead1'), 'sub-dono recebe a lista de mortos');
        utils.removeSubOwner('5511999999999');
        wipeGroups();
    });

    it('não-dono é negado', async () => {
        const sock = mockSock([G_ALIVE]);
        await limparmortosCmd.execute(sock, msg(), { ...ctxBase, sender: 'intruso@s.whatsapp.net', fullArgsText: '' });
        assert.ok(sock.sent.some((s) => String(s.content?.text || '').includes('Apenas o dono')));
    });
});
