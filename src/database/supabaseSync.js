// Sincronização local (bot.db) <-> Supabase Postgres (nuvem, fonte da verdade).
// Estratégia:
//  - Boot: PULL nuvem -> local (a nuvem vence; sobrescreve o bot.db local).
//  - Ao salvar / flush / intervalo: PUSH local -> nuvem (upsert em lote via PostgREST).
// Mantém todo o código síncrono existente intacto.
require('dotenv').config();
const { isSupabaseEnabled, supaSelectAll, supaCount, supaUpsert, ensureSupabaseSchema } = require('./supabaseClient');

const SYNC_TABLES = [
    'messages',
    'active_groups',
    'active_groups_partial',
    'group_state',
    'config',
    'stats',
    'dashboard_groups',
    'dashboard_group_info',
    'news_groups',
    'news_state',
    'dashboard_logs',
    'dashboard_visits',
    'group_blacklist',
    'feedback',
    'antiflood_config',
    'login_allowed',
    'group_msg_stats',
    'group_modlog',
    'rank_monthly_history',
    'pessoas',
    'memes',
];

// Coluna(s) de conflito para o upsert (PostgREST ?on_conflict=)
const CONFLICT_TARGET = {
    messages: 'id',
    active_groups: 'jid',
    active_groups_partial: 'jid',
    group_state: 'jid',
    config: 'key',
    stats: 'key',
    dashboard_groups: 'jid',
    dashboard_group_info: 'jid',
    news_groups: 'jid',
    news_state: 'key',
    dashboard_logs: 'id',
    dashboard_visits: 'id',
    group_blacklist: 'group_jid,user_jid',
    feedback: 'id',
    antiflood_config: 'jid',
    login_allowed: 'phone',
    group_msg_stats: 'jid,day,hour',
    group_modlog: 'id',
    rank_monthly_history: 'jid,month',
    pessoas: 'id',
    memes: 'id',
};

// Tabelas com volume alto: limita o pull/push aos N mais recentes.
const CAPPED_TABLES = { messages: 30000, dashboard_logs: 30000, dashboard_visits: 500, group_modlog: 2000 };
// Coluna de ordem para as tabelas com cap (Postgres não tem rowid).
const ORDER_COL = { messages: 'id', dashboard_logs: 'id', dashboard_visits: 'id', group_modlog: 'id' };

// Coluna temporal das tabelas com cap (comparável entre PCs; id AUTOINCREMENT não é).
const TIME_COL = { messages: 'time', dashboard_logs: 'timestamp', dashboard_visits: 'timestamp', group_modlog: 'timestamp' };

// Limita a nuvem às `cap` linhas globalmente mais recentes (por coluna temporal).
// Sem isso o upsert (que nunca apaga) faz a nuvem crescer sem limite e o PULL
// ressuscita linhas que o bot já aparou localmente.
async function _trimCloudCap(table, cap) {
    const tcol = TIME_COL[table];
    if (!tcol) return 0;
    const { supaFetch } = require('./supabaseClient');
    const boundary = await supaFetch(`/${table}?select=${tcol}&order=${tcol}.desc&limit=1&offset=${cap - 1}`);
    if (!Array.isArray(boundary) || !boundary.length) return 0; // nuvem tem < cap linhas
    const cutoff = Number(boundary[0]?.[tcol]);
    if (!isFinite(cutoff)) return 0;
    await supaFetch(`/${table}?${tcol}=lt.${cutoff}`, { method: 'DELETE' });
    return 1;
}

// Coerção de tipos no PUSH (SQLite aceita qualquer tipo em qualquer coluna;
// o Postgres não). stats.value é TEXT na nuvem por design (mistura inteiros e 'YYYY-MM').
const TEXT_COLS = { stats: ['value'] };
const NUMERIC_COLS = {
    messages: ['id', 'time'],
    active_groups: ['activated_at'],
    active_groups_partial: ['activated_at'],
    group_state: ['antilink'],
    dashboard_groups: ['enabled', 'updated_at'],
    dashboard_group_info: ['member_count', 'updated_at'],
    news_groups: ['enabled', 'activated_at'],
    news_state: ['updated_at'],
    dashboard_logs: ['id', 'from_me', 'hidden', 'ephemeral', 'timestamp'],
    dashboard_visits: ['id', 'timestamp'],
    group_blacklist: ['added_at'],
    feedback: ['id', 'created_at'],
    antiflood_config: ['enabled', 'include_admins', 'max_msgs', 'window_secs', 'updated_at'],
    login_allowed: ['added_at'],
    group_msg_stats: ['hour', 'count'],
    group_modlog: ['id', 'timestamp'],
    rank_monthly_history: ['total', 'created_at'],
    pessoas: ['id', 'created_at', 'updated_at'],
    memes: ['id', 'created_at'],
};

function _coerceForCloud(table, col, v) {
    if (v === undefined) return null;
    if (v === null) return null;
    if ((TEXT_COLS[table] || []).includes(col)) {
        return typeof v === 'string' ? v : String(v);
    }
    if ((NUMERIC_COLS[table] || []).includes(col)) {
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
        return v; // deixa o Postgres recusar com erro claro em vez de corromper silenciosamente
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
}

let _syncTimer = null;
let _autoTimer = null;
let _localOverride = null; // null = segue .env, true/false = override via Telegram em runtime
let _pushPending = false;
let _syncRunning = false;
let _pullOk = false;
let _pullFailed = false;
let _pullRefusedLogged = false;
let _dirty = false; // true = houve escrita local desde o último push bem-sucedido
let _lastPullAt = 0;
let _lastPushAt = 0;
let _lastPushRefused = null;

function markDirty() { _dirty = true; }
function isDirty() { return _dirty; }
// Push com timeout: usado no shutdown (SIGINT/SIGTERM), onde o process.exit
// mataria um schedulePush agendado. Retorna true se subiu.
async function pushNow(timeoutMs = 20000) {
    try {
        await Promise.race([
            pushToCloud({ requirePull: false }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('push-timeout')), Math.max(1000, timeoutMs))),
        ]);
        return true;
    } catch (e) {
        try { console.error(`⚠️ [supabase] push de shutdown falhou: ${e?.message || e}`); } catch (_) {}
        return false;
    }
}

function _localDb() {
    return require('./db').db;
}

function _tableColumns(localDb, table) {
    try {
        const rows = localDb.prepare(`PRAGMA table_info("${table}")`).all();
        return rows.map(r => r.name).filter(Boolean);
    } catch (_) { return []; }
}

function _tableExists(localDb, table) {
    try {
        const r = localDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        return !!r;
    } catch (_) { return false; }
}

function _countLocal(localDb, table) {
    try {
        if (!_tableExists(localDb, table)) return 0;
        const r = localDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get();
        return Number(r?.c) || 0;
    } catch (_) { return -1; }
}

async function _countCloud(table) {
    try {
        return await supaCount(table);
    } catch (_) {
        return -1;
    }
}

function _localIntegrity() {
    try {
        const row = _localDb().prepare('PRAGMA integrity_check').get();
        const v = row && (row.integrity_check || Object.values(row)[0]);
        return String(v || '').toLowerCase() === 'ok' ? { ok: true } : { ok: false, reason: String(v).slice(0, 200) };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

function _quarantineLocal(reason) {
    try {
        const fs = require('fs');
        const path = require('path');
        const { dbPath } = require('./db');
        try { _localDb().pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}`;
        const dest = path.join(path.dirname(dbPath), `bot.db.quarentena-${stamp}.db`);
        fs.copyFileSync(dbPath, dest);
        try { console.error(`🚧 [supabase] DB local em QUARENTENA (cópia): ${dest} — motivo: ${reason}`); } catch (_) {}
        return dest;
    } catch (e) {
        try { console.error('🚧 [supabase] falha ao quarentenar DB local:', e?.message || e); } catch (_) {}
        return null;
    }
}

async function validateBeforePush() {
    const localDb = _localDb();
    const integ = _localIntegrity();
    if (!integ.ok) {
        _quarantineLocal(`integrity_check: ${integ.reason}`);
        return { ok: false, reason: `integrity_check falhou: ${integ.reason}` };
    }
    const localCfg = _countLocal(localDb, 'config');
    const localGs = _countLocal(localDb, 'group_state');
    if (localCfg < 0 || localGs < 0) return { ok: false, reason: 'erro ao ler tabelas locais' };
    if (localCfg === 0) {
        return { ok: false, reason: 'db local vazio (config=0) — push recusado; rode --push --force se for intencional' };
    }
    const cloudCfg = await _countCloud('config');
    const cloudGs = await _countCloud('group_state');
    if (cloudCfg > 0 && localCfg < Math.ceil(cloudCfg * 0.5)) {
        return { ok: false, reason: `db local suspeito (config local=${localCfg} < 50% da nuvem=${cloudCfg}) — push recusado` };
    }
    if (cloudGs > 0 && localGs === 0) {
        return { ok: false, reason: `db local suspeito (group_state local=0, nuvem=${cloudGs}) — push recusado` };
    }
    return { ok: true };
}

async function backupCloud({ log = console } = {}) {
    if (!isSupabaseEnabled()) return { ok: false, reason: 'not-configured' };
    await ensureSupabaseSchema(SYNC_TABLES);
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}`;
    const file = path.join(dir, `supabase-${stamp}.json`);
    const dump = { at: new Date().toISOString(), tables: {} };
    for (const table of SYNC_TABLES) {
        const cap = CAPPED_TABLES[table];
        dump.tables[table] = await supaSelectAll(table, {
            order: cap ? (ORDER_COL[table] || null) : null,
            desc: true,
            limit: cap || 20000,
        });
    }
    fs.writeFileSync(file, JSON.stringify(dump));
    try { log.log(`💾 [supabase] backup da nuvem em ${path.basename(file)}`); } catch (_) {}
    return { ok: true, file };
}

// Backups pré-pull ficam TODOS dentro de backups/ (nunca na raiz).
// Rotação: mantém os 7 bot-pre-*.db mais recentes — sem isso a pasta
// cresce sem limite (um backup por pull do boot).
const PRE_PULL_KEEP = 7;
function _backupLocalFile(tag) {
    try {
        const fs = require('fs');
        const path = require('path');
        const { dbPath } = require('./db');
        if (!fs.existsSync(dbPath)) return null;
        try { _localDb().pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}`;
        const dest = path.join(process.cwd(), 'backups', `bot-pre-${tag}-${stamp}.db`);
        const dir = path.dirname(dest);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(dbPath, dest);
        try {
            const files = fs.readdirSync(dir).filter(f => /^bot-pre-.*\.db$/.test(f)).sort();
            while (files.length > PRE_PULL_KEEP) {
                const old = files.shift();
                try { fs.unlinkSync(path.join(dir, old)); } catch (_) {}
            }
        } catch (_) {}
        return dest;
    } catch (_) { return null; }
}

// Normaliza tipos vindos do Postgres para o SQLite local (int 0/1, etc).
function _normRow(table, row, cols) {
    const o = {};
    for (const c of cols) {
        let v = row[c];
        if (v === undefined) v = null;
        o[c] = v;
    }
    return o;
}

async function pullFromCloud({ log = console } = {}) {
    if (!isSupabaseEnabled()) return { ok: false, reason: 'not-configured' };
    if (_syncRunning) return { ok: false, reason: 'busy' };
    _syncRunning = true;
    try {
        await ensureSupabaseSchema(SYNC_TABLES);
        _backupLocalFile('pull');
        const localDb = _localDb();
        let tables = 0, rows = 0;
        for (const table of SYNC_TABLES) {
            if (!_tableExists(localDb, table)) continue;
            const cols = _tableColumns(localDb, table);
            if (!cols.length) continue;
            const cap = CAPPED_TABLES[table];
            const cloudRows = await supaSelectAll(table, {
                order: cap ? (ORDER_COL[table] || null) : null,
                desc: true,
                limit: cap || 20000,
            });
            // Guarda anti-nuvem-vazia: o PULL é destrutivo (DELETE+INSERT local).
            // Se a nuvem veio vazia mas o local tem dados, NÃO apaga o local —
            // pode ser push interrompido entre DELETE e upsert (REPLACE_TABLES),
            // falha parcial, ou tabela dropada manualmente. O próximo push
            // restaura a nuvem a partir do local preservado.
            if (!cloudRows.length && (REPLACE_TABLES[table] || table === 'config' || table === 'group_state')) {
                let localCount = 0;
                try { localCount = localDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c || 0; } catch (_) {}
                if (localCount > 0) {
                    try { log.log(`🛡️ [supabase] PULL pulou ${table}: nuvem vazia, local com ${localCount} linha(s) preservado(s)`); } catch (_) {}
                    continue;
                }
            }
            const del = localDb.prepare(`DELETE FROM "${table}"`);
            const placeholders = cols.map(() => '?').join(',');
            const quoted = cols.map(c => `"${c}"`).join(',');
            const ins = localDb.prepare(`INSERT OR REPLACE INTO "${table}" (${quoted}) VALUES (${placeholders})`);
            const list = cloudRows.map(r => _normRow(table, r, cols));
            if (cap) list.reverse();
            // Tabelas volumosas de histórico (messages/dashboard_logs/...): MERGE,
            // não wipe. O PULL com cap traz só os N mais recentes da nuvem — um
            // DELETE local apagaria o excedente que só existe no bot.db (ex.:
            // local com 80k, nuvem com 30k). O teto é aplicado depois via trim.
            // Deletes intencionais (clearChatHistory) vão por caminho explícito
            // (_msgPendingCloudDelete) e não dependem do PULL.
            const isCappedHistory = !!cap;
            const tx = localDb.transaction((arr) => {
                if (!isCappedHistory) del.run();
                for (const r of arr) ins.run(cols.map(c => (r[c] === undefined ? null : r[c])));
            });
            tx(list);
            tables++;
            rows += list.length;
        }
        // Total x parcial são mutuamente exclusivos, mas a nuvem pode ter o mesmo
        // jid nas duas tabelas (push antigo era só-upsert e nunca apagava).
        // Sem isso, o boot ressuscita o modo errado. Vence o mais recente.
        try { require('./utils').reconcileActivePartial(localDb); } catch (e) {
            try { log.log(`⚠️ [supabase] reconcile total/parcial falhou (segue): ${e?.message || e}`); } catch (_) {}
        }
        // Pós-PULL: uniformiza tetos locais (o merge acima pode trazer grupos
        // de messages acima do summaryLimit; o trim de logs usa history*).
        try { require('./utils').trimMessagesToLimit?.(); } catch (_) {}
        try { require('../history/store').runHistoryTrimOnce?.(false); } catch (_) {}
        try { localDb.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        _lastPullAt = Date.now();
        _pullOk = true;
        _pullFailed = false;
        try { log.log(`☁️ [supabase] PULL ok: ${rows} linhas em ${tables} tabelas (nuvem → local)`); } catch (_) {}
        return { ok: true, tables, rows };
    } catch (e) {
        _pullFailed = true;
        throw e;
    } finally {
        _syncRunning = false;
    }
}

// Tabelas com semântica de DELETE (membership, toggles por grupo, listas):
// PUSH faz full-replace (DELETE na nuvem + INSERT do local) em vez de upsert
// puro. Motivo: o upsert nunca apaga, então remoções/desativações locais
// (!desativar, !news desativar, !listanegra del/limpar, !removerlogin,
// !deletar-pessoa, !dashboard off, !newsreset, !limparfeedback...) deixavam a
// linha velha na nuvem e o PULL do boot (DELETE+INSERT local) ressuscitava o
// estado antigo. O valor é o filtro PostgREST do DELETE (coluna temporal da
// tabela; group_state não tem coluna temporal — usa o PK com valor impossível,
// já que jid é PRIMARY KEY NOT NULL e nunca é "__none__").
// Tabelas minúsculas (só jids/flags), então o replace é barato.
const REPLACE_TABLES = {
    active_groups: 'activated_at=gte.0',
    active_groups_partial: 'activated_at=gte.0',
    news_groups: 'activated_at=gte.0',
    group_blacklist: 'added_at=gte.0',
    login_allowed: 'added_at=gte.0',
    pessoas: 'created_at=gte.0',
    memes: 'created_at=gte.0',
    antiflood_config: 'updated_at=gte.0',
    dashboard_groups: 'updated_at=gte.0',
    dashboard_group_info: 'updated_at=gte.0',
    news_state: 'updated_at=gte.0',
    feedback: 'created_at=gte.0',
    group_state: 'jid=neq.__none__',
};

async function pushToCloud({ log = console, force = false, requirePull = true } = {}) {
    if (!isSupabaseEnabled()) return { ok: false, reason: 'not-configured' };
    if (requirePull && !_pullOk && !force && process.env.SUPABASE_REQUIRE_PULL !== '0') {
        _lastPushRefused = { at: Date.now(), reason: 'pull-pending' };
        if (!_pullRefusedLogged) {
            _pullRefusedLogged = true;
            try { (log.log || log)(`⏳ [supabase] push adiado: aguardando 1º PULL do boot (nuvem vence)`); } catch (_) {}
        }
        _pushPending = true;
        return { ok: false, reason: 'pull-pending' };
    }
    if (_syncRunning) { _pushPending = true; return { ok: false, reason: 'busy' }; }
    _syncRunning = true;
    try {
        await ensureSupabaseSchema(SYNC_TABLES);
        // Deletes de messages pendentes (clearChatHistory offline): messages é
        // upsert-only, então o delete precisa ir explícito — senão o próximo
        // PULL ressuscita o histórico. Falha aqui re-enfileira p/ o próximo push.
        try {
            const pending = require('./utils').consumePendingMessageDeletes?.() || [];
            if (pending.length) {
                const { supaFetch } = require('./supabaseClient');
                for (const [pjid, pcut] of pending) {
                    try {
                        await supaFetch(`/messages?jid=eq.${encodeURIComponent(pjid)}&time=lte.${pcut}`, { method: 'DELETE', timeoutMs: 15000 });
                    } catch (e) {
                        try { require('./utils').requeueMessageCloudDelete?.(pjid, pcut); } catch (_) {}
                        try { console.error(`⚠️ [supabase] delete pendente de messages falhou (re-enfileirado): ${e?.message || e}`); } catch (_) {}
                    }
                }
            }
        } catch (_) {}
        const check = await validateBeforePush();
        if (!check.ok && !force) {
            _lastPushRefused = { at: Date.now(), reason: check.reason };
            try { console.error(`🛡️ [supabase] PUSH RECUSADO: ${check.reason}`); } catch (_) {}
            return { ok: false, reason: check.reason };
        }
        if (!check.ok && force) {
            try { console.warn(`⚠️ [supabase] validação ignorada via --force: ${check.reason}`); } catch (_) {}
        }
        const localDb = _localDb();
        let tables = 0, rows = 0;
        // Ordem de prioridade: tabelas pequenas e críticas primeiro, para que
        // mesmo um push truncado (ex: SIGKILL do PM2 no meio do push de
        // shutdown) preserve o que importa. Logs volumosos vão por último.
        const priority = ['config', 'group_state', ...Object.keys(REPLACE_TABLES)];
        const ordered = [...new Set([...priority.filter(t => SYNC_TABLES.includes(t)), ...SYNC_TABLES])];
        for (const table of ordered) {
            if (!_tableExists(localDb, table)) continue;
            const cols = _tableColumns(localDb, table);
            if (!cols.length) continue;
            const cap = CAPPED_TABLES[table];
            const orderCol = ORDER_COL[table];
            const localRows = cap && orderCol && cols.includes(orderCol)
                ? localDb.prepare(`SELECT * FROM "${table}" ORDER BY "${orderCol}" DESC LIMIT ${cap}`).all().reverse()
                : localDb.prepare(`SELECT * FROM "${table}"`).all();
            if (REPLACE_TABLES[table]) {
                // Propaga DESATIVAÇÕES e REMOÇÕES: limpa a nuvem e grava o
                // estado local (vazio = "ninguém nesse modo / lista vazia", válido).
                const { supaFetch } = require('./supabaseClient');
                await supaFetch(`/${table}?${REPLACE_TABLES[table]}`, { method: 'DELETE' });
                if (!localRows.length) { tables++; continue; }
            } else if (!localRows.length) { tables++; continue; }
            // Postgres: coerção explícita (SQLite é flexível, Postgres não).
            const payload = localRows.map(r => {
                const o = {};
                for (const c of cols) {
                    o[c] = _coerceForCloud(table, c, r[c]);
                }
                return o;
            });
            const n = await supaUpsert(table, payload, CONFLICT_TARGET[table]);
            rows += n;
            tables++;
            // Tabela com cap: apara a nuvem às `cap` mais recentes (por tempo, válido entre PCs).
            if (cap && TIME_COL[table]) {
                try { await _trimCloudCap(table, cap); } catch (e) {
                    try { console.warn(`⚠️ [supabase] trim ${table} falhou (segue):`, e?.message || e); } catch (_) {}
                }
            }
        }
        _lastPushAt = Date.now();
        _dirty = false;
        _pullRefusedLogged = false;
        try { log.log(`☁️ [supabase] PUSH ok: ${rows} linhas em ${tables} tabelas (local → nuvem)`); } catch (_) {}
        return { ok: true, tables, rows };
    } finally {
        _syncRunning = false;
        if (_pushPending) { _pushPending = false; schedulePush(2000); }
    }
}

function schedulePush(delayMs = 5000) {
    if (!isSupabaseEnabled() || isSyncKilled()) return;
    markDirty();
    if (_syncTimer) return;
    _syncTimer = setTimeout(async () => {
        _syncTimer = null;
        try { await pushToCloud(); } catch (e) {
            try { console.error('⚠️ [supabase] push agendado falhou:', e?.message || e); } catch (_) {}
        }
    }, delayMs);
    try { if (_syncTimer.unref) _syncTimer.unref(); } catch (_) {}
}

function _intervalMs() {
    const raw = process.env.SUPABASE_SYNC_INTERVAL_MS || '60000';
    return Math.max(15000, Number(raw) || 60000);
}

// Modo local: BOT_LOCAL_MODE=1 força modo 100% local
// (sem pull no boot, sem push periódico, sem push via flush).
// 0, ausente ou qualquer outro valor = sync normal (modo local DESATIVADO).
// Comandos manuais do CLI (db:push/db:pull/db:init) continuam funcionando — são ação explícita.
// Legado: SUPABASE_SYNC_ENABLED=0 ainda é aceito como alias (com aviso).
// Runtime: _localOverride (via Telegram /banco) tem precedência sobre o .env.
function isSyncKilled() {
    if (_localOverride !== null) return _localOverride;
    const v = String(process.env.BOT_LOCAL_MODE || '').trim();
    if (v === '1') return true;
    if (String(process.env.SUPABASE_SYNC_ENABLED || '').trim() === '0') {
        try { console.warn('⚠️ [supabase] SUPABASE_SYNC_ENABLED=0 é legado — use BOT_LOCAL_MODE=1'); } catch (_) {}
        return true;
    }
    return false;
}

function _persistLocalModeEnv(enabled) {
    try {
        const fs = require('fs');
        const path = require('path');
        const envPath = path.join(process.cwd(), '.env');
        if (!fs.existsSync(envPath)) return { ok: false, reason: 'no-.env' };
        let content = fs.readFileSync(envPath, 'utf8');
        const line = `BOT_LOCAL_MODE=${enabled ? '1' : '0'}`;
        if (/^BOT_LOCAL_MODE\s*=.*$/m.test(content)) {
            content = content.replace(/^BOT_LOCAL_MODE\s*=.*$/m, line);
        } else {
            if (!content.endsWith('\n')) content += '\n';
            content += `${line}\n`;
        }
        fs.writeFileSync(envPath, content);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

function stopAutoSync() {
    try { if (_autoTimer) clearInterval(_autoTimer); } catch (_) {}
    _autoTimer = null;
    try { if (_syncTimer) clearTimeout(_syncTimer); } catch (_) {}
    _syncTimer = null;
}

// Troca local <-> nuvem em runtime (Telegram /banco). Persiste no .env p/ sobreviver ao restart.
// local=true  -> para timers, só bot.db (sem pull/push).
// local=false -> retoma push periódico SEM pull destrutivo (nuvem NÃO sobrescreve o local;
//                rode `npm run db:pull` se quiser forçar nuvem -> local).
function setLocalMode(local, { persist = true } = {}) {
    const enabled = !!local;
    _localOverride = enabled;
    try { process.env.BOT_LOCAL_MODE = enabled ? '1' : '0'; } catch (_) {}
    if (enabled) {
        stopAutoSync();
        try { console.log('☁️ [supabase] /banco local — modo local ativado em runtime (só bot.db)'); } catch (_) {}
    } else {
        // Retoma sync sem recriar pull destrutivo; pushes voltam a funcionar.
        _pullOk = true;
        _pullFailed = false;
        try {
            const r = startAutoSync({ onBootPull: false });
            void r;
        } catch (_) {}
        try { console.log('☁️ [supabase] /banco nuvem — sync retomado em runtime (push periódico, sem pull auto)'); } catch (_) {}
    }
    let saved = { ok: false, reason: 'skip' };
    if (persist) saved = _persistLocalModeEnv(enabled);
    return { ok: true, local: enabled, persisted: saved.ok, persistDetail: saved.reason || null };
}

function getMode() {
    return {
        local: isSyncKilled(),
        source: _localOverride !== null ? 'runtime' : 'env',
        env: String(process.env.BOT_LOCAL_MODE || '').trim() || '(ausente)',
        ...status(),
    };
}

function startAutoSync({ onBootPull = true } = {}) {
    if (!isSupabaseEnabled()) {
        try { console.log('☁️ [supabase] desativado (sem SUPABASE_URL/SECRET_KEY) — usando bot.db local'); } catch (_) {}
        return { enabled: false };
    }
    if (isSyncKilled()) {
        try { console.log('☁️ [supabase] modo local ativado (BOT_LOCAL_MODE=1) — usando só bot.db, sem pull/push'); } catch (_) {}
        return { enabled: false, localOnly: true };
    }
    // Evita duplicar o intervalo em trocas runtime (/banco nuvem repetido).
    try { if (_autoTimer) clearInterval(_autoTimer); } catch (_) {}
    _autoTimer = null;
    const intervalMs = _intervalMs();
    _pullOk = false;
    _pullFailed = false;
    const bootPullOff = process.env.SUPABASE_SYNC_ON_BOOT === '0';
    if (onBootPull && !bootPullOff) {
        setImmediate(async () => {
            try {
                await pullFromCloud();
            } catch (e) {
                try { console.error('⚠️ [supabase] pull do boot falhou (PUSH bloqueado até próximo pull; segue com bot.db local):', e?.message || e); } catch (_) {}
            }
        });
    } else {
        _pullOk = true;
    }
    const t = setInterval(async () => {
        try { await pushToCloud({ log: { log: () => {} } }); } catch (e) {
            try { console.error('⚠️ [supabase] push periódico falhou:', e?.message || e); } catch (_) {}
        }
    }, intervalMs);
    _autoTimer = t;
    try { if (t.unref) t.unref(); } catch (_) {}
    try { console.log(`☁️ [supabase] ativo (pull no boot + push a cada ${Math.round(intervalMs / 1000)}s)`); } catch (_) {}
    return { enabled: true };
}

function status() {
    return { enabled: isSupabaseEnabled(), localOnly: isSyncKilled(), lastPullAt: _lastPullAt, lastPushAt: _lastPushAt, pullOk: _pullOk, pullFailed: _pullFailed, dirty: _dirty, lastPushRefused: _lastPushRefused };
}

function markPullOk() { _pullOk = true; _pullFailed = false; }

module.exports = { pullFromCloud, pushToCloud, schedulePush, pushNow, markDirty, isDirty, startAutoSync, stopAutoSync, setLocalMode, getMode, status, SYNC_TABLES, backupCloud, validateBeforePush, markPullOk, isSyncKilled };
