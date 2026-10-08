const cooldowns = new Map();

const COOLDOWN_CLEANUP_INTERVAL = 5 * 60 * 1000;
const COOLDOWN_MAX_AGE = 60 * 1000;

const CMD_COOLDOWN_DEFAULTS = {
    default: 2000,
    s: 3000,
    sticker: 3000,
    f: 3000,
    figurinha: 3000,
    toimg: 3000,
    acelerar: 3000,
    desacelerar: 3000,
    revelar: 2000,
    rv: 2000,
    i: 2000,
    ai: 3000,
    resumir: 10000,
    tts: 5000,
    play: 5000,
    dl: 5000,
    d: 5000,
    download: 5000,
    dhd: 5000,
    downloadhd: 5000,
    menu: 1000,
    help: 1000,
    comandos: 1000,
    status: 2000,
    ping: 2000,
    info: 2000,
    divulgar: 60000,
    mencionar: 30000,
    set: 3000,
    config: 3000,
    news: 5000,
    perfil: 3000,
    ficha: 3000,
    pessoa: 3000,
    'cadastrar-pessoa': 10000,
    cadastrar: 10000,
    'editar-pessoa': 5000,
    editar: 5000,
    'deletar-pessoa': 5000,
    'listar-pessoas': 3000,
    fichas: 3000,
    aniversariantes: 3000,
    niver: 3000,
    'radar-cidades': 3000,
    radar: 3000,
    aleatorio: 3000,
    sortear: 3000,
    contato: 3000,
    pix: 3000,
    dashboard: 2000,
    dash: 2000,
    painel: 2000,
    dump: 10000,
    grupos: 5000,
    log: 5000,
    limpar: 5000,
    ban: 3000,
    mute: 3000,
    desmute: 3000,
    antilink: 3000,
    adv: 3000,
    beijar: 2000,
    beijo: 2000,
    abraco: 2000,
    cafune: 2000,
    tapa: 2000,
    soco: 2000,
    morder: 2000,
    lamber: 2000,
    chute: 2000,
    matar: 2000,
    cutucar: 2000,
    cuddle: 2000,
    highfive: 2000,
    lancar: 2000,
    'lançar': 2000,
    jogar: 2000,
    lansar: 2000,
    comandosinteracao: 1000,
    interacao: 1000,
    interacoes: 1000,
    dono: 2000,
    owner: 2000,
    meme: 0,
    memealeatorio: 0,
    memerandom: 0,
    postarmeme: 15000,
    novomeme: 15000,
    memenovo: 15000,
    delmeme: 3000,
    deletememe: 3000,
    apagarmeme: 3000,
};

function getKey(commandName, userId) {
    // Canônico: "5511..:7@s.whatsapp.net" e "5511..@s.whatsapp.net" usam a
    // mesma chave (evita burla/duplicidade por troca de device).
    let u = String(userId || '');
    try { u = u.split('@')[0].split(':')[0].toLowerCase(); } catch (_) {}
    return `${commandName}:${u}`;
}

function getEffectiveCooldownMs(commandName) {
    return CMD_COOLDOWN_DEFAULTS[commandName] ?? CMD_COOLDOWN_DEFAULTS.default;
}

function checkCooldown(commandName, userId) {
    if (!commandName || !userId) return 0;
    const key = getKey(commandName, userId);
    const lastTime = cooldowns.get(key);
    const now = Date.now();
    const cooldownMs = getEffectiveCooldownMs(commandName);

    if (cooldownMs <= 0) return 0;

    if (lastTime && (now - lastTime) < cooldownMs) {
        return lastTime + cooldownMs - now;
    }

    cooldowns.set(key, now);
    return 0;
}

function getRemainingSeconds(commandName, userId) {
    if (!commandName || !userId) return 0;
    const key = getKey(commandName, userId);
    const lastTime = cooldowns.get(key);
    if (!lastTime) return 0;
    const cooldownMs = getEffectiveCooldownMs(commandName);
    if (cooldownMs <= 0) return 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed >= cooldownMs) return 0;
    return Math.ceil((cooldownMs - elapsed) / 1000);
}

function clearCooldown(commandName, userId) {
    const key = getKey(commandName, userId);
    cooldowns.delete(key);
}

function clearAllCooldowns() {
    cooldowns.clear();
}

setInterval(() => {
    const now = Date.now();
    for (const [key, time] of cooldowns) {
        if (now - time > COOLDOWN_MAX_AGE) {
            cooldowns.delete(key);
        }
    }
}, COOLDOWN_CLEANUP_INTERVAL).unref();

module.exports = {
    checkCooldown,
    getRemainingSeconds,
    clearCooldown,
    clearAllCooldowns,
    getEffectiveCooldownMs,
    CMD_COOLDOWN_DEFAULTS
};
