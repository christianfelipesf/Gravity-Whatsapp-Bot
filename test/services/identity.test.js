const { describe, it } = require('node:test');
const assert = require('node:assert');

const identity = require('../../src/services/identity');

describe('identity — pure: dígitos e formato', () => {
    it('digitsOf extrai só dígitos sem domínio/sufixo', () => {
        assert.strictEqual(identity.digitsOf('5564993347663@s.whatsapp.net'), '5564993347663');
        assert.strictEqual(identity.digitsOf('151059083309097@lid'), '151059083309097');
        assert.strictEqual(identity.digitsOf('5511:12@s.whatsapp.net'), '5511');
        assert.strictEqual(identity.digitsOf('(64) 99334-7663'), '64993347663');
    });

    it('isLidJid / isPhoneJid distinguem domínio', () => {
        assert.strictEqual(identity.isLidJid('123@lid'), true);
        assert.strictEqual(identity.isLidJid('123@LID'), true);
        assert.strictEqual(identity.isLidJid('5511@s.whatsapp.net'), false);
        assert.strictEqual(identity.isPhoneJid('5511@s.whatsapp.net'), true);
        assert.strictEqual(identity.isPhoneJid('123@lid'), false);
    });

    it('formatPhoneDisplay formata BR e preserva resto com +', () => {
        assert.strictEqual(identity.formatPhoneDisplay('5564993347663'), '(64) 99334-7663');
        assert.strictEqual(identity.formatPhoneDisplay('5511987654321'), '(11) 98765-4321');
        assert.strictEqual(identity.formatPhoneDisplay('151059083309097'), '+151059083309097');
        assert.strictEqual(identity.formatPhoneDisplay(''), '');
    });

    it('cleanPersonName rejeita genéricos e números', () => {
        assert.strictEqual(identity.cleanPersonName('Tommy'), 'Tommy');
        assert.strictEqual(identity.cleanPersonName('~pastor david '), 'pastor david');
        assert.strictEqual(identity.cleanPersonName('Usuário'), null);
        assert.strictEqual(identity.cleanPersonName('151059083309097'), null);
        assert.strictEqual(identity.cleanPersonName(null), null);
    });
});

describe('identity — extração da mensagem (sem rede)', () => {
    it('senderPhonesFromMessage pega Pn e ignora @lid puro', () => {
        const m = { key: { participantPn: '5564993347663@s.whatsapp.net' }, message: {} };
        assert.deepStrictEqual(identity.senderPhonesFromMessage(m, '151059083309097@lid', 'x@g.us'), ['5564993347663']);
    });

    it('senderLidsFromMessage extrai @lid', () => {
        const m = { key: { participant: '151059083309097@lid' }, message: {} };
        assert.deepStrictEqual(identity.senderLidsFromMessage(m, '151059083309097@lid'), ['151059083309097']);
        assert.deepStrictEqual(identity.senderLidsFromMessage({ key: {}, message: {} }, '5511@s.whatsapp.net'), []);
    });

    it('messageAliasKeys junta tudo sem rede', () => {
        const m = { key: { participant: '151059083309097@lid', participantPn: '5564993347663@s.whatsapp.net' }, message: {} };
        const k = identity.messageAliasKeys(m, '151059083309097@lid');
        assert.ok(k.jids.includes('151059083309097@lid'));
        assert.ok(k.jids.includes('5564993347663@s.whatsapp.net'));
        assert.deepStrictEqual(k.phones, ['5564993347663']);
        assert.deepStrictEqual(k.lids, ['151059083309097']);
    });
});

describe('identity — listas e moderação (puro)', () => {
    it('healPhoneList troca LID por telefone sem duplicar', () => {
        const map = new Map([['LID1', '5511999999999']]);
        assert.deepStrictEqual(
            identity.healPhoneList(['LID1', '5511999999999', '5521888888888'], map),
            { next: ['5511999999999', '5521888888888'], changed: true }
        );
        assert.deepStrictEqual(
            identity.healPhoneList(['5511999999999'], new Map()),
            { next: ['5511999999999'], changed: false }
        );
    });

    it('warnCount lê o máximo; warnSetAll grava em todas', () => {
        const w = { 'a@s.whatsapp.net': 1, 'b@lid': 2 };
        assert.strictEqual(identity.warnCount(w, ['a@s.whatsapp.net', 'b@lid']), 2);
        assert.strictEqual(identity.warnCount(w, ['c@lid']), 0);
        identity.warnSetAll(w, ['a@s.whatsapp.net', 'b@lid'], 3);
        assert.strictEqual(w['a@s.whatsapp.net'], 3);
        assert.strictEqual(w['b@lid'], 3);
        identity.warnDeleteAll(w, ['a@s.whatsapp.net', 'b@lid']);
        assert.deepStrictEqual(w, {});
    });

    it('groupsForSearch prioriza o atual e limita', () => {
        const utils = { listActiveGroups: () => ['g1@g.us', 'g2@g.us', 'pv@s.whatsapp.net'] };
        assert.deepStrictEqual(identity.groupsForSearch(utils, 'cur@g.us', 10), ['cur@g.us', 'g1@g.us', 'g2@g.us']);
        assert.deepStrictEqual(identity.groupsForSearch(null, 'cur@g.us', 10), ['cur@g.us']);
    });
});

describe('identity — resolução com sock mockado', () => {
    const phone = '5564993347663';
    const lid = '151059083309097';
    const sock = {
        groupMetadata: async () => ({
            participants: [{ id: `${lid}@lid`, lid: `${lid}@lid`, phoneNumber: `${phone}@s.whatsapp.net`, notify: 'Tommy' }]
        })
    };
    const utils = require('../../src/database/utils');

    it('resolveCandidateToPhone converte @lid em telefone', async () => {
        const r = await identity.resolveCandidateToPhone(sock, utils, `${lid}@lid`, 'g@g.us');
        assert.strictEqual(r.phone, phone);
        assert.strictEqual(r.resolvedFromLid, true);
    });

    it('resolveCandidateToPhone mantém telefone genuíno', async () => {
        const r = await identity.resolveCandidateToPhone(sock, utils, '5511987654321', 'g@g.us');
        assert.strictEqual(r.phone, '5511987654321');
        assert.strictEqual(r.resolvedFromLid, false);
    });

    it('targetKeys retorna telefone+LID', async () => {
        const k = await identity.targetKeys(sock, utils, 'g@g.us', `${lid}@lid`);
        assert.strictEqual(k.phone, phone);
        assert.ok(k.all.includes(`${phone}@s.whatsapp.net`));
        assert.ok(k.all.includes(`${lid}@lid`));
        assert.strictEqual(k.primary, `${phone}@s.whatsapp.net`);
    });

    it('displayPerson mostra nome + telefone, sem LID cru', async () => {
        const d = await identity.displayPerson(sock, utils, 'g@g.us', lid, new Map());
        assert.strictEqual(d.name, 'Tommy');
        assert.strictEqual(d.phone, phone);
        assert.ok(!d.lines.join(' ').includes(lid));
    });

    it('personLabel nunca vaza LID', async () => {
        const label = await identity.personLabel(sock, utils, 'g@g.us', `${lid}@lid`);
        assert.strictEqual(label, 'Tommy');
    });
});
