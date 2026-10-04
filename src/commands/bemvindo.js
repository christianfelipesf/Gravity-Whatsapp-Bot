const HELP = '👋 *Bem-vindo* (só boas-vindas de entrada)\n\n' +
    '❌ Use:\n' +
    '!bemvindo on|off|msg <texto>|ver|teste\n\n' +
    'Variáveis: @user = marca a pessoa • {grupo} = nome do grupo\n' +
    'Saída, promoção, rebaixamento e mudanças: use !avisosgrupo';

const T = { onKey: 'welcomeOn', msgKey: 'welcomeMsg', label: 'Boas-vindas', mode: 'welcome', defMsg: '👋 Bem-vindo @user ao {grupo}!' };

const SAIR_WORDS = ['sair', 'saida', 'saída', 'despedida', 'bye', 'saídas', 'saidas'];

module.exports = {
    name: 'bemvindo',
    aliases: ['welcome', 'boasvindas', 'bv', 'boas-vindas', 'despedida', 'saida'],
    description: 'Configura as boas-vindas do grupo (só entrada).',
    category: 'admin',
    async execute(sock, m, { from, isGroup, sender, args, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        if (!isGroup) return await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });

        const admins = await utils.getAdmins(sock, from);
        if (!utils.isUserAdmin(sender, admins)) {
            return await sock.sendMessage(from, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
        }

        const parts = (args || []).map(s => String(s));
        if (parts.length === 0) return await sock.sendMessage(from, { text: HELP }, { quoted: m });

        // A saída mudou para os avisos — redireciona quem tentar o caminho antigo.
        if (SAIR_WORDS.includes(parts[0].toLowerCase())) {
            return await sock.sendMessage(from, { text: 'ℹ️ O aviso de saída agora fica em *!avisosgrupo*:\n!avisosgrupo saida on|off|msg|ver|teste' }, { quoted: m });
        }

        const gd = utils.getGroupData(from) || {};
        const sub = parts[0].toLowerCase();

        if (sub === 'ver' || sub === 'status') {
            const on = !!gd[T.onKey];
            const msg = (gd[T.msgKey] || '').toString();
            let cdTxt = '';
            try {
                const { getWelcomeRemainingMs } = require('../events/group');
                const rest = getWelcomeRemainingMs(from);
                if (rest > 0) {
                    const min = Math.ceil(rest / 60000);
                    cdTxt = `\n⏳ Cooldown: *~${min}min* restantes (anti-spam 40min)`;
                } else if (on) {
                    cdTxt = '\n✅ Pronta para enviar na próxima entrada (cooldown 40min livre)';
                }
            } catch (_) {}
            return await sock.sendMessage(from, { text: `👋 *Bem-vindo*\n\n• ${T.label}: ${on ? '🟢 ativa' : '🔴 desligada'}${cdTxt}\n${msg ? `Mensagem:\n${msg}` : `(padrão: ${T.defMsg})`}\n\n_Saída e outros avisos: !avisosgrupo ver_` }, { quoted: m });
        }
        if (sub === 'teste' || sub === 'testar' || sub === 'previa' || sub === 'prévia') {
            const { getTheme } = require('../services/themes');
            const { generateWelcomeImage, getUserAvatarBuffer, getGroupAvatarBuffer, resolveDisplayJid, formatPhoneDisplay } = require('../services/welcomeImage');
            const msg = (gd[T.msgKey] || '').toString().trim() || T.defMsg;
            let subject = 'o grupo';
            let memberCount = 0;
            let previewParts = [];
            try {
                const meta = await utils.groupMetadataCached(sock, from).catch(() => null);
                if (meta?.subject) subject = meta.subject;
                if (Array.isArray(meta?.participants)) { memberCount = meta.participants.length; previewParts = meta.participants; }
            } catch (_) {}
            const previewJid = resolveDisplayJid(sender, previewParts);
            // LID não resolvido: nunca exibe dígitos opacos (prévia é só demonstração).
            const previewIsLid = String(previewJid).toLowerCase().endsWith('@lid');
            const previewTag = previewIsLid ? '@você' : `@${String(previewJid).split('@')[0].split(':')[0]}`;
            const text = msg.split('@user').join(previewTag).split('{grupo}').join(subject);
            try {
                const digits = String(previewJid).split('@')[0].split(':')[0];
                const pushName = m.pushName || null;
                const userName = (pushName && !/^(usuário|usuario)?$/i.test(String(pushName).trim())) ? String(pushName).trim().slice(0, 26) : (!previewIsLid && /^\d{8,15}$/.test(digits) ? formatPhoneDisplay(digits) : 'Você');
                const [avatarRaw, groupAvatarRaw] = await Promise.all([
                    getUserAvatarBuffer(sock, sender, from, utils.groupMetadataCached, previewParts).catch(() => null),
                    getGroupAvatarBuffer(sock, from).catch(() => null)
                ]);
                let theme = null;
                try { theme = getTheme(typeof utils.getThemeForJid === 'function' ? utils.getThemeForJid(from) : 'default'); } catch (_) { theme = null; }
                const card = await generateWelcomeImage({
                    mode: T.mode,
                    userName,
                    groupName: subject,
                    memberCount,
                    message: text.replace(/@\S+/g, '').trim(),
                    avatarRaw,
                    groupAvatarRaw,
                    theme
                });
                if (card) {
                    return await sock.sendMessage(from, { image: card, caption: `👁️ *Prévia ${T.label}* — é assim que vai aparecer:\n\n${text}`, mentions: [...new Set([sender, previewJid])] }, { quoted: m });
                }
            } catch (_) {}
            return await sock.sendMessage(from, { text: `👁️ *Prévia ${T.label}*\n\n${text}`, mentions: [...new Set([sender, previewJid])] }, { quoted: m });
        }
        if (sub === 'on' || sub === 'ativar' || sub === 'ligar') {
            utils.setGroupData(from, { [T.onKey]: true });
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ ${T.label} ativada.\nPadrão: ${T.defMsg}` }, { quoted: m });
        }
        if (sub === 'off' || sub === 'desativar' || sub === 'desligar') {
            utils.setGroupData(from, { [T.onKey]: false });
            await utils.react(sock, m, '🔕', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `🔕 ${T.label} desativada.` }, { quoted: m });
        }
        if (sub === 'msg' || sub === 'mensagem' || sub === 'set' || sub === 'definir') {
            const texto = parts.slice(1).join(' ').trim();
            if (!texto) return await sock.sendMessage(from, { text: '❌ Informe a mensagem. Ex: !bemvindo msg Bem-vindo @user ao {grupo}! 👋' }, { quoted: m });
            if (texto.length > 500) return await sock.sendMessage(from, { text: '❌ Mensagem muito longa (máx. 500 caracteres).' }, { quoted: m });
            utils.setGroupData(from, { [T.msgKey]: texto, [T.onKey]: true });
            await utils.react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            return await sock.sendMessage(from, { text: `✅ ${T.label} salva e ativada:\n\n${texto}` }, { quoted: m });
        }
        return await sock.sendMessage(from, { text: HELP }, { quoted: m });
    }
};
