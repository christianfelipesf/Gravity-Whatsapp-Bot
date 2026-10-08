const { describe, it } = require('node:test');
const assert = require('node:assert');

const investigar = require('../../src/commands/investigar.js');
const investigartudo = require('../../src/commands/investigartudo.js');
const { resolveCommand, loadCommands } = require('../../src/commands/loader');
loadCommands();

function makeSock(inbox) {
    return {
        sendMessage: async (to, content) => { inbox.push(String(content?.text || '')); return {}; }
    };
}
function makeMsg(text) {
    return { key: { remoteJid: 'g1@g.us', fromMe: false }, pushName: 'Zé', message: { extendedTextMessage: { text, contextInfo: {} } } };
}
// utils de membro comum: SEM canConfigureBot/canGuardianActAsync
const memberUtils = {
    react: async () => 1,
    reactStatus: async () => 2,
    groupMetadataCached: async () => null,
    getMessagesBySender: () => [],
    getSenderName: () => null,
    getMessagesByPushName: () => [],
    getGroupData: () => ({}),
    getDashboardGroupInfo: () => null,
    listDashboardGroupInfos: () => [],
    getRecentLogs: () => []
};
const base = {
    from: 'g1@g.us', isGroup: true, sender: 'ze@s.whatsapp.net',
    config: { prefix: '!' }, utils: memberUtils, model: { generateContent: async () => ({ response: { text: () => 'nunca' } }) },
    lastBotResponse: 0, GLOBAL_COOLDOWN: 0, abortSignal: undefined, log: () => {}
};

describe('split investigar / investigartudo', () => {
    it('loader resolve investigar + alias aidono/iadono', () => {
        assert.strictEqual(resolveCommand('investigar'), investigar);
        assert.strictEqual(resolveCommand('aidono'), investigar, 'aidono virou alias');
        assert.strictEqual(resolveCommand('iadono'), investigar);
        assert.strictEqual(resolveCommand('investigartudo'), investigartudo);
        assert.ok((investigar.aliases || []).includes('aidono'));
    });

    it('!investigar aberto: membro comum NÃO recebe negação de permissão', async () => {
        const inbox = [];
        await investigar.execute(makeSock(inbox), makeMsg('!investigar quais comandos rodaram?'), { ...base, fullArgsText: 'quais comandos rodaram?' });
        assert.ok(!inbox.some((t) => /apenas o dono/i.test(t)), 'não pode negar por permissão');
    });

    it('!investigartudo trancado: membro comum é negado sem IA', async () => {
        const inbox = [];
        let called = false;
        const model = { generateContent: async () => { called = true; return { response: { text: () => 'x' } }; } };
        await investigartudo.execute(makeSock(inbox), makeMsg('!investigartudo briga'), { ...base, model, fullArgsText: 'briga' });
        assert.strictEqual(called, false, 'não pode chamar IA de negado');
        assert.ok(inbox.some((t) => /apenas o dono, sub-donos ou guardiões/i.test(t)));
    });
});
