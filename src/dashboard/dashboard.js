const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const cookieSession = require('cookie-session');
const adminAuth = require('./adminAuth');
const axios = require('axios');
const terminalLog = require('../services/terminalLog');
const {
    mediaToSticker,
    insertDashboardLog,
    loadDashboardHistory,
    getDashboardLogByMessageId,
    trimDashboardLogs,
    countDashboardLogs,
    updateDashboardLogReactions,
    updateDashboardLogMedia,
    selectDashboardLogsWithInlineMedia,
    clearDashboardLogs,
    upsertDashboardGroupInfo,
    getDashboardGroupInfo,
    listDashboardGroupInfos,
    listDashboardGroups,
    deleteDashboardGroupInfo,
    insertDashboardVisit
} = require('../database/utils');
const webDownloader = require('../services/webDownloader');

let ioServer = null;
let sockRef = null;
let groupsApi = null;
let httpServer = null;
const MAX_LOGS = 100000;
const HISTORY_SEND_LIMIT = 300;
const groupInfoCache = new Map();
const GROUP_INFO_TTL = 60 * 1000;
let groupsRefreshTimer = null;
let logsTrimTimer = null;
let accessLogStream = null;

const mediaCache = new Map();
const MAX_CACHE = 30;

let groupsSnapshotCache = null;
const GROUPS_CACHE_TTL = 30 * 1000;

let connectionState = { status: 'disconnected', qr: null, phone: null };

function setConnectionState(state) {
    connectionState = { ...connectionState, ...state };
    if (state.status === 'connected') {
        refreshBotGroupCache().catch(() => {}).then(() => pushGroupsSnapshot({ force: true }).catch(() => {}));
    }
    if (state.status !== 'connected') {
        clearBotGroupCache();
        groupsSnapshotCache = null;
    }
    if (ioServer) {
        try {
            const cfg = safe(() => require('../database/utils').readConfig(), {});
            ioServer.emit('connection:update', {
                ...getConnectionState(),
                dashboardShowQR: cfg && cfg.dashboardShowQR === true,
                dashboardChatBlocked: cfg && cfg.dashboardChatBlocked === true
            });
        } catch (_) {}
    }
}

function getConnectionState() { return { ...connectionState }; }

function safe(fn, fallback) {
    try { return fn(); } catch (e) { console.error('[dashboard]', e?.message || e); return fallback; }
}

function cacheMedia(messageId, info) {
    if (!messageId) return;
    try {
        mediaCache.set(messageId, info);
        if (mediaCache.size > MAX_CACHE) {
            const firstKey = mediaCache.keys().next().value;
            if (firstKey) mediaCache.delete(firstKey);
        }
    } catch (_) {}
}

function getCachedMedia(messageId) {
    try { return messageId ? mediaCache.get(messageId) : null; } catch (_) { return null; }
}

function attachSock(sock) {
    sockRef = sock;
    groupInfoCache.clear();
}

function setGroupsApi(api) { groupsApi = api; }

let processStartTime = Date.now();
let cpuUsage = { user: 0, system: 0 };
let lastCpuSnapshot = null;

function setStartTime(ts) {
    if (Number.isFinite(ts) && ts > 0) processStartTime = ts;
}

function readCpuUsage() {
    const cpus = os.cpus();
    let user = 0, sys = 0, idle = 0, total = 0;
    for (const c of cpus) {
        const t = c.times || {};
        user += t.user || 0;
        sys += t.sys || 0;
        idle += t.idle || 0;
        total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    }
    if (lastCpuSnapshot && total > lastCpuSnapshot.total) {
        const dTotal = total - lastCpuSnapshot.total;
        const dIdle = idle - lastCpuSnapshot.idle;
        const usedPct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0;
        cpuUsage = { userPct: usedPct, cores: cpus.length };
    } else {
        cpuUsage = { userPct: 0, cores: cpus.length };
    }
    lastCpuSnapshot = { user, sys, idle, total };
    return cpuUsage;
}

function isValidGroupJid(jid) {
    return typeof jid === 'string'
        && jid.endsWith('@g.us')
        && /^\d[\d\-]+\d@g\.us$/.test(jid);
}

function fallbackGroupSubject(jid) {
    const id = String(jid || '').split('@')[0];
    return id ? `Grupo ${id.slice(-6)}` : 'Grupo';
}

function normalizeGroupItem(item) {
    const jid = typeof item === 'string' ? item : item?.jid;
    if (!isValidGroupJid(jid)) return null;
    return {
        jid,
        subject: typeof item === 'object' ? item.subject : null,
        pictureUrl: typeof item === 'object' ? item.pictureUrl : null
    };
}

function rememberGroupInfo(jid, patch = {}) {
    const base = normalizeGroupItem({ jid });
    if (!base) return;
    const cached = groupInfoCache.get(base.jid)?.info || {};
    const info = {
        jid: base.jid,
        subject: patch.subject || cached.subject || null,
        pictureUrl: patch.pictureUrl || cached.pictureUrl || null,
        memberCount: patch.memberCount !== undefined ? patch.memberCount : (cached.memberCount || 0),
        ownerJid: patch.ownerJid || cached.ownerJid || null,
        desc: patch.desc || cached.desc || null
    };
    groupInfoCache.set(base.jid, { info, updatedAt: Date.now() });
    try { upsertDashboardGroupInfo(base.jid, info); } catch (_) {}
}

async function getParticipatingGroup(jid) {
    if (!sockRef?.groupFetchAllParticipating) return null;
    try {
        const all = await sockRef.groupFetchAllParticipating();
        return all?.[jid] || null;
    } catch (_) {
        return null;
    }
}

async function fetchAndCacheGroupMeta(jid) {
    const out = {};
    if (!sockRef) return out;
    try {
        const meta = await sockRef.groupMetadata(jid);
        if (meta) {
            if (meta.subject) out.subject = meta.subject;
            if (typeof meta.size === 'number') out.memberCount = meta.size;
            else if (Array.isArray(meta.participants)) out.memberCount = meta.participants.length;
            if (meta.owner) out.ownerJid = meta.owner;
            else if (meta.subjectOwner) out.ownerJid = meta.subjectOwner;
            if (meta.desc) out.desc = meta.desc;
            else if (meta.description) out.desc = meta.description;
        }
    } catch (_) {}
    try {
        const url = await sockRef.profilePictureUrl(jid, 'image');
        if (url) out.pictureUrl = url;
    } catch (_) {}
    if (!out.subject || out.memberCount === undefined) {
        try {
            const part = await getParticipatingGroup(jid);
            if (part) {
                if (!out.subject && part.subject) out.subject = part.subject;
                if (out.memberCount === undefined && typeof part.size === 'number') out.memberCount = part.size;
                else if (out.memberCount === undefined && Array.isArray(part.participants)) out.memberCount = part.participants.length;
            }
        } catch (_) {}
    }
    return out;
}

async function getGroupInfo(item, force = false) {
    const base = normalizeGroupItem(item);
    if (!base) return null;

    const cached = groupInfoCache.get(base.jid);
    if (!force && cached && Date.now() - cached.updatedAt < GROUP_INFO_TTL) {
        return {
            ...base,
            ...cached.info,
            subject: cached.info.subject || base.subject || fallbackGroupSubject(base.jid),
            pictureUrl: cached.info.pictureUrl || base.pictureUrl || null,
            memberCount: cached.info.memberCount || 0,
            ownerJid: cached.info.ownerJid || null,
            desc: cached.info.desc || null
        };
    }

    const fromDb = getDashboardGroupInfo(base.jid) || {};
    let info = {
        jid: base.jid,
        subject: base.subject || fromDb.subject || null,
        pictureUrl: base.pictureUrl || fromDb.pictureUrl || null,
        memberCount: fromDb.memberCount || 0,
        ownerJid: fromDb.ownerJid || null,
        desc: fromDb.desc || null
    };

    const needsRefresh = force
        || !info.subject
        || info.memberCount === 0
        || !info.pictureUrl;

    if (needsRefresh) {
        const fresh = await fetchAndCacheGroupMeta(base.jid);
        info = {
            jid: base.jid,
            subject: info.subject || fresh.subject || null,
            pictureUrl: info.pictureUrl || fresh.pictureUrl || null,
            memberCount: fresh.memberCount || info.memberCount || 0,
            ownerJid: info.ownerJid || fresh.ownerJid || null,
            desc: info.desc || fresh.desc || null
        };
    }

    if (!info.subject) info.subject = fallbackGroupSubject(base.jid);

    groupInfoCache.set(base.jid, { info, updatedAt: Date.now() });
    try { upsertDashboardGroupInfo(base.jid, info); } catch (_) {}
    return info;
}

let _botGroupJids = null;
let _botGroupJidsAt = 0;
const BOT_GROUPS_TTL = 120 * 1000;

function clearBotGroupCache() { _botGroupJids = null; _botGroupJidsAt = 0; }

async function refreshBotGroupCache() {
    if (!sockRef || !sockRef.groupFetchAllParticipating) { _botGroupJids = null; return; }
    try {
        const all = await sockRef.groupFetchAllParticipating();
        if (all && typeof all === 'object') {
            _botGroupJids = new Set(Object.keys(all));
            _botGroupJidsAt = Date.now();
        }
    } catch (_) { _botGroupJids = null; }
}

async function getGroupsSnapshot(options = {}) {
    if (!sockRef) return [];
    if (!_botGroupJids || Date.now() - _botGroupJidsAt > BOT_GROUPS_TTL) {
        await refreshBotGroupCache();
    }
    if (!_botGroupJids) return [];
    const raw = groupsApi ? await groupsApi() : [];
    const items = Array.isArray(raw) ? raw : [];
    const knownJids = new Set(items.map(i => i?.jid).filter(Boolean));

    try {
        const stored = listDashboardGroupInfos();
        for (const s of stored) {
            if (!knownJids.has(s.jid)) {
                try { deleteDashboardGroupInfo(s.jid); } catch (_) {}
            }
        }
    } catch (_) {}

    const seen = new Set();
    const tasks = [];
    for (const item of items) {
        const base = normalizeGroupItem(item);
        if (!base || seen.has(base.jid)) continue;
        seen.add(base.jid);
        if (base.jid.endsWith('@g.us') && _botGroupJids && !_botGroupJids.has(base.jid)) continue;
        tasks.push(getGroupInfo(base, !!options.force));
    }
    const results = await Promise.all(tasks);
    let out = results.filter(Boolean);

    // Filtra apenas grupos (remove contatos privados)
    out = out.filter(g => g.jid && g.jid.endsWith('@g.us'));

    return out.sort((a, b) => String(a.subject).localeCompare(String(b.subject), 'pt-BR'));
}

// Trim do histórico: DONO é src/history/store.js (histórico não depende do
// painel web). Esta função aqui é só alias legado p/ compat — delega.
// Lê history* a cada ciclo para respeitar !set sem restart.
function ensureLogsTrimLoop() {
    try { return require('../history/store').ensureHistoryTrimLoop(); } catch (_) {}
    if (logsTrimTimer) return true;
    const runTrim = (isBoot) => {
        try {
            const lim = require('../history/store').getHistoryLimits();
            const maxRows = lim.maxRows, maxAgeMs = lim.maxAgeMs;
            const c = countDashboardLogs();
            if (c > maxRows || (maxAgeMs > 0 && c > 0)) {
                trimDashboardLogs({ maxAgeMs, maxRows });
                try { require('../database/utils').checkpointWal(); } catch (_) {}
                if (isBoot && c > maxRows) {
                    try {
                        const after = countDashboardLogs();
                        if (after !== c) console.log(`🧹 [history] logs (maxRows): ${c} → ${after} (max=${maxRows})`);
                    } catch (_) {}
                }
            }
        } catch (_) {}
    };
    let intervalMs = 5 * 60 * 1000;
    try {
        intervalMs = require('../history/store').getHistoryLimits().intervalMs;
    } catch (_) {}
    runTrim(true);
    logsTrimTimer = setInterval(() => runTrim(false), intervalMs);
    if (logsTrimTimer.unref) logsTrimTimer.unref();
    return true;
}

function init(config) {
    // Histórico primeiro: dono é src/history/store.js, independe do painel.
    try { ensureLogsTrimLoop(); } catch (_) {}
    if (config && config.dashboardEnabled === false) return null;

    const port = (config && config.dashboardPort) || 3000;
    const app = express();
    const server = http.createServer(app);

    startAccessLog();
    app.use(accessLogMiddleware);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });
    app.use(express.json({ limit: '20mb' }));

    adminAuth.ensureDefault();
    adminAuth.startSessionRotation();
    app.set('trust proxy', 1);
    app.use(cookieSession({
        name: 'admin_session',
        keys: adminAuth.getSessionKeys(),
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: false
    }));

    const { readConfig, writeConfig, getVersion, readStats } = require('../database/utils');
    const isAdmin = (req) => req.session && req.session.adminUser;
    const json = (res, ok, data = {}, status = 200) => res.status(status).json({ ok, ...data });

    app.post('/api/admin/login', (req, res) => {
        const { username, password } = req.body || {};
        const ip = getClientIp(req, true) || req.ip || 'unknown';
        const ua = req.headers['user-agent'] || '';
        if (!username || !password || !adminAuth.verify(username, password)) {
            insertDashboardVisit(username || 'unknown', ip, ua);
            return json(res, false, { error: 'Credenciais inválidas' }, 401);
        }
        req.session.adminUser = String(username);
        insertDashboardVisit(username, ip, ua);
        return json(res, true, { username });
    });

    app.post('/api/admin/logout', (req, res) => {
        if (req.session) req.session = null;
        return json(res, true);
    });

    app.post('/api/admin/credentials', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        const { username, password } = req.body || {};
        if (!username || !password || password.length < 4) {
            return json(res, false, { error: 'Usuário e senha (mín. 4 chars) obrigatórios' }, 400);
        }
        if (adminAuth.setCredentials(username, password)) return json(res, true);
        return json(res, false, { error: 'Erro ao salvar' }, 500);
    });

    require('./mgmt')(app, { isAdmin, json });

    app.get('/api/admin/config', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const cfg = readConfig();
            const stats = readStats();
            return json(res, true, {
                config: { ...cfg, openrouterApiKey: cfg.openrouterApiKey ? '••••••••' : '' },
                hasApiKey: !!cfg.openrouterApiKey,
                botName: cfg.botName,
                version: getVersion(),
                platform: process.platform,
                restarts: stats.restarts,
                nodeVersion: process.version
            });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.post('/api/admin/env-key', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const { key } = req.body || {};
            const trimmedKey = (typeof key === 'string' ? key : '').trim();
            const envPath = require('path').join(process.cwd(), '.env');
            let envContent = '';
            try { envContent = require('fs').readFileSync(envPath, 'utf8'); } catch (_) {}
            const lines = envContent.split(/\r?\n/);
            const idx = lines.findIndex(l => l.startsWith('OPENROUTER_API_KEY='));
            if (trimmedKey) {
                const newLine = `OPENROUTER_API_KEY=${trimmedKey}`;
                if (idx >= 0) lines[idx] = newLine;
                else lines.push(newLine);
                process.env.OPENROUTER_API_KEY = trimmedKey;
            } else {
                if (idx >= 0) lines.splice(idx, 1);
                delete process.env.OPENROUTER_API_KEY;
            }
            require('fs').writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
            try {
                const { setupAI } = require('../services/ai');
                const { readConfig } = require('../database/utils');
                setupAI(readConfig());
            } catch (_) {}
            return json(res, true, { ok: true });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.put('/api/admin/config', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const { updates } = req.body || {};
            if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
                return json(res, false, { error: 'Body precisa ter { updates: { key: value } }' }, 400);
            }
            writeConfig({ ...readConfig(), ...updates });
            return json(res, true, { updated: Object.keys(updates).length });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/logs', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            return json(res, true, { logs: terminalLog.getLast(15) });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/ai-usage', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const { getUsageStats } = require('../services/ai');
            const stats = getUsageStats();
            return json(res, true, { usage: stats });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.post('/api/admin/ai-usage', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const { resetUsageStats } = require('../services/ai');
            resetUsageStats();
            return json(res, true, { ok: true });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/active-users', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const minutes = Math.max(5, Math.min(1440, Number(req.query.minutes) || 60));
            const users = require('../database/utils').getActiveUsers(minutes);
            return json(res, true, { users, minutes });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/connection-status', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            return json(res, true, getConnectionState());
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/connection-status', (req, res) => {
        try {
            const cfg = safe(() => require('../database/utils').readConfig(), {});
            return json(res, true, {
                ...getConnectionState(),
                dashboardShowQR: cfg && cfg.dashboardShowQR === true,
                dashboardChatBlocked: cfg && cfg.dashboardChatBlocked === true
            });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/qr-status', (req, res) => {
        if (!qrControlAllowed(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const ctrl = global.__qrControl;
            return json(res, true, {
                attempts: ctrl ? ctrl.getAttempts() : 0,
                maxAttempts: ctrl ? ctrl.getMaxAttempts() : 3,
                stopped: ctrl ? ctrl.getAttempts() >= ctrl.getMaxAttempts() : false
            });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    function qrControlAllowed(req) {
        if (isAdmin(req)) return true;
        try {
            const cfg = safe(() => require('../database/utils').readConfig(), {});
            return cfg && cfg.dashboardShowQR === true;
        } catch (_) { return false; }
    }

    app.post('/api/admin/stop-qr', (req, res) => {
        if (!qrControlAllowed(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            if (global.__qrControl) global.__qrControl.stopRetrying();
            return json(res, true, { ok: true });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.post('/api/admin/reset-qr', (req, res) => {
        if (!qrControlAllowed(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            if (global.__qrControl) global.__qrControl.resetAttempts();
            return json(res, true, { ok: true });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    app.get('/api/admin/visit-history', (req, res) => {
        if (!isAdmin(req)) return json(res, false, { error: 'Não autenticado' }, 401);
        try {
            const limit = Math.max(10, Math.min(500, Number(req.query.limit) || 100));
            const visits = require('../database/utils').getVisitHistory(limit);
            return json(res, true, { visits, limit });
        } catch (e) { return json(res, false, { error: e.message }, 500); }
    });

    function isChatBlocked() {
        try {
            const cfg = safe(() => require('../database/utils').readConfig(), {});
            return cfg && cfg.dashboardChatBlocked === true;
        } catch (_) { return false; }
    }

    app.post('/api/reply', (req, res, next) => {
        if (isChatBlocked()) return res.status(503).json({ ok: false, error: 'Chat do dashboard bloqueado pelo admin' });
        if (!rateLimit(req)) return res.status(429).json({ ok: false, error: 'Muitas requisições. Aguarde alguns segundos.' });
        next();
    }, apiHandler(sendReply));
    app.post('/api/send', (req, res, next) => {
        if (isChatBlocked()) return res.status(503).json({ ok: false, error: 'Chat do dashboard bloqueado pelo admin' });
        if (!rateLimit(req)) return res.status(429).json({ ok: false, error: 'Muitas requisições. Aguarde alguns segundos.' });
        next();
    }, apiHandler(sendDirect));
    app.get('/api/groups', async (req, res) => {
        try {
            if (!sockRef) return res.json({ ok: true, groups: [] });
            const list = await getGroupsSnapshot();
            res.json({ ok: true, groups: list });
        } catch (e) {
            console.error('[dashboard] /api/groups:', e?.message || e);
            res.status(500).json({ ok: false, error: 'Erro interno' });
        }
    });
    app.get('/api/health', (req, res) => {
        try {
            const wd = require('../services/watchdog');
            const st = wd.getState();
            const wsOk = st.wsReadyState === 1;
            const alive = !!sockRef && wsOk && !st.isZombie;
            // legado: ok true apenas se realmente vivo; se isZombie, 503
            if (!alive) {
                return res.status(503).json({
                    ok: false,
                    connected: !!sockRef,
                    wsState: st.wsState,
                    wsReadyState: st.wsReadyState,
                    isZombie: st.isZombie,
                    idleMs: st.idleMs,
                    idleMin: Math.round(st.idleMs/60000),
                    thresholdMs: st.threshold,
                    lastUpsertAt: st.lastUpsertAt,
                    queue: st.queue
                });
            }
            return res.json({
                ok: true,
                connected: true,
                wsState: st.wsState,
                isZombie: false,
                idleMs: st.idleMs,
                lastUpsertAt: st.lastUpsertAt,
                queue: st.queue
            });
        } catch (_) {
            return res.json({ ok: !!sockRef, fallback: true });
        }
    });

    // Endpoint simples para uptime externo que só checa sock (legado)
    app.get('/api/health/simple', (req, res) => res.json({ ok: !!sockRef }));

    // Teste telegram (admin only)
    app.post('/api/admin/telegram-test', (req, res) => {
        if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'Não autenticado' });
        const tg = require('../services/telegramAlerts');
        tg.test().then(r => res.json(r)).catch(e => res.status(500).json({ ok:false, error: e.message }));
    });
    app.get('/api/admin/watchdog', (req, res) => {
        if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'Não autenticado' });
        try {
            const wd = require('../services/watchdog');
            return res.json({ ok:true, ...wd.getState() });
        } catch (e) { return res.status(500).json({ ok:false, error: e.message }); }
    });

    const FILES_DIRS = [
        { root: path.join(process.cwd(), 'logs'), label: 'logs', includeExts: /\.(log|txt|json|csv)$/i },
        { root: path.join(process.cwd(), 'temp'), label: 'temp', includeExts: /\.(zip|txt|json|csv|log|tar|gz|7z|rar|pdf|webp|png|jpg|jpeg|mp4|webm|opus|mp3|m4a)$/i }
    ];

    function listDumpFiles() {
        const out = [];
        for (const dir of FILES_DIRS) {
            let entries = [];
            try {
                if (!fs.existsSync(dir.root)) continue;
                entries = fs.readdirSync(dir.root, { withFileTypes: true })
                    .filter(d => d.isFile())
                    .filter(d => !d.name.startsWith('.') && d.name !== 'dashboard_media');
            } catch (_) { continue; }
            for (const ent of entries) {
                try {
                    const full = path.join(dir.root, ent.name);
                    if (dir.includeExts && !dir.includeExts.test(ent.name)) continue;
                    const stat = fs.statSync(full);
                    const resolved = path.resolve(full);
                    const logsRoot = path.resolve(FILES_DIRS[0].root);
                    const tempRoot = path.resolve(FILES_DIRS[1].root);
                    const safeBase = resolved.startsWith(logsRoot) ? logsRoot : (resolved.startsWith(tempRoot) ? tempRoot : null);
                    if (!safeBase) continue;
                    out.push({
                        name: ent.name,
                        dir: dir.label,
                        sizeBytes: stat.size,
                        sizeKb: Math.max(1, Math.round(stat.size / 1024)),
                        mtime: stat.mtimeMs,
                        downloadUrl: `/api/files/download/${encodeURIComponent(ent.name)}?dir=${encodeURIComponent(dir.label)}`
                    });
                } catch (_) {}
            }
        }
        out.sort((a, b) => b.mtime - a.mtime);
        return out.slice(0, 50);
    }

    app.get('/api/files', (req, res) => {
        try { res.json({ ok: true, files: listDumpFiles() }); }
        catch (e) { console.error('[dashboard] /api/files:', e?.message || e); res.status(500).json({ ok: false, error: 'Erro interno' }); }
    });

    app.get('/api/files/download/:name', (req, res) => {
        try {
            const name = String(req.params.name || '');
            if (!/^[A-Za-z0-9._\-]+$/.test(name)) return res.status(400).end();
            const dirLabel = String(req.query.dir || 'logs');
            const dirCfg = FILES_DIRS.find(d => d.label === dirLabel);
            if (!dirCfg) return res.status(404).end();
            const full = path.join(dirCfg.root, name);
            const resolved = path.resolve(full);
            const root = path.resolve(dirCfg.root);
            if (!resolved.startsWith(root + path.sep) && resolved !== root) return res.status(403).end();
            if (!fs.existsSync(resolved)) return res.status(404).end();
            const stat = fs.statSync(resolved);
            if (!stat.isFile()) return res.status(404).end();
            res.setHeader('Content-Length', stat.size);
            const safeName = name.replace(/[\r\n"\\]/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
            fs.createReadStream(resolved).pipe(res);
        } catch (e) {
            res.status(500).end();
        }
    });
    app.get('/api/system', (req, res) => {
        try {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const mem = {
                totalBytes: totalMem,
                usedBytes: usedMem,
                freeBytes: freeMem,
                usedPct: totalMem > 0 ? (usedMem / totalMem) * 100 : 0
            };
            const cpu = readCpuUsage();
            const procMem = process.memoryUsage();
            const proc = {
                rssBytes: procMem.rss || 0,
                heapUsedBytes: procMem.heapUsed || 0,
                heapTotalBytes: procMem.heapTotal || 0
            };
            const upMs = Date.now() - processStartTime;
            const days = Math.floor(upMs / (24 * 3600 * 1000));
            const hrs = Math.floor((upMs % (24 * 3600 * 1000)) / 3600000);
            const mins = Math.floor((upMs % 3600000) / 60000);
            const secs = Math.floor((upMs % 60000) / 1000);
            const uptimeStr = `${days}d ${hrs}h ${mins}m ${secs}s`;

            let totalGroups = 0;
            let activeGroups = 0;
            let partialGroups = 0;
            let totalCommands = 0;
            let totalRestarts = 0;
            try {
                const utils = require('../database/utils');
                totalCommands = (utils.readStats() || {}).totalCommands || 0;
                totalRestarts = (utils.readStats() || {}).restarts || 0;
                const ag = (utils.listActiveGroups() || []).length;
                const pg = (utils.listPartialGroups() || []).length;
                activeGroups = ag;
                partialGroups = pg;
                totalGroups = ag + pg;
            } catch (_) {}

            let watchdogState = null;
            try { watchdogState = require('../services/watchdog').getState(); } catch (_) {}
            let queueState = null;
            try { queueState = require('../services/queue').queueSize(); } catch (_) {}
            res.json({
                ok: true,
                host: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                cpuModel: (os.cpus()[0] || {}).model || 'unknown',
                nodeVersion: process.version,
                pid: process.pid,
                uptimeMs: upMs,
                uptimeStr,
                cpu,
                memory: mem,
                process: proc,
                watchdog: watchdogState,
                queue: queueState,
                bot: {
                    connected: !!sockRef,
                    wsState: watchdogState?.wsState || null,
                    isZombie: !!watchdogState?.isZombie,
                    idleMs: watchdogState?.idleMs || 0,
                    lastUpsertAt: watchdogState?.lastUpsertAt || null,
                    totalGroups,
                    activeGroups,
                    partialGroups,
                    totalCommands,
                    totalRestarts
                }
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    const downloadRateLimitMap = new Map();
    const DL_RATE_WINDOW = 60 * 1000;
    const DL_RATE_MAX = 20;
    function downloadRateLimit(req) {
        const key = req.ip || req.connection?.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = downloadRateLimitMap.get(key);
        if (!entry || (now - entry.windowStart) > DL_RATE_WINDOW) {
            entry = { windowStart: now, count: 0 };
            downloadRateLimitMap.set(key, entry);
        }
        entry.count++;
        return entry.count <= DL_RATE_MAX;
    }
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of downloadRateLimitMap) {
            if ((now - entry.windowStart) > DL_RATE_WINDOW * 2) downloadRateLimitMap.delete(key);
        }
    }, DL_RATE_WINDOW);

    app.post('/api/download', (req, res, next) => {
        if (!downloadRateLimit(req)) return res.status(429).json({ ok: false, error: 'Muitos downloads. Aguarde alguns segundos.' });
        next();
    }, async (req, res) => {
        try {
            const { url, hd, fmt, lang } = req.body || {};
            if (!url) return json(res, false, { error: 'URL é obrigatória' }, 400);
            const result = await webDownloader.downloadMedia(url, !!hd, fmt || 'mp4', lang);
            if (result.cached) {
                return json(res, true, {
                    cached: true,
                    filename: result.filename,
                    mime: result.mime,
                    size: result.size
                });
            }
            return json(res, true, {
                cached: false,
                files: result.files
            });
        } catch (e) {
            return json(res, false, { error: e.message }, 400);
        }
    });

    function serveCachedFile(filename, asDownload, req, res) {
        if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename)) return res.status(400).end();
        const filePath = path.join(webDownloader.CACHE_DIR, filename);
        const resolved = path.resolve(filePath);
        const cacheRoot = path.resolve(webDownloader.CACHE_DIR);
        if (!resolved.startsWith(cacheRoot)) return res.status(403).end();
        if (!require('fs').existsSync(resolved)) return res.status(404).end();
        const mime = webDownloader.getFileMime ? webDownloader.getFileMime(filePath) : 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (asDownload) {
            res.setHeader('Content-Disposition', 'attachment; filename="' + filename.replace(/"/g, '') + '"');
        }
        require('fs').createReadStream(resolved).pipe(res);
    }

    app.get('/api/download-cache/:filename', (req, res) => {
        try { serveCachedFile(req.params.filename, false, req, res); }
        catch (e) { res.status(500).end(); }
    });

    app.get('/api/download-cache/:filename/download', (req, res) => {
        try { serveCachedFile(req.params.filename, true, req, res); }
        catch (e) { res.status(500).end(); }
    });

    app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint nao encontrado' }));
    app.get('/theme.css', (req, res) => res.type('css').sendFile(path.join(__dirname, 'theme.css')));
    app.get('/dashboard.css', (req, res) => res.type('css').sendFile(path.join(__dirname, 'dashboard.css')));
    app.get('/pwa-manifest.json', (req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.sendFile(path.join(__dirname, 'pwa-manifest.json'));
    });
    app.get('/sw.js', (req, res) => {
        res.type('application/javascript');
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(__dirname, 'sw.js'));
    });
    app.get('/media/pwa-icon-192.png', (req, res) => {
        const p = path.join(__dirname, '..', 'media', 'pwa-icon-192.png');
        if (fs.existsSync(p)) return res.type('image/png').sendFile(p);
        res.status(404).end();
    });
    app.get('/media/pwa-icon-512.png', (req, res) => {
        const p = path.join(__dirname, '..', 'media', 'pwa-icon-512.png');
        if (fs.existsSync(p)) return res.type('image/png').sendFile(p);
        res.status(404).end();
    });
    app.get('/admin.js', (req, res) => {
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'admin.js'));
    });
    app.get('/configDocs.js', (req, res) => {
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'configDocs.js'));
    });
    app.get('/dashboard-client.js', (req, res) => {
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'client', 'index.js'));
    });
    app.get('/dashboard-client/:name', (req, res) => {
        const name = String(req.params.name || '');
        if (!/^[a-zA-Z0-9_\-]+\.js$/.test(name)) return res.status(400).end();
        const file = path.join(__dirname, 'client', name);
        if (!fs.existsSync(file)) return res.status(404).end();
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(file);
    });
    app.get('/media/favcon.png', (req, res) => {
        const p = path.join(__dirname, '..', 'media', 'favcon.png');
        if (require('fs').existsSync(p)) {
            res.type('image/png').sendFile(p);
        } else {
            res.status(404).end();
        }
    });

    app.get('/media/:id', (req, res) => {
        const id = req.params.id;
        const data = readPersistedMedia(id);
        if (!data) return res.status(404).end();
        res.setHeader('Content-Type', data.mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.query.download) {
            res.setHeader('Content-Disposition', `attachment; filename="${(data.fileName || id).replace(/"/g, '')}"`);
        }
        res.end(data.buffer);
    });
    app.get('/favicon.ico', (req, res) => {
        const mediaDir = path.join(__dirname, '..', 'media');
        const candidates = ['favcon.png', 'favcon.jpg', 'favcon.ico'];
        for (const name of candidates) {
            const full = path.join(mediaDir, name);
            if (fs.existsSync(full)) {
                const ext = name.split('.').pop().toLowerCase();
                const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
                res.setHeader('Content-Type', mime);
                res.setHeader('Cache-Control', 'public, max-age=300');
                return res.sendFile(full);
            }
        }
        res.status(204).end();
    });
    const adminHtml = path.join(__dirname, 'admin.html');
    app.get('/admin', (req, res) => {
        if (!(req.session && req.session.adminUser)) return res.redirect('/admin/login');
        const ip = getClientIp(req, true) || req.ip || 'unknown';
        const ua = req.headers['user-agent'] || '';
        insertDashboardVisit(req.session.adminUser, ip, ua);
        res.type('html').sendFile(adminHtml);
    });
    app.get('/admin/login', (req, res) => {
        const ip = getClientIp(req, true) || req.ip || 'unknown';
        const ua = req.headers['user-agent'] || '';
        insertDashboardVisit('visitante', ip, ua);
        res.type('html').sendFile(adminHtml);
    });
    app.get('/', (req, res) => {
        res.type('html').sendFile(path.join(__dirname, 'menu.html'));
    });

    app.get('/dashboard', (req, res) => {
        const ip = getClientIp(req, true) || req.ip || 'unknown';
        const ua = req.headers['user-agent'] || '';
        const user = (req.session && req.session.adminUser) || 'visitante';
        insertDashboardVisit(user, ip, ua);
        res.type('html').send(getHtml(config.botName || 'Bot'));
    });

    app.get('/baixar', (req, res) => {
        res.type('html').sendFile(path.join(__dirname, 'downloader.html'));
    });

    app.get('/download', (req, res) => {
        res.redirect('/');
    });
    app.use((err, req, res, next) => {
        const status = err?.type === 'entity.too.large' ? 413 : 400;
        const error = status === 413 ? 'Arquivo muito grande para enviar pelo dashboard' : 'JSON invalido';
        res.status(status).json({ ok: false, error });
    });

    ioServer = new Server(server, {
        cors: { origin: (origin, cb) => cb(null, !origin || origin.startsWith('http://localhost') || origin.startsWith('https://localhost')), credentials: true },
        transports: ['polling', 'websocket'],
        allowUpgrades: true,
        pingTimeout: 60000,
        pingInterval: 25000,
        upgradeTimeout: 30000,
        serveClient: true,
        path: '/socket.io'
    });
    ioServer.engine.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });
    ioServer.on('connection', async (socket) => {
        try {
            const cfg = safe(() => require('../database/utils').readConfig(), {});
            socket.emit('connection:update', {
                ...getConnectionState(),
                dashboardShowQR: cfg && cfg.dashboardShowQR === true,
                dashboardChatBlocked: cfg && cfg.dashboardChatBlocked === true
            });
        } catch (_) {}
        try {
            const history = loadDashboardHistory({ limit: HISTORY_SEND_LIMIT });
            const CHUNK = 15;
            if (history.length <= CHUNK) {
                socket.emit('history', history);
            } else {
                socket.emit('history:start', { total: history.length });
                for (let i = 0; i < history.length; i += CHUNK) {
                    socket.emit('history:chunk', history.slice(i, i + CHUNK));
                }
                socket.emit('history:end', { total: history.length });
            }
        } catch (_) {}
        try {
            const cachedGroups = groupsSnapshotCache && Date.now() - groupsSnapshotCache.at < GROUPS_CACHE_TTL
                ? groupsSnapshotCache.list
                : null;
            if (cachedGroups) {
                socket.emit('groups', cachedGroups);
                socket.emit('groups:ready', true);
            } else {
                const quick = await getGroupsSnapshot({ force: false });
                groupsSnapshotCache = { list: quick, at: Date.now() };
                socket.emit('groups', quick);
                socket.emit('groups:ready', true);
                const cachedSet = new Set(quick.map(g => g.jid));
                const items = groupsApi ? await groupsApi() : [];
                const enrichTasks = [];
                for (const item of items) {
                    const jid = typeof item === 'string' ? item : item?.jid;
                    if (!jid || cachedSet.has(jid)) continue;
                    enrichTasks.push(getGroupInfo(jid, false));
                }
                if (enrichTasks.length) {
                    Promise.all(enrichTasks).then(async () => {
                        try {
                            const fresh = await getGroupsSnapshot({ force: false });
                            groupsSnapshotCache = { list: fresh, at: Date.now() };
                            ioServer.emit('groups', fresh);
                        } catch (_) {}
                    }).catch(() => {});
                }
            }
        } catch (_) {}
    });

    try {
        httpServer = server;
        // Espelho do histórico: a camada src/history/store.js é a escritora
        // oficial; o painel só recebe eventos em tempo real (leitura).
        // Direção da dependência: dashboard -> history (nunca o inverso).
        try {
            require('../history/store').setMirror((payload) => {
                if (!ioServer) return;
                try {
                    if (payload && payload.kind === 'msg' && payload.log && shouldEmit(payload.log)) {
                        ioServer.emit('msg', payload.log);
                    } else if (payload && payload.kind === 'media:update') {
                        ioServer.emit('media:update', { toJid: payload.toJid, messageId: payload.messageId, type: payload.type, media: payload.media });
                    } else if (payload && payload.kind === 'reaction') {
                        ioServer.emit('reaction', { targetId: payload.messageId, targetJid: payload.toJid, targetType: payload.type, emoji: payload.emoji, senderJid: payload.senderJid, senderName: payload.senderName, reactions: payload.reactions });
                    }
                } catch (_) {}
            });
        } catch (_) {}
        const publicUrl = String(config?.dashboardUrl || '').replace(/\/+$/, '');
        ensureMediaDir();
        try { migrateInlineMedia(); } catch (_) {}
        server.listen(port, '0.0.0.0', () => {
            console.log(`[dashboard] ativo em http://localhost:${port}`);
            if (publicUrl) console.log(`[dashboard] url pública: ${publicUrl}`);
        });
        groupsRefreshTimer = setInterval(() => {
            pushGroupsSnapshot({ force: false }).catch(() => {});
        }, 10 * 60 * 1000);
        if (groupsRefreshTimer.unref) groupsRefreshTimer.unref();

        // Trim do histórico é independente do painel (ver ensureLogsTrimLoop,
        // já iniciado no init mesmo com dashboard desligado).
        try { ensureLogsTrimLoop(); } catch (_) {}
    } catch (e) {
        console.error('[dashboard] falha ao iniciar HTTP:', e.message);
    }
    return ioServer;
}

async function isJidAllowed(jid) {
    if (!jid || typeof jid !== 'string') return false;
    try {
        if (groupsSnapshotCache && Array.isArray(groupsSnapshotCache.list)) {
            if (groupsSnapshotCache.list.some(g => g && g.jid === jid)) return true;
        }
    } catch (_) {}
    try {
        if (groupsApi) {
            const items = await groupsApi();
            if (Array.isArray(items) && items.some(it => {
                const id = typeof it === 'string' ? it : it?.jid;
                return id === jid;
            })) return true;
        }
    } catch (_) {}
    return false;
}

function apiHandler(fn) {
    return async (req, res) => {
        try {
            const r = await fn(req.body || {});
            res.status(r && r.ok ? 200 : 400).json(r);
        } catch (e) {
            console.error('[dashboard] api error:', e?.stack || e?.message || e);
            const msg = e?.message || 'Erro interno';
            if (msg.includes('Timeout')) {
                res.status(504).json({ ok: false, error: msg });
            } else {
                res.status(500).json({ ok: false, error: msg });
            }
        }
    };
}

// ============================================================
// Rate limiter for API endpoints
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 10 * 1000;
const RATE_LIMIT_MAX = 10;

function rateLimit(req) {
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(key);
    if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW) {
        entry = { windowStart: now, count: 0 };
        rateLimitMap.set(key, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
}

// Prevent unbounded growth of IP entries
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if ((now - entry.windowStart) > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(key);
    }
}, RATE_LIMIT_WINDOW);

function startAccessLog() {
    try {
        const dir = path.join(process.cwd(), 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'access.log');
        accessLogStream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        console.log(`[dashboard] access log → ${file}`);
    } catch (e) {
        console.error('[dashboard] falha ao abrir access log:', e.message);
        accessLogStream = null;
    }
}

function getClientIp(req, trustProxy) {
    try {
        if (trustProxy) {
            const xf = req.headers['x-forwarded-for'];
            if (typeof xf === 'string' && xf.length > 0) {
                return xf.split(',')[0].trim();
            }
        }
        return req.socket?.remoteAddress || req.ip || null;
    } catch (_) { return null; }
}

function accessLogMiddleware(req, res, next) {
    const start = Date.now();
    const trustProxy = !!(req.app && req.app.get && req.app.get('trust proxy'));
    const ip = getClientIp(req, trustProxy) || '-';
    const ua = (req.headers['user-agent'] || '-').toString().replace(/[\r\n\t]+/g, ' ');
    const referer = (req.headers['referer'] || req.headers['referer'] || '-').toString().replace(/[\r\n\t]+/g, ' ');
    res.on('finish', () => {
        if (!accessLogStream) return;
        const ts = new Date().toISOString();
        const line = `[${ts}] ${ip} ${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${Date.now() - start}ms ua="${ua}" ref="${referer}"\n`;
        try { accessLogStream.write(line); } catch (_) {}
    });
    next();
}

function buildQuotedPayload(quotedId, quotedParticipant, cached, fallbackText) {
    let label = fallbackText || 'Mensagem';
    if (cached) {
        if (cached.text) label = cached.text;
        else if (cached.type === 'image') label = '📷 Foto';
        else if (cached.type === 'video') label = '🎥 Vídeo';
        else if (cached.type === 'audio') label = '🎵 Áudio';
        else if (cached.type === 'sticker') label = '🏷️ Sticker';
        else if (cached.type === 'document') label = '📎 ' + (cached.fileName || 'Documento');
    }
    return {
        key: { remoteJid: '__jid__', id: quotedId, participant: quotedParticipant || undefined },
        message: { conversation: label }
    };
}

function getBotPhone() {
    try { return (sockRef?.user?.id || sockRef?.user?.jid || 'bot').split(':')[0].split('@')[0]; }
    catch (_) { return 'bot'; }
}

function getMediaLabel(type) {
    if (type === 'image') return 'Foto';
    if (type === 'video') return 'Video';
    if (type === 'audio') return 'Audio';
    if (type === 'sticker') return 'Sticker';
    if (type === 'document') return 'Documento';
    return 'Midia';
}

function mediaForLog(media) {
    if (!media || !media.dataBase64) return null;
    const sendType = media.sendType || media.type || 'document';
    const mime = media.mime || (sendType === 'sticker' ? 'image/webp' : 'application/octet-stream');
    if (!['image', 'video', 'audio', 'voice', 'sticker'].includes(sendType)) return null;
    return { type: sendType, url: `data:${mime};base64,${media.dataBase64}` };
}

function mediaForLogSent(media, messageId) {
    if (!media || !media.dataBase64) return null;
    const sendType = media.sendType || media.type || 'document';
    const mime = media.mime || (sendType === 'sticker' ? 'image/webp' : 'application/octet-stream');
    if (!['image', 'video', 'audio', 'voice', 'sticker'].includes(sendType)) return null;
    if (messageId) {
        try {
            persistMedia(messageId, media.dataBase64, mime);
            return { type: sendType, url: `/media/${encodeURIComponent(messageId)}`, mime, fileName: media.fileName || null };
        } catch (_) {}
    }
    return { type: sendType, url: `data:${mime};base64,${media.dataBase64}`, mime, fileName: media.fileName || null };
}

function mediaForLogReceived(media, messageId) {
    if (!media) return null;
    const type = media.type;
    if (!['image', 'video', 'audio', 'voice', 'sticker', 'document'].includes(type)) return null;
    if (media.url && media.url.startsWith('data:') && messageId) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(media.url);
        if (m) {
            try {
                const fileName = media.fileName || (type === 'document' ? 'documento' : null);
                const mime = m[1];
                const buf = Buffer.from(m[2], 'base64');
                persistMedia(messageId, m[2], mime);
                return {
                    type,
                    url: `/media/${encodeURIComponent(messageId)}`,
                    mime,
                    fileName,
                    sizeBytes: media.sizeBytes || buf.length
                };
            } catch (_) {}
        }
    }
    return media;
}

const MEDIA_DIR = path.join(__dirname, '..', '..', 'temp', 'dashboard_media');
function ensureMediaDir() {
    try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (_) {}
}
function persistMedia(messageId, dataBase64, mime) {
    if (!messageId || !dataBase64) return null;
    try {
        ensureMediaDir();
        const safeId = String(messageId).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const ext = (mime || '').split('/')[1] || 'bin';
        const file = path.join(MEDIA_DIR, `${safeId}.${ext}`);
        const buf = Buffer.from(dataBase64, 'base64');
        fs.writeFileSync(file, buf);
        return file;
    } catch (_) { return null; }
}
function readPersistedMedia(messageId) {
    if (!messageId) return null;
    try {
        ensureMediaDir();
        const files = fs.readdirSync(MEDIA_DIR);
        const safeId = String(messageId).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const EXT_TO_MIME = {
            jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
            mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska',
            mp3:'audio/mpeg', ogg:'audio/ogg', opus:'audio/ogg', m4a:'audio/mp4', wav:'audio/wav',
            pdf:'application/pdf', zip:'application/zip', '7z':'application/x-7z-compressed',
            rar:'application/vnd.rar', tar:'application/x-tar', gz:'application/gzip',
            txt:'text/plain', json:'application/json', csv:'text/csv', log:'text/plain',
            doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt:'application/vnd.ms-powerpoint', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        };
        for (const f of files) {
            if (f.startsWith(safeId + '.')) {
                const full = path.join(MEDIA_DIR, f);
                const buf = fs.readFileSync(full);
                const ext = (f.split('.').pop() || '').toLowerCase();
                const mime = EXT_TO_MIME[ext] || 'application/octet-stream';
                return { buffer: buf, mime, fileName: f };
            }
        }
    } catch (_) {}
    return null;
}

function migrateInlineMedia() {
    try {
        ensureMediaDir();
        const rows = selectDashboardLogsWithInlineMedia(1000);
        let migrated = 0;
        for (const row of rows) {
            try {
                const media = JSON.parse(row.media_json);
                if (!media || !media.url || !media.url.startsWith('data:')) continue;
                const m = /^data:([^;]+);base64,(.+)$/.exec(media.url);
                if (!m) continue;
                const mime = m[1];
                const b64 = m[2];
                if (row.message_id) {
                    persistMedia(row.message_id, b64, mime);
                    const newMedia = { ...media };
                    newMedia.url = `/media/${encodeURIComponent(row.message_id)}`;
                    newMedia.mime = mime;
                    updateDashboardLogMedia(row.to_jid, row.message_id, row.type, JSON.stringify(newMedia));
                    migrated++;
                }
            } catch (_) {}
        }
        if (migrated > 0) console.log(`🧹 [dashboard] migrou ${migrated} mídia(s) inline para disco`);
    } catch (e) {
        console.error('[dashboard] migrateInlineMedia:', e?.message || e);
    }
}

function mediaForLogRef(media, messageId) {
    if (!media || !media.dataBase64) return null;
    const sendType = media.sendType || media.type || 'document';
    const mime = media.mime || (sendType === 'sticker' ? 'image/webp' : 'application/octet-stream');
    if (!['image', 'video', 'audio', 'voice', 'sticker'].includes(sendType)) return null;
    if (messageId) {
        try {
            const pathOnDisk = persistMedia(messageId, media.dataBase64, mime);
            if (pathOnDisk) return { type: sendType, url: `/media/${encodeURIComponent(messageId)}`, mime, fileName: media.fileName || null };
        } catch (_) {}
    }
    return { type: sendType, url: `data:${mime};base64,${media.dataBase64}`, mime, fileName: media.fileName || null };
}

async function sendMediaMessage(toJid, text, media, opts = {}, contextExtras = {}) {
    const buf = Buffer.from(media.dataBase64, 'base64');
    const caption = text ? String(text).slice(0, 1024) : undefined;
    const sendType = media.sendType || media.type;

    if (sendType === 'image') {
        return sockRef.sendMessage(toJid, { image: buf, mimetype: media.mime || 'image/jpeg', caption, ...contextExtras }, opts);
    }
    if (sendType === 'video') {
        return sockRef.sendMessage(toJid, { video: buf, mimetype: media.mime || 'video/mp4', caption, gifPlayback: !!media.gif, ...contextExtras }, opts);
    }
    if (sendType === 'audio' || sendType === 'voice') {
        return sockRef.sendMessage(toJid, { audio: buf, mimetype: media.mime || 'audio/mp4', ptt: sendType === 'voice', ...contextExtras }, opts);
    }
    if (sendType === 'sticker') {
        const mime = media.mime || 'image/webp';
        const stickerBuffer = mime === 'image/webp'
            ? buf
            : await mediaToSticker(buf, mime, 'Dashboard', 'Bot');
        if (stickerBuffer.length > 1024 * 1024) return { ok: false, error: 'Sticker muito grande (>1MB)' };
        return sockRef.sendMessage(toJid, { sticker: stickerBuffer, ...contextExtras }, opts);
    }
    if (sendType === 'document') {
        return sockRef.sendMessage(toJid, { document: buf, mimetype: media.mime || 'application/octet-stream', fileName: media.fileName || 'arquivo', caption, ...contextExtras }, opts);
    }
    return { ok: false, error: 'Tipo de midia nao suportado: ' + sendType };
}

async function logSentMessage(toJid, text, media, sentId, quoted = null) {
    try {
        const mediaInfo = mediaForLogSent(media, sentId);
        const fallbackText = mediaInfo && !text ? `[${getMediaLabel(mediaInfo.type)}]` : '';
        log('chat', await getGroupName(toJid),
            text ? String(text).slice(0, 4096) : fallbackText,
            'Voce', getBotPhone(), mediaInfo,
            { toJid, messageId: sentId, senderJid: sockRef?.user?.id || sockRef?.user?.jid, fromMe: true, quoted });

        if (sentId && mediaInfo && media?.dataBase64) {
            cacheMedia(sentId, {
                bufferBase64: media.dataBase64,
                mime: media.mime || 'application/octet-stream',
                type: mediaInfo.type,
                fileName: media.fileName || null,
                text: text || null,
                fromJid: toJid
            });
        }
    } catch (e) {
        console.error('[dashboard] logSentMessage:', e.message);
    }
}

const SEND_TIMEOUT_MS = 30000;

function sendWithTimeout(target, content, opts = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout — WhatsApp não respondeu em ' + (SEND_TIMEOUT_MS / 1000) + 's')), SEND_TIMEOUT_MS);
        sockRef.sendMessage(target, content, opts).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
    });
}

async function buildContextExtras(toJid, ctxInfo) {
    if (!ctxInfo || (!ctxInfo.forwarded && !ctxInfo.mentionAll && !ctxInfo.hasCard && !ctxInfo.hasActionLink && !ctxInfo.hasFwdNewsletter)) return {};
    const extras = {};
    if (ctxInfo.forwarded) {
        extras.contextInfo = { forwardingScore: 999, isForwarded: true };
    }
    if (ctxInfo.mentionAll && sockRef) {
        try {
            const meta = await sockRef.groupMetadata(toJid);
            if (meta && Array.isArray(meta.participants)) {
                const jids = meta.participants.map(p => p.id).filter(Boolean);
                if (jids.length) extras.mentions = jids;
            }
        } catch (_) {}
    }
    if (ctxInfo.hasCard) {
        const card = {
            title: ctxInfo.cardTitle || '',
            body: ctxInfo.cardBody || '',
            mediaType: 1,
            thumbnailUrl: ctxInfo.cardThumb || '',
            sourceUrl: ctxInfo.cardUrl || '',
            mediaUrl: ctxInfo.cardUrl || '',
            renderLargerThumbnail: true
        };
        if (ctxInfo.cardThumb) {
            try {
                const resp = await axios.get(ctxInfo.cardThumb, { responseType: 'arraybuffer', timeout: 10000 });
                if (resp.status === 200 && resp.data) {
                    const sharp = require('sharp');
                    card.thumbnail = await sharp(Buffer.from(resp.data), { failOn: 'none' }).rotate().resize({ width: 300, height: 300, fit: 'cover', kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
                }
            } catch (_) {}
        }
        extras.contextInfo = extras.contextInfo || {};
        extras.contextInfo.externalAdReply = card;
    }
    if (ctxInfo.hasActionLink) {
        extras.contextInfo = extras.contextInfo || {};
        extras.contextInfo.actionLink = {
            url: ctxInfo.actionLinkUrl || '',
            buttonTitle: ctxInfo.actionLinkLabel || 'Saiba mais'
        };
    }
    if (ctxInfo.hasFwdNewsletter) {
        extras.contextInfo = extras.contextInfo || {};
        extras.contextInfo.isForwarded = true;
        extras.contextInfo.forwardedNewsletterMessageInfo = {
            newsletterJid: '0@newsletter',
            newsletterName: ctxInfo.fwdNewsletterName || 'Canal',
            serverMessageId: 0,
            contentType: 1
        };
    }
    return extras;
}

async function sendReply(payload) {
    if (!sockRef) return { ok: false, error: 'Bot não conectado' };
    const { toJid, text, quotedId, quotedParticipant, quotedFromMe, quotedText, media, contextInfo } = payload || {};
    if (!toJid) return { ok: false, error: 'Dados incompletos' };
    if (!await isJidAllowed(toJid)) return { ok: false, error: 'Grupo não autorizado' };

    const hasText = !!(text && String(text).trim().length > 0);
    const hasMedia = !!(media && media.dataBase64 && (media.type || media.sendType));
    if (!hasText && !hasMedia) return { ok: false, error: 'Mensagem vazia' };

    const opts = {};
    if (quotedId) {
        const cached = getCachedMedia(quotedId);
        const quotedSafe = buildQuotedPayload(quotedId, quotedParticipant, cached, quotedText);
        if (quotedSafe) {
            opts.quoted = {
                key: { remoteJid: toJid, id: quotedId, participant: quotedParticipant || undefined, fromMe: !!quotedFromMe },
                message: quotedSafe.message
            };
        }
    }

    const contextExtras = contextInfo ? await buildContextExtras(toJid, contextInfo) : {};
    if (contextInfo?.ephemeral) opts.ephemeralExpiration = 86400;

    const quotedLog = quotedId ? {
        text: quotedText || null,
        hasMedia: !!getCachedMedia(quotedId),
        senderJid: quotedParticipant || null,
        phone: quotedParticipant ? quotedParticipant.split('@')[0] : null,
        name: quotedFromMe ? 'Voce' : null
    } : null;

    try {
        const sent = hasMedia
            ? await sendMediaMessage(toJid, hasText ? text : '', media, opts, contextExtras)
            : await sendWithTimeout(toJid, { text: String(text).slice(0, 4096), ...contextExtras }, opts);
        if (sent?.ok === false) return sent;
        const sentId = sent && sent.key && sent.key.id;
        await logSentMessage(toJid, hasText ? text : '', hasMedia ? media : null, sentId, quotedLog);
        return { ok: true, messageId: sentId };
    } catch (sendErr) {
        console.error('[dashboard] sendReply:', sendErr?.message || sendErr);
        return { ok: false, error: sendErr?.message || 'Falha no envio' };
    }
}

async function sendDirect(payload) {
    if (!sockRef) return { ok: false, error: 'Bot não conectado' };
    const { toJid, text, media, contextInfo } = payload || {};
    if (!toJid) return { ok: false, error: 'Dados incompletos' };
    if (!await isJidAllowed(toJid)) return { ok: false, error: 'Grupo não autorizado' };

    const hasText = !!(text && String(text).trim().length > 0);
    const hasMedia = !!(media && media.dataBase64 && (media.type || media.sendType));
    if (!hasText && !hasMedia) return { ok: false, error: 'Mensagem vazia' };

    const opts = {};
    const contextExtras = contextInfo ? await buildContextExtras(toJid, contextInfo) : {};
    if (contextInfo?.ephemeral) opts.ephemeralExpiration = 86400;

    try {
        const sent = hasMedia
            ? await sendMediaMessage(toJid, hasText ? text : '', media, opts, contextExtras)
            : await sendWithTimeout(toJid, { text: String(text).slice(0, 4096), ...contextExtras }, opts);
        if (sent?.ok === false) return sent;
        const sentId = sent && sent.key && sent.key.id;
        await logSentMessage(toJid, hasText ? text : '', hasMedia ? media : null, sentId);
        return { ok: true, messageId: sentId };
    } catch (sendErr) {
        console.error('[dashboard] sendDirect:', sendErr?.message || sendErr);
        return { ok: false, error: sendErr?.message || 'Falha no envio' };
    }
}

async function getGroupName(jid) {
    if (!sockRef) return jid;
    if (!jid?.endsWith('@g.us')) return jid.split('@')[0] || jid;
    const info = await getGroupInfo({ jid }, true);
    return info?.subject || fallbackGroupSubject(jid);
}

function shouldEmit(data) {
    if (!data) return false;
    try {
        const cfg = safe(() => require('../database/utils').readConfig(), {});
        if (cfg && cfg.dashboardChatBlocked === true) return false;
    } catch (_) {}
    if (data.fromMe) return true;
    if (data.toJid && (data.toJid.endsWith('@g.us') || data.toJid.endsWith('@s.whatsapp.net') || data.toJid.endsWith('@c.us'))) return true;
    return false;
}

function log(type, group, text, name = null, phone = null, media = null, extra = {}) {
    try {
        try {
            const cfg = readConfig();
            if (cfg && cfg.dashboardMuted === true) return false;
        } catch (_) {}
        // Gera messageId determinístico a partir do conteúdo quando não vier,
        // para que o UNIQUE INDEX (to_jid, message_id, type) deduplique
        // logs idênticos (ex.: mensagens de ação geradas em sequência rápida).
        let messageId = extra.messageId || null;
        if (!messageId) {
            const seed = `${type}|${extra.toJid || ''}|${text || ''}|${extra.attachment?.fileName || ''}`;
            let h = 0;
            for (let i = 0; i < seed.length; i++) {
                h = (h * 31 + seed.charCodeAt(i)) | 0;
            }
            messageId = 'synthetic-' + (h >>> 0).toString(36);
        }
        const logData = {
            type,
            group: group || 'Sistema',
            text,
            name,
            phone,
            media,
            attachment: extra.attachment || null,
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            toJid: extra.toJid || null,
            messageId,
            quoted: extra.quoted || null,
            hidden: !!extra.hidden,
            ephemeral: !!extra.ephemeral,
            senderJid: extra.senderJid || null,
            fromMe: !!extra.fromMe,
            reactions: extra.reactions || undefined
        };

        try { insertDashboardLog(logData); } catch (_) {}

        if (ioServer && shouldEmit(logData)) {
            ioServer.emit('msg', logData);
        }
    } catch (e) {
        console.error('[dashboard] log:', e?.message || e);
    }
}

async function pushGroupsSnapshot(options = {}) {
    if (!ioServer) return;
    try {
        const now = Date.now();
        const wantsForce = !!options.force;
        const effectiveForce = wantsForce && (now - lastForceRefreshAt > FORCE_REFRESH_COOLDOWN_MS);
        if (wantsForce) lastForceRefreshAt = now;
        const list = await getGroupsSnapshot({ force: effectiveForce });
        groupsSnapshotCache = { list, at: Date.now() };
        ioServer.emit('groups', list);
    } catch (e) {
        console.error('[dashboard] pushGroupsSnapshot:', e?.message || e);
    }
}

function isBotConnected() { return !!sockRef; }

function emitMediaUpdate(toJid, messageId, type, mediaInfo) {
    if (!ioServer) return;
    try {
        ioServer.emit('media:update', { toJid, messageId, type, media: mediaInfo });
    } catch (_) {}
}

function handleReaction(targetId, emoji, senderJid, senderName) {
    try {
        const msg = getDashboardLogByMessageId(targetId);
        let targetJid = null;
        let targetType = null;
        let reactions = {};
        if (msg) {
            if (!msg.reactions) msg.reactions = {};
            if (emoji) {
                msg.reactions[senderJid] = emoji;
            } else {
                delete msg.reactions[senderJid];
            }
            targetJid = msg.toJid;
            targetType = msg.type;
            reactions = { ...msg.reactions };
            try { updateDashboardLogReactions(targetJid, targetId, targetType, msg.reactions); } catch (_) {}
        }
        if (ioServer) {
            ioServer.emit('reaction', { targetId, targetJid, targetType, emoji, senderJid, senderName, reactions });
        }
    } catch (e) {
        console.error('[dashboard] handleReaction:', e.message);
    }
}

let lastForceRefreshAt = 0;
const FORCE_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

let htmlTemplate = null;
function getHtml(botName) {
    if (!htmlTemplate) {
        try {
            htmlTemplate = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
        } catch (e) {
            htmlTemplate = '<!doctype html><html><body><h1>dashboard offline</h1></body></html>';
        }
    }
    const safeName = String(botName || 'Bot');
    return htmlTemplate
        .replaceAll('{{BOT_NAME}}', safeName)
        .replaceAll('{{BOT_NAME_ENCODED}}', encodeURIComponent(safeName));
}

let currentMaxLogs = 200;
function setMaxLogs(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) currentMaxLogs = v;
}

function resetDashboard() {
    let removedLogs = 0;
    let removedMediaFiles = 0;
    let removedTempFiles = 0;
    let removedLogsDirFiles = 0;
    try { removedLogs = clearDashboardLogs(); } catch (e) { console.error('[dashboard] reset clearLogs:', e.message); }
    try { mediaCache.clear(); } catch (_) {}
    // Limpa mídia persistida do dashboard (temp/dashboard_media/*)
    try {
        if (fs.existsSync(MEDIA_DIR)) {
            for (const f of fs.readdirSync(MEDIA_DIR)) {
                try { fs.unlinkSync(path.join(MEDIA_DIR, f)); removedMediaFiles++; } catch (_) {}
            }
        }
    } catch (_) {}
    // Limpa temp/ de órfãos: tudo que NÃO é cache ativo em uso.
    // Mantém: stk_* (sticker em processamento), dl_* (download em andamento),
    //         tts_*, speed_* (conversões em andamento).
    try {
        const tempRoot = path.join(process.cwd(), 'temp');
        const keepRe = /^(stk_|dl_|tts_|speed_|tts_)/i;
        if (fs.existsSync(tempRoot)) {
            for (const f of fs.readdirSync(tempRoot)) {
                if (f === 'dashboard_media') continue;
                if (keepRe.test(f)) continue;
                try { fs.unlinkSync(path.join(tempRoot, f)); removedTempFiles++; } catch (_) {}
            }
        }
    } catch (_) {}
    // Limpa logs/ completamente (terminal_*.log, divulgar_*.log, etc)
    try {
        const logsRoot = path.join(process.cwd(), 'logs');
        if (fs.existsSync(logsRoot)) {
            for (const f of fs.readdirSync(logsRoot)) {
                try { fs.unlinkSync(path.join(logsRoot, f)); removedLogsDirFiles++; } catch (_) {}
            }
        }
    } catch (_) {}
    setMaxLogs(200);
    if (ioServer) {
        try { ioServer.emit('reset', { ts: Date.now() }); } catch (_) {}
    }
    return {
        removedLogs,
        removedMediaFiles,
        removedTempFiles,
        removedLogsDirFiles,
        newLimit: currentMaxLogs
    };
}

function stop() {
    try { require('../history/store').setMirror(null); } catch (_) {}
    return new Promise((resolve) => {
        let pending = 0;
        if (ioServer) {
            pending++;
            try { ioServer.close(() => { pending--; if (pending === 0) resolve(); }); } catch (_) { pending--; }
        }
        if (httpServer) {
            pending++;
            try { httpServer.close(() => { pending--; if (pending === 0) resolve(); }); } catch (_) { pending--; }
        }
        if (groupsRefreshTimer) { try { clearInterval(groupsRefreshTimer); groupsRefreshTimer = null; } catch (_) {} }
        // logsTrimTimer NÃO é parado aqui: trim do histórico independe do painel.
        if (accessLogStream) { try { accessLogStream.end(); } catch (_) {} accessLogStream = null; }
        ioServer = null;
        httpServer = null;
        if (pending === 0) resolve();
        else setTimeout(resolve, 2000);
    });
}

module.exports = {
    init, log, attachSock, cacheMedia,
    setGroupsApi, pushGroupsSnapshot, rememberGroupInfo,
    setStartTime,
    handleReaction,
    resetDashboard, setMaxLogs, stop,
    ensureLogsTrimLoop,
    mediaForLogReceived, mediaForLogSent,
    emitMediaUpdate,
    setConnectionState, getConnectionState
};
