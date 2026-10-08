const { describe, it } = require('node:test');
const assert = require('node:assert');

const ev = require('../../src/services/ownerEvidence');

const stubUtils = {
    normalizeJid: (j) => String(j || '').toLowerCase(),
    listDashboardGroupInfos: () => [{ jid: 'g1@g.us', subject: 'Amigos' }],
    resolveLidPhoneInGroup: async () => null,
    getGroupData: () => ({ warnings: { '111@s.whatsapp.net': 2 } }),
    getDashboardGroupInfo: () => null,
    getTopMember: () => 'Ana',
    getMessagesBySender: () => [
        { text: 'bom dia', name: 'Ana', timestamp: 1700000000000 },
        { text: 'alguém viu meu gato?', name: 'Ana', timestamp: 1700000060000 }
    ],
    getMessagesByGroup: () => [
        { text: 'oi gente', name: 'Beto', senderJid: '222@s.whatsapp.net', timestamp: 1700000000000 }
    ],
    getRecentLogs: (type) => type === 'error'
        ? [{ text: '❌ toimg falhou: download-falhou', timestamp: 1700000100000 }]
        : [{ text: 'Comando executado: !s', timestamp: 1700000050000 }]
};

function fakeMsg({ mentioned = [], participant = null, pushName = null } = {}) {
    return { message: { extendedTextMessage: { text: '!investigar x', contextInfo: { mentionedJid: mentioned, participant, pushName } } } };
}

describe('ownerEvidence', () => {
    it('resolveTargets pega várias menções', async () => {
        const t = await ev.resolveTargets({}, fakeMsg({ mentioned: ['111@s.whatsapp.net', '222@s.whatsapp.net'] }), 'quem fala mais?', stubUtils, 'g1@g.us');
        assert.strictEqual(t.people.length, 2);
    });

    it('resolveTargets pega citado + número digitado', async () => {
        const t = await ev.resolveTargets({}, fakeMsg({ participant: '333@s.whatsapp.net', pushName: 'Cid' }), 'resume 5511999999999', stubUtils, null);
        const jids = t.people.map((p) => p.jid);
        assert.ok(jids.includes('333@s.whatsapp.net'));
        assert.ok(jids.includes('5511999999999@s.whatsapp.net'));
    });

    it('resolveTargets acha grupo pelo nome', async () => {
        const t = await ev.resolveTargets({}, fakeMsg(), 'como está o grupo amigos?', stubUtils, null);
        assert.strictEqual(t.groups.length, 1);
        assert.strictEqual(t.groups[0].jid, 'g1@g.us');
    });

    it('warningsOf acha adv independente do formato do jid', () => {
        assert.strictEqual(ev.warningsOf(stubUtils, 'g1@g.us', '111@s.whatsapp.net'), 2);
        assert.strictEqual(ev.warningsOf(stubUtils, 'g1@g.us', '999@s.whatsapp.net'), 0);
    });

    it('buildEvidence monta texto com advs e mensagens', async () => {
        const { text, stats } = await ev.buildEvidence({}, { people: [{ jid: '111@s.whatsapp.net', alias: null }], groups: [] }, { from: 'g1@g.us', isGroup: true, utils: stubUtils });
        assert.ok(text.includes('2/3'));
        assert.ok(text.includes('gato'));
        assert.strictEqual(stats.people[0].msgCount, 2);
    });

    it('matchFactual responde advs sem IA', () => {
        const evidence = { text: 'x', stats: { people: [{ jid: 'a', label: 'Ana', advs: ['2/3 (Amigos)'], msgCount: 2 }], groups: [] } };
        const ans = ev.matchFactual('quantas adv tem a Ana?', evidence, {});
        assert.ok(ans.includes('2/3'));
    });

    it('matchFactual retorna null para pergunta opinativa', () => {
        const evidence = { text: 'x', stats: { people: [{ jid: 'a', label: 'Ana', advs: [], msgCount: 1 }], groups: [] } };
        assert.strictEqual(ev.matchFactual('o que você acha da Ana?', evidence, {}), null);
    });

    it('wantsLogs detecta pergunta sobre logs', () => {
        assert.strictEqual(ev.wantsLogs('quais erros deram hoje?'), true);
        assert.strictEqual(ev.wantsLogs('quais comandos rodaram?'), true);
        assert.strictEqual(ev.wantsLogs('o que acha da Ana?'), false);
    });

    it('buildEvidence inclui logs quando perguntado', async () => {
        const { text, stats } = await ev.buildEvidence({}, { people: [], groups: [] }, { from: null, isGroup: false, utils: stubUtils, question: 'quais erros deram?' });
        assert.ok(text.includes('toimg falhou'));
        assert.strictEqual(stats.logs.errors.length, 1);
        assert.strictEqual(stats.logs.commands.length, 1);
    });

    it('matchFactual lista erros sem IA', () => {
        const evidence = { text: 'x', stats: { people: [], groups: [], logs: { errors: [{ when: 1, text: '❌ toimg falhou' }], commands: [] } } };
        const ans = ev.matchFactual('que erros deram?', evidence, {});
        assert.ok(ans.includes('toimg falhou'));
    });

    it('fallback agrega mensagens da pessoa em VÁRIOS grupos', async () => {        const multi = {
            ...stubUtils,
            getMessagesBySender: () => [],
            getSenderName: undefined,
            listDashboardGroupInfos: () => [{ jid: 'g1@g.us', subject: 'Amigos' }, { jid: 'g2@g.us', subject: 'Trabalho' }],
            getMessagesByPushName: (gj, pn) => gj === 'g1@g.us'
                ? [{ jid: 'g1@g.us', text: 'oi aqui', push_name: 'Ana', time: 1700000000000 }]
                : gj === 'g2@g.us'
                    ? [{ jid: 'g2@g.us', text: 'oi lá', push_name: 'Ana', time: 1700000100000 }]
                    : [{ jid: 'g9@g.us', text: 'oi pv', push_name: 'Ana', time: 1700000200000 }]
        };
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: '999@s.whatsapp.net', alias: null, nameHint: 'Ana' }], groups: []
        }, { from: 'g1@g.us', isGroup: true, utils: multi, msgLimit: 12, question: 'x' });
        assert.strictEqual(stats.people[0].msgCount, 2, 'soma grupo atual + escopo global');
        assert.ok(stats.people[0].groups.includes('Amigos'), 'grupos distintos listados');
        assert.strictEqual(stats.people[0].groups.length, 2, 'dois grupos distintos');
        assert.ok(text.includes('(Amigos)'), 'msgs marcadas por grupo');
    });
});
