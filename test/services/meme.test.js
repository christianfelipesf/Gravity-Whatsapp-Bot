const { describe, it } = require('node:test');
const assert = require('node:assert');
const memeStore = require('../../src/services/memeStore');

describe('memeStore puras', () => {
    it('sha256 determinístico e 64 hex', () => {
        const a = memeStore.sha256(Buffer.from('abc'));
        const b = memeStore.sha256(Buffer.from('abc'));
        assert.strictEqual(a, b);
        assert.match(a, /^[0-9a-f]{64}$/);
        assert.notStrictEqual(a, memeStore.sha256(Buffer.from('abd')));
    });

    it('formatDateBR formata pt-BR', () => {
        const ts = new Date(2026, 9, 6, 12, 0, 0).getTime();
        assert.strictEqual(memeStore.formatDateBR(ts), '06/10/2026');
        assert.strictEqual(memeStore.formatDateBR('x'), '—');
    });

    it('buildMemeCaption mostra origem (grupo onde foi postado)', () => {
        const cap = memeStore.buildMemeCaption(
            { id: 7, sender_name: 'Maria', sender_phone: '5515999999999', group_name: 'Família', created_at: new Date(2026, 9, 6).getTime() }
        );
        assert.ok(!cap.includes('#7'));
        assert.ok(!cap.includes('Meme'));
        assert.ok(cap.includes('Enviado por:'));
        assert.ok(cap.includes('Maria'));
        assert.ok(cap.includes('5515999999999'));
        assert.ok(cap.includes('Grupo:'));
        assert.ok(cap.includes('Família'));
        assert.ok(cap.includes('Data:'));
        assert.ok(cap.includes('06/10/2026'));
    });

    it('buildMemeCaption origem privado', () => {
        const cap = memeStore.buildMemeCaption(
            { sender_name: 'João', sender_phone: null, group_name: 'privado', created_at: new Date(2026, 9, 6).getTime() }
        );
        assert.ok(cap.includes('privado'));
    });

    it('extractPhone resolve @lid via participantPn', () => {
        const m = { key: { participantPn: '5515988887777@s.whatsapp.net' } };
        assert.strictEqual(memeStore.extractPhone('123@lid', m), '5515988887777');
        assert.strictEqual(memeStore.extractPhone('5515999999999@s.whatsapp.net', {}), '5515999999999');
        assert.strictEqual(memeStore.extractPhone('invalido', {}), null);
    });

    it('checkMemeGroupCooldown desativado — sempre liberado (sem delay)', () => {
        const jid = `teste-${Date.now()}@g.us`;
        assert.strictEqual(memeStore.checkMemeGroupCooldown(jid), 0);
        assert.strictEqual(memeStore.checkMemeGroupCooldown(jid), 0);
        assert.strictEqual(memeStore.MEME_GROUP_COOLDOWN_MS, 0);
    });
});

describe('comandos meme', () => {
    it('meme: nome/aliases/categoria', () => {
        const cmd = require('../../src/commands/meme');
        assert.strictEqual(cmd.name, 'meme');
        assert.ok(cmd.aliases.includes('memealeatorio'));
        assert.strictEqual(cmd.category, 'mídia');
    });
    it('postarmeme: aliases de cadastro', () => {
        const cmd = require('../../src/commands/postarmeme');
        assert.strictEqual(cmd.name, 'postarmeme');
        assert.ok(cmd.aliases.includes('novomeme'));
        assert.ok(cmd.aliases.includes('memenovo'));
    });
    it('delmeme: admin', () => {
        const cmd = require('../../src/commands/delmeme');
        assert.strictEqual(cmd.name, 'delmeme');
        assert.strictEqual(cmd.category, 'admin');
    });
});
