const { isSensitiveKey, maskSecret, reportSensitive } = require('../services/safeDebug');

module.exports = {
    name: 'set',
    category: 'config',
    description: 'Altera uma configuração do bot',
    async execute(sock, m, { from, sender, args, config, utils, ai, lastBotResponse, GLOBAL_COOLDOWN }) {
        const { react, writeConfig, readConfig } = utils;
        const { setupAI } = ai;

        const access = typeof utils.canConfigureBot === 'function'
            ? utils.canConfigureBot(sock, m, sender, from)
            : { ok: (() => { const meId = utils.normalizeJid(sock.user.id); const senderNorm = utils.normalizeJid(sender); return m.key.fromMe === true || sender === meId || senderNorm === meId; })() };
        if (!access.ok) {
            return await sock.sendMessage(from, { text: '❌ Apenas o dono ou sub-donos podem usar este comando.' }, { quoted: m });
        }
        
        const rawP = args[0];
        const v = args.slice(1).join(' ');

        const defaults = (typeof utils.getDefaultConfig === 'function')
            ? utils.getDefaultConfig()
            : (() => { try { return require('../database/utils').DEFAULT_CONFIG; } catch (_) { return null; } })();
        const knownKeys = defaults ? Object.keys(defaults) : [];
        const knownKeySet = new Set(knownKeys);
        const lowerMap = new Map(knownKeys.map(k => [k.toLowerCase(), k]));
        const p = rawP ? (knownKeySet.has(rawP) ? rawP : (lowerMap.get(String(rawP).toLowerCase()) || rawP)) : rawP;

        const findClosest = (q) => {
            if (!q || !knownKeys.length) return null;
            const ql = String(q).toLowerCase();
            let best = null, bestDist = Infinity;
            for (const k of knownKeys) {
                const kl = k.toLowerCase();
                let d = 0;
                if (kl === ql) return k;
                if (kl.startsWith(ql) || kl.includes(ql) || ql.includes(kl)) d = 1;
                else {
                    const m = Math.min(kl.length, ql.length);
                    let diff = Math.abs(kl.length - ql.length);
                    for (let i = 0; i < m; i++) if (kl[i] !== ql[i]) diff++;
                    d = diff + 2;
                }
                if (d < bestDist) { bestDist = d; best = k; }
            }
            return bestDist <= 3 ? best : null;
        };
        
        if (!p) {
            await sock.sendMessage(from, { text: `❌ Use: ${config.prefix}set <parâmetro> <valor>\n💡 Veja todas as opções: \`${config.prefix}set help\`` }, { quoted: m });
            return lastBotResponse;
        }
        
        if (p === 'help' || p === 'list' || p === '?') {
            if (!defaults) {
                await sock.sendMessage(from, { text: '❌ Não foi possível carregar a lista de configurações.' }, { quoted: m });
                return lastBotResponse;
            }

            const typeOf = (val) => {
                if (Array.isArray(val)) return 'array';
                if (typeof val === 'number') return Number.isInteger(val) ? 'inteiro' : 'número';
                if (typeof val === 'boolean') return 'booleano';
                if (typeof val === 'string') return 'texto';
                return typeof val;
            };

            const allKeys = Object.keys(defaults).filter(k => k !== 'subOwners' && k !== 'guardioes').sort();
            const lines = [`⚙️ *Configurações editáveis (${allKeys.length})*`, ''];
            for (const k of allKeys) {
                const def = defaults[k];
                const t = typeOf(def);
                let extra = '';
                if (t === 'inteiro' || t === 'número') extra = ' (aceita sufixos ms/s/m/h em alguns casos)';
                else if (t === 'booleano') extra = ' (true/false)';
                else if (t === 'array') extra = ' (valores separados por vírgula ou espaço)';
                else if (k === 'dashboardUrl') extra = ' (http(s)://...)';
                const lock = isSensitiveKey(k) ? '🔒 ' : '';
                lines.push(`${lock}• *${k}* — _${t}_${extra}`);
            }
            lines.push('');
            lines.push('🔒 = sensível: valor nunca exibido no chat (vai p/ Telegram/terminal)');
            lines.push('');
            lines.push(`Uso: \`${config.prefix}set <parâmetro> <valor>\``);
            lines.push(`Ex.: \`${config.prefix}set botName Gravity Bot🪐\``);
            lines.push(`Veja o valor atual: \`${config.prefix}set <parâmetro>\` (sem valor)`);
            await sock.sendMessage(from, { text: lines.join('\n') }, { quoted: m });
            return lastBotResponse;
        }

        // subOwners e guardioes NÃO são editáveis via !set (evita escalação).
        // Use !addsubdono / !remsubdono / !addguardiao / !remguardiao.
        if (p === 'subOwners' || p === 'guardioes' || ['subowners', 'guardioes', 'guardiao', 'guardian'].includes(String(p || '').toLowerCase())) {
            await sock.sendMessage(from, { text: `👑 *Sub-donos* só pelo dono via:\n➕ \`${config.prefix}addsubdono <numero>\`\n➖ \`${config.prefix}remsubdono <numero>\`\n📋 \`${config.prefix}listsubdonos\`\n\n🛡️ *Guardiões* pelo dono/subdono via:\n➕ \`${config.prefix}addguardiao <numero>\`\n➖ \`${config.prefix}remguardiao <numero>\`\n📋 \`${config.prefix}listguardioes\`` }, { quoted: m });
            return lastBotResponse;
        }

        if (config[p] !== undefined || p === 'prefix') {
            if (!v) {
                // Chave sensível: valor real NUNCA vai ao chat — só Telegram/terminal.
                if (isSensitiveKey(p)) {
                    reportSensitive({ title: `Leitura de ${p}`, detail: `${p} = ${config[p]}`, key: `set-read:${p}` });
                    await sock.sendMessage(from, { text: `📝 *${p}* atual: ${maskSecret(config[p])}\n🔒 _Valor real enviado ao Telegram/terminal._` }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: `📝 *${p}* atual: ${config[p]}` }, { quoted: m });
                }
                return lastBotResponse;
            }
            
            if (p === 'prefix') config.prefix = v.trim()[0] || '!';
            else if (p === 'showLogoInMenu' || p === 'voiceEffects' || p === 'dashboardEnabled' || p === 'newsEnabled' || p === 'newsRandomSub' || p === 'newsOnePerCycle' || p === 'subSessionsGroups' || p === 'splashEnabled' || p === 'splashWithImage' || p === 'humanMode' || p === 'humanPresence' || p === 'humanReadReceipt' || p === 'broadcastVaryText' || p === 'dashboardMuted' || p === 'historyMuted' || p === 'rejectCalls' || p === 'tagOwnerOnMod') { config[p] = v.toLowerCase() === 'true'; try { if (p === 'historyMuted') config.dashboardMuted = config[p]; else if (p === 'dashboardMuted') config.historyMuted = config[p]; } catch (_) {} }
            else if (p === 'summaryLimit' || p === 'clearDefaultLimit' || p === 'dashboardPort' || p === 'dashboardMaxLogs' || p === 'historyMaxLogs' || p === 'dashboardHistoryHours' || p === 'historyHours' || p === 'newsSendDelayMs' || p === 'newsFetchStaggerMs' || p === 'newsMaxPerCycle' || p === 'newsMaxRetries' || p === 'newsRetryBaseDelayMs' || p === 'dashboardTrimIntervalMs' || p === 'historyTrimIntervalMs' || p === 'maxMediaDurationSeconds' || p === 'maxDownloadSizeMB' || p === 'splashInterval' || p === 'splashCooldownMs' || p === 'humanMinDelayMs' || p === 'humanMaxDelayMs' || p === 'humanMsPerChar' || p === 'humanMaxTypingMs' || p === 'humanThrottleMs' || p === 'broadcastMinDelayMs' || p === 'broadcastMaxDelayMs') {
                const n = parseInt(v, 10);
                if (!Number.isFinite(n)) { await sock.sendMessage(from, { text: `❌ Valor inválido para ${p}` }, { quoted: m }); return lastBotResponse; }
                if (p === 'dashboardPort' && (n < 1024 || n > 65535)) { await sock.sendMessage(from, { text: `❌ Porta inválida (1024-65535)` }, { quoted: m }); return lastBotResponse; }
                if (p === 'maxMediaDurationSeconds' && (n < 30 || n > 36000)) { await sock.sendMessage(from, { text: `❌ Duração inválida (30-36000s)` }, { quoted: m }); return lastBotResponse; }
                if (p === 'maxDownloadSizeMB' && (n < 1 || n > 500)) { await sock.sendMessage(from, { text: `❌ Tamanho inválido (1-500 MB)` }, { quoted: m }); return lastBotResponse; }
                if (p === 'clearDefaultLimit' && (n < 1 || n > 100)) { await sock.sendMessage(from, { text: `❌ Limite inválido (1-100)` }, { quoted: m }); return lastBotResponse; }
                if (p === 'splashInterval' && (n < 60 || n > 200)) { await sock.sendMessage(from, { text: `❌ Intervalo inválido (60-200)` }, { quoted: m }); return lastBotResponse; }
                if (p === 'splashCooldownMs' && (n < 21600000 || n > 86400000)) { await sock.sendMessage(from, { text: `❌ Cooldown inválido (21600000-86400000ms = 6h-24h)` }, { quoted: m }); return lastBotResponse; }
                config[p] = n;
                // Histórico desvinculado do painel: `history*` espelha `dashboard*`
                // (e vice-versa) para não divergirem via !set antigo/novo.
                try {
                    if (p === 'historyMaxLogs') config.dashboardMaxLogs = n;
                    else if (p === 'dashboardMaxLogs') config.historyMaxLogs = n;
                    else if (p === 'historyHours') config.dashboardHistoryHours = n;
                    else if (p === 'dashboardHistoryHours') config.historyHours = n;
                    else if (p === 'historyTrimIntervalMs') config.dashboardTrimIntervalMs = n;
                    else if (p === 'dashboardTrimIntervalMs') config.historyTrimIntervalMs = n;
                } catch (_) {}
            }
            else if (p === 'newsPollIntervalMinutes' || p === 'newsPollIntervalMs') {
                // Aceita: "45" (minutos), "45m", "60s", "1h", "2700000ms".
                // newsPollIntervalMinutes → grava em MINUTOS (número puro).
                // newsPollIntervalMs (legado) → grava em ms.
                const m = String(v || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
                if (!m) {
                    await sock.sendMessage(from, { text: `❌ Formato inválido. Use: ${config.prefix}set newsPollIntervalMinutes 45m  (ou 60s, 1h)` }, { quoted: m });
                    return lastBotResponse;
                }
                const num = parseFloat(m[1]);
                const unit = m[2] || 'm';
                if (p === 'newsPollIntervalMinutes') {
                    // Grava SEMPRE em minutos (forma padrão da chave).
                    if (unit === 'ms') config[p] = Math.round(num / 60000);
                    else if (unit === 's') config[p] = Math.round(num / 60);
                    else if (unit === 'm') config[p] = Math.round(num);
                    else if (unit === 'h') config[p] = Math.round(num * 60);
                } else {
                    // Legado: grava em ms.
                    let totalMs;
                    if (unit === 'ms') totalMs = Math.round(num);
                    else if (unit === 's') totalMs = Math.round(num * 1000);
                    else if (unit === 'm') totalMs = Math.round(num * 60 * 1000);
                    else if (unit === 'h') totalMs = Math.round(num * 60 * 60 * 1000);
                    config[p] = totalMs;
                }
            }
            else if (p === 'newsSubreddits') {
                const raw = String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
                const seen = new Set();
                const out = [];
                for (const s of raw) {
                    let n = s.replace(/^r\//i, '').replace(/^\//, '').replace(/\/$/, '').toLowerCase();
                    if (!n) continue;
                    if (!/^[a-z0-9_]{2,32}$/.test(n)) {
                        await sock.sendMessage(from, { text: `❌ Subreddit inválido ignorado: *${s}*` }, { quoted: m });
                        continue;
                    }
                    if (seen.has(n)) continue;
                    seen.add(n);
                    out.push(n);
                }
                if (out.length === 0) {
                    await sock.sendMessage(from, { text: `❌ Nenhum subreddit válido informado. Use: ${config.prefix}set newsSubreddits pics,ShitpostBR` }, { quoted: m });
                    return lastBotResponse;
                }
                config[p] = out;
            }
            else if (p === 'dashboardUrl') {
                const u = String(v || '').trim();
                if (!/^https?:\/\/.+/i.test(u)) {
                    await sock.sendMessage(from, { text: `❌ URL inválida. Use o formato: ${config.prefix}set dashboardUrl https://seu-dominio.com` }, { quoted: m });
                    return lastBotResponse;
                }
                config[p] = u.replace(/\/+$/, '');
            }
            else config[p] = v;
            
            writeConfig(config);
            // Refresh local config and AI
            const newConfig = readConfig();
            setupAI(newConfig);
            // Troca de segredo: registra valor real só no Telegram/terminal.
            if (isSensitiveKey(p)) {
                reportSensitive({ title: `Alteração de ${p}`, detail: `${p} = ${v}`, key: `set-write:${p}` });
            }

            // Controle runtime do news (start/stop sem reiniciar o bot).
            // Aplica em mudanças de newsEnabled OU newsPollIntervalMinutes OU newsSubreddits.
            if (p === 'newsEnabled' || p === 'newsPollIntervalMinutes' || p === 'newsPollIntervalMs' || p === 'newsSubreddits') {
                const svc = (typeof global !== 'undefined' && global.__botServices && global.__botServices.news) || null;
                if (svc && newConfig.newsEnabled !== false) {
                    try {
                        svc.stop();
                        svc.start();
                    } catch (e) {
                        console.error('[set] falha ao reiniciar news:', e?.message || e);
                    }
                } else if (svc && newConfig.newsEnabled === false) {
                    try { svc.stop(); } catch (e) { console.error('[set] stop news:', e?.message || e); }
                }
            }

            let currentBotResponse = await react(sock, m, '✅', lastBotResponse, GLOBAL_COOLDOWN);
            await sock.sendMessage(from, { text: `✅ *${p}* atualizado!` }, { quoted: m });
            return currentBotResponse;
        } else {
            const suggested = findClosest(p);
            const tip = suggested ? `\n💡 Você quis dizer \`${suggested}\`?` : `\n💡 Veja a lista: \`${config.prefix}set help\``;
            await sock.sendMessage(from, { text: `❌ Parâmetro *${p}* inválido!${tip}` }, { quoted: m });
            return lastBotResponse;
        }
    }
};
