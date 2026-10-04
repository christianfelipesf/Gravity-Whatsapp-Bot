const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isola o banco: database/utils abre o SQLite no require.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guardiao-test-')), 'bot.db');
process.env.BOT_DB_PATH = tmpDb;

let utils;
let partial;
before(() => {
    utils = require('../../src/database/utils');
    partial = require('../../src/events/partial');
});

const GUARD = '5598989111222';
const SUB = '5598989133333';
const STRANGER = '5598989144444';

function pvSock() {
    return { user: { id: '5598989100000@s.whatsapp.net' } };
}
function pvMsg() {
    return { key: { fromMe: false }, message: {} };
}

describe('guardiao — helpers de dados', () => {
    it('exporta os helpers do guardião', () => {
        for (const fn of ['getGuardioes', 'isGuardiaoPhone', 'isGuardiaoSender', 'isGuardiaoSenderAsync', 'canGuardianActAsync', 'addGuardiao', 'removeGuardiao']) {
            assert.strictEqual(typeof utils[fn], 'function', fn);
        }
    });

    it('add/remove/list com duplicado e all', () => {
        assert.deepStrictEqual(utils.getGuardioes(), []);
        const r1 = utils.addGuardiao(GUARD);
        assert.strictEqual(r1.ok, true);
        assert.deepStrictEqual(utils.getGuardioes(), [GUARD]);
        assert.strictEqual(utils.isGuardiaoPhone(GUARD), true);
        assert.strictEqual(utils.isGuardiaoPhone(STRANGER), false);
        const dup = utils.addGuardiao(GUARD);
        assert.strictEqual(dup.ok, false);
        assert.strictEqual(dup.error, 'duplicado');
        utils.addGuardiao(SUB);
        assert.strictEqual(utils.getGuardioes().length, 2);
        const rm = utils.removeGuardiao(GUARD);
        assert.strictEqual(rm.ok, true);
        assert.deepStrictEqual(utils.getGuardioes(), [SUB]);
        const all = utils.removeGuardiao('all');
        assert.strictEqual(all.ok, true);
        assert.deepStrictEqual(utils.getGuardioes(), []);
    });

    it('DEFAULT_CONFIG inclui guardioes', () => {
        assert.ok(Array.isArray(utils.DEFAULT_CONFIG.guardioes));
    });
});

describe('guardiao — portões de acesso', () => {
    it('estranho é negado em tudo; dono passa', async () => {
        const denied = await utils.canGuardianActAsync(pvSock(), pvMsg(), `${STRANGER}@s.whatsapp.net`, '5511888888888@s.whatsapp.net');
        assert.strictEqual(denied.ok, false);
        const owner = await utils.canGuardianActAsync(pvSock(), { key: { fromMe: true }, message: {} }, 'any@s.whatsapp.net', 'x@s.whatsapp.net');
        assert.strictEqual(owner.ok, true);
        assert.strictEqual(owner.owner, true);
        // Regressão crítica: guardião NÃO passa em canConfigureBot (sem !set/chaves API)
        utils.addGuardiao(GUARD);
        const cfg = utils.canConfigureBot(pvSock(), pvMsg(), `${GUARD}@s.whatsapp.net`, '5511888888888@s.whatsapp.net');
        assert.strictEqual(cfg.ok, false);
    });

    it('guardião passa no portão próprio (guardiao:true, sem sub)', async () => {
        const r = await utils.canGuardianActAsync(pvSock(), pvMsg(), `${GUARD}@s.whatsapp.net`, '5511888888888@s.whatsapp.net');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.guardiao, true);
        assert.strictEqual(r.sub, false);
        assert.strictEqual(utils.isGuardiaoSender(pvSock(), pvMsg(), `${GUARD}@s.whatsapp.net`, 'x@s.whatsapp.net').ok, true);
    });

    it('subdono continua passando no portão do guardião (compat)', async () => {
        const cfg = utils.readConfig();
        utils.writeConfig({ ...cfg, subOwners: [SUB] });
        const r = await utils.canGuardianActAsync(pvSock(), pvMsg(), `${SUB}@s.whatsapp.net`, '5511888888888@s.whatsapp.net');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.sub, true);
        // ...mas subdono segue com !set (canConfigureBot intacto)
        assert.strictEqual(utils.canConfigureBot(pvSock(), pvMsg(), `${SUB}@s.whatsapp.net`, 'x@s.whatsapp.net').ok, true);
        utils.writeConfig({ ...utils.readConfig(), subOwners: [] });
    });

    it('fallback LID->telefone via metadata do grupo', async () => {
        const sock = {
            user: { id: '5598989100000@s.whatsapp.net' },
            groupMetadata: async () => ({
                participants: [{ id: '123456@lid', phoneNumber: `${GUARD}@s.whatsapp.net` }]
            })
        };
        const m = { key: { fromMe: false }, message: {} };
        const r = await utils.canGuardianActAsync(sock, m, '123456@lid', '99999@g.us');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.guardiao, true);
    });
});

describe('guardiao — entradas legadas em LID', () => {
    it('LID salvo casa com remetente @lid (compat)', () => {
        const LID = '151059083309097';
        assert.strictEqual(utils.addGuardiao(LID).ok, true);
        const m = { key: { fromMe: false, participant: `${LID}@lid` }, message: {} };
        const r = utils.isGuardiaoSender(pvSock(), m, `${LID}@lid`, '5511888888888@g.us');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.guardiao, true);
        assert.strictEqual(utils.removeGuardiao(LID).ok, true);
    });

    it('getSenderLids extrai dígitos do @lid', () => {
        const m = { key: { participant: '151059083309097@lid' }, message: {} };
        assert.deepStrictEqual(utils.getSenderLids(m, '151059083309097@lid'), ['151059083309097']);
        assert.deepStrictEqual(utils.getSenderLids(pvMsg(), '5511999999999@s.whatsapp.net'), []);
    });
});

describe('guardiao — modo parcial', () => {    it('gestão de guardiões é bloqueada no parcial', () => {
        for (const c of ['addguardiao', 'remguardiao', 'listguardioes', 'guardioes']) {
            assert.ok(
                partial.PARTIAL_BLOCKED_COMMANDS.has(c),
                `PARTIAL_BLOCKED_COMMANDS deveria conter ${c}`
            );
        }
    });
});
