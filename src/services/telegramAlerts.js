const axios = require('axios');

/**
 * Telegram Alerts — envia notificações críticas para o admin via Telegram.
 * Config via env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Também lê de config DB: telegramBotToken, telegramChatId (prioridade: env > DB)
 */

let _token = null;
let _chatId = null;
let _axios = null;
let _lastSendAt = 0;
let _cooldownMs = 30000; // anti-spam mínimo entre alertas do mesmo tipo
const _lastByKey = new Map(); // key -> timestamp
let _enabledLogged = false;

function _getToken() {
    if (_token) return _token;
    _token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!_token) {
        try {
            const { readConfig } = require('../database/utils');
            const cfg = readConfig();
            _token = (cfg.telegramBotToken || '').trim();
        } catch (_) {}
    }
    return _token;
}

function _getChatId() {
    if (_chatId) return _chatId;
    const env = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if (env) { _chatId = env; return _chatId; }
    try {
        const { readConfig } = require('../database/utils');
        const cfg = readConfig();
        const v = String(cfg.telegramChatId || '').trim();
        if (v) _chatId = v;
    } catch (_) {}
    return _chatId;
}

function isConfigured() {
    return !!(_getToken() && _getChatId());
}

function configure({ token, chatId }) {
    if (token) { _token = String(token).trim(); process.env.TELEGRAM_BOT_TOKEN = _token; }
    if (chatId) { _chatId = String(chatId).trim(); process.env.TELEGRAM_CHAT_ID = _chatId; }
    if (_token && _chatId && !_enabledLogged) {
        _enabledLogged = true;
        console.log(`📲 [telegram] alertas ativados → chat ${_chatId.slice(0,4)}****`);
    }
}

function _getAxios() {
    if (_axios) return _axios;
    _axios = axios.create({ timeout: 10000 });
    return _axios;
}

/**
 * Envia mensagem formatada para o Telegram.
 * @param {string} text - Texto (Markdown ou plain)
 * @param {object} opts - { key, parseMode, disableNotification, cooldownMs }
 */
async function sendAlert(text, opts = {}) {
    const token = _getToken();
    const chatId = _getChatId();
    if (!token || !chatId) {
        if (!_enabledLogged) {
            // log once
            _enabledLogged = true;
            console.warn('⚠️ [telegram] não configurado — defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env');
        }
        return { ok: false, error: 'not_configured' };
    }
    const key = opts.key || 'default';
    const cooldown = opts.cooldownMs != null ? opts.cooldownMs : _cooldownMs;
    const now = Date.now();
    const last = _lastByKey.get(key) || 0;
    if (now - last < cooldown) {
        return { ok: false, error: 'cooldown', remaining: cooldown - (now - last) };
    }
    // global rate-limit mínimo 3s
    if (now - _lastSendAt < 3000) {
        await new Promise(r => setTimeout(r, 3000 - (now - _lastSendAt)));
    }
    _lastSendAt = Date.now();
    _lastByKey.set(key, _lastSendAt);

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        parse_mode: opts.parseMode || 'Markdown',
        disable_notification: !!opts.disableNotification
    };
    // Remove parse_mode if plain
    if (opts.parseMode === null) delete payload.parse_mode;

    try {
        const res = await _getAxios().post(url, payload);
        if (res.data?.ok) return { ok: true };
        return { ok: false, error: res.data?.description || 'unknown' };
    } catch (e) {
        const msg = e.response?.data?.description || e.message || String(e);
        console.warn(`⚠️ [telegram] falha ao enviar (${key}): ${msg.slice(0,150)}`);
        return { ok: false, error: msg };
    }
}

function formatAlert({ title, botName, status, reason, uptime, extra }) {
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const lines = [];
    lines.push(`*${escapeMd(title)}*`);
    if (botName) lines.push(`🤖 Bot: \`${escapeMd(botName)}\``);
    if (status) lines.push(`📡 Status: ${escapeMd(status)}`);
    if (reason) lines.push(`📝 Motivo: ${escapeMd(reason)}`);
    if (uptime) lines.push(`⏱️ Uptime: ${escapeMd(uptime)}`);
    lines.push(`🕐 ${escapeMd(ts)}`);
    if (extra) lines.push(`\n${escapeMd(extra)}`);
    return lines.join('\n');
}

function escapeMd(s) {
    return String(s || '').replace(/[_*`\[\]]/g, '\\$&');
}

// Atalhos tipados
async function notifyZombie({ botName, idleMs, wsState, reason }) {
    const mins = Math.round(idleMs / 60000);
    return sendAlert(
        formatAlert({
            title: '🚨 BOT ZUMBI DETECTADO',
            botName,
            status: `ZUMBI — sem mensagens há ${mins}min`,
            reason: reason || `ws=${wsState || '?'} idle=${mins}min`,
            extra: 'Tentando reconectar automaticamente... Se persistir, verifique logs/dashboard.'
        }),
        { key: 'zombie', cooldownMs: 5 * 60 * 1000 }
    );
}

async function notifyDisconnect({ botName, code, reasonName, phone }) {
    return sendAlert(
        formatAlert({
            title: '🔌 BOT DESCONECTADO',
            botName,
            status: `Desconectado (code=${code} ${reasonName})`,
            reason: phone ? `phone ${phone}` : undefined,
            extra: 'Reconectando em 5s...'
        }),
        { key: 'disconnect', cooldownMs: 60 * 1000 }
    );
}

async function notifyConnected({ botName, phone, version }) {
    return sendAlert(
        formatAlert({
            title: '🟢 BOT RECONECTADO',
            botName,
            status: `Conectado ✅`,
            reason: `phone ${phone || '?'} • ${version || ''}`,
            extra: 'Bot voltou a receber comandos.'
        }),
        { key: 'connected', cooldownMs: 60 * 1000 }
    );
}

async function notifyQr({ botName, attempt }) {
    return sendAlert(
        formatAlert({
            title: '📱 QR CODE NECESSÁRIO',
            botName,
            status: `QR #${attempt} gerado`,
            extra: 'Escaneie o QR no dashboard ou terminal para reconectar.'
        }),
        { key: 'qr', cooldownMs: 2 * 60 * 1000 }
    );
}

async function notifyError({ botName, error }) {
    return sendAlert(
        formatAlert({
            title: '💥 ERRO CRÍTICO',
            botName,
            status: 'Erro fatal / exception',
            reason: String(error).slice(0,300),
            extra: 'Processo será reiniciado se restart:always estiver ativo.'
        }),
        { key: 'error', cooldownMs: 2 * 60 * 1000 }
    );
}

// Log de interação/comando (básico, sem toggle)
async function notifyCommand({ botName, commandName, prefix, senderName, sender, group, args, elapsed }) {
    const cmd = `${prefix || '!'}${commandName || '?'}`;
    const isLid = typeof sender === 'string' && sender.endsWith('@lid');
    const rawNum = !isLid && sender ? String(sender).split('@')[0].split(':')[0] : null;
    const validPhone = rawNum && /^\d{8,15}$/.test(rawNum) ? rawNum : null;
    let who;
    if (senderName && String(senderName).trim() && !['usuario','usuário'].includes(String(senderName).trim().toLowerCase())) {
        who = validPhone ? `${senderName} (@${validPhone})` : String(senderName).trim();
    } else {
        who = validPhone ? `@${validPhone}` : 'Usuário';
    }
    const where = group || 'privado';
    const extra = args ? `Args: ${String(args).slice(0,200)}` : null;
    const lines = [
        `*⌨️ COMANDO* \`${escapeMd(cmd)}\``,
        `👤 ${escapeMd(who)}`,
        `👥 ${escapeMd(where)}`,
        elapsed != null ? `⏱️ ${elapsed}ms` : null,
        extra ? `📝 ${escapeMd(extra)}` : null,
        `🤖 ${escapeMd(botName||'')}`,
        `🕐 ${escapeMd(new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}`
    ].filter(Boolean).join('\n');
    return sendAlert(lines, { key: `cmd:${commandName}`, cooldownMs: 0, parseMode: 'Markdown' });
}

// --- Sync pós-reconnect: UMA mensagem editada (sem flood) ---
let _syncMsgId = null;
let _syncLastEditAt = 0;

async function _sendSyncRaw(text) {
    const token = _getToken();
    const chatId = _getChatId();
    if (!token || !chatId) return { ok: false, error: 'not_configured' };
    try {
        const res = await _getAxios().post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: String(text).slice(0, 4000),
            disable_notification: true
        });
        const mid = res.data?.result?.message_id || null;
        if (mid) { _syncMsgId = mid; _syncLastEditAt = Date.now(); }
        return { ok: !!res.data?.ok, messageId: mid };
    } catch (e) {
        return { ok: false, error: e.response?.data?.description || e.message };
    }
}

async function _editSyncRaw(text) {
    const token = _getToken();
    const chatId = _getChatId();
    if (!token || !chatId || !_syncMsgId) return _sendSyncRaw(text);
    try {
        await _getAxios().post(`https://api.telegram.org/bot${token}/editMessageText`, {
            chat_id: chatId,
            message_id: _syncMsgId,
            text: String(text).slice(0, 4000),
            disable_notification: true
        });
        _syncLastEditAt = Date.now();
        return { ok: true, edited: true };
    } catch (e) {
        const desc = e.response?.data?.description || '';
        // msg antiga demais / sem mudança: reenvia uma vez e segue
        if (/message to edit not found|message is not modified/i.test(desc)) {
            return _sendSyncRaw(text);
        }
        return { ok: false, error: desc || e.message };
    }
}

function _syncBar(pct, width = 12) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const f = Math.round((p / 100) * width);
    return '█'.repeat(f) + '░'.repeat(width - f);
}

async function notifySyncStart({ phase } = {}) {
    _syncMsgId = null;
    const txt = `🔄 *SINCRONIZANDO* — bot reconectado, drenando fila offline...\n${_syncBar(0)} 0%\nFase: ${phase || 'connecting'}\n_Comandos antigos serão descartados; novos respondem em seguida._`;
    // sendAlert com parseMode Markdown aqui (mensagem nova, não edição)
    const r = await sendAlert(txt, { key: 'sync', cooldownMs: 0, disableNotification: true });
    // sendAlert não retorna message_id; busca via send cru só se configurado
    // e sem msg anterior — tenta capturar o id com envio direto na próxima vez.
    // Para garantir edit, faz um envio cru adicional? Não — evita duplicar:
    // usa o truque: se r.ok, o próximo progress cria a msg editável.
    if (r.ok) { _syncLastEditAt = Date.now(); }
    return r;
}

async function notifySyncProgress({ pct = 0, received = 0, discarded = 0, processed = 0, phase = 'draining' } = {}) {
    const now = Date.now();
    // throttle: 1 edição / 5s (o syncProgress já filtra por 10%, aqui é rede)
    if (_syncMsgId && now - _syncLastEditAt < 5000) return { ok: false, error: 'throttled' };
    const txt = `🔄 SINCRONIZANDO — ${_syncBar(pct)} ${Math.round(pct)}%\nFase: ${phase} • recebidas ${received} • descartadas ${discarded} • novas ${processed}\n_Comandos antigos descartados; novos já respondem._`;
    if (!_syncMsgId) return _sendSyncRaw(txt);
    return _editSyncRaw(txt);
}

async function notifySyncDone({ received = 0, discarded = 0, processed = 0, reason = '' } = {}) {
    const txt = `✅ SINCRONIZAÇÃO CONCLUÍDA\nRecebidas ${received} • descartadas ${discarded} • novas ${processed}${reason ? `\n_${String(reason).slice(0, 120)}_` : ''}\nBot pronto — comandos respondendo normalmente.`;
    let r;
    if (_syncMsgId) r = await _editSyncRaw(txt);
    else r = await sendAlert(txt, { key: 'sync', cooldownMs: 0, disableNotification: true });
    _syncMsgId = null;
    return r;
}

// Teste manual
async function test() {
    return sendAlert(
        formatAlert({
            title: '✅ TESTE TELEGRAM',
            botName: 'Gravity Bot🪐',
            status: 'Alerta de teste OK',
            reason: 'Se recebeu esta mensagem, os alertas estão funcionando!',
            extra: 'Você receberá avisos de: zumbi, desconexão e reconexão.'
        }),
        { key: 'test', cooldownMs: 0 }
    );
}

module.exports = {
    isConfigured,
    configure,
    sendAlert,
    notifyZombie,
    notifyDisconnect,
    notifyConnected,
    notifySyncStart,
    notifySyncProgress,
    notifySyncDone,
    notifyQr,
    notifyError,
    notifyCommand,
    test,
    formatAlert
};
