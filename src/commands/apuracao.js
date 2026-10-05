const axios = require('axios');
const apuracao = require('../services/apuracao');
const { generateApuracaoImage } = require('../services/apuracaoImage');

// NOTA: o alias `!votacao` já pertence ao comando !enquete (enquete nativa).
// Este comando usa !apuracao (+ !eleicao, !presidentes, !urnas, ...).
module.exports = {
    name: 'apuracao',
    aliases: ['eleicao', 'eleicoes', 'eleicao2026', 'apuracao2026', 'presidente', 'presidentes', 'urnas'],
    category: 'geral',
    description: 'Apuração da eleição presidencial em tempo real (TSE) — !apuracao [UF]',
    async execute(sock, m, { from, isGroup, config, utils, fullArgsText, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, getBotName, isActiveGroup, isPartialActive } = utils;

        let currentBotResponse = await react(sock, m, '🗳️', lastBotResponse, GLOBAL_COOLDOWN);

        if (!isGroup) {
            await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
            return currentBotResponse;
        }

        const isActive = isActiveGroup(from);
        const isPartial = isPartialActive(from);
        if (!isActive && !isPartial) {
            await sock.sendMessage(from, { text: `❌ Este grupo não está ativo.\nUse *${config.prefix}ativar* (dono) ou *${config.prefix}ativarp* para ativar.` }, { quoted: m });
            await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
            return currentBotResponse;
        }

        // UF opcional: !apuracao | !apuracao sp | !eleicao rj
        const rawArg = String(fullArgsText || '').trim().split(/\s+/).filter(Boolean)[0] || 'br';
        const uf = rawArg.toLowerCase();

        const botName = getBotName(from, config);

        let turno;
        let data;
        try {
            const res = await apuracao.fetchApuracaoAuto(uf, undefined);
            turno = res.turno;
            data = res.data;
        } catch (e) {
            if (e && e.code === 'UF_INVALIDA') {
                await sock.sendMessage(from, { text: `❌ UF inválida: *${rawArg.slice(0, 10)}*.\n💡 Use *${config.prefix}apuracao* (Brasil) ou *${config.prefix}apuracao <UF>* — ex: *${config.prefix}apuracao sp*` }, { quoted: m });
                return currentBotResponse;
            }
            if (e && e.code === 'NAO_INICIOU') {
                await sock.sendMessage(from, {
                    text: `🗳️ *APURAÇÃO — PRESIDENTE 2026*\n_${turnoLabelFallback()} — ${abbrFallback(uf)}_\n\n⏳ A totalização ainda não começou.\n📢 A divulgação do TSE começa a partir das *17h (horário de Brasília)*.\n\n💡 Tente novamente após as 17h com *${config.prefix}apuracao*.`
                }, { quoted: m });
                return currentBotResponse;
            }
            console.error('❌ [apuracao] falha ao buscar TSE:', e && e.message);
            await sock.sendMessage(from, { text: '❌ Não consegui buscar a apuração no TSE agora. Tente novamente em 1 minuto.' }, { quoted: m });
            await react(sock, m, '⚠️', currentBotResponse, GLOBAL_COOLDOWN);
            return currentBotResponse;
        }

        // Fotos oficiais (sqcand) — igual ao !rank faz com foto de perfil
        let candsComAvatar = data.candidatos;
        try {
            const results = await Promise.all(data.candidatos.map(async (c) => {
                if (!c.foto) return { ...c, avatar: null };
                try {
                    const res = await axios.get(c.foto, {
                        responseType: 'arraybuffer',
                        timeout: 6000,
                        maxContentLength: 2 * 1024 * 1024,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    }).catch(() => null);
                    if (!res || !res.data) return { ...c, avatar: null };
                    const buf = Buffer.from(res.data);
                    if (buf.length < 100 || buf.length > 2 * 1024 * 1024) return { ...c, avatar: null };
                    return { ...c, avatar: buf };
                } catch (_) {
                    return { ...c, avatar: null };
                }
            }));
            candsComAvatar = results;
        } catch (_) { /* segue sem fotos */ }

        const withFmt = candsComAvatar.map((c) => ({ ...c, votosFmt: apuracao.fmtInt(c.votos) }));

        // Caption curta: cabeçalho + TOP 3 em texto + totais.
        // (a lista completa aparece na imagem).
        function buildCaption() {
            const medals = ['🥇', '🥈', '🥉'];
            let t = `*${botName} — APURAÇÃO PRESIDENTE 2026* 🗳️\n_${data.abrangenciaNome} • ${turno}º turno_\n\n`;
            t += `🏛️ *Urnas apuradas:* ${data.secoes.pct}% (${apuracao.fmtInt(data.secoes.apuradas)} de ${apuracao.fmtInt(data.secoes.total)})\n`;
            t += `🕒 *Atualizado:* ${data.atualizacao || '—'} (TSE)\n`;
            t += `────────────────\n`;
            withFmt.slice(0, 3).forEach((c, i) => {
                t += `${medals[i]} ${c.nomeUrna} (${c.numero}${c.partido ? '/' + c.partido : ''}) — *${c.pct}%* • ${c.votosFmt} votos\n`;
            });
            t += `────────────────\n`;
            t += `✔️ Válidos: ${apuracao.fmtInt(data.votos.validos)} • ⚪ Brancos: ${apuracao.fmtInt(data.votos.brancos)} (${data.votos.brancosPct}%) • ❌ Nulos: ${apuracao.fmtInt(data.votos.nulos)} (${data.votos.nulosPct}%)\n`;
            t += `\n_Fonte: TSE • Use ${config.prefix}apuracao ou ${config.prefix}apuracao <UF> para atualizar._`;
            return t;
        }

        // Fallback completo (só se a imagem falhar): inclui a lista em texto,
        // senão o usuário ficaria sem ver os candidatos.
        function buildFallbackText() {
            const medals = ['🥇', '🥈', '🥉'];
            let t = buildCaption() + `\n────────────────\n`;
            withFmt.forEach((c, i) => {
                const medal = i < 3 ? medals[i] : `*${i + 1}º*`;
                t += `${medal} ${c.nomeUrna} (${c.numero}${c.partido ? '/' + c.partido : ''}) — *${c.pct}%* • ${c.votosFmt} votos\n`;
            });
            return t;
        }

        try {
            let theme = null;
            try {
                const { getTheme } = require('../services/themes');
                const tid = typeof utils.getThemeForJid === 'function' ? utils.getThemeForJid(from) : 'default';
                theme = getTheme(tid);
            } catch (_) { theme = null; }
            const img = await generateApuracaoImage({
                candidatos: withFmt,
                turno,
                abrangenciaNome: data.abrangenciaNome,
                secoesPct: data.secoes.pct,
                secoesPctNum: data.secoes.pctNum,
                secoesApuradasFmt: apuracao.fmtInt(data.secoes.apuradas),
                secoesTotalFmt: apuracao.fmtInt(data.secoes.total),
                atualizacao: data.atualizacao,
                finalizada: data.finalizada,
                botName,
                theme,
                resumo: {
                    validos: apuracao.fmtInt(data.votos.validos),
                    brancos: apuracao.fmtInt(data.votos.brancos),
                    brancosPct: data.votos.brancosPct,
                    nulos: apuracao.fmtInt(data.votos.nulos),
                    nulosPct: data.votos.nulosPct
                }
            });
            await sock.sendMessage(from, { image: img, caption: buildCaption() }, { quoted: m });
            currentBotResponse = await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            console.error('❌ [apuracao] falha ao gerar imagem:', e.message);
            await sock.sendMessage(from, { text: buildFallbackText() }, { quoted: m });
            currentBotResponse = await react(sock, m, '⚠️', currentBotResponse, GLOBAL_COOLDOWN);
        }

        return currentBotResponse;

        function turnoLabelFallback() {
            return '1º turno';
        }
        function abbrFallback(u) {
            return String(u || 'br').toUpperCase();
        }
    }
};
