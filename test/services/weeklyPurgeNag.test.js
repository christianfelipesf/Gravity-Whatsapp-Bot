// Lembrete semanal de limpeza (weeklyPurgeNag).
// Roda contra banco TEMPORÁRIO (BOT_DB_PATH) — nunca toca no bot.db real.
process.env.BOT_DB_PATH = require('path').join(require('os').tmpdir(), `bot-test-purgenag-${process.pid}.db`);

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const utils = require('../../src/database/utils');
const { db } = require('../../src/database/db');
const nag = require('../../src/services/weeklyPurgeNag');

// Isola o Telegram: registra envios em vez de POST real.
const _sent = [];
try {
    const tg = require('../../src/services/telegramBot');
    tg.send = async (chatId, text) => { _sent.push(String(text || '')); return { ok: true }; };
} catch (_) {}

const G_ALIVE = 'nag-alive@g.us';
const G_DEAD = 'nag-dead@g.us';

function wipe() {
    for (const j of [G_ALIVE, G_DEAD]) {
        try { db.prepare('DELETE FROM active_groups WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(j); } catch (_) {}
        try { db.prepare('DELETE FROM news_groups WHERE jid = ?').run(j); } catch (_) {}
    }
    try { db.prepare("DELETE FROM config WHERE key = 'lastPurgeNagAt'").run(); } catch (_) {}
}

function setSock(participating) {
    const prev = global.__baileysSock;
    if (participating === null) {
        global.__baileysSock = null;
    } else {
        global.__baileysSock = {
            groupFetchAllParticipating: async () => Object.fromEntries(participating.map((j) => [j, {}]))
        };
    }
    return prev;
}

after(() => {
    wipe();
    for (const suf of ['', '-shm', '-wal', '-journal']) {
        try { fs.unlinkSync(process.env.BOT_DB_PATH + suf); } catch (_) {}
    }
});

describe('weeklyPurgeNag', () => {
    it('findDeadGroups acha mortos via membership', async () => {
        wipe();
        utils.activateGroup(G_ALIVE);
        utils.activateGroup(G_DEAD);
        const prev = setSock([G_ALIVE]);
        try {
            const r = await nag.findDeadGroups();
            assert.strictEqual(r.membershipOk, true);
            assert.deepStrictEqual(r.dead, [G_DEAD]);
        } finally { global.__baileysSock = prev; wipe(); }
    });

    it('não envia antes de 7 dias (too-early)', async () => {
        wipe();
        utils.activateGroup(G_DEAD);
        const prev = setSock([]);
        _sent.length = 0;
        try {
            const cfg = utils.readConfig();
            cfg.lastPurgeNagAt = Date.now();
            utils.writeConfig(cfg);
            const r = await nag.checkWeeklyNag({ reason: 'test' });
            assert.strictEqual(r.reason, 'too-early');
            assert.strictEqual(_sent.length, 0, 'nada enviado antes da semana');
        } finally { global.__baileysSock = prev; wipe(); }
    });

    it('envia lembrete quando há mortos e semana venceu', async () => {
        wipe();
        utils.activateGroup(G_DEAD);
        const prev = setSock([]);
        _sent.length = 0;
        try {
            const cfg = utils.readConfig();
            cfg.lastPurgeNagAt = 0;
            utils.writeConfig(cfg);
            const r = await nag.checkWeeklyNag({ reason: 'test' });
            assert.strictEqual(r.ok, true);
            assert.strictEqual(r.dead, 1);
            assert.ok(_sent.some((t) => t.includes('/limparmortos')), 'mensagem deve citar /limparmortos');
            assert.ok(Number(utils.readConfig().lastPurgeNagAt) > 0, 'carimba lastPurgeNagAt');
        } finally { global.__baileysSock = prev; wipe(); }
    });

    it('silencioso quando não há mortos (mas carimba a semana)', async () => {
        wipe();
        utils.activateGroup(G_ALIVE);
        const prev = setSock([G_ALIVE]);
        _sent.length = 0;
        try {
            const cfg = utils.readConfig();
            cfg.lastPurgeNagAt = 0;
            utils.writeConfig(cfg);
            const r = await nag.checkWeeklyNag({ reason: 'test' });
            assert.strictEqual(r.ok, true);
            assert.strictEqual(r.dead, 0);
            assert.strictEqual(_sent.length, 0, 'sem mortos, sem mensagem');
            assert.ok(Number(utils.readConfig().lastPurgeNagAt) > 0);
        } finally { global.__baileysSock = prev; wipe(); }
    });

    it('sem sock não quebra nem carimba (com grupos registrados)', async () => {
        wipe();
        utils.activateGroup(G_DEAD);
        const prev = setSock(null);
        _sent.length = 0;
        try {
            const cfg = utils.readConfig();
            cfg.lastPurgeNagAt = 0;
            utils.writeConfig(cfg);
            const r = await nag.checkWeeklyNag({ reason: 'test' });
            assert.strictEqual(r.reason, 'no-membership');
            assert.strictEqual(_sent.length, 0);
            assert.strictEqual(Number(utils.readConfig().lastPurgeNagAt) || 0, 0, 'não carimba sem membership');
        } finally { global.__baileysSock = prev; wipe(); }
    });
});
