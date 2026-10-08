const { describe, it } = require('node:test');
const assert = require('node:assert');

const adminGroups = require('../../src/services/adminGroups');
const sortear = require('../../src/commands/sortear.js');

const BOT_PN = '5511999999999@s.whatsapp.net';
const BOT_LID = '172684226912308@lid';
const G = 'grupo@g.us';

// Bot aparece SÓ como LID nos admins, mas sock.user.id é o número:
// o getBotJid legado diria "não admin" — o robusto tem que achar.
function metaWithBotAs(botId, botAdmin = 'admin') {
    return {
        subject: 'Hellshitpost',
        participants: [
            { id: botId, admin: botAdmin },
            { id: '11111111111@s.whatsapp.net', notify: 'Alice' },
            { id: '22222222222@lid', notify: 'Beto' },
        ]
    };
}
const sockPN = { user: { id: BOT_PN, lid: BOT_LID } }; // sessão real tem id + lid

describe('adminGroups — detecção robusta de admin', () => {
    it('acha o bot admin via LID mesmo com sock.user.id em número', () => {
        assert.strictEqual(adminGroups.isBotAdminInMeta(metaWithBotAs(BOT_LID), sockPN), true);
    });
    it('acha o bot admin via número', () => {
        assert.strictEqual(adminGroups.isBotAdminInMeta(metaWithBotAs(BOT_PN), sockPN), true);
    });
    it('não-admin continua não-admin', () => {
        assert.strictEqual(adminGroups.isBotAdminInMeta(metaWithBotAs(BOT_LID, null), sockPN), false);
    });
    it('sem nenhuma identidade em comum não força admin', () => {
        const stranger = { user: { id: '99999999999@s.whatsapp.net', lid: '99999999999999@lid' } };
        assert.strictEqual(adminGroups.isBotAdminInMeta(metaWithBotAs(BOT_LID), stranger), false);
    });
    it('metadata vazio não é admin (não conta como sem-admin à toa)', () => {
        assert.strictEqual(adminGroups.isBotAdminInMeta({ subject: 'X', participants: [] }, sockPN), false);
    });
    it('checkGroup marca alcançável + admin + assunto', async () => {
        const meta = metaWithBotAs(BOT_LID);
        const utils = { groupMetadataCached: async () => meta, botIsAdmin: async () => false };
        const info = await adminGroups.checkGroup(sockPN, G, utils);
        assert.strictEqual(info.reachable, true);
        assert.strictEqual(info.admin, true, 'robusto vence o legado');
        assert.strictEqual(info.subject, 'Hellshitpost');
        assert.strictEqual(info.memberCount, 3);
    });
    it('checkGroup inacessível não finge nada', async () => {
        const utils = { groupMetadataCached: async () => ({ subject: 'Grupo', participants: [] }), botIsAdmin: async () => false };
        const info = await adminGroups.checkGroup(sockPN, G, utils);
        assert.strictEqual(info.reachable, false);
        assert.strictEqual(info.admin, false);
    });
    it('listCandidateGroupJids une fontes e filtra', async () => {
        const sock = { groupFetchAllParticipating: async () => ({ [G]: {}, 'x@s.whatsapp.net': {} }) };
        const utils = {
            listActiveGroups: () => [G, 'outro@g.us'],
            listPartialGroups: () => [],
            listNewsGroups: () => [],
            listDashboardGroupInfos: () => [{ jid: 'dash@g.us' }]
        };
        const jids = await adminGroups.listCandidateGroupJids(sock, utils);
        assert.ok(jids.includes(G) && jids.includes('outro@g.us') && jids.includes('dash@g.us'));
        assert.ok(!jids.includes('x@s.whatsapp.net'));
        assert.strictEqual(new Set(jids).size, jids.length, 'sem duplicar');
    });
});

describe('!sortear — comando', () => {
    it('nome/aliases/categoria', () => {
        assert.strictEqual(sortear.name, 'sortear');
        assert.ok(sortear.aliases.includes('aleatorio'));
        assert.ok(sortear.aliases.includes('sorteio'));
        assert.strictEqual(sortear.category, 'geral');
    });

    function makeCtx(meta) {
        const inbox = [];
        const sock = {
            user: { id: BOT_PN },
            sendMessage: async (to, content) => { inbox.push(content); return {}; },
            groupMetadata: async () => meta,
            profilePictureUrl: async () => { throw new Error('sem foto'); }
        };
        const utils = {
            react: async () => 1,
            groupMetadataCached: async () => meta,
            resolveLidPhoneInGroup: async () => null,
            getSenderName: () => null,
        };
        return { inbox, sock, utils };
    }

    it('sorteia membro (nunca o bot) com grupo/nome/número', async () => {
        const meta = {
            subject: 'Hellshitpost',
            participants: [
                { id: BOT_PN, admin: 'admin' },
                { id: '11111111111@s.whatsapp.net', notify: 'Alice' },
            ]
        };
        // injeta grupo admin direto (sem rede)
        const ag = require('../../src/services/adminGroups');
        const orig = ag.getAdminGroups;
        ag.getAdminGroups = async () => [{ jid: G, subject: 'Hellshitpost', memberCount: 2 }];
        try {
            const { inbox, sock, utils } = makeCtx(meta);
            const m = { key: {}, pushName: 'Zé' };
            await sortear.execute(sock, m, {
                from: G, config: { prefix: '!' }, utils,
                lastBotResponse: 0, GLOBAL_COOLDOWN: 0
            });
            const sent = inbox[0];
            const text = sent.caption || sent.text || '';
            assert.ok(/Hellshitpost/.test(text), 'mostra o grupo. Saiu: ' + text);
            assert.ok(/Alice/.test(text), 'mostra o nome. Saiu: ' + text);
            assert.ok(/11111111111/.test(text), 'mostra o número. Saiu: ' + text);
            assert.ok(!text.includes('9999999999'), 'nunca sorteia o bot. Saiu: ' + text);
        } finally {
            ag.getAdminGroups = orig;
        }
    });

    it('sem grupos admin avisa', async () => {
        const ag = require('../../src/services/adminGroups');
        const orig = ag.getAdminGroups;
        ag.getAdminGroups = async () => [];
        try {
            const inbox = [];
            const sock = { user: { id: BOT_PN }, sendMessage: async (t, c) => { inbox.push(c); return {}; } };
            const utils = { react: async () => 1 };
            await sortear.execute(sock, { key: {} }, { from: G, config: {}, utils, lastBotResponse: 0, GLOBAL_COOLDOWN: 0 });
            assert.ok(/Nenhum grupo/i.test(inbox[0].text));
        } finally {
            ag.getAdminGroups = orig;
        }
    });
});
