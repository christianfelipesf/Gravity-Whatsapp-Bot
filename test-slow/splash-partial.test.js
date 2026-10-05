const { describe, it, after } = require('node:test');
const assert = require('node:assert');

const splash = require('../src/services/splash.js');
const partial = require('../src/events/partial.js');

const G_PARCIAL = 'test-splash-parcial-g@g.us';
const G_TOTAL = 'test-splash-total-g@g.us';

function citedCommands(text) {
    const out = new Set();
    const re = /!([a-zà-ú0-9_-]+)/gi;
    let m;
    while ((m = re.exec(String(text || '')))) out.add(m[1].toLowerCase());
    return out;
}

// Luminância relativa WCAG (sRGB) p/ checar contraste do card amarelo.
function luminance(hex) {
    const n = String(hex || '').replace('#', '');
    const c = [0, 2, 4].map(i => {
        const v = parseInt(n.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}

after(() => {
    try {
        const db = require('../src/database/db').db;
        db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(G_PARCIAL);
        db.prepare('DELETE FROM active_groups WHERE jid = ?').run(G_PARCIAL);
        db.prepare('DELETE FROM active_groups_partial WHERE jid = ?').run(G_TOTAL);
        db.prepare('DELETE FROM active_groups WHERE jid = ?').run(G_TOTAL);
    } catch (_) {}
    try { delete require('../src/services/splash.js')._counters.get(G_PARCIAL); } catch (_) {}
    try { delete require('../src/services/splash.js')._counters.get(G_TOTAL); } catch (_) {}
});

describe('splash parcial — pool filtrado', () => {
    it('pool parcial existe e tem volume mínimo', () => {
        assert.ok(Array.isArray(splash.CURIOSIDADES_PARCIAL), 'deveria exportar CURIOSIDADES_PARCIAL');
        assert.ok(splash.CURIOSIDADES_PARCIAL.length >= 10, `pool parcial pequeno: ${splash.CURIOSIDADES_PARCIAL.length}`);
    });

    it('pool parcial NÃO cita nenhum comando bloqueado no parcial', () => {
        const fails = [];
        for (const item of splash.CURIOSIDADES_PARCIAL) {
            for (const cmd of citedCommands(item)) {
                if (partial.PARTIAL_BLOCKED_COMMANDS.has(cmd)) fails.push(`!${cmd} em: ${String(item).slice(0, 60)}`);
            }
        }
        assert.strictEqual(fails.length, 0, `comandos bloqueados no pool parcial:\n${fails.join('\n')}`);
    });

    it('pool parcial cobre os comandos do parcial (mídia/interação/tts/statusp)', () => {
        const all = splash.CURIOSIDADES_PARCIAL.join('\n').toLowerCase();
        for (const cmd of ['!s', '!play', '!toimg', '!tts', '!statusp', '!revelar', '!abraco']) {
            assert.ok(all.includes(cmd), `pool parcial deveria citar ${cmd}`);
        }
    });

    it('pool parcial não sugere !menu (bloqueado no parcial)', () => {
        const all = splash.CURIOSIDADES_PARCIAL.join('\n').toLowerCase();
        assert.ok(!all.includes('!menu'), 'pool parcial não pode sugerir !menu');
    });
});

describe('splash parcial — caption e seleção de pool', () => {
    it('caption parcial sugere !statusp e não cita !menu', () => {
        const cap = splash.buildCaption('curiosidade teste', '!', 'Bot', { parcial: true });
        assert.ok(cap.includes('!statusp'), 'caption parcial deveria sugerir !statusp');
        assert.ok(!cap.includes('!menu'), 'caption parcial não pode citar !menu');
        assert.ok(cap.includes('MODO PARCIAL'), 'caption parcial deveria marcar MODO PARCIAL');
    });

    it('caption padrão continua sugerindo !menu (compatibilidade)', () => {
        const cap = splash.buildCaption('curiosidade teste', '!', 'Bot');
        assert.ok(cap.includes('!menu'), 'caption padrão deveria sugerir !menu');
        assert.ok(!cap.includes('!statusp'), 'caption padrão não deveria citar !statusp');
    });

    it('pickNext usa pool parcial em grupo parcial e pool total no resto', () => {
        const utils = require('../src/database/utils.js');
        assert.strictEqual(utils.activatePartial(G_PARCIAL), true);
        const seen = new Set();
        for (let i = 0; i < splash.CURIOSIDADES_PARCIAL.length + 2; i++) seen.add(splash.pickNext(G_PARCIAL));
        const poolSet = new Set(splash.CURIOSIDADES_PARCIAL);
        for (const s of seen) assert.ok(poolSet.has(s), `fora do pool parcial: ${String(s).slice(0, 60)}`);
        const total = splash.pickNext(G_TOTAL);
        assert.ok(require('../src/data/curiosidades.js').includes(total), 'grupo normal deveria usar pool total');
        assert.strictEqual(utils.deactivatePartial(G_PARCIAL), true);
    });

    it('isPartialSplashJid reflete o modo do grupo', () => {
        const utils = require('../src/database/utils.js');
        assert.strictEqual(splash.isPartialSplashJid(G_TOTAL), false);
        assert.strictEqual(splash.isPartialSplashJid('nao-grupo@s.whatsapp.net'), false);
        assert.strictEqual(utils.activatePartial(G_PARCIAL), true);
        try {
            assert.strictEqual(splash.isPartialSplashJid(G_PARCIAL), true);
        } finally {
            utils.deactivatePartial(G_PARCIAL);
        }
    });
});

describe('splash parcial — contraste do card amarelo', () => {
    it('texto e subtítulo sobre o amarelo têm contraste ≥ 4.5', () => {
        const C = splash.SPLASH_PARCIAL_THEME.colors;
        for (const bg of [C.bg0, C.bg1]) {
            assert.ok(contrast(C.text, bg) >= 4.5, `text x ${bg} = ${contrast(C.text, bg).toFixed(2)}`);
            assert.ok(contrast(C.sub, bg) >= 4.5, `sub x ${bg} = ${contrast(C.sub, bg).toFixed(2)}`);
        }
    });

    it('badge (texto x fundo) tem contraste ≥ 4.5 — sem branco sobre amarelo', () => {
        const C = splash.SPLASH_PARCIAL_THEME.colors;
        assert.notStrictEqual((C.badgeText || '').toLowerCase(), '#ffffff', 'badge não pode ser branco no amarelo');
        assert.notStrictEqual((C.badgeText || '').toLowerCase(), '#fff', 'badge não pode ser branco no amarelo');
        assert.ok(contrast(C.badgeText, C.accent) >= 4.5, `badge = ${contrast(C.badgeText, C.accent).toFixed(2)}`);
    });

    it('generateMenuImage gera card parcial (amarelo sólido, sem cover)', async () => {
        const { generateMenuImage } = require('../src/services/menuImage.js');
        const buf = await generateMenuImage({
            title: 'MODO PARCIAL',
            headerEmoji: '🟡',
            groupName: 'Grupo Teste',
            memberLabel: '10 membros',
            tagline: 'curiosidade de teste do modo parcial',
            footer: 'SPLASH PARCIAL',
            badge: 'PARCIAL',
            theme: splash.SPLASH_PARCIAL_THEME,
            avatarRaw: null,
            noCover: true
        });
        assert.ok(Buffer.isBuffer(buf) && buf.length > 5000, 'deveria gerar imagem do card');
    });
});
