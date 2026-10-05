// dashboardStub.js — substituto do painel web (src/dashboard/, arquivado em
// archive/dashboard-2026-10-05) para quem só precisa do HISTÓRICO em banco.
// - log(): implementação real (mesma do dashboard.js), grava dashboard_logs.
// - resetDashboard(): port do dashboard.js sem a parte socket.io.
// - Todo o resto (init, socket, pushGroupsSnapshot, etc.): no-op, para os
//   ~10 call sites existentes não quebrarem.
const fs = require('fs');
const path = require('path');
const { insertDashboardLog, clearDashboardLogs } = require('../database/utils');

let currentMaxLogs = 500;
let connectionState = { status: 'disconnected', qr: null, phone: null };

// --- servidor web: removido (no-ops) ---
function init() {
    return null;
}
function stop() {
    return Promise.resolve();
}
function setGroupsApi() {}
function attachSock() {}
function pushGroupsSnapshot() {
    return Promise.resolve();
}
function setStartTime() {}
function setConnectionState(state) {
    connectionState = { ...connectionState, ...state };
}
function getConnectionState() {
    return { ...connectionState };
}
function setMaxLogs(n) {
    if (Number.isFinite(Number(n)) && Number(n) > 0) currentMaxLogs = Number(n);
}
function ensureLogsTrimLoop() {}
function handleReaction() {
    return Promise.resolve();
}

// --- mídia do log: sem servidor, sem cache (callers já tratam null) ---
function cacheMedia() {
    return null;
}
function rememberGroupInfo() {}
function mediaForLogReceived() {
    return null;
}
function mediaForLogSent() {
    return null;
}
function emitMediaUpdate() {}

// --- histórico em banco: REAL (era dashboard.log) ---
function log(type, group, text, name = null, phone = null, media = null, extra = {}) {
    try {
        try {
            const cfg = require('../database/utils').readConfig();
            if (cfg && cfg.dashboardMuted === true) return false;
        } catch (_) {}
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
        return true;
    } catch (e) {
        try { console.error('[dashboardStub] log:', e?.message || e); } catch (_) {}
        return false;
    }
}

// --- reset de histórico/arquivos: port do dashboard.resetDashboard ---
function resetDashboard() {
    let removedLogs = 0;
    let removedMediaFiles = 0;
    let removedTempFiles = 0;
    let removedLogsDirFiles = 0;
    try { removedLogs = clearDashboardLogs(); } catch (e) {
        try { console.error('[dashboardStub] reset clearLogs:', e.message); } catch (_) {}
    }
    try {
        const mediaDir = path.join(process.cwd(), 'temp', 'dashboard_media');
        if (fs.existsSync(mediaDir)) {
            for (const f of fs.readdirSync(mediaDir)) {
                try { fs.unlinkSync(path.join(mediaDir, f)); removedMediaFiles++; } catch (_) {}
            }
        }
    } catch (_) {}
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
    try {
        const logsRoot = path.join(process.cwd(), 'logs');
        if (fs.existsSync(logsRoot)) {
            for (const f of fs.readdirSync(logsRoot)) {
                try { fs.unlinkSync(path.join(logsRoot, f)); removedLogsDirFiles++; } catch (_) {}
            }
        }
    } catch (_) {}
    setMaxLogs(200);
    return {
        removedLogs,
        removedMediaFiles,
        removedTempFiles,
        removedLogsDirFiles,
        newLimit: currentMaxLogs
    };
}

module.exports = {
    init,
    log,
    attachSock,
    cacheMedia,
    setGroupsApi,
    pushGroupsSnapshot,
    rememberGroupInfo,
    setStartTime,
    handleReaction,
    resetDashboard,
    setMaxLogs,
    stop,
    ensureLogsTrimLoop,
    mediaForLogReceived,
    mediaForLogSent,
    emitMediaUpdate,
    setConnectionState,
    getConnectionState
};
