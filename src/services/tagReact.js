// tagReact.js — modo !tag global (dono/sub 🤡, guardião 🦅).
// Reage a mensagens normais (não-comandos) em grupos quando tagMode=true.
// Membro comum: sem reação. Fire-and-forget p/ não atrasar o handler.

const TAG_OWNER_EMOJI = '🤡';
const TAG_GUARDIAN_EMOJI = '🦅';

function isTagEnabled(cfg) {
    try {
        if (cfg && typeof cfg.tagMode !== 'undefined') return cfg.tagMode === true;
        const utils = require('../database/utils');
        return utils.readConfig().tagMode === true;
    } catch (_) { return false; }
}

// Retorna o emoji p/ o remetente ou null (sem reação).
// Usa canGuardianActAsync (com fallback LID->telefone) — dono/sub 🤡, guardião 🦅.
async function resolveTagEmoji(sock, m, sender, from) {
    try {
        const utils = require('../database/utils');
        if (typeof utils.canGuardianActAsync !== 'function') return null;
        const g = await utils.canGuardianActAsync(sock, m, sender, from);
        if (!g || !g.ok) return null;
        if (g.owner || g.sub) return TAG_OWNER_EMOJI;
        if (g.guardiao) return TAG_GUARDIAN_EMOJI;
        return null;
    } catch (_) { return null; }
}

// Dispara a reação (fire-and-forget). Retorna true se reagiu.
async function maybeTagReact(sock, m, { from, sender } = {}) {
    try {
        if (!sock || !m?.key?.id || !from || !String(from).endsWith('@g.us')) return false;
        if (m.key.fromMe) return false;
        if (!isTagEnabled()) return false;
        const emoji = await resolveTagEmoji(sock, m, sender, from);
        if (!emoji) return false;
        await sock.sendMessage(from, { react: { text: emoji, key: m.key } });
        return true;
    } catch (_) { return false; }
}

module.exports = {
    TAG_OWNER_EMOJI,
    TAG_GUARDIAN_EMOJI,
    isTagEnabled,
    resolveTagEmoji,
    maybeTagReact
};
