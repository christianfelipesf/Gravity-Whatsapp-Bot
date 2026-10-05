// spawnSafe.js — suprime janelas pretas (conhost.exe) no Windows.
// No Windows, todo spawn SEM windowsHide abre uma janela de console que
// pisca na tela. Isso cobre:
//  - wrapper interno src/services/ffmpeg (stickers, conversões, TTS);
//  - backstop para qualquer spawn direto que esqueça a flag.
// Uso: chamar patchChildProcess() UMA vez no startup (index.js), antes de
// qualquer spawn. Respeita windowsHide:false explícito.

const childProcess = require('child_process');

let _patched = false;

// Retorna cópia de opts com windowsHide injetado (só win32).
// Pura e testável.
function withWinHide(opts) {
    const o = { ...(opts || {}) };
    if (process.platform === 'win32' && o.windowsHide !== false) o.windowsHide = true;
    return o;
}

// Wrapper direto para novos códigos: spawnHidden('ffmpeg', [...], { stdio }).
function spawnHidden(cmd, args, opts) {
    return childProcess.spawn(cmd, args, withWinHide(opts));
}

// Patch global do child_process.spawn (idempotente).
// Preserva todas as assinaturas: (cmd, args, opts) e (cmd, opts).
function patchChildProcess() {
    if (_patched || process.platform !== 'win32') return false;
    try {
        const origSpawn = childProcess.spawn;
        if (typeof origSpawn !== 'function' || origSpawn.__spawnSafePatched) return false;
        const patched = function (command, args, options, ...rest) {
            if (Array.isArray(args)) {
                return origSpawn.call(this, command, args, withWinHide(options), ...rest);
            }
            // spawn(command, options) ou spawn(command)
            if (args && typeof args === 'object') {
                return origSpawn.call(this, command, withWinHide(args), ...rest);
            }
            return origSpawn.call(this, command, args, options, ...rest);
        };
        patched.__spawnSafePatched = true;
        childProcess.spawn = patched;
        _patched = true;
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = { withWinHide, spawnHidden, patchChildProcess };
