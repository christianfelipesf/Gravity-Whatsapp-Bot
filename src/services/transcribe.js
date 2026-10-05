// transcribe.js — áudio/vídeo do WhatsApp → texto.
// Cadeia de provedores (transcribeProvider=auto):
//   1) Groq (GROQ_API_KEY, grátis) → whisper-large-v3-turbo, rápido e preciso
//   2) OpenAI (OPENAI_API_KEY) → whisper-1
//   3) OpenRouter STT (OPENROUTER_API_KEY) → mesmo endpoint p/ contas com saldo
//      (conta sem saldo retorna 402 e o bot cai p/ o próximo)
//   4) Local offline (scripts/transcribe_local.py + faster-whisper, sem chave)
// Sem chave nenhuma e sem faster-whisper: erro orientando como habilitar.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const ffmpeg = require('./ffmpeg');

const { withTimeout } = require('./timeout');

const STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions';

const PROVIDER_DEFAULT_MODELS = {
    groq: 'whisper-large-v3-turbo',
    openai: 'whisper-1',
    openrouter: 'openai/whisper-1',
    local: 'base'
};
const FALLBACK_MODEL = PROVIDER_DEFAULT_MODELS.openrouter;
const DEFAULT_MAX_SECONDS = 600; // 10 min
const MAX_INPUT_BYTES = 20 * 1024 * 1024; // igual ao changeSpeed
const MAX_API_BYTES = 25 * 1024 * 1024; // limite dos endpoints cloud
const DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS) || 30000;
const FFMPEG_TIMEOUT_MS = 60000;
const STT_TIMEOUT_MS = 120000;
const LOCAL_TIMEOUT_MS = 300000;

// Primeiro arg pode ser o idioma (ISO-639-1): "!transcrever en".
// Igual ao padrão do traduzir.js.
function parseTranscribeArgs(args) {
    const rest = Array.isArray(args) ? [...args] : [];
    let language = 'pt';
    if (rest.length > 0 && /^[a-z]{2}$/i.test(String(rest[0] || '').trim())) {
        language = String(rest.shift()).trim().toLowerCase();
    }
    return { language };
}

// Monta a key da mensagem-alvo (citada ou direta).
// Mesma lógica de grupo/DM do events/media.js: em grupo o participant é
// obrigatório; em DM ele DEVE ser omitido (senão o reupload falha).
function _buildTargetKey(sock, from, quotedInfo) {
    const stanzaId = quotedInfo.stanzaId;
    const isGroupChat = typeof from === 'string' && from.endsWith('@g.us');
    if (isGroupChat) {
        const key = {
            remoteJid: from,
            id: stanzaId,
            participant: quotedInfo.participant || from,
            fromMe: false
        };
        try {
            const meNum = String(sock?.user?.id || '').split(':')[0].split('@')[0];
            const qpNum = String(quotedInfo.participant || '').split(':')[0].split('@')[0];
            if (meNum && qpNum && meNum === qpNum) key.fromMe = true;
        } catch (_) {}
        return key;
    }
    let fromMe = false;
    try {
        const meNum = String(sock?.user?.id || '').split(':')[0].split('@')[0];
        const qpNum = String(quotedInfo.participant || '').split(':')[0].split('@')[0];
        if (qpNum && meNum && qpNum === meNum) fromMe = true;
    } catch (_) {}
    return { remoteJid: from, id: stanzaId, fromMe };
}

// Localiza o áudio/vídeo: citada primeiro, depois a própria mensagem.
// Retorna { targetMsg, mediaMessage } ou flags de erro amigável.
function resolveAudioTarget(sock, from, m, getMediaMessage) {
    const quotedInfo = m.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = quotedInfo?.quotedMessage;
    if (quotedMsg) {
        const media = getMediaMessage(quotedMsg);
        if (media && (media.audioMessage || media.videoMessage)) {
            return {
                targetMsg: { key: _buildTargetKey(sock, from, quotedInfo), message: quotedMsg },
                mediaMessage: media
            };
        }
        return { targetMsg: null, mediaMessage: null, quotedNonAudio: true };
    }
    const direct = getMediaMessage(m.message);
    if (direct && (direct.audioMessage || direct.videoMessage)) {
        return { targetMsg: m, mediaMessage: direct };
    }
    return { targetMsg: null, mediaMessage: null };
}

function _downloadOnce(sock, targetMsg) {
    const label = `download-transcrever ${targetMsg?.key?.id || '?'}`;
    const dl = downloadMediaMessage(
        targetMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    ).then(
        (buf) => {
            if (!buf || buf.length === 0) throw new Error('download-vazio');
            return buf;
        },
        (e) => { throw new Error(`download-falhou: ${String(e?.message || e).slice(0, 150)}`); }
    );
    return withTimeout(dl, DOWNLOAD_TIMEOUT_MS, label);
}

async function downloadAudioBuffer(sock, from, targetMsg) {
    try {
        return await _downloadOnce(sock, targetMsg);
    } catch (_) {
        // Fallback DM: inverte fromMe uma vez (mesmo padrão do reveal/speed).
        if (targetMsg?.key && typeof from === 'string' && !from.endsWith('@g.us')) {
            try {
                targetMsg.key = { ...targetMsg.key, fromMe: !targetMsg.key.fromMe };
                return await _downloadOnce(sock, targetMsg);
            } catch (_) { /* cai no erro abaixo */ }
        }
        throw new Error('Não consegui baixar o áudio. Tente encaminhar o áudio direto ao bot.');
    }
}

function _guessInputExt(mediaMessage) {
    try {
        const mime = mediaMessage.audioMessage?.mimetype
            || mediaMessage.videoMessage?.mimetype
            || '';
        if (/ogg|opus/i.test(mime)) return '.ogg';
        if (/mp4|m4a/i.test(mime)) return '.m4a';
        if (/mpeg|mp3/i.test(mime)) return '.mp3';
        if (/wav/i.test(mime)) return '.wav';
        if (/webm/i.test(mime)) return '.webm';
    } catch (_) {}
    return mediaMessage.videoMessage ? '.mp4' : '.ogg';
}

// Converte qualquer áudio/vídeo p/ mp3 mono 16kHz 64k — formato ideal e
// pequeno p/ o Whisper (áudio de WhatsApp costuma ser ogg/opus).
function convertToMp3(buffer, ext) {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const id = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `tr_in_${id}${ext || '.ogg'}`);
    const outputPath = path.join(tempDir, `tr_out_${id}.mp3`);
    const cleanup = () => {
        try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    };
    fs.writeFileSync(inputPath, buffer);
    return new Promise((resolve, reject) => {
        let cmd = null;
        const to = setTimeout(() => {
            try { if (cmd && typeof cmd.kill === 'function') cmd.kill('SIGKILL'); } catch (_) {}
            cleanup();
            reject(new Error('Tempo esgotado ao converter o áudio (ffmpeg 60s).'));
        }, FFMPEG_TIMEOUT_MS);
        cmd = ffmpeg(inputPath)
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .audioChannels(1)
            .audioFrequency(16000)
            .toFormat('mp3')
            .on('end', () => {
                clearTimeout(to);
                let out = null;
                try { out = fs.readFileSync(outputPath); } catch (_) {}
                cleanup();
                if (!out || out.length === 0) return reject(new Error('Falha ao converter o áudio.'));
                resolve(out);
            })
            .on('error', (e) => {
                clearTimeout(to);
                cleanup();
                reject(new Error(`Falha ao converter o áudio: ${String(e?.message || e).slice(0, 120)}`));
            })
            .save(outputPath);
    });
}

function _isBalanceError(e) {
    const status = e?.response?.status;
    const msg = String(e?.response?.data?.error?.message || e?.message || '').toLowerCase();
    return status === 402 || msg.includes('at least $0.50') || msg.includes('insufficient balance') || msg.includes('insufficient_quota');
}

// --- Provedor OpenRouter STT (JSON + base64) ---
async function transcribeBuffer(mp3Buffer, { apiKey, model, language, signal }) {
    if (!apiKey) throw new Error('IA não configurada. Defina OPENROUTER_API_KEY no arquivo .env');
    const data = mp3Buffer.toString('base64');
    let res;
    try {
        res = await axios.post(STT_URL, {
            model: model || PROVIDER_DEFAULT_MODELS.openrouter,
            input_audio: { data, format: 'mp3' },
            language: language || 'pt'
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/BotStickerNode',
                'X-Title': 'BotStickerNode',
                'Content-Type': 'application/json'
            },
            timeout: STT_TIMEOUT_MS,
            signal
        });
    } catch (e) {
        if (_isBalanceError(e)) {
            const err = new Error('OpenRouter sem saldo para áudio.');
            err.code = 'NO_BALANCE';
            throw err;
        }
        const status = e?.response?.status;
        const msg = String(e?.response?.data?.error?.message || e?.message || e).slice(0, 200);
        if (status === 401 || status === 403) throw new Error('Chave OpenRouter inválida ou sem acesso ao modelo de transcrição.');
        if (status === 400) throw new Error(`Áudio rejeitado pela API: ${msg}`);
        throw new Error(`Falha na transcrição: ${msg}`);
    }
    const text = String(res?.data?.text || '').trim();
    if (!text) throw new Error('A API retornou transcrição vazia. Tente um áudio mais nítido.');
    return text;
}

// --- Provedores compatíveis com OpenAI (Groq / OpenAI): multipart + file ---
async function transcribeViaOpenAICompat(mp3Buffer, { url, apiKey, model, language, signal, httpPost, providerName }) {
    if (!apiKey) throw new Error(`Chave ${providerName || 'da API'} não configurada.`);
    const post = httpPost || axios.post;
    const form = new FormData();
    form.append('file', new Blob([mp3Buffer], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', model);
    if (language) form.append('language', language);
    let res;
    try {
        res = await post(url, form, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: STT_TIMEOUT_MS,
            signal
        });
    } catch (e) {
        if (_isBalanceError(e)) {
            const err = new Error(`${providerName || 'API'} sem saldo/cota para áudio.`);
            err.code = 'NO_BALANCE';
            throw err;
        }
        const status = e?.response?.status;
        const msg = String(e?.response?.data?.error?.message || e?.message || e).slice(0, 200);
        if (status === 401 || status === 403 || /invalid api key|invalid_api_key|unauthorized/i.test(msg)) {
            throw new Error(`Chave ${providerName || 'da API'} inválida.`);
        }
        throw new Error(`Falha na transcrição (${providerName || 'API'}): ${msg}`);
    }
    const text = String(res?.data?.text || '').trim();
    if (!text) throw new Error('A API retornou transcrição vazia. Tente um áudio mais nítido.');
    return text;
}

// --- Provedor local offline (faster-whisper) ---
function buildLocalArgs(audioPath, { model, language }) {
    const script = path.join(process.cwd(), 'scripts', 'transcribe_local.py');
    const py = process.platform === 'win32' ? 'python' : 'python3';
    return {
        cmd: py,
        args: [script, audioPath, '--model', model || PROVIDER_DEFAULT_MODELS.local, '--language', language || 'pt']
    };
}

function parseLocalResult(stdout, exitCode) {
    let obj = null;
    try {
        const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        obj = JSON.parse(lines[lines.length - 1]);
    } catch (_) { /* abaixo */ }
    if (!obj || typeof obj !== 'object') throw new Error('Transcritor local falhou (saída inválida).');
    if (obj.error) {
        const err = new Error(`Transcritor local: ${String(obj.error).slice(0, 200)}`);
        if (/faster-whisper nao instalado/i.test(obj.error)) err.code = 'LOCAL_MISSING';
        throw err;
    }
    const text = String(obj.text || '').trim();
    if (exitCode !== 0 || !text) throw new Error('Transcrição local vazia. Tente um áudio mais nítido.');
    return text;
}

function transcribeViaLocal(mp3Buffer, { model, language, timeoutMs, signal } = {}) {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const id = crypto.randomBytes(4).toString('hex');
    const audioPath = path.join(tempDir, `tr_local_${id}.mp3`);
    fs.writeFileSync(audioPath, mp3Buffer);
    const { cmd, args } = buildLocalArgs(audioPath, { model, language });
    return new Promise((resolve, reject) => {
        const done = (fn) => (...a) => {
            clearTimeout(to);
            try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (_) {}
            fn(...a);
        };
        const ok = done(resolve);
        const fail = done(reject);
        let child;
        try {
            child = spawn(cmd, args, {
                windowsHide: true,
                env: {
                    ...process.env,
                    TRANSCRIBE_MODEL_DIR: path.join(process.cwd(), 'models', 'stt'),
                    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || '0'
                }
            });
        } catch (e) {
            return fail(new Error(`Python indisponível para transcrição local: ${e.message}`));
        }
        let out = '';
        let errOut = '';
        const to = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            fail(new Error('Transcrição local demorou demais (timeout 5min). Tente um áudio mais curto.'));
        }, timeoutMs || LOCAL_TIMEOUT_MS);
        if (to.unref) { try { to.unref(); } catch (_) {} }
        const onAbort = () => {
            try { child.kill('SIGKILL'); } catch (_) {}
            fail(Object.assign(new Error('Comando interrompido por timeout'), { code: 'ABORTED' }));
        };
        try { signal?.addEventListener?.('abort', onAbort, { once: true }); } catch (_) {}
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.stderr?.on('data', (d) => { errOut += d.toString(); });
        child.on('error', (e) => {
            try { signal?.removeEventListener?.('abort', onAbort); } catch (_) {}
            const err = new Error(`Python indisponível para transcrição local: ${e.message}`);
            if (/ENOENT/i.test(String(e.message))) err.code = 'LOCAL_MISSING';
            fail(err);
        });
        child.on('close', (code) => {
            try { signal?.removeEventListener?.('abort', onAbort); } catch (_) {}
            if (signal?.aborted) return fail(Object.assign(new Error('Comando interrompido por timeout'), { code: 'ABORTED' }));
            try {
                ok(parseLocalResult(out, code));
            } catch (e) {
                if (/faster-whisper nao instalado/i.test(String(errOut)) && !e.code) e.code = 'LOCAL_MISSING';
                fail(e);
            }
        });
    });
}

// Monta a lista de candidatos na ordem de tentativa.
function pickProviders(config = {}) {
    const forced = String(config?.transcribeProvider || process.env.TRANSCRIBE_PROVIDER || 'auto').trim().toLowerCase();
    const keys = {
        groq: config?.groqApiKey || process.env.GROQ_API_KEY || '',
        openai: config?.openaiApiKey || process.env.OPENAI_API_KEY || '',
        openrouter: config?.openrouterApiKey || process.env.OPENROUTER_API_KEY || ''
    };
    const modelOverride = config?.transcribeModel || process.env.TRANSCRIBE_MODEL || '';
    const localModel = config?.transcribeLocalModel || process.env.TRANSCRIBE_LOCAL_MODEL || PROVIDER_DEFAULT_MODELS.local;
    const mk = (provider) => {
        if (provider === 'local') return { provider, model: localModel };
        if (provider === 'groq') return { provider, url: GROQ_STT_URL, apiKey: keys.groq, model: modelOverride || PROVIDER_DEFAULT_MODELS.groq };
        if (provider === 'openai') return { provider, url: OPENAI_STT_URL, apiKey: keys.openai, model: modelOverride || PROVIDER_DEFAULT_MODELS.openai };
        return { provider: 'openrouter', apiKey: keys.openrouter, model: modelOverride || PROVIDER_DEFAULT_MODELS.openrouter };
    };
    if (forced !== 'auto') {
        if (!['groq', 'openai', 'openrouter', 'local'].includes(forced)) {
            throw new Error(`transcribeProvider inválido: '${forced}'. Use auto|groq|openai|openrouter|local.`);
        }
        if (forced !== 'local' && !keys[forced]) {
            throw new Error(`Provedor '${forced}' sem chave. Defina ${forced === 'groq' ? 'GROQ_API_KEY' : forced === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'} no .env ou use transcribeProvider=local.`);
        }
        return [mk(forced)];
    }
    const list = [];
    if (keys.groq) list.push(mk('groq'));
    if (keys.openai) list.push(mk('openai'));
    if (keys.openrouter) list.push(mk('openrouter'));
    list.push(mk('local'));
    return list;
}

async function _runCandidate(candidate, mp3Buffer, { language, signal, log }) {
    try { log?.(`stt:${candidate.provider}`, candidate.model); } catch (_) {}
    if (candidate.provider === 'local') {
        return await transcribeViaLocal(mp3Buffer, { model: candidate.model, language, signal });
    }
    if (candidate.provider === 'openrouter') {
        return await transcribeBuffer(mp3Buffer, { apiKey: candidate.apiKey, model: candidate.model, language, signal });
    }
    return await transcribeViaOpenAICompat(mp3Buffer, {
        url: candidate.url,
        apiKey: candidate.apiKey,
        model: candidate.model,
        language,
        signal,
        providerName: candidate.provider === 'groq' ? 'Groq' : 'OpenAI'
    });
}

// Orquestra tudo: localizar → baixar → validar → converter → transcrever
// (com fallback automático entre provedores no modo auto).
async function transcribeAudioMessage(sock, from, m, { config, utils, language, signal, log } = {}) {
    const { getMediaMessage } = utils || {};
    if (typeof getMediaMessage !== 'function') throw new Error('getMediaMessage indisponível');

    const maxSeconds = Number(config?.transcribeMaxSeconds) || DEFAULT_MAX_SECONDS;
    const lang = language || 'pt';

    const resolved = resolveAudioTarget(sock, from, m, getMediaMessage);
    if (resolved.quotedNonAudio) {
        throw new Error('A mensagem marcada não é áudio nem vídeo. Marque um áudio ou vídeo.');
    }
    if (!resolved.targetMsg || !resolved.mediaMessage) {
        throw new Error('Marque um áudio/vídeo ou envie o áudio com a legenda !transcrever.');
    }

    // Trava revealAdminOnly: áudio/vídeo view-once transcrito também exige
    // admin (senão o !revelar seria burlado via !transcrever).
    try {
        const isVO = typeof utils?.isViewOnce === 'function' ? utils.isViewOnce(resolved.targetMsg.message) : false;
        if (isVO) {
            const canUse = typeof utils?.canUseViewOnce === 'function'
                ? await utils.canUseViewOnce(sock, from, m)
                : true;
            if (!canUse) {
                const msg = typeof utils?.viewOnceBlockedMessage === 'function'
                    ? utils.viewOnceBlockedMessage()
                    : '🔒 Apenas *admins* podem usar mídia de visualização única neste grupo.';
                throw Object.assign(new Error(msg), { code: 'VIEWONCE_ADMIN_ONLY' });
            }
        }
    } catch (e) {
        if (e?.code === 'VIEWONCE_ADMIN_ONLY') throw e;
        /* em erro de verificação mantém liberado (padrão) */
    }

    const seconds = resolved.mediaMessage.audioMessage?.seconds
        ?? resolved.mediaMessage.videoMessage?.seconds
        ?? null;
    if (Number.isFinite(Number(seconds)) && Number(seconds) > maxSeconds) {
        throw new Error(`Áudio muito longo (${Math.round(Number(seconds))}s). Máximo: ${maxSeconds}s.`);
    }

    try { log?.('download'); } catch (_) {}
    const buffer = await downloadAudioBuffer(sock, from, resolved.targetMsg);
    if (buffer.length > MAX_INPUT_BYTES) {
        throw new Error(`Áudio muito grande (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Máximo: ${MAX_INPUT_BYTES / 1024 / 1024}MB.`);
    }

    try { log?.('convert', `${buffer.length} bytes`); } catch (_) {}
    const mp3 = await convertToMp3(buffer, _guessInputExt(resolved.mediaMessage));
    if (mp3.length > MAX_API_BYTES) {
        // Nuvem limita em 25MB; local aceita maior — segue p/ candidatos locais.
        try { log?.('oversize-cloud', `${mp3.length} bytes`); } catch (_) {}
    }

    const candidates = pickProviders(config);
    const errors = [];
    for (const candidate of candidates) {
        if (signal?.aborted) throw Object.assign(new Error('Comando interrompido por timeout'), { code: 'ABORTED' });
        if (candidate.provider !== 'local' && mp3.length > MAX_API_BYTES) {
            errors.push(`${candidate.provider}: áudio >25MB, pulado`);
            continue;
        }
        try {
            const text = await _runCandidate(candidate, mp3, { language: lang, signal, log });
            return { text, seconds: Number(seconds) || null, provider: candidate.provider, model: candidate.model };
        } catch (e) {
            if (e?.code === 'ABORTED' || signal?.aborted) throw e;
            // Modo auto: tenta o próximo (ex.: OpenRouter sem saldo → local).
            // Provedor forçado: erro direto.
            if (candidates.length === 1) throw e;
            errors.push(`${candidate.provider}: ${String(e?.message || e).slice(0, 120)}`);
        }
    }
    const missingLocal = errors.some((x) => /faster-whisper nao instalado|Python indisponível/i.test(x));
    if (missingLocal && !errors.some((x) => !/faster-whisper nao instalado|Python indisponível/i.test(x))) {
        throw new Error('Nenhum transcritor disponível. Opções: 1) adicione GROQ_API_KEY gratuita no .env, 2) instale com: pip install faster-whisper.');
    }
    throw new Error(`Transcrição falhou em todos os provedores. ${errors.join(' | ').slice(0, 300)}`);
}

module.exports = {
    parseTranscribeArgs,
    resolveAudioTarget,
    downloadAudioBuffer,
    convertToMp3,
    transcribeBuffer,
    transcribeViaOpenAICompat,
    transcribeViaLocal,
    buildLocalArgs,
    parseLocalResult,
    pickProviders,
    transcribeAudioMessage,
    PROVIDER_DEFAULT_MODELS,
    FALLBACK_MODEL,
    DEFAULT_MAX_SECONDS,
    STT_URL
};
