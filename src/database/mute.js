const MUTE_TTL_MS = 12 * 60 * 60 * 1000;

function createMuteHelpers({ getGroupState, upsertGroupState }) {
    function readMutedObj(jid) {
        try {
            const row = getGroupState(jid);
            if (!row) return {};
            const v = (() => { try { return JSON.parse(row.muted); } catch { return {}; } })();
            return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
        } catch (_) {
            return {};
        }
    }

    function writeMutedObj(jid, obj) {
        upsertGroupState(jid, JSON.stringify(obj || {}), null, null, null);
    }

    function cleanupMuted(jid, now = Date.now()) {
        const obj = readMutedObj(jid);
        const keys = Object.keys(obj);
        if (keys.length === 0) return false;
        let changed = false;
        for (const k of keys) {
            const ts = Number(obj[k]);
            if (!ts || now - ts >= MUTE_TTL_MS) {
                delete obj[k];
                changed = true;
            }
        }
        if (changed) writeMutedObj(jid, obj);
        return changed;
    }

    function cleanupAllMuted(allJids, now = Date.now()) {
        for (const jid of allJids) cleanupMuted(jid, now);
    }

    function isMuted(jid, participant) {
        if (!jid || !participant) return false;
        const obj = readMutedObj(jid);
        const ts = Number(obj[participant]);
        if (!ts) return false;
        if (Date.now() - ts >= MUTE_TTL_MS) {
            delete obj[participant];
            writeMutedObj(jid, obj);
            return false;
        }
        return true;
    }

    // Variante alias-aware: casa qualquer chave (telefone e/ou LID).
    // Use com identity.messageAliasKeys / identity.targetKeys.
    function isMutedAny(jid, participants) {
        if (!jid) return false;
        const keys = Array.isArray(participants) ? participants : [participants];
        for (const k of keys) {
            try { if (k && isMuted(jid, k)) return true; } catch (_) {}
        }
        return false;
    }

    function addMuted(jid, participant) {
        if (!jid || !participant) return false;
        const obj = readMutedObj(jid);
        const ts = Number(obj[participant]);
        const now = Date.now();
        if (ts && (now - ts) < MUTE_TTL_MS) return false;
        obj[participant] = now;
        writeMutedObj(jid, obj);
        return true;
    }

    function removeMuted(jid, participant) {
        if (!jid || !participant) return false;
        const obj = readMutedObj(jid);
        if (!(participant in obj)) return false;
        delete obj[participant];
        writeMutedObj(jid, obj);
        return true;
    }

    function listMuted(jid) {
        cleanupMuted(jid);
        return Object.keys(readMutedObj(jid));
    }

    function clearMuted(jid) {
        writeMutedObj(jid, {});
    }

    return { cleanupMuted, cleanupAllMuted, isMuted, isMutedAny, addMuted, removeMuted, listMuted, clearMuted, MUTE_TTL_MS };
}

module.exports = { createMuteHelpers };
