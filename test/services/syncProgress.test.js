const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('syncProgress — dreno pós-reconnect', () => {
    let sp;

    beforeEach(() => {
        // Isola Telegram: sem isso startDraining/finish tentam POST real
        // (10s timeout) porque o .env local tem token configurado.
        try {
            const tgPath = require.resolve('../../src/services/telegramAlerts');
            delete require.cache[tgPath];
            const tg = require('../../src/services/telegramAlerts');
            tg.isConfigured = () => false;
            tg.notifySyncStart = async () => ({ ok: false, skipped: true });
            tg.notifySyncProgress = async () => ({ ok: false, skipped: true });
            tg.notifySyncDone = async () => ({ ok: false, skipped: true });
        } catch (_) {}
        delete require.cache[require.resolve('../../src/services/syncProgress')];
        sp = require('../../src/services/syncProgress');
        sp._reset();
    });

    it('renderBar gera barra proporcional', () => {
        assert.strictEqual(sp.renderBar(0, 10), '░'.repeat(10));
        assert.strictEqual(sp.renderBar(100, 10), '█'.repeat(10));
        assert.strictEqual(sp.renderBar(50, 10), '█'.repeat(5) + '░'.repeat(5));
    });

    it('startDraining abre janela e descarta backlog anterior ao open', () => {
        sp.startDraining();
        const drainStart = sp.getDrainStart();
        assert.ok(drainStart > 0);
        assert.strictEqual(sp.isDraining(), true);
        // msg de 1h atrás => fast-discard
        const oldSec = Math.floor(drainStart / 1000) - 3600;
        assert.strictEqual(sp.shouldFastDiscard(oldSec, false), true);
        // msg nova => não descarta
        const newSec = Math.floor(Date.now() / 1000);
        assert.strictEqual(sp.shouldFastDiscard(newSec, false), false);
        // fromMe nunca entra em fast-discard
        assert.strictEqual(sp.shouldFastDiscard(oldSec, true), false);
    });

    it('contadores atualizam pct e estado', () => {
        sp.startDraining();
        sp.onBatch(10);
        sp.countDiscarded(7);
        sp.countProcessed(1);
        const st = sp.getState();
        assert.strictEqual(st.received, 10);
        assert.strictEqual(st.discarded, 7);
        assert.strictEqual(st.processed, 1);
        assert.strictEqual(st.pct, 80);
        assert.strictEqual(st.phase, 'draining');
    });

    it('fora do draining não descarta nada', () => {
        sp._reset();
        assert.strictEqual(sp.isDraining(), false);
        assert.strictEqual(sp.shouldFastDiscard(Math.floor(Date.now() / 1000) - 3600, false), false);
    });

    it('finish/fail mudam a fase', () => {
        sp.startDraining();
        sp.onBatch(5);
        sp.finish('teste');
        assert.strictEqual(sp.getState().phase, 'ready');
        assert.strictEqual(sp.getState().pct, 100);
        sp.startDraining();
        sp.fail('boom');
        assert.strictEqual(sp.getState().phase, 'failed');
    });
});
