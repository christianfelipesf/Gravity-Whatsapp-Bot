const subSessions = require('../services/subSessions');
const principalState = require('../services/principalState');
const { sanitizeUserText } = require('../services/safeDebug');

function normalizePhone(input) {
    if (!input) return null;
    try {
        const utils = require('../database/utils');
        if (typeof utils.normalizePhoneNumber === 'function') return utils.normalizePhoneNumber(input);
    } catch (_) {}
    const digits = String(input).replace(/\D/g, '');
    if (!digits) return null;
    return digits;
}

module.exports = {
    name: 'login',
    aliases: ['entrar', 'conectar'],
    category: 'admin',
    description: 'Conecta uma sub-sessão Baileys (QR Code ou código de pareamento). Só inicia depois do bot principal.',
    async execute(sock, m, { from, isGroup, sender, fullArgsText, utils, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react } = utils;
        const ownerJid = sender;

        const existing = subSessions.getSession(ownerJid);
        if (existing?.connected) {
            await sock.sendMessage(from, {
                text: '⚠️ Você já tem uma sub-sessão ativa.\nUse !logoff ou !sair para encerrar.'
            }, { quoted: m });
            return await react(sock, m, '⚠️', lastBotResponse, GLOBAL_COOLDOWN);
        }

        const perm = utils.canUseLogin(sock, m, sender, from);
        if (!perm.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono do bot pode usar este comando.\n💡 Peça ao dono para liberar seu número com !addlogin.' }, { quoted: m });
        }
        // Autorizados (não-dono) só podem usar no privado
        if (!perm.owner && isGroup) {
            return await sock.sendMessage(from, { text: '❌ Use o !login apenas no privado do bot.' }, { quoted: m });
        }

        const rawArg = normalizePhone(fullArgsText);
        // LID colado não serve para pareamento: tenta converter p/ telefone real.
        // Se tem cara de LID (>=14 dígitos) e não resolve, avisa em vez de falhar mudo.
        let phoneArg = rawArg;
        if (rawArg) {
            try {
                const identity = require('../services/identity');
                const r = await identity.resolveCandidateToPhone(sock, utils, rawArg, isGroup ? from : null);
                if (r.phone && r.phone !== rawArg) phoneArg = r.phone;
                else if (rawArg.length >= 14 && !r.resolvedFromLid) phoneArg = null;
            } catch (_) {}
        }
        if (rawArg && !phoneArg) {
            return await sock.sendMessage(from, { text: '❌ Isso parece um ID interno (@lid), não um número de telefone.\n\n💡 Digite o número com DDI+DDD: *!login 5511999999999*' }, { quoted: m });
        }
        const usePairing = !!phoneArg;

        let currentBotResponse = await react(sock, m, '🔐', lastBotResponse, GLOBAL_COOLDOWN);

        const principalOnline = principalState.getState().connected;
        if (usePairing) {
            await sock.sendMessage(from, {
                text: `🔐 *Sub-sessão na fila…*\n\n📞 *Número:* \`${phoneArg}\`\n📲 *Modo:* código de pareamento\n${principalOnline ? '✅ Bot principal online — iniciando (1 login por vez).' : '⏳ Bot principal ainda offline — vou esperar ele conectar (até 90s) e inicio sozinho.'}\n\nVou gerar um *código de 8 dígitos*. Use \`!subcancel\` para sair da fila.`
            }, { quoted: m });
        } else {
            await sock.sendMessage(from, {
                text: `🔐 *Sub-sessão na fila…*\n\n${principalOnline ? '✅ Bot principal online — gerando QR (1 login por vez).' : '⏳ Bot principal ainda offline — vou esperar ele conectar (até 90s) e gero o QR sozinho.'}\n\nVou enviar o QR em até *3 tentativas*.\n💡 _Dica:_ use \`!login 5511999999999\` para código de 8 dígitos.\nUse \`!subcancel\` para sair da fila.`
            }, { quoted: m });
        }

        try {
            await subSessions.startLogin(ownerJid, {
                phoneNumber: usePairing ? phoneArg : null,
                onQueued: async (jid, { position, waitingPrincipal, alreadyRunning } = {}) => {
                    try {
                        if (alreadyRunning) {
                            await sock.sendMessage(from, {
                                text: `ℹ️ Seu login já está em andamento${position ? ` (posição ${position} na fila)` : ''} — aguarde o QR/código aqui mesmo.\nUse \`!subcancel\` para cancelar e recomeçar.`
                            }, { quoted: m });
                        } else if (waitingPrincipal) {
                            await sock.sendMessage(from, {
                                text: '⏳ *Aguardando o bot principal conectar…*\nA sub-sessão inicia sozinha assim que ele ficar 🟢 (até 90s). Não precisa mandar `!login` de novo.'
                            }, { quoted: m });
                        } else if (position > 1) {
                            await sock.sendMessage(from, {
                                text: `⏳ Você é o nº *${position}* na fila de login (1 por vez para não conflitar). Aguarde…`
                            }, { quoted: m });
                        }
                    } catch (_) {}
                },
                onQr: async (jid, { buffer, attempt, max }) => {
                    if (usePairing) return;
                    try {
                        if (buffer) {
                            await sock.sendMessage(from, {
                                image: buffer,
                                caption: `📱 *QR ${attempt}/${max}*\nAbra WhatsApp → ⋮ → *Aparelhos conectados* → *Conectar um aparelho* e escaneie esta imagem.`
                            }, { quoted: m });
                        } else {
                            await sock.sendMessage(from, {
                                text: `📱 *QR ${attempt}/${max}*\n_(falha ao gerar imagem — veja o terminal do bot)_`
                            }, { quoted: m });
                        }
                    } catch (_) {}
                },
                onPairingCode: async (jid, { code, phoneNumber, failed, attempts }) => {
                    try {
                        if (failed) {
                            await sock.sendMessage(from, {
                                text: `❌ *Falha no pareamento (${attempts} tentativas).*\n\nO WhatsApp rejeitou o código ${attempts}x. Provável rate-limit desta VPS.\n\n✅ *Limpeza automática:*\n• Sub-sessão encerrada\n• Credenciais apagadas do disco\n• Pairing bloqueado por 30min (use QR nesse meio-tempo)\n\n🔄 *Próximas opções:*\n• Use \`!login\` (sem número) → QR Code\n• Aguarde 30-60 min e tente \`!login ${phoneNumber}\` novamente\n• Use \`!subclean\` para limpar antes de tentar de novo`
                            }, { quoted: m });
                            return;
                        }
                        if (!code) return;
                        const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
                        await sock.sendMessage(from, {
                            text: `🔢 *Código de pareamento*\n\n📞 *Número:* \`${phoneNumber}\`\n🔐 *Código:* \`${formatted}\`\n\n📱 *Como usar:*\n1. Abra o WhatsApp no celular\n2. ⋮ (três pontos) → *Aparelhos conectados*\n3. Toque em *Conectar um aparelho*\n4. Toque em *Conectar com número de telefone*\n5. Digite o código acima: *${formatted}*\n\n⏱️ Código válido por ~5 minutos.\n🔁 Você tem *3 tentativas* antes da sub-sessão ser limpa.`
                        }, { quoted: m });
                    } catch (_) {}
                },
                onConnected: async (jid, { phoneNumber }) => {
                    try {
                        await sock.sendMessage(from, {
                            text: `✅ *Sub-sessão CONECTADA!*\n📞 Número: \`${phoneNumber || '?'}\`\n\nSua sessão pessoal está pronta. Use *!menu* lá para ver os comandos.\nPara encerrar: *!logoff* ou *!sair*.`
                        }, { quoted: m });
                    } catch (_) {}
                },
                onClosed: async (jid, reason) => {
                    try {
                        if (reason === 'qr-exhausted') {
                            await sock.sendMessage(from, {
                                text: '❌ *Sub-sessão cancelada.*\nVocê não escaneou o QR em 3 tentativas. Use !login para tentar novamente.'
                            }, { quoted: m });
                        } else if (reason === 'logged-out') {
                            await sock.sendMessage(from, {
                                text: '🚪 *Sub-sessão desconectada pelo WhatsApp.*\nUse !login para reconectar.'
                            }, { quoted: m });
                        } else if (reason === 'unauthorized') {
                            await sock.sendMessage(from, {
                                text: '🔒 *Falha de autenticação (401).*\n\nO WhatsApp rejeitou a conexão.\n\n💡 *Possíveis causas:*\n• O número já tem outro dispositivo pareado\n• O WhatsApp bloqueou este IP (muitos pareamentos)\n• Credenciais anteriores expiradas\n\n🔄 *Alternativa:* use `!login` (sem número) para gerar QR Code.\n\n⏰ Se o problema persistir, espere 15-30 min antes de tentar novamente.'
                            }, { quoted: m });
                        } else if (reason === 'principal-not-connected') {
                            await sock.sendMessage(from, {
                                text: '❌ *Bot principal não conectou em 90s.*\n\nTente `!login` novamente em alguns minutos.'
                            }, { quoted: m });
                        } else if (reason === 'cooldown') {
                            await sock.sendMessage(from, {
                                text: '⏳ *Aguarde antes de tentar de novo.*\nVocê tentou `!login` há pouco. Espere ~3 minutos ou use `!subcancel` + `!subclean`.'
                            }, { quoted: m });
                        } else if (reason === 'pairing-blocked') {
                            await sock.sendMessage(from, {
                                text: '🔒 *Pairing em pausa por 30min* (3 falhas seguidas = rate-limit).\n\nUse `!login` (sem número) para QR Code agora.'
                            }, { quoted: m });
                        } else if (reason && reason.startsWith('close-')) {
                            await sock.sendMessage(from, {
                                text: `❌ *Conexão fechada (${reason}).*\n\nO servidor WhatsApp encerrou a conexão antes de concluir.\n\n💡 *Sugestão:* use \`!login\` (sem número) para gerar *QR Code* como alternativa — QR é menos restritivo.\n\n⏰ Aguarde 15-30 min se quiser tentar pairing novamente.`
                            }, { quoted: m });
                        } else if (reason === 'restart-loop') {
                            await sock.sendMessage(from, {
                                text: '❌ *WhatsApp pediu restart 5x seguidas.*\n\nPossível instabilidade/Baileys desatualizado.\n\n🔄 Use `!subclean` e tente `!login` de novo em alguns minutos.'
                            }, { quoted: m });
                        } else if (reason && reason !== 'login-cancelado') {
                            await sock.sendMessage(from, {
                                text: `❌ *Sub-sessão encerrada (${reason}).*\n\nUse \`!login\` para tentar novamente ou \`!subclean\` para limpar antes.`
                            }, { quoted: m });
                        }
                    } catch (_) {}
                }
            });
            currentBotResponse = await react(sock, m, '✅', currentBotResponse, GLOBAL_COOLDOWN);
        } catch (e) {
            if (String(e?.message || '').includes('login-cancelado')) {
                return currentBotResponse;
            }
            await sock.sendMessage(from, { text: `❌ Falha ao iniciar sub-sessão: ${sanitizeUserText(e.message || e)}` }, { quoted: m });
            currentBotResponse = await react(sock, m, '❌', currentBotResponse, GLOBAL_COOLDOWN);
        }

        return currentBotResponse;
    }
};
