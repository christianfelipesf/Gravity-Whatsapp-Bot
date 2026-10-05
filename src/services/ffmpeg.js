// ffmpeg.js — wrapper mínimo compatível com o uso que o bot fazia do
// fluent-ffmpeg (pacote deprecated/arquivado). Usa spawn direto, sem deps.
// Cobre apenas a API usada em: tts.js, transcribe.js, database/sticker.js
//   ffmpeg(input)
//     .inputOptions([...])
//     .outputOptions([...])
//     .audioCodec/bitrate/channels/frequency(...)
//     .toFormat(...)
//     .on('end'|'error', cb)
//     .save(outputPath)  (+ .kill())
// e os estáticos setFfmpegPath/getFfmpegPath.

const { spawn } = require('child_process');

let _ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

function setFfmpegPath(p) {
    if (p) _ffmpegPath = p;
}
function getFfmpegPath() {
    return _ffmpegPath;
}
function setFfprobePath() {
    // compat: bot não usa ffprobe via fluent, só spawn direto.
}

// 'a -b c' -> ['a','-b','c']; já-separados passam intactos.
function _splitFlat(list) {
    const out = [];
    for (const item of list || []) {
        if (item == null) continue;
        const s = String(item);
        if (!s) continue;
        if (!/\s/.test(s)) {
            out.push(s);
        } else {
            out.push(...s.split(/\s+/).filter(Boolean));
        }
    }
    return out;
}

class FfmpegCommand {
    constructor(input) {
        this._input = input;
        this._inputOptions = [];
        this._outputOptions = [];
        this._audioCodec = null;
        this._audioBitrate = null;
        this._audioChannels = null;
        this._audioFrequency = null;
        this._format = null;
        this._handlers = { end: [], error: [] };
        this._child = null;
    }
    inputOptions(arr) {
        this._inputOptions.push(..._splitFlat(arr));
        return this;
    }
    outputOptions(arr) {
        this._outputOptions.push(..._splitFlat(arr));
        return this;
    }
    audioCodec(c) {
        this._audioCodec = c;
        return this;
    }
    audioBitrate(b) {
        this._audioBitrate = b;
        return this;
    }
    audioChannels(c) {
        this._audioChannels = c;
        return this;
    }
    audioFrequency(f) {
        this._audioFrequency = f;
        return this;
    }
    toFormat(f) {
        this._format = f;
        return this;
    }
    on(evt, cb) {
        if (evt === 'end' || evt === 'error') this._handlers[evt].push(cb);
        return this;
    }
    kill(sig) {
        try {
            if (this._child) this._child.kill(sig || 'SIGKILL');
        } catch (_) {}
    }
    _emit(evt, ...args) {
        for (const cb of this._handlers[evt] || []) {
            try {
                cb(...args);
            } catch (_) {}
        }
    }
    save(outputPath) {
        const args = [];
        args.push(...this._inputOptions);
        args.push('-i', String(this._input));
        if (this._audioCodec) args.push('-c:a', String(this._audioCodec));
        if (this._audioBitrate) args.push('-b:a', String(this._audioBitrate));
        if (this._audioChannels != null) args.push('-ac', String(this._audioChannels));
        if (this._audioFrequency != null) args.push('-ar', String(this._audioFrequency));
        args.push(...this._outputOptions);
        if (this._format) args.push('-f', String(this._format));
        // -y: sobrescreve output (comportamento do fluent .save)
        args.push('-y', String(outputPath));

        let child;
        try {
            child = spawn(_ffmpegPath, args, { windowsHide: true });
        } catch (e) {
            setImmediate(() => this._emit('error', e));
            return this;
        }
        this._child = child;
        let stderr = '';
        if (child.stderr) {
            child.stderr.on('data', (d) => {
                stderr += d.toString();
                if (stderr.length > 4000) stderr = stderr.slice(-4000);
            });
        }
        child.on('error', (e) => this._emit('error', e));
        child.on('close', (code) => {
            if (code === 0) {
                this._emit('end');
            } else {
                const tail = stderr.trim().slice(-300);
                const err = new Error(`ffmpeg exit ${code}${tail ? `: ${tail}` : ''}`);
                this._emit('error', err);
            }
        });
        return this;
    }
}

function ffmpeg(input) {
    return new FfmpegCommand(input);
}

ffmpeg.setFfmpegPath = setFfmpegPath;
ffmpeg.getFfmpegPath = getFfmpegPath;
ffmpeg.setFfprobePath = setFfprobePath;

module.exports = ffmpeg;
