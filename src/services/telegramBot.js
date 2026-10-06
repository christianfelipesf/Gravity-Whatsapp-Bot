require('dotenv').config();
const axios = require('axios');

let _pollTimer = null;
let _offset = 0;
let _running = false;
let _token = null;
let _allowedChatId = null;
let _api = null;

function _getToken() {
    if (_token) return _token;
    _token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!_token) {
        try { _token = (require('../database/utils').readConfig().telegramBotToken || '').trim(); } catch (_) {}
    }
    return _token;
}
function _getAllowedChatId() {
    if (_allowedChatId) return _allowedChatId;
    const env = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if (env) { _allowedChatId = String(env); return _allowedChatId; }
    try { _allowedChatId = String(require('../database/utils').readConfig().telegramChatId || '').trim(); } catch (_) {}
    return _allowedChatId;
}
function _getApi() {
    if (_api) return _api;
    const t = _getToken();
    if (!t) return null;
    _api = axios.create({ baseURL: `https://api.telegram.org/bot${t}`, timeout: 40000 });
    return _api;
}

async function send(chatId, text, opts = {}) {
    const api = _getApi();
    if (!api) return { ok: false, error: 'not_configured' };
    try {
        const payload = {
            chat_id: chatId || _getAllowedChatId(),
            text: String(text).slice(0, 4000),
            ...opts.extra
        };
        if (opts.parseMode !== null) payload.parse_mode = opts.parseMode || 'Markdown';
        // Botões inline (opts.buttons: [[{text, data}, ...], ...]).
        // callback_data limitado a 64 bytes pela Bot API.
        if (opts.buttons) {
            try {
                const rows = (Array.isArray(opts.buttons) ? opts.buttons : []).map((row) =>
                    (Array.isArray(row) ? row : [row])
                        .map((b) => ({ text: String(b?.text || '').slice(0, 60), callback_data: String(b?.data || '').slice(0, 64) }))
                        .filter((b) => b.text && b.callback_data)
                ).filter((r) => r.length);
                if (rows.length) payload.reply_markup = { inline_keyboard: rows.slice(0, 20) };
            } catch (_) {}
        }
        const res = await api.post('/sendMessage', payload);
        return { ok: !!res.data?.ok };
    } catch (e) {
        console.warn(`⚠️ [telegramBot] send falhou: ${e.response?.data?.description || e.message}`);
        return { ok: false, error: e.message };
    }
}

async function sendDocument(chatId, buffer, filename, caption, opts = {}) {
    const api = _getApi();
    if (!api) return { ok: false, error: 'not_configured' };
    try {
        const form = new FormData();
        form.append('chat_id', String(chatId || _getAllowedChatId()));
        form.append('document', new Blob([buffer], { type: 'application/zip' }), filename || 'dump.zip');
        if (caption) {
            form.append('caption', String(caption).slice(0, 1024));
            // parseMode null = texto puro (padrão Markdown quebra com
            // underscores em "logs/agent_2026-09-30.jsonl").
            const pm = opts.parseMode === undefined ? 'Markdown' : opts.parseMode;
            if (pm) form.append('parse_mode', pm);
        }
        const res = await api.post('/sendDocument', form);
        return { ok: !!res.data?.ok };
    } catch (e) {
        console.warn(`⚠️ [telegramBot] sendDocument falhou: ${e.response?.data?.description || e.message}`);
        return { ok: false, error: e.response?.data?.description || e.message };
    }
}

function isAuthorized(chatId) {
    const allowed = _getAllowedChatId();
    if (!allowed) return false;
    return String(chatId) === String(allowed);
}

// Responde ao clique num botão inline (tira a ampulheta do botão).
async function answerCallback(id, text) {
    const api = _getApi();
    if (!api || !id) return { ok: false, error: 'no-api-or-id' };
    try {
        const payload = { callback_query_id: id };
        if (text) {
            payload.text = String(text).slice(0, 200);
            payload.show_alert = true;
        }
        await api.post('/answerCallbackQuery', payload);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function downloadTelegramFile(fileId) {
    const api = _getApi();
    if (!api) return { ok: false, error: 'not_configured' };
    try {
        const info = await api.get('/getFile', { params: { file_id: fileId } });
        const filePath = info.data?.result?.file_path;
        if (!filePath) return { ok: false, error: 'file_path vazio' };
        const url = `https://api.telegram.org/file/bot${_getToken()}/${filePath}`;
        const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 12 * 1024 * 1024
        });
        if (!resp.data) return { ok: false, error: 'download vazio' };
        const buf = Buffer.from(resp.data);
        if (buf.length < 100) return { ok: false, error: 'arquivo muito pequeno' };
        return { ok: true, buffer: buf };
    } catch (e) {
        return { ok: false, error: e.response?.data?.description || e.message };
    }
}

// Confirmação em 2 passos p/ broadcast (anti-ban): 1ª chamada mostra
// contagem + ETA e pede /broadcast confirmar; 2ª executa com delay seguro.
const _pendingBroadcast = new Map(); // chatId -> { kind:'text'|'image', text, imgBuf, expiresAt }
const BROADCAST_CONFIRM_MS = 5 * 60 * 1000;

// Pendência do /update confirmar (uma por vez, expira em 5 min).
let _pendingUpdate = null;
const UPDATE_CONFIRM_MS = 5 * 60 * 1000;

// Ponte WhatsApp→Telegram: executa um comando de src/commands/ como se o
// dono tivesse digitado no chat. Reaproveita validações e regras sem duplicar.
// sock.sendMessage é redirecionado ao Telegram (reações Baileys são ignoradas);
// permissões passam via fromMe:true (chat Telegram já é autorizado).
async function runWaCommand(chatId, name, argStr) {
    const { resolveCommand, loadCommands } = require('../commands/loader');
    let cmd = null;
    try { cmd = resolveCommand(name); } catch (_) {}
    if (!cmd) {
        // Fora do boot (ex.: testes): carrega sob demanda.
        try { if (typeof loadCommands === 'function') loadCommands(); } catch (_) {}
        try { cmd = resolveCommand(name); } catch (_) {}
    }
    if (!cmd) { await send(chatId, `❌ Comando interno não encontrado: ${name}`); return; }
    const liveSock = global.__baileysSock;
    const args = String(argStr || '').trim().split(/ +/).filter(Boolean);
    const fakeSock = {
        user: (liveSock && liveSock.user) || { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, content) => {
            try {
                if (!content || typeof content !== 'object') {
                    if (content == null) return {};
                    await send(chatId, String(content).slice(0, 4000));
                    return {};
                }
                const isOnlyReact = content.react && !content.text && !content.image && !content.video
                    && !content.audio && !content.sticker && !content.document;
                if (isOnlyReact) return {};
                const text = content.text || content.caption || '';
                if (!text) return {};
                await send(chatId, String(text).slice(0, 4000));
            } catch (_) {}
            return {};
        }
    };
    if (liveSock && typeof liveSock.groupMetadata === 'function') {
        fakeSock.groupMetadata = liveSock.groupMetadata.bind(liveSock);
    }
    if (liveSock && typeof liveSock.groupFetchAllParticipating === 'function') {
        fakeSock.groupFetchAllParticipating = liveSock.groupFetchAllParticipating.bind(liveSock);
    }
    const m = { key: { id: `tg-${Date.now()}`, remoteJid: 'telegram', fromMe: true } };
    const utils = require('../database/utils');
    let ai = null;
    try { ai = require('./ai'); } catch (_) {}
    const ctx = {
        from: 'telegram',
        isGroup: false,
        sender: fakeSock.user.id,
        config: utils.readConfig(),
        utils,
        fullArgsText: String(argStr || ''),
        args,
        commandName: name,
        lastBotResponse: 0,
        GLOBAL_COOLDOWN: 0,
        model: null,
        ai,
        mediaHandler: null
    };
    return cmd.execute(fakeSock, m, ctx);
}

// Pendência do /limparmortos confirmar (uma por vez, expira em 5 min).
let _pendingPurge = null;
const PURGE_CONFIRM_MS = 5 * 60 * 1000;

async function fanOutBroadcast(chatId, makePayload, label) {
    const utils = require('../database/utils');
    const safe = require('./safeBroadcast');
    const cfg = utils.readConfig();
    const sock = global.__baileysSock;
    if (!sock) { await send(chatId, `❌ Baileys desconectado`); return; }
    // Alvos reais: bot dentro + ativo ou parcial (mortos são podados do banco).
    const targets = await safe.resolveBroadcastTargets(sock);
    const groups = targets.groups;
    if (targets.pruned.length) {
        try { await send(chatId, `🧹 ${targets.pruned.length} grupo(s) morto(s) removido(s) da lista (bot fora): ${targets.pruned.map((j) => `\`${j.split('@')[0].slice(-6)}\``).join(' ')}`); } catch (_) {}
    }
    if (!groups.length) { await send(chatId, `⚠️ Nenhum grupo válido (bot dentro + ativo/parcial)`); return; }
    if (safe.isBroadcastRunning()) { await send(chatId, `⏳ Já existe um broadcast em andamento. Aguarde terminar.`); return; }
    const detail = `${groups.length} grupos (${targets.activeCount} ativos + ${targets.partialCount} parciais)${targets.membershipOk ? '' : ' — ⚠️ sem checagem de presença (lista do banco)'}`;
    const eta = safe.estimateTotal(groups.length, cfg);
    await send(chatId,
        `📢 Broadcast ${label || ''}para *${detail}*\n` +
        `⏱️ Tempo estimado: ~${safe.formatEta(eta)} (delay ${Math.round((cfg.broadcastMinDelayMs||30000)/1000)}–${Math.round((cfg.broadcastMaxDelayMs||60000)/1000)}s/grupo)\n` +
        `⚠️ O WhatsApp bane por spam: envio idêntico e rápido = ban temporário.\n` +
        `O bot vai enviar devagar, um por vez, e parar sozinho em rate-limit.`);
    let lastLog = 0;
    const res = await safe.runSafeBroadcast(sock, groups, makePayload, {
        cfg,
        onProgress: async (p) => {
            const now = Date.now();
            if (p.phase === 'sent' && (now - lastLog > 60000 || p.index + 1 === p.total)) {
                lastLog = now;
                try { await send(chatId, `📊 ${p.index + 1}/${p.total} (✓${p.sent} ✗${p.failed})`); } catch (_) {}
            }
        }
    });
    let msg = `✅ Broadcast ok: ${res.sent} enviados, ${res.failed} falhas (${res.total} grupos)`;
    if (res.stopped) msg += `\n⛔ Parado: ${res.stopped}`;
    await send(chatId, msg);
}

async function handleUpdate(update) {
    // Clique em botão inline: equivale a digitar o comando (data "cmd:/status").
    // Reaproveita o roteador de texto via mensagem sintética (profundidade 1).
    if (update.callback_query) {
        const cq = update.callback_query;
        const cqChatId = cq.message?.chat?.id;
        try { await answerCallback(cq.id); } catch (_) {}
        if (!cqChatId || !isAuthorized(cqChatId)) return;
        const data = String(cq.data || '');
        if (!data.startsWith('cmd:')) return;
        const fakeText = data.slice(4).trim();
        if (!fakeText) return;
        return handleUpdate({
            message: { chat: { id: cqChatId }, text: fakeText, from: cq.from, message_id: cq.message?.message_id },
            update_id: update.update_id
        });
    }
    const msg = update.message || update.edited_message;
    if (!msg) return;
    const chatId = msg.chat?.id;
    if (!chatId) return;

    if (!isAuthorized(chatId)) {
        const preview = (msg.text || msg.caption || '').trim();
        try { await send(chatId, `⛔ Não autorizado. Seu chatId: \`${chatId}\``, { parseMode: 'Markdown' }); } catch (_) {}
        console.warn(`⚠️ [telegramBot] acesso negado chat ${chatId}: ${preview.slice(0,80)}`);
        return;
    }

    // Foto com legenda /broadcast => broadcast de imagem + texto para os grupos
    const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
    if (photo) {
        const caption = (msg.caption || '').trim();
        if (!caption.toLowerCase().startsWith('/broadcast')) {
            await send(chatId, `🖼️ Para enviar imagem aos grupos, envie a foto com a legenda \`/broadcast <texto>\``);
            return;
        }
        const spaceIdx = caption.indexOf(' ');
        const legenda = spaceIdx === -1 ? '' : caption.slice(spaceIdx + 1).trim();
        if (legenda.toLowerCase() === 'confirmar') {
            const pend = _pendingBroadcast.get(String(chatId));
            if (!pend || Date.now() > pend.expiresAt) { await send(chatId, `⚠️ Nada pendente. Envie a foto com \`/broadcast <texto>\` primeiro.`); return; }
            _pendingBroadcast.delete(String(chatId));
            const buf = pend.imgBuf;
            await fanOutBroadcast(chatId, () => (pend.text ? { image: buf, caption: pend.text } : { image: buf }), 'com imagem ');
            return;
        }
        await send(chatId, `⬇️ Baixando imagem...`);
        const dl = await downloadTelegramFile(photo.file_id);
        if (!dl.ok) { await send(chatId, `❌ Falha ao baixar imagem: ${dl.error}`, { parseMode: null }); return; }
        try {
            const utils = require('../database/utils');
            const safe = require('./safeBroadcast');
            const cfg = utils.readConfig();
            const targets = await safe.resolveBroadcastTargets(global.__baileysSock);
            const n = targets.groups.length;
            _pendingBroadcast.set(String(chatId), { kind: 'image', text: legenda, imgBuf: dl.buffer, expiresAt: Date.now() + BROADCAST_CONFIRM_MS });
            await send(chatId,
                `⚠️ *CONFIRMAR BROADCAST COM IMAGEM*\n` +
                `📢 ${n} grupo(s) válido(s) (${targets.activeCount} ativos + ${targets.partialCount} parciais) • ~${safe.formatEta(safe.estimateTotal(n, cfg))}\n` +
                (targets.pruned.length ? `🧹 ${targets.pruned.length} morto(s) podado(s)\n` : ``) +
                `❗ Envio em massa pode gerar *ban temporário*.\n` +
                `Confirme com foto+legenda \`/broadcast confirmar\` (5 min).`);
        } catch (e) { await send(chatId, `❌ Erro: ${e.message}`); }
        return;
    }

    if (!msg.text) return;
    const text = msg.text.trim();

    const lower = text.toLowerCase();
    const args = text.split(/\s+/).slice(1);

    // /help /start — menu clicável (botões equivalem a digitar o comando)
    if (lower === '/start' || lower === '/help' || lower.startsWith('/help ')) {
        const help = [
            `*🤖 Gravity Bot — Painel Telegram*`,
            ``,
            `Toque num botão ou digite o comando:`,
            ``,
            `📊 *Monitor* — status, QR, logs, banco`,
            `🧹 *Manutenção* — limpar mortos, broadcast, dump`,
            `🔌 *Conexão* — reconnect, restart, ativar/desativar`,
            ``,
            `_Comandos com texto: /ativar <jid> • /desativar <jid> • /broadcast <texto>_`
        ].join('\n');
        await send(chatId, help, {
            buttons: [
                [{ text: '📊 Status', data: 'cmd:/status' }, { text: '📱 QR', data: 'cmd:/qr' }],
                [{ text: '📜 Logs', data: 'cmd:/logs' }, { text: '💾 Banco', data: 'cmd:/modo' }],
                [{ text: '🧹 Limpar mortos', data: 'cmd:/limparmortos' }, { text: '📢 Broadcast', data: 'cmd:/broadcast' }],
                [{ text: '🔌 Reconnect', data: 'cmd:/reconnect' }, { text: '📦 Dump', data: 'cmd:/dump' }],
                [{ text: '🔄 Update', data: 'cmd:/update' }, { text: '⚙️ Config', data: 'cmd:/config' }],
                [{ text: '👥 Grupos', data: 'cmd:/grupos' }, { text: '📰 News', data: 'cmd:/news status' }],
                [{ text: '🔄 Restart', data: 'cmd:/restart' }]
            ]
        });
        return;
    }

    // /modo /banco /local /nuvem — alterna banco local x remoto (Supabase)
    if (lower === '/modo' || lower.startsWith('/modo ') || lower === '/banco' || lower.startsWith('/banco ')
        || lower === '/local' || lower.startsWith('/local ') || lower === '/nuvem' || lower.startsWith('/nuvem ')
        || lower === '/remoto' || lower.startsWith('/remoto ') || lower === '/cloud' || lower.startsWith('/cloud ')) {
        try {
            const sync = require('../database/supabaseSync');
            const fmtTs = (ts) => {
                if (!ts) return 'nunca';
                try { return new Date(ts).toLocaleString('pt-BR'); } catch (_) { return String(ts); }
            };
            const modeText = () => {
                const m = (typeof sync.getMode === 'function') ? sync.getMode() : { ...sync.status() };
                const nome = m.local ? '📀 LOCAL (só bot.db)' : '☁️ NUVEM (Supabase)';
                return [
                    `*💾 BANCO ATUAL: ${m.local ? 'LOCAL' : 'NUVEM'}*`,
                    `${nome}`,
                    `Origem: \`${m.source || 'env'}\` env: \`${m.env || '?'}\``,
                    `Último pull: ${fmtTs(m.lastPullAt)}`,
                    `Último push: ${fmtTs(m.lastPushAt)}`,
                ].join('\n');
            };
            const doSwitch = async (toLocal) => {
                const cur = sync.isSyncKilled();
                if (cur === toLocal) {
                    await send(chatId, `${modeText()}\n\n⚠️ Já está em ${toLocal ? '*LOCAL*' : '*NUVEM*'}.`);
                    return;
                }
                try { require('../database/utils').flushNow?.(); } catch (_) {}
                const r = sync.setLocalMode(toLocal, { persist: true });
                console.warn(`🔀 [telegramBot] /banco → ${toLocal ? 'LOCAL' : 'NUVEM'} por ${chatId} (persistido: ${r.persisted ? 'sim' : 'não'})`);
                const extra = toLocal
                    ? `\n\n✅ Agora só \`bot.db\` local (sem pull/push).\nTroca salva no .env — sobrevive ao restart.`
                    : `\n\n✅ Sync retomado (push periódico, sem pull automático).\n⚠️ A nuvem NÃO sobrescreveu o local. Para forçar nuvem→local rode \`npm run db:pull\`. Troca salva no .env.`;
                await send(chatId, `${modeText()}${extra}`);
            };
            // só consulta
            if (lower === '/modo' || lower.startsWith('/modo ')) {
                await send(chatId, `${modeText()}\n\nUso: \`/banco local\` ou \`/banco nuvem\``);
                return;
            }
            // atalhos diretos
            if (lower === '/local' || lower.startsWith('/local ')) { await doSwitch(true); return; }
            if (lower === '/nuvem' || lower.startsWith('/nuvem ') || lower === '/remoto' || lower.startsWith('/remoto ')
                || lower === '/cloud' || lower.startsWith('/cloud ')) { await doSwitch(false); return; }
            // /banco [local|nuvem]
            const alvo = (args[0] || '').toLowerCase();
            if (!alvo) { await send(chatId, `${modeText()}\n\nUso: \`/banco local\` ou \`/banco nuvem\``); return; }
            if (['local', 'loc'].includes(alvo)) { await doSwitch(true); return; }
            if (['nuvem', 'remoto', 'cloud', 'supabase'].includes(alvo)) { await doSwitch(false); return; }
            await send(chatId, `❌ Uso: \`/banco local\` ou \`/banco nuvem\``);
        } catch (e) { await send(chatId, `❌ Erro banco: ${e.message}`); }
        return;
    }

    if (lower === '/status' || lower.startsWith('/status ')) {
        try {
            const wd = require('./watchdog').getState();
            const dash = (() => { try { return require('./principalState').getState(); } catch (_) { return null; } })();
            const utils = require('../database/utils');
            const stats = utils.readStats();
            const ag = utils.listActiveGroups().length;
            const pg = utils.listPartialGroups().length;
            const uptime = (() => {
                const ms = Date.now() - (global.__startTime || Date.now());
                const s = Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return `${h}h ${m}m`;
            })();
            const dbMode = (() => { try { return require('../database/supabaseSync').isSyncKilled() ? 'LOCAL' : 'NUVEM'; } catch (_) { return '?'; } })();
            const syncLine = (() => {
                try {
                    const sp = require('./syncProgress').getState();
                    if (sp.phase === 'draining' || sp.phase === 'connecting') {
                        return `Sync: 🔄 ${sp.phase} ${sp.pct}% (rec ${sp.received} desc ${sp.discarded} novas ${sp.processed})`;
                    }
                    if (sp.phase === 'failed') return `Sync: ⚠️ falhou (${sp.failReason || '?'})`;
                    if (sp.received > 0) return `Sync: ✅ pronto (rec ${sp.received} desc ${sp.discarded})`;
                    return null;
                } catch (_) { return null; }
            })();
            const connIcon = dash?.status === 'connected' ? '🟢' : dash?.status === 'syncing' || dash?.status === 'connecting' ? '🔄' : '🔴';
            const wsIcon = wd.isZombie ? '🚨' : '📡';
            const txt = [
                `*📊 STATUS — ${utils.readConfig().botName || 'Bot'}*`,
                `───────────────`,
                `${connIcon} Conexão: \`${dash?.status || '?'}\` • 📱 \`${dash?.phone || '-'}\``,
                syncLine,
                `${wsIcon} WS: \`${wd.wsState || '?'}\` • zumbi: \`${wd.isZombie ? 'SIM 🚨' : 'não'}\` • idle: ${Math.round(wd.idleMs/1000)}s`,
                `───────────────`,
                `💾 Banco: \`${dbMode}\` • 👥 Grupos: ${ag} ativos + ${pg} parciais`,
                `⌨️ Comandos: ${stats.totalCommands||0} • 🔄 Restarts: ${stats.totalRestarts||0} • ⏱️ Uptime: ${uptime}`,
                `📦 Fila: ${wd.queue?.pending||0} pendente(s) (dl:${wd.queue?.download||0} send:${wd.queue?.send||0} proc:${wd.queue?.process||0})`
            ].filter(Boolean).join('\n');
            await send(chatId, txt, {
                buttons: [
                    [{ text: '🔄 Atualizar', data: 'cmd:/status' }, { text: '📜 Logs', data: 'cmd:/logs' }],
                    [{ text: '🏠 Menu', data: 'cmd:/help' }]
                ]
            });
        } catch (e) { await send(chatId, `❌ Erro status: ${e.message}`); }
        return;
    }

    if (lower === '/restart' || lower.startsWith('/restart ')) {
        await send(chatId, `🔄 Reiniciando bot (process.exit) — Docker vai subir em ~5s...`);
        console.warn('🔄 [telegramBot] /restart por', chatId);
        try { require('../database/utils').flushNow?.(); } catch (_) {}
        // Push best-effort antes de sair: sem isso o PULL do próximo boot
        // desfaz os últimos ~60s (o schedulePush de 5s morria no exit).
        try {
            const sync = require('../database/supabaseSync');
            if (sync.isDirty && sync.isDirty()) await sync.pushNow(12000);
        } catch (_) {}
        setTimeout(() => process.exit(1), 1200).unref();
        return;
    }

    if (lower === '/reconnect' || lower.startsWith('/reconnect ')) {
        const sock = global.__baileysSock;
        if (!sock) { await send(chatId, `⚠️ Baileys não conectado (sock nulo)`); return; }
        try {
            await send(chatId, `🔌 Forçando reconnect (ws.close)...`);
            try { if (sock.ws?.close) sock.ws.close(); else if (sock.ws?.socket?.close) sock.ws.socket.close(); } catch (_) {}
            try { if (typeof sock.end === 'function') sock.end(new Error('telegram /reconnect')); } catch (_) {}
            console.log('🔌 [telegramBot] /reconnect executado');
        } catch (e) { await send(chatId, `❌ Falha reconnect: ${e.message}`); }
        return;
    }

    if (lower === '/qr' || lower.startsWith('/qr ')) {
        try {
            const dash = require('./principalState').getState();
            const qrCtrl = global.__qrControl;
            const attempts = qrCtrl ? `${qrCtrl.getAttempts()}/${qrCtrl.getMaxAttempts()}` : '?';
            const status = dash.qr ? 'qr' : (dash.status || '?');
            let txt = `*📱 QR STATUS*\nStatus: \`${status}\`\nPhone: \`${dash.phone||'-'}\`\nTentativas: \`${attempts}\``;
            if (dash.qr) txt += `\n\nQR gerado — veja no terminal do servidor.`;
            await send(chatId, txt);
        } catch (e) { await send(chatId, `❌ Erro qr: ${e.message}`); }
        return;
    }

    if (lower.startsWith('/ativar ') || lower.startsWith('/desativar ')) {
        const isAtivar = lower.startsWith('/ativar ');
        const jid = args[0]?.trim();
        if (!jid || !jid.endsWith('@g.us')) { await send(chatId, `❌ Uso: \`${isAtivar ? '/ativar' : '/desativar'} 120363...@g.us\``); return; }
        try {
            const utils = require('../database/utils');
            const ok = isAtivar ? utils.activateGroup(jid) : utils.deactivateGroup(jid);
            await send(chatId, ok ? `✅ ${isAtivar ? 'Ativado' : 'Desativado'}: \`${jid}\`` : `⚠️ Já ${isAtivar ? 'ativo' : 'inativo'} ou falha: \`${jid}\``);
        } catch (e) { await send(chatId, `❌ Erro: ${e.message}`); }
        return;
    }

    // /broadcast sem texto: mostra o uso (também destino do botão 📢 do /help)
    if (lower === '/broadcast') {
        await send(chatId, `*📢 Broadcast*\n\nEnvia um texto para todos os grupos (devagar, anti-ban).\n\nUso: \`/broadcast <texto>\`\nDepois confirme com \`/broadcast confirmar\` (5 min).\nCom imagem: envie a foto com a legenda \`/broadcast <texto>\`.`);
        return;
    }

    if (lower.startsWith('/broadcast ')) {
        const broadcastText = text.slice(text.indexOf(' ') + 1).trim();
        if (!broadcastText) { await send(chatId, `❌ Uso: \`/broadcast <texto>\``); return; }
        try {
            if (broadcastText.toLowerCase() === 'confirmar') {
                const pend = _pendingBroadcast.get(String(chatId));
                if (!pend || Date.now() > pend.expiresAt) { await send(chatId, `⚠️ Nada pendente. Use \`/broadcast <texto>\` primeiro.`); return; }
                _pendingBroadcast.delete(String(chatId));
                await fanOutBroadcast(chatId, () => ({ text: pend.text }));
                return;
            }
            const utils = require('../database/utils');
            const safe = require('./safeBroadcast');
            const cfg = utils.readConfig();
            const targets = await safe.resolveBroadcastTargets(global.__baileysSock);
            const n = targets.groups.length;
            if (!n) { await send(chatId, `⚠️ Nenhum grupo válido (bot dentro + ativo/parcial)`); return; }
            _pendingBroadcast.set(String(chatId), { kind: 'text', text: broadcastText, expiresAt: Date.now() + BROADCAST_CONFIRM_MS });
            await send(chatId,
                `⚠️ *CONFIRMAR BROADCAST*\n` +
                `📢 ${n} grupo(s) válido(s) (${targets.activeCount} ativos + ${targets.partialCount} parciais) • ~${safe.formatEta(safe.estimateTotal(n, cfg))} (devagar p/ evitar ban)\n` +
                (targets.pruned.length ? `🧹 ${targets.pruned.length} morto(s) podado(s)\n` : ``) +
                `📝 \`${broadcastText.slice(0, 200)}\`\n\n` +
                `❗ Envio em massa idêntico é o que causa *ban temporário*.\n` +
                `Toque em ✅ ou digite \`/broadcast confirmar\` (5 min).`,
                { buttons: [[{ text: '✅ Confirmar envio', data: 'cmd:/broadcast confirmar' }]] });
        } catch (e) { await send(chatId, `❌ Erro broadcast: ${e.message}`); }
        return;
    }

    if (lower === '/logs' || lower.startsWith('/logs ')) {
        try {
            const n = Math.min(20, Math.max(5, parseInt(args[0]||'10',10)||10));
            const logs = require('./terminalLog').getLast(n);
            if (!logs.length) { await send(chatId, `📭 Sem logs`); return; }
            const txt = logs.map(l => `[${l.time}] ${l.text.slice(0,200)}`).join('\n').slice(0, 3800);
            await send(chatId, `*📜 Últimos ${logs.length} logs:*\n\`\`\`\n${txt}\n\`\`\``);
        } catch (e) { await send(chatId, `❌ Erro logs: ${e.message}`); }
        return;
    }

    if (lower === '/dump' || lower.startsWith('/dump ')) {
        try {
            await send(chatId, `📦 Gerando backup (inclui .env com API keys)...`);
            const { buildDumpZip, cleanupDumpZip } = require('./dump');
            const fs = require('fs');
            const { zipPath, zipName, includedNames, sizeKb } = buildDumpZip();
            try {
                const buf = fs.readFileSync(zipPath);
                const caption = `📦 Backup OK\n${includedNames.map(n => `• ${n}`).join('\n')}\n💾 ${sizeKb} KB\n⚠️ Contém .env com API keys — mantenha em local seguro.`;
                // parseMode null: nomes como logs/agent_2026-09-30.jsonl têm
                // underscores que quebram o Markdown ("can't parse entities").
                const r = await sendDocument(chatId, buf, zipName, caption, { parseMode: null });
                if (!r.ok) await send(chatId, `❌ Falha ao enviar dump: ${r.error}`, { parseMode: null });
            } finally {
                cleanupDumpZip(zipPath);
            }
        } catch (e) { await send(chatId, `❌ Erro dump: ${e.message}`, { parseMode: null }); }
        return;
    }

    if (lower === '/limparmortos' || lower.startsWith('/limparmortos ')) {
        try {
            const utils = require('../database/utils');
            const sub = String(args[0] || '').toLowerCase();
            if (sub === 'confirmar') {
                const pend = _pendingPurge;
                _pendingPurge = null;
                if (!pend || Date.now() > pend.expiresAt) {
                    await send(chatId, `⚠️ Nada pendente (ou expirou). Rode /limparmortos de novo para varrer.`);
                    return;
                }
                let purged = 0;
                let logs = 0;
                const lines = [];
                for (const jid of pend.jids) {
                    try {
                        const r = utils.purgeDeadGroup(jid);
                        if (r && r.ok) {
                            purged++;
                            logs += Number(r.removed?.dashboard_logs) || 0;
                            lines.push(`• \`${jid.split('@')[0]}\` (logs ${Number(r.removed?.dashboard_logs) || 0})`);
                        }
                    } catch (e) {
                        lines.push(`• \`${jid.split('@')[0]}\` — falha: ${e?.message || e}`);
                    }
                }
                await send(chatId, `*🧹 Limpeza concluída*\n\n✅ ${purged} grupo(s) purgado(s) • ${logs} log(s) apagado(s)\n${lines.slice(0, 30).join('\n')}${lines.length > 30 ? `\n…(+${lines.length - 30})` : ''}`);
                return;
            }
            const sock = global.__baileysSock;
            const candidates = [...new Set([
                ...utils.listActiveGroups(),
                ...utils.listPartialGroups(),
                ...utils.listNewsGroups()
            ].filter((j) => j && String(j).endsWith('@g.us')))];
            if (!candidates.length) { await send(chatId, `✅ Nenhum grupo registrado no banco. Nada a limpar.`); return; }
            let participating = null;
            try {
                if (sock && typeof sock.groupFetchAllParticipating === 'function') {
                    const p = await sock.groupFetchAllParticipating();
                    if (p && typeof p === 'object') participating = new Set(Object.keys(p));
                }
            } catch (_) { participating = null; }
            if (!participating) { await send(chatId, `⚠️ Não consegui ler a lista de grupos do WhatsApp agora (sem conexão?). Nada foi apagado.`); return; }
            const dead = candidates.filter((j) => !participating.has(j));
            if (!dead.length) { await send(chatId, `✅ Nenhum grupo morto: ${candidates.length} registrado(s), todos com o bot dentro. 🎉`); return; }
            const flags = (j) => {
                const f = [];
                try { if (utils.isActiveGroup(j)) f.push('ativo'); } catch (_) {}
                try { if (utils.isPartialActive(j)) f.push('parcial'); } catch (_) {}
                try { if (utils.isNewsEnabled(j)) f.push('news'); } catch (_) {}
                return f.length ? ` [${f.join('/')}]` : '';
            };
            _pendingPurge = { jids: dead, expiresAt: Date.now() + PURGE_CONFIRM_MS };
            await send(chatId,
                `*🧹 Grupos mortos* (${dead.length} — bot fora, dados no banco):\n\n` +
                dead.slice(0, 30).map((j) => `• \`${j.split('@')[0]}\`${flags(j)}`).join('\n') +
                (dead.length > 30 ? `\n…(+${dead.length - 30})` : '') +
                `\n\n⚠️ A purga apaga ativação, news, dashboard, rank, logs e mensagens (irreversível).` +
                `\nToque em ✅ ou digite \`/limparmortos confirmar\` (5 min).`,
                { buttons: [[{ text: '✅ Confirmar purga', data: 'cmd:/limparmortos confirmar' }]] });
        } catch (e) { await send(chatId, `❌ Erro limparmortos: ${e.message}`); }
        return;
    }

    if (lower === '/config' || lower.startsWith('/config ')) {
        try { await runWaCommand(chatId, 'config', ''); }
        catch (e) { await send(chatId, `❌ Erro config: ${e.message}`); }
        return;
    }

    if (lower === '/set' || lower.startsWith('/set ')) {
        try {
            const rest = text.slice(text.indexOf(' ') + 1);
            await runWaCommand(chatId, 'set', lower === '/set' ? '' : rest);
        } catch (e) { await send(chatId, `❌ Erro set: ${e.message}`); }
        return;
    }

    if (lower === '/grupos' || lower.startsWith('/grupos ')) {
        try { await runWaCommand(chatId, 'grupos', ''); }
        catch (e) { await send(chatId, `❌ Erro grupos: ${e.message}`); }
        return;
    }

    if (lower === '/news' || lower.startsWith('/news ')) {
        try {
            const utils = require('../database/utils');
            const sub = String(args[0] || '').toLowerCase();
            const svc = () => ((typeof global !== 'undefined' && global.__botServices && global.__botServices.news) || null);
            if (sub === 'on' || sub === 'ativar' || sub === 'ligar') {
                const cfg = utils.readConfig();
                cfg.newsEnabled = true;
                utils.writeConfig(cfg);
                const s = svc();
                if (s) { try { s.stop(); s.start(); } catch (_) {} }
                await send(chatId, `🟢 *Feed global ATIVADO* (vale p/ grupos com news ligado).`);
                return;
            }
            if (sub === 'off' || sub === 'desativar' || sub === 'desligar') {
                const cfg = utils.readConfig();
                cfg.newsEnabled = false;
                utils.writeConfig(cfg);
                const s = svc();
                if (s) { try { s.stop(); } catch (_) {} }
                await send(chatId, `🔴 *Feed global DESATIVADO* (polling parado).`);
                return;
            }
            const cfg = utils.readConfig();
            const n = utils.listNewsGroups().length;
            await send(chatId,
                `*📰 Feed global:* \`${cfg.newsEnabled !== false ? '🟢 ATIVO' : '🔴 DESATIVADO'}\`\n` +
                `👥 Grupos assinantes: ${n}\n\n` +
                `Uso: \`/news on\` • \`/news off\` • \`/news status\``);
        } catch (e) { await send(chatId, `❌ Erro news: ${e.message}`); }
        return;
    }

    if (lower === '/update' || lower.startsWith('/update ')) {
        try {
            const sub = String(args[0] || '').toLowerCase();
            if (sub === 'confirmar') {
                const pend = _pendingUpdate;
                _pendingUpdate = null;
                if (!pend || Date.now() > pend.expiresAt) {
                    await send(chatId, `⚠️ Nada pendente (ou expirou). Rode /update de novo.`);
                    return;
                }
                await send(chatId, `⬇️ *Atualizando...* (git pull + restart)`);
                await runWaCommand(chatId, 'update', '');
                return;
            }
            let cur = 'versão atual desconhecida';
            try {
                const { execFileSync } = require('child_process');
                const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { windowsHide: true }).toString().trim();
                const subj = execFileSync('git', ['log', '-1', '--pretty=%s'], { windowsHide: true }).toString().trim().slice(0, 80);
                if (short) cur = `\`${short}\` ${subj}`;
            } catch (_) {}
            _pendingUpdate = { expiresAt: Date.now() + UPDATE_CONFIRM_MS };
            await send(chatId,
                `*🔄 Update*\n\n📌 Atual: ${cur}\n\nVai rodar \`git pull\` + reiniciar (segundos fora do ar).\n` +
                `Toque em ✅ ou digite \`/update confirmar\` (5 min).`,
                { buttons: [[{ text: '✅ Confirmar update', data: 'cmd:/update confirmar' }]] });
        } catch (e) { await send(chatId, `❌ Erro update: ${e.message}`); }
        return;
    }

    // fallback: eco help
    await send(chatId, `❓ Comando desconhecido: \`${text.slice(0,40)}\`\nUse /help`);
}

async function pollOnce() {
    if (_running) return;
    _running = true;
    try {
        const api = _getApi();
        if (!api) return;
        const res = await api.get('/getUpdates', { params: { offset: _offset, timeout: 25, allowed_updates: JSON.stringify(['message','edited_message','callback_query']) } });
        const updates = res.data?.result || [];
        for (const u of updates) {
            _offset = Math.max(_offset, (u.update_id || 0) + 1);
            try { await handleUpdate(u); } catch (e) { console.warn('[telegramBot] handleUpdate erro:', e.message); }
        }
    } catch (e) {
        const msg = e.response?.data?.description || e.message || String(e);
        // timeout de long-poll sem mensagens é normal — não polui log
        if (e.code === 'ECONNABORTED' || String(msg).toLowerCase().includes('timeout')) {
            // silêncio: apenas aguarda próximo ciclo
            await new Promise(r => setTimeout(r, 1000));
        } else if (String(msg).includes('409') || String(msg).includes('conflict')) {
            console.warn('⚠️ [telegramBot] polling conflito 409 — aguardando 10s');
            await new Promise(r => setTimeout(r, 10000));
        } else {
            console.warn(`⚠️ [telegramBot] poll falhou: ${msg.slice(0,120)}`);
            await new Promise(r => setTimeout(r, 3000));
        }
    } finally { _running = false; }
}

function start(opts = {}) {
    const tok = (opts.token || _getToken() || '').trim();
    const chat = (opts.chatId || _getAllowedChatId() || '').trim();
    if (!tok || !chat) {
        console.warn('⚠️ [telegramBot] não iniciado — sem TELEGRAM_BOT_TOKEN/CHAT_ID');
        return null;
    }
    _token = tok; _allowedChatId = String(chat);
    _api = axios.create({ baseURL: `https://api.telegram.org/bot${_token}`, timeout: 40000 });
    if (_pollTimer) clearInterval(_pollTimer);
    // polling a cada 3s + long poll 25s
    _pollTimer = setInterval(() => pollOnce().catch(()=>{}), 3000);
    if (_pollTimer.unref) _pollTimer.unref();
    // primeira chamada imediata
    pollOnce().catch(()=>{});
    console.log(`🤖 [telegramBot] polling ativo → chat ${String(chat).slice(0,4)}**** cmds: /modo /banco /local /nuvem /restart /reconnect /qr /ativar /desativar /broadcast /logs /dump`);
    return _pollTimer;
}

function stop() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
}

module.exports = { start, stop, send, sendDocument, handleUpdate, isAuthorized, answerCallback, runWaCommand };
