const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg');

const piperDir = path.join(process.cwd(), 'bin', 'piper');
const isWindows = process.platform === 'win32';
const piperExe = path.join(piperDir, isWindows ? 'piper.exe' : 'piper-linux');
const modelsDir = path.join(process.cwd(), 'models', 'tts');
const defaultModel = path.join(modelsDir, 'pt_BR-cadu-medium.onnx');

/**
 * Converte texto em áudio usando Piper TTS (Offline)
 * @param {string} text Texto a ser convertido
 * @param {string} modelPath Caminho para o modelo .onnx
 * @returns {Promise<string>} Caminho para o arquivo .opus gerado
 */
async function synthesize(text, modelPath = defaultModel) {
    if (!fs.existsSync(piperExe)) {
        throw new Error(`Executável do Piper não encontrado em ${piperExe}. Execute o setup primeiro.`);
    }

    // Garantir permissão de execução no Linux
    if (!isWindows) {
        try {
            fs.chmodSync(piperExe, 0o755);
        } catch (e) {
            console.error('Erro ao dar permissão ao Piper:', e.message);
        }
    }

    if (!fs.existsSync(modelPath)) {
        throw new Error(`Modelo de voz não encontrado em ${modelPath}`);
    }

    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const id = crypto.randomBytes(4).toString('hex');
    const wavPath = path.join(tempDir, `tts_${id}.wav`);
    const opusPath = path.join(tempDir, `tts_${id}.opus`);

    const espeakData = path.join(piperDir, 'espeak-ng-data');

    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        if (!isWindows) {
            env.LD_LIBRARY_PATH = piperDir;
        }

        const piper = spawn(piperExe, [
            '--model', modelPath,
            '--output_file', wavPath,
            '--espeak_data', espeakData
        ], { env, windowsHide: true });

        if (text.length > 3000) text = text.slice(0, 3000);
        piper.stdin.write(text);
        piper.stdin.end();

        let killed = false;
        const timeout = setTimeout(() => { killed = true; try { piper.kill('SIGKILL'); } catch (_) {} }, 30000);

        piper.on('close', async (code) => {
            clearTimeout(timeout);
            if (killed) { try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {} return reject(new Error('Piper timeout 30s')); }
            if (code === 0 && fs.existsSync(wavPath)) {
                try {
                    // Converter para OPUS (encapsulado em OGG) para WhatsApp
                    await new Promise((res, rej) => {
                        let cmd = null;
                        let to = setTimeout(() => { try { if (cmd && typeof cmd.kill === 'function') cmd.kill('SIGKILL'); } catch (_) {} rej(new Error('ffmpeg opus timeout 30s')); }, 30000);
                        cmd = ffmpeg(wavPath)
                            .audioCodec('libopus')
                            .outputOptions([
                                '-b:a 48k',
                                '-vbr on',
                                '-compression_level 10'
                            ])
                            .toFormat('ogg')
                            .on('end', () => { clearTimeout(to); res(); })
                            .on('error', (e) => { clearTimeout(to); rej(e); })
                            .save(opusPath);
                    });
                    
                    try { fs.unlinkSync(wavPath); } catch (_) {}
                    resolve(opusPath);
                } catch (err) {
                    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {}
                    try { if (fs.existsSync(opusPath)) fs.unlinkSync(opusPath); } catch (_) {}
                    reject(new Error(`Erro na conversão para Opus: ${err.message}`));
                }
            } else {
                try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {}
                reject(new Error(`Piper finalizou com código ${code}`));
            }
        });

        piper.on('error', (err) => {
            clearTimeout(timeout);
            try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {}
            reject(err);
        });
    });
}

module.exports = { synthesize };
