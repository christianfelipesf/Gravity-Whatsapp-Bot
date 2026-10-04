const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = baileys;
const { Boom } = require('@hapi/boom');
const { initAuthCreds, BufferJSON } = baileys;

const DEBUG_SUB = process.env.DEBUG_SUB === '1' || process.env.DEBUG_SUB === 'true';

function dlog(msg) {
    // Escrita única (console.log já é capturado pelo terminalLog/dashboard).
    // Antes escrevia em stderr + stdout e cada linha aparecia duplicada no log.
    try { console.log(`[sub] ${msg}`); } catch (_) {}
}

function vlog(msg) {
    // Log verboso (upsert count, msg sem texto, PROCESSANDO sem prefixo).
    // Só aparece com DEBUG_SUB=1 para não spammar o terminal.
    if (!DEBUG_SUB) return;
    dlog(msg);
}

// Avisa o dono da sub no privado do bot principal (via sock principal).
// Usado em: restore pós-restart e reconnect automático (515/428/transiente).
// Nunca derruba nada — só sendMessage; resultado vai para logs/subs/.
// Retorna true se enviou, false caso contrário.
async function notifyOwner(ownerJid, text) {
    if (!ownerJid || !text) return false;
    // Normaliza: remove sufixo de device (":12@s.whatsapp.net" -> "@s.whatsapp.net")
    // pois sendMessage para JID com device falha silenciosamente.
    let target = String(ownerJid);
    try { target = target.replace(/:\d+(@)/, '$1'); } catch (_) {}
    const { connlog } = require('./subConnLog');
    let psock = null;
    try { psock = principalState.getSock?.() || global.__baileysSock || null; } catch (_) {}
    if (!psock) {
        connlog(ownerJid, 'notify-fail', 'sem-principal-sock');
        return false;
    }
    try { if (!principalState.getState().connected) { connlog(ownerJid, 'notify-fail', 'principal-offline'); return false; } } catch (_) {}
    try {
        await psock.sendMessage(target, { text });
        connlog(ownerJid, 'notify-ok', `para=${target.split('@')[0]} len=${String(text).length}`);
        return true;
    } catch (e) {
        connlog(ownerJid, 'notify-fail', `send-erro=${e?.message || e}`.slice(0, 200));
        return false;
    }
}

// Re-tenta o aviso uma vez após 15s (principal pode ainda estar estabilizando).
function notifyOwnerWithRetry(ownerJid, text) {
    notifyOwner(ownerJid, text).then((ok) => {
        if (!ok) setTimeout(() => { notifyOwner(ownerJid, text).catch?.(() => {}); }, 15000);
    }).catch?.(() => {});
}

const { readConfig } = require('../database/utils');
const mediaHandler = require('../events/media');
const principalState = require('./principalState');

// ============================================================
// subSessions — múltiplos sockets Baileys paralelos por usuário
// Cada owner (jid) tem sua própria sub-sessão com:
//   - credenciais persistidas em session/sub_<hash>/
//   - prefixo próprio (!setprefix <símbolo>)
//   - comandos básicos restritos: s, sticker, rv, toimg, acelerar,
//     play, tiktok (download), prefixo, menu simples
//   - em grupos ou privado (config subSessionsGroups)
//   - silencioso: erros viram reação ❌, nunca texto
// ============================================================

const SUB_SESSIONS_DIR = path.join(process.cwd(), 'session', 'subs');
const PER_SESSION_PREFIX_DEFAULT = '!';
const QR_MAX_ATTEMPTS = 3;
const QR_INTERVAL_MS = 45000;
const SUBS_GROUPS_DEFAULT = true;

const ALLOWED_BASIC = new Set([
    's', 'sticker', 'f', 'figurinha',
    'toimg', 'tovideo', 'pramidia',
    'revelar', 'r', 'rv', 'i',
    'acelerar', 'fast', 'speed',
    'desacelerar',
    'play', 'p', 'musica', 'youtube',
    'download', 'd', 'dl', 'baixar', 'media', 'social',
    'tiktok', 'ttk', 'fb', 'facebook', 'insta', 'instagram', 'reel', 'shorts',
    'prefixo', 'prefix', 'setprefix',
    'menu', 'help', 'comandos', 'tutorial'
]);

const sessions = new Map();
const loginLocks = new Map();
const LOGIN_LOCK_TTL_MS = 60000;
const LOGIN_COOLDOWN_MS = 3 * 60 * 1000;
const LOGIN_MIN_GAP_MS = 12000;
const PAIRING_FAIL_BLOCK_MS = 30 * 60 * 1000;
const loginCooldowns = new Map();
const pairingBlockedUntil = new Map();

// Fila global: 1 login de sub por vez, sempre depois do principal.
// Evita 2 sockets Baileys concorrendo no mesmo IP/processo (428/515/401).
const loginQueue = [];
let loginActive = false;
let lastLoginStart = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function destroySock(sock) {
    // Remove TODOS os listeners que anexamos (messages, receipts,
    // group-participants): sock morto com listener órfão vaza memória e
    // pode processar evento fantasma.
    for (const ev of ['connection.update', 'creds.update', 'messages.upsert', 'message-receipt.update', 'group-participants.update', 'groups.update']) {
        try { sock?.ev?.removeAllListeners?.(ev); } catch (_) {}
    }
    try { sock?.end?.(undefined); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
}

function getQueuePosition(ownerJid) {
    const i = loginQueue.findIndex(e => e.ownerJid === ownerJid);
    return i >= 0 ? i + 1 : 0;
}

function cancelQueuedLogin(ownerJid) {
    const i = loginQueue.findIndex(e => e.ownerJid === ownerJid);
    if (i < 0) return false;
    const [entry] = loginQueue.splice(i, 1);
    try { entry?.reject?.(new Error('login-cancelado')); } catch (_) {}
    return true;
}

async function pumpLoginQueue() {
    if (loginActive) return;
    const next = loginQueue.shift();
    if (!next) return;
    loginActive = true;
    try {
        const gap = Date.now() - lastLoginStart;
        if (lastLoginStart && gap < LOGIN_MIN_GAP_MS) {
            await sleep(LOGIN_MIN_GAP_MS - gap + Math.floor(Math.random() * 2000));
        }
        lastLoginStart = Date.now();
        const session = await _doStartLogin(next.ownerJid, next.opts);
        try { next.resolve?.(session); } catch (_) {}
    } catch (e) {
        try { next.reject?.(e); } catch (_) {}
    } finally {
        loginActive = false;
        if (loginQueue.length) setImmediate(pumpLoginQueue);
    }
}

function enqueueLogin(ownerJid, opts) {
    return new Promise((resolve, reject) => {
        loginQueue.push({ ownerJid, opts, resolve, reject, enqueuedAt: Date.now() });
        try {
            const pos = getQueuePosition(ownerJid);
            safeCallback(opts?.onQueued, ownerJid, { position: pos }).catch?.(() => {});
        } catch (_) {}
        setImmediate(pumpLoginQueue);
    });
}

function hashJid(jid) {
    return crypto.createHash('sha1').update(String(jid || '')).digest('hex').slice(0, 16);
}

// Quarentena de credenciais: renomeia a pasta p/ .bak-<ts> em vez de apagar.
// 401 transitório (conflito, mismatch de versão) não destrói a sessão;
// mantém os últimos 2 backups para restauração manual.
function quarantineDir(dir, why) {
    try {
        if (!dir || !fs.existsSync(dir)) return false;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bak = `${dir}.bak-${stamp}`;
        try { fs.rmSync(bak, { recursive: true, force: true }); } catch (_) {}
        fs.renameSync(dir, bak);
        try {
            const parent = path.dirname(dir);
            const base = path.basename(dir);
            const olds = fs.readdirSync(parent).filter(n => n.startsWith(base + '.bak-')).sort();
            while (olds.length > 2) { const o = olds.shift(); try { fs.rmSync(path.join(parent, o), { recursive: true, force: true }); } catch (_) {} }
        } catch (_) {}
        dlog(`${hashJid(why || '')} credenciais movidas p/ quarentena ${path.basename(bak)}`);
        return true;
    } catch (_) { return false; }
}

function sessionFolder(ownerJid) {
    const dir = path.join(SUB_SESSIONS_DIR, hashJid(ownerJid));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

// Creds pareadas de verdade? Fresh initAuthCreds tem registered=false e sem .me.
// Fantasma (QR nunca escaneado) não deve ser restaurado no boot.
function hasPairedCreds(dir) {
    try {
        const raw = fs.readFileSync(path.join(dir, 'creds.json'), 'utf8');
        const c = JSON.parse(raw);
        if (c && (c.registered === true || c.me)) return true;
    } catch (_) {}
    return false;
}

function getSubsGroupsEnabled() {
    try {
        const cfg = readConfig();
        if (cfg && typeof cfg.subSessionsGroups === 'boolean') return cfg.subSessionsGroups;
    } catch (_) {}
    return SUBS_GROUPS_DEFAULT;
}

// ============================================================
// Anti-conflito: sub fica silenciosa quando o principal está
// no mesmo grupo. Prioridade sempre do bot principal.
// - Se principal offline/desconectado → sub responde (fail-open,
//   senão o grupo ficaria sem resposta = "bugado").
// - Se não dá pra verificar (sem JID do principal, metadata
//   falhou) → sub responde (fail-open).
// - Cache curto (45s) + invalidação em group-participants.update
//   para reagir rápido quando o principal sai/entra.
// ============================================================
const PRINCIPAL_PRESENCE_TTL_MS = 45000;
const principalPresenceCache = new Map(); // groupJid -> { has: bool, at: number, pkey: string }

function _userOf(jid) {
    try { return String(jid || '').split('@')[0].split(':')[0].trim(); } catch (_) { return ''; }
}
function _digitsOf(jid) {
    try { return _userOf(jid).replace(/\D/g, ''); } catch (_) { return ''; }
}

function getPrincipalKeys() {
    const out = [];
    try {
        const ps = principalState.getState?.() || {};
        if (ps.phone) out.push(String(ps.phone));
    } catch (_) {}
    try {
        const s1 = principalState.getSock?.();
        if (s1?.user?.id) out.push(String(s1.user.id));
        if (s1?.user?.lid) out.push(String(s1.user.lid));
        if (s1?.user?.jid) out.push(String(s1.user.jid));
    } catch (_) {}
    try {
        const s2 = global.__baileysSock;
        if (s2?.user?.id) out.push(String(s2.user.id));
        if (s2?.user?.lid) out.push(String(s2.user.lid));
        if (s2?.user?.jid) out.push(String(s2.user.jid));
    } catch (_) {}
    return out.filter(Boolean);
}

function collectParticipantKeys(p) {
    if (!p) return [];
    if (typeof p === 'string') return [p];
    const keys = [];
    for (const f of ['id', 'jid', 'lid', 'phoneNumber', 'author', 'notify']) {
        try { if (p[f] && typeof p[f] === 'string') keys.push(p[f]); } catch (_) {}
    }
    return keys;
}

function principalMatchesParticipants(principalKeys, participants) {
    const pUsers = new Set();
    const pDigits = new Set();
    for (const k of principalKeys) {
        const u = _userOf(k);
        const d = _digitsOf(k);
        if (u) pUsers.add(u);
        if (d && d.length >= 8) pDigits.add(d);
    }
    if (!pUsers.size && !pDigits.size) return false;
    for (const part of participants || []) {
        for (const ck of collectParticipantKeys(part)) {
            const u = _userOf(ck);
            const d = _digitsOf(ck);
            if (u && pUsers.has(u)) return true;
            if (d && d.length >= 8) {
                for (const pd of pDigits) {
                    if (pd === d) return true;
                    // Sufixo: cobre variação de DDI/DDD ("55..." vs "...").
                    if (pd.length >= 10 && d.length >= 10) {
                        if (pd.endsWith(d) || d.endsWith(pd)) return true;
                    }
                }
            }
        }
    }
    return false;
}

async function isPrincipalInGroup(subSock, groupJid) {
    if (!groupJid || !groupJid.endsWith('@g.us')) return false;
    // Principal offline → sub DEVE responder (evita grupo mudo).
    try { if (!principalState.getState?.().connected) return false; } catch (_) { return false; }
    const pkeys = getPrincipalKeys();
    if (!pkeys.length) return false; // sem referência → fail-open
    const pkey = pkeys.map(_userOf).sort().join('|');
    const now = Date.now();
    const cached = principalPresenceCache.get(groupJid);
    if (cached && (now - cached.at) < PRINCIPAL_PRESENCE_TTL_MS && cached.pkey === pkey) {
        return !!cached.has;
    }
    let participants = null;
    try {
        const metaP = subSock.groupMetadata(groupJid);
        const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('gm-timeout')), 8000));
        const meta = await Promise.race([metaP, timeoutP]);
        participants = meta?.participants || [];
    } catch (e) {
        // Falha ao verificar → fail-open (responde) para não bugar.
        // Mantém cache antigo se existir, senão assume ausente.
        vlog(`presence-check falhou ${groupJid}: ${e?.message || e} → fail-open`);
        return cached ? !!cached.has : false;
    }
    let has = false;
    try { has = principalMatchesParticipants(pkeys, participants); } catch (_) { has = false; }
    try {
        principalPresenceCache.set(groupJid, { has, at: now, pkey });
        // Cap: grupos entram e o Map cresceria sem limite ao longo de dias.
        if (principalPresenceCache.size > 300) {
            const oldest = principalPresenceCache.keys().next().value;
            principalPresenceCache.delete(oldest);
        }
    } catch (_) {}
    if (has) vlog(`presence-check ${groupJid}: principal PRESENTE → sub silenciosa`);
    return has;
}

function clearPrincipalPresenceCache(groupJid) {
    try {
        if (groupJid) principalPresenceCache.delete(groupJid);
        else principalPresenceCache.clear();
    } catch (_) {}
}

// IDs de mensagens de mídia enviadas pela sub (para o listener de
// message-receipt.update confirmar entrega). Cap simples, sem TTL:
// recibo chega em segundos; overflow limpa os mais antigos.
const recentSubSentIds = new Set();
function trackSubSentId(id) {
    try {
        if (!id) return;
        recentSubSentIds.add(String(id));
        if (recentSubSentIds.size > 60) {
            const first = recentSubSentIds.values().next().value;
            recentSubSentIds.delete(first);
        }
    } catch (_) {}
}

function listSessions() {
    return Array.from(sessions.values()).map(s => ({
        ownerJid: s.ownerJid,
        prefix: s.prefix,
        connected: !!s.connected,
        phoneNumber: s.phoneNumber || null,
        startedAt: s.startedAt
    }));
}

function getSession(ownerJid) { return sessions.get(ownerJid) || null; }

async function reactSilent(sock, m, emoji) {
    try {
        const r = await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } });
        // Rastreia recibo: reação APARECE no celular do usuário, então o
        // recibo dela prova que o listener funciona e que a sessão entrega.
        try { trackSubSentId(r?.key?.id); } catch (_) {}
    }
    catch (_) {}
}

async function sendSilent(sock, jid, text, quoted) {
    try { await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined); } catch (_) {}
}

async function sendImageSilent(sock, jid, buffer, caption, quoted) {
    try {
        await sock.sendMessage(jid, { image: buffer, caption }, quoted ? { quoted } : undefined);
    } catch (_) {}
}

function basicMenuText(prefix, botName) {
    return `*${botName || 'Sub-sessão'}*\n\n` +
        `╭── *GERAL* ───\n` +
        `│ 📂 *${prefix}menu*\n` +
        `│ 📚 *${prefix}tutorial*\n` +
        `│ ⌨️ *${prefix}prefixo*\n` +
        `╰───────────────\n\n` +
        `╭── *MÍDIA* ───\n` +
        `│ 🖼️ *${prefix}s* (imagem/vídeo)\n` +
        `│ 🔓 *${prefix}rv* / ${prefix}revelar\n` +
        `│ 🔄 *${prefix}toimg*\n` +
        `│ ⚡ *${prefix}acelerar*\n` +
        `│ 🐌 *${prefix}desacelerar*\n` +
        `╰───────────────\n\n` +
        `╭── *DOWNLOAD* ───\n` +
        `│ 🎵 *${prefix}play* <nome> (max 15min)\n` +
        `│ 🎬 *${prefix}tiktok* <link>\n` +
        `│ 📥 *${prefix}dl* <link> (YT max 15min)\n` +
        `╰───────────────\n\n` +
        `╭── *CONFIG* ───\n` +
        `│ 🛠️ *${prefix}setprefix* <símbolo>\n` +
        `│ 🚪 *${prefix}logoff* / ${prefix}sair\n` +
        `╰───────────────\n\n` +
        `💡 *Dica:* este menu só responde comandos básicos da sua sub-sessão pessoal. O bot principal tem mais recursos.`;
}

async function dispatchBasicCommand(session, sock, m, text, from) {
    const prefix = session.prefix || PER_SESSION_PREFIX_DEFAULT;
    if (!text.startsWith(prefix)) return false;
    const args = text.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const fullArgsText = args.join(' ');
    const targetJid = from || m.key.remoteJid;

    if (commandName === 'logoff' || commandName === 'sair' || commandName === 'logout') {
        // Só o dono da sessão pode derrubá-la — senão qualquer pessoa no
        // grupo encerra a sub alheia com um "!sair".
        const senderJid = m.key.participant || targetJid;
        const sDigits = _digitsOf(senderJid);
        const oDigits = _digitsOf(session.ownerJid);
        const isOwner = (sDigits && oDigits && sDigits === oDigits) ||
            (_userOf(senderJid) && _userOf(senderJid) === _userOf(session.ownerJid));
        if (!isOwner) {
            await reactSilent(sock, m, '❌');
            return true;
        }
        await reactSilent(sock, m, '✅');
        try { await sendSilent(sock, targetJid, '🚪 *Sub-sessão encerrada.*\nUse !login para criar uma nova.', m); } catch (_) {}
        // Desconecta de verdade: antes só reagia ✅ e a sessão continuava viva.
        setImmediate(() => { try { logout(session.ownerJid); } catch (_) {} });
        return true;
    }

    if (commandName === 'prefixo' || commandName === 'prefix') {
        const prefixBox = `*Sub-sessão — Prefixo* ⌨️\n_prefixo atual_\n\n` +
            `╭─── *PREFIXO* ───\n` +
            `│ ⌨️ *Prefixo:* *${prefix}*\n` +
            `│ 💡 *Alterar:* ${prefix}setprefix <símbolo>\n` +
            `╰───────────────`;
        await sendSilent(sock, targetJid, prefixBox, m);
        await reactSilent(sock, m, '✅');
        return true;
    }

    if (commandName === 'setprefix') {
        // Prefixo: 1 símbolo não-alfanumérico. Sem isso, "!setprefix a"
        // faz toda mensagem com "a..." virar comando (reação ❌ em massa)
        // e "*" colide com as caixas do próprio bot ("*Sub-sessão*"),
        // gerando eco (bot reage à própria resposta, emitOwnEvents:true).
        const raw = fullArgsText.trim().split(/ +/)[0] || '';
        const VALID_PREFIX_RE = /^[!#$%&+\-./:;=?@^~]$/;
        if (!VALID_PREFIX_RE.test(raw)) {
            await reactSilent(sock, m, '❌');
            return true;
        }
        const newPrefix = raw;
        session.prefix = newPrefix;
        try { persistSessionMeta(session); } catch (_) {}
        const okBox = `*Sub-sessão — Prefixo* ⌨️\n_atualizado_\n\n` +
            `╭─── *CONFIG* ───\n` +
            `│ ✅ *Novo prefixo:* *${newPrefix}*\n` +
            `╰───────────────`;
        await sendSilent(sock, targetJid, okBox, m);
        await reactSilent(sock, m, '✅');
        return true;
    }

    if (commandName === 'menu' || commandName === 'help' || commandName === 'comandos' || commandName === 'tutorial') {
        await sendSilent(sock, targetJid, basicMenuText(session.prefix, `Sub-sessão`), m);
        await reactSilent(sock, m, '✅');
        return true;
    }

    let allowedName = null;
    if (ALLOWED_BASIC.has(commandName)) allowedName = commandName;

    if (!allowedName) {
        await reactSilent(sock, m, '❌');
        return true;
    }

    await reactSilent(sock, m, '⏳');
    try {
        const realName = resolveRealName(commandName);
        if (!realName) { await reactSilent(sock, m, '❌'); return true; }

        const mod = require(`../commands/${realName}.js`);
        if (!mod || typeof mod.execute !== 'function') { await reactSilent(sock, m, '❌'); return true; }

        const dummyConfig = { prefix: session.prefix, botName: `Sub-sessão` };
        const utils = require('../database/utils');
        const GLOBAL_COOLDOWN = 600;
        // lastBotResponse=0: os comandos usam utils.react com cooldown
        // (now - last < COOLDOWN → suprime). Com Date.now() aqui, TODAS
        // as reações internas (🔎⬇️✅❌) eram suprimidas e o usuário só
        // via ⏳ + ✅ — inclusive ✅ em caso de falha (mascarava erro).
        const lastBotResponse = 0;

        const _t0 = Date.now();
        try { vlog(`${hashJid(session.ownerJid)} INICIO !${commandName} em ${targetJid}`); } catch (_) {}
        await mod.execute(sock, m, {
            from: targetJid,
            isGroup: targetJid?.endsWith?.('@g.us'),
            sender: m.key.participant || targetJid,
            senderName: m.pushName || 'Usuário',
            fullArgsText,
            args,
            commandName: realName,
            config: dummyConfig,
            utils,
            model: null,
            startTime: session.startedAt,
            lastBotResponse,
            GLOBAL_COOLDOWN,
            mediaHandler,
            // Socket ATUAL da sessão (pode ter sido recriado por reconnect
            // no meio de um download longo). Comandos de mídia usam para
            // re-tentar o envio no socket novo em vez do morto.
            getSock: () => {
                try { return sessions.get(session.ownerJid)?.sock || sock; }
                catch (_) { return sock; }
            }
        });
        // SEM ✅ automático: cada comando já envia sua própria reação
        // final (✅/❌ via reactStatus). ✅ incondicional aqui mentia em
        // caso de falha interna (ex: !play com download falho).
        try { vlog(`${hashJid(session.ownerJid)} FIM !${commandName} ok em ${Date.now() - _t0}ms`); } catch (_) {}
        return true;
    } catch (e) {
        dlog(`${hashJid(session.ownerJid)} erro em !${commandName}: ${e?.message || e}`);
        await reactSilent(sock, m, '❌');
        return true;
    }
}

function resolveRealName(name) {
    const map = {
        s: 's', sticker: 's', f: 's', figurinha: 's',
        toimg: 'toimg', tovideo: 'toimg', pramidia: 'toimg',
        revelar: 'revelar', r: 'revelar', rv: 'revelar', i: 'revelar',
        acelerar: 'acelerar', fast: 'acelerar', speed: 'acelerar',
        desacelerar: 'desacelerar',
        play: 'play', p: 'play', musica: 'play', youtube: 'play',
        download: 'download', d: 'download', dl: 'download', baixar: 'download',
        media: 'download', social: 'download',
        tiktok: 'download', ttk: 'download', fb: 'download', facebook: 'download',
        insta: 'download', instagram: 'download', reel: 'download', shorts: 'download'
    };
    return map[name] || null;
}

const META_FILE = 'sub_meta.json';
function persistSessionMeta(session) {
    try {
        const dir = sessionFolder(session.ownerJid);
        const file = path.join(dir, META_FILE);
        fs.writeFileSync(file, JSON.stringify({
            ownerJid: session.ownerJid,
            prefix: session.prefix,
            phoneNumber: session.phoneNumber || null,
            startedAt: session.startedAt
        }, null, 2));
    } catch (_) {}
}

function loadSessionMeta(ownerJid) {
    try {
        const file = path.join(sessionFolder(ownerJid), META_FILE);
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { return null; }
}

function attachMessagesHandler(session, sock) {
    const ownerJid = session.ownerJid;
    const selfJidRaw = (sock.user?.id || '');
    const selfNorm = selfJidRaw.split(':')[0].split('@')[0];
    dlog(`${hashJid(ownerJid)} handler attached, selfJidRaw=${selfJidRaw} selfNorm=${selfNorm}`);

    // Invalida cache anti-conflito quando alguém entra/sai do grupo.
    // Assim se o principal sair, a sub volta a responder no próximo
    // comando sem esperar o TTL; se entrar, a sub silencia rápido.
    try {
        sock.ev.removeAllListeners?.('group-participants.update');
    } catch (_) {}
    try {
        sock.ev.on('group-participants.update', (u) => {
            try {
                const gid = u?.id;
                if (gid) clearPrincipalPresenceCache(gid);
            } catch (_) {}
        });
    } catch (_) {}

    // Rastreio de entrega: IDs de mídia enviadas pela sub (ex: áudio do
    // !play). Quando o WhatsApp confirma entrega/leitura, loga — prova se
    // a mensagem saiu do servidor e chegou ao aparelho (ou sumiu no meio).
    try {
        sock.ev.on('message-receipt.update', (updates) => {
            try {
                const current = sessions.get(ownerJid);
                if (!current || current.sock !== sock) return;
                for (const u of updates || []) {
                    const ids = [];
                    try {
                        if (u?.key?.id) ids.push(u.key.id);
                        if (Array.isArray(u?.keyIds)) for (const id of u.keyIds) ids.push(id);
                    } catch (_) {}
                    for (const id of ids) {
                        if (!id || !recentSubSentIds.has(id)) continue;
                        const rc = u?.receipt || {};
                        // IUserReceipt: receiptTimestamp=entregue, readTimestamp=lido, playedTimestamp=ouvido.
                        // Sem campo conhecido, despeja o objeto p/ aprender o formato real.
                        let rtype = rc.playedTimestamp ? 'played' : rc.readTimestamp ? 'read' : rc.receiptTimestamp ? 'delivery' : (rc.type || null);
                        if (!rtype) { try { rtype = JSON.stringify(rc).slice(0, 120); } catch (_) { rtype = '?'; } }
                        const who = String(u?.key?.participant || u?.key?.remoteJid || '?').split('@')[0];
                        dlog(`${hashJid(ownerJid)} recibo ${String(id).slice(-8)}: ${rtype} para=${who}`);
                    }
                }
            } catch (_) {}
        });
    } catch (_) {}

    // Ligações 1:1 na sub-sessão — rejeita em silêncio (não toca no dono).
    try { require('../events/calls').registerCallHandler(sock); } catch (_) {}

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            // Anti-fantasma: se a sessão saiu do map (logoff/close/logged-out) ou o
            // sock foi substituído por reconnect, ignora sem logar nem processar.
            // NUNCA desconecta aqui — só retorna. Sessão conectada segue normal.
            const current = sessions.get(ownerJid);
            if (!current || current.sock !== sock) return;
            // Desconectado (connected=false) não processa nem spamma log.
            // Só volta a processar quando 'open' marcar connected=true de novo.
            if (!current.connected) return;
            if (DEBUG_SUB) vlog(`${hashJid(ownerJid)} upsert type=${type} count=${messages?.length || 0}`);
            if (type !== 'notify' && type !== 'append') return;
            for (const m of messages) {
                if (!m?.message) {
                    continue;
                }

                const keys = Object.keys(m.message);
                const isHandshake = keys.length > 0 && keys.every(k =>
                    k === 'senderKeyDistributionMessage' ||
                    k === 'messageContextInfo' ||
                    k === 'protocolMessage'
                );
                if (isHandshake) continue;

                const reaction = m.message.reactionMessage;
                if (reaction && !reaction.text) continue;

                const from = m.key.remoteJid;
                if (!from) continue;
                if (from === 'status@broadcast') continue;

                const isGroup = from.endsWith('@g.us');
                const fromNorm = from.split('@')[0].split(':')[0];

                const isSelfChat = !isGroup && fromNorm === selfNorm;

                if (isGroup && !getSubsGroupsEnabled()) {
                    continue;
                }

                const text = extractText(m.message, m);
                if (!text || !text.trim()) {
                    continue;
                }
                const t = text.trim();

                // Só loga PROCESSANDO quando é comando potencial (com prefixo).
                // Mensagem comum ("Nada cara que isso", "Oba 🥰") não spamma mais.
                if (t.startsWith(session.prefix)) {
                    vlog(`${hashJid(session.ownerJid)} PROCESSANDO from=${from} isGroup=${isGroup} text="${t.slice(0,60)}"`);
                }

                const isBarePrefixQuery = t.toLowerCase() === 'prefixo' || t.toLowerCase() === 'prefix';
                const isPotentialCmd = t.startsWith(session.prefix) || isBarePrefixQuery;

                // Anti-conflito: se o bot principal está no mesmo grupo, a sub
                // fica 100% silenciosa (nem reage, nem responde). O principal
                // tem prioridade. Fail-open: se o principal está offline ou a
                // verificação falhar, a sub responde normalmente para o grupo
                // não ficar sem resposta.
                if (isGroup && isPotentialCmd) {
                    try {
                        if (await isPrincipalInGroup(sock, from)) {
                            vlog(`${hashJid(session.ownerJid)} silenciada em ${from}: principal presente`);
                            continue;
                        }
                    } catch (_) {
                        // fail-open: erro na verificação → responde normal
                    }
                }

                if (!t.startsWith(session.prefix)) {
                    if (isBarePrefixQuery) {
                        const prefixBox = `*Sub-sessão — Prefixo* ⌨️\n_prefixo atual_\n\n` +
                            `╭─── *PREFIXO* ───\n` +
                            `│ ⌨️ *Prefixo:* *${session.prefix}*\n` +
                            `╰───────────────`;
                        await sendSilent(sock, from, prefixBox, m);
                        await reactSilent(sock, m, 'ℹ️');
                    }
                    continue;
                }

                await dispatchBasicCommand(session, sock, m, t, from);
            }
        } catch (e) {
            dlog(`handler error: ${e?.message || e}`);
            try { dlog(`stack: ${e?.stack?.split('\n').slice(0,3).join(' | ')}`); } catch (_) {}
        }
    });
}

function extractText(message, m) {
    if (!message) return '';
    let inner = message;
    if (message.ephemeralMessage?.message) inner = message.ephemeralMessage.message;
    if (message.viewOnceMessage?.message) inner = message.viewOnceMessage.message;
    if (message.documentWithCaptionMessage?.message) inner = message.documentWithCaptionMessage.message;

    return (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.buttonsResponseMessage?.selectedButtonId ||
        inner.listResponseMessage?.title ||
        ''
    );
}

async function startLogin(ownerJid, opts = {}) {
    const { _silent = false, _reconnect = false } = opts || {};
    // Retries internos do próprio serviço não passam pela fila.
    if (_silent || _reconnect) return _doStartLogin(ownerJid, opts);

    // Idempotente: se já está conectando ou na fila, só atualiza callbacks/chat.
    const existing = sessions.get(ownerJid);
    if (existing && (existing.connecting || existing.queued)) {
        existing.onQr = opts.onQr || existing.onQr;
        existing.onConnected = opts.onConnected || existing.onConnected;
        existing.onClosed = opts.onClosed || existing.onClosed;
        existing.onPairingCode = opts.onPairingCode || existing.onPairingCode;
        existing.onQueued = opts.onQueued || existing.onQueued;
        dlog(`${hashJid(ownerJid)} login já em andamento — reutilizando (sem novo sock)`);
        try { await safeCallback(existing.onQueued, ownerJid, { position: getQueuePosition(ownerJid), alreadyRunning: true }); } catch (_) {}
        return existing;
    }
    if (existing?.connected) return existing;
    if (getQueuePosition(ownerJid) > 0) {
        const entry = loginQueue.find(e => e.ownerJid === ownerJid);
        if (entry) {
            entry.opts.onQr = opts.onQr || entry.opts.onQr;
            entry.opts.onConnected = opts.onConnected || entry.opts.onConnected;
            entry.opts.onClosed = opts.onClosed || entry.opts.onClosed;
            entry.opts.onPairingCode = opts.onPairingCode || entry.opts.onPairingCode;
            entry.opts.onQueued = opts.onQueued || entry.opts.onQueued;
            try { await safeCallback(entry.opts.onQueued, ownerJid, { position: getQueuePosition(ownerJid), alreadyRunning: true }); } catch (_) {}
        }
        dlog(`${hashJid(ownerJid)} login já na fila — callbacks atualizados, sem duplicar`);
        return sessions.get(ownerJid) || null;
    }

    // Cooldown anti-spam: 3min entre tentativas manuais do mesmo dono.
    const cdUntil = loginCooldowns.get(ownerJid);
    if (cdUntil && cdUntil > Date.now()) {
        dlog(`${hashJid(ownerJid)} cooldown ativo (${Math.ceil((cdUntil - Date.now()) / 1000)}s)`);
        await safeCallback(opts.onClosed, ownerJid, 'cooldown');
        return sessions.get(ownerJid) || null;
    }

    // Lock 60s contra duplo-clique / 2 chats simultâneos.
    const lockUntil = loginLocks.get(ownerJid);
    if (lockUntil && lockUntil > Date.now()) {
        dlog(`${hashJid(ownerJid)} login duplicado bloqueado (lock ativo)`);
        return sessions.get(ownerJid) || null;
    }
    loginLocks.set(ownerJid, Date.now() + LOGIN_LOCK_TTL_MS);
    setTimeout(() => loginLocks.delete(ownerJid), LOGIN_LOCK_TTL_MS).unref?.();
    loginCooldowns.set(ownerJid, Date.now() + LOGIN_COOLDOWN_MS);

    // Bloqueio de pairing após 3 falhas (rate-limit do WhatsApp): força QR por 30min.
    const phoneEarly = opts.phoneNumber ? String(opts.phoneNumber).replace(/\D/g, '') : null;
    if (phoneEarly) {
        const blocked = pairingBlockedUntil.get(ownerJid);
        if (blocked && blocked > Date.now()) {
            dlog(`${hashJid(ownerJid)} pairing bloqueado até ${new Date(blocked).toLocaleTimeString('pt-BR')} — use QR`);
            await safeCallback(opts.onClosed, ownerJid, 'pairing-blocked');
            return null;
        }
    }

    return enqueueLogin(ownerJid, { ...opts, _waitPrincipal: true });
}

async function _doStartLogin(ownerJid, { onQr, onConnected, onClosed, _silent = false, _reconnect = false, phoneNumber = null, onPairingCode = null, onQueued = null, _waitPrincipal = true, _resumeState = null }) {
    const baseHash = hashJid(ownerJid);
    const metaEarly = loadSessionMeta(ownerJid) || {};
    const normalizedPhoneEarly = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : null;

    // GATE: sub nunca sobe antes do principal. Fonte única da verdade.
    if (!_reconnect && !principalState.getState().connected) {
        dlog(`${hashJid(ownerJid)} aguardando bot principal conectar (timeout 90s)...`);
        try {
            await safeCallback(onQueued, ownerJid, { position: getQueuePosition(ownerJid), waitingPrincipal: true });
            await principalState.waitForConnection(90000);
            dlog(`${hashJid(ownerJid)} bot principal conectou, prosseguindo`);
        } catch (e) {
            dlog(`${hashJid(ownerJid)} timeout aguardando principal: ${e?.message}`);
            await safeCallback(onClosed, ownerJid, 'principal-not-connected');
            sessions.delete(ownerJid);
            return null;
        }
    }

    if (sessions.has(ownerJid)) {
        const existing = sessions.get(ownerJid);
        // Re-chamada idempotente dentro da fila: atualiza callbacks, mantém sock.
        if (existing.connecting || existing.queued) {
            existing.onQr = onQr || existing.onQr;
            existing.onConnected = onConnected || existing.onConnected;
            existing.onClosed = onClosed || existing.onClosed;
            existing.onPairingCode = onPairingCode || existing.onPairingCode;
            existing.onQueued = onQueued || existing.onQueued;
            return existing;
        }
        destroySock(existing.sock);
        dlog(`${hashJid(ownerJid)} sock anterior destruído (connecting=${!!existing.connecting})`);
        sessions.delete(ownerJid);
    }
    // Limpeza segura: NUNCA apaga a pasta final no início de pairing.
    // Apaga só _pair_* obsoletos do mesmo dono (stale >1h) para não matar retry atual.
    if (normalizedPhoneEarly) {
        try {
            const allDirs = fs.readdirSync(SUB_SESSIONS_DIR);
            const now = Date.now();
            for (const n of allDirs) {
                if (!n.startsWith(baseHash + '_pair_')) continue;
                try {
                    const st = fs.statSync(path.join(SUB_SESSIONS_DIR, n));
                    if (now - st.mtimeMs > 60 * 60 * 1000) {
                        fs.rmSync(path.join(SUB_SESSIONS_DIR, n), { recursive: true, force: true });
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }

    let dir = sessionFolder(ownerJid);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const meta = metaEarly;
    const normalizedPhone = normalizedPhoneEarly;

    if (normalizedPhone) {
        const stamp = Date.now().toString(36);
        const pairDir = path.join(SUB_SESSIONS_DIR, `${baseHash}_pair_${stamp}`);
        try { fs.mkdirSync(pairDir, { recursive: true }); } catch (_) {}
        dir = pairDir;
        dlog(`${hashJid(ownerJid)} modo pairing → usando dir temporário ${dir}`);
    }

    const session = {
        ownerJid,
        prefix: (_resumeState && _resumeState.prefix) || meta.prefix || PER_SESSION_PREFIX_DEFAULT,
        phoneNumber: normalizedPhone || (_resumeState && _resumeState.phoneNumber) || meta.phoneNumber || null,
        startedAt: Date.now(),
        sock: null,
        connected: false,
        connecting: true,
        queued: false,
        qrAttempts: (_resumeState && Number(_resumeState.qrAttempts)) || 0,
        qrTimer: null,
        lastQrHash: (_resumeState && _resumeState.lastQrHash) || null,
        lastQrAt: (_resumeState && _resumeState.lastQrAt) || 0,
        pairCodeSent: false,
        _restartCount: (_resumeState && Number(_resumeState.restartCount)) || 0,
        _wasConnected: false,
        onQr, onConnected, onClosed, onPairingCode, onQueued
    };
    sessions.set(ownerJid, session);
    persistSessionMeta(session);

    try {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        const credsPath = path.join(dir, 'creds.json');
        try {
            if (!fs.existsSync(credsPath)) {
                const fresh = initAuthCreds();
                fs.writeFileSync(credsPath, JSON.stringify(fresh, BufferJSON.replacer, 2), 'utf8');
                dlog(`${hashJid(ownerJid)} creds.json criado via initAuthCreds em ${dir}`);
            }
        } catch (e) {
            dlog(`${hashJid(ownerJid)} falha ao criar creds: ${e?.message}`);
        }
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        // Reutiliza a versão do principal para evitar mismatch 401/405 entre sockets.
        // O principalState pode conter a versão do BOT (string) — só usa se for array [major, minor, patch].
        let version = principalState.getVersion();
        const isValidVersion = Array.isArray(version) && version.length === 3 && version.every(n => Number.isInteger(n));
        if (!isValidVersion) {
            if (version != null) dlog(`principal version inválida (${JSON.stringify(version)}) — buscando versão Baileys`);
            const { getCachedBaileysVersion } = require('./version');
            version = await getCachedBaileysVersion();
        }
        dlog(`${hashJid(ownerJid)} usando version=${JSON.stringify(version)} (pairing=${!!normalizedPhone})`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['Windows', 'Chrome', '124.0.0.0'],
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 60_000,
            emitOwnEvents: true,
            syncFullHistory: false,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            getMessage: async () => undefined
        });
        session.sock = sock;
        console.log(`🔐 [sub:${hashJid(ownerJid)}] sock criado, auth dir=${dir}, version=${JSON.stringify(version)}`);

        if (normalizedPhone) {
            const tryRequestCode = async (attempt = 1) => {
                if (session.pairCodeSent || session.connected) return;
                if (sessions.get(ownerJid) !== session) {
                    dlog(`${hashJid(ownerJid)} sessão trocada/removida, parando tentativas de pairing`);
                    return;
                }
                try {
                    dlog(`${hashJid(ownerJid)} requesting pairing code (tentativa ${attempt}/3)...`);
                    const code = await sock.requestPairingCode(normalizedPhone);
                    dlog(`${hashJid(ownerJid)} pairing code OK: ${code}`);
                    session.pairCodeSent = true;
                    await safeCallback(session.onPairingCode, ownerJid, { code, phoneNumber: normalizedPhone });
                    armWatchdog();
                } catch (e) {
                    dlog(`${hashJid(ownerJid)} erro pairing (tentativa ${attempt}/3): ${e?.message}`);
                    if (session.connected || sessions.get(ownerJid) !== session) return;
                    if (attempt < 3 && !session.connected && sessions.get(ownerJid) === session) {
                        setTimeout(() => tryRequestCode(attempt + 1), 3000);
                    } else if (attempt >= 3 && sessions.get(ownerJid) === session) {
                        dlog(`${hashJid(ownerJid)} ❌ 3 tentativas de pairing falharam → limpando tudo automaticamente`);
                        pairingBlockedUntil.set(ownerJid, Date.now() + PAIRING_FAIL_BLOCK_MS);
                        try { await safeCallback(session.onPairingCode, ownerJid, { code: null, phoneNumber: normalizedPhone, failed: true, attempts: 3 }); } catch (_) {}
                        await cleanupAndCancel('pairing-failed');
                    }
                }
            };
            setTimeout(() => tryRequestCode(1), 5000);
        }

        const cleanupAndCancel = async (reason) => {
            // NUNCA cancela quem já conectou: se conectou no meio do caminho,
            // o watchdog/pairing tardio não pode derrubar nem avisar "cancelada".
            if (session.connected) return;
            // Timer obsoleto de um sock antigo (recreate) não pode matar a sessão nova.
            if (sessions.get(ownerJid) !== session) return;
            try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
            destroySock(sock);
            if (normalizedPhone && dir && dir.includes('_pair_')) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
            }
            // qr-exhausted sem nunca ter conectado = creds frescas inúteis
            // (fantasma de restore ou !login não escaneado). Apaga a pasta final
            // para não virar loop cleanup-qr-exhausted a cada boot.
            if (reason === 'qr-exhausted' && !session._wasConnected && !normalizedPhone && dir) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
            }
            // Pasta final só é apagada em falha definitiva de auth, nunca em timeout/retry.
            if ((reason === 'unauthorized' || reason === 'logged-out' || String(reason).startsWith('auth-failed')) && !normalizedPhone) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
            }
            sessions.delete(ownerJid);
            loginCooldowns.delete(ownerJid);
            console.log(`🔐 [sub:${hashJid(ownerJid)}] cleanup (${reason})`);
            try { require('./subConnLog').connlog(ownerJid, 'end', `cleanup-${reason} qrAttempts=${session.qrAttempts}`); } catch (_) {}
            await safeCallback(session.onClosed, ownerJid, reason);
        };

        const armWatchdog = () => {
            try { if (session.qrTimer) clearTimeout(session.qrTimer); } catch (_) {}
            session.qrTimer = setTimeout(async () => {
                try {
                    if (session.connected) return;
                    if (sessions.get(ownerJid) !== session) return;
                    const sinceLast = Date.now() - (session.lastQrAt || 0);
                    if (sinceLast < QR_INTERVAL_MS) {
                        armWatchdog();
                        return;
                    }
                    await cleanupAndCancel('qr-exhausted');
                } catch (_) {}
            }, QR_INTERVAL_MS);
            if (typeof session.qrTimer.unref === 'function') session.qrTimer.unref();
        };

        sock.ev.on('creds.update', async () => {
            try { await saveCreds(); }
            catch (e) {
                if (e?.code === 'ENOENT') {
                    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
                    try { await saveCreds(); } catch (_) {}
                }
            }
        });

        sock.ev.on('connection.update', async (u) => {
            try {
                dlog(`${hashJid(ownerJid)} conn.update → connection=${u.connection} qr=${u.qr ? 'YES(len=' + u.qr.length + ')' : 'no'} lastDisconnect=${u.lastDisconnect?.error?.message ? u.lastDisconnect.error.message.slice(0, 80) : 'none'}`);

                if (normalizedPhone && u.connection === 'connecting' && !u.qr && !session.pairCodeSent) {
                    try {
                        const code = await sock.requestPairingCode(normalizedPhone);
                        dlog(`${hashJid(ownerJid)} pairing code gerado: ${code}`);
                        session.pairCodeSent = true;
                        await safeCallback(session.onPairingCode, ownerJid, { code, phoneNumber: normalizedPhone });
                        armWatchdog();
                    } catch (e) {
                        dlog(`${hashJid(ownerJid)} erro ao gerar pairing code: ${e?.message}`);
                    }
                }

                if (u.qr) {
                    if (normalizedPhone && session.pairCodeSent) {
                        dlog(`${hashJid(ownerJid)} QR suprimido (modo pairing code)`);
                        armWatchdog();
                        return;
                    }
                    const qrHash = crypto.createHash('sha1').update(String(u.qr)).digest('hex');
                    const isNewQr = qrHash !== session.lastQrHash;
                    if (isNewQr) {
                        session.lastQrHash = qrHash;
                        session.lastQrAt = Date.now();
                        session.qrAttempts += 1;
                        dlog(`${hashJid(ownerJid)} novo QR → tentativa ${session.qrAttempts}/${QR_MAX_ATTEMPTS}`);
                        if (session.qrAttempts > QR_MAX_ATTEMPTS) {
                            dlog(`${hashJid(ownerJid)} limite excedido`);
                            await cleanupAndCancel('qr-exhausted');
                            return;
                        }
                        let buffer = null;
                        try { buffer = await QRCode.toBuffer(u.qr, { type: 'png', width: 512, margin: 2 }); }
                        catch (e) { dlog(`${hashJid(ownerJid)} erro PNG: ${e?.message}`); buffer = null; }
                        await safeCallback(session.onQr, ownerJid, { qr: u.qr, buffer, attempt: session.qrAttempts, max: QR_MAX_ATTEMPTS });
                    }
                    armWatchdog();
                }

                if (u.connection === 'close') {
                    session.connected = false;
                    try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                    const code = (u.lastDisconnect?.error instanceof Boom)
                        ? u.lastDisconnect.error.output?.statusCode
                        : u.lastDisconnect?.error?.statusCode;
                    const errMsg = u.lastDisconnect?.error?.message || 'sem mensagem';
                    const errData = u.lastDisconnect?.error?.data ? JSON.stringify(u.lastDisconnect.error.data).slice(0, 200) : '';
                    const errLower = String(errMsg).toLowerCase();
                    dlog(`${hashJid(ownerJid)} CLOSE code=${code} msg="${errMsg}" data="${errData}" attempts=${session.qrAttempts} connected=${!!session._wasConnected}`);
                    try { require('./subConnLog').connlog(ownerJid, 'close', `code=${code} wasOnline=${!!session._wasConnected} msg=${String(errMsg).slice(0, 120)}`); } catch (_) {}
                    const isLoginPhase = !session._wasConnected;
                    const isTransient = (
                        code === 408 || code === 428 || code === 515 || code === 502 ||
                        code === 503 || code === 500 || code == null ||
                        errLower.includes('restart required') ||
                        errLower.includes('connection closed') ||
                        errLower.includes('timed out') || errLower.includes('timeout') ||
                        errLower.includes('econnreset') || errLower.includes('socket closed') ||
                        errLower.includes('precondition required')
                    );
                    const recreateLoginSock = (why) => {
                        session._restartCount = (session._restartCount || 0) + 1;
                        if (session._restartCount > 5) {
                            dlog(`${hashJid(ownerJid)} ${why} loop >5 — quarentenando e abortando`);
                            try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                            destroySock(sock);
                            quarantineDir(dir, ownerJid);
                            sessions.delete(ownerJid);
                            loginCooldowns.delete(ownerJid);
                            try { require('./subConnLog').connlog(ownerJid, 'end', `restart-loop-${why} abort>5`); } catch (_) {}
                            safeCallback(session.onClosed, ownerJid, 'restart-loop');
                            return;
                        }
                        const delay = Math.min(30000, 3000 * Math.pow(2, session._restartCount - 1)) + Math.floor(Math.random() * 1000);
                        dlog(`${hashJid(ownerJid)} ${why} → recriando sock sem apagar credenciais (${session._restartCount}/5) em ${delay}ms, qrAttempts=${session.qrAttempts}`);
                        try { require('./subConnLog').connlog(ownerJid, 'recreate', `${why} em=${Math.round(delay / 1000)}s try=${session._restartCount}/5`); } catch (_) {}
                        const wasOnline = !!session._wasConnected;
                        // Avisa no privado do dono (via principal) que vai tentar reconectar.
                        // Só avisa quem já estava ONLINE — fase de QR já tem suas próprias mensagens.
                        if (wasOnline) {
                            notifyOwnerWithRetry(ownerJid,
                                `🔄 *Sub-sessão caiu (${why})*\nTentando reconectar automaticamente em ~${Math.round(delay / 1000)}s…\nVocê não precisa fazer nada.`
                            );
                        }
                        destroySock(sock);
                        const saved = {
                            qrAttempts: session.qrAttempts,
                            lastQrHash: session.lastQrHash,
                            lastQrAt: session.lastQrAt,
                            prefix: session.prefix,
                            phoneNumber: session.phoneNumber,
                            restartCount: session._restartCount,
                            onQr: session.onQr, onConnected: session.onConnected,
                            onClosed: session.onClosed, onPairingCode: session.onPairingCode,
                            onQueued: session.onQueued
                        };
                        // Envolve onConnected/onClosed para avisar no WhatsApp via principal atual
                        // (o closure original do !login pode referenciar o sock principal antigo).
                        const savedOnConnected = saved.onConnected;
                        const savedOnClosed = saved.onClosed;
                        const wrappedOnConnected = async (jid, info) => {
                            try { if (typeof savedOnConnected === 'function') await savedOnConnected(jid, info); } catch (_) {}
                            if (wasOnline) {
                                await notifyOwner(jid, `✅ *Sub-sessão reconectada!*\n📞 Número: \`${info?.phoneNumber || saved.phoneNumber || '?'}\`\nPode usar normalmente.`);
                            }
                        };
                        const wrappedOnClosed = async (jid, reason) => {
                            try { if (typeof savedOnClosed === 'function') await savedOnClosed(jid, reason); } catch (_) {}
                            if (wasOnline && (reason === 'restart-loop' || String(reason).startsWith('auth-failed') || reason === 'unauthorized')) {
                                await notifyOwner(jid, `❌ *Sub-sessão não reconectou (${reason}).*\nUse *!login* para conectar de novo ou *!subclean* antes se persistir.`);
                            }
                        };
                        sessions.delete(ownerJid);
                        setTimeout(async () => {
                            try {
                                // Se o principal caiu junto, espera ele voltar antes de recriar.
                                if (!principalState.getState().connected) {
                                    try { await principalState.waitForConnection(90000); } catch (_) {}
                                }
                                await _doStartLogin(ownerJid, {
                                    onQr: saved.onQr, onConnected: wrappedOnConnected,
                                    onClosed: wrappedOnClosed, onPairingCode: saved.onPairingCode,
                                    onQueued: saved.onQueued,
                                    phoneNumber: normalizedPhone || saved.phoneNumber,
                                    _reconnect: true,
                                    _resumeState: saved
                                });
                            } catch (e) { dlog(`${hashJid(ownerJid)} erro ao recriar: ${e?.message}`); }
                        }, delay);
                        // mantém o usuário informado que o QR vai atualizar, sem encerrar
                        armWatchdog();
                    };
                    if (code === DisconnectReason.loggedOut) {
                        try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                        destroySock(sock);
                        quarantineDir(dir, ownerJid);
                        sessions.delete(ownerJid);
                        try { require('./subConnLog').connlog(ownerJid, 'end', 'logged-out cred-quarentena'); } catch (_) {}
                        await safeCallback(session.onClosed, ownerJid, 'logged-out');
                    } else if (isTransient && isLoginPhase) {
                        // Fase de QR/pairing: close transitório (428/408/515/502/503/timeout)
                        // NÃO apaga credenciais nem avisa "cancelado" — só recria e aguarda próximo QR.
                        recreateLoginSock(`transient-${code}`);
                    } else if (code === 515 || errLower.includes('restart required')) {
                        recreateLoginSock('515-restart');
                    } else if (code === 401 || code === 403 || code === 405) {
                        // Sessão que JÁ ESTEVE online tinha credenciais válidas:
                        // 401 aqui costuma ser transitório (conflito/mismatch).
                        // Tenta 1 recreate antes de quarentenar.
                        if (session._wasConnected && !session._authRecreated) {
                            session._authRecreated = true;
                            recreateLoginSock(`auth-transient-${code}`);
                        } else {
                            dlog(`${hashJid(ownerJid)} ${code} → quarentenando credenciais e sessão`);
                            try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                            destroySock(sock);
                            quarantineDir(dir, ownerJid);
                            sessions.delete(ownerJid);
                            try { require('./subConnLog').connlog(ownerJid, 'end', `unauthorized-${code} cred-quarentena`); } catch (_) {}
                            await safeCallback(session.onClosed, ownerJid, 'unauthorized');
                        }
                    } else if (session.qrAttempts >= QR_MAX_ATTEMPTS) {
                        try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                        destroySock(sock);
                        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
                        sessions.delete(ownerJid);
                        try { require('./subConnLog').connlog(ownerJid, 'end', 'qr-exhausted'); } catch (_) {}
                        await safeCallback(session.onClosed, ownerJid, 'qr-exhausted');
                    } else if (isTransient) {
                        // Sessão já conectada que caiu com erro transitório, ou fase de login
                        // com código não coberto acima: recria sem apagar credenciais.
                        recreateLoginSock(`transient-late-${code}`);
                    } else if (code && code >= 400 && code < 500) {
                        dlog(`${hashJid(ownerJid)} erro ${code} → quarentenando credenciais e sessão`);
                        try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                        destroySock(sock);
                        quarantineDir(dir, ownerJid);
                        sessions.delete(ownerJid);
                        try { require('./subConnLog').connlog(ownerJid, 'end', `auth-failed-${code}`); } catch (_) {}
                        await safeCallback(session.onClosed, ownerJid, `auth-failed-${code}`);
                    } else {
                        try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                        destroySock(sock);
                        sessions.delete(ownerJid);
                        try { require('./subConnLog').connlog(ownerJid, 'end', `close-${code}`); } catch (_) {}
                        await safeCallback(session.onClosed, ownerJid, `close-${code}`);
                    }
                } else if (u.connection === 'open') {
                    session.connected = true;
                    session._wasConnected = true;
                    session._authRecreated = false;
                    session.connecting = false;
                    session.queued = false;
                    loginCooldowns.delete(ownerJid);
                    try { if (session.qrTimer) { clearTimeout(session.qrTimer); session.qrTimer = null; } } catch (_) {}
                    session.phoneNumber = sock.user?.id?.split?.(':')?.[0] || session.phoneNumber;

                    const finalDir = sessionFolder(ownerJid);
                    if (dir !== finalDir) {
                        try {
                            fs.rmSync(finalDir, { recursive: true, force: true });
                            fs.mkdirSync(path.dirname(finalDir), { recursive: true });
                            try {
                                fs.renameSync(dir, finalDir);
                            } catch (_) {
                                // Windows/EPERM: copia e depois apaga a temporária.
                                fs.cpSync(dir, finalDir, { recursive: true });
                                fs.rmSync(dir, { recursive: true, force: true });
                            }
                            dlog(`${hashJid(ownerJid)} credenciais movidas de ${path.basename(dir)} → ${path.basename(finalDir)}`);
                        } catch (e) {
                            dlog(`${hashJid(ownerJid)} erro ao mover credenciais: ${e?.message}`);
                        }
                    }

                    persistSessionMeta(session);
                    attachMessagesHandler(session, sock);
                    dlog(`${hashJid(ownerJid)} ✅ CONECTADO phone=${session.phoneNumber}`);
                    try { require('./subConnLog').connlog(ownerJid, 'open', `phone=${session.phoneNumber || '?'}`); } catch (_) {}
                    await safeCallback(session.onConnected, ownerJid, { phoneNumber: session.phoneNumber });
                } else if (u.connection === 'connecting') {
                    dlog(`${hashJid(ownerJid)} estado: connecting…`);
                }
            } catch (e) {
                dlog(`${hashJid(ownerJid)} conn.update ERRO: ${e?.message || e}`);
                try { dlog(`stack: ${e?.stack?.split('\n').slice(0, 4).join(' | ')}`); } catch (_) {}
                try { require('./subConnLog').connlog(ownerJid, 'bug', `conn.update-ERRO ${e?.message || e} | ${(e?.stack || '').split('\n')[1]?.trim() || ''}`.slice(0, 400)); } catch (_) {}
            }
        });

    } catch (e) {
        console.error('💥 [sub:startLogin]', e?.message || e);
        try { require('./subConnLog').connlog(ownerJid, 'bug', `startLogin-fail ${e?.message || e} | ${(e?.stack || '').split('\n')[1]?.trim() || ''}`.slice(0, 400)); } catch (_) {}
        session.connecting = false;
        sessions.delete(ownerJid);
        await safeCallback(session.onClosed, ownerJid, e?.message || 'init-failed');
    }

    return session;
}

async function safeCallback(cb, ...args) {
    if (typeof cb !== 'function') return;
    try { await cb(...args); } catch (e) { console.error('💥 [sub:cb]', e?.message || e); }
}

async function logout(ownerJid) {
    cancelQueuedLogin(ownerJid);
    loginCooldowns.delete(ownerJid);
    loginLocks.delete(ownerJid);
    const session = sessions.get(ownerJid);
    if (!session) {
        try { fs.rmSync(sessionFolder(ownerJid), { recursive: true, force: true }); } catch (_) {}
        return false;
    }
    try { if (session.qrTimer) clearTimeout(session.qrTimer); } catch (_) {}
    destroySock(session.sock);
    try { fs.rmSync(sessionFolder(ownerJid), { recursive: true, force: true }); } catch (_) {}
    sessions.delete(ownerJid);
    try { require('./subConnLog').connlog(ownerJid, 'end', 'logout-manual'); } catch (_) {}
    return true;
}

async function restoreFromDisk(onConnected) {
    const { connlog } = require('./subConnLog');
    try {
        // Restore sequencial e espaçado: 1 sub por vez, só com principal online.
        if (!principalState.getState().connected) {
            try { await principalState.waitForConnection(120000); } catch (e) {
                dlog(`restore adiado: principal offline (${e?.message})`);
                connlog('boot', 'restore-adiado', `principal-offline ${e?.message || ''}`);
                return [];
            }
        }
        if (!fs.existsSync(SUB_SESSIONS_DIR)) {
            connlog('boot', 'restore-vazio', 'sem-pasta-subs');
            return [];
        }
        const dirs = fs.readdirSync(SUB_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        const restored = [];
        const seenOwners = new Set();
        connlog('boot', 'restore-inicio', `dirs=${dirs.length}`);
        for (const d of dirs) {
            // Só pastas finais exatas (hash 16 hex). Pula _pair_* temporárias
            // e .bak-* de quarentena (creds rejeitadas 401/logged-out) —
            // senão o mesmo dono restaura 2-3x, cada retry mata o anterior
            // e o último vira fantasma em loop cleanup-qr-exhausted.
            if (!/^[0-9a-f]{16}$/.test(d.name)) continue;
            const metaPath = path.join(SUB_SESSIONS_DIR, d.name, META_FILE);
            if (!fs.existsSync(metaPath)) continue;
            let meta;
            try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { continue; }
            if (!meta || !meta.ownerJid) continue;
            if (seenOwners.has(meta.ownerJid)) continue;
            // Fantasma: nunca conectou (sem phone) + creds frescas não-pareadas
            // (registered=false, sem me) = QR que ninguém vai escanear no restore.
            // Restaurar isso gera cleanup-qr-exhausted a cada boot + spam no dono.
            // Apaga e pula. (Se as creds estiverem pareadas, tenta mesmo sem phone.)
            if (!meta.phoneNumber && !hasPairedCreds(path.join(SUB_SESSIONS_DIR, d.name))) {
                connlog(meta.ownerJid, 'restore-skip', `dir=${d.name} fantasma sem-phone → removido`);
                try { fs.rmSync(path.join(SUB_SESSIONS_DIR, d.name), { recursive: true, force: true }); } catch (_) {}
                continue;
            }
            seenOwners.add(meta.ownerJid);
            try {
                connlog(meta.ownerJid, 'restore-try', `dir=${d.name} phone=${meta.phoneNumber || '?'}`);
                // Avisa o dono no privado do principal que o bot reiniciou e vai reconectar.
                notifyOwnerWithRetry(meta.ownerJid,
                    `🔄 *Bot reiniciado*\nTentando reconectar sua sub-sessão automaticamente…\nVocê não precisa escanear QR de novo.`
                );
                await _doStartLogin(meta.ownerJid, {
                    onQr: async () => {},
                    onConnected: async (jid, info) => {
                        try { if (typeof onConnected === 'function') await onConnected(jid); } catch (_) {}
                        connlog(jid, 'restore-ok', `phone=${info?.phoneNumber || meta.phoneNumber || '?'}`);
                        await notifyOwner(jid,
                            `✅ *Sub-sessão reconectada após reinício!*\n📞 Número: \`${info?.phoneNumber || meta.phoneNumber || '?'}\`\nPode usar normalmente.`
                        );
                    },
                    onClosed: async (jid, reason) => {
                        connlog(jid, 'restore-fail', `reason=${reason}`);
                        if (reason === 'unauthorized' || reason === 'logged-out' || reason === 'close-401' || reason === 'close-403') {
                            try {
                                const dir2 = path.join(SUB_SESSIONS_DIR, hashJid(jid));
                                fs.rmSync(dir2, { recursive: true, force: true });
                                dlog(`${hashJid(jid)} credenciais inválidas/expiradas → removidas`);
                            } catch (_) {}
                            await notifyOwner(jid,
                                `❌ *Sub-sessão não reconectou após reinício (${reason}).*\nA sessão expirou no WhatsApp.\nUse *!login* para conectar de novo.`
                            );
                        } else if (reason && reason !== 'login-cancelado') {
                            await notifyOwner(jid,
                                `⚠️ *Sub-sessão: falha ao reconectar (${reason}).*\nVou tentar de novo sozinho; se persistir use *!login*.`
                            );
                        }
                    },
                    _silent: true,
                    _waitPrincipal: true
                });
                restored.push(meta.ownerJid);
                await sleep(LOGIN_MIN_GAP_MS);
            } catch (e) {
                dlog(`${hashJid(meta.ownerJid)} falha ao restaurar: ${e?.message}`);
                connlog(meta.ownerJid, 'restore-erro', `${e?.message || e}`.slice(0, 200));
            }
        }
        connlog('boot', 'restore-fim', `ok=${restored.length}`);
        return restored;
    } catch (e) {
        dlog(`restoreDisk erro: ${e?.message}`);
        try { require('./subConnLog').connlog('boot', 'restore-erro-fatal', `${e?.message || e}`.slice(0, 200)); } catch (_) {}
        return [];
    }
}

module.exports = {
    startLogin,
    logout,
    listSessions,
    getSession,
    restoreFromDisk,
    cancelQueuedLogin,
    getQueuePosition,
    isPrincipalInGroup,
    clearPrincipalPresenceCache,
    trackSubSentId,
    PER_SESSION_PREFIX_DEFAULT,
    QR_MAX_ATTEMPTS,
    ALLOWED_BASIC
};
