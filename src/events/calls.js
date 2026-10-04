// src/events/calls.js — rejeita ligações 1:1 (voz/vídeo) em silêncio.
// Motivo: o bot roda no número do dono — toda chamada toca no celular dele.
// Sem mensagem de volta (decisão do dono): só log no terminal.
// Chamada de grupo NÃO tem rejeição via API Baileys — essas continuam
// tocando; mitigação é silenciar o grupo no aparelho.
function registerCallHandler(sock) {
    if (!sock?.ev?.on) return false;
    try {
        sock.ev.on('call', async (calls) => {
            try {
                let cfg = null;
                try { cfg = require('../database/utils').readConfig(); } catch (_) {}
                if (cfg && cfg.rejectCalls === false) return;
                const list = Array.isArray(calls) ? calls : [calls];
                for (const call of list) {
                    try {
                        if (!call || call.status !== 'offer') continue;
                        if (call.isGroup === true || call.isVideo === undefined) {
                            // Grupo: sem API de reject — ignora (não quebra).
                            if (call.isGroup === true) continue;
                        }
                        const id = call.id || call.callId;
                        const from = call.from || call.chatId;
                        if (!id || !from) continue;
                        // Nunca rejeita o próprio aparelho.
                        if (call.fromMe === true) continue;
                        try {
                            if (typeof sock.rejectCall === 'function') {
                                await sock.rejectCall(id, from);
                                console.log(`📵 [calls] ligação 1:1 rejeitada em silêncio (de=${String(from).split('@')[0]})`);
                            }
                        } catch (e) {
                            console.warn(`⚠️ [calls] falha ao rejeitar (${String(e?.message || e).slice(0, 120)})`);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        });
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = { registerCallHandler };
