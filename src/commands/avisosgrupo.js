const HELP = '🔔 *Avisos do grupo* (só admins)\n\n' +
    'Use:\n' +
    '!avisosgrupo on — ativa os 4 avisos\n' +
    '!avisosgrupo off — desativa os 4 avisos\n' +
    '!avisosgrupo ver — mostra o que está ligado\n' +
    '!avisosgrupo <saida|promover|rebaixar|grupo> on|off — liga/desliga um aviso\n' +
    '!avisosgrupo <saida|promover|rebaixar|grupo> msg <texto> — troca o texto\n' +
    '!avisosgrupo <saida|promover|rebaixar|grupo> ver — vê o texto atual\n' +
    '!avisosgrupo teste — prévia dos 4 cards\n' +
    '!avisosgrupo <saida|promover|rebaixar|grupo> teste — prévia de um aviso\n\n' +
    'Ex:\n' +
    '!avisosgrupo saida on\n' +
    '!avisosgrupo promover on\n\n' +
    'Variáveis: @user = quem recebeu a ação • {autor} = quem fez a ação (promover/rebaixar) • {grupo} = nome do grupo • {mudancas} = o que mudou (só p/ grupo)';

// Saída, promoção, rebaixamento e mudanças — boas-vindas ficam no !bemvindo.
const TARGETS = {
    saida: { onKey: 'goodbyeOn', msgKey: 'goodbyeMsg', label: 'Saída (despedida) 👋', defMsg: '👋 @user saiu do grupo. Até mais!' },
    promover: { onKey: 'promoteOn', msgKey: 'promoteMsg', label: 'Promoção a admin 👑', defMsg: '👑 {autor} promoveu @user a admin do {grupo}! 🎉' },
    rebaixar: { onKey: 'demoteOn', msgKey: 'demoteMsg', label: 'Rebaixamento 📉', defMsg: '📉 {autor} rebaixou @user de admin do {grupo}.' },
    grupo: { onKey: 'groupChangeOn', msgKey: 'groupChangeMsg', label: 'Mudanças do grupo ⚙️', defMsg: '📝 Título atualizado' }
};
const ALL_KEYS = ['goodbyeOn', 'promoteOn', 'demoteOn', 'groupChangeOn'];

function parseTarget(s) {
    s = String(s || '').toLowerCase();
    if (['saida', 'saída', 'sair', 'despedida', 'bye'].includes(s)) return 'saida';
    if (['promover', 'promovido', 'promo', 'promocao', 'promoção'].includes(s)) return 'promover';
    if (['rebaixar', 'rebaixado', 'demote'].includes(s)) return 'rebaixar';
    if (['grupo', 'mudanca', 'mudança', 'mudancas', 'mudanças'].includes(s)) return 'grupo';
    return null;
}

const MODE_OF = { saida: 'goodbye', promover: 'promote', rebaixar: 'demote', grupo: 'groupchange' };

async function sendPreview(sock, m, utils, from, sender, target) {
    const { getTheme } = require('../services/themes');
    const { generateWelcomeImage, getUserAvatarBuffer, getGroupAvatarBuffer, resolveDisplayJid, formatPhoneDisplay } = require('../services/welcomeImage');
    const T = TARGETS[target];
    const gd = utils.getGroupData(from) || {};
    const msg = (gd[T.msgKey] || '').toString().trim() || T.defMsg;
    let subject = 'o grupo';
    let memberCount = 0;
    let previewParts = [];
    try {
        const meta = await utils.groupMetadataCached(sock, from).catch(() => null);
        if (meta?.subject) subject = meta.subject;
        if (Array.isArray(meta?.participants)) { memberCount = meta.participants.length; previewParts = meta.participants; }
    } catch (_) {}
    const fakeChanges = '📝 Novo nome: *Exemplo*\n📄 Nova descrição: exemplo';
    const previewJid = resolveDisplayJid(sender, previewParts);
    const isActorMode = target === 'promover' || target === 'rebaixar';
    // LID não resolvido: nunca exibe dígitos opacos (prévia é só demonstração).
    const previewIsLid = String(previewJid).toLowerCase().endsWith('@lid');
    const previewTag = previewIsLid ? '@você' : `@${String(previewJid).split('@')[0].split(':')[0]}`;
    const text = msg.split('@user').join(previewTag).split('{autor}').join(previewTag).split('{grupo}').join(subject).split('{mudancas}').join(fakeChanges);
    try {
        const digits = String(previewJid).split('@')[0].split(':')[0];
        const pushName = m.pushName || null;
        const isGroup = target === 'grupo';
        const userName = isGroup ? subject.slice(0, 24)
            : ((pushName && !/^(usuário|usuario)?$/i.test(String(pushName).trim())) ? String(pushName).trim().slice(0, 26) : (!previewIsLid && /^\d{8,15}$/.test(digits) ? formatPhoneDisplay(digits) : 'Você'));
        const [avatarRaw, groupAvatarRaw] = await Promise.all([
            isGroup ? Promise.resolve(null) : getUserAvatarBuffer(sock, sender, from, utils.groupMetadataCached, previewParts).catch(() => null),
            getGroupAvatarBuffer(sock, from).catch(() => null)
        ]);
        // Prévia: o próprio admin como autor da ação (demonstra o layout dual).
        const previewActorAvatar = (!isGroup && isActorMode)
            ? await getUserAvatarBuffer(sock, sender, from, utils.groupMetadataCached, previewParts).catch(() => null)
            : null;
        let theme = null;
        try { theme = getTheme(typeof utils.getThemeForJid === 'function' ? utils.getThemeForJid(from) : 'default'); } catch (_) { theme = null; }
        const card = await generateWelcomeImage({
            mode: MODE_OF[target],
            userName,
            actorName: isActorMode ? userName : null,
            groupName: subject,
            memberCount,
            message: text.replace(/@\S+/g, '').trim(),
            avatarRaw: isGroup ? groupAvatarRaw : avatarRaw,
            actorAvatarRaw: previewActorAvatar,
            groupAvatarRaw,
            theme
        });
        if (card) {
            await sock.sendMessage(from, { image: card, caption: `👁️ *Prévia ${T.label}* — é assim que vai aparecer:\n\n${text}`, mentions: [...new Set([sender, previewJid])] }, { quoted: m });
            return;
        }
    } catch (_) {}
    await sock.sendMessage(from, { text: `👁️ *Prévia ${T.label}*\n\n${text}`, mentions: [...new Set([sender, previewJid])] }, { quoted: m });
}

module.exports = {
    name: 'avisosgrupo',
    aliases: ['avisos-grupo', 'avisogrupo', 'avisosgp', 'avisos', 'aviso'],
    description: 'Liga/desliga os avisos do grupo (saída, promoção, rebaixamento, mudanças).',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, args, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        if (!utils.isUserAdmin(sender, admins)) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        const parts = (args || []).map(s => String(s));
        const gd = utils.getGroupData(from) || {};

        // sem argumento ou "ver" -> status (os 4 avisos)
        if (parts.length === 0 || ['ver', 'status', 'info', 'listar'].includes((parts[0] || '').toLowerCase())) {
            const st = (k) => (gd[k] ? '🟢 ligado' : '🔴 desligado');
            const text = '🔔 *Avisos do grupo*\n\n' +
                `• Saída: ${st('goodbyeOn')}\n` +
                `• Promoção: ${st('promoteOn')}\n` +
                `• Rebaixamento: ${st('demoteOn')}\n` +
                `• Mudanças: ${st('groupChangeOn')}\n\n` +
                '_Para mudar: !avisosgrupo on|off ou !avisosgrupo <aviso> on|off_\n' +
                '_Boas-vindas: !bemvindo ver_';
            return await sock.sendMessage(from, { text }, { quoted: m });
        }

        // !avisosgrupo on|off -> os 4 avisos (não toca no bemvindo)
        const first = parts[0].toLowerCase();
        if (first === 'on' || first === 'ativar' || first === 'ligar' || first === 'ativar-tudo') {
            const patch = {};
            for (const k of ALL_KEYS) patch[k] = true;
            utils.setGroupData(from, patch);
            await utils.react(sock, m, '🔔', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: '✅ *Avisos do grupo ativados!* 🔔\nSaída, promoção, rebaixamento e mudanças vão aparecer com card.\n_(O !bemvindo não foi alterado.)_' }, { quoted: m });
        }
        if (first === 'off' || first === 'desativar' || first === 'desligar') {
            const patch = {};
            for (const k of ALL_KEYS) patch[k] = false;
            utils.setGroupData(from, patch);
            await utils.react(sock, m, '🔕', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: '🔕 *Avisos do grupo desativados.*\n_(O !bemvindo não foi alterado.)_' }, { quoted: m });
        }

        // !avisosgrupo teste -> prévia dos 4 cards (não altera nada)
        if (['teste', 'testar', 'previa', 'prévia', 'preview'].includes(first)) {
            for (const k of Object.keys(TARGETS)) {
                await sendPreview(sock, m, utils, from, sender, k);
            }
            return;
        }

        // !avisosgrupo <alvo> on|off|msg|ver|teste
        const target = parseTarget(parts[0]);
        if (!target) return await sock.sendMessage(from, { text: HELP }, { quoted: m });
        const T = TARGETS[target];
        const sub = (parts[1] || '').toLowerCase();
        if (sub === 'teste' || sub === 'testar' || sub === 'previa' || sub === 'prévia' || sub === 'preview') {
            await sendPreview(sock, m, utils, from, sender, target);
            return;
        }
        if (sub === 'on' || sub === 'ativar' || sub === 'ligar') {
            utils.setGroupData(from, { [T.onKey]: true });
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ ${T.label} *ativado.*\nPadrão: ${T.defMsg}` }, { quoted: m });
        }
        if (sub === 'off' || sub === 'desativar' || sub === 'desligar') {
            utils.setGroupData(from, { [T.onKey]: false });
            await utils.react(sock, m, '🔕', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `🔕 ${T.label} *desativado.*` }, { quoted: m });
        }
        if (sub === 'ver' || sub === 'status') {
            const on = !!gd[T.onKey];
            const msg = (gd[T.msgKey] || '').toString();
            return await sock.sendMessage(from, { text: `${T.label}: ${on ? '🟢 ativado' : '🔴 desativado'}\n${msg ? `Mensagem:\n${msg}` : `(padrão: ${T.defMsg})`}` }, { quoted: m });
        }
        if (sub === 'msg' || sub === 'mensagem' || sub === 'set' || sub === 'definir') {
            const texto = parts.slice(2).join(' ').trim();
            if (!texto) return await sock.sendMessage(from, { text: `❌ Informe a mensagem. Ex: !avisosgrupo ${target} msg ${T.defMsg}` }, { quoted: m });
            if (texto.length > 500) return await sock.sendMessage(from, { text: '❌ Mensagem muito longa (máx. 500 caracteres).' }, { quoted: m });
            utils.setGroupData(from, { [T.msgKey]: texto, [T.onKey]: true });
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ ${T.label} salvo e ativado:\n\n${texto}` }, { quoted: m });
        }
        return await sock.sendMessage(from, { text: HELP }, { quoted: m });
    }
};
