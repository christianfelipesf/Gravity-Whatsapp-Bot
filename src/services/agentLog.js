// Trilha de auditoria p/ bug-hunting (OpenCode): 1 linha JSON por execução.
// Arquivo: logs/agent_YYYY-MM-DD.jsonl (data SP). Sem multiline, sem noise.
// Uso: agentCommand({ cid, cmd, ... }) — fire-and-forget, nunca quebra o handler.
const fs = require('fs');
const path = require('path');

function spDateLabel(d = new Date()) {
    try {
        // America/Sao_Paulo (UTC-3 fixo p/ nome de arquivo; sem dependência de ICU extra)
        const t = new Date(d.getTime() - 3 * 3600 * 1000);
        return t.toISOString().slice(0, 10);
    } catch (_) {
        return d.toISOString().slice(0, 10);
    }
}

function spTimestamp(d = new Date()) {
    try {
        const fmt = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
            year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        return fmt.format(d);
    } catch (_) {
        return d.toISOString();
    }
}

function getAgentFile(d = new Date()) {
    const dir = path.join(process.cwd(), 'logs');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return path.join(dir, `agent_${spDateLabel(d)}.jsonl`);
}

function safeStr(v, max) {
    let s = v == null ? '' : String(v);
    s = s.replace(/[\r\n]+/g, ' ').trim();
    if (max && s.length > max) s = s.slice(0, max);
    return s;
}

// 1 linha por execução de comando. Campos estáveis p/ grep/join por cid.
function agentCommand(ev = {}) {
    try {
        const now = new Date();
        const line = JSON.stringify({
            ts_utc: now.toISOString(),
            ts_sp: spTimestamp(now),
            cid: safeStr(ev.cid || '', 64),
            cmd: safeStr(ev.cmd || '', 48),
            prefix: safeStr(ev.prefix || '', 4),
            category: safeStr(ev.category || '', 24),
            ok: ev.ok !== false,
            err: safeStr(ev.err || '', 300),
            stack0: safeStr(ev.stack0 || '', 200),
            cmd_ms: Number(ev.cmd_ms) || 0,
            args_prev: safeStr(ev.args || '', 200),
            from: safeStr(ev.from || '', 64),
            group: safeStr(ev.group || '', 80),
            sender: safeStr(ev.sender || '', 64),
            sender_name: safeStr(ev.senderName || '', 48),
            from_me: !!ev.fromMe,
            version: safeStr(ev.version || '', 48)
        });
        fs.appendFileSync(getAgentFile(now), line + '\n');
    } catch (_) {}
}

// Prune: apaga agent_*.jsonl e terminal_*.log com mais de `maxDays` dias.
// Roda 1x no boot (deferido) — barato: só readdir + unlink.
function pruneOldLogs({ maxDays = 7 } = {}) {
    try {
        const dir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(dir)) return { deleted: 0 };
        const cutoff = Date.now() - maxDays * 24 * 3600 * 1000;
        let deleted = 0;
        for (const name of fs.readdirSync(dir)) {
            if (!/^agent_\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && !/^terminal_\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
            try {
                const st = fs.statSync(path.join(dir, name));
                if (st.mtimeMs < cutoff) { fs.unlinkSync(path.join(dir, name)); deleted++; }
            } catch (_) {}
        }
        // .gz antigos do mesmo padrão
        for (const name of fs.readdirSync(dir)) {
            if (!/^terminal_\d{4}-\d{2}-\d{2}\.log\.gz$/.test(name)) continue;
            try {
                const st = fs.statSync(path.join(dir, name));
                if (st.mtimeMs < cutoff) { fs.unlinkSync(path.join(dir, name)); deleted++; }
            } catch (_) {}
        }
        return { deleted };
    } catch (_) { return { deleted: 0 }; }
}

// Gzip do terminal de ontem (se >1MB e ainda não gzippado). Async, fire-and-forget.
function gzipYesterdayTerminal() {
    try {
        const zlib = require('zlib');
        const dir = path.join(process.cwd(), 'logs');
        const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
        const src = path.join(dir, `terminal_${spDateLabel(yesterday)}.log`);
        const dst = src + '.gz';
        if (!fs.existsSync(src) || fs.existsSync(dst)) return;
        let size = 0;
        try { size = fs.statSync(src).size; } catch (_) { return; }
        if (size < 1024 * 1024) return;
        const inp = fs.createReadStream(src);
        const out = fs.createWriteStream(dst);
        const gz = zlib.createGzip();
        inp.pipe(gz).pipe(out);
        out.on('finish', () => { try { fs.unlinkSync(src); } catch (_) {} });
        out.on('error', () => { try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {} });
        inp.on('error', () => { try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {} });
    } catch (_) {}
}

module.exports = { agentCommand, pruneOldLogs, gzipYesterdayTerminal, spDateLabel, spTimestamp, getAgentFile };
