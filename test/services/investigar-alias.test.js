const { describe, it } = require('node:test');
const assert = require('node:assert');

process.env.BOT_DB_PATH = require('path').join(require('os').tmpdir(), `bot-test-alias-${process.pid}.db`);

const ev = require('../../src/services/ownerEvidence');
const agent = require('../../src/services/ownerAgent');
const utils = require('../../src/database/utils');

const G = 'alias@g.us';
const PHONE = '5511999999999';
const LID = '98765432109876@lid';
const sock = {
    groupMetadata: async () => ({
        participants: [
            { id: `${PHONE}@s.whatsapp.net`, lid: LID, admin: 'admin' },
            { id: '111222333@s.whatsapp.net' }
        ]
    })
};

describe('!investigar — alias reverso telefone→LID', () => {
    it('resolvePhoneLidInGroup acha o LID pelo número', async () => {
        assert.strictEqual(await utils.resolvePhoneLidInGroup(sock, PHONE, G), LID);
    });
    it('resolvePhoneLidInGroup null p/ desconhecido/curto/sem sock', async () => {
        assert.strictEqual(await utils.resolvePhoneLidInGroup(sock, '5500000000000', G), null);
        assert.strictEqual(await utils.resolvePhoneLidInGroup(sock, '123', G), null);
        assert.strictEqual(await utils.resolvePhoneLidInGroup(null, PHONE, G), null);
    });
    it('ownerEvidence.resolveAlias cobre número→LID', async () => {
        const stub = { resolvePhoneLidInGroup: async () => LID };
        assert.strictEqual(await ev.resolveAlias({}, `${PHONE}@s.whatsapp.net`, G, stub), LID);
        assert.strictEqual(await ev.resolveAlias({}, `${PHONE}@s.whatsapp.net`, null, stub), null);
    });
    it('buildEvidence usa o alias e acha as msgs do LID', async () => {
        const stub = {
            normalizeJid: (j) => String(j || '').toLowerCase(),
            getGroupData: () => ({ warnings: {} }),
            getMessagesBySender: (a, b) => (
                (a === LID || b === LID)
                    ? [{ text: 'fala do lid', name: 'Fulano', timestamp: Date.now() }]
                    : []
            ),
        };
        const { stats } = await ev.buildEvidence({}, { people: [{ jid: `${PHONE}@s.whatsapp.net`, alias: LID }], groups: [] },
            { from: G, isGroup: true, utils: stub, msgLimit: 14, question: 'x' });
        assert.strictEqual(stats.people[0].msgCount, 1);
        assert.strictEqual(stats.people[0].label, 'Fulano');
    });
    it('ownerAgent.findPerson resolve alias número→LID', async () => {
        const stub = { resolvePhoneLidInGroup: async () => LID };
        const p = await agent.findPerson({}, PHONE, { utils: stub, from: G });
        assert.strictEqual(p.jid, `${PHONE}@s.whatsapp.net`);
        assert.strictEqual(p.alias, LID);
    });
    it('ownerAgent.findPerson resolve alias LID→número', async () => {
        const stub = { resolveLidPhoneInGroup: async () => PHONE };
        const p = await agent.findPerson({}, '98765432109876', { utils: stub, from: G });
        assert.ok(p.jid.endsWith('@lid'));
        assert.strictEqual(p.alias, `${PHONE}@s.whatsapp.net`);
    });
});
