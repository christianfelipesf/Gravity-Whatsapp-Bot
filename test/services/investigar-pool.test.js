const { describe, it } = require('node:test');
const assert = require('node:assert');

const ev = require('../../src/services/ownerEvidence');
const agent = require('../../src/services/ownerAgent');

// 500 msgs distribuídas em 6 dias (01/10 -> 06/10/2026 em BRT; base meio-dia UTC p/ não cair no dia anterior)
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);
const BIG = Array.from({ length: 500 }, (_, i) => ({
    text: `msg ${i}`, name: 'Well', timestamp: T0 + Math.floor((i / 499) * 5 * DAY)
}));

const stubUtils = {
    normalizeJid: (j) => j,
    getMessagesBySender: () => BIG,
    getSenderName: () => 'Well',
    getMessagesByPushName: () => [],
    findMessagesByNameLike: () => [],
    getGroupData: () => ({}),
    getDashboardGroupInfo: () => null,
    listDashboardGroupInfos: () => [],
    getRecentLogs: () => [],
    getGroupSubject: () => null,
    groupMetadataCached: async () => null
};

describe('!investigar — pool cheio, exibição amostrada', () => {
    it('perfil: 500 no pool, 30 exibidas, span da janela toda', async () => {
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: 'u@lid', alias: null }], groups: []
        }, { from: null, isGroup: false, utils: stubUtils, msgLimit: 20, question: 'o que acha do Well?' });
        const p = stats.people[0];
        assert.strictEqual(p.windowTotal, 500, 'pool não pode ser capado antes de amostrar');
        assert.strictEqual(p.msgCount, 30, 'exibição continua curta');
        assert.ok(p.sampled);
        assert.ok(/30 de 500/.test(text), 'header anuncia amostra honesta');
        assert.ok(/01\/10.*06\/10/.test(text), 'span cobre a janela toda, não só o recente');
    });

    it('normal: 500 no pool, 20 mais recentes exibidas', async () => {
        const { stats } = await ev.buildEvidence({}, {
            people: [{ jid: 'u@lid', alias: null }], groups: []
        }, { from: null, isGroup: false, utils: stubUtils, msgLimit: 20, question: 'investigar o well' });
        const p = stats.people[0];
        assert.strictEqual(p.windowTotal, 500);
        assert.strictEqual(p.msgCount, 20);
    });

    it('tool do agent anuncia total + intervalo honestos', async () => {
        const utils2 = {
            ...stubUtils,
            findPeopleByName: undefined,
            getMessagesBySender: (a, b, lim) => BIG.slice(-Math.min(BIG.length, lim || 12)),
        };
        // findPerson usa utils.findPeopleByName — injeta hit direto
        utils2.findPeopleByName = () => [{ senderJid: 'u@lid', name: 'Well' }];
        const out = await agent.executeTool('buscar_mensagens_pessoa', { pessoa: 'Well', limite: 12 }, { sock: {}, from: null, utils: utils2 });
        assert.ok(/500 msgs/.test(out), 'tool deve anunciar o total do pool, não só as exibidas. Saída: ' + out.slice(0, 120));
        assert.ok(/01\/10.*06\/10/.test(out), 'tool deve anunciar o intervalo. Saída: ' + out.slice(0, 120));
    });
});
