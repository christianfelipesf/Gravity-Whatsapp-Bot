require('dotenv').config();

// Suprime janelas de console (conhost) no Windows para ffmpeg/python/etc.
// ANTES de qualquer spawn — o patch pega o módulo child_process cacheado,
// cobrindo o wrapper interno src/services/ffmpeg (stickers/conversões).
try { require('./src/services/spawnSafe').patchChildProcess(); } catch (_) {}

// Instância única ANTES de qualquer socket/Telegram: dois processos no mesmo
// número geram close 440 (connectionReplaced) em loop — a "sessão fantasma".
// Se já houver uma instância viva, aborta aqui e o pm2 não duplica conexão.
try {
    const si = require('./src/services/singleInstance');
    const lock = si.acquire();
    if (!lock.ok) {
        // NÃO usar exit(0): o pm2 tem `stop_exit_codes: [0]` por padrão, então
        // saída 0 faz o pm2 marcar o app como "stopped" e nunca mais reiniciar —
        // se o lock for de um órfão que morre depois, o bot fica morto de vez.
        // Saída 1 faz o pm2 tentar de novo (o acquire espera ~30s, então é um
        // retry lento que se auto-corrige quando a duplicata some).
        console.error(`⛔ [singleInstance] outra instância já está ativa (pid=${lock.holder?.pid} pm2=${lock.holder?.pm2 ?? false}) — abortando para evitar sessão fantasma/440.`);
        process.exit(1);
    }
    if (lock.degraded) {
        console.warn(`⚠️ [singleInstance] lock indisponível (${lock.error?.message || lock.error}) — seguindo sem proteção`);
    }
} catch (e) {
    console.warn(`⚠️ [singleInstance] falha ao aplicar lock: ${e.message} — seguindo`);
}

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const ffmpeg = require('./src/services/ffmpeg');
const { execFileSync } = require('child_process');
let _ffmpegChecked = false;
let _ffmpegFound = false;
function ensureFfmpeg() {
    if (_ffmpegChecked) return;
    _ffmpegChecked = true;
    try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const out = execFileSync(finder, ['ffmpeg'], { windowsHide: true }).toString().split(/\r?\n/)[0].trim();
        if (out) { ffmpeg.setFfmpegPath(out); _ffmpegFound = true; }
    } catch (_) {}
}

// Utilidades e Configurações
const {
    isActiveGroup,
    listDashboardGroups,
    incrementRestart,
    readConfig,
    flushNow
} = require('./src/database/utils');

// Modulos Isolados (Refatoração AI.txt)
const { initLogger } = require('./src/services/logger');
const trace = require('./src/services/trace');
const terminalLog = require('./src/services/terminalLog');
const { loadCommands, commands } = require('./src/commands/loader');
const { handleGroupParticipantsUpdate, handleGroupUpdate } = require('./src/events/group');
const { handleMessageUpsert } = require('./src/events/message');
const { setupAI } = require('./src/services/ai');
        const dashboard = require('./src/services/dashboardStub');
const news = require('./src/services/news');
const splash = require('./src/services/splash');
const subSessions = require('./src/services/subSessions');
const { startTempCleanup } = require('./src/services/tempCleanup');
const watchdog = require('./src/services/watchdog');
const telegram = require('./src/services/telegramAlerts');
const telegramBot = require('./src/services/telegramBot');

// Inicializar Filtro de Logs
initLogger();

// Supabase (nuvem): pull no boot (nuvem vence) + push periódico. Não trava o boot.
try { require('./src/database/supabaseSync').startAutoSync(); } catch (e) {
    console.error('⚠️ [supabase] falha ao iniciar sync (segue local):', e.message);
}

// Adiciona [hh:mm:ss] em cada console.log/info/warn/error
trace.patch();

// Captura últimos 50 console.* em ring buffer + arquivo diário (logs/terminal_YYYY-MM-DD.log)
terminalLog.init();

// --- Configuração Global ---
const config = readConfig();

// Configura Telegram se env estiver presente
try {
    const tok = (process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken || '').trim();
    const chat = (process.env.TELEGRAM_CHAT_ID || config.telegramChatId || '').trim();
    if (tok && chat) telegram.configure({ token: tok, chatId: chat });
} catch (_) {}

// Bot Telegram de controle: sobe ANTES e INDEPENDENTE do WhatsApp,
// para permitir /status /restart /qr /logs /dump mesmo com Baileys offline.
try { telegramBot.start(); } catch (e) {
    console.error('⚠️ [telegramBot] falha ao iniciar (WhatsApp segue normal):', e.message);
}

// Expõe serviços para que comandos (ex: set.js) possam controlá-los em runtime.
global.__botServices = { news, splash, dashboard, watchdog, telegram, telegramBot };
global.__startTime = Date.now();

// Histórico (!aidono/!resumir) — dono próprio, independe do painel web.
// O dashboard.init() também chama, mas aqui garante mesmo se o painel falhar.
try { require('./src/history/store').ensureHistoryTrimLoop(); } catch (e) {
    console.error('⚠️ [history] falha ao iniciar trim (segue normal):', e.message);
}

// Histórico em banco (dashboardStub.log) — painel web arquivado, só o log permanece.
try {
    dashboard.init(config);
    dashboard.setGroupsApi(() => {
        try {
            return listDashboardGroups()
                .map(jid => ({ jid }));
        } catch (_) { return []; }
    });
} catch (e) {
    console.error('⚠️ [dashboard] falha ao iniciar (bot segue normal):', e.message);
}

// Inicializar Inteligência Artificial e Comandos
setupAI(config);
loadCommands({ verbose: false });

// Limpeza automática de temp/ a cada 30 min (arquivos > 1h)
startTempCleanup();

// Dump automático diário no Telegram (1x/dia, horário TELEGRAM_DUMP_HOUR)
try { require('./src/services/dailyDump').startDailyDump(); } catch (e) {
    console.error('⚠️ [dailyDump] falha ao agendar (bot segue normal):', e.message);
}

// Restaurar sub-sessões Baileys persistidas SOMENTE depois do principal 🟢.
// Antes elas subiam em paralelo ao principal e causavam 428/515/401 (conflito Baileys).
const _restorePromise = Promise.resolve();
try {
    const principalState = require('./src/services/principalState');
    principalState.emitter.once('connected', async () => {
        try {
            // Pequena folga para o principal estabilizar antes da primeira sub.
            await new Promise(r => setTimeout(r, 8000));
            const restored = await subSessions.restoreFromDisk();
            if (restored.length) {
                console.log(`🔐 [subSessions] restauradas ${restored.length} sessão(ões) do disco (pós-principal)`);
            }
        } catch (e) {
            console.error('⚠️ [subSessions] falha ao restaurar:', e.message);
        }
    });
} catch (e) {
    console.error('⚠️ [subSessions] falha ao agendar restore:', e.message);
}

// --- Tratamento de Erros Globais ---
let _fatalExiting = false;
function _fatalExit(label, err) {
    console.error(`💥 [${label}]:`, err);
    try { flushNow(); } catch (_) {}
    try { terminalLog.flushSync(); } catch (_) {}
    try { dashboard.log('error', 'SISTEMA', `${label}: ${err?.message || err}`); } catch (_) {}
    try { telegram.notifyError({ botName: config.botName, error: `${label}: ${err?.message || err}` }).catch(()=>{}); } catch (_) {}
    // Estado do processo é indefinido após erro fatal — sai para o gerenciador reiniciar.
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500).unref();
    _fatalExiting = true;
}
process.on('uncaughtException', (err) => {
    if (_fatalExiting) return;
    if (err.message?.includes('Bad MAC') || err.stack?.includes('libsignal')) {
        console.warn(`⚠️ [BAILEYS][suppressed][uncaughtException] Bad MAC/libsignal — ${err.message?.slice(0,120) || ''}`);
        return;
    }
    _fatalExit('ERRO FATAL', err);
});
process.on('unhandledRejection', (reason) => {
    if (_fatalExiting) return;
    if (reason?.message?.includes('Bad MAC') || reason?.stack?.includes('libsignal')) {
        console.warn(`⚠️ [BAILEYS][suppressed][unhandledRejection] Bad MAC/libsignal — ${reason.message?.slice(0,120) || ''}`);
        return;
    }
    if (reason?.isBoom) {
        const code = reason.output?.statusCode;
        if (code === 428 || code === 515 || code === 502) {
            console.warn(`⚠️ [BAILEYS][suppressed][unhandledRejection] Boom ${code} — ${reason.message || ''} | stack0=${(reason.stack||'').split('\n')[1]?.trim()||''}`);
            return;
        }
    }
    if (reason?.message?.includes('Connection Closed') || reason?.message?.includes('Precondition Required')) {
        console.warn(`⚠️ [BAILEYS][suppressed][unhandledRejection] Connection Closed/Precondition — ${reason.message?.slice(0,150) || ''}`);
        return;
    }
    _fatalExit('REJEIÇÃO NÃO TRATADA', reason);
});

// FFmpeg: lazy detection (executado na 1ª vez que precisar)
ensureFfmpeg();

const startTime = Date.now();
try { dashboard.setStartTime(startTime); } catch (_) {}
const _restartNumber = incrementRestart();
try {
    const utils = require('./src/database/utils');
    const _version = utils.getVersion();
    const _stats = utils.readStats();
    const _ts = new Date().toLocaleString('pt-BR');
    dashboard.log('action', 'SISTEMA',
        `🔄 Reinício #${_restartNumber} — v${_version} • ${_ts} • Comandos acumulados: ${_stats.totalCommands || 0}`,
        'Sistema', '—');
} catch (_) {}

/* ========== Boot summary (uma linha por componente, status real) ========== */

const _aiOk = !!require('./src/services/ai').getModel();
const _sockDir = fs.existsSync('session') ? '✓' : '✗';
const _nodeVer = process.version;
const _os = `${process.platform} ${process.arch}`;

console.log('');
console.log('═'.repeat(60));
console.log(`🤖  ${config.botName.toUpperCase()} • v${require('./src/database/utils').getVersion()} • Reinício #${_restartNumber}`);
console.log('═'.repeat(60));
console.log(`  📦 comandos     carregando em background...`);
console.log(`  💾 database     logs • bot.db OK`);
console.log(`  🌐 dashboard    arquivado (só histórico em banco)`);
    console.log(`  🤖 IA OpenRouter ${_aiOk ? '✓ ativa (' + (config.aiModel || 'default') + ')' : '✗ sem API key'}`);
console.log(`  📰 news         ${config.newsEnabled !== false ? '✓ ativo' : '✗ desativado'}`);
console.log(`  🎬 ffmpeg       ${_ffmpegChecked ? (_ffmpegFound ? '✓' : 'não encontrado') : '?'}`);
console.log(`  🔐 sessão       ${_sockDir} ${_sockDir === '✓' ? 'salva' : 'QR necessário'}`);
console.log(`  ⚙️  plataforma   ${_os} • Node ${_nodeVer}`);
console.log('═'.repeat(60));

let _qrAttempts = 0;
const MAX_QR_ATTEMPTS = 3;
let _reconnecting = false;
let _reconnectBackoffMs = 5000;
let _lastCloseCode = null;
const RECONNECT_BACKOFF_MAX = 60000;
global.__qrControl = {
    getAttempts: () => _qrAttempts,
    getMaxAttempts: () => MAX_QR_ATTEMPTS,
    stopRetrying: () => { _qrAttempts = MAX_QR_ATTEMPTS; console.log('⛔ [ADMIN] QR retry stopped manually'); },
    resetAttempts: () => { _qrAttempts = 0; console.log('🔄 [ADMIN] QR retry count reset'); }
};

try {
    const { baileysEnabled } = readConfig();
    global.__baileysEnabled = baileysEnabled !== false;
} catch (_) {
    global.__baileysEnabled = true;
}

async function startBot() {
    if (!global.__baileysEnabled) {
        console.log('⏸️ [Baileys] desligado manualmente — não iniciando');
        return;
    }
    if (_reconnecting) {
        console.log('⏳ [Baileys] reconexão já em andamento — ignorando chamada duplicada');
        return;
    }
    _reconnecting = true;
    try { await _restorePromise; } catch (_) {}
    try {
        const { state, saveCreds } = await useMultiFileAuthState('session');
        const { getCachedBaileysVersion } = require('./src/services/version');
        const version = await getCachedBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'fatal' }),
            printQRInTerminal: false,
            auth: state,
            // Modo Humanizado: browser genérico de PC real. Usar o nome do bot
            // aqui (ex: "Gravity Bot") é assinatura clássica de automação.
            browser: ['Windows', 'Chrome', '124.0.0.0'],
            syncFullHistory: false,
            fireInitQueries: true,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            // Humanizado LIGADO (default): não fica "online" fixo no connect.
            // Humano aparece online só ao digitar/responder (via presence).
            markOnlineOnConnect: readConfig().humanMode === false
        });

        // Camada anti-ban: digitação, delay humano e throttle em todos os envios
        try { require('./src/services/humanize').wrapSocketForHumanMode(sock); } catch (_) {}

        global.__baileysSock = sock;

        // Telegram já foi iniciado no boot (independente do WhatsApp) — não reinicia aqui.

        // Inicia watchdog anti-zumbi
        try {
            watchdog.start({
                getSock: () => global.__baileysSock,
                onZombie: async ({ idleMs, wsState, reason, zombieCount }) => {
                    try { await telegram.notifyZombie({ botName: config.botName, idleMs, wsState, reason: `${reason} #${zombieCount}` }); } catch (_) {}
                }
            });
        } catch (_) {}

        try { dashboard.attachSock(sock); } catch (_) {}
        try { dashboard.pushGroupsSnapshot(); } catch (_) {}
        try {
            const curCfg = readConfig();
            if (curCfg.newsEnabled !== false) {
                news.attachSock(sock);
                news.start();
            }
            // news desativado é mostrado no boot summary (não loga aqui)
            // splash: só guarda o sock; o disparo é por contagem em message.js
            try { splash.attachSock(sock); } catch (_) {}
        } catch (_) {}

        sock.ev.on('creds.update', async (...args) => {
            try { await saveCreds(...args); }
            catch (e) { console.error(`⚠️ [creds.update] falha ao salvar creds: ${e.message} | stack0=${(e.stack||'').split('\n')[1]?.trim()||''}`); }
        });

        let _connAttemptId = 0;
        // safety: garante que _reconnecting não fique preso em half-open
        let _reconnectSafetyTimer = setTimeout(() => { if (_reconnecting) { console.warn('⚠️ [watchdog] _reconnecting travado >30s — liberando'); _reconnecting = false; } }, 30000);
        if (_reconnectSafetyTimer.unref) _reconnectSafetyTimer.unref();

        sock.ev.on('connection.update', async (u) => {
            if (u.qr) {
                _qrAttempts++;
                console.log(`\n⚡ --- QR CODE #${_qrAttempts}/${MAX_QR_ATTEMPTS} (attemptId=${_restartNumber}-${_qrAttempts}) --- ⚡`);
                try {
                    console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
                } catch (e) {
                    console.log(u.qr);
                }
                try { dashboard.setConnectionState({ status: 'qr', qr: u.qr, phone: null }); } catch (_) {}
                try { require('./src/services/principalState').setQr(u.qr); } catch (_) {}
                try { telegram.notifyQr({ botName: config.botName, attempt: _qrAttempts }).catch(()=>{}); } catch (_) {}
                if (_qrAttempts >= MAX_QR_ATTEMPTS) {
                    console.log(`⛔ Limite de ${MAX_QR_ATTEMPTS} QR codes atingido. Pare o bot e apague a pasta session/ manualmente ou use o painel admin.`);
                }
            }
            if (u.connection === 'close') {
                global.__baileysSock = null;
                _reconnecting = false;
                try { clearTimeout(_reconnectSafetyTimer); } catch (_) {}
                try {
                    const principalState = require('./src/services/principalState');
                    principalState.clearSock();
                    // Marca offline de verdade: sem isso _connected ficava true
                    // para sempre e o GATE das subs/waitForConnection mentia.
                    principalState.setDisconnected();
                } catch (_) {}
                const lastErr = u.lastDisconnect?.error;
                const code = (lastErr instanceof Boom)
                    ? lastErr.output?.statusCode
                    : lastErr?.statusCode || lastErr?.output?.statusCode;
                const reasonName = (() => { try { if (DisconnectReason[code]) return String(DisconnectReason[code]); for (const [k,v] of Object.entries(DisconnectReason)) if (v===code) return k; } catch(_){} return 'unknown'; })();
                _lastCloseCode = code;
                const boomMsg = lastErr?.message || lastErr?.output?.payload?.message || '';
                const stack0 = (lastErr?.stack||'').split('\n')[1]?.trim()||'';
                console.warn(`🔌 [CONNECTION] close code=${code ?? '?'} reason=${reasonName} boom=${!!(lastErr instanceof Boom)} msg="${String(boomMsg).slice(0,150)}" stack0="${stack0}" attemptId=${_restartNumber}-${_qrAttempts} isBoom=${!!lastErr?.isBoom}`);
                try { dashboard.setConnectionState({ status: 'disconnected', qr: null, phone: null }); } catch (_) {}
                try { require('./src/services/subConnLog').connlog('principal', 'close', `code=${code ?? '?'} reason=${reasonName}`); } catch (_) {}
                try { telegram.notifyDisconnect({ botName: config.botName, code: code ?? '?', reasonName, phone: null }).catch(()=>{}); } catch (_) {}
                try { require('./src/services/syncProgress').fail(`close code=${code ?? '?'} ${reasonName}`); } catch (_) {}
                if (!global.__baileysEnabled || _qrAttempts >= MAX_QR_ATTEMPTS) {
                    if (!global.__baileysEnabled) console.log('⏸️ [Baileys] desconexão manual — não reconectando');
                    else console.log(`⏸️ QR limit reached (${MAX_QR_ATTEMPTS}). Auto-retry stopped.`);
                    return;
                }
                if (code !== DisconnectReason.loggedOut) {
                    // 440 connectionReplaced: outro socket com as MESMAS credenciais
                    // assumiu (sessão fantasma). Reconectar em rajada faz os dois se
                    // derrubarem em loop — por isso exige backoff longo.
                    if (code === DisconnectReason.connectionReplaced) {
                        _reconnectBackoffMs = Math.max(_reconnectBackoffMs, RECONNECT_BACKOFF_MAX);
                        console.warn('🔁 [CONNECTION] 440 connectionReplaced — possível instância duplicada; backoff longo para quebrar o ping-pong');
                    }
                    const wait = _reconnectBackoffMs;
                    _reconnectBackoffMs = Math.min(RECONNECT_BACKOFF_MAX, _reconnectBackoffMs * 2);
                    // Jitter ±25%: evita rajada sincronizada principal+subs no mesmo IP.
                    const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
                    console.log(`🔄 [CONNECTION] reconectando em ${Math.round(jittered/1000)}s (code=${code} reason=${reasonName} backoff=${wait}ms)`);
                    setTimeout(() => { startBot().catch(e => console.error('reconnect falhou:', e.message, e.stack?.split('\n')[1]?.trim()||'')); }, jittered);
                } else {
                    console.warn(`🔑 [CONNECTION] loggedOut — movendo session p/ quarentena e reconectando`);
                    try {
                        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                        const bak = `session.bak-${stamp}`;
                        try { fs.rmSync(bak, { recursive: true, force: true }); } catch (_) {}
                        // Quarentena em vez de apagar: 401 transitório não destrói a sessão.
                        fs.renameSync('session', bak);
                        try {
                            const olds = fs.readdirSync('.').filter(n => n.startsWith('session.bak-')).sort();
                            while (olds.length > 2) { const o = olds.shift(); try { fs.rmSync(o, { recursive: true, force: true }); } catch (_) {} }
                        } catch (_) {}
                    } catch (e) {
                        try { fs.rmSync('session', { recursive: true, force: true }); } catch (_) {}
                    }
                    _qrAttempts = 0;
                    _reconnectBackoffMs = 5000;
                    setTimeout(() => { startBot().catch(e => console.error('reconnect falhou:', e.message, e.stack?.split('\n')[1]?.trim()||'')); }, 5000);
                }
            } else if (u.connection === 'open') {
                _reconnecting = false;
                // Só zera o backoff em conexão limpa; se o último close foi 440,
                // mantém o backoff longo (evita ping-pong com instância duplicada).
                if (_lastCloseCode !== DisconnectReason.connectionReplaced) _reconnectBackoffMs = 5000;
                try { clearTimeout(_reconnectSafetyTimer); } catch (_) {}
                _qrAttempts = 0;
                _connAttemptId++;
                global.__baileysEnabled = true;
                try {
                    const { readConfig, writeConfig } = require('./src/database/utils');
                    const cfg = readConfig();
                    if (cfg.baileysEnabled === false) writeConfig({ ...cfg, baileysEnabled: true });
                } catch (_) {}
                const utils = require('./src/database/utils');
                const botVersion = utils.getVersion();
                const stats = utils.readStats();
                const ts = new Date().toLocaleString('pt-BR');
                const phone = sock.user?.id?.split?.(':')?.[0] || null;
                console.log(`\n🟢 ${config.botName.toUpperCase()} CONECTADO! (Versão: ${botVersion} | attemptId=${_restartNumber}-${_connAttemptId} | phone=${phone || '?'})\n`);
                try { if (utils.checkMonthlyReset) utils.checkMonthlyReset(); } catch (_) {}
                try { dashboard.setConnectionState({ status: 'connected', qr: null, phone }); } catch (_) {}
                try { require('./src/services/subConnLog').connlog('principal', 'open', `phone=${phone || '?'}`); } catch (_) {}
                try {
                    const principalState = require('./src/services/principalState');
                    // principalState guarda a versão BAILEYS (array) — sub-sessões reutilizam para o socket.
                    principalState.setConnected({ version, phone });
                    principalState.setSock(sock);
                } catch (_) {}
                // Pós-reconnect: drena fila offline descartando backlog e
                // mostrando barra no terminal + Telegram (syncProgress).
                try { require('./src/services/syncProgress').startDraining(); } catch (_) {}
                try { watchdog.touchConnection(); } catch (_) {}
                try { telegram.notifyConnected({ botName: config.botName, phone, version: botVersion }).catch(()=>{}); } catch (_) {}
                try {
                    dashboard.log('action', 'SISTEMA',
                        `🟢 Bot Conectado — v${botVersion} • ${ts} • Comandos: ${stats.totalCommands || 0} • ${phone||''}`,
                        'Sistema', '—');
                } catch (_) {}
                // Resolve o JID real do canal oficial (invite → 1203...@newsletter)
                // para o "Ver canal" aparecer nos envios de mídia. Fire-and-forget.
                try {
                    setTimeout(() => {
                        try { require('./src/services/channelPromo').resolveChannelInfo(sock, config).catch(() => {}); } catch (_) {}
                    }, 15000);
                } catch (_) {}
            }
            if (u.connection === 'connecting') {
                console.log(`⏳ [CONNECTION] connecting... attemptId=${_restartNumber}-${_qrAttempts}`);
                try { require('./src/services/syncProgress').start('connecting'); } catch (_) {}
                try { require('./src/services/principalState').setSyncing(0, 'connecting'); } catch (_) {}
            }
        });

    // Evento de erro do socket (evita unhandled rejection com Boom 428 etc) — agora loga WARN antes de suprimir
    sock.ev.on('error', (err) => {
        const code = err?.output?.statusCode;
        const msg = err?.message || String(err||'');
        const stack0 = (err?.stack||'').split('\n')[1]?.trim()||'';
        if (code === 428 || code === 515 || code === 502) {
            console.warn(`⚠️ [BAILEYS][suppressed][socket.error] Boom ${code} — ${msg.slice(0,150)} | stack0=${stack0}`);
            return;
        }
        if (msg.includes('Connection Closed') || msg.includes('Precondition Required')) {
            console.warn(`⚠️ [BAILEYS][suppressed][socket.error] Connection Closed/Precondition — ${msg.slice(0,150)} | stack0=${stack0}`);
            return;
        }
        console.error('🔌 [SOCKET ERROR]:', msg, '| stack0=', stack0);
    });

        // Evento de Participantes do Grupo (Adição/Remoção/Admin)
        sock.ev.on('group-participants.update', (anu) => {
            handleGroupParticipantsUpdate(sock, anu);
        });

        // Evento de mudanças do grupo (nome/descrição/foto/configs)
        sock.ev.on('groups.update', (updates) => {
            try { handleGroupUpdate(sock, updates); } catch (e) { console.error('Erro no groups.update:', e.message); }
        });

    // Evento de Recebimento de Mensagens — touch watchdog em todo upsert
    sock.ev.on('messages.upsert', (upsert) => {
        try { watchdog.touchInbound(); } catch (_) {}
        handleMessageUpsert(sock, upsert, { commands, config, startTime });
    });

    // Ligações 1:1 — rejeita em silêncio (não toca no celular do dono).
    try { require('./src/events/calls').registerCallHandler(sock); } catch (_) {}

    // Listener direto no websocket para half-open (adicional ao connection.update)
    try {
        if (sock.ws) {
            sock.ws.on('close', () => console.warn('🔌 [WS] close direto'));
            sock.ws.on('error', (e) => console.warn(`🔌 [WS] error direto: ${e?.message?.slice(0,120)||e}`));
        }
    } catch (_) {}
    } catch (e) {
        _reconnecting = false;
        try { clearTimeout(_reconnectSafetyTimer); } catch (_) {}
        console.error(`💥 [startBot] falhou: ${e.message} | stack0=${(e.stack||'').split('\n')[1]?.trim()||''}`, e.stack || '');
        try { terminalLog.flushSync(); } catch (_) {}
        try { telegram.notifyError({ botName: config.botName, error: e.message }).catch(()=>{}); } catch (_) {}
        if (_qrAttempts < MAX_QR_ATTEMPTS) {
            const wait = _reconnectBackoffMs;
            _reconnectBackoffMs = Math.min(RECONNECT_BACKOFF_MAX, _reconnectBackoffMs * 2);
            setTimeout(() => { startBot().catch(e2 => console.error('reconnect falhou:', e2.message, e2.stack?.split('\n')[1]?.trim()||'')); }, wait);
        }
    }
}

global.__startBot = () => {
    if (!global.__baileysEnabled) {
        console.log('⏸️ [Baileys] desligado manualmente — não iniciando');
        return Promise.resolve();
    }
    return startBot();
};
if (global.__baileysEnabled) {
    startBot();
} else {
    console.log('⏸️ [Baileys] desligado na inicialização — não iniciando');
    try {
const dashboard = require('./src/services/dashboardStub');
        dashboard.setConnectionState({ status: 'disconnected', qr: null, phone: null });
    } catch (_) {}
}