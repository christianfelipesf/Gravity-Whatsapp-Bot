const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const { getMaxDurationSeconds, formatDuration } = require('../services/durationLimit');
const { enqueueDownload, enqueueSend } = require('../services/queue');
const { sendMessageSafe } = require('../database/utils');

const cookiesPath = path.join(process.cwd(), 'cookies.txt');

const { normalizeLang, parseLangFromQuery } = require('../services/downloaderCore');
const { withChannelContext } = require('../services/channelPromo');
const { sanitizeUserText } = require('../services/safeDebug');

function parseDurationToSeconds(d) {
    if (typeof d === 'number' && Number.isFinite(d)) return d;
    if (typeof d === 'string') {
        const parts = d.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 3) return parts[0]*3600+parts[1]*60+parts[2];
        if (parts.length === 2) return parts[0]*60+parts[1];
        if (parts.length === 1) return parts[0];
    }
    if (d && typeof d === 'object') {
        if (typeof d.seconds === 'number') return d.seconds;
        if (typeof d.timestamp === 'string') return parseDurationToSeconds(d.timestamp);
    }
    return 0;
}

function searchViaYtDlp(query) {
    return new Promise((resolve) => {
        const proc = spawn('yt-dlp', [
            '--no-warnings',
            '--flat-playlist',
            '--print', '%(id)s|%(title)s|%(duration)s',
            `ytsearch1:${query}`
        ], { windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve(null); }, 30000);
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('error', () => { clearTimeout(timer); resolve(null); });
        proc.on('close', () => {
            clearTimeout(timer);
            const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
            if (!line) return resolve(null);
            const f = line.split('|');
            const id = f[0];
            if (!id || id === 'NA') return resolve(null);
            const title = f.length > 2 ? f.slice(1, -1).join('|') || 'sem título' : 'sem título';
            resolve({ id, url: `https://www.youtube.com/watch?v=${id}`, title, seconds: Number(f[f.length - 1]) || 0 });
        });
    });
}

async function getPlayThumbBuffer(video) {
    let thumbUrl = null;
    try {
        if (video.thumbnail) thumbUrl = typeof video.thumbnail === 'string' ? video.thumbnail : video.thumbnail.url;
        else if (video.image) thumbUrl = typeof video.image === 'string' ? video.image : video.image.url;
        else if (video.thumbnails && Array.isArray(video.thumbnails) && video.thumbnails[0]?.url) thumbUrl = video.thumbnails[0].url;
        else if (video.videoId) thumbUrl = `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
        else if (video.id) thumbUrl = `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`;
        else if (video.url) {
            const m = video.url.match(/(?:v=|\/)([A-Za-z0-9_-]{11})/);
            if (m) thumbUrl = `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
        }
    } catch (_) {}
    if (!thumbUrl) return null;
    try {
        const resp = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 8000 });
        if (!resp.data) return null;
        const sharp = require('sharp');
        let buf = await sharp(Buffer.from(resp.data), { failOn: 'none' }).rotate().resize({ width: 300, height: 300, fit: 'cover', kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        if (buf.length > 100 * 1024) {
            try {
                buf = await sharp(buf, { failOn: 'none' }).resize({ width: 200, height: 200, fit: 'cover' }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
            } catch (_) {}
        }
        return buf;
    } catch (_) { return null; }
}

module.exports = {
    name: 'play',
    aliases: ['p', 'musica', 'youtube'],
    category: 'mídia',
    description: 'Baixa áudio do YouTube (limite configurável, padrão 15 min)',
    async execute(sock, m, { from, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN, config, getSock }) {
        const { react, reactStatus } = utils;
        // Tag nos logs p/ distinguir sub-sessão do principal (sub passa botName 'Sub-sessão').
        const isSub = config?.botName === 'Sub-sessão';
        const PTAG = isSub ? '[PLAY][sub]' : '[PLAY]';
        const plog = (...a) => { try { console.log(`${PTAG}`, ...a); } catch (_) {} };
        const pwarn = (...a) => { try { console.warn(`${PTAG}`, ...a); } catch (_) {} };
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Socket VIVO: na sub ele pode ter sido recriado (reconnect) no meio
        // de um download longo; usar o antigo = envio morto. No principal
        // getSock não existe e cai para o próprio sock (sem mudança).
        const live = () => {
            try { const s = typeof getSock === 'function' ? getSock() : null; return s || sock; }
            catch (_) { return sock; }
        };
        // Na sub o socket cai com frequência (428/515/502); não deixa
        // falha de REAÇÃO abortar o fluxo nem esconder o erro real.
        const isConnClosedErr = (e) => {
            if (!e) return false;
            const code = e?.output?.statusCode || e?.statusCode;
            if (code === 428 || code === 515 || code === 502) return true;
            const msg = String(e?.message || e || '').toLowerCase();
            return msg.includes('connection closed') || msg.includes('precondition required');
        };
        const safeReact = async (fn, _s, ...a) => {
            try { return await fn(live(), ...a); }
            catch (e) { if (isConnClosedErr(e)) { pwarn(`react falhou (conexão fechada): ${e.message}`); return a[2] ?? null; } throw e; }
        };
        const safeReactStatus = async (_s, ...a) => {
            try { return await reactStatus(live(), ...a); }
            catch (e) { if (isConnClosedErr(e)) return a[5] ?? null; throw e; }
        };
        // Envio do áudio com retry no socket atual: se a sub caiu no meio
        // do upload (Stream Errored/428/515), espera o reconnect automático
        // (3-30s) e tenta de novo no socket novo em vez de desistir mudo.
        const sendAudioResilient = async (payload) => {
            const waits = [0, 8000, 20000];
            let lastErr = null;
            for (let i = 0; i < waits.length; i++) {
                if (waits[i]) {
                    pwarn(`nova tentativa de envio em ${waits[i] / 1000}s (tentativa ${i + 1}/${waits.length})...`);
                    await sleep(waits[i]);
                }
                const s = live();
                try {
                    return await enqueueSend(() => sendMessageSafe(s, from, payload, { sendOptions: { quoted: m }, maxRetries: 2, baseDelayMs: 5000 }));
                } catch (e) {
                    lastErr = e;
                    if (!isConnClosedErr(e)) throw e;
                    pwarn(`envio falhou (tentativa ${i + 1}/${waits.length}): ${e?.message || e}`.slice(0, 200));
                }
            }
            throw lastErr;
        };
        let q = fullArgsText.trim();

        // Sem argumento: usa o texto/caption da mensagem marcada (se houver)
        if (!q) {
            try {
                const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted) q = (utils.getMessageText(quoted) || '').trim();
            } catch (_) {}
        }

        if (!q) return await safeReact(react, sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);

        // parse lang trailing token: !play <query> [pt|original|en...] default pt
        const parsedQuery = parseLangFromQuery(q);
        const effectiveLang = parsedQuery.lang; // null = original, 'pt' = português
        q = parsedQuery.query;
        if (!q) return await safeReact(react, sock, m, '❌', lastBotResponse, GLOBAL_COOLDOWN);

        let currentBotResponse = await safeReact(react, sock, m, '🔎', lastBotResponse, GLOBAL_COOLDOWN);
        plog(`busca: "${q.slice(0, 80)}" em ${from}`);

        try {
            let video;
            try {
                video = (await yts(q)).videos[0];
            } catch (searchErr) {
                plog(`⚠️ yt-search falhou (${String(searchErr.message).slice(0, 120)}) — resolvendo busca via yt-dlp`);
                video = await searchViaYtDlp(q);
            }

            if (!video) {
                try { await live().sendMessage(from, { text: '❌ Nenhum vídeo encontrado.' }, { quoted: m }); }
                catch (sendErr) { pwarn(`aviso 'nenhum vídeo' não enviado: ${sendErr?.message || sendErr}`); }
                return await safeReactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            const safeTitle = String(video.title || 'sem título').trim() || 'sem título';
            const duration = parseDurationToSeconds(video.seconds ?? video.duration);
            const maxSeconds = getMaxDurationSeconds();
            if (duration > maxSeconds) {
                try {
                    await live().sendMessage(from, {
                        text: `⏱️ *Limite de duração excedido!*\n\n📌 O *!play* baixa no máximo *${formatDuration(maxSeconds)}* (${maxSeconds}s).\n🎵 *Vídeo:* ${safeTitle}\n⏰ *Duração:* ${formatDuration(duration)}\n\n💡 Para vídeos longos, use *!d <link>* e baixe apenas o trecho que quiser em outro app.\n⚙️ _Limite configurável:_ \`!set maxMediaDurationSeconds <segundos>\``
                    }, { quoted: m });
                } catch (sendErr) { pwarn(`aviso 'limite duração' não enviado: ${sendErr?.message || sendErr}`); }
                return await safeReactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            }

            currentBotResponse = await safeReact(react, sock, m, '⬇️', currentBotResponse, GLOBAL_COOLDOWN);

            const tempName = `music_${crypto.randomBytes(4).toString('hex')}.mp3`;
            const tempDir = path.join(process.cwd(), 'temp');
            const outPath = path.join(tempDir, tempName);

            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            console.log(`${PTAG} Baixando: ${safeTitle} (${formatDuration(duration)})`);

            const hasCookies = fs.existsSync(cookiesPath);
            // tenta yt-dlp com cookies/user-agent (igual download.js) + fallback BTCH
            let downloaded = false;
            let lastError = '';

            try {
                await enqueueDownload(() => new Promise((resolve, reject) => {
                    const ytLang = effectiveLang || null;
                    const extractorArgs = ytLang ? `youtube:player_client=android,web;lang=${ytLang}` : 'youtube:player_client=android,web';
                    const formatSel = effectiveLang ? `bestaudio[language^=${effectiveLang}]/bestaudio/best` : 'bestaudio/best';
                    const args = [
                        '--no-warnings',
                        '--no-check-certificates',
                        '--retries', '5',
                        '--fragment-retries', '5',
                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        '--extractor-args', extractorArgs,
                        '--extract-audio',
                        '--audio-format', 'mp3',
                        '--audio-quality', '128K',
                        '-f', formatSel,
                        '--no-playlist',
                        '--output', outPath,
                        ...(hasCookies ? ['--cookies', cookiesPath] : []),
                        video.url
                    ];
                    const proc = spawn('yt-dlp', args, { windowsHide: true });

                    let stderr = '';
                    let timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} reject(new Error('yt-dlp timeout 180s')); }, 180000);
                    let reactTimer = setTimeout(async () => {
                        try { currentBotResponse = await safeReact(react, sock, m, '🔄', currentBotResponse, GLOBAL_COOLDOWN); } catch (_) {}
                    }, 5000);
                    proc.stderr.on('data', (d) => { stderr += d.toString(); });
                    proc.on('error', (err) => {
                        clearTimeout(timer); clearTimeout(reactTimer);
                        console.error(`❌ [YT-DLP] Erro: ${err.message}`);
                        reject(err);
                    });
                    proc.on('close', (code) => {
                        clearTimeout(timer); clearTimeout(reactTimer);
                        if (code === 0) resolve();
                        else reject(new Error(`yt-dlp exit code ${code}: ${stderr.slice(0, 300)}`));
                    });
                }));
                try { downloaded = fs.existsSync(outPath) && fs.statSync(outPath).size > 1024; } catch (_) { downloaded = false; }
            } catch (e) {
                lastError = e.message;
                plog(`⚠️ yt-dlp falhou: ${lastError} — tentando fallback API...`);
            }

            // Fallback: API btch-downloader (funciona mesmo com IP bloqueado pelo YouTube)
            if (!downloaded) {
                try { if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (_) {} } catch (_) {}
                try {
                    const apiUrl = `https://backend1.tioo.eu.org/youtube?url=${encodeURIComponent(video.url)}`;
                    const res = await axios.get(apiUrl, {
                        headers: { 'User-Agent': 'btch/6.0.36' },
                        timeout: 30000,
                        maxContentLength: 2 * 1024 * 1024
                    });
                    const mp3Url = res.data?.mp3 || res.data?.result?.mp3 || res.data?.audio;
                    if (!mp3Url) throw new Error('API sem mp3');
                    if (!/^https?:\/\//i.test(mp3Url)) throw new Error('URL fallback inválida');
                    plog(`🎵 fallback BTCH: ${mp3Url.slice(0, 80)}...`);
                    const writer = fs.createWriteStream(outPath);
                    const dl = await axios({ url: mp3Url, method: 'GET', responseType: 'stream', timeout: 120000, maxContentLength: 100*1024*1024, maxBodyLength: 100*1024*1024 });
                    let total = 0;
                    dl.data.on('data', c => { total += c.length; if (total > 100*1024*1024) { try { dl.data.destroy(); writer.destroy(); } catch (_) {} } });
                    dl.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                        dl.data.on('error', reject);
                    });
                    try { downloaded = fs.existsSync(outPath) && fs.statSync(outPath).size > 1024; } catch (_) { downloaded = false; }
                    if (!downloaded) throw new Error('fallback não gerou arquivo');
                } catch (fbErr) {
                    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
                    throw new Error(lastError ? `${lastError} | fallback: ${fbErr.message}` : fbErr.message);
                }
            }

            if (fs.existsSync(outPath)) {
                try { if (fs.statSync(outPath).size < 1024) throw new Error('Arquivo muito pequeno'); } catch (e) { throw new Error('Arquivo não foi gerado: ' + e.message); }
                // Áudio só com o contexto do canal (sem card do YouTube):
                // card + canal juntos o WhatsApp comum descarta (só o Business mostra).
                // Capa 21:9 com infos da música (estilo !menu) antes do áudio.
                // É opcional: se falhar, segue direto pro áudio.
                try {
                    const { generateMusicCover, fetchThumbRaw } = require('../services/musicCover');
                    const { getChannelConfig: _getChannelCfg } = require('../services/channelPromo');
                    const thumbRaw = await fetchThumbRaw(video).catch(() => null);
                    let _theme = null;
                    try {
                        const { getTheme } = require('../services/themes');
                        const _tid = typeof utils.getThemeForJid === 'function' ? utils.getThemeForJid(from) : 'default';
                        _theme = getTheme(_tid);
                    } catch (_) { _theme = null; }
                    const cover = await generateMusicCover({
                        title: safeTitle,
                        duration: formatDuration(duration),
                        source: 'YouTube',
                        channelName: _getChannelCfg(config).name,
                        botName: config?.botName || 'Bot',
                        thumbRaw,
                        theme: _theme,
                    });
                    if (cover && cover.length > 1024) {
                        const coverCaption = `🎵 *${String(safeTitle).slice(0, 80)}*\n⏱️ ${formatDuration(duration)} • ▶️ YouTube`;
                        await enqueueSend(() => sendMessageSafe(live(), from,
                            withChannelContext({ image: cover, caption: coverCaption }, config),
                            { sendOptions: { quoted: m }, maxRetries: 2, baseDelayMs: 5000 }));
                    }
                } catch (_) {}
                // Nome do arquivo: só a música (as infos já vão na capa).
                const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
                const musicTitle = cleanName(video.title || 'audio').slice(0, 60) || 'audio';
                const audioPayload = withChannelContext({
                    audio: { url: outPath },
                    mimetype: 'audio/mp4',
                    fileName: musicTitle + '.mp3',
                }, config);
                const sent = await sendAudioResilient(audioPayload);
                try {
                    const sentId = sent?.key?.id || sent?.id || null;
                    if (sentId && isSub) {
                        try { require('../services/subSessions').trackSubSentId(sentId); } catch (_) {}
                        plog(`enviado: "${safeTitle.slice(0, 60)}" em ${from} id=${String(sentId).slice(-8)}`);
                    } else {
                        plog(`enviado: "${safeTitle.slice(0, 60)}" em ${from}`);
                    }
                } catch (_) { plog(`enviado: "${safeTitle.slice(0, 60)}" em ${from}`); }

                try { fs.unlinkSync(outPath); } catch (_) {}
                currentBotResponse = await safeReactStatus(sock, m, from, true, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN);
            } else {
                throw new Error('Arquivo não foi gerado');
            }
        } catch (e) {
            const isConnClosed = e?.output?.statusCode === 428 || String(e?.message || '').includes('Connection Closed') || String(e?.message || '').includes('Precondition Required');
            if (isConnClosed) {
                pwarn(`conexão fechada (428) — abortando sem responder`);
                try { if (typeof outPath !== 'undefined' && outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
                return currentBotResponse;
            }
            try { if (typeof outPath !== 'undefined' && outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
            console.error(`${PTAG} Falha geral:`, e);
            const is403 = e.message.includes('403') || e.message.includes('Forbidden');
            const hint = is403
                ? '\n\n💡 *YouTube bloqueou seu IP (403 Forbidden).* Soluções:\n1. Crie `cookies.txt` na raiz (extensão "Get cookies.txt" logado no YouTube)\n2. Ou use `!dl <link>` que já tem fallback automático'
                : '';
            try { await live().sendMessage(from, { text: `❌ Falha ao baixar áudio.${hint}\n\n\`${sanitizeUserText(String(e.message || e).slice(0, 200))}\`` }, { quoted: m }); } catch (sendErr) {
                pwarn(`texto de erro não enviado (socket instável?): ${sendErr?.message || sendErr}`);
                if (sendErr?.output?.statusCode !== 428 && !String(sendErr?.message || '').includes('Connection Closed')) throw sendErr;
            }
            try { currentBotResponse = await safeReactStatus(sock, m, from, false, '✅', '❌', currentBotResponse, GLOBAL_COOLDOWN); } catch (_) {}
        }

        return currentBotResponse;
    }
};
