const fs = require('fs');
const path = require('path');

const THEMES = {
    default: {
        id: 'default',
        label: 'Padrão',
        header: '📖',
        bullet: '│',
        ok: '✅',
        err: '❌',
        react: '📖',
        rankReact: '🏆',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🏆',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '',
        menuImageCandidates: [],
        colors: {
            bg0: '#060f24',
            bg1: '#0a1c44',
            headerBg: '#10295e',
            accent: '#2563eb',
            gold: '#60a5fa',
            silver: '#bfdbfe',
            bronze: '#1d4ed8',
            row: '#0b1a38',
            rowAlt: '#081426',
            text: '#eff6ff',
            sub: '#93c5fd'
        },
        phrases: {
            activated: 'Tema padrão restaurado.',
            already: 'O grupo já está no tema padrão.'
        }
    },
    hell: {
        id: 'hell',
        label: 'Inferno 🔥',
        header: '🔥👹',
        bullet: '🔥',
        ok: '🔥',
        err: '💀',
        react: '🔥',
        rankReact: '👹',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '👹',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🔥👹',
        menuImageCandidates: ['hell.jpg', 'hell.png', 'hell.webp', 'inferno.jpg', 'hell.jpeg'],
        colors: {
            bg0: '#140607',
            bg1: '#220a0a',
            headerBg: '#2a0d0d',
            accent: '#ff2d20',
            gold: '#ff6b35',
            silver: '#ff3b30',
            bronze: '#a31212',
            row: '#241014',
            rowAlt: '#1b0c0f',
            text: '#ffe9e4',
            sub: '#e08a7d'
        },
        phrases: {
            activated: '🔥👹 O INFERNO tomou conta deste grupo! Emojis vermelhos ativados! 💀🩸',
            already: '🔥 Este grupo já está queimando no inferno.'
        }
    },
    natal: {
        id: 'natal',
        label: 'Natal 🎄',
        header: '🎄🎅',
        bullet: '🎄',
        ok: '🎁',
        err: '⛄',
        react: '🎄',
        rankReact: '🎅',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🎅',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🎄🎅',
        menuImageCandidates: ['natal.jpg', 'natal.png', 'natal.webp', 'christmas.jpg'],
        colors: {
            bg0: '#08130e',
            bg1: '#0d2117',
            headerBg: '#123524',
            accent: '#22c55e',
            gold: '#fbbf24',
            silver: '#e5e7eb',
            bronze: '#b45309',
            row: '#10241a',
            rowAlt: '#0c1d15',
            text: '#f0fdf4',
            sub: '#86efac'
        },
        phrases: {
            activated: '🎄🎅 Clima de NATAL ativado neste grupo! 🎁❄️',
            already: '🎄 Este grupo já está em clima de natal.'
        }
    },
    festa: {
        id: 'festa',
        label: 'Festa 🎉',
        header: '🎉🥳',
        bullet: '🎉',
        ok: '🥳',
        err: '😵',
        react: '🎉',
        rankReact: '🥇',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🥳',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🎉🥳',
        menuImageCandidates: ['festa.jpg', 'festa.png', 'festa.webp', 'party.jpg'],
        colors: {
            bg0: '#150a24',
            bg1: '#22103a',
            headerBg: '#2d1550',
            accent: '#d946ef',
            gold: '#facc15',
            silver: '#e9d5ff',
            bronze: '#f97316',
            row: '#221338',
            rowAlt: '#1b0f2e',
            text: '#faf5ff',
            sub: '#d8b4fe'
        },
        phrases: {
            activated: '🎉🥳 MODO FESTA ativado! Solta o som! 🎊🍻',
            already: '🎉 Este grupo já está em festa.'
        }
    },
    fofo: {
        id: 'fofo',
        label: 'Fofo 💖',
        header: '💖🌸',
        bullet: '🌸',
        ok: '💖',
        err: '🥺',
        react: '💖',
        rankReact: '🌸',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🌸',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '💖🌸',
        menuImageCandidates: ['fofo.jpg', 'fofo.png', 'fofo.webp', 'kawaii.jpg'],
        colors: {
            bg0: '#1c0f1a',
            bg1: '#2b1226',
            headerBg: '#3b1734',
            accent: '#f472b6',
            gold: '#fbcfe8',
            silver: '#fce7f3',
            bronze: '#db2777',
            row: '#2c1527',
            rowAlt: '#231020',
            text: '#fdf2f8',
            sub: '#f9a8d4'
        },
        phrases: {
            activated: '💖🌸 MODO FOFINHO ativado! Que amor! 🐰✨',
            already: '💖 Este grupo já está fofinho.'
        }
    },
    ceu: {
        id: 'ceu',
        label: 'Céu 😇',
        header: '😇🕊️',
        bullet: '🤍',
        ok: '🤍',
        err: '🌧️',
        react: '😇',
        rankReact: '👼',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '👼',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '😇🕊️',
        menuImageCandidates: ['ceu.jpg', 'ceu.png', 'ceu.webp', 'angelical.jpg', 'ceu.jpeg'],
        colors: {
            bg0: '#0b1226',
            bg1: '#16233f',
            headerBg: '#1e2f52',
            accent: '#e8eefc',
            gold: '#ffffff',
            silver: '#e2e8f0',
            bronze: '#94a3b8',
            row: '#131e38',
            rowAlt: '#0e1729',
            text: '#ffffff',
            sub: '#cbd5e1'
        },
        phrases: {
            activated: '😇🕊️ MODO ANGELICAL ativado! Paz e luz neste grupo! ✨🤍',
            already: '😇 Este grupo já está em paz angelical.'
        }
    },
    dark: {
        id: 'dark',
        label: 'Dark 🌑',
        header: '🌑💀',
        bullet: '⬛',
        ok: '🌑',
        err: '☠️',
        react: '🌑',
        rankReact: '💀',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '💀',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🌑💀',
        legacySuffixes: ['🖤💀'],
        menuImageCandidates: ['dark.jpg', 'dark.png', 'dark.webp', 'trevas.jpg', 'dark.jpeg'],
        colors: {
            bg0: '#050505',
            bg1: '#0d0d0f',
            headerBg: '#141416',
            accent: '#52525b',
            gold: '#e4e4e7',
            silver: '#a1a1aa',
            bronze: '#3f3f46',
            row: '#101012',
            rowAlt: '#0a0a0b',
            text: '#fafafa',
            sub: '#71717a'
        },
        phrases: {
            activated: '🌑💀 MODO DARK ativado! As trevas tomaram conta! ☠️🌑',
            already: '🌑 Este grupo já está nas trevas.'
        }
    },
    espacial: {
        id: 'espacial',
        label: 'Espacial 🚀',
        header: '🚀🛸',
        bullet: '🟣',
        ok: '🚀',
        err: '👽',
        react: '🚀',
        rankReact: '🛸',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🚀',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🚀💜',
        menuImageCandidates: ['espacial.jpg', 'espacial.png', 'espacial.webp', 'espaco.jpg', 'galaxia.jpg'],
        colors: {
            bg0: '#0d0618',
            bg1: '#1a0b33',
            headerBg: '#241145',
            accent: '#8b5cf6',
            gold: '#c4b5fd',
            silver: '#a78bfa',
            bronze: '#6d28d9',
            row: '#170c2b',
            rowAlt: '#120a22',
            text: '#f5f3ff',
            sub: '#b7a6f5'
        },
        phrases: {
            activated: '🚀🛸 MODO ESPACIAL ativado! Decolando! 🌌👽',
            already: '🚀 Este grupo já está em órbita.'
        }
    },
    verde: {
        id: 'verde',
        label: 'Verde 💚',
        header: '💚🍀',
        bullet: '💚',
        ok: '💚',
        err: '🥀',
        react: '💚',
        rankReact: '🍀',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '🌿',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '💚🍀',
        menuImageCandidates: ['verde.jpg', 'verde.png', 'verde.webp', 'green.jpg', 'verde.jpeg'],
        colors: {
            bg0: '#04140a',
            bg1: '#07271a',
            headerBg: '#0b3b26',
            accent: '#16a34a',
            gold: '#4ade80',
            silver: '#86efac',
            bronze: '#15803d',
            row: '#0a2418',
            rowAlt: '#071c12',
            text: '#f0fdf4',
            sub: '#6ee7a0'
        },
        phrases: {
            activated: '💚🍀 MODO VERDE ativado! Energia natural! 🌱🌿',
            already: '💚 Este grupo já está verdejante.'
        }
    },
    halloween: {
        id: 'halloween',
        label: 'Halloween 🎃',
        header: '🎃👻',
        bullet: '🎃',
        ok: '🍬',
        err: '💀',
        react: '🎃',
        rankReact: '👻',
        tagline: 'comandos principais',
        menuTitle: 'Menu Principal',
        rankTitle: 'RANK MENSAL — TOP 10 ATIVOS',
        rankIcon: '👻',
        rankEmpty: 'Nenhum registro este mês. Seja o primeiro a falar! 💬',
        botSuffix: '🎃👻',
        menuImageCandidates: ['halloween.jpg', 'halloween.png', 'halloween.webp', 'haloween.jpg', 'bruxas.jpg'],
        colors: {
            bg0: '#120802',
            bg1: '#1f0e04',
            headerBg: '#2b1406',
            accent: '#f97316',
            gold: '#fbbf24',
            silver: '#e7c88a',
            bronze: '#7c2d12',
            row: '#1d1007',
            rowAlt: '#160c05',
            text: '#fff3e6',
            sub: '#e8a04c'
        },
        phrases: {
            activated: '🎃👻 HALLOWEEN tomou conta deste grupo! Doces ou travessuras! 🍬🦇',
            already: '🎃 Este grupo já está assombrado.'
        }
    }
};

const THEME_IDS = Object.keys(THEMES);

const THEME_ALIASES = {
    angelical: 'ceu',
    angel: 'ceu',
    heaven: 'ceu',
    trevas: 'dark',
    darkness: 'dark',
    espaco: 'espacial',
    space: 'espacial',
    galaxia: 'espacial',
    green: 'verde',
    inferno: 'hell',
    party: 'festa',
    kawaii: 'fofo',
    haloween: 'halloween',
    bruxas: 'halloween'
};

function normalizeThemeId(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'reset' || s === 'off' || s === 'default' || s === 'padrao' || s === 'padrão') return 'default';
    if (THEMES[s]) return s;
    if (THEME_ALIASES[s]) return THEME_ALIASES[s];
    return null;
}

function getTheme(id) {
    const nid = normalizeThemeId(id) || 'default';
    return THEMES[nid] || THEMES.default;
}

function listThemes() {
    return THEME_IDS.filter(id => id !== 'default').map(id => ({ id, label: THEMES[id].label }));
}

function themeBullets(text, theme) {
    const t = theme || THEMES.default;
    if (!t || t.id === 'default') return text;
    return String(text || '').replace(/^│/gm, t.bullet);
}

function pickThemedMenuImage(themeId) {
    try {
        const t = getTheme(themeId);
        const dir = path.join(process.cwd(), 'src', 'media', 'menus');
        if (!fs.existsSync(dir)) return null;
        for (const cand of (t.menuImageCandidates || [])) {
            const full = path.join(dir, cand);
            if (fs.existsSync(full)) return full;
        }
        return null;
    } catch (_) { return null; }
}

function pickRandomMenuImage() {
    try {
        const dir = path.join(process.cwd(), 'src', 'media', 'menus');
        const valid = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir)
            .filter(f => valid.has(path.extname(f).toLowerCase()))
            .map(f => path.join(dir, f));
        if (!files.length) return null;
        return files[Math.floor(Math.random() * files.length)];
    } catch (_) { return null; }
}

function resolveMenuImage({ groupMenuImage, themeId }) {
    try {
        if (groupMenuImage) {
            const p = path.isAbsolute(groupMenuImage) ? groupMenuImage : path.join(process.cwd(), groupMenuImage);
            if (fs.existsSync(p)) return p;
        }
    } catch (_) {}
    const themed = pickThemedMenuImage(themeId);
    if (themed) return themed;
    const rnd = pickRandomMenuImage();
    if (rnd) return rnd;
    const fallback = path.join(process.cwd(), 'src', 'media', 'logo.png');
    return fs.existsSync(fallback) ? fallback : null;
}

module.exports = {
    THEMES,
    THEME_IDS,
    THEME_ALIASES,
    normalizeThemeId,
    getTheme,
    listThemes,
    themeBullets,
    pickThemedMenuImage,
    pickRandomMenuImage,
    resolveMenuImage
};
