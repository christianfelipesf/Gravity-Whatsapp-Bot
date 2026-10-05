const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('../services/ffmpeg');
const sharp = require('sharp');
const { Image } = require('node-webpmux');
const { tempDir } = require('./db');

async function addMetadata(buffer, pack, author, originalBuffer = null) {
    // garante pack/author nunca vazios (evita sticker sem info - bug imagem vs vídeo)
    const safePack = (pack && String(pack).trim()) ? String(pack).trim().slice(0,30) : 'Usuário';
    const safeAuthor = (author && String(author).trim()) ? String(author).trim().slice(0,30) : 'Bot';
    try {
        const img = new Image();
        await img.load(buffer);
        const payload = {
            "sticker-pack-id": `bot-${crypto.randomBytes(4).toString('hex')}`,
            "sticker-pack-name": safePack,
            "sticker-pack-publisher": safeAuthor,
            "emojis": ["✅"]
        };
        // embedding opcional do original para !toimg perfeito - limitado para não estourar exif e não quebrar pack/author no WhatsApp
        // 66KB original gerava exif 89KB e WhatsApp não exibia pack/author. Agora só até 25KB / 50KB total.
        if (originalBuffer && Buffer.isBuffer(originalBuffer) && originalBuffer.length > 64 && originalBuffer.length < 25 * 1024) {
            try {
                // só embutir se não estourar 50KB total (webp + exif) - mantém exif pequeno para WhatsApp exibir pack/author
                const b64 = originalBuffer.toString('base64');
                const testPayload = { ...payload, data: b64 };
                const testLen = Buffer.byteLength(JSON.stringify(testPayload), 'utf-8') + 22 + buffer.length;
                if (testLen < 50 * 1024) {
                    payload.data = b64;
                    // guardar mime para decodificação fiel (opcional)
                    try {
                        const meta = await sharp(originalBuffer, { failOn: 'none' }).metadata().catch(()=>null);
                        if (meta && meta.format) payload.dataMime = `image/${meta.format}`;
                    } catch(_) {}
                    console.log(`[STICKER-LOG] addMetadata: embutindo original ${originalBuffer.length}B base64=${b64.length} testLen=${testLen}B`);
                } else {
                    console.log(`[STICKER-LOG] addMetadata: original ${originalBuffer.length}B não embutido (testLen ${testLen}B >50KB)`);
                }
            } catch(e) { console.warn(`⚠️ [METADATA] falha ao preparar embedding: ${e.message}`); }
        }
        const exif = Buffer.concat([
            Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]),
            Buffer.from(JSON.stringify(payload), 'utf-8')
        ]);
        exif.writeUInt32LE(exif.length - 22, 14);
        img.exif = exif;
        const out = await img.save(null);
        if (payload.data) console.log(`[STICKER-LOG] addMetadata: final com original ${out.length}B (webp ${buffer.length}B + exif ${exif.length}B)`);
        return out;
    } catch (e) {
        console.error('❌ [METADATA] Falha:', e.message);
        return buffer;
    }
}

const STICKER_IMG_MAX = 10 * 1024 * 1024;
const STICKER_VIDEO_MAX = 50 * 1024 * 1024;

function _killFfmpeg(cmd) {
    try { if (cmd && typeof cmd.kill === 'function') cmd.kill('SIGKILL'); } catch (_) {}
}

async function shrinkImageBuffer(buffer, tempId) {
    // sharp path: sem ffmpeg, muito mais rápido e sem disco extra
    try {
        const out = await sharp(buffer, { failOn: 'none' })
            .rotate()
            .resize({ width: 1600, withoutEnlargement: true, fit: 'inside', kernel: sharp.kernel.lanczos3 })
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer();
        if (out.length < 1024) throw new Error('compressão gerou arquivo vazio');
        console.log(`[STICKER-LOG] shrinkImageBuffer sharp ${buffer.length} -> ${out.length} bytes`);
        return out;
    } catch (e) {
        // fallback ffmpeg legado se sharp falhar (ex: formato exótico)
        console.warn(`⚠️ [STICKER] shrink sharp falhou (${e.message}) — fallback ffmpeg`);
        const inputPath = path.join(tempDir, `stk_shrink_in_${tempId}.bin`);
        const outputPath = path.join(tempDir, `stk_shrink_out_${tempId}.jpg`);
        fs.writeFileSync(inputPath, buffer);
        try {
            await new Promise((resolve, reject) => {
                let cmd = null;
                const to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg timeout 60s')); }, 60000);
                cmd = ffmpeg(inputPath)
                    .outputOptions(['-vf', "scale='min(1600,iw)':-2", '-q:v', '5'])
                    .toFormat('mjpeg')
                    .on('end', () => { clearTimeout(to); resolve(); })
                    .on('error', (err) => { clearTimeout(to); reject(err); })
                    .save(outputPath);
            });
            const out = fs.readFileSync(outputPath);
            if (out.length < 1024) throw new Error('compressão gerou arquivo vazio');
            return out;
        } finally {
            try { fs.unlinkSync(inputPath); } catch (_) {}
            try { fs.unlinkSync(outputPath); } catch (_) {}
        }
    }
}

async function mediaToSticker(buffer, mimeType, pack, author) {
    const startTs = Date.now();
    if (!buffer || !buffer.length) throw new Error('Mídia vazia');
    const mime = (mimeType || '').toLowerCase();
    const isVideo = mime.includes('video');
    console.log(`\n[STICKER-LOG] ===== !s INICIO ===== tempId pending mime=${mime} isVideo=${isVideo} inputBytes=${buffer.length} (${(buffer.length/1024).toFixed(1)}KB)`);
    // probe rápido via sharp
    try {
        const probe = await sharp(buffer, { failOn: 'none' }).metadata().catch(()=>null);
        if (probe) console.log(`[STICKER-LOG] probe original ${probe.width}x${probe.height} mime=${mime} hasAlpha=${probe.hasAlpha}`);
    } catch(_) {}
    if (isVideo && buffer.length > STICKER_VIDEO_MAX) throw new Error('Mídia muito grande (max 50MB)');
    const tempId = crypto.randomBytes(4).toString('hex');
    console.log(`[STICKER-LOG] tempId=${tempId} pack="${pack}" author="${author}"`);
    if (!isVideo && buffer.length > STICKER_IMG_MAX) {
        console.log(`🖼️ [STICKER] imagem ${(buffer.length / 1048576).toFixed(1)}MB > 10MB — comprimindo antes de converter`);
        try {
            buffer = await shrinkImageBuffer(buffer, tempId);
        } catch (e) {
            console.error(`❌ [STICKER] compressão falhou: ${e.message}`);
            throw new Error('Mídia muito grande (max 10MB)');
        }
        if (buffer.length > STICKER_IMG_MAX) throw new Error('Mídia muito grande (max 10MB)');
    }

    // vídeo ainda usa arquivos temporários + ffmpeg
    const inputPath = path.join(tempDir, `stk_in_${tempId}${isVideo ? '.mp4' : '.bin'}`);
    const outputPath = path.join(tempDir, `stk_out_${tempId}.webp`);
    const cleanup = [inputPath, outputPath];

    try {
        if (!isVideo) {
            // --- fluxo imagem via sharp (sem cwebp, sem PNG temp) ---
            let metadata;
            try {
                metadata = await sharp(buffer, { failOn: 'none' }).metadata();
            } catch (e) {
                throw new Error(`Imagem inválida: ${e.message}`);
            }
            const origW = metadata.width || 0;
            const origH = metadata.height || 0;
            const hasAlpha = !!metadata.hasAlpha;
            console.log(`[STICKER-LOG] sharp original ${origW}x${origH} aspect=${origW && origH ? (origW/origH).toFixed(3) : 'n/a'} mime=${mime} input=${buffer.length}B hasAlpha=${hasAlpha} channels=${metadata.channels} origPixels=${origW*origH}`);

            if (origW > 3000 || origH > 3000) {
                console.error(`❌ [STICKER-IMG] Rejeitado: dimensões ${origW}x${origH} excedem limite 3000`);
                throw new Error('Imagem muito grande');
            }

            // Se imagem já é webp pequena e dentro de 512, ainda re-encoda para garantir limite 1MB e normalizar
            const MAX_SIDE = 512;
            const needResize = origW > MAX_SIDE || origH > MAX_SIDE;
            if (needResize) {
                console.log(`[STICKER-LOG] sharp vai redimensionar para caber em ${MAX_SIDE}x${MAX_SIDE} (aspect preservado)`);
            } else {
                console.log(`[STICKER-LOG] sharp mantém original ${origW}x${origH} (abaixo de MAX, sem redimensionar)`);
            }

            // Estratégia de tentativas — sharp webp com alta nitidez (effort 6, smartSubsample false preserva texto)
            // Usa buffer.length como proxy de complexidade e hasAlpha
            let imgAttempts;
            if (!hasAlpha && buffer.length < 300 * 1024) {
                imgAttempts = [
                    { quality: 92, effort: 6, smartSubsample: false },
                    { quality: 88, effort: 6, smartSubsample: false },
                    { quality: 82, effort: 6 },
                    { quality: 75, effort: 4 }
                ];
                console.log(`[STICKER-LOG] Estratégia sharp: sem alfa e input leve → q92 effort6`);
            } else if (buffer.length > 600 * 1024) {
                imgAttempts = [
                    { quality: 88, alphaQuality: 95, effort: 6, smartSubsample: false },
                    { quality: 82, alphaQuality: 90, effort: 6 },
                    { quality: 75, effort: 4 },
                    { quality: 65, effort: 4 }
                ];
                console.log(`[STICKER-LOG] Estratégia sharp: input pesado ${buffer.length}B → começa em q88`);
            } else {
                // caso padrão: imagens médias com/sem alfa — prioriza nitidez de texto/borda
                imgAttempts = [
                    { quality: 90, alphaQuality: 100, effort: 6, smartSubsample: false },
                    { quality: 88, alphaQuality: 100, effort: 6, smartSubsample: false },
                    { quality: 85, alphaQuality: 95, effort: 6 },
                    { quality: 80, effort: 4 },
                    { quality: 72, effort: 4 }
                ];
                console.log(`[STICKER-LOG] Estratégia sharp: padrão q90 alfa100 effort6`);
            }

            let rawWebp = null;
            let lastImgErr = null;
            let chosenAttempt = null;

            for (let i = 0; i < imgAttempts.length; i++) {
                const opts = imgAttempts[i];
                console.log(`[STICKER-LOG] tentativa imagem sharp ${i+1}/${imgAttempts.length}: q=${opts.quality} alpha_q=${opts.alphaQuality ?? 'auto'} effort=${opts.effort} | orig=${origW}x${origH} hasAlpha=${hasAlpha} input=${buffer.length}B`);
                try {
                    let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
                    if (needResize) {
                        pipeline = pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true, kernel: sharp.kernel.lanczos3 });
                    }
                    if (hasAlpha) pipeline = pipeline.ensureAlpha();
                    // sharp webp: quality, alphaQuality, effort (0-6), smartSubsample
                    const webpOpts = {
                        quality: opts.quality,
                        effort: opts.effort ?? 4,
                        smartSubsample: !!opts.smartSubsample,
                    };
                    if (opts.alphaQuality != null) webpOpts.alphaQuality = opts.alphaQuality;
                    // lossless false por padrão
                    rawWebp = await pipeline.webp(webpOpts).toBuffer();
                    console.log(`[STICKER-LOG] tentativa ${i+1} gerou ${rawWebp.length}B header=${rawWebp.slice(0,4).toString()} hex=${rawWebp.slice(0,16).toString('hex').slice(0,32)}`);
                    if (rawWebp.length < 64) throw new Error('WebP vazio (<64B)');
                    if (rawWebp.length > 950 * 1024 && i < imgAttempts.length - 1) {
                        console.warn(`⚠️ [STICKER-IMG] tentativa ${i+1} ficou ${rawWebp.length}B >950KB — reduzindo qualidade`);
                        continue;
                    }
                    console.log(`[STICKER-LOG] tentativa imagem ${i+1} OK ${rawWebp.length}B (${(rawWebp.length/1024).toFixed(1)}KB)`);
                    chosenAttempt = i+1;
                    break;
                } catch (e) {
                    lastImgErr = e;
                    console.warn(`⚠️ [STICKER-IMG] tentativa ${i+1} FALHOU | q=${opts.quality} | motivo="${e.message}" | stack="${e.stack?.split('\n')[1]?.trim() || ''}" | orig=${origW}x${origH}`);
                }
            }
            if (!rawWebp) {
                console.error(`❌ [STICKER-IMG] Todas ${imgAttempts.length} tentativas falharam | tempId=${tempId} | orig=${origW}x${origH} hasAlpha=${hasAlpha} mime=${mime} | último erro="${lastImgErr?.message}"`);
                throw lastImgErr || new Error('Falha sharp após todas tentativas');
            }
            try { console.log(`[STICKER-LOG] WebP sharp gerado ${rawWebp.length} bytes (${(rawWebp.length/1024).toFixed(1)}KB) header=${rawWebp.slice(0,4).toString()} tentativa=${chosenAttempt}`); } catch(_){}

            console.log(`[STICKER-LOG] raw WebP antes de addMetadata ${rawWebp.length} bytes`);
            try {
                const chk = rawWebp.slice(0, 100).toString('hex').slice(0,80);
                console.log(`[STICKER-LOG] raw WebP head hex=${chk}...`);
            } catch(_){}
            // tenta embutir original para !toimg perfeito se couber em 1MB (só <300KB)
            const originalForEmbedding = buffer;
            const result = await addMetadata(rawWebp, pack, author, originalForEmbedding);
            if (!result || result.length < 64) {
                throw new Error('Falha ao injetar metadados do sticker');
            }
            // imagem pequena (ex: 100x100 cor sólida) pode gerar <512B válido — não rejeitar
            try {
                const imgProbe = new Image(); await imgProbe.load(result);
                const exifLen = imgProbe.exif ? imgProbe.exif.length : 0;
                const exifPreview = imgProbe.exif ? imgProbe.exif.slice(0,120).toString('utf-8').replace(/\0/g,'.') : 'sem exif';
                console.log(`[STICKER-LOG] ===== !s FIM ===== tempId=${tempId} final ${result.length} bytes (${(result.length/1024).toFixed(1)}KB) exifLen=${exifLen} exifPreview="${exifPreview.slice(0,100)}" dur=${Date.now()-startTs}ms`);
                console.log(`[STICKER-LOG] Header final RIFF=${result.slice(0,4).toString()} WEBP=${result.slice(8,12).toString()} | sharp q${imgAttempts[chosenAttempt-1].quality} alfa${imgAttempts[chosenAttempt-1].alphaQuality ?? 'auto'}, original ${rawWebp.length} -> final ${result.length}`);
            } catch(e) {
                console.log(`[STICKER-LOG] ===== !s FIM (probe falhou) ===== final ${result.length} bytes dur=${Date.now()-startTs}ms err=${e.message}`);
            }
            return result;
        } else {
            fs.writeFileSync(inputPath, buffer);
            let stats; try { stats = fs.statSync(inputPath); } catch (_) { throw new Error('Vídeo vazio'); }
            if (!stats.size) throw new Error('Vídeo vazio');

            // Tentativas proativas: reduz tempo/fps/qualidade até caber em <1MB e ffmpeg não falhar
            const videoAttempts = [
                { t: 6, fps: 10, q: 78, preset: 'default' },
                { t: 4, fps: 10, q: 72, preset: 'default' },
                { t: 3, fps: 8,  q: 65, preset: 'default' },
                { t: 2, fps: 8,  q: 55, preset: 'default' }
            ];
            let attemptOk = false;
            let lastVidErr = null;
            for (let i = 0; i < videoAttempts.length; i++) {
                const a = videoAttempts[i];
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                console.log(`[STICKER-LOG] tentativa video ${i+1}/${videoAttempts.length}: t=${a.t}s fps=${a.fps} q=${a.q}`);
                try {
                    await new Promise((resolve, reject) => {
                        let cmd = null;
                        let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg timeout 30s')); }, 30000);
                        cmd = ffmpeg(inputPath)
                            .inputOptions([`-t ${a.t}`])
                            .outputOptions([
                                '-vf', `scale=512:512:flags=lanczos,fps=${a.fps},setsar=1`,
                                '-c:v', 'libwebp',
                                '-lossless', '0',
                                '-q:v', String(a.q),
                                '-preset', a.preset,
                                '-loop', '0',
                                '-an',
                                '-fps_mode', 'vfr'
                            ])
                            .toFormat('webp')
                            .on('end', () => { clearTimeout(to); resolve(); })
                            .on('error', (e) => { clearTimeout(to); reject(e); })
                            .save(outputPath);
                    });
                    let outStat; try { outStat = fs.statSync(outputPath); } catch (_) { throw new Error('Vídeo gerou WebP vazio/inválido'); }
                    if (outStat.size < 512) throw new Error('Vídeo gerou WebP vazio/inválido');
                    let header; try { header = fs.readFileSync(outputPath).slice(0, 12); } catch (_) { throw new Error('Vídeo gerou arquivo não-WebP'); }
                    if (header.slice(0, 4).toString() !== 'RIFF' || header.slice(8, 12).toString() !== 'WEBP') throw new Error('Vídeo gerou arquivo não-WebP');
                    // Se passou de 900KB, tenta próxima tentativa mais leve (evita estourar 1MB após exif)
                    if (outStat.size > 950 * 1024 && i < videoAttempts.length - 1) {
                        console.log(`[STICKER-LOG] tentativa ${i+1} ficou ${outStat.size} bytes >950KB — tentando menor qualidade/duração`);
                        continue;
                    }
                    console.log(`[STICKER-LOG] tentativa ${i+1} OK ${outStat.size} bytes`);
                    attemptOk = true;
                    break;
                } catch (e) {
                    lastVidErr = e;
                    console.warn(`⚠️ [STICKER] tentativa ${i+1} falhou: ${e.message} — tentando próxima redução`);
                }
            }
            if (!attemptOk) throw lastVidErr || new Error('Vídeo gerou WebP vazio/inválido após todas tentativas');

            const rawWebp = fs.readFileSync(outputPath);
            console.log(`[STICKER-LOG] raw WebP antes de addMetadata ${rawWebp.length} bytes`);
            try {
                const chk = rawWebp.slice(0, 100).toString('hex').slice(0,80);
                console.log(`[STICKER-LOG] raw WebP head hex=${chk}...`);
            } catch(_){}
            const result = await addMetadata(rawWebp, pack, author);
            if (!result || result.length < 512) {
                throw new Error('Falha ao injetar metadados do sticker');
            }
            try {
                const imgProbe = new Image(); await imgProbe.load(result);
                const exifLen = imgProbe.exif ? imgProbe.exif.length : 0;
                const exifPreview = imgProbe.exif ? imgProbe.exif.slice(0,120).toString('utf-8').replace(/\0/g,'.') : 'sem exif';
                console.log(`[STICKER-LOG] ===== !s FIM ===== tempId=${tempId} final ${result.length} bytes (${(result.length/1024).toFixed(1)}KB) exifLen=${exifLen} exifPreview="${exifPreview.slice(0,100)}" dur=${Date.now()-startTs}ms`);
                console.log(`[STICKER-LOG] Header final RIFF=${result.slice(0,4).toString()} WEBP=${result.slice(8,12).toString()} | aspect preservado, sharp+ffmpeg, original ${rawWebp.length} -> final ${result.length}`);
            } catch(e) {
                console.log(`[STICKER-LOG] ===== !s FIM (probe falhou) ===== final ${result.length} bytes dur=${Date.now()-startTs}ms err=${e.message}`);
            }
            return result;
        }

    } catch (error) {
        console.error(`❌ [CONVERSÃO] Falha geral tempId=${tempId} isVideo=${isVideo} mime=${mime} input=${buffer?.length || 0}B | motivo="${error.message}" | stack="${error.stack?.split('\n')[1]?.trim() || ''}"`);
        if (isVideo && fs.existsSync(inputPath)) {
            const firstFrameWebp = path.join(tempDir, `stk_fb_${tempId}.webp`);
            cleanup.push(firstFrameWebp);
            try {
                await new Promise((resolve, reject) => {
                    let cmd = null;
                    let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg fallback timeout 30s')); }, 30000);
                    cmd = ffmpeg(inputPath)
                        .outputOptions([
                            '-vframes', '1',
                            '-vf', 'scale=512:512:flags=lanczos,setsar=1',
                            '-c:v', 'libwebp',
                            '-lossless', '0',
                            '-q:v', '75',
                            '-preset', 'default',
                            '-loop', '0',
                            '-an'
                        ])
                        .toFormat('webp')
                        .on('end', () => { clearTimeout(to); resolve(); })
                        .on('error', (e) => { clearTimeout(to); reject(e); })
                        .save(firstFrameWebp);
                });
                let fbOk = false; try { fbOk = fs.existsSync(firstFrameWebp) && fs.statSync(firstFrameWebp).size >= 64; } catch (_) {}
                if (fbOk) {
                    const fallback = await addMetadata(fs.readFileSync(firstFrameWebp), pack, author);
                    if (fallback && fallback.length >= 64) return fallback;
                }
            } catch (fbErr) {
                console.error('❌ [CONVERSÃO] Fallback estático falhou:', fbErr.message);
            }
        }
        throw error;
    } finally {
        cleanup.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
    }
}

async function convertAnimatedWebpDirect(inputPath, outputPath) {
    await new Promise((resolve, reject) => {
        let cmd = null;
        let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg stickerToMedia timeout 30s')); }, 30000);
        cmd = ffmpeg(inputPath)
            .outputOptions(['-pix_fmt yuv420p', '-c:v libx264', '-crf 18', '-preset slow', '-movflags +faststart', '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'])
            .toFormat('mp4')
            .on('end', () => { clearTimeout(to); resolve(); })
            .on('error', (e) => { clearTimeout(to); reject(e); })
            .save(outputPath);
    });
}

async function convertAnimatedWebpFrames(buffer, outputPath) {
    const tempId = crypto.randomBytes(4).toString('hex');
    const frameDir = path.join(tempDir, `stk_frames_${tempId}`);
    const written = [];
    try {
        fs.mkdirSync(frameDir, { recursive: true });
        const img = new Image();
        await img.load(buffer);
        if (!img.frames || !img.frames.length) throw new Error('WebP animado sem frames');
        const bufs = await img.demux({ buffers: true });
        if (!bufs.length) throw new Error('WebP animado sem frames');
        const delays = img.frames.map(f => f.delay || 100);
        const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
        const fps = Math.min(30, Math.max(1, Math.round(1000 / avgDelay)));
        for (let i = 0; i < bufs.length; i++) {
            const p = path.join(frameDir, `f_${i}.webp`);
            fs.writeFileSync(p, bufs[i]);
            written.push(p);
        }
        await new Promise((resolve, reject) => {
            let cmd = null;
            let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg fallback timeout 30s')); }, 30000);
            cmd = ffmpeg(path.join(frameDir, 'f_%d.webp'))
                .inputOptions(['-framerate', String(fps)])
                .outputOptions(['-pix_fmt yuv420p', '-c:v libx264', '-crf 18', '-preset slow', '-movflags +faststart', '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'])
                .toFormat('mp4')
                .on('end', () => { clearTimeout(to); resolve(); })
                .on('error', (e) => { clearTimeout(to); reject(e); })
                .save(outputPath);
        });
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('Vídeo gerado vazio');
    } finally {
        written.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
        try { fs.rmdirSync(frameDir); } catch (_) {}
    }
}

async function stickerToMedia(buffer, isAnimated = false) {
    const startTs2 = Date.now();
    // auto-corrige flag isAnimated (Baileys/sticker-maker as vezes envia false pra animado)
    let effectiveAnimated = !!isAnimated;
    try {
        if (!effectiveAnimated && buffer && buffer.includes(Buffer.from('ANIM'))) effectiveAnimated = true;
    } catch (_) {}
    if (effectiveAnimated !== !!isAnimated) {
        console.log(`[STICKER-LOG] isAnimated corrigido: ${isAnimated} -> ${effectiveAnimated} (detectado ANIM chunk)`);
        isAnimated = effectiveAnimated;
    }
    console.log(`\n[STICKER-LOG] ===== !toimg INICIO ===== isAnimated=${isAnimated} (orig=${!!effectiveAnimated}) inputBytes=${buffer?.length || 0} (${buffer? (buffer.length/1024).toFixed(1)+'KB':''}) header=${buffer?.slice(0,4).toString() || ''} WEBP=${buffer?.slice(8,12).toString() || ''}`);
    // tenta inspecionar EXIF/WebP chunks para ver se tem original embutido (como outros bots fazem)
    let _exifJson = null;
    try {
        const probeImg = new Image(); await probeImg.load(buffer);
        const exifLen = probeImg.exif ? probeImg.exif.length : 0;
        const hasExif = !!probeImg.exif;
        let exifPreview='';
        if (hasExif) {
            try { exifPreview = probeImg.exif.slice(0,300).toString('utf-8').replace(/\0/g,'.').slice(0,200); } catch(_){}
            try { const raw = probeImg.exif.slice(22).toString('utf-8'); _exifJson = JSON.parse(raw); } catch(_){ }
        }
        console.log(`[STICKER-LOG] probe WebP exifLen=${exifLen} hasExif=${hasExif} preview="${exifPreview}" jsonKeys=${_exifJson? Object.keys(_exifJson).join(','): 'n/a'}`);
        if (_exifJson && _exifJson.data) console.log(`[STICKER-LOG] ATENCAO: sticker contém data embutida len=${String(_exifJson.data).length} (original embutido detectado!)`);
        // também loga RIFF chunks
        let off=12; let chunks=[];
        while(off+8 < buffer.length && chunks.length<6){ const id=buffer.slice(off,off+4).toString(); const sz=buffer.readUInt32LE(off+4); chunks.push(`${id}:${sz}`); off+=8+sz + (sz%2); }
        console.log(`[STICKER-LOG] RIFF chunks: ${chunks.join(' | ')}`);
        console.log(`[STICKER-LOG] Se for sticker do seu bot: exifLen deve ser ~150-200 bytes (só pack/author) ou >10KB se com original embutido.`);
    } catch(e){ console.log(`[STICKER-LOG] probe WebP falhou: ${e.message}`); }
    // restauração perfeita: se sticker tem original embutido em exif.data, devolver sem recompressão
    if (_exifJson && _exifJson.data) {
        try {
            const embedded = Buffer.from(String(_exifJson.data), 'base64');
            if (embedded && embedded.length > 64 && embedded.length < 10 * 1024 * 1024) {
                // tenta inferir mime via header/sharp
                let mime = 'image/jpeg';
                let ext = 'jpg';
                try {
                    const m = await sharp(embedded, { failOn: 'none' }).metadata().catch(()=>null);
                    if (m && m.format) {
                        if (m.format === 'png') { mime = 'image/png'; ext = 'png'; }
                        else if (m.format === 'webp') { mime = 'image/webp'; ext = 'webp'; }
                        else if (m.format === 'jpeg' || m.format === 'jpg') { mime = 'image/jpeg'; ext = 'jpg'; }
                    } else {
                        // fallback header
                        if (embedded[0]===0x89 && embedded[1]===0x50) { mime='image/png'; ext='png'; }
                        else if (embedded[0]===0xFF && embedded[1]===0xD8) { mime='image/jpeg'; ext='jpg'; }
                    }
                } catch(_) {}
                console.log(`[STICKER-LOG] ===== !toimg FIM (restauração perfeita) ===== original embutido ${embedded.length} bytes mime=${mime} dur=${Date.now()-startTs2}ms`);
                return { buffer: embedded, mime, ext };
            }
        } catch(e) { console.warn(`⚠️ [TOIMG] falha ao extrair original embutido: ${e.message}`); }
    }
    if (!buffer || buffer.length > 10 * 1024 * 1024) throw new Error('Sticker muito grande');
    const tempId = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `stk_in_${tempId}.webp`);
    const outputPath = path.join(tempDir, `stk_out_${tempId}.${isAnimated ? 'mp4' : 'png'}`);
    try {
        fs.writeFileSync(inputPath, buffer);
        if (isAnimated) {
            try {
                await convertAnimatedWebpDirect(inputPath, outputPath);
            } catch (_) {
                await convertAnimatedWebpFrames(buffer, outputPath);
            }
        } else {
            // estático: preferir sharp (libwebp direto, sem subsampling yuv420 do ffmpeg) para maior nitidez
            let sharpOk = false;
            try {
                const pngBuf = await sharp(buffer, { failOn: 'none' }).png({ compressionLevel: 9, palette: false }).toBuffer();
                if (pngBuf && pngBuf.length > 64) {
                    fs.writeFileSync(outputPath, pngBuf);
                    sharpOk = true;
                    console.log(`[STICKER-LOG] sharp decode WEBP->PNG ${pngBuf.length} bytes (sem ffmpeg)`);
                }
            } catch (e) { console.warn(`⚠️ [TOIMG] sharp decode falhou (${e.message}) — fallback ffmpeg`); }
            if (!sharpOk) {
                // fallback ffmpeg legado
                await new Promise((resolve, reject) => {
                    let cmd = null;
                    let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg stickerToMedia timeout 30s')); }, 30000);
                    cmd = ffmpeg(inputPath)
                        .outputOptions(['-vcodec png', '-compression_level 0', '-f image2'])
                        .on('end', () => { clearTimeout(to); resolve(); })
                        .on('error', (err) => { clearTimeout(to); reject(err); })
                        .save(outputPath);
                });
            }
        }
        let outBuf; try { outBuf = fs.readFileSync(outputPath); } catch (_) { throw new Error('Falha conversão sticker'); }
        // log do resultado e tentativa de detectar dimensões reais via sharp
        try {
            if (!isAnimated) {
                const meta = await sharp(outBuf, { failOn: 'none' }).metadata().catch(()=>null);
                if (meta) console.log(`[STICKER-LOG] out PNG ${meta.width}x${meta.height} ${outBuf.length} bytes (${(outBuf.length/1024).toFixed(1)}KB)`);
                else console.log(`[STICKER-LOG] out PNG ${outBuf.length} bytes header=${outBuf.slice(0,8).toString('hex')}`);
            } else {
                console.log(`[STICKER-LOG] out MP4 ${outBuf.length} bytes header=${outBuf.slice(0,4).toString('hex')}`);
            }
            console.log(`[STICKER-LOG] ===== !toimg FIM ===== dur=${Date.now()-startTs2}ms | extração preserva dimensões nativas do WebP (aspect preservado)`);
        } catch(_){}
        return { buffer: outBuf, mime: isAnimated ? 'video/mp4' : 'image/png', ext: isAnimated ? 'mp4' : 'png' };
    } catch (err) {
        console.error('❌ [FFMPEG] Falha:', err.message);
        throw err;
    } finally {
        [inputPath, outputPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
    }
}

async function changeSpeed(buffer, mimeType, speed = 1.0, voiceEffects = true) {
    if (!buffer || buffer.length > 20 * 1024 * 1024) throw new Error('Mídia muito grande');
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('Speed inválido');
    const isVideo = mimeType.includes('video');
    const tempId = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `speed_in_${tempId}${isVideo ? '.mp4' : '.ogg'}`);
    const outputPath = path.join(tempDir, `speed_out_${tempId}${isVideo ? '.mp4' : '.opus'}`);
    try {
        fs.writeFileSync(inputPath, buffer);
        await new Promise((resolve, reject) => {
            let cmd = null;
            let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg changeSpeed timeout 30s')); }, 30000);
            let ff = ffmpeg(inputPath);
            cmd = ff;
            let audioFilter = `atempo=${speed}`;
            if (voiceEffects) {
                const rate = 44100 * speed;
                audioFilter = `asetrate=${rate},atempo=1.0`;
            }
            if (isVideo) {
                const pts = 1 / speed;
                ff.outputOptions([
                    `-filter:v setpts=${pts}*PTS`,
                    `-filter:a ${audioFilter}`,
                    '-c:v libx264',
                    '-preset fast',
                    '-c:a aac',
                    '-movflags +faststart'
                ]);
            } else {
                ff.outputOptions([
                    `-filter:a ${audioFilter}`,
                    '-c:a libopus',
                    '-b:a 48k',
                    '-vbr on',
                    '-compression_level 10'
                ]).toFormat('ogg');
            }
            ff.on('end', () => { clearTimeout(to); resolve(); }).on('error', (e) => { clearTimeout(to); reject(e); }).save(outputPath);
        });
        let out; try { out = fs.readFileSync(outputPath); } catch (_) { throw new Error('Falha changeSpeed'); }
        return out;
    } catch (e) {
        console.error('❌ [SPEED] Falha:', e.message);
        throw e;
    } finally {
        [inputPath, outputPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
    }
}

async function convertAnimatedWebpToGifDirect(inputPath, outputPath) {
    await new Promise((resolve, reject) => {
        let cmd = null;
        let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg toGif timeout 30s')); }, 30000);
        cmd = ffmpeg(inputPath)
            .outputOptions([
                '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
                '-loop', '0'
            ])
            .toFormat('gif')
            .on('end', () => { clearTimeout(to); resolve(); })
            .on('error', (e) => { clearTimeout(to); reject(e); })
            .save(outputPath);
    });
}

async function convertAnimatedWebpFramesGif(buffer, outputPath) {
    const tempId = crypto.randomBytes(4).toString('hex');
    const frameDir = path.join(tempDir, `gif_frames_${tempId}`);
    const written = [];
    try {
        fs.mkdirSync(frameDir, { recursive: true });
        const img = new Image();
        await img.load(buffer);
        if (!img.frames || !img.frames.length) throw new Error('WebP animado sem frames');
        const bufs = await img.demux({ buffers: true });
        if (!bufs.length) throw new Error('WebP animado sem frames');
        const delays = img.frames.map(f => f.delay || 100);
        const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
        const fps = Math.min(30, Math.max(1, Math.round(1000 / avgDelay)));
        for (let i = 0; i < bufs.length; i++) {
            const p = path.join(frameDir, `f_${i}.webp`);
            fs.writeFileSync(p, bufs[i]);
            written.push(p);
        }
        await new Promise((resolve, reject) => {
            let cmd = null;
            let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg fallback timeout 30s')); }, 30000);
            cmd = ffmpeg(path.join(frameDir, 'f_%d.webp'))
                .inputOptions(['-framerate', String(fps)])
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
                    '-loop', '0'
                ])
                .toFormat('gif')
                .on('end', () => { clearTimeout(to); resolve(); })
                .on('error', (e) => { clearTimeout(to); reject(e); })
                .save(outputPath);
        });
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('GIF gerado vazio');
    } finally {
        written.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
        try { fs.rmdirSync(frameDir); } catch (_) {}
    }
}

async function mediaToGif(buffer, mimeType) {
    if (!buffer || buffer.length > 20 * 1024 * 1024) throw new Error('Mídia muito grande');
    const isSticker = (mimeType || '').toLowerCase().includes('sticker');
    const tempId = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `gif_in_${tempId}${isSticker ? '.webp' : '.mp4'}`);
    const outputPath = path.join(tempDir, `gif_out_${tempId}.gif`);
    try {
        fs.writeFileSync(inputPath, buffer);
        if (isSticker) {
            try {
                await convertAnimatedWebpToGifDirect(inputPath, outputPath);
            } catch (_) {
                await convertAnimatedWebpFramesGif(buffer, outputPath);
            }
        } else {
            await new Promise((resolve, reject) => {
                let cmd = null;
                let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg toGif timeout 30s')); }, 30000);
                cmd = ffmpeg(inputPath)
                    .outputOptions([
                        '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
                        '-loop', '0'
                    ])
                    .toFormat('gif')
                    .on('end', () => { clearTimeout(to); resolve(); })
                    .on('error', (e) => { clearTimeout(to); reject(e); })
                    .save(outputPath);
            });
        }
        let out; try { out = fs.readFileSync(outputPath); } catch (_) { throw new Error('Falha conversão GIF'); }
        if (out.length < 32) throw new Error('GIF gerado vazio');
        return out;
    } catch (e) {
        console.error('❌ [TOGIF] Falha:', e.message);
        throw e;
    } finally {
        [inputPath, outputPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
    }
}

async function mediaToGifVideo(buffer, mimeType) {
    if (!buffer || buffer.length > 20 * 1024 * 1024) throw new Error('Mídia muito grande');
    const isSticker = (mimeType || '').toLowerCase().includes('sticker');
    const tempId = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `gifvid_in_${tempId}${isSticker ? '.webp' : '.mp4'}`);
    const outputPath = path.join(tempDir, `gifvid_out_${tempId}.mp4`);
    try {
        fs.writeFileSync(inputPath, buffer);
        if (isSticker) {
            try {
                await new Promise((resolve, reject) => {
                    let cmd = null;
                    let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg gifVideo timeout 30s')); }, 30000);
                    cmd = ffmpeg(inputPath)
                        .outputOptions([
                            '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=15,setsar=1',
                            '-c:v', 'libx264',
                            '-pix_fmt', 'yuv420p',
                            '-crf', '18',
                            '-preset', 'fast',
                            '-movflags', '+faststart',
                            '-an'
                        ])
                        .toFormat('mp4')
                        .on('end', () => { clearTimeout(to); resolve(); })
                        .on('error', (e) => { clearTimeout(to); reject(e); })
                        .save(outputPath);
                });
            } catch (firstErr) {
                console.warn(`⚠️ [TOGIFVIDEO] ffmpeg direto falhou (${firstErr.message}) — fallback stickerToMedia`);
                const { buffer: mp4Buffer } = await stickerToMedia(buffer, true);
                if (!mp4Buffer || mp4Buffer.length < 512) throw new Error('Fallback gerou vídeo vazio');
                fs.writeFileSync(outputPath, mp4Buffer);
            }
        } else {
            await new Promise((resolve, reject) => {
                let cmd = null;
                let to = setTimeout(() => { _killFfmpeg(cmd); reject(new Error('ffmpeg gifVideo timeout 30s')); }, 30000);
                cmd = ffmpeg(inputPath)
                    .outputOptions([
                        '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1',
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-crf', '18',
                        '-preset', 'fast',
                        '-movflags', '+faststart',
                        '-an',
                        '-t', '6'
                    ])
                    .toFormat('mp4')
                    .on('end', () => { clearTimeout(to); resolve(); })
                    .on('error', (e) => { clearTimeout(to); reject(e); })
                    .save(outputPath);
            });
        }
        let out; try { out = fs.readFileSync(outputPath); } catch (_) { throw new Error('Falha conversão GIF video'); }
        if (!out || out.length < 512) throw new Error('GIF video gerado vazio');
        return out;
    } catch (e) {
        console.error('❌ [TOGIFVIDEO] Falha:', e.message);
        throw e;
    } finally {
        [inputPath, outputPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
    }
}

module.exports = {
    addMetadata,
    mediaToSticker,
    stickerToMedia,
    changeSpeed,
    mediaToGif,
    mediaToGifVideo
};
