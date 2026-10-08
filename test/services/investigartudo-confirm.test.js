const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const ownerAgent = require('../../src/services/ownerAgent');

function makeSock(inbox) {
    return {
        sendMessage: async (to, content) => { inbox.push(String(content?.text || '')); return {}; }
    };
}
const stubUtils = {
    canConfigureBot: () => ({ ok: true }),
    react: async () => 1,
    reactStatus: async () => 2,
    groupMetadataCached: async () => null
};
const base = {
    from: 'g1@g.us', isGroup: true, sender: 'dono@s.whatsapp.net',
    config: { prefix: '!' }, utils: stubUtils, model: {},
    lastBotResponse: 0, GLOBAL_COOLDOWN: 0, abortSignal: undefined, log: () => {}
};
function makeMsg(text) {
    return { key: { remoteJid: 'g1@g.us', fromMe: false }, pushName: 'Dono', message: { extendedTextMessage: { text, contextInfo: {} } } };
}

describe('!investigartudo — confirmação do modo pesado', () => {
    beforeEach(() => {
        // limpa pendências entre testes (mesma chave from::sender)
        delete require.cache[require.resolve('../../src/commands/investigartudo.js')];
    });

    it('pede confirmação e NÃO roda o loop', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        let called = false;
        const orig = ownerAgent.runInvestigativeLoop;
        ownerAgent.runInvestigativeLoop = async () => { called = true; return { answer: 'x', partial: false, usage: { rounds: 1 } }; };
        try {
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo briga no grupo'), { ...base, fullArgsText: 'briga no grupo' });
        } finally {
            ownerAgent.runInvestigativeLoop = orig;
        }
        assert.strictEqual(called, false, 'loop não pode rodar sem confirmação');
        assert.ok(inbox.some((t) => /confirmar investigação/i.test(t)), 'deve pedir confirmação');
        assert.ok(inbox.some((t) => /investigartudo sim/i.test(t)), 'deve explicar como confirmar');
    });

    it('!investigartudo sim executa a investigação pendente', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        const orig = ownerAgent.runInvestigativeLoop;
        let gotQuestion = null;
        ownerAgent.runInvestigativeLoop = async ({ question }) => { gotQuestion = question; return { answer: 'apurei Y', partial: false, usage: { rounds: 2 } }; };
        try {
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo briga'), { ...base, fullArgsText: 'briga' });
            assert.strictEqual(gotQuestion, null, 'nada ainda');
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo sim'), { ...base, fullArgsText: 'sim' });
        } finally {
            ownerAgent.runInvestigativeLoop = orig;
        }
        assert.strictEqual(gotQuestion, 'briga');
        assert.ok(inbox.some((t) => t.includes('apurei Y')), 'deve entregar a resposta');
    });

    it('!investigartudo não cancela sem rodar nada', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        let called = false;
        const orig = ownerAgent.runInvestigativeLoop;
        ownerAgent.runInvestigativeLoop = async () => { called = true; return { answer: 'x', partial: false, usage: {} }; };
        try {
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo z'), { ...base, fullArgsText: 'z' });
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo não'), { ...base, fullArgsText: 'não' });
        } finally {
            ownerAgent.runInvestigativeLoop = orig;
        }
        assert.strictEqual(called, false);
        assert.ok(inbox.some((t) => /cancelada/i.test(t)));
    });

    it('texto sem pendência vira nova pergunta (pede confirmação, não roda)', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        let called = false;
        const orig = ownerAgent.runInvestigativeLoop;
        ownerAgent.runInvestigativeLoop = async () => { called = true; return { answer: 'x', partial: false, usage: {} }; };
        try {
            // sender diferente = sem pendência: "sim" é tratado como novo alvo
            await fresh.execute(makeSock(inbox), makeMsg('!investigartudo sim'), { ...base, sender: 'outro@s.whatsapp.net', fullArgsText: 'sim' });
        } finally {
            ownerAgent.runInvestigativeLoop = orig;
        }
        assert.strictEqual(called, false, 'loop não pode rodar sem confirmação');
        assert.ok(inbox.some((t) => /confirmar investigação/i.test(t)), 'deve pedir confirmação para o novo alvo');
    });

    it('nega membro comum (sem dono/sub/guardião)', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        const noAccess = {
            ...stubUtils,
            canConfigureBot: () => ({ ok: false }),
            canGuardianActAsync: async () => ({ ok: false })
        };
        await fresh.execute(makeSock(inbox), makeMsg('!investigartudo briga'), { ...base, utils: noAccess, fullArgsText: 'briga' });
        assert.ok(inbox.some((t) => /apenas o dono, sub-donos ou guardiões/i.test(t)), 'deve negar membro comum');
    });

    it('guardião passa no gate', async () => {
        const fresh = require('../../src/commands/investigartudo.js');
        const inbox = [];
        const guardUtils = {
            ...stubUtils,
            canConfigureBot: () => ({ ok: false }),
            canGuardianActAsync: async () => ({ ok: true, guardiao: true })
        };
        await fresh.execute(makeSock(inbox), makeMsg('!investigartudo briga'), { ...base, utils: guardUtils, fullArgsText: 'briga' });
        assert.ok(inbox.some((t) => /confirmar investigação/i.test(t)), 'guardião deve chegar na confirmação');
    });
});
