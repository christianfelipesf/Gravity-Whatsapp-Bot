// memeStore.js — acervo global de memes (foto + quem enviou + quando).
// Dedup por sha256 do buffer; anti-repetição por grupo via meme_sends.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const RECENT_EXCLUDE_MAX = 20;

function _db() { return require('../database/db').db; }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function memeFileName(hash) { return `meme_${String(hash).slice(0, 16)}.jpg`; }

function countMemes() {
    try { return Number(_db().prepare('SELECT COUNT(*) AS c FROM memes').get()?.c) || 0; }
    catch (_) { return 0; }
}

function getMemeByHash(hash) {
    try { return _db().prepare('SELECT * FROM memes WHERE hash = ?').get(hash) || null; }
    catch (_) { return null; }
}

function getMemeById(id) {
    try { return _db().prepare('SELECT * FROM memes WHERE id = ?').get(Number(id)) || null; }
    catch (_) { return null; }
}

// Últimos N memes (p/ admin localizar o ID no !delmeme).
function listRecentMemes(limit = 10) {
    try {
        const n = Math.max(1, Math.min(20, Number(limit) || 10));
        return _db().prepare('SELECT * FROM memes ORDER BY id DESC LIMIT ?').all(n);
    } catch (_) { return []; }
}

// Sorteia 1 meme excluindo os N mais recentes já enviados neste grupo.
// Se tudo já foi visto, limpa o histórico do grupo (novo ciclo) e sorteia.
function pickRandomMeme(groupJid) {
    const db = _db();
    const total = countMemes();
    if (!total) return { meme: null, cycled: false };
    const excludeN = Math.min(RECENT_EXCLUDE_MAX, Math.floor(total / 2));
    let rows = [];
    try {
        if (groupJid && excludeN > 0) {
            rows = db.prepare(
                `SELECT m.* FROM memes m
                 WHERE m.id NOT IN (
                   SELECT meme_id FROM meme_sends WHERE group_jid = ?
                   ORDER BY sent_at DESC LIMIT ?
                 )
                 ORDER BY RANDOM() LIMIT 1`
            ).all(groupJid, excludeN);
        } else {
            rows = db.prepare('SELECT * FROM memes ORDER BY RANDOM() LIMIT 1').all();
        }
    } catch (_) { rows = []; }
    if (rows.length) return { meme: rows[0], cycled: false };
    // Tudo visto: novo ciclo
    try {
        if (groupJid) db.prepare('DELETE FROM meme_sends WHERE group_jid = ?').run(groupJid);
        const r = db.prepare('SELECT * FROM memes ORDER BY RANDOM() LIMIT 1').get();
        return { meme: r || null, cycled: true };
    } catch (_) { return { meme: null, cycled: true }; }
}

function recordMemeSend(groupJid, memeId) {
    try {
        if (!groupJid || !memeId) return;
        _db().prepare('INSERT OR REPLACE INTO meme_sends (group_jid, meme_id, sent_at) VALUES (?, ?, ?)')
            .run(groupJid, Number(memeId), Date.now());
    } catch (_) {}
}

// Salva buffer como jpg normalizado (sem crop — meme não pode ser cortado).
// Retorna { row } ou { duplicate: row }.
async function saveMeme(buffer, { senderJid = null, senderName = null, senderPhone = null, groupJid = null, groupName = null } = {}) {
    if (!buffer || !buffer.length) throw new Error('Imagem vazia');
    if (buffer.length > MAX_BYTES) throw new Error('Imagem muito grande (max 5MB)');
    const hash = sha256(buffer);
    const dupe = getMemeByHash(hash);
    if (dupe) return { duplicate: dupe };
    const sharp = require('sharp');
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const filePath = path.join(uploadsDir, memeFileName(hash));
    await sharp(buffer, { failOn: 'none' }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(filePath);
    const now = Date.now();
    const info = _db().prepare(
        'INSERT INTO memes (file_path, hash, sender_jid, sender_name, sender_phone, group_jid, group_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(`uploads/${memeFileName(hash)}`, hash, senderJid, senderName, senderPhone, groupJid, groupName, now);
    try { require('../database/supabaseSync').schedulePush(5000); } catch (_) {}
    return { row: getMemeById(Number(info.lastInsertRowid)) };
}

function readMemeBuffer(filePath) {
    try {
        if (!filePath) return null;
        const full = path.resolve(process.cwd(), filePath);
        const uploadsDir = path.resolve(process.cwd(), 'uploads');
        if (!full.startsWith(uploadsDir + path.sep)) return null;
        if (!fs.existsSync(full)) return null;
        const buf = fs.readFileSync(full);
        if (!buf || buf.length < 100 || buf.length > MAX_BYTES) return null;
        return buf;
    } catch (_) { return null; }
}

function deleteMeme(id) {
    const row = getMemeById(id);
    if (!row) return { ok: false, reason: 'not-found' };
    try {
        _db().prepare('DELETE FROM memes WHERE id = ?').run(Number(id));
        _db().prepare('DELETE FROM meme_sends WHERE meme_id = ?').run(Number(id));
    } catch (e) { return { ok: false, reason: e?.message || 'db' }; }
    try {
        const full = path.resolve(process.cwd(), row.file_path);
        const uploadsDir = path.resolve(process.cwd(), 'uploads');
        if (full.startsWith(uploadsDir + path.sep) && fs.existsSync(full)) fs.unlinkSync(full);
    } catch (_) {}
    try { require('../database/supabaseSync').schedulePush(5000); } catch (_) {}
    return { ok: true };
}

function formatDateBR(ts) {
    try {
        const d = new Date(Number(ts));
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch (_) { return '—'; }
}

// Legenda padrão: enviado por + grupo de ORIGEM + data.
// Mostra onde o meme foi postado (nome do grupo ou "privado"),
// não o grupo atual onde foi sorteado.
// O 2º param é fallback p/ memes antigos sem origem salva.
function buildMemeCaption(meme, fallbackGroupName) {
    const who = meme.sender_name || 'alguém';
    const phone = meme.sender_phone ? ` (${meme.sender_phone})` : '';
    const origin = meme.group_name || fallbackGroupName || '—';
    return `👤 *Enviado por:* ${who}${phone}\n👥 *Grupo:* ${origin}\n📅 *Data:* ${formatDateBR(meme.created_at)}`;
}

// Telefone canônico a partir do sender + participantPn (cobre @lid).
function extractPhone(sender, m) {
    try {
        const pn = m?.key?.participantPn || m?.key?.senderPn || null;
        if (pn && String(pn).endsWith('@s.whatsapp.net')) {
            const ph = String(pn).split('@')[0].split(':')[0];
            if (/^\d{8,15}$/.test(ph)) return ph;
        }
    } catch (_) {}
    try {
        const ph = String(sender || '').split('@')[0].split(':')[0];
        if (/^\d{8,15}$/.test(ph)) return ph;
    } catch (_) {}
    return null;
}

// Anti-spam do !meme por grupo DESATIVADO (pedido do dono: sem delay).
// Mantido por compatibilidade — sempre liberado.
const _memeGroupLast = new Map();
const MEME_GROUP_COOLDOWN_MS = 0;
function checkMemeGroupCooldown(jid) {
    return 0;
}

module.exports = {
    MAX_BYTES,
    RECENT_EXCLUDE_MAX,
    MEME_GROUP_COOLDOWN_MS,
    sha256,
    countMemes,
    getMemeByHash,
    getMemeById,
    listRecentMemes,
    pickRandomMeme,
    recordMemeSend,
    saveMeme,
    readMemeBuffer,
    deleteMeme,
    formatDateBR,
    buildMemeCaption,
    extractPhone,
    checkMemeGroupCooldown,
};
