// Menu clicável do Telegram: reply_markup, callback_query e /help em botões.
// Rede isolada (axios.create stubado) — nenhum POST real.
process.env.TELEGRAM_BOT_TOKEN = 'test-token-menu';
process.env.TELEGRAM_CHAT_ID = '999';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const axios = require('axios');
const posts = [];
const _origCreate = axios.create;
axios.create = () => ({
    post: async (url, payload) => { posts.push([url, payload]); return { data: { ok: true, result: {} } }; },
    get: async () => ({ data: { ok: true, result: [] } })
});

const tg = require('../../src/services/telegramBot');

beforeEach(() => { posts.length = 0; });
after(() => { axios.create = _origCreate; });

function lastSend() {
    const found = [...posts].reverse().find(([u]) => u === '/sendMessage');
    return found ? found[1] : null;
}

describe('telegram menu clicável', () => {
    it('send() com buttons inclui reply_markup inline_keyboard', async () => {
        await tg.send('999', 'oi', { buttons: [[{ text: 'A', data: 'cmd:/status' }, { text: 'B', data: 'cmd:/qr' }]] });
        const p = lastSend();
        assert.ok(p, 'deve POSTar sendMessage');
        assert.deepStrictEqual(p.reply_markup, {
            inline_keyboard: [[
                { text: 'A', callback_data: 'cmd:/status' },
                { text: 'B', callback_data: 'cmd:/qr' }
            ]]
        });
    });

    it('send() sem buttons não manda reply_markup', async () => {
        await tg.send('999', 'oi');
        const p = lastSend();
        assert.ok(p);
        assert.strictEqual(p.reply_markup, undefined);
    });

    it('callback_data limitado a 64 bytes', async () => {
        await tg.send('999', 'oi', { buttons: [[{ text: 'X', data: 'cmd:/' + 'y'.repeat(100) }]] });
        const p = lastSend();
        assert.ok(p.reply_markup.inline_keyboard[0][0].callback_data.length <= 64);
    });

    it('/help vem com menu de botões', async () => {
        await tg.handleUpdate({ message: { chat: { id: 999 }, text: '/help' }, update_id: 1 });
        const p = lastSend();
        assert.ok(p, '/help deve responder');
        assert.ok(p.reply_markup && p.reply_markup.inline_keyboard.length >= 4, 'menu com linhas de botões');
        const allData = p.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
        assert.ok(allData.includes('cmd:/status'), 'atalho Status presente');
        assert.ok(allData.includes('cmd:/limparmortos'), 'atalho Limpar mortos presente');
    });

    it('clique em botão autorizado despacha o comando', async () => {
        await tg.handleUpdate({
            callback_query: { id: 'cq1', data: 'cmd:/qr', message: { message_id: 7, chat: { id: 999 } }, from: { id: 999 } },
            update_id: 2
        });
        assert.ok(posts.some(([u, p]) => u === '/answerCallbackQuery' && p.callback_query_id === 'cq1'), 'deve confirmar o clique');
        const p = lastSend();
        assert.ok(p && String(p.text).includes('QR STATUS'), 'clique deve executar /qr');
    });

    it('clique não autorizado não executa nada', async () => {
        const n0 = posts.length;
        await tg.handleUpdate({
            callback_query: { id: 'cq2', data: 'cmd:/restart', message: { message_id: 8, chat: { id: 666 } }, from: { id: 666 } },
            update_id: 3
        });
        assert.ok(!posts.slice(n0).some(([u]) => u === '/sendMessage'), 'intruso não recebe resposta de comando');
    });

    it('clique com data estranha é ignorado', async () => {
        const n0 = posts.length;
        await tg.handleUpdate({
            callback_query: { id: 'cq3', data: 'hello', message: { message_id: 9, chat: { id: 999 } }, from: { id: 999 } },
            update_id: 4
        });
        assert.ok(!posts.slice(n0).some(([u]) => u === '/sendMessage'), 'data sem cmd: não despacha');
    });

    it('/status vem com botões Atualizar/Logs/Menu', async () => {
        await tg.handleUpdate({ message: { chat: { id: 999 }, text: '/status' }, update_id: 5 });
        const p = lastSend();
        assert.ok(p && p.reply_markup, '/status deve ter botões');
        const labels = p.reply_markup.inline_keyboard.flat().map((b) => b.text).join(' ');
        assert.ok(labels.includes('Atualizar') && labels.includes('Menu'), 'botões esperados: ' + labels);
    });
});
