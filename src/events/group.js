const { isDashboardEnabled, getDashboardGroupInfo, upsertDashboardGroupInfo, groupMetadataCached, clearGroupMetadataCache, isBlacklisted, isBlacklistedAny, botIsAdmin, recordModEvent, getGroupData, getThemeForJid, normalizeJid, deactivateGroup } = require('../database/utils');
const identity = require('../services/identity');
const { getTheme } = require('../services/themes');
const { generateWelcomeImage, getUserAvatarBuffer, getGroupAvatarBuffer, resolveDisplayJid, displayNameForEvent } = require('../services/welcomeImage');
const store = require('../history/store');

const safeDashboardLog = (...args) => { try { store.writeLog(...args); } catch (_) {} };
const safeRemember = (...args) => { try { store.rememberGroup(...args); } catch (_) {} };

// Último título/descrição conhecidos por grupo — anti-spam do groups.update,
// que costuma repetir subject/desc mesmo sem mudança real.
const _groupSnapshot = new Map(); // jid -> { subject: string|null, desc: string|null }

// === Cooldown de boas-vindas: 40min por grupo (anti-spam) ===
// Se muita gente entra em sequência (ou alguém entra/sai repetidamente),
// o bot manda no máximo 1 leva de boas-vindas a cada 40min por grupo.
// Persistido em disco para sobreviver a restart (senão reiniciar zeraria a janela e spammava).
const fs = require('fs');
const path = require('path');
const WELCOME_COOLDOWN_MS = 40 * 60 * 1000;
const _welcomeLast = new Map(); // jid -> timestamp do último envio
const WELCOME_STATE_FILE = path.join(__dirname, '..', '..', 'data', 'welcome-state.json');
let _welcomeLoaded = false;

function _loadWelcomeState() {
    if (_welcomeLoaded) return;
    _welcomeLoaded = true;
    try {
        if (!fs.existsSync(WELCOME_STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(WELCOME_STATE_FILE, 'utf8') || '{}');
        for (const [jid, ts] of Object.entries(raw)) {
            if (!jid || !String(jid).endsWith('@g.us')) continue;
            const t = Number(ts) || 0;
            if (t > 0) _welcomeLast.set(jid, t);
        }
    } catch (_) {}
}

function _saveWelcomeState() {
    try {
        const dir = path.dirname(WELCOME_STATE_FILE);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        const obj = {};
        for (const [jid, ts] of _welcomeLast) obj[jid] = ts;
        fs.writeFileSync(WELCOME_STATE_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
}

try { _loadWelcomeState(); } catch (_) {}

function getWelcomeRemainingMs(jid) {
    try { _loadWelcomeState(); } catch (_) {}
    const last = _welcomeLast.get(jid) || 0;
    if (!last) return 0;
    return Math.max(0, WELCOME_COOLDOWN_MS - (Date.now() - last));
}

function markWelcomeSent(jid) {
    try { _loadWelcomeState(); } catch (_) {}
    _welcomeLast.set(jid, Date.now());
    try { _saveWelcomeState(); } catch (_) {}
}

/**
 * O próprio bot saiu/foi removido do grupo? Compara JID normalizado +
 * dígitos (o evento pode trazer @s.whatsapp.net e o sock ter outro
 * formato). Pura/testável — ver test/services/broadcast-targets.test.js.
 */
function isBotRemoved(anu, botId) {
    try {
        if (!anu || anu.action !== 'remove' || !Array.isArray(anu.participants) || !anu.participants.length) return false;
        if (!botId) return false;
        let meNorm = null;
        let meDigits = null;
        try { meNorm = normalizeJid(botId); } catch (_) {}
        try { meDigits = String(botId).split('@')[0].split(':')[0].replace(/\D/g, '') || null; } catch (_) {}
        if (!meNorm && !meDigits) return false;
        return anu.participants.some((p) => {
            try {
                if (meNorm && normalizeJid(p) === meNorm) return true;
                if (meDigits) {
                    const d = String(p).split('@')[0].split(':')[0].replace(/\D/g, '');
                    if (d && d === meDigits) return true;
                }
            } catch (_) {}
            return false;
        });
    } catch (_) { return false; }
}

function snapshotGroup(jid, meta) {
    try {
        if (!jid || !meta) return;
        const prev = _groupSnapshot.get(jid) || {};
        _groupSnapshot.set(jid, {
            subject: typeof meta.subject === 'string' ? meta.subject : (prev.subject ?? null),
            desc: typeof meta.desc === 'string' ? meta.desc : (prev.desc ?? null)
        });
    } catch (_) {}
}

async function resolveTheme(groupJid) {
    try {
        const themeId = (typeof getThemeForJid === 'function' ? getThemeForJid(groupJid) : 'default');
        return getTheme(themeId);
    } catch (_) { return null; }
}

async function sendEventCard(sock, { groupJid, mode, userJid, authorJid, defaultMsg, customMsg, subject, memberCount, theme, groupAvatarRaw, fetchUserAvatar, participants }) {
    const parts = Array.isArray(participants) ? participants : [];
    // Eventos do grupo trazem @lid (número opaco): resolve para o telefone
    // para nome, legenda e busca da foto. Sem pushName aqui, é o melhor sinal.
    // LID não resolvido nunca aparece cru no texto (usa nome/'Novo membro').
    const displayJid = resolveDisplayJid(userJid, parts);
    const displayIsLid = String(displayJid).toLowerCase().endsWith('@lid');
    const mentionTag = displayIsLid
        ? displayNameForEvent(userJid, parts)
        : `@${String(displayJid).split('@')[0].split(':')[0]}`;
    // Promoção/rebaixamento: quem FEZ a ação (anu.author) aparece no card e na legenda.
    const isActorMode = (mode === 'promote' || mode === 'demote') && !!authorJid;
    const actorDisplayJid = isActorMode ? resolveDisplayJid(authorJid, parts) : null;
    const actorIsLid = actorDisplayJid ? String(actorDisplayJid).toLowerCase().endsWith('@lid') : false;
    const actorTag = actorDisplayJid
        ? (actorIsLid ? displayNameForEvent(authorJid, parts) : `@${String(actorDisplayJid).split('@')[0].split(':')[0]}`)
        : '';
    const actorName = isActorMode ? displayNameForEvent(authorJid, parts) : null;
    const msg = (customMsg || '').toString().trim() || defaultMsg;
    const text = msg.split('@user').join(mentionTag).split('{autor}').join(actorTag).split('{grupo}').join(subject);
    const mentions = [...new Set([userJid, displayJid, authorJid, actorDisplayJid].filter(Boolean))];
    try {
        const userName = displayNameForEvent(userJid, parts);
        const [avatarRaw, actorAvatarRaw] = await Promise.all([
            fetchUserAvatar ? getUserAvatarBuffer(sock, userJid, groupJid, groupMetadataCached, parts).catch(() => null) : Promise.resolve(null),
            isActorMode ? getUserAvatarBuffer(sock, authorJid, groupJid, groupMetadataCached, parts).catch(() => null) : Promise.resolve(null)
        ]);
        const card = await generateWelcomeImage({
            mode,
            userName,
            actorName,
            groupName: subject,
            memberCount,
            message: text.replace(/@\S+/g, '').trim(),
            avatarRaw,
            actorAvatarRaw,
            groupAvatarRaw: groupAvatarRaw || null,
            theme
        });
        if (card) {
            await sock.sendMessage(groupJid, { image: card, caption: text, mentions });
            return true;
        }
    } catch (_) {}
    await sock.sendMessage(groupJid, { text, mentions });
    return true;
}

// Lote de boas-vindas: N entradas no mesmo evento viram 1 única mensagem
// com todas as menções (menos spam que N cards). Usa o avatar/nome do
// primeiro para o card, mas menciona todos no texto.
async function sendWelcomeBatch(sock, { groupJid, userJids, defaultMsg, customMsg, subject, memberCount, theme, groupAvatarRaw, participants }) {
    const parts = Array.isArray(participants) ? participants : [];
    const tags = userJids.map((u) => {
        const d = resolveDisplayJid(u, parts);
        if (String(d).toLowerCase().endsWith('@lid')) return displayNameForEvent(u, parts);
        return `@${String(d).split('@')[0].split(':')[0]}`;
    });
    const allTags = tags.join(' ');
    const msg = (customMsg || '').toString().trim() || defaultMsg;
    // @user vira a lista de todos; sem @user, anexa a lista no fim.
    let text = msg.split('{grupo}').join(subject);
    if (text.includes('@user')) text = text.split('@user').join(allTags);
    else text = `${text}\n${allTags}`;
    const displayJids = userJids.map((u) => resolveDisplayJid(u, parts));
    const mentions = [...new Set([...userJids, ...displayJids].filter(Boolean))];
    try {
        const firstName = displayNameForEvent(userJids[0], parts);
        let avatarRaw = null;
        try { avatarRaw = await getUserAvatarBuffer(sock, userJids[0], groupJid, groupMetadataCached, parts).catch(() => null); } catch (_) {}
        const card = await generateWelcomeImage({
            mode: 'welcome',
            userName: userJids.length > 1 ? `${firstName} +${userJids.length - 1}` : firstName,
            groupName: subject,
            memberCount,
            message: text.replace(/@\S+/g, '').trim(),
            avatarRaw,
            groupAvatarRaw: groupAvatarRaw || null,
            theme
        });
        if (card) {
            await sock.sendMessage(groupJid, { image: card, caption: text, mentions });
            return true;
        }
    } catch (_) {}
    await sock.sendMessage(groupJid, { text, mentions });
    return true;
}

module.exports = {
    handleGroupParticipantsUpdate: async (sock, anu) => {
        // Invalida cache ANTES de qualquer early-return: mudança de participantes
        // afeta getAdmins/enforcement, não só o dashboard.
        try { clearGroupMetadataCache(anu.id); } catch (_) {}

        // O próprio bot saiu/foi removido/banido: desliga na hora (total+parcial).
        // Sem isso a linha apodrecia em active_groups e o /broadcast contava
        // grupo morto (só gerava falha no envio).
        try {
            const botId = sock?.user?.id || sock?.user?.jid || '';
            if (isBotRemoved(anu, botId)) {
                try { deactivateGroup(anu.id); } catch (_) {}
                try { console.log(`👋 [groups] bot saiu/foi removido de ${anu.id} — desativado (total+parcial)`); } catch (_) {}
                return;
            }
        } catch (_) {}

        // === Analytics !infogrupo: entradas/saídas (últimos 90 dias) ===
        try {
            if (anu.action === 'add' && Array.isArray(anu.participants)) {
                for (const _p of anu.participants) { try { recordModEvent(anu.id, 'join'); } catch (_) {} }
            } else if (anu.action === 'remove' && Array.isArray(anu.participants)) {
                for (const _p of anu.participants) { try { recordModEvent(anu.id, 'leave'); } catch (_) {} }
            }
        } catch (_) {}

        // === Lista negra: auto-ban ao tentar voltar ao grupo ===
        if (anu.action === 'add' && Array.isArray(anu.participants) && anu.participants.length > 0) {
            try {
                // Metadados do próprio grupo: resolve @lid<->telefone sem varredura.
                let joinParts = [];
                try {
                    const jm = await groupMetadataCached(sock, anu.id).catch(() => null);
                    if (Array.isArray(jm?.participants)) joinParts = jm.participants;
                } catch (_) {}
                const aliasesOf = (p) => {
                    const out = [p];
                    try {
                        const want = identity.digitsOf(p);
                        for (const part of joinParts) {
                            const cands = [part.id, part.jid, part.lid, part.phoneNumber, part.pn].filter(Boolean).map(String);
                            if (!cands.map(identity.digitsOf).includes(want)) continue;
                            for (const c of cands) out.push(c);
                        }
                    } catch (_) {}
                    return [...new Set(out)];
                };
                const blacklistedToBan = [];
                for (const p of anu.participants) {
                    try {
                        const hit = typeof isBlacklistedAny === 'function'
                            ? isBlacklistedAny(anu.id, aliasesOf(p))
                            : isBlacklisted(anu.id, p);
                        if (hit) blacklistedToBan.push(p);
                    } catch (_) {}
                }
                if (blacklistedToBan.length > 0) {
                    const isBotAdmin = await botIsAdmin(sock, anu.id);
                    if (!isBotAdmin) {
                        console.log(`🚫 [listanegra] ${blacklistedToBan.length} usuário(s) da lista negra tentaram entrar em ${anu.id}, mas bot não é admin para banir.`);
                    } else {
                        for (const target of blacklistedToBan) {
                            try {
                                await sock.groupParticipantsUpdate(anu.id, [target], 'remove');
                                // Rótulo seguro: nome > telefone formatado; nunca LID cru.
                                let who = 'membro';
                                try {
                                    const want = identity.digitsOf(target);
                                    for (const part of joinParts) {
                                        const cands = [part.id, part.jid, part.lid, part.phoneNumber, part.pn].filter(Boolean).map(String);
                                        if (!cands.map(identity.digitsOf).includes(want)) continue;
                                        const nm = part.notify || part.name || part.verifiedName;
                                        if (nm && !/^(usuário|usuario)$/i.test(String(nm).trim())) { who = String(nm).trim().slice(0, 30); break; }
                                        const ph = cands.filter((c) => !identity.isLidJid(c)).map(identity.digitsOf).find((d) => d && d.length >= 8 && d.length <= 15);
                                        if (ph) { who = identity.formatPhoneDisplay(ph); break; }
                                        break;
                                    }
                                    if (who === 'membro' && !identity.isLidJid(target)) who = identity.formatPhoneDisplay(want) || 'membro';
                                } catch (_) {}
                                console.log(`🚫 [listanegra] auto-ban: ${who} removido de ${anu.id}`);
                                // Avisa no grupo
                                try {
                                    await sock.sendMessage(anu.id, { text: `🚫 ${who} está na lista negra e foi removido automaticamente.`, mentions: [target] });
                                } catch (_) {}
                                // Loga no dashboard (se houver metadata para nome)
                                try {
                                    const meta = await groupMetadataCached(sock, anu.id).catch(() => null);
                                    const subject = meta?.subject || 'Grupo';
                                    safeDashboardLog('event', subject, `🚫 Lista negra: ${who} auto-banido`, null, identity.isLidJid(target) ? null : identity.digitsOf(target), null, {
                                        toJid: anu.id,
                                        senderJid: target,
                                        fromMe: false
                                    });
                                } catch (_) {}
                            } catch (e) {
                                console.error(`❌ [listanegra] falha ao auto-banir ${target}:`, e.message);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Erro na verificação de lista negra:', e);
            }
        }

        // === Avisos do grupo com card (foto do grupo no fundo, igual !menu) ===
        // add/remove/promote/demote — cada um com on/off + msg próprios (ver !bemvindo).
        if ((['add', 'remove', 'promote', 'demote'].includes(anu.action)) && Array.isArray(anu.participants) && anu.participants.length > 0) {
            try {
                const gd = getGroupData(anu.id) || {};
                const isJoin = anu.action === 'add';
                const isLeave = anu.action === 'remove';
                const isPromote = anu.action === 'promote';
                const isDemote = anu.action === 'demote';

                // Retrocompat: quem nunca configurou promove/rebaixa começa DESLIGADO.
                // Quem já tinha welcome/goodbye mantém o comportamento antigo.
                const on = isJoin ? !!gd.welcomeOn
                    : isLeave ? !!gd.goodbyeOn
                    : isPromote ? !!gd.promoteOn
                    : !!gd.demoteOn;
                const customMsg = isJoin ? gd.welcomeMsg : isLeave ? gd.goodbyeMsg : isPromote ? gd.promoteMsg : gd.demoteMsg;
                const mode = isJoin ? 'welcome' : isLeave ? 'goodbye' : isPromote ? 'promote' : 'demote';
                const defaultMsg = isJoin ? '👋 Bem-vindo @user ao {grupo}!'
                    : isLeave ? '👋 @user saiu do grupo. Até mais!'
                    : isPromote ? '👑 {autor} promoveu @user a admin do {grupo}! 🎉'
                    : '📉 {autor} rebaixou @user de admin do {grupo}.';

                if (on) {
                    // Anti-spam boas-vindas: 1 leva a cada 40min por grupo.
                    // Entradas dentro da janela são ignoradas (sem mensagem) para não spammar
                    // quando entra muita gente em sequência ou alguém entra/sai repetidamente.
                    let welcomeOnCooldown = false;
                    if (isJoin) {
                        const rest = getWelcomeRemainingMs(anu.id);
                        if (rest > 0) {
                            const min = Math.ceil(rest / 60000);
                            console.log(`🤫 [welcome] cooldown ativo em ${anu.id} (faltam ~${min}min) — ${anu.participants.length} entrada(s) ignorada(s).`);
                            safeDashboardLog('event', 'Grupo', `🤫 Boas-vindas ignoradas (cooldown ~${min}min)`, null, null, null, { toJid: anu.id, fromMe: true });
                            // Não retorna: cai para o log do dashboard abaixo normalmente.
                            // Marca como tratado para pular o envio.
                            welcomeOnCooldown = true;
                        }
                    }
                    if (!welcomeOnCooldown) {
                        let subject = 'o grupo';
                        let memberCount = 0;
                        let eventParticipants = [];
                        try {
                            const meta = await groupMetadataCached(sock, anu.id).catch(() => null);
                            if (meta?.subject) subject = meta.subject;
                            if (Array.isArray(meta?.participants)) { memberCount = meta.participants.length; eventParticipants = meta.participants; }
                            snapshotGroup(anu.id, meta); // mantém a base do anti-spam atualizada
                        } catch (_) {}
                        const theme = await resolveTheme(anu.id);
                        // Foto do grupo como fundo do card (igual !menu) — busca 1x por evento.
                        let groupAvatarRaw = null;
                        try { groupAvatarRaw = await getGroupAvatarBuffer(sock, anu.id).catch(() => null); } catch (_) {}
                        if (isJoin) {
                            // Lote único: N entradas no mesmo evento (ou rajada) viram 1 mensagem
                            // com todas as menções, em vez de N mensagens. Conta como 1 envio p/ o cooldown.
                            // Filtra quem está na lista negra (casa telefone<->LID via aliases).
                            const targets = anu.participants.filter((p) => {
                                try {
                                    if (typeof isBlacklistedAny !== 'function') return !isBlacklisted(anu.id, p);
                                    const want = identity.digitsOf(p);
                                    const aliases = [p];
                                    for (const part of eventParticipants) {
                                        const cands = [part.id, part.jid, part.lid, part.phoneNumber, part.pn].filter(Boolean).map(String);
                                        if (cands.map(identity.digitsOf).includes(want)) {
                                            for (const c of cands) aliases.push(c);
                                            break;
                                        }
                                    }
                                    return !isBlacklistedAny(anu.id, [...new Set(aliases)]);
                                } catch (_) { return true; }
                            });
                            if (targets.length === 1) {
                                try {
                                    await sendEventCard(sock, {
                                        groupJid: anu.id, mode, userJid: targets[0],
                                        authorJid: anu.author || null,
                                        defaultMsg, customMsg, subject, memberCount, theme,
                                        groupAvatarRaw,
                                        participants: eventParticipants,
                                        fetchUserAvatar: true
                                    });
                                } catch (_) {}
                            } else if (targets.length > 1) {
                                try {
                                    await sendWelcomeBatch(sock, {
                                        groupJid: anu.id, userJids: targets,
                                        defaultMsg, customMsg, subject, memberCount, theme,
                                        groupAvatarRaw, participants: eventParticipants
                                    });
                                } catch (_) {}
                            }
                            if (targets.length > 0) markWelcomeSent(anu.id);
                        } else {
                            for (const p of anu.participants) {
                                try {
                                    await sendEventCard(sock, {
                                        groupJid: anu.id, mode, userJid: p,
                                        authorJid: anu.author || null,
                                        defaultMsg, customMsg, subject, memberCount, theme,
                                        groupAvatarRaw,
                                        participants: eventParticipants,
                                        // Na saída o WhatsApp costuma já ter apagado a foto — busca só no resto.
                                        fetchUserAvatar: !isLeave
                                    });
                                } catch (_) {}
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Erro nos avisos de grupo:', e.message);
            }
        }

        if (!isDashboardEnabled(anu.id)) return;
        try {            const metadata = await groupMetadataCached(sock, anu.id).catch(() => null);
            const subject = metadata?.subject || null;
            const memberCount = Array.isArray(metadata?.participants) ? metadata.participants.length : undefined;
            if (subject) {
                safeRemember(anu.id, { subject, memberCount });
            } else if (memberCount !== undefined) {
                safeRemember(anu.id, { memberCount });
            }
            if (!metadata) return;

            for (const num of anu.participants) {
                const phone = num.split('@')[0];
                let text = '';
                if (anu.action === 'add') text = `Entrou no grupo`;
                else if (anu.action === 'remove') text = `Saiu ou foi removido`;
                else if (anu.action === 'promote') text = `Promovido a admin`;
                else if (anu.action === 'demote') text = `Rebaixado de admin`;
                
                if (text) {
                    safeDashboardLog('event', subject || 'Grupo', text, null, phone, null, { 
                        toJid: anu.id, 
                        senderJid: num, 
                        fromMe: false 
                    });
                }
            }
        } catch (e) {
            console.error('Erro no group-participants.update:', e);
        }
    },

    // Mudanças de grupo: avisa SÓ título/descrição que realmente mudaram.
    // O WhatsApp repete subject/desc em quase todo groups.update (ex: ao
    // abrir/fechar o grupo), então compara com o último valor conhecido e
    // fica em silêncio se nada mudou. Abrir/fechar e permissões NÃO avisam.
    handleGroupUpdate: async (sock, updates) => {
        const list = Array.isArray(updates) ? updates : [updates];
        for (const u of list) {
            try {
                if (!u || !u.id || !String(u.id).endsWith('@g.us')) continue;
                try { clearGroupMetadataCache(u.id); } catch (_) {}
                const gd = getGroupData(u.id) || {};
                if (!gd.groupChangeOn) continue;

                // Fonte da verdade: metadados frescos (cache invalidado acima).
                let meta = null;
                try { meta = await groupMetadataCached(sock, u.id).catch(() => null); } catch (_) {}
                const curSubject = (meta && typeof meta.subject === 'string' && meta.subject) || u.subject || null;
                const curDesc = (meta && typeof meta.desc === 'string') ? meta.desc : (typeof u.desc === 'string' ? u.desc : null);

                const prev = _groupSnapshot.get(u.id) || null;
                if (!prev) {
                    // Primeira visão: grava a base sem avisar (evita spam de valores antigos).
                    _groupSnapshot.set(u.id, { subject: curSubject, desc: curDesc });
                    continue;
                }

                // Só entra no aviso o que MUDOU de verdade (texto simples, sem poluir).
                const changes = [];
                if (curSubject && prev.subject && curSubject !== prev.subject) {
                    changes.push(`📝 Título atualizado`);
                }
                if (curSubject && curSubject !== prev.subject) prev.subject = curSubject;
                if (curDesc !== null && prev.desc !== null && curDesc !== prev.desc) {
                    changes.push(`📄 Descrição atualizada`);
                }
                if (curDesc !== null && curDesc !== prev.desc) prev.desc = curDesc;
                if (changes.length === 0) continue; // nada mudou: silêncio, sem poluir

                let subject = curSubject || 'o grupo';
                let memberCount = 0;
                try {
                    if (Array.isArray(meta?.participants)) memberCount = meta.participants.length;
                } catch (_) {}
                const theme = await resolveTheme(u.id);
                const customMsg = (gd.groupChangeMsg || '').toString().trim();
                const detail = changes.join('\n');
                const defaultMsg = detail; // texto simples: só o rótulo do que mudou
                const text = (customMsg || defaultMsg).split('{grupo}').join(subject).split('{mudancas}').join(detail);

                try {
                    let groupAvatarRaw = null;
                    try { groupAvatarRaw = await getGroupAvatarBuffer(sock, u.id).catch(() => null); } catch (_) {}
                    const card = await generateWelcomeImage({
                        mode: 'groupchange',
                        userName: subject.slice(0, 24),
                        groupName: subject,
                        memberCount,
                        message: detail.replace(/\*/g, '').slice(0, 120),
                        avatarRaw: groupAvatarRaw,
                        groupAvatarRaw,
                        theme
                    });
                    if (card) {
                        await sock.sendMessage(u.id, { image: card, caption: text });
                        continue;
                    }
                } catch (_) {}
                await sock.sendMessage(u.id, { text });
            } catch (e) {
                console.error('Erro no group.update:', e.message);
            }
        }
    },
    // Exportados p/ !bemvindo ver/status e testes.
    getWelcomeRemainingMs,
    markWelcomeSent,
    isBotRemoved,
    WELCOME_COOLDOWN_MS
};
