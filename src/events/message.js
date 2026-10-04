const { getModel } = require('../services/ai');
const { resolveCommand } = require('../commands/loader');
const cooldown = require('../services/cooldown');
const trace = require('../services/trace');
const { handleDashboardLog, handleProtocolMessage, handleReaction, safeDashboardLog, safeDashboardRememberGroup } = require('../history/handler');
const { enforceMuteAndAntilink } = require('./enforcement');
const { agentCommand } = require('../services/agentLog');

const {
    isActiveGroup, isPartialActive, getPartialWaitMs,
    incrementCommand, formatUptime,
    readConfig, saveMessage,
    getBotName, react, getMessageText,
    isDashboardEnabled, groupMetadataCached, updateMemberActivity, recordGroupMessage,
    shouldRecordHistory,
    readStats, getPrefixForJid, getAllPrefixesForJid, matchPrefixForJid, getGroupData, setGroupData,
    getGuardioes
} = require('../database/utils');

// ============================================================
// Deduplication (TTL por mensagem — nunca clear() total)
// ============================================================
const processedMessages = new Map(); // dedupKey -> timestamp ms
const DEDUP_MAX = 5000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h: cobre replays de reconnect
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000; // re-entrega com +5min é replay: ignora

function _evictDedupIfNeeded() {
    // Remove expirados primeiro; se ainda estourar, remove os mais antigos
    // (Map preserva ordem de inserção).
    try {
        const now = Date.now();
        for (const [k, ts] of processedMessages) {
            if (now - ts > DEDUP_TTL_MS) processedMessages.delete(k);
            else break; // mais recentes adiante — para
        }
    } catch (_) {}
    if (processedMessages.size > DEDUP_MAX) {
        let n = processedMessages.size - DEDUP_MAX + 1000;
        for (const k of processedMessages.keys()) {
            processedMessages.delete(k);
            if (--n <= 0) break;
        }
    }
}

// ============================================================
// Aviso de grupo não ativado — UMA única vez por grupo (nunca repete)
// ============================================================
// Flag em memória (rápido) + persistida em group_state.extra.inactiveNoticed
// (sobrevive a restart). Quando avisado, nunca mais avisa naquele grupo.
const inactiveNoticedGroups = new Set();

function hasInactiveNoticed(from) {
    try {
        if (inactiveNoticedGroups.has(from)) return true;
        const gd = getGroupData(from) || {};
        if (gd.inactiveNoticed) { inactiveNoticedGroups.add(from); return true; }
    } catch (_) {}
    return false;
}

function markInactiveNoticed(from) {
    try { inactiveNoticedGroups.add(from); } catch (_) {}
    try { setGroupData(from, { inactiveNoticed: true }); } catch (_) {}
}

// Envia o aviso "bot ainda não ativado" uma única vez por grupo.
// Retorna true se enviou, false se já tinha avisado (ou falhou).
async function maybeSendInactiveNotice(sock, m, from, effectivePrefix, config) {
    try {
        if (!from || !String(from).endsWith('@g.us')) return false;
        if (m?.key?.fromMe) return false;
        if (hasInactiveNoticed(from)) return false;
        markInactiveNoticed(from);
        let botName = 'Bot';
        try { botName = getBotName(from, config); } catch (_) {}
        // Números dos guardiões para contato (podem ativar com !ativar).
        let guardLine = '';
        try {
            const guards = (typeof getGuardioes === 'function' ? getGuardioes() : []) || [];
            if (guards.length) {
                const shown = guards.slice(0, 10).map((n) => `wa.me/${n}`).join(' • ');
                const extra = guards.length > 10 ? ` (+${guards.length - 10})` : '';
                guardLine = `\n\n🛡️ *Guardiões:* ${shown}${extra}\n📩 Chame um deles no privado para ativar 🙏`;
            }
        } catch (_) {}
        const text = `🤖 *${botName}* ainda não foi ativado neste grupo.\n\n` +
            `⏳ Aguarde até que o dono ou um sub-dono ative com *${effectivePrefix}ativar*.${guardLine}`;
        await sock.sendMessage(from, { text }, { quoted: m });
        return true;
    } catch (_) { return false; }
}

// ============================================================
// Recent message buffer (for !limpar)
// ============================================================
const RECENT_BUFFER_LIMIT = 100;
const recentMessagesByGroup = new Map();

function trackRecentMessage(jid, key) {
    if (!jid || !key || !key.id) return;
    if (recentMessagesByGroup.size > 500 && !recentMessagesByGroup.has(jid)) {
        const oldest = recentMessagesByGroup.keys().next().value;
        recentMessagesByGroup.delete(oldest);
    }
    let list = recentMessagesByGroup.get(jid);
    if (!list) { list = []; recentMessagesByGroup.set(jid, list); }
    list.push({ id: key.id, participant: key.participant || null, fromMe: !!key.fromMe });
    if (list.length > RECENT_BUFFER_LIMIT) list.shift();
}

function getRecentMessages(jid, limit) {
    const list = recentMessagesByGroup.get(jid) || [];
    return list.slice(-Math.max(1, Math.min(limit, list.length)));
}

// ============================================================
// Partial Activation (lógica em ./partial.js — módulo sem deps, testável)
// ============================================================
const {
    partialPending,
    PARTIAL_ALLOWED_CATEGORIES,
    PARTIAL_ALLOWED_COMMANDS,
    PARTIAL_BLOCKED_COMMANDS,
    PARTIAL_BYPASS_COMMANDS,
    registerPartialPending,
    cancelPartialPending,
    notifyPartialReaction,
    cancelPartialPendingForGroup,
    setPartialTimer,
    isPartialAllowed: _isPartialAllowed
} = require('./partial');

// ============================================================
// Constants
// ============================================================
const GLOBAL_COOLDOWN = 1000;
let lastBotResponse = 0;
// ============================================================
// Main message handler
// ============================================================
module.exports = {
    handleMessageUpsert: async (sock, { messages, type }, { commands, config, startTime }) => {
        if (type !== 'notify' && !messages?.some(msg => msg?.key?.fromMe)) return;
        const _evtStart = Date.now();
        try {
            // B1: antes só messages[0] — lote Baileys com N msgs perdia N-1.
            // Agora itera sequencialmente (ordem preservada, sem concorrência).
            for (const m of (messages || [])) {
                try {
                    await _handleSingleMessage(sock, m, { commands, config, startTime });
                } catch (e) {
                    console.error(`[${trace.ts()}] [evt] mensagem ${m?.key?.id || '?'} ERRO: ${e.message} | stack[0]=${(e.stack||'').split('\n')[1]?.trim() || ''}`);
                }
            }
        } catch (e) {
            console.error(`[${trace.ts()}] [evt] messages.upsert ERRO: ${e.message} | stack[0]=${(e.stack||'').split('\n')[1]?.trim() || ''} (após ${Date.now()-_evtStart}ms)`);
            console.error('Erro ao processar mensagem:', e);
        }
    },
    trackRecentMessage,
    getRecentMessages,
    notifyPartialReaction,
    cancelPartialPending,
    cancelPartialPendingForGroup,
    registerPartialPending,
    setPartialTimer,
    isPartialAllowed: _isPartialAllowed,
    PARTIAL_ALLOWED_CATEGORIES,
    PARTIAL_ALLOWED_COMMANDS,
    PARTIAL_BLOCKED_COMMANDS,
    PARTIAL_BYPASS_COMMANDS,
    isPartialActive
};

// Processa UMA mensagem (extraído p/ suportar lote Baileys sem duplicar lógica).
async function _handleSingleMessage(sock, m, { commands, config, startTime }) {
    if (!m?.key) return;
            const dedupKey = `${m.key.remoteJid || ''}:${m.key.id || ''}`;
            try {
                const seenAt = processedMessages.get(dedupKey);
                if (seenAt && (Date.now() - seenAt) < DEDUP_TTL_MS) return;
                if (!m.message) return;
            } catch (_) { if (!m.message) return; }

            let messageTime = 0;
            if (m.messageTimestamp) {
                if (typeof m.messageTimestamp === 'number') messageTime = m.messageTimestamp;
                else if (typeof m.messageTimestamp === 'object' && typeof m.messageTimestamp.low === 'number') messageTime = m.messageTimestamp.low;
                else messageTime = Number(m.messageTimestamp) || 0;
                if (messageTime > 1e12) messageTime = Math.floor(messageTime / 1000);
            }
            if (messageTime < Math.floor(startTime / 1000) + 2) return;
            // Replay antigo (reconnect/offline re-entregando notify de minutos
            // atrás): ignora. Não afeta mensagens novas nem fromMe.
            try {
                if (messageTime > 0 && !m.key.fromMe) {
                    const ageMs = Date.now() - messageTime * 1000;
                    if (ageMs > REPLAY_MAX_AGE_MS) return;
                }
            } catch (_) {}

            _evictDedupIfNeeded();
            try { processedMessages.set(dedupKey, Date.now()); } catch (_) {}

            const from = m.key.remoteJid;
            if (!from) return;
            const isGroup = from.endsWith('@g.us');
            const effectivePrefix = isGroup ? getPrefixForJid(from) : config.prefix;
            // Multiprefixo: lista efetiva por grupo (principal + global + extras).
            let effectivePrefixes = [effectivePrefix];
            let matchedPrefix = '';
            try {
                if (isGroup && typeof getAllPrefixesForJid === 'function') {
                    effectivePrefixes = getAllPrefixesForJid(from);
                    if (!Array.isArray(effectivePrefixes) || !effectivePrefixes.length) effectivePrefixes = [effectivePrefix];
                }
                if (typeof matchPrefixForJid === 'function') matchedPrefix = matchPrefixForJid((getMessageText(m.message) || '').trim(), from) || '';
                else matchedPrefix = String(getMessageText(m.message) || '').trim().startsWith(effectivePrefix) ? effectivePrefix : '';
            } catch (_) { matchedPrefix = ''; }
            if (isGroup) trackRecentMessage(from, m.key);

            const sender = m.key.fromMe
                ? (sock.user?.id || m.key.participant || m.key.remoteJid)
                : (m.key.participant || m.key.remoteJid);
            // Sender canônico p/ contagem: prefere o nº real (@s.whatsapp.net) quando o
            // sender vier como @lid — senão a mesma pessoa gera 2 linhas no rank e os
            // totais de cada linha ficam menores que o real.
            let activitySender = sender;
            try {
                const pn = m.key?.participantPn || m.key?.senderPn;
                if (pn && String(pn).endsWith('@s.whatsapp.net') && !String(sender).endsWith('@s.whatsapp.net')) {
                    activitySender = pn;
                }
            } catch (_) {}
            const text = (getMessageText(m.message) || '').trim();
            const senderName = m.key.fromMe ? config.botName : (m.pushName || 'Usuário');

            // === Reactions ===
            if (await handleReaction(sock, m, from, sender, senderName)) {
                try {
                    const tgt = m.message?.reactionMessage?.key?.id || m.message?.ephemeralMessage?.message?.reactionMessage?.key?.id;
                    if (isGroup && tgt) notifyPartialReaction(from, tgt, sender, !!m.key.fromMe);
                } catch (_) {}
                return;
            }

            // === Protocol messages (deleted, etc) ===
            if (await handleProtocolMessage(sock, m, from, sender, senderName)) return;

            const botActive = !isGroup || isActiveGroup(from);
            // Histórico (!aidono/!resumir) independe do painel: grava em todo
            // grupo ativo ou parcial. PV mantém a regra antiga (painel).
            const historyOn = isGroup ? shouldRecordHistory(from) : isDashboardEnabled(from);

            // === Mute & Antilink & Antiflood enforcement ===
            if (isGroup && botActive) {
                const enforcement = await enforceMuteAndAntilink(sock, m, from, sender, text);
                if (enforcement === 'muted' || enforcement === 'antilink' || enforcement === 'antiflood') return;
            }

            // === Histórico p/ !aidono e !resumir (ativo + parcial, sem painel) ===
            if (historyOn) {
                const groupMetadata = isGroup
                    ? await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' }))
                    : { subject: senderName || 'Privado', participants: [] };
                await handleDashboardLog(sock, m, from, sender, senderName, text, groupMetadata);
            }

            // === Save message for !resumir (ativo + parcial, sem painel) ===
            if (isGroup && historyOn && text && !matchedPrefix) {
                saveMessage(from, m.pushName || senderName, text);
            }

            // === Activity tracking (bufferizado em memória, flush periódico) ===
            // Comandos (qualquer prefixo válido) NÃO contam como atividade — senão o próprio !rank
            // somaria +1 a quem chamou e o resultado mudaria a cada chamada.
            // Mensagens do próprio bot (fromMe) também NÃO contam — senão o bot
            // apareceria no próprio rank e inflaria os totais.
            const isCommandMsg = !!text && !!matchedPrefix;
            if (botActive && isGroup && !isCommandMsg && !m.key.fromMe) {
                updateMemberActivity(from, activitySender, senderName);
                try { recordGroupMessage(from, Date.now()); } catch (_) {}
            }
            // 💡 Splash cômico a cada N mensagens (contador por grupo).
            // Dispara no modo total E no parcial (no parcial o splash usa o
            // pool filtrado + card amarelo). Comandos e mensagens do bot não
            // contam. Fire-and-forget p/ não atrasar.
            if ((botActive || (isGroup && isPartialActive(from))) && isGroup && !isCommandMsg && !m.key.fromMe) {
                try {
                    const splash = require('../services/splash');
                    splash.handleMessage(sock, from, { prefix: effectivePrefix }).then((fired) => {
                        if (fired) {
                            try { safeDashboardLog('action', 'Grupo', '💡 splash curiosidade enviado', senderName, null, null, { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: false }); } catch (_) {}
                        }
                    }).catch(() => {});
                } catch (_) {}
            }

            // === Prefix query ===
            // Em grupo não ativado, "prefixo" também recebe o aviso único
            // (1x por grupo, nunca repete) em vez de silêncio.
            if ((text.toLowerCase() === 'prefixo' || text.toLowerCase() === 'prefix') && !botActive && isGroup && !isPartialActive(from)) {
                await maybeSendInactiveNotice(sock, m, from, effectivePrefix, config);
                return;
            }
            if ((text.toLowerCase() === 'prefixo' || text.toLowerCase() === 'prefix') && botActive) {
                const botName = getBotName(from, config);
                let prefixLine = `│ ⌨️ *Prefixo:* ${effectivePrefix}\n`;
                try {
                    if (isGroup && Array.isArray(effectivePrefixes) && effectivePrefixes.length > 1) {
                        prefixLine = `│ ⌨️ *Prefixos:* ${effectivePrefixes.map((p) => `*${p}*`).join(' ')}\n`;
                    }
                } catch (_) {}
                const prefixText = `*${botName} — Prefixo* ⌨️\n_prefixo atual_\n\n` +
                    `╭─── *PREFIXO* ───\n` +
                    prefixLine +
                    `│ 💡 *Alterar:* ${effectivePrefix}setprefix <símbolo>\n` +
                    `│ 🔀 *Vários:* ${effectivePrefix}multiprefixo on / ${effectivePrefix}multiprefixo set ! . /\n` +
                    `│ 🔄 *Resetar:* ${effectivePrefix}setprefix reset\n` +
                    `╰───────────────`;
                lastBotResponse = await react(sock, m, 'ℹ️', lastBotResponse, GLOBAL_COOLDOWN);
                return await sock.sendMessage(from, { text: prefixText }, { quoted: m });
            }

            // === Autoresponder (chat automático, personalidade automática por grupo) ===
            // Só texto sem prefixo, em grupo ativo, exceto mensagens do próprio bot.
            // Fire-and-forget p/ não atrasar comandos nem o handler.
            if (!matchedPrefix && isGroup && botActive && !m.key.fromMe && text) {
                try {
                    const auto = require('../services/autoResponder');
                    if (auto.isEnabled(from)) {
                        auto.maybeAutoReply(sock, m, { from, sender, senderName, text, config }).catch(() => {});
                    }
                } catch (_) {}
            }

            // === Command detection (multiprefixo: aceita qualquer prefixo válido) ===
            if (!matchedPrefix) return;
            const args = text.slice(matchedPrefix.length).trim().split(/ +/);
            const commandName = args.shift().toLowerCase();
            const fullArgsText = args.join(' ');

            const cmd = resolveCommand(commandName);
            if (!cmd) return;

            // === Activation control commands always work ===
            const activationControlCmds = ['ativar', 'desativar', 'ativarp', 'desativarp', 'status', 'statusp', 'dashboard', 'dash', 'painel', 'dashdel', 'dashremover', 'dashremove', 'news', 'noticias', 'feed'];
            const isPartActive = isGroup && isPartialActive(from);
            if (isGroup && !botActive && !isPartActive && !activationControlCmds.includes(cmd.name)) {
                // Grupo novo/não ativado: avisa UMA única vez (nunca repete).
                await maybeSendInactiveNotice(sock, m, from, effectivePrefix, config);
                return;
            }

            // === Cooldown ===
            if (!m.key.fromMe) {
                const remaining = cooldown.checkCooldown(cmd.name, sender);
                if (remaining > 0) {
                    const secs = Math.ceil(remaining / 1000);
                    console.log(`⏳ [COOLDOWN] !${commandName} por ${senderName} — aguarde ${secs}s`);
                    try { await sock.sendMessage(from, { react: { text: '⏳', key: m.key } }); } catch (_) {}
                    // Avisa o tempo em vez de silêncio: antes só reagia ⏳ e o
                    // usuário não sabia quanto esperar. Só em PV para não
                    // poluir grupo (em grupo a reação ⏳ já basta).
                    if (!isGroup) {
                        try { await sock.sendMessage(from, { text: `⏳ Aguarde *${secs}s* para usar *${effectivePrefix}${commandName}* novamente.` }, { quoted: m }); } catch (_) {}
                    }
                    return;
                }
            }

            const effectiveConfig = { ...config, prefix: effectivePrefix };
            // === Partial activation ===
            if (isPartActive) {
                if (PARTIAL_BYPASS_COMMANDS.has(cmd.name)) {
                    // bypass
                } else if (!_isPartialAllowed(cmd)) {
                    console.log(`🤐 [PARCIAL] comando ${effectivePrefix}${commandName} bloqueado em ${from}`);
                    try {
                        const gm = await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' }));
                        const phoneParcial = (()=>{ if(!sender) return null; if(String(sender).endsWith('@lid')){ const pn=m.key?.participantPn||m.key?.senderPn||null; if(pn&&pn.endsWith('@s.whatsapp.net')){const ph=pn.split('@')[0].split(':')[0]; if(/^\d{8,15}$/.test(ph)) return ph;} return null;} const ph=String(sender).split('@')[0].split(':')[0]; return /^\d{8,15}$/.test(ph)?ph:null; })();
                        safeDashboardLog('action', gm.subject, `🤐 [PARCIAL] !${commandName} bloqueado`, senderName, phoneParcial, null, { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe });
                    } catch (_) {}
                    return;
                } else {
                    // waitMs<=0: executa direto (sem pendência que ficaria órfã até o sweep).
                    const waitMs = getPartialWaitMs();
                    if (waitMs > 0) {
                        const botJid = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
                        const pendingPromise = registerPartialPending(from, m.key.id, commandName, botJid);
                        if (pendingPromise) {
                            setPartialTimer(from, m.key.id, waitMs);
                            const result = await pendingPromise;
                            if (result && result.reacted) {
                                console.log(`🤐 [PARCIAL] outro bot reagiu a !${commandName} em ${from}, ignorando`);
                                return;
                            }
                            // Grupo pode ter saído do parcial durante a espera.
                            if (!isPartialActive(from)) {
                                console.log(`🤐 [PARCIAL] grupo saiu do parcial durante espera de !${commandName}, ignorando`);
                                return;
                            }
                        }
                    }
                }
            }

            // === Pre-command tracking ===
            const groupMetadata = isGroup ? await groupMetadataCached(sock, from).catch(() => ({ subject: 'Grupo' })) : { subject: 'Privado' };
            if (isGroup) safeDashboardRememberGroup(from, {
                subject: groupMetadata.subject,
                memberCount: Array.isArray(groupMetadata.participants) ? groupMetadata.participants.length : undefined,
                ownerJid: groupMetadata.owner || groupMetadata.subjectOwner || null
            });

            const botActiveInGroup = botActive || isPartActive;
            if (botActiveInGroup || !isGroup) {
                const phoneExec = (()=>{ if(!sender) return null; if(String(sender).endsWith('@lid')){ const pn=m.key?.participantPn||m.key?.senderPn||null; if(pn&&pn.endsWith('@s.whatsapp.net')){const ph=pn.split('@')[0].split(':')[0]; if(/^\d{8,15}$/.test(ph)) return ph;} return null;} const ph=String(sender).split('@')[0].split(':')[0]; return /^\d{8,15}$/.test(ph)?ph:null; })();
                safeDashboardLog('action', groupMetadata.subject, `Comando executado: ${effectivePrefix}${commandName}`, senderName, phoneExec, null, { toJid: from, messageId: m.key.id, senderJid: sender, fromMe: !!m.key.fromMe });
            }

            console.log(`🤖 [INTERAÇÃO] Comando ${effectivePrefix}${commandName} por ${senderName} em ${from}`);
            incrementCommand();
            // Log básico no Telegram (sem toggle — envia sempre que configurado)
            try {
                const tg = require('../services/telegramAlerts');
                if (tg.isConfigured()) {
                    tg.notifyCommand({
                        botName: config.botName,
                        commandName,
                        prefix: effectivePrefix,
                        senderName,
                        sender,
                        group: isGroup ? (groupMetadata.subject || from) : 'privado',
                        args: fullArgsText || '',
                        elapsed: null
                    }).catch(()=>{});
                }
            } catch (_) {}

            const context = {
                from, isGroup, sender, senderName, fullArgsText, args, commandName,
                config: effectiveConfig, utils: require('../database/utils'), model: getModel(), startTime,
                lastBotResponse, GLOBAL_COOLDOWN,
                mediaHandler: require('./media'),
                ai: require('../services/ai')
            };

            // === Tracing contextual (sem monkey-patch do console — seguro p/ comandos concorrentes) ===
            const t0 = Date.now();
            let stepN = 0;
            const traceTag = `cmd.!${commandName}`;
            const cmdLog = (...a) => {
                const now = Date.now();
                const delta = now - t0;
                stepN += 1;
                const msg = a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(' ');
                console.log(`   └─ [${new Date().toLocaleTimeString('pt-BR', { hour12: false })}] [+${String(delta).padStart(5,' ')}ms / total ${now - t0}ms] ${traceTag} #${stepN}${msg ? ` ${msg}` : ''}`);
            };
            cmdLog('início', `${senderName} → ${effectivePrefix}${commandName}${fullArgsText ? ` args="${fullArgsText.slice(0,80)}"` : ''}`);

            // === Humanização pré-resposta (digitando + lido, como gente) ===
            // Só para comandos reais; reações/cooldown já saíram antes.
            try {
                const humanize = require('../services/humanize');
                if (humanize.isHumanMode(effectiveConfig)) {
                    await humanize.preReply(sock, from, m, { config: effectiveConfig });
                }
            } catch (_) {}
            // === Command execution (com timeout anti-zumbi) === p/ mídia o yt-dlp
            // sozinho pode levar até 180s + fallback; timeout menor matava !play
            // antes do fallback terminar. cancelToken permite ao comando
            // cooperativo (divulgar/transmitir) parar de verdade em vez de
            // continuar em background após o "interrompido".
            const CMD_TIMEOUT_MS = cmd.category === 'mídia'
                ? (Number(process.env.CMD_TIMEOUT_MEDIA_MS) || 210000)
                : (Number(process.env.CMD_TIMEOUT_MS) || 90000);
            // Trilha p/ bug-hunting: 1 linha JSON por execução (logs/agent_*.jsonl).
            // cid = message id — liga INTERAÇÃO → passos → erro sem adivinhar por timestamp.
            const _auditBase = () => {
                let version = '';
                try { version = require('../database/utils').getVersion() || ''; } catch (_) {}
                return {
                    cid: m?.key?.id || '', cmd: commandName, prefix: effectivePrefix,
                    category: cmd.category || '', args: fullArgsText || '',
                    from, group: groupMetadata.subject || '', sender, senderName,
                    fromMe: !!m?.key?.fromMe, version
                };
            };
            try {
                context.log = cmdLog;
                const { runCommandWithTimeout } = require('../services/commandRunner');
                const result = await runCommandWithTimeout(cmd, sock, m, context, CMD_TIMEOUT_MS);
                if (result !== undefined) lastBotResponse = result;
                const elapsed = Date.now() - t0;
                cmdLog('fim', `ok em ${elapsed}ms`);
                try { agentCommand({ ..._auditBase(), ok: true, cmd_ms: elapsed }); } catch (_) {}
                if (botActiveInGroup && elapsed >= 800) {
                    safeDashboardLog('action', groupMetadata.subject, `✅ !${commandName} concluído em ${elapsed}ms`, config.botName || 'Bot', (sock.user?.id || '').split(':')[0].split('@')[0] || 'bot', null, { toJid: from, messageId: m.key.id, senderJid: sock.user?.id || '', fromMe: true });
                }
            } catch (cmdErr) {
                const elapsed = Date.now() - t0;
                const isTimeout = cmdErr?.code === 'ETIMEDOUT' || cmdErr?.name === 'TimeoutError' || String(cmdErr?.message || '').includes('timeout') || String(cmdErr?.message || '').includes('excedeu timeout');
                if (isTimeout) {
                    console.warn(`⏱️ [CMD-TIMEOUT] ${effectivePrefix}${commandName} travou após ${elapsed}ms — liberando handler (anti-zumbi)`);
                    cmdLog('TIMEOUT', `travou após ${elapsed}ms`);
                    try { agentCommand({ ..._auditBase(), ok: false, err: 'timeout', cmd_ms: elapsed }); } catch (_) {}
                    try { await sock.sendMessage(from, { text: `⏱️ *${effectivePrefix}${commandName}* demorou demais e foi interrompido. Tente novamente.` }, { quoted: m }); } catch (_) {}
                    safeDashboardLog('error', groupMetadata.subject, `⏱️ Timeout em !${commandName} após ${elapsed}ms`, config.botName || 'Bot', (sock.user?.id || '').split(':')[0].split('@')[0] || 'bot', null, { toJid: from, messageId: m.key.id, senderJid: sock.user?.id || '', fromMe: true });
                } else {
                    const isConnClosed = cmdErr?.output?.statusCode === 428 || cmdErr?.output?.statusCode === 515 || String(cmdErr?.message || '').includes('Connection Closed') || String(cmdErr?.message || '').includes('Precondition Required');
                    if (isConnClosed) {
                        console.warn(`⚠️ [CMD-WARN] ${effectivePrefix}${commandName}: conexão fechada (428) após ${elapsed}ms — ignorado, reconexão automática`);
                        cmdLog('WARN', `Connection Closed (após ${elapsed}ms) — socket será reconectado`);
                        try { agentCommand({ ..._auditBase(), ok: false, err: 'connection-closed', cmd_ms: elapsed }); } catch (_) {}
                        // Feedback ao usuário: antes era só warn no terminal e
                        // parecia que o bot ignorou o comando.
                        try { await sock.sendMessage(from, { text: `🔄 Conexão instável ao executar *${effectivePrefix}${commandName}*. Tente novamente em alguns segundos.` }, { quoted: m }); } catch (_) {}
                    } else {
                        console.error(`💥 [CMD-ERROR] ${effectivePrefix}${commandName}:`, cmdErr);
                        cmdLog('ERRO', `${cmdErr?.message || cmdErr} (após ${elapsed}ms)`);
                        try {
                            agentCommand({
                                ..._auditBase(), ok: false, cmd_ms: elapsed,
                                err: cmdErr?.message || String(cmdErr || ''),
                                stack0: ((cmdErr?.stack || '').split('\n')[1] || '').trim()
                            });
                        } catch (_) {}
                        if (botActiveInGroup || !isGroup) {
                            safeDashboardLog('error', groupMetadata.subject, `❌ Erro em !${commandName} após ${elapsed}ms: ${cmdErr?.message || cmdErr}`, config.botName || 'Bot', (sock.user?.id || '').split(':')[0].split('@')[0] || 'bot', null, { toJid: from, messageId: m.key.id, senderJid: sock.user?.id || '', fromMe: true });
                        }
                    }
                }
            }
} // fim _handleSingleMessage
