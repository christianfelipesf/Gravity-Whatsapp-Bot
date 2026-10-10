const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isola o banco: database/utils abre o SQLite no require.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tag-test-')), 'bot.db');
process.env.BOT_DB_PATH = tmpDb;

let utils;
let tagReact;
let tagCmd;
let partial;
before(() => {
    utils = require('../../src/database/utils');
    tagReact = require('../../src/services/tagReact');
    tagCmd = require('../../src/commands/tag');
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
function mkMsg(fromMe = false) {
    return { key: { fromMe, remoteJid: 'x@g.us', id: 'MSG1' }, message: { conversation: 'oi' } };
}
function mkSock(sent = []) {
    return {
        user: { id: '5598989100000@s.whatsapp.net' },
        sendMessage: async (jid, content) => { sent.push(content); return {}; }
    };
}

describe('tag — config global', () => {
    it('DEFAULT_CONFIG inclui tagMode=false', () => {
        assert.strictEqual(utils.DEFAULT_CONFIG.tagMode, false);
    });

    it('isTagEnabled respeita o banco', () => {
        assert.strictEqual(tagReact.isTagEnabled(), false);
        const cfg = utils.readConfig();
        utils.writeConfig({ ...cfg, tagMode: true });
        assert.strictEqual(tagReact.isTagEnabled(), true);
        assert.strictEqual(utils.readConfig().tagMode, true);
        utils.writeConfig({ ...utils.readConfig(), tagMode: false });
        assert.strictEqual(tagReact.isTagEnabled(), false);
    });
});

describe('tag — emojis por cargo', () => {
    it('exporta os emojis certos', () => {
        assert.strictEqual(tagReact.TAG_OWNER_EMOJI, '🤡');
        assert.strictEqual(tagReact.TAG_GUARDIAN_EMOJI, '🦅');
    });

    it('dono -> 🤡, sub -> 🤡, guardião -> 🦅, estranho -> null', async () => {
        utils.addGuardiao(GUARD);
        const cfg = utils.readConfig();
        utils.writeConfig({ ...cfg, subOwners: [SUB] });

        const ownerEmoji = await tagReact.resolveTagEmoji(pvSock(), { key: { fromMe: true }, message: {} }, 'any@s.whatsapp.net', 'x@s.whatsapp.net');
        assert.strictEqual(ownerEmoji, '🤡');

        const subEmoji = await tagReact.resolveTagEmoji(pvSock(), pvMsg(), `${SUB}@s.whatsapp.net`, 'x@s.whatsapp.net');
        assert.strictEqual(subEmoji, '🤡');

        const guardEmoji = await tagReact.resolveTagEmoji(pvSock(), pvMsg(), `${GUARD}@s.whatsapp.net`, 'x@s.whatsapp.net');
        assert.strictEqual(guardEmoji, '🦅');

        const stranger = await tagReact.resolveTagEmoji(pvSock(), pvMsg(), `${STRANGER}@s.whatsapp.net`, 'x@s.whatsapp.net');
        assert.strictEqual(stranger, null);

        utils.writeConfig({ ...utils.readConfig(), subOwners: [] });
        utils.removeGuardiao(GUARD);
    });

    it('maybeTagReact não reage com tagMode off nem p/ estranho', async () => {
        utils.writeConfig({ ...utils.readConfig(), tagMode: false });
        const sent = [];
        const m = { key: { fromMe: false, remoteJid: 'g@g.us', id: 'A1' }, message: {} };
        const r1 = await tagReact.maybeTagReact(mkSock(sent), m, { from: 'g@g.us', sender: `${GUARD}@s.whatsapp.net` });
        assert.strictEqual(r1, false);
        assert.strictEqual(sent.length, 0);
    });

    it('maybeTagReact reage 🦅 p/ guardião com tagMode on', async () => {
        utils.addGuardiao(GUARD);
        utils.writeConfig({ ...utils.readConfig(), tagMode: true });
        const sent = [];
        const sock = mkSock(sent);
        const m = { key: { fromMe: false, remoteJid: 'g@g.us', id: 'A2' }, message: {} };
        const r = await tagReact.maybeTagReact(sock, m, { from: 'g@g.us', sender: `${GUARD}@s.whatsapp.net` });
        assert.strictEqual(r, true);
        assert.strictEqual(sent[0]?.react?.text, '🦅');
        utils.writeConfig({ ...utils.readConfig(), tagMode: false });
        utils.removeGuardiao(GUARD);
    });
});

describe('tag — comando !tag', () => {
    it('carrega com nome e aliases', () => {
        assert.strictEqual(tagCmd.name, 'tag');
        assert.ok(tagCmd.aliases.includes('tagmode'));
    });

    it('estranho é negado; guardião liga/desliga o global', async () => {
        utils.addGuardiao(GUARD);
        const sentS = [];
        await tagCmd.execute(mkSock(sentS), mkMsg(), {
            sender: `${STRANGER}@s.whatsapp.net`, args: ['on'], config: { prefix: '!' },
            utils, lastBotResponse: 0, GLOBAL_COOLDOWN: 0
        });
        assert.match(sentS[0]?.text || '', /Apenas o dono/);

        const sentOn = [];
        await tagCmd.execute(mkSock(sentOn), mkMsg(), {
            sender: `${GUARD}@s.whatsapp.net`, args: ['on'], config: { prefix: '!' },
            utils, lastBotResponse: 0, GLOBAL_COOLDOWN: 0
        });
        assert.strictEqual(utils.readConfig().tagMode, true);

        const sentOff = [];
        await tagCmd.execute(mkSock(sentOff), mkMsg(), {
            sender: `${GUARD}@s.whatsapp.net`, args: ['off'], config: { prefix: '!' },
            utils, lastBotResponse: 0, GLOBAL_COOLDOWN: 0
        });
        assert.strictEqual(utils.readConfig().tagMode, false);
        utils.removeGuardiao(GUARD);
    });

    it('bloqueado no modo parcial', () => {
        for (const c of ['tag', 'tagmode', 'tags']) {
            assert.ok(partial.PARTIAL_BLOCKED_COMMANDS.has(c), `deveria conter ${c}`);
        }
    });
});
