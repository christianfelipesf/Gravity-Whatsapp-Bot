// Blindagem anti-base64 no histórico: garante que data: URL grande (ex. nota
// de voz audio/ogg; codecs=opus) nunca pare no media_json do banco — foi o
// que inflou o bot.db em ~47MB. Roda contra banco TEMPORÁRIO (BOT_DB_PATH).
process.env.BOT_DB_PATH = require('path').join(require('os').tmpdir(), `bot-test-inlinemedia-${process.pid}.db`);

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const store = require('../../src/history/store');
const utils = require('../../src/database/utils');
const { db } = require('../../src/database/db');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'temp', 'dashboard_media');
const _createdMediaIds = [];

after(() => {
    for (const id of _createdMediaIds) {
        try { fs.unlinkSync(path.join(MEDIA_DIR, encodeURIComponent(id))); } catch (_) {}
    }
    for (const suf of ['', '-shm', '-wal', '-journal']) {
        try { fs.unlinkSync(process.env.BOT_DB_PATH + suf); } catch (_) {}
    }
});

function bigDataUrl(mime, kb) {
    // base64 válido de ~kb KB
    const buf = Buffer.alloc(kb * 1024, 0x61);
    return `data:${mime};base64,${buf.toString('base64')}`;
}

describe('histórico — trava anti-base64 (bot.db 75MB)', () => {
    it('persistReceivedMedia casa mime com codecs (audio/ogg; codecs=opus)', () => {
        const msgId = `test-voice-${Date.now()}`;
        _createdMediaIds.push(msgId);
        const out = store.persistReceivedMedia(
            { type: 'audio', url: bigDataUrl('audio/ogg; codecs=opus', 100), sizeBytes: 100 * 1024 },
            msgId
        );
        assert.ok(out, 'deve retornar info de mídia');
        assert.ok(!String(out.url || '').startsWith('data:'), `url não pode ser data: (veio ${String(out.url).slice(0, 30)})`);
        assert.ok(String(out.url).startsWith('/media/'), 'deve apontar p/ arquivo em disco');
        assert.strictEqual(out.mime, 'audio/ogg', 'mime deve ser sanitizado (sem codecs)');
        assert.ok(fs.existsSync(path.join(MEDIA_DIR, encodeURIComponent(msgId))), 'arquivo deve existir em disco');
    });

    it('persistReceivedMedia nunca devolve data: gigante (falha vira url:null)', () => {
        const out = store.persistReceivedMedia(
            { type: 'audio', url: bigDataUrl('audio/ogg; codecs=opus', 200), sizeBytes: 200 * 1024 },
            null // sem messageId: impossível persistir em disco
        );
        assert.ok(out, 'deve retornar algo (nunca undefined p/ quebrar chamador)');
        assert.ok(!String(out.url || '').startsWith('data:'), 'mesmo sem messageId não pode vazar data:');
    });

    it('insertDashboardLog troca data: >64KB por url:null', () => {
        const toJid = `test-inline-${Date.now()}@g.us`;
        const msgId = `mid-${Date.now()}`;
        const ok = utils.insertDashboardLog({
            type: 'chat', group: 'T', text: '[audio]', name: 'U',
            media: { type: 'audio', url: bigDataUrl('audio/ogg; codecs=opus', 100) },
            toJid, messageId: msgId, timestamp: Date.now()
        });
        assert.strictEqual(ok, true);
        const row = db.prepare('SELECT media_json FROM dashboard_logs WHERE to_jid = ?').get(toJid);
        assert.ok(row && !row.media_json.includes('base64'), 'banco não pode conter base64');
        const saved = JSON.parse(row.media_json);
        assert.strictEqual(saved.type, 'audio');
        assert.strictEqual(saved.url, null);
        db.prepare('DELETE FROM dashboard_logs WHERE to_jid = ?').run(toJid);
    });

    it('updateDashboardLogMedia troca base64 gigante por url:null', () => {
        const toJid = `test-upd-${Date.now()}@g.us`;
        const msgId = `mid-upd-${Date.now()}`;
        utils.insertDashboardLog({
            type: 'chat', group: 'T', text: '[audio]', name: 'U',
            media: { type: 'audio', url: null }, toJid, messageId: msgId, timestamp: Date.now()
        });
        const big = JSON.stringify({ type: 'audio', url: bigDataUrl('audio/mp4', 100) });
        const changed = utils.updateDashboardLogMedia(toJid, msgId, 'chat', big);
        assert.strictEqual(changed, true);
        const row = db.prepare('SELECT media_json FROM dashboard_logs WHERE to_jid = ?').get(toJid);
        assert.ok(!row.media_json.includes('base64'), 'update não pode gravar base64');
        assert.strictEqual(JSON.parse(row.media_json).url, null);
        db.prepare('DELETE FROM dashboard_logs WHERE to_jid = ?').run(toJid);
    });

    it('data: pequeno (<64KB, ex. thumbnail) continua passando', () => {
        const toJid = `test-small-${Date.now()}@g.us`;
        utils.insertDashboardLog({
            type: 'chat', group: 'T', text: '[img]', name: 'U',
            media: { type: 'image', url: bigDataUrl('image/jpeg', 10) },
            toJid, messageId: `mid-small-${Date.now()}`, timestamp: Date.now()
        });
        const row = db.prepare('SELECT media_json FROM dashboard_logs WHERE to_jid = ?').get(toJid);
        assert.ok(JSON.parse(row.media_json).url.startsWith('data:'), 'pequeno segue inline (sem mudança de comportamento)');
        db.prepare('DELETE FROM dashboard_logs WHERE to_jid = ?').run(toJid);
    });
});
