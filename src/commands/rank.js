const axios = require('axios');
const { generateRankImage } = require('../services/rankImage');
const { getTheme, themeBullets } = require('../services/themes');

module.exports = {
    name: 'rank',
    aliases: ['rankativos', 'rankmensal', 'topativos', 'top10', 'ranking'],
    category: 'geral',
    description: 'Rank mensal dos 10 mais ativos — reseta todo dia 1',
    async execute(sock, m, { from, isGroup, sender, config, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getBotName, getMonthlyRank, isActiveGroup, isPartialActive, groupMetadataCached, _getCurrentMonthKey, _getMonthLabelBr, getGroupData, getThemeForJid } = utils;

        const themeId = (typeof getThemeForJid === 'function' ? getThemeForJid(from) : ((getGroupData(from).theme) || 'default'));
        const theme = getTheme(themeId);

        let currentBotResponse = await react(sock, m, theme.rankReact || '🏆', lastBotResponse, GLOBAL_COOLDOWN);

        if (!isGroup) {
            await sock.sendMessage(from, { text: `${theme.err || '❌'} Este comando só funciona em grupos.` }, { quoted: m });
            return currentBotResponse;
        }

        const isActive = isActiveGroup(from);
        const isPartial = isPartialActive(from);
        if (!isActive && !isPartial) {
            await sock.sendMessage(from, { text: `${theme.err || '❌'} Este grupo não está ativo.\nUse *${config.prefix}ativar* (dono) ou *${config.prefix}ativarp* para ativar.` }, { quoted: m });
            await react(sock, m, theme.err || '❌', currentBotResponse, GLOBAL_COOLDOWN);
            return currentBotResponse;
        }

        const botName = getBotName(from, config);
        const monthKey = _getCurrentMonthKey ? _getCurrentMonthKey() : new Date().toISOString().slice(0, 7);
        const monthLabel = _getMonthLabelBr ? _getMonthLabelBr(monthKey) : monthKey;

        let groupName = 'Grupo';
        try {
            const meta = await groupMetadataCached(sock, from);
            groupName = meta?.subject || groupName;
        } catch (_) {}

        const ranking = getMonthlyRank(from, 10);

        // Foto do grupo p/ cabeçalho (igual ao rankglobal faz com os top 3 grupos)
        let groupAvatar = null;
        try {
            const url = await sock.profilePictureUrl(from, 'image').catch(() => null);
            if (url) {
                const res = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 5000,
                    maxContentLength: 2 * 1024 * 1024,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                }).catch(() => null);
                if (res?.data) {
                    const buf = Buffer.from(res.data);
                    if (buf.length >= 100 && buf.length <= 2 * 1024 * 1024) groupAvatar = buf;
                }
            }
        } catch (_) { groupAvatar = null; }

        // Busca fotos de perfil para os top 10 (resolve @lid -> @s.whatsapp.net quando necessário)
        let rankingWithAvatar = ranking;
        if (ranking.length > 0) {
            let groupMetaForAvatars = null;
            try { groupMetaForAvatars = await groupMetadataCached(sock, from); } catch(_) {}
            const participants = Array.isArray(groupMetaForAvatars?.participants) ? groupMetaForAvatars.participants : [];

            function findPhoneForJid(jid){
                if (!jid) return null;
                const norm = String(jid).split('@')[0].split(':')[0];
                for (const p of participants){
                    const cands = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean);
                    for (const c of cands){
                        const cn = String(c).split('@')[0].split(':')[0];
                        if (cn === norm){
                            // retorna o id @s.whatsapp.net se existir
                            if (p.id && p.id.endsWith('@s.whatsapp.net')) return p.id;
                            if (p.jid && p.jid.endsWith('@s.whatsapp.net')) return p.jid;
                            if (p.phoneNumber && String(p.phoneNumber).includes('@')) return String(p.phoneNumber);
                            // se só tem lid, retorna o próprio lid
                            return p.id || p.jid || p.lid || null;
                        }
                    }
                    // comparação direta lid
                    if (p.lid === jid || p.id === jid) {
                        if (p.id && p.id.endsWith('@s.whatsapp.net')) return p.id;
                        if (p.phoneNumber) return String(p.phoneNumber);
                    }
                }
                return null;
            }

            async function fetchAvatarBuffer(jid){
                // tenta jid original + jid resolvido
                const tries = [];
                if (jid) tries.push(jid);
                const phone = findPhoneForJid(jid);
                if (phone && phone !== jid) tries.push(phone);
                // também tenta lid -> phone inverso
                if (jid && jid.endsWith('@lid') && phone) {
                    // já tem
                } else if (jid && jid.endsWith('@s.whatsapp.net')) {
                    // tenta achar lid correspondente e usar? profilePictureUrl aceita ambos, mas tenta lid também
                    const lidCand = participants.find(pp => (pp.id===jid || pp.jid===jid))?.lid;
                    if (lidCand) tries.push(lidCand);
                }
                for (const t of tries){
                    try{
                        const url = await sock.profilePictureUrl(t, 'image').catch(()=>null);
                        if (!url) continue;
                        const res = await axios.get(url, {
                            responseType: 'arraybuffer',
                            timeout: 5000,
                            maxContentLength: 2 * 1024 * 1024,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        }).catch(()=>null);
                        if (!res || !res.data) continue;
                        const buf = Buffer.from(res.data);
                        if (buf.length < 100 || buf.length > 2*1024*1024) continue;
                        return buf;
                    }catch(_){ continue; }
                }
                return null;
            }

            try {
                const avatarResults = await Promise.all(ranking.map(async (u) => {
                    const jid = u.jid;
                    if (!jid) return { ...u, avatar: null };
                    const buf = await fetchAvatarBuffer(jid);
                    return { ...u, avatar: buf };
                }));
                rankingWithAvatar = avatarResults;
                // log para debug de quantos avatares reais pegou
                try{
                    const ok = rankingWithAvatar.filter(x=>x.avatar).length;
                    console.log(`[RANK] avatares ${ok}/${ranking.length} obtidos (lid resolvido via groupMetadata ${participants.length} participants)`);
                }catch(_){}
            } catch (_) {
                rankingWithAvatar = ranking;
            }
        }

        // Texto fallback curto para caption (título sempre genérico — slogan fica só no !tema)
        let caption = `*${botName} — Rank Mensal* ${theme.rankIcon || '🏆'}\n_top 10 mais ativos_\n\n`;
        caption += `${theme.bullet || '📅'} *Mês:* ${monthLabel} (${monthKey})\n`;
        caption += `👥 *Grupo:* ${groupName}\n`;
        caption += `${isPartial ? '🟡 *Modo:* Parcial (subativo)\n' : '🟢 *Modo:* Ativo\n'}`;
        caption += `🔄 *Reseta:* todo dia 1\n`;
        caption += `────────────────\n`;
        if (!ranking || ranking.length === 0) {
            caption += `\n_Nenhum registro este mês. Envie mensagens para aparecer aqui!_\n`;
        } else {
            const medals = ['🥇', '🥈', '🥉'];
            ranking.forEach((u, i) => {
                const medal = i < 3 ? medals[i] : `*${i + 1}º*`;
                const label = u.count === 1 ? '1 msg' : `${u.count} msgs`;
                caption += `${medal} ${u.name} — ${label}\n`;
            });
            if (ranking.length < 10) caption += `\n_Faltam ${10 - ranking.length} posições para completar o top 10._\n`;
        }
        caption += `\n_Use ${config.prefix}rank ou ${config.prefix}rankativos para ver a imagem._`;

        // Gera imagem (com avatares se tiver)
        try {
            const imgBuffer = await generateRankImage({
                groupName,
                botName,
                monthLabel,
                ranking: rankingWithAvatar,
                monthKey,
                theme,
                groupAvatar
            });
            await sock.sendMessage(from, { image: imgBuffer, caption }, { quoted: m });
            currentBotResponse = await react(sock, m, theme.ok || '✅', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            console.error('❌ [rank] falha ao gerar imagem:', e.message);
            // Fallback apenas texto
            await sock.sendMessage(from, { text: caption }, { quoted: m });
            currentBotResponse = await react(sock, m, '⚠️', currentBotResponse, GLOBAL_COOLDOWN);
        }

        return currentBotResponse;
    }
};
