module.exports = {
    name: 'add',
    aliases: ['adicionar', 'addmember', 'adicionarmembro'],
    description: 'Adiciona um membro ao grupo pelo número. Ex: !add 5511999999999 (!add +55 13 93631-2912 também funciona)',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, args, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        if (!utils.isUserAdmin(sender, admins)) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }
        if (!utils.isUserAdmin(sock.user.id, admins)) {
            return await sock.sendMessage(from, { text: '❌ Eu preciso ser administrador para adicionar membros.' }, { quoted: m });
        }

        // Aceita qualquer formatação: "!add +55 13 93631-2912", "!add (13) 93631-2912",
        // "!add 13 93631-2912", "!add 5513936312912". O normalizador extrai os
        // dígitos do texto inteiro e completa o DDI 55 quando vier só DDD+número.
        // Dígitos de LID colado são convertidos p/ o telefone real (ver identity).
        let raw = utils.normalizePhoneNumber(fullArgsText || (args || []).join(' '), { min: 10 });
        if (!raw) {
            return await sock.sendMessage(from, { text: '❌ Use: !add 5511999999999 (aceita +55, espaços, traços e parênteses — ex: !add +55 13 93631-2912).' }, { quoted: m });
        }
        try {
            const identity = require('../services/identity');
            const r = await identity.resolveCandidateToPhone(sock, utils, raw, from);
            if (r.phone) raw = r.phone;
        } catch (_) {}
        const jid = `${raw}@s.whatsapp.net`;

        try {
            const meta = await utils.groupMetadataCached(sock, from).catch(() => null);
            const parts = Array.isArray(meta?.participants) ? meta.participants : [];
            const identity = require('../services/identity');
            const exists = parts.some(p => {
                const fields = [p.id, p.jid, p.lid, p.phoneNumber, p.pn].filter(Boolean).map(String);
                const digs = fields.map(identity.digitsOf).filter(Boolean);
                return digs.includes(raw) || digs.some(d => d.endsWith(raw.slice(-11)));
            });
            if (exists) {
                return await sock.sendMessage(from, { text: 'ℹ️ Este número já está no grupo.' }, { quoted: m });
            }
        } catch (_) {}

        if (utils.isUserAdmin(jid, admins)) {
            return await sock.sendMessage(from, { text: 'ℹ️ Este usuário já está no grupo como admin.' }, { quoted: m });
        }

        // ACK imediato: o groupParticipantsUpdate do WhatsApp pode levar 10-30s
        // (privacidade, número inexistente). Sem isso o bot parece travado e os
        // outros comandos demoram junto na percepção do usuário.
        try { await sock.sendMessage(from, { text: `⏳ Adicionando @${raw}...`, mentions: [jid] }, { quoted: m }); } catch (_) {}

        // Falha rápida p/ número inexistente no WhatsApp (best-effort, 8s).
        // Se o onWhatsApp falhar/timeout, segue para o add normalmente.
        try {
            if (typeof sock.onWhatsApp === 'function') {
                const check = await Promise.race([
                    sock.onWhatsApp(raw).catch(() => null),
                    new Promise(r => setTimeout(() => r(null), 8000))
                ]);
                const arr = Array.isArray(check) ? check : (check ? [check] : null);
                if (arr && arr[0] && arr[0].exists === false) {
                    return await sock.sendMessage(from, { text: `❌ O número @${raw} não existe no WhatsApp. Confira o DDI+DDD.`, mentions: [jid] }, { quoted: m });
                }
            }
        } catch (_) {}

        // Timeout próprio (25s): nunca deixa o handler pendurado até o
        // CMD_TIMEOUT de 90s — o bot segue respondendo outros comandos.
        const withTimeout = (p, ms) => Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('add-timeout')), ms))
        ]);

        try {
            const res = await withTimeout(sock.groupParticipantsUpdate(from, [jid], 'add'), 25000);
            if (typeof utils.clearGroupMetadataCache === 'function') utils.clearGroupMetadataCache(from);
            const status = Array.isArray(res) ? res[0]?.status : res?.[0]?.status;
            if (status && String(status) !== '200') {
                return await sock.sendMessage(from, { text: '⚠️ Não consegui adicionar diretamente (o usuário pode ter privacidade restrita ou ter saído recentemente). Envie o link do grupo para ele.' }, { quoted: m });
            }
        } catch (e) {
            if (String(e?.message || '').includes('add-timeout')) {
                return await sock.sendMessage(from, { text: '⏱️ O WhatsApp demorou demais para responder. Tente de novo em alguns segundos — se persistir, envie o link do grupo.' }, { quoted: m });
            }
            return await sock.sendMessage(from, { text: '⚠️ Não consegui adicionar. Ele pode ter ativado a privacidade ou saído há pouco tempo — envie o link do grupo.' }, { quoted: m });
        }

        try { utils.recordModEvent(from, 'join'); } catch (_) {}
        await utils.reactStatus(sock, m, from, true, '✅', '❌', lastBotResponse, GLOBAL_COOLDOWN);
        return await sock.sendMessage(from, { text: `✅ @${raw} adicionado ao grupo.`, mentions: [jid] }, { quoted: m });
    }
};
