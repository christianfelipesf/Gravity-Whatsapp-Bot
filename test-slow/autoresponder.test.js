const { describe, it, after } = require('node:test');
const assert = require('node:assert');

const auto = require('../src/services/autoResponder');

const G = 'test-autoresponder-g@g.us';

after(() => {
    try { auto.disable(G); } catch (_) {}
    try {
        const { setGroupData } = require('../src/database/utils');
        setGroupData(G, { autoresponder: null, autoresponderCount: null, autoresponderLimit: null });
    } catch (_) {}
    try {
        const db = require('../src/database/db').db;
        db.prepare('DELETE FROM group_state WHERE jid = ?').run(G);
    } catch (_) {}
});

describe('autoresponder — estado por grupo', () => {
    it('começa desligado e liga/desliga com reset de contador', () => {
        auto.disable(G);
        assert.strictEqual(auto.isEnabled(G), false);
        auto.enable(G);
        assert.strictEqual(auto.isEnabled(G), true);
        const st = auto.getState(G);
        assert.strictEqual(st.count, 0);
        assert.ok(st.limit >= 3 && st.limit <= 5);
        auto.disable(G);
        assert.strictEqual(auto.isEnabled(G), false);
    });
});

describe('autoresponder — contador', () => {
    it('dispara ao atingir o limite', () => {
        assert.strictEqual(auto.shouldTriggerCounter(2, 3), false);
        assert.strictEqual(auto.shouldTriggerCounter(3, 3), true);
        assert.strictEqual(auto.shouldTriggerCounter(9, 5), true);
    });
});

describe('autoresponder — menção/reply direto', () => {
    const sock = { user: { id: '5511999999999:1@s.whatsapp.net' } };
    it('detecta menção ao bot', () => {
        const m = {
            message: { extendedTextMessage: { text: 'oi', contextInfo: { mentionedJid: ['5511999999999@s.whatsapp.net'] } } }
        };
        assert.strictEqual(auto.isDirectReply(sock, m), true);
    });
    it('detecta reply ao bot', () => {
        const m = {
            message: { extendedTextMessage: { text: 'oi', contextInfo: { participant: '5511999999999@s.whatsapp.net' } } }
        };
        assert.strictEqual(auto.isDirectReply(sock, m), true);
    });
    it('ignora mensagem normal', () => {
        const m = { message: { conversation: 'oi gente' } };
        assert.strictEqual(auto.isDirectReply(sock, m), false);
    });
});

describe('autoresponder — personalidade automática sem moderação', () => {
    it('system proíbe moderar/censurar/moralizar e inventar fatos', () => {
        const sys = auto.buildSystemPrompt().toLowerCase();
        assert.ok(sys.includes('nunca modere') || sys.includes('nunca modera'));
        assert.ok(sys.includes('censur'));
        assert.ok(sys.includes('moral'));
        assert.ok(sys.includes('tom do grupo') || sys.includes('espelhe o tom'));
        assert.ok(sys.includes('invente'));
    });

    it('contexto em tiers 5/10/30 com a mensagem atual por último', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({ pushName: `U${i}`, text: `msg ${i}` }));
        const p = auto.buildTieredPrompt({ history, senderName: 'Zé', text: 'e aí?', botName: 'Bot' });
        assert.ok(p.includes('HISTÓRICO ANTIGO'));
        assert.ok(p.includes('CONTEXTO ANTERIOR'));
        assert.ok(p.includes('ASSUNTO ATUAL'));
        assert.ok(p.includes('MENSAGEM PARA RESPONDER'));
        assert.ok(p.indexOf('msg 19') < p.indexOf('MENSAGEM PARA RESPONDER'));
        // tiers: 5 atuais (msg 15-19), 10 contexto (msg 5-14), 5 antigas (msg 0-4)
        const atual = p.split('--- ASSUNTO ATUAL')[1];
        assert.ok(atual.includes('msg 15') && atual.includes('msg 19') && !atual.includes('msg 14'));
        const ctx = p.split('--- CONTEXTO ANTERIOR')[1].split('--- ASSUNTO ATUAL')[0];
        assert.ok(ctx.includes('msg 5') && ctx.includes('msg 14') && !ctx.includes('msg 15'));
    });

    it('material antigo limitado a 30 mensagens', () => {
        const history = Array.from({ length: 60 }, (_, i) => ({ pushName: `U${i}`, text: `msg ${i}` }));
        const p = auto.buildTieredPrompt({ history, senderName: 'Zé', text: 'e aí?', botName: 'Bot' });
        const old = p.split('--- HISTÓRICO ANTIGO')[1].split('--- CONTEXTO ANTERIOR')[0];
        // janela total 45: msg 15-59; antigas = msg 15-44 (30 msgs)
        assert.ok(old.includes('msg 15') && old.includes('msg 44'));
        assert.ok(!old.includes('msg 14') && !old.includes('msg 45'));
    });

    it('limpa eco "Nome: fala" e recusa vira silêncio', () => {
        assert.strictEqual(auto.cleanReply('Zé: e aí?\nZé: tudo bem?'), 'Zé: e aí?');
        assert.strictEqual(auto.cleanReply('Desculpe, não posso continuar com isso'), '');
        assert.strictEqual(auto.cleanReply(''), '');
    });

    it('corta em 30 palavras', () => {
        const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
        const out = auto.cleanReply(long);
        assert.ok(out.split(/\s+/).length <= 30);
    });
});

describe('autoresponder — split + emoji (Humanity Plus)', () => {
    it('mensagem curta não divide', () => {
        assert.deepStrictEqual(auto.splitMessage('e aí kkk'), ['e aí kkk']);
    });
    it('mensagem longa divide em 2-3 partes que remontam o original', () => {
        const long = 'mano, isso aí foi muito engraçado, mas falando sério agora porque o jogo ontem foi tenso e ninguém esperava aquele final maluco';
        const parts = auto.splitMessage(long);
        assert.ok(parts.length >= 2 && parts.length <= 3);
        assert.strictEqual(parts.join(' '), long.replace(/\s+/g, ' ').trim());
        for (const p of parts) assert.ok(p.length > 0);
    });
    it('extrai emoji final e ignora texto sem emoji', () => {
        assert.strictEqual(auto.extractTrailingEmoji('kkk boa 💀'), '💀');
        assert.strictEqual(auto.extractTrailingEmoji('texto sem emoji'), null);
        assert.strictEqual(auto.extractTrailingEmoji(''), null);
    });
});

describe('autoresponder — roles assistant + delay distribuído', () => {
    it('falas do bot viram role assistant e última msg é user', () => {
        const history = [
            { pushName: 'Zé', text: 'e aí?' },
            { pushName: 'Bot', text: 'fala mano 😎' },
            { pushName: 'Ana', text: 'kkk' }
        ];
        const p = auto.buildTieredPrompt({ history, senderName: 'Zé', text: 'bora hoje?', botName: 'Bot' });
        const msgs = auto.toRoleMessages(p, 'Bot');
        const asst = msgs.filter((m) => m.role === 'assistant');
        assert.strictEqual(asst.length, 1);
        assert.ok(asst[0].content.includes('fala mano'));
        assert.strictEqual(msgs[msgs.length - 1].role, 'user');
        assert.ok(msgs[msgs.length - 1].content.includes('bora hoje?'));
    });
    it('sem falas do bot, tudo é user', () => {
        const p = auto.buildTieredPrompt({ history: [{ pushName: 'Zé', text: 'oi' }], senderName: 'Zé', text: 'oi', botName: 'Bot' });
        const msgs = auto.toRoleMessages(p, 'Bot');
        assert.ok(msgs.length > 0 && msgs.every((m) => m.role === 'user'));
    });
    it('delay cobre as 3 faixas (rápido/médio/lento)', () => {
        const seen = { fast: 0, mid: 0, slow: 0 };
        for (let i = 0; i < 500; i++) {
            const d = auto.getReadDelay();
            assert.ok(d >= 200 && d <= 10000, `delay fora da faixa: ${d}`);
            if (d < 800) seen.fast++;
            else if (d < 3500) seen.mid++;
            else seen.slow++;
        }
        assert.ok(seen.fast > 0 && seen.mid > 0 && seen.slow > 0);
    });
    it('resumo entra no prompt quando existe', () => {
        const p = auto.buildTieredPrompt({ history: [], senderName: 'Zé', text: 'oi', botName: 'Bot', summary: 'futebol e churrasco' });
        assert.ok(p.includes('RESUMO DO ASSUNTO') && p.includes('futebol e churrasco'));
    });
});

describe('autoresponder — resumo do assunto', () => {
    const G2 = 'test-autoresponder-sum@g.us';
    after(() => {
        try {
            const { setGroupData } = require('../src/database/utils');
            setGroupData(G2, { autoresponder: null, autoresponderCount: null, autoresponderLimit: null, topicSummary: null });
        } catch (_) {}
        try {
            const db = require('../src/database/db').db;
            db.prepare('DELETE FROM group_state WHERE jid = ?').run(G2);
            db.prepare('DELETE FROM messages WHERE jid = ?').run(G2);
        } catch (_) {}
    });
    it('grava resumo após 5 respostas (fake model)', async () => {
        const utils = require('../src/database/utils');
        for (let i = 0; i < 6; i++) utils.saveMessage(G2, `U${i}`, `mensagem teste ${i} sobre futebol`);
        const fakeModel = { generateChat: async () => ({ text: 'futebol no grupo' }) };
        for (let i = 0; i < 4; i++) {
            await auto.maybeUpdateSummary(G2, fakeModel);
            assert.strictEqual(auto.getSummary(G2), '');
        }
        await auto.maybeUpdateSummary(G2, fakeModel);
        assert.strictEqual(auto.getSummary(G2), 'futebol no grupo');
    });
    it('frases de follow-up existem e são curtas', () => {
        assert.ok(Array.isArray(auto.FOLLOW_UP_PHRASES) && auto.FOLLOW_UP_PHRASES.length >= 6);
        for (const f of auto.FOLLOW_UP_PHRASES) assert.ok(String(f).length <= 20);
    });
});

describe('autoresponder — comando registrado', () => {    it('carrega via loader com aliases', () => {
        const { resolveCommand } = require('../src/commands/loader');
        // loader pode ainda não ter rodado neste processo de teste
        try { require('../src/commands/loader').loadCommands({ verbose: false }); } catch (_) {}
        const cmd = resolveCommand('autoresponder');
        assert.ok(cmd && cmd.name === 'autoresponder');
        assert.ok((cmd.aliases || []).includes('autoresposta'));
    });
});
