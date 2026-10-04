// src/history/store.js — camada própria de histórico (!aidono / !resumir).
//
// REGRA: todo código novo de histórico usa este módulo. NUNCA faça
// `require('../dashboard/dashboard')` em código novo — o painel web é
// somente leitura desta camada e será removido no futuro. A direção da
// dependência é: dashboard -> history. history NUNCA -> dashboard.
//
// O que fica aqui: escrita e leitura do histórico no SQLite (tabelas
// dashboard_logs e messages — nomes legados mantidos para não migrar
// banco). O painel web continua funcionando: ele lê do mesmo banco e,
// quando ativo, recebe espelho em tempo real via setMirror().

const fs = require('fs');
const path = require('path');

const utils = require('../database/utils');

// Espelho em tempo real (opcional, registrado pelo painel quando ativo).
// Sem painel: no-op. O histórico no banco NUNCA depende disso.
let _mirror = null;
function setMirror(fn) {
    _mirror = typeof fn === 'function' ? fn : null;
}
function _emit(payload) {
    if (!_mirror) return;
    try { _mirror(payload); } catch (_) {}
}

// --- Escrita ---------------------------------------------------------------

function _syntheticMessageId(type, toJid, text, fileName) {
    const seed = `${type}|${toJid || ''}|${text || ''}|${fileName || ''}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
        h = (h * 31 + seed.charCodeAt(i)) | 0;
    }
    return 'synthetic-' + (h >>> 0).toString(36);
}

// Mesma semântica do antigo dashboard.log(), sem o servidor HTTP:
// monta o registro, persiste no banco e espelha (se houver painel).
// Retorna o logData ou false quando silenciado (dashboardMuted).
function writeLog(type, group, text, name = null, phone = null, media = null, extra = {}) {
    try {
        try {
            // Histórico tem mute próprio (historyMuted); dashboardMuted é alias legado.
            const cfg = utils.readConfig();
            if (cfg && (cfg.historyMuted === true || (cfg.historyMuted === undefined && cfg.dashboardMuted === true))) return false;
        } catch (_) {}
        const messageId = extra.messageId || _syntheticMessageId(type, extra.toJid, text, extra.attachment?.fileName);
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
        try { utils.insertDashboardLog(logData); } catch (_) {}
        _emit({ kind: 'msg', log: logData });
        return logData;
    } catch (e) {
        console.error('[history] writeLog:', e?.message || e);
        return false;
    }
}

function updateMedia(toJid, messageId, type, mediaInfo) {
    try {
        const json = typeof mediaInfo === 'string' ? mediaInfo : JSON.stringify(mediaInfo);
        utils.updateDashboardLogMedia(toJid, messageId, type, json);
    } catch (_) {}
    _emit({ kind: 'media:update', toJid, messageId, type, media: mediaInfo });
}

function updateReactions(toJid, messageId, type, reactions, extra = {}) {
    try { utils.updateDashboardLogReactions(toJid, messageId, type, reactions); } catch (_) {}
    _emit({ kind: 'reaction', toJid, messageId, type, reactions, emoji: extra.emoji || '', senderJid: extra.senderJid || null, senderName: extra.senderName || null });
}

// Mídia recebida: persiste o base64 em temp/dashboard_media (mesmo dir que
// o painel serve) e devolve a info com URL local. Sem painel, o arquivo
// fica para uso futuro; o JSON vai para o banco de qualquer forma.
const MEDIA_DIR = path.join(__dirname, '..', '..', 'temp', 'dashboard_media');
function persistReceivedMedia(media, messageId) {
    if (!media) return null;
    const type = media.type;
    if (!['image', 'video', 'audio', 'voice', 'sticker', 'document'].includes(type)) return null;
    if (media.url && media.url.startsWith('data:') && messageId) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(media.url);
        if (m) {
            try {
                const mime = m[1];
                const buf = Buffer.from(m[2], 'base64');
                try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (_) {}
                try { fs.writeFileSync(path.join(MEDIA_DIR, encodeURIComponent(messageId)), buf); } catch (_) {}
                return {
                    type,
                    url: `/media/${encodeURIComponent(messageId)}`,
                    mime,
                    fileName: media.fileName || (type === 'document' ? 'documento' : null),
                    sizeBytes: media.sizeBytes || buf.length
                };
            } catch (_) {}
        }
    }
    return media;
}

// Info de grupo: só persiste no banco (o cache em memória era do painel).
function rememberGroup(jid, patch = {}) {
    if (!jid || !String(jid).endsWith('@g.us')) return;
    try {
        utils.upsertDashboardGroupInfo(jid, {
            subject: patch.subject || null,
            memberCount: patch.memberCount !== undefined ? patch.memberCount : 0,
            ownerJid: patch.ownerJid || null,
            desc: patch.desc || null
        });
    } catch (_) {}
}

// --- Retenção (dono do trim: histórico, NÃO o painel web) ------------------
// Roda SEMPRE, mesmo com dashboardEnabled=false. Lê history* a cada ciclo
// para respeitar !set sem restart. Idempotente (guarda em _trimTimer).
let _trimTimer = null;

function _historyLimits() {
    try {
        if (typeof utils.getHistoryLimits === 'function') return utils.getHistoryLimits();
    } catch (_) {}
    try {
        const cfg = utils.readConfig();
        return {
            maxRows: Math.max(1000, Number(cfg?.historyMaxLogs ?? cfg?.dashboardMaxLogs) || 100000),
            maxAgeMs: (Math.max(1, Number(cfg?.historyHours ?? cfg?.dashboardHistoryHours) || 168)) * 3600 * 1000,
            intervalMs: Math.max(30 * 1000, Number(cfg?.historyTrimIntervalMs ?? cfg?.dashboardTrimIntervalMs) || 5 * 60 * 1000)
        };
    } catch (_) {
        return { maxRows: 100000, maxAgeMs: 168 * 3600 * 1000, intervalMs: 5 * 60 * 1000 };
    }
}

function runHistoryTrimOnce(isBoot = false) {
    try {
        const { maxRows, maxAgeMs } = _historyLimits();
        const c = utils.countDashboardLogs();
        if (c > maxRows || (maxAgeMs > 0 && c > 0)) {
            utils.trimDashboardLogs({ maxAgeMs, maxRows });
            try { utils.checkpointWal(); } catch (_) {}
            // messages tem teto próprio por grupo (summaryLimit) — o flush só
            // apara jids recém-escritos, então o PULL pode deixar excedente.
            try { utils.trimMessagesToLimit?.(); } catch (_) {}
            if (isBoot && c > maxRows) {
                try {
                    const after = utils.countDashboardLogs();
                    if (after !== c) console.log(`🧹 [history] logs (maxRows): ${c} → ${after} (max=${maxRows})`);
                } catch (_) {}
            }
        } else {
            // Mesmo sem estourar logs, garante o teto de messages (barato:
            // só conta por jid e sai quando ninguém excede).
            try { utils.trimMessagesToLimit?.(); } catch (_) {}
        }
    } catch (_) {}
}

function ensureHistoryTrimLoop() {
    if (_trimTimer) return true;
    const { intervalMs } = _historyLimits();
    runHistoryTrimOnce(true);
    _trimTimer = setInterval(() => runHistoryTrimOnce(false), intervalMs);
    if (_trimTimer.unref) _trimTimer.unref();
    return true;
}

// --- Leitura (caminho próprio do !aidono / !resumir) ------------------------

module.exports = {
    setMirror,
    writeLog,
    updateMedia,
    updateReactions,
    persistReceivedMedia,
    rememberGroup,
    // predicado: histórico independe do painel (grupo ativo ou parcial)
    shouldRecordHistory: utils.shouldRecordHistory,
    insertHistoryLog: utils.insertDashboardLog,
    getHistoryByMessageId: utils.getDashboardLogByMessageId,
    getMessagesBySender: utils.getMessagesBySender,
    getMessagesByGroup: utils.getMessagesByGroup,
    getMessagesBySenderRange: utils.getMessagesBySenderRange,
    getMessagesByGroupRange: utils.getMessagesByGroupRange,
    getRecentLogs: utils.getRecentLogs,
    countMediaOnlyBySender: utils.countMediaOnlyBySender,
    getMessagesByPushName: utils.getMessagesByPushName,
    findMessagesByNameLike: utils.findMessagesByNameLike,
    getGroupMessages: utils.getGroupMessages,
    getMessagesByPushNameRange: utils.getMessagesByPushNameRange,
    getGroupMessagesRange: utils.getGroupMessagesRange,
    saveMessage: utils.saveMessage,
    getChatHistory: utils.getChatHistory,
    trimHistoryLogs: utils.trimDashboardLogs,
    countHistoryLogs: utils.countDashboardLogs,
    getHistoryLimits: () => _historyLimits(),
    getHistoryStats: utils.getHistoryStats,
    getHistoryWindowLabel: utils.getHistoryWindowLabel,
    trimMessagesToLimit: utils.trimMessagesToLimit,
    ensureHistoryTrimLoop,
    runHistoryTrimOnce
};
