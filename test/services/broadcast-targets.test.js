// ATENÇÃO: estes testes NUNCA tocam no banco real.
// resolveBroadcastTargets recebe listas fake via deps — um teste anterior
// sem isso podou 32 grupos de verdade do bot.db (restaurado do backup).
// Não reintroduzir chamadas a utils.activateGroup/deactivateGroup aqui.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const safe = require('../../src/services/safeBroadcast');
const groupEvents = require('../../src/events/group');

const G_REAL = 'test-bc-real@g.us';
const G_PARTIAL = 'test-bc-partial@g.us';
const G_DEAD = 'test-bc-dead@g.us';

function fakeDeps(prunedOut) {
    return {
        listActive: () => [G_REAL, G_DEAD],
        listPartial: () => [G_PARTIAL],
        deactivate: (j) => { prunedOut.push(j); }
    };
}

describe('broadcast — só grupos reais (ativo/parcial com o bot dentro)', () => {
    it('filtra mortos e poda via deps (sem banco)', async () => {
        const prunedOut = [];
        const fakeSock = {
            groupFetchAllParticipating: async () => ({ [G_REAL]: {}, [G_PARTIAL]: {} })
        };
        const r = await safe.resolveBroadcastTargets(fakeSock, fakeDeps(prunedOut));
        assert.strictEqual(r.membershipOk, true);
        assert.deepStrictEqual(r.groups.slice().sort(), [G_PARTIAL, G_REAL].sort());
        assert.deepStrictEqual(r.pruned, [G_DEAD]);
        assert.deepStrictEqual(prunedOut, [G_DEAD]);
        assert.strictEqual(r.activeCount, 1);
        assert.strictEqual(r.partialCount, 1);
    });

    it('sem presença cai para a lista do banco (sem podar)', async () => {
        const prunedOut = [];
        const r = await safe.resolveBroadcastTargets({}, fakeDeps(prunedOut));
        assert.strictEqual(r.membershipOk, false);
        assert.deepStrictEqual(r.groups.slice().sort(), [G_DEAD, G_PARTIAL, G_REAL].sort());
        assert.deepStrictEqual(r.pruned, []);
        assert.deepStrictEqual(prunedOut, []);
    });
});

describe('groups — bot removido desliga sozinho', () => {
    it('isBotRemoved detecta o próprio bot (mesmo formato)', () => {
        const bot = '5511999999999:12@s.whatsapp.net';
        assert.strictEqual(groupEvents.isBotRemoved({ action: 'remove', participants: ['5511999999999@s.whatsapp.net'] }, bot), true);
    });

    it('isBotRemoved detecta por dígitos quando o formato difere', () => {
        const bot = '5511999999999:12@s.whatsapp.net';
        assert.strictEqual(groupEvents.isBotRemoved({ action: 'remove', participants: ['5511999999999:99@s.whatsapp.net'] }, bot), true);
    });

    it('isBotRemoved ignora saída de terceiros e outros actions', () => {
        const bot = '5511999999999:12@s.whatsapp.net';
        assert.strictEqual(groupEvents.isBotRemoved({ action: 'remove', participants: ['5511888888888@s.whatsapp.net'] }, bot), false);
        assert.strictEqual(groupEvents.isBotRemoved({ action: 'add', participants: ['5511999999999@s.whatsapp.net'] }, bot), false);
        assert.strictEqual(groupEvents.isBotRemoved({ action: 'remove', participants: [] }, bot), false);
        assert.strictEqual(groupEvents.isBotRemoved(null, bot), false);
    });
});
