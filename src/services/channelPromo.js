// ============================================================
// Promo do canal oficial via contextInfo (forwarded newsletter).
// Centraliza o link do canal para sticker, música, conversões,
// revelar etc — sem poluir a legenda com link em texto.
// Uso: withChannelContext({ image: buf, caption }, config)
// ============================================================

const DEFAULT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbDbHSTI1rcrp0Ybo10i';
const DEFAULT_CHANNEL_ID = '0029VbDbHSTI1rcrp0Ybo10i';
const DEFAULT_CHANNEL_JID = `${DEFAULT_CHANNEL_ID}@newsletter`;
const DEFAULT_CHANNEL_NAME = 'Canal Oficial 📢';

// Cache do JID real resolvido via newsletterMetadata('invite', code).
// O código do convite (0029Vb...) NÃO é o JID — o WhatsApp só mostra
// "Ver canal" e renderiza o áudio com o JID numérico real (ex: 1203...@newsletter).
let _resolvedCache = null; // { code, jid, name, at }
let _resolving = false;

function extractInviteCode(linkOrCode) {
    const s = String(linkOrCode || '').trim();
    if (!s) return null;
    const m = s.match(/channel\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    if (/^[A-Za-z0-9]{8,64}$/.test(s)) return s;
    return null;
}

function getChannelConfig(config) {
    const link = (config && config.channelLink) || process.env.CHANNEL_LINK || DEFAULT_CHANNEL_LINK;
    // JID real resolvido tem prioridade sobre o configurado (que pode ser só o invite).
    let jid = (_resolvedCache && _resolvedCache.jid)
        || (config && config.channelJid) || process.env.CHANNEL_JID || DEFAULT_CHANNEL_JID;
    jid = String(jid || '').trim() || DEFAULT_CHANNEL_JID;
    // Aceita só o ID (sem @newsletter) e completa automaticamente.
    if (!jid.includes('@')) jid = `${jid}@newsletter`;
    const name = String((_resolvedCache && _resolvedCache.name)
        || (config && config.channelName) || process.env.CHANNEL_NAME || DEFAULT_CHANNEL_NAME).slice(0, 60) || DEFAULT_CHANNEL_NAME;
    return { link, jid, name };
}

// Resolve o código do convite para o JID real do canal (1x por dia).
// Chame após o 'open' da conexão; é fire-and-forget e persiste no config.
async function resolveChannelInfo(sock, config) {
    try {
        if (!sock || typeof sock.newsletterMetadata !== 'function') return _resolvedCache;
        if (_resolving) return _resolvedCache;
        const { link } = getChannelConfig(config);
        const code = extractInviteCode(link) || DEFAULT_CHANNEL_ID;
        if (_resolvedCache && _resolvedCache.code === code && (Date.now() - _resolvedCache.at) < 24 * 3600 * 1000) return _resolvedCache;
        _resolving = true;
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            if (!meta) return _resolvedCache;
            let jid = meta.id || meta.jid || null;
            if (jid && !String(jid).includes('@')) jid = `${jid}@newsletter`;
            const rawName = (meta.thread_metadata && meta.thread_metadata.name && meta.thread_metadata.name.text)
                || meta.name || null;
            const name = rawName ? String(rawName).slice(0, 60) : null;
            if (!jid) return _resolvedCache;
            _resolvedCache = { code, jid: String(jid), name, at: Date.now() };
            console.log(`📢 [CANAL] resolvido: ${_resolvedCache.jid} ("${name || '?'}")`);
            try {
                const { readConfig, writeConfig } = require('../database/utils');
                const cfg = readConfig();
                if (cfg.channelJid !== _resolvedCache.jid || (name && cfg.channelName !== name)) {
                    writeConfig({ ...cfg, channelJid: _resolvedCache.jid, ...(name ? { channelName: name } : {}) });
                }
            } catch (_) {}
            return _resolvedCache;
        } finally {
            _resolving = false;
        }
    } catch (e) {
        try { console.warn(`⚠️ [CANAL] falha ao resolver invite: ${String(e && e.message || e).slice(0, 120)}`); } catch (_) {}
        return _resolvedCache;
    }
}

// Monta o contextInfo de atribuição do canal, preservando o que já existe
// (mentions, externalAdReply do !play, etc).
// ATENÇÃO: forwardingScore precisa ficar <= 4 e sem isForwarded — acima
// disso o WhatsApp carimba "Encaminhada com frequência", o que limita o
// encaminhamento (1 conversa por vez) e atrapalha baixar/salvar. Só o
// forwardedNewsletterMessageInfo já mostra o "via Canal Oficial".
function buildChannelContextInfo(config, extraContextInfo) {
    const { jid, name } = getChannelConfig(config);
    const base = (extraContextInfo && typeof extraContextInfo === 'object') ? { ...extraContextInfo } : {};
    const prevFwd = (base.forwardedNewsletterMessageInfo && typeof base.forwardedNewsletterMessageInfo === 'object')
        ? base.forwardedNewsletterMessageInfo
        : {};
    const out = {
        ...base,
        forwardingScore: 1,
        forwardedNewsletterMessageInfo: {
            newsletterJid: jid,
            newsletterName: name,
            serverMessageId: Number(prevFwd.serverMessageId) > 0 ? prevFwd.serverMessageId : 1,
        },
    };
    // Nunca vazar selo de encaminhado mesmo se o contexto extra trouxer um.
    delete out.isForwarded;
    return out;
}

// Anexa o context do canal dentro do payload (1º arg do sendMessage).
// Preserva mentions[] sincronizando com contextInfo.mentionedJid.
function withChannelContext(payload, config) {
    const out = (payload && typeof payload === 'object') ? payload : {};
    const prevCtx = (out.contextInfo && typeof out.contextInfo === 'object') ? out.contextInfo : {};
    out.contextInfo = buildChannelContextInfo(config, prevCtx);
    try {
        const mentions = Array.isArray(out.mentions) ? out.mentions.filter(Boolean) : [];
        const mentionedJid = Array.isArray(out.contextInfo.mentionedJid) ? out.contextInfo.mentionedJid.filter(Boolean) : [];
        const merged = [...new Set([...mentionedJid, ...mentions])];
        if (merged.length) out.contextInfo.mentionedJid = merged;
    } catch (_) {}
    return out;
}

module.exports = {
    DEFAULT_CHANNEL_LINK,
    DEFAULT_CHANNEL_ID,
    DEFAULT_CHANNEL_JID,
    DEFAULT_CHANNEL_NAME,
    extractInviteCode,
    getChannelConfig,
    resolveChannelInfo,
    buildChannelContextInfo,
    withChannelContext,
};
