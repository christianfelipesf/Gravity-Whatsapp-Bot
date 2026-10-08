const { describe, it } = require('node:test');
const assert = require('node:assert');

const ev = require('../../src/services/ownerEvidence');
const cmd = require('../../src/commands/investigar.js');

const LID = '86522200076318@lid';

describe('!investigar — jid nunca chega na IA', () => {
    it('safePersonLabel: nome humano passa, jid/LID vira tag', () => {
        assert.strictEqual(ev.safePersonLabel('Mika'), 'Mika');
        assert.strictEqual(ev.safePersonLabel('57 diabo Do Rj'), '57 diabo Do Rj');
        assert.strictEqual(ev.safePersonLabel('5511974217874'), '@5511974217874', 'telefone real o dono reconhece');
        assert.strictEqual(ev.safePersonLabel(LID), 'pessoa mencionada');
        assert.strictEqual(ev.safePersonLabel(LID, 'pessoa B'), 'pessoa B');
        assert.strictEqual(ev.safePersonLabel('86522200076318'), 'pessoa mencionada', 'dígitos longos (LID) viram tag');
        assert.strictEqual(ev.safePersonLabel(null), 'pessoa mencionada');
        assert.strictEqual(ev.personTag(0, 2), 'pessoa A');
        assert.strictEqual(ev.personTag(1, 2), 'pessoa B');
        assert.strictEqual(ev.personTag(0, 1), 'pessoa mencionada');
    });

    it('buildEvidence com pessoa desconhecida: sem jid no texto', async () => {
        const u = {
            normalizeJid: (j) => j,
            getMessagesBySender: () => [],
            getSenderName: () => null,
            getMessagesByPushName: () => [],
            getGroupData: () => ({}),
            getDashboardGroupInfo: () => null,
            listDashboardGroupInfos: () => []
        };
        const { text, stats } = await ev.buildEvidence({}, {
            people: [{ jid: LID, alias: null }], groups: []
        }, { from: null, isGroup: false, utils: u, msgLimit: 5, question: 'o que acha?' });
        assert.ok(!text.includes('86522200076318'), 'jid não pode vazar para o prompt');
        assert.ok(!text.includes('@lid'), 'domínio nunca aparece');
        assert.ok(text.includes('pessoa mencionada'));
        assert.strictEqual(stats.people[0].label, 'pessoa mencionada');
    });

    it('autores desconhecidos em grupo viram pessoa A/B, sem jid', async () => {
        const u = {
            getMessagesByGroup: () => [
                { text: 'oi', name: null, senderJid: '11111111111111@lid', timestamp: 1 },
                { text: 'opa', name: null, senderJid: '22222222222222@lid', timestamp: 2 },
                { text: 'de novo', name: null, senderJid: '11111111111111@lid', timestamp: 3 }
            ],
            getTopMember: () => null,
            getDashboardGroupInfo: () => null,
            listDashboardGroupInfos: () => []
        };
        const { text } = await ev.buildEvidence({}, {
            people: [], groups: [{ jid: 'g@g.us', subject: 'G' }]
        }, { from: null, isGroup: false, utils: u, msgLimit: 5, question: 'clima?' });
        assert.ok(!text.includes('@lid'), 'nenhum jid no texto');
        assert.ok(text.includes('pessoa A') && text.includes('pessoa B'), 'tags estáveis por autor');
        // mesmo autor = mesma tag
        const aCount = text.split('pessoa A').length - 1;
        assert.strictEqual(aCount, 2, 'autor repetido mantém a tag');
    });

    it('prompt final do comando: sem jid + com a regra anti-jid', async () => {
        delete require.cache[require.resolve('../../src/commands/investigar.js')];
        const fresh = require('../../src/commands/investigar.js');
        const inbox = [];
        let captured = null;
        const sock = { sendMessage: async (to, c) => { inbox.push(String(c?.text || '')); return {}; } };
        const utilsStub = {
            canConfigureBot: () => ({ ok: true }),
            react: async () => 1,
            reactStatus: async () => 2,
            normalizeJid: (j) => j,
            listDashboardGroupInfos: () => [],
            resolveLidPhoneInGroup: async () => null,
            groupMetadataCached: async () => null,
            getMessagesBySender: () => [{ text: 'bla', name: null, senderJid: LID, timestamp: 1 }],
            getSenderName: () => null,
            getMessagesByPushName: () => [],
            getGroupData: () => ({}),
            getDashboardGroupInfo: () => null,
            getMessagesByGroup: () => [],
            getGroupMessages: () => [],
            getTopMember: () => null
        };
        const modelStub = {
            generateContent: async (prompt) => { captured = String(prompt); return { response: { text: () => 'ok' } }; }
        };
        const m = {
            key: { remoteJid: 'g@g.us', fromMe: false }, pushName: 'Dono',
            message: { extendedTextMessage: { text: '!investigar x', contextInfo: { mentionedJid: [LID] } } }
        };
        await fresh.execute(sock, m, {
            from: 'g@g.us', isGroup: true, sender: 'dono@s.whatsapp.net',
            fullArgsText: 'o que acha?', config: { prefix: '!', aiMaxPromptLength: 2000 },
            utils: utilsStub, model: modelStub, lastBotResponse: 0, GLOBAL_COOLDOWN: 0, abortSignal: undefined, log: () => {}
        });
        assert.ok(captured, 'modelo deve ter sido chamado');
        assert.ok(!captured.includes('86522200076318'), 'prompt sem jid');
        assert.ok(/NUNCA os repita/i.test(captured), 'system com a regra anti-jid');
    });
});
