'use strict';
// ============================================================
// identity.js — CENTRAL DE IDENTIDADE (telefone / LID / nome).
//
// REGRA DE OURO (vale p/ o bot inteiro):
//   1. LID opaco NUNCA é salvo como se fosse telefone.
//   2. LID opaco NUNCA é exibido cru para o usuário.
//   3. Toda comparação cobre os dois formatos (telefone + LID).
//
// Por que existe este módulo: grupos com privacidade LID entregam
// remetentes como `12345@lid` (dígitos opacos, NÃO são telefones),
// mas `normalizePhoneNumber` aceita 8-15 dígitos — então o LID
// passava na validação, era salvo em listas (sub-donos, guardiões,
// logins, blacklist), quebrava o match depois e vazava na exibição
// como "+151059083309097".
//
// Como usar:
//   - ESCRITA (add*): `resolveCandidateToPhone(sock, utils, candidate, grupo)`
//     e salve o retorno. Nunca salve @lid nem dígitos não resolvidos de @lid.
//   - REMOÇÃO (rem*): tente direto; se "não encontrado", use
//     `findStoredMatch(...)` que cruza telefone<->LID via metadados.
//   - LISTAGEM: `displayPerson(...)` por entrada + `healPhoneList(...)`
//     para auto-curar LIDs legados.
//   - MODERAÇÃO (mute/adv/blacklist): `targetKeys(...)` na escrita e
//     `messageAliasKeys(...)` na leitura — nunca chave única verbatim.
//   - EXIBIÇÃO: `formatPhoneDisplay` / `personLabel` — nunca
//     `jid.split('@')[0]` cru no texto.
//
// Este módulo NÃO faz require de ../database/utils no topo (evita
// ciclo): recebe `utils` por parâmetro nas funções que precisam.
// ============================================================

function digitsOf(v) {
    return String(v == null ? '' : v).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function stripDevice(jid) {
    if (!jid) return jid;
    const [rawUser, domain] = String(jid).split('@');
    const [user] = String(rawUser).split(':');
    return domain ? `${user}@${domain}` : user;
}

function isLidJid(jid) {
    return String(jid || '').toLowerCase().endsWith('@lid');
}

function isPhoneJid(jid) {
    return String(jid || '').toLowerCase().endsWith('@s.whatsapp.net');
}

function isGroupJid(jid) {
    return String(jid || '').toLowerCase().endsWith('@g.us');
}

/**
 * Formato canônico de exibição de telefone.
 * BR com DDI: 5564993347663 -> (64) 99334-7663.
 * Fora do padrão: +<dígitos>. Nunca retorna null.
 * ATENÇÃO: só chame com TELEFONE real. LID deve ser resolvido antes
 * (resolveLidPhone) — se não resolver, use personLabel (que omite).
 */
function formatPhoneDisplay(raw) {
    const d = digitsOf(raw);
    if (!d) return '';
    let core = d;
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) core = d.slice(2);
    if (/^\d{10}$/.test(core)) return `(${core.slice(0, 2)}) ${core.slice(2, 6)}-${core.slice(6)}`;
    if (/^\d{11}$/.test(core)) return `(${core.slice(0, 2)}) ${core.slice(2, 7)}-${core.slice(7)}`;
    return `+${d}`;
}

function cleanPersonName(nm) {
    const n = String(nm == null ? '' : nm).trim().replace(/^~\s*/, '');
    if (!n || /^(usuário|usuario)$/i.test(n)) return null;
    if (/^\d[\d\s()+.-]*$/.test(n)) return null;
    return n.slice(0, 30);
}

// ---- Extração gratuita (sem rede) a partir da mensagem ----

function _ctxOf(m) {
    try {
        const msg = m?.message || {};
        return (
            msg?.extendedTextMessage?.contextInfo ||
            msg?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
            msg?.imageMessage?.contextInfo ||
            msg?.videoMessage?.contextInfo ||
            null
        );
    } catch (_) { return null; }
}

// Telefones visíveis sem rede (campos Pn do Baileys + sender não-@lid).
function senderPhonesFromMessage(m, sender, from) {
    const out = [];
    const push = (v) => {
        const d = digitsOf(v);
        if (d && d.length >= 8 && d.length <= 15 && !out.includes(d)) out.push(d);
    };
    try {
        push(m?.key?.participantPn);
        push(m?.key?.senderPn);
        const ctx = _ctxOf(m);
        push(ctx?.senderPn);
        push(ctx?.participantPn);
    } catch (_) {}
    try {
        if (sender && !isLidJid(sender)) push(sender);
        if (from && !isGroupJid(from) && !isLidJid(from)) push(from);
    } catch (_) {}
    return out;
}

// LIDs do remetente (para casar com entradas legadas salvas como LID).
function senderLidsFromMessage(m, sender) {
    const out = [];
    const push = (v) => {
        if (!isLidJid(v)) return;
        const d = digitsOf(v);
        if (d && !out.includes(d)) out.push(d);
    };
    try {
        push(sender);
        push(m?.key?.participant);
        const ctx = _ctxOf(m);
        push(ctx?.participant);
        if (Array.isArray(ctx?.mentionedJid)) for (const j of ctx.mentionedJid) push(j);
    } catch (_) {}
    return out;
}

// Todas as chaves candidatas do autor (leitura sem rede p/ mute/warnings).
// Retorna { phones, lids, jids } — jids inclui sender/participant verbatim.
function messageAliasKeys(m, sender) {
    const phones = senderPhonesFromMessage(m, sender, null);
    const lids = senderLidsFromMessage(m, sender);
    const jids = [];
    const pushJ = (v) => {
        if (!v || !String(v).includes('@')) return;
        const n = stripDevice(v);
        if (n && !jids.includes(n)) jids.push(n);
    };
    try {
        pushJ(sender);
        pushJ(m?.key?.participant);
    } catch (_) {}
    for (const p of phones) jids.push(`${p}@s.whatsapp.net`);
    for (const l of lids) jids.push(`${l}@lid`);
    return { phones, lids, jids: [...new Set(jids)] };
}

// ---- Resolução (precisa de sock + utils) ----

function groupsForSearch(utils, preferred, cap = 15) {
    const groups = [];
    if (preferred && isGroupJid(preferred)) groups.push(preferred);
    try {
        if (utils && typeof utils.listActiveGroups === 'function') {
            for (const g of utils.listActiveGroups()) {
                if (!isGroupJid(g)) continue;
                if (g !== preferred && !groups.includes(g)) groups.push(g);
                if (groups.length >= cap) break;
            }
        }
    } catch (_) {}
    return groups;
}

async function resolveLidPhone(sock, utils, lidDigits, preferredGroup) {
    const want = digitsOf(lidDigits);
    if (!want || !sock || !utils) return null;
    try {
        if (typeof utils.resolveLidToPhoneInGroups === 'function') {
            const groups = groupsForSearch(utils, preferredGroup, 15);
            const real = await utils.resolveLidToPhoneInGroups(sock, want, groups, { maxGroups: 15 });
            if (real) return real;
        }
        if (preferredGroup && isGroupJid(preferredGroup) && typeof utils.resolveLidPhoneInGroup === 'function') {
            const real = await utils.resolveLidPhoneInGroup(sock, `${want}@lid`, preferredGroup);
            if (real) return real;
        }
    } catch (_) {}
    return null;
}

// Mapa LID -> telefone varrendo metadados (grupo preferido primeiro).
async function buildLidPhoneMap(sock, utils, groupJids, maxGroups = 15) {
    const map = new Map();
    const groups = (Array.isArray(groupJids) ? groupJids : []).filter(isGroupJid);
    if (!sock || !groups.length) return map;
    const cap = Math.max(1, Math.min(40, Number(maxGroups) || 15));
    let checked = 0;
    for (const gjid of groups) {
        if (checked >= cap) break;
        checked++;
        let meta = null;
        try {
            meta = (utils && typeof utils.groupMetadataCached === 'function')
                ? await utils.groupMetadataCached(sock, gjid)
                : await sock.groupMetadata(gjid);
        } catch (_) { continue; }
        const parts = meta?.participants || [];
        for (const p of parts) {
            try {
                const ids = [p?.id, p?.jid, p?.lid].filter(Boolean).map(String);
                const lidHit = ids
                    .filter((id) => String(id).toLowerCase().endsWith('@lid'))
                    .map(digitsOf)
                    .find(Boolean);
                if (!lidHit || map.has(lidHit)) continue;
                // Telefone pode estar em phoneNumber/pn OU no próprio id/jid.
                const cands = [p?.phoneNumber, p?.pn, p?.id, p?.jid].filter(Boolean).map(String);
                for (const c of cands) {
                    if (String(c).toLowerCase().endsWith('@lid')) continue;
                    const d = digitsOf(c);
                    if (d && d !== lidHit && d.length >= 8 && d.length <= 15) { map.set(lidHit, d); break; }
                }
            } catch (_) {}
        }
    }
    return map;
}

async function resolvePersonName(sock, utils, groupJid, value) {
    const want = digitsOf(value);
    if (!want || !utils) return null;
    try {
        if (groupJid && isGroupJid(groupJid) && typeof utils.groupMetadataCached === 'function') {
            const meta = await utils.groupMetadataCached(sock, groupJid).catch(() => null);
            const parts = meta?.participants || [];
            for (const p of parts) {
                const cands = [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.pn].filter(Boolean).map(String);
                const users = cands.map(digitsOf).filter(Boolean);
                if (!users.includes(want)) continue;
                const nm = cleanPersonName(p?.notify || p?.name || p?.verifiedName || null);
                if (nm) return nm;
                break;
            }
        }
    } catch (_) {}
    const jidNum = `${want}@s.whatsapp.net`;
    const jidLid = `${want}@lid`;
    try {
        if (typeof utils.findActivityName === 'function') {
            const hit = utils.findActivityName(jidNum, jidLid);
            const nm = cleanPersonName(hit && hit.name);
            if (nm) return nm;
        }
    } catch (_) {}
    try {
        if (typeof utils.getSenderName === 'function') {
            for (const sid of [jidNum, jidLid]) {
                const nm = cleanPersonName(utils.getSenderName(sid));
                if (nm) return nm;
            }
        }
    } catch (_) {}
    try {
        if (typeof utils.getCachedParticipantName === 'function' && groupJid) {
            for (const sid of [jidNum, jidLid]) {
                const nm = cleanPersonName(utils.getCachedParticipantName(groupJid, sid));
                if (nm) return nm;
            }
        }
    } catch (_) {}
    return null;
}

// ---- ESCRITA: candidato (menção/@lid/dígitos) -> telefone real ----
// Retorna { phone } ou { phone: null, reason }.
// Nunca retorna LID: @lid sem resolução = erro, não salvamento.
async function resolveCandidateToPhone(sock, utils, candidate, preferredGroup) {
    if (candidate == null) return { phone: null, reason: 'vazio' };
    const raw = String(candidate);
    if (isLidJid(raw)) {
        const real = await resolveLidPhone(sock, utils, raw, preferredGroup);
        if (real) return { phone: real, resolvedFromLid: true };
        return { phone: null, reason: 'lid-sem-telefone' };
    }
    const norm = utils && typeof utils.normalizePhoneNumber === 'function'
        ? utils.normalizePhoneNumber(raw.split('@')[0] || raw)
        : digitsOf(raw);
    if (!norm) return { phone: null, reason: 'invalido' };
    // Dígitos digitados podem ser um LID colado: tenta converter.
    const real = await resolveLidPhone(sock, utils, norm, preferredGroup);
    if (real && real !== norm) return { phone: real, resolvedFromLid: true };
    return { phone: norm, resolvedFromLid: false };
}

// ---- REMOÇÃO: acha a entrada salva casando telefone<->LID ----
async function findStoredMatch(sock, utils, storedList, typedPhone, preferredGroup) {
    const typed = digitsOf(typedPhone);
    if (!typed || !Array.isArray(storedList)) return null;
    if (storedList.includes(typed)) return typed;
    const groups = groupsForSearch(utils, preferredGroup, 15);
    for (const s of storedList) {
        if (s === typed) continue;
        try {
            if (!utils || typeof utils.resolveLidToPhoneInGroups !== 'function') continue;
            const real = await utils.resolveLidToPhoneInGroups(sock, s, groups, { maxGroups: 15 });
            if (real && real === typed) return s;
            // Inverso: o digitado é LID e o salvo é o telefone.
            const back = await utils.resolveLidToPhoneInGroups(sock, typed, groups, { maxGroups: 15 });
            if (back && back === s) return s;
        } catch (_) {}
    }
    return null;
}

// ---- LISTAGEM: auto-cura de LIDs legados (troca pelo telefone, sem duplicar) ----
function healPhoneList(storedList, lidMap) {
    if (!Array.isArray(storedList)) return { next: [], changed: false };
    if (!lidMap || lidMap.size === 0) return { next: [...storedList], changed: false };
    const seen = new Set();
    const next = [];
    for (const entry of storedList) {
        const v = lidMap.get(entry) || entry;
        if (!v || seen.has(v)) continue;
        seen.add(v);
        next.push(v);
    }
    const cur = [...storedList];
    const changed = next.length !== cur.length || next.some((v, i) => v !== cur[i]);
    return { next, changed };
}

// ---- MODERAÇÃO: chaves canônicas (telefone + LID) ----
// Escrita: grave a `primary`; leitura: teste todas de `all`.
async function targetKeys(sock, utils, groupJid, targetJid) {
    const norm = stripDevice(targetJid);
    const user = digitsOf(norm);
    const lidJid = isLidJid(norm) ? norm : null;
    let phoneDigits = null;
    if (isPhoneJid(norm)) {
        phoneDigits = user;
    } else if (lidJid) {
        try { phoneDigits = await resolveLidPhone(sock, utils, user, groupJid); } catch (_) {}
    }
    const phoneJid = phoneDigits ? `${phoneDigits}@s.whatsapp.net` : null;
    const primary = phoneJid || norm;
    const all = [...new Set([primary, norm, phoneJid, lidJid].filter(Boolean))];
    return { primary, all, phone: phoneDigits, lid: lidJid ? user : null };
}

// ---- MODERAÇÃO: contadores com chaves alias ----
// Leitura = máximo entre as chaves (converge entradas legadas divididas).
function warnCount(warnings, keys) {
    let max = 0;
    try {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) {
            const c = Number(warnings && warnings[k]) || 0;
            if (c > max) max = c;
        }
    } catch (_) {}
    return max;
}

// Escrita = grava em TODAS as chaves (telefone + LID) para leitura
// exata futura acertar em qualquer formato.
function warnSetAll(warnings, keys, count) {
    try {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) {
            if (!k) continue;
            if (count > 0) warnings[k] = count;
            else delete warnings[k];
        }
    } catch (_) {}
    return warnings;
}

function warnDeleteAll(warnings, keys) {
    return warnSetAll(warnings, keys, 0);
}

// ---- EXIBIÇÃO ----

// Rótulo seguro p/ texto: nome > telefone formatado > 'membro'.
// Nunca retorna JID nem LID cru.
async function personLabel(sock, utils, groupJid, value) {
    const d = digitsOf(value);
    if (!d) return 'membro';
    // Resolve LID para telefone antes de formatar.
    let phone = null;
    if (isLidJid(value)) {
        try { phone = await resolveLidPhone(sock, utils, d, groupJid); } catch (_) {}
    } else {
        phone = d;
    }
    let name = null;
    try { name = await resolvePersonName(sock, utils, groupJid, phone || d); } catch (_) {}
    if (name) return name;
    if (phone) return formatPhoneDisplay(phone);
    return 'membro';
}

// Linha de lista "nome + número embaixo", sem JID/LID.
// Retorna { lines: [nome?, numero], name, phone }.
async function displayPerson(sock, utils, groupJid, storedValue, lidMap) {
    const raw = digitsOf(storedValue);
    const real = (lidMap && lidMap.get(storedValue)) || raw;
    // Se o valor salvo parece LID (sufixo @lid ou 13+ dígitos sem resolução
    // pelo mapa) e ainda é o valor cru, tenta resolução direta: listas legadas
    // guardam só dígitos, sem domínio para distinguir.
    let phone = real;
    if (phone === raw && sock && utils && (isLidJid(storedValue) || raw.length >= 13)) {
        try {
            const r = await resolveLidPhone(sock, utils, raw, groupJid);
            if (r) phone = r;
        } catch (_) {}
    }
    const num = formatPhoneDisplay(phone);
    let name = null;
    try { name = await resolvePersonName(sock, utils, groupJid, phone); } catch (_) {}
    if (!name && phone !== raw) {
        try { name = await resolvePersonName(sock, utils, groupJid, raw); } catch (_) {}
    }
    return { name, phone, lines: name ? [`*${name}*`, `   ${num}`] : [num] };
}

module.exports = {
    digitsOf,
    stripDevice,
    isLidJid,
    isPhoneJid,
    isGroupJid,
    formatPhoneDisplay,
    cleanPersonName,
    senderPhonesFromMessage,
    senderLidsFromMessage,
    messageAliasKeys,
    groupsForSearch,
    resolveLidPhone,
    buildLidPhoneMap,
    resolvePersonName,
    resolveCandidateToPhone,
    findStoredMatch,
    healPhoneList,
    targetKeys,
    warnCount,
    warnSetAll,
    warnDeleteAll,
    personLabel,
    displayPerson
};
