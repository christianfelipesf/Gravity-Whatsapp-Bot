// Fontes de evidência do !investigar contra banco TEMPORÁRIO (nunca toca no real).
process.env.BOT_DB_PATH = require('path').join(require('os').tmpdir(), `bot-test-investigar-${process.pid}.db`);

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const u = require('../../src/database/utils');
const ev = require('../../src/services/ownerEvidence');

const G = 'testinvestigar@g.us';
const JID = '999888777@lid';

after(() => {
    try { fs.unlinkSync(process.env.BOT_DB_PATH); } catch (_) {}
    for (const suf of ['-shm', '-wal', '-journal']) {
        try { fs.unlinkSync(process.env.BOT_DB_PATH + suf); } catch (_) {}
    }
});

describe('!investigar — fontes de evidência', () => {
    it('findPeopleByName acha nome nos logs de ação (sem precisar de chat)', () => {
        u.insertDashboardLog({ type: 'action', group: 'G', text: 'Comando executado: !s', name: 'Mika', toJid: G, senderJid: JID, timestamp: Date.now() });
        const hits = u.findPeopleByName('mik', 5);
        assert.ok(hits.some((h) => h.senderJid === JID), 'deve achar a Mika pelo nome');
        assert.strictEqual(u.getSenderName(JID), 'Mika');
    });

    it('fallback por push_name funciona sem log do painel', () => {
        u.saveMessage(G, 'Mika', 'oi gente, cheguei');
        u.saveMessage(G, 'Mika', 'alguém viu meu gato?');
        u.flushNow();
        assert.strictEqual(u.getMessagesBySender(JID, null, 10).length, 0, 'painel vazio confirma o cenário');
        const fb = u.getMessagesByPushName(G, 'Mika', 10);
        assert.strictEqual(fb.length, 2, 'fallback por nome deve achar as 2 msgs');
        const all = u.getGroupMessages(G, 10);
        assert.ok(all.length >= 2, 'histórico do grupo deve existir');
    });

    it('buildEvidence monta dossiê com fallback aproximado', async () => {
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: JID, alias: null }],
            groups: [{ jid: G, subject: 'Teste' }]
        }, { from: G, isGroup: true, utils: u, msgLimit: 12, question: 'o que acha?' });
        assert.strictEqual(stats.people[0].approx, true);
        assert.ok(stats.people[0].msgCount >= 2, 'deve trazer as msgs do fallback');
        assert.ok(text.includes('gato'), 'evidência deve conter o conteúdo real');
        assert.ok(text.includes('aproximado'), 'deve sinalizar aproximação');
    });

    it('grupo sem nada retorna vazio (sem inventar)', async () => {
        const { text, stats } = await ev.buildEvidence({}, {
            people: [], groups: [{ jid: 'vazio@g.us', subject: 'Vazio' }]
        }, { from: null, isGroup: false, utils: u, msgLimit: 5, question: 'clima?' });
        assert.strictEqual(stats.groups[0].msgCount, 0);
        assert.ok(!text.includes('aproximado'));
    });

    it('jidFromDigits: 14+ dígitos é LID, até 13 é telefone', () => {
        assert.strictEqual(ev.jidFromDigits('73680331751662'), '73680331751662@lid');
        assert.strictEqual(ev.jidFromDigits('5511974217874'), '5511974217874@s.whatsapp.net');
        assert.strictEqual(ev.jidFromDigits('123'), null);
    });

    it('resolveTargets manda 14 dígitos para @lid', async () => {
        const m = { message: { extendedTextMessage: { text: 'x', contextInfo: {} } } };
        const t = await ev.resolveTargets({}, m, 'info sobre @73680331751662', u, null);
        assert.ok(t.people.some((p) => p.jid === '73680331751662@lid'), 'LID, não telefone');
    });

    it('fuzzy acha "~ pastor david" buscando "~ David"', () => {
        u.saveMessage(G, '~ pastor david', 'fala galera do teste');
        u.flushNow();
        const rows = u.findMessagesByNameLike(G, '~ David', 10);
        assert.ok(rows.some((r) => r.text.includes('fala galera')), 'LIKE deve alcançar variação do nome');
    });

    it('findActivityName acha quem fala mas nunca usou comando', () => {
        u.updateMemberActivity(G, '555666777@lid', 'Fantasma');
        u.flushNow();
        const hit = u.findActivityName('555666777@lid');
        assert.ok(hit, 'deve achar pela atividade');
        assert.strictEqual(hit.name, 'Fantasma');
        assert.ok(hit.total >= 1);
        assert.ok(hit.groups.some((g) => g.jid === G));
        assert.strictEqual(u.findActivityName('000000000@lid'), null, 'desconhecido retorna null');
    });

    it('buildEvidence usa nome da atividade e sinaliza presença', async () => {
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: '555666777@lid', alias: null }], groups: []
        }, { from: G, isGroup: true, utils: u, msgLimit: 5, question: 'quem é?' });
        assert.strictEqual(stats.people[0].label, 'Fantasma');
        assert.ok(text.includes('aparece em'), 'presença deve constar na evidência');
        assert.ok(!text.includes('555666777'), 'jid nunca no prompt');
        assert.strictEqual(ev.evidenceIsEmpty(stats), false, 'presença conta como conteúdo');
    });

    it('caso real: LID + nome aproximado monta dossiê multi-grupo', async () => {        u.saveMessage('outro@g.us', '~ pastor david', 'mensagem de outro grupo');
        u.flushNow();
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: '99900011122233@lid', alias: null }], groups: []
        }, { from: G, isGroup: true, utils: u, msgLimit: 12, question: 'info?' });
        // sem nome nos logs -> sem fallback por nome -> vazio honesto, sem jid no texto
        assert.ok(!text.includes('99900011122233'), 'jid nunca no prompt');
    });

    it('linha de resolução liga número da pergunta à pessoa', async () => {
        const { text } = await ev.buildEvidence({}, {
            people: [{ jid: '99900011122233@lid', alias: null, nameHint: 'Zé' }], groups: []
        }, { from: G, isGroup: true, utils: u, msgLimit: 5, question: 'info?' });
        assert.ok(text.includes('Alvos da pergunta'), 'deve declarar o alvo resolvido');
        assert.ok(text.includes('Zé (identidade confirmada pelo bot)'));
        assert.ok(!text.includes('99900011122233'));
    });

    it('evidenceIsEmpty: vazio de verdade x com conteúdo', () => {
        assert.strictEqual(ev.evidenceIsEmpty({ people: [{ msgCount: 0, advs: [] }], groups: [] }), true);
        assert.strictEqual(ev.evidenceIsEmpty({ people: [{ msgCount: 3, advs: [] }], groups: [] }), false);
        assert.strictEqual(ev.evidenceIsEmpty({ people: [{ msgCount: 0, advs: ['1/3'] }], groups: [] }), false);
        assert.strictEqual(ev.evidenceIsEmpty({ people: [], groups: [] }), true);
        assert.strictEqual(ev.evidenceIsEmpty({ people: [], groups: [], logs: { errors: [{ text: 'x' }], commands: [] } }), false);
    });
});
