const { describe, it } = require('node:test');
const assert = require('node:assert');

const ev = require('../../src/services/ownerEvidence');

// 2026-09-30 19:00 BRT (quarta). SP = UTC-3 fixo.
const NOW = Date.UTC(2026, 8, 30, 22, 0, 0);
const DAY = 24 * 3600 * 1000;
const H = 3600 * 1000;
// meia-noite SP de um dia (mês 0-based, dia): UTC = dayUtc + 3h
const spMid = (m, d) => Date.UTC(2026, m, d) + 3 * H;

describe('!investigar — janela de tempo (extractTimeRange)', () => {
    it('ontem', () => {
        const r = ev.extractTimeRange('o que o @fulano falou ontem?', NOW);
        assert.strictEqual(r.since, spMid(8, 29));
        assert.strictEqual(r.until, spMid(8, 29) + DAY - 1);
        assert.ok(r.label.includes('ontem') && r.label.includes('29/09'));
    });
    it('anteontem', () => {
        const r = ev.extractTimeRange('falou anteontem?', NOW);
        assert.strictEqual(r.since, spMid(8, 28));
        assert.ok(r.label.includes('anteontem'));
    });
    it('há 3 dias', () => {
        const r = ev.extractTimeRange('oq essa pessoa falou ha 3 dias', NOW);
        assert.strictEqual(r.since, spMid(8, 27));
        assert.strictEqual(r.until, spMid(8, 27) + DAY - 1);
        assert.ok(r.label.includes('3 dias') && r.label.includes('27/09'));
    });
    it('N dias atrás', () => {
        const r = ev.extractTimeRange('o que disse 2 dias atrás?', NOW);
        assert.strictEqual(r.since, spMid(8, 28));
    });
    it('hoje vai até agora', () => {
        const r = ev.extractTimeRange('o que falou hoje?', NOW);
        assert.strictEqual(r.since, spMid(8, 30));
        assert.strictEqual(r.until, NOW);
    });
    it('últimos N dias', () => {
        const r = ev.extractTimeRange('mensagens dos últimos 5 dias', NOW);
        assert.strictEqual(r.since, spMid(8, 26));
        assert.strictEqual(r.until, NOW);
        assert.ok(r.label.includes('5 dias'));
    });
    it('dia DD/MM', () => {
        const r = ev.extractTimeRange('o que rolou dia 20/09?', NOW);
        assert.strictEqual(r.since, spMid(8, 20));
        assert.ok(r.label.includes('20/09'));
    });
    it('nessa semana', () => {
        const r = ev.extractTimeRange('o que falou nessa semana?', NOW);
        assert.strictEqual(r.since, spMid(8, 24));
        assert.strictEqual(r.until, NOW);
    });
    it('essa hora estreita para ±3h', () => {
        const r = ev.extractTimeRange('o que falou há 3 dias essa hora?', NOW);
        assert.strictEqual(r.until - r.since, 6 * H);
        assert.ok(r.label.includes('por volta'));
    });
    it('sem data retorna null (opinião)', () => {
        assert.strictEqual(ev.extractTimeRange('o que acha dele?', NOW), null);
        assert.strictEqual(ev.extractTimeRange('quem fala mais?', NOW), null);
    });
});

describe('!investigar — comparação entre janelas', () => {
    it('extractAllTimeRanges acha ontem + hoje', () => {
        const all = ev.extractAllTimeRanges('o que ela falou ontem tem a ver com o que fala hoje?', NOW);
        assert.strictEqual(all.length, 2);
        assert.ok(all[0].label.includes('ontem'));
        assert.ok(all[1].label.includes('hoje'));
    });
    it('rangesForComparison completa com hoje ("mudou desde ontem?")', () => {
        const r = ev.rangesForComparison('será que ele mudou desde ontem?', NOW);
        assert.ok(r && r.length === 2);
        assert.ok(r[0].label.includes('ontem'));
        assert.ok(r[1].label.includes('hoje'));
    });
    it('rangesForComparison null sem comparação', () => {
        assert.strictEqual(ev.rangesForComparison('o que a Ana falou ontem?', NOW), null);
        assert.strictEqual(ev.rangesForComparison('o que acha dele?', NOW), null);
    });
    it('isComparison separa julgar de listar', () => {
        assert.ok(ev.isComparison('o que falou ontem tem a ver com hoje?'));
        assert.ok(ev.isComparison('comparar ontem e hoje'));
        assert.ok(ev.isComparison('mudou desde semana passada?'));
        assert.ok(!ev.isComparison('o que falou ontem?'));
        assert.ok(!ev.isComparison('o que acha dele?'));
    });
    it('buildComparisonEvidence funde as duas janelas', async () => {
        const stub = {
            normalizeJid: (j) => String(j || '').toLowerCase(),
            getGroupData: () => ({ warnings: {} }),
            getMessagesBySenderRange: (_jid, _al, since) => (since < spMid(8, 30)
                ? [{ text: 'fala de ontem', name: 'Ana', timestamp: since + 10 * H }]
                : [{ text: 'fala de hoje', name: 'Ana', timestamp: since + H }, { text: 'outra de hoje', name: 'Ana', timestamp: since + 2 * H }]),
        };
        const ranges = ev.rangesForComparison('o que a Ana falou ontem tem a ver com hoje?', NOW);
        const { text, stats } = await ev.buildComparisonEvidence({}, { people: [{ jid: '111@s.whatsapp.net', alias: null }], groups: [] },
            { from: null, isGroup: false, utils: stub, question: 'x', ranges });
        assert.ok(text.includes('JANELA 1'));
        assert.ok(text.includes('JANELA 2'));
        assert.ok(text.includes('fala de ontem'));
        assert.ok(text.includes('fala de hoje'));
        assert.strictEqual(stats.people[0].windowTotal, 3);
        assert.ok(stats.comparison);
    });
    it('matchFactual nunca julga comparação (vai p/ IA)', () => {
        const evidence = { text: 'x', stats: { timeRange: 'ontem × hoje', comparison: true, people: [{ label: 'Ana', windowTotal: 2, windowMsgs: [{ text: 'a', timestamp: 1, name: 'Ana' }], advs: [] }], groups: [] } };
        assert.strictEqual(ev.matchFactual('o que falou ontem tem a ver com hoje?', evidence, {}), null);
    });
});

describe('!investigar — fusão exato+aproximado (mergeMsgLists)', () => {
    const T0 = spMid(8, 30);
    it('dedupe dobra gravação (mesmo texto a 2s)', () => {
        const out = ev.mergeMsgLists(
            [{ text: 'oi', timestamp: T0 }],
            [{ text: 'oi', timestamp: T0 + 2000 }]
        );
        assert.strictEqual(out.length, 1);
    });
    it('preserva repetição real espaçada', () => {
        const out = ev.mergeMsgLists(
            [{ text: 'Chad.', timestamp: T0 }],
            [{ text: 'Chad.', timestamp: T0 + 60000 }, { text: 'Chad.', timestamp: T0 + 120000 }]
        );
        assert.strictEqual(out.length, 3);
    });
    it('ordena e descarta vazio', () => {
        const out = ev.mergeMsgLists(
            [{ text: 'b', timestamp: T0 + 10 }],
            [{ text: '  ', timestamp: T0 + 5 }, { text: 'a', timestamp: T0 }]
        );
        assert.deepStrictEqual(out.map((x) => x.text), ['a', 'b']);
    });
    it('buildEvidence soma fonte fina + fallback rico', async () => {
        const stub = {
            normalizeJid: (j) => String(j || '').toLowerCase(),
            getGroupData: () => ({ warnings: {} }),
            getMessagesBySender: () => [{ text: 'fala exata', name: 'Mel', timestamp: T0 }],
            getMessagesByPushName: (_gj, _pn) => [
                { jid: 'outro@g.us', push_name: 'Mel', text: 'fala antiga 1', time: T0 - 3600000 },
                { jid: 'outro@g.us', push_name: 'Mel', text: 'fala antiga 2', time: T0 - 1800000 }
            ],
        };
        const { text, stats } = await ev.buildEvidence({}, { people: [{ jid: '111@s.whatsapp.net', alias: null }], groups: [] },
            { from: 'g1@g.us', isGroup: true, utils: stub, msgLimit: 14, question: 'o que a Mel falou?' });
        assert.strictEqual(stats.people[0].windowTotal, 3);
        assert.ok(text.includes('fala antiga 1'));
        assert.ok(text.includes('fala exata'));
        assert.strictEqual(stats.people[0].approx, true);
    });
});

describe('!investigar — wantsSpoken separa fala de opinião', () => {
    it('fala vai no fast-path', () => {
        assert.ok(ev.wantsSpoken('o que a Ana falou ontem?'));
        assert.ok(ev.wantsSpoken('mostra as mensagens dele há 3 dias'));
    });
    it('opinião vai para a IA', () => {
        assert.ok(!ev.wantsSpoken('o que acha dele?'));
        assert.ok(!ev.wantsSpoken('resume essa pessoa'));
        assert.ok(!ev.wantsSpoken('quantas mensagens tem?'));
    });
});

describe('!investigar — evidência com janela + resposta direta', () => {
    const stub = {
        normalizeJid: (j) => String(j || '').toLowerCase(),
        getGroupData: () => ({ warnings: {} }),
        getMessagesBySenderRange: () => [
            { text: 'fala antiga', name: 'Ana', timestamp: spMid(8, 27) + 10 * H },
            { text: 'outra fala', name: 'Ana', timestamp: spMid(8, 27) + 11 * H }
        ],
    };
    const tr = ev.extractTimeRange('o que a Ana falou há 3 dias?', NOW);

    it('buildEvidence usa a janela e marca o texto', async () => {
        const { text, stats } = await ev.buildEvidence({}, { people: [{ jid: '111@s.whatsapp.net', alias: null }], groups: [] },
            { from: null, isGroup: false, utils: stub, msgLimit: 14, question: 'o que a Ana falou há 3 dias?', timeRange: tr });
        assert.ok(text.includes('Janela da pergunta'));
        assert.ok(text.includes('27/09'));
        assert.ok(text.includes('fala antiga'));
        assert.strictEqual(stats.timeRange, tr.label);
        assert.strictEqual(stats.people[0].windowTotal, 2);
    });

    it('matchFactual responde as falas sem IA', () => {
        const evidence = {
            text: 'x',
            stats: {
                timeRange: tr.label,
                people: [{ label: 'Ana', windowTotal: 2, windowMsgs: [
                    { text: 'fala antiga', timestamp: spMid(8, 27) + 10 * H, name: 'Ana' },
                    { text: 'outra fala', timestamp: spMid(8, 27) + 11 * H, name: 'Ana' }
                ], advs: [] }],
                groups: []
            }
        };
        const out = ev.matchFactual('o que a Ana falou há 3 dias?', evidence, {});
        assert.ok(out.includes('fala antiga'));
        assert.ok(out.includes('27/09'));
    });

    it('matchFactual devolve null p/ opinião (vai p/ IA)', () => {
        const evidence = { text: 'x', stats: { timeRange: tr.label, people: [{ label: 'Ana', windowTotal: 2, windowMsgs: [], advs: [] }], groups: [] } };
        assert.strictEqual(ev.matchFactual('o que acha da Ana?', evidence, {}), null);
    });
});
