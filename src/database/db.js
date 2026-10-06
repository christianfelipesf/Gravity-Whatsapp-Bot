const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.BOT_DB_PATH || path.join(__dirname, '../../bot.db');
const legacyDbPath = path.join(__dirname, '../../database.json');
const legacyMsgsPath = path.join(__dirname, '../../messages.json');
const tempDir = path.join(process.cwd(), 'temp');

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('cache_size = -64000');
db.pragma('temp_store = MEMORY');
try { db.pragma('mmap_size = 268435456'); } catch (_) {}
setInterval(() => { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {} }, 10 * 60 * 1000).unref();

let _vacuumedNow = false;
let _vacuumPending = false;
function _runInitialVacuumAsync() {
    if (_vacuumPending) return;
    _vacuumPending = true;
    setImmediate(() => {
        try {
            const av = Number(db.pragma('auto_vacuum', { simple: true }));
            if (av === 0) {
                db.pragma('auto_vacuum = INCREMENTAL');
                const beforeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
                try { db.exec('VACUUM;'); } catch (e) { console.error('[database] VACUUM falhou:', e?.message || e); _vacuumPending = false; return; }
                const afterBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
                const beforeMb = (beforeBytes / 1048576).toFixed(2);
                const afterMb = (afterBytes / 1048576).toFixed(2);
                if (beforeBytes !== afterBytes) {
                    console.log(`🧹 [database] VACUUM inicial: ${beforeMb} MB → ${afterMb} MB (auto_vacuum=INCREMENTAL ativo)`);
                    _vacuumedNow = true;
                }
            }
        } catch (e) { console.error('[database] VACUUM inicial falhou:', e?.message || e); }
        _vacuumPending = false;
        try {
            const avFinal = Number(db.pragma('auto_vacuum', { simple: true }));
            const pageCount = Number(db.pragma('page_count', { simple: true }));
            const pageSize = Number(db.pragma('page_size', { simple: true }));
            const freelist = Number(db.pragma('freelist_count', { simple: true }));
            const totalBytes = pageCount * pageSize;
            const avLabel = avFinal === 0 ? 'NONE' : avFinal === 1 ? 'FULL' : 'INCREMENTAL';
            const sizeKb = (totalBytes / 1024).toFixed(1);
            const freeKb = (freelist * pageSize / 1024).toFixed(1);
            const note = _vacuumedNow ? '' : (avFinal === 2 ? ' (já migrado)' : '');
            console.log(`💾 [database] auto_vacuum=${avLabel}, ${pageCount}×${pageSize}B = ${sizeKb} KB, freelist=${freeKb} KB${note}`);
        } catch (_) {}
    });
}
try {
    const avSync = Number(db.pragma('auto_vacuum', { simple: true }));
    if (avSync === 0) {
        _runInitialVacuumAsync();
        const pageCount = Number(db.pragma('page_count', { simple: true }));
        const pageSize = Number(db.pragma('page_size', { simple: true }));
        console.log(`💾 [database] auto_vacuum=NONE, ${pageCount}×${pageSize}B — VACUUM agendado em background (não bloqueia boot)`);
    } else {
        const avFinal = avSync;
        const pageCount = Number(db.pragma('page_count', { simple: true }));
        const pageSize = Number(db.pragma('page_size', { simple: true }));
        const freelist = Number(db.pragma('freelist_count', { simple: true }));
        const totalBytes = pageCount * pageSize;
        const avLabel = avFinal === 0 ? 'NONE' : avFinal === 1 ? 'FULL' : 'INCREMENTAL';
        const sizeKb = (totalBytes / 1024).toFixed(1);
        const freeKb = (freelist * pageSize / 1024).toFixed(1);
        const note = avFinal === 2 ? ' (já migrado)' : '';
        console.log(`💾 [database] auto_vacuum=${avLabel}, ${pageCount}×${pageSize}B = ${sizeKb} KB, freelist=${freeKb} KB${note}`);
    }
} catch (e) {
    console.error('[database] VACUUM inicial falhou:', e?.message || e);
}

db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        jid       TEXT NOT NULL,
        push_name TEXT,
        text      TEXT NOT NULL,
        time      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_jid_time ON messages(jid, time);

    CREATE TABLE IF NOT EXISTS active_groups (
        jid      TEXT PRIMARY KEY,
        activated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_groups_partial (
        jid      TEXT PRIMARY KEY,
        activated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_state (
        jid       TEXT PRIMARY KEY,
        muted     TEXT NOT NULL DEFAULT '[]',
        warnings  TEXT NOT NULL DEFAULT '{}',
        antilink  INTEGER NOT NULL DEFAULT 1,
        activity  TEXT NOT NULL DEFAULT '{}',
        bot_name  TEXT,
        menu_image TEXT,
        prefix    TEXT,
        sticker_pack TEXT,
        sticker_author TEXT,
        theme     TEXT,
        extra     TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dashboard_groups (
        jid        TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_group_info (
        jid          TEXT PRIMARY KEY,
        subject      TEXT,
        picture_url  TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        owner_jid    TEXT,
        desc         TEXT,
        updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news_groups (
        jid          TEXT PRIMARY KEY,
        enabled      INTEGER NOT NULL DEFAULT 1,
        activated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT NOT NULL,
        grp         TEXT,
        text        TEXT,
        name        TEXT,
        phone       TEXT,
        media_json  TEXT,
        to_jid      TEXT,
        message_id  TEXT,
        sender_jid  TEXT,
        from_me     INTEGER NOT NULL DEFAULT 0,
        hidden      INTEGER NOT NULL DEFAULT 0,
        ephemeral   INTEGER NOT NULL DEFAULT 0,
        quoted_json TEXT,
        reactions   TEXT,
        time_label  TEXT,
        timestamp   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_logs_ts ON dashboard_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_dashboard_logs_to_jid ON dashboard_logs(to_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_dashboard_logs_msgid
        ON dashboard_logs(message_id)
        WHERE message_id IS NOT NULL AND message_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_logs_msgid_unique
        ON dashboard_logs(to_jid, message_id, type)
        WHERE message_id IS NOT NULL AND message_id != '';

    CREATE TABLE IF NOT EXISTS dashboard_visits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT,
        ip          TEXT,
        user_agent  TEXT,
        timestamp   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_visits_ts ON dashboard_visits(timestamp);

    CREATE TABLE IF NOT EXISTS group_blacklist (
        group_jid TEXT NOT NULL,
        user_jid  TEXT NOT NULL,
        added_by  TEXT,
        added_at  INTEGER NOT NULL,
        PRIMARY KEY (group_jid, user_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_group_blacklist_group ON group_blacklist(group_jid);

    CREATE TABLE IF NOT EXISTS feedback (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL CHECK(kind IN ('bug','sugestao')),
        text        TEXT NOT NULL,
        sender_jid  TEXT,
        sender_name TEXT,
        group_jid   TEXT,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_kind_created ON feedback(kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS antiflood_config (
        jid             TEXT PRIMARY KEY,
        enabled         INTEGER NOT NULL DEFAULT 1,
        include_admins  INTEGER NOT NULL DEFAULT 0,
        max_msgs        INTEGER NOT NULL DEFAULT 5,
        window_secs     INTEGER NOT NULL DEFAULT 8,
        updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_allowed (
        phone      TEXT PRIMARY KEY,
        added_by   TEXT,
        added_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_msg_stats (
        jid   TEXT NOT NULL,
        day   TEXT NOT NULL,
        hour  INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (jid, day, hour)
    );
    CREATE INDEX IF NOT EXISTS idx_group_msg_stats_jid_day ON group_msg_stats(jid, day);

    CREATE TABLE IF NOT EXISTS group_modlog (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        jid       TEXT NOT NULL,
        kind      TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_modlog_jid_ts ON group_modlog(jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_group_modlog_jid_kind_ts ON group_modlog(jid, kind, timestamp);

    CREATE TABLE IF NOT EXISTS rank_monthly_history (
        jid        TEXT NOT NULL,
        month      TEXT NOT NULL,
        total      INTEGER NOT NULL DEFAULT 0,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (jid, month)
    );

    CREATE TABLE IF NOT EXISTS pessoas (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        nome       TEXT NOT NULL,
        nome_norm  TEXT NOT NULL UNIQUE,
        nascimento TEXT,
        cidade     TEXT,
        descricao  TEXT,
        status     TEXT,
        hobby      TEXT,
        pix        TEXT,
        instagram  TEXT,
        linkedin   TEXT,
        foto_path  TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pessoas_cidade ON pessoas(cidade);
    CREATE INDEX IF NOT EXISTS idx_pessoas_nascimento ON pessoas(nascimento);

    CREATE TABLE IF NOT EXISTS memes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path    TEXT NOT NULL,
        hash         TEXT NOT NULL UNIQUE,
        sender_jid   TEXT,
        sender_name  TEXT,
        sender_phone TEXT,
        created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memes_created ON memes(created_at DESC);

    -- Anti-repetição por grupo (local, sem sync): quais memes já foram
    -- sorteados em cada grupo. Limpo quando o ciclo termina.
    CREATE TABLE IF NOT EXISTS meme_sends (
        group_jid TEXT NOT NULL,
        meme_id   INTEGER NOT NULL,
        sent_at   INTEGER NOT NULL,
        PRIMARY KEY (group_jid, meme_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meme_sends_group ON meme_sends(group_jid, sent_at DESC);
`);

// ============================================================
// Migrate esquemas legados — adiciona colunas se não existirem
// ============================================================
try { db.exec("ALTER TABLE group_state ADD COLUMN bot_name TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN menu_image TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN prefix TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN sticker_pack TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN sticker_author TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN theme TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE group_state ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'"); } catch (_) {}

// Antispam/antilink ON por padrão — migração única (idempotente via flag em config).
// Grupos que estavam com OFF explícito voltam a ON uma vez; admin pode desligar de novo.
try {
    const flagRow = db.prepare("SELECT value FROM config WHERE key = 'antispam_default_on_v1'").get();
    if (!flagRow || flagRow.value !== '1') {
        const a = db.prepare('UPDATE group_state SET antilink = 1 WHERE antilink = 0').run();
        const b = db.prepare('UPDATE antiflood_config SET enabled = 1 WHERE enabled = 0').run();
        db.prepare("INSERT INTO config (key, value) VALUES ('antispam_default_on_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
        console.log(`🛡️ [database] antispam padrão ON: antilink ${a.changes} grupo(s), antiflood ${b.changes} grupo(s)`);
    }
} catch (e) {
    console.error('[database] migração antispam_default_on_v1 falhou:', e?.message || e);
}

// Retenção do histórico: teto antigo (30k ≈ 2,5 dias no ritmo atual) ->
// 100k (≈ 7+ dias, mesma janela do dashboardHistoryHours). Só migra quem
// está exatamente no default antigo (não mexe em valor ajustado via !set).
try {
    const row = db.prepare("SELECT value FROM config WHERE key = 'dashboardMaxLogs'").get();
    if (row && Number(JSON.parse(row.value)) === 30000) {
        db.prepare("INSERT INTO config (key, value) VALUES ('dashboardMaxLogs', '100000') ON CONFLICT(key) DO UPDATE SET value = '100000'").run();
        console.log('🧹 [database] dashboardMaxLogs 30000 → 100000 (histórico ~7 dias)');
    }
} catch (e) {
    console.error('[database] migração dashboardMaxLogs falhou:', e?.message || e);
}

// Limpeza de órfãos — DEPOIS do CREATE TABLE (antes falhava em banco novo).
try {
    const removed = db.prepare(`
        DELETE FROM dashboard_logs
        WHERE message_id IS NULL OR message_id = ''
    `).run();
    if (removed.changes > 0) {
        console.log(`🧹 [database] limpou ${removed.changes} log(s) órffão(s) sem message_id`);
        try { db.pragma('incremental_vacuum(500)'); } catch (_) {}
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }
} catch (e) {
    console.error('[database] limpeza de órffãos falhou:', e?.message || e);
}

function checkpointWal() {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
}

module.exports = {
    db,
    dbPath,
    legacyDbPath,
    legacyMsgsPath,
    tempDir,
    checkpointWal
};
