// ownerEvidence.js — evidências para o !aidono (somente leitura).
// Resolve alvos (menções múltiplas, citado, número, nome de grupo) e monta
// um pacote compacto de evidências (advs + mensagens recentes + atividade).
// Tudo local (SQLite). matchFactual responde perguntas factuais sem IA (R$0).

function clean(s, n) {
    return String(s == null ? '' : s)
        .replace(/[\x00-\x1F\x7F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n);
}

function digitsOf(jid) {
    const m = String(jid || '').split('@')[0].split(':')[0];
    return /^\d{8,15}$/.test(m) ? m : null;
}

// 14+ dígitos = LID do WhatsApp (ex.: 73680331751662@lid), NÃO telefone.
// Telefones com DDI têm no máx. 13 dígitos. Errar o domínio zera a busca.
function jidFromDigits(digits) {
    const d = String(digits || '').replace(/\D/g, '');
    if (!/^\d{8,}$/.test(d)) return null;
    return d.length >= 14 ? `${d}@lid` : `${d}@s.whatsapp.net`;
}

function displayName(row, fallback) {
    const n = clean(row?.name || '', 30);
    if (n && !['usuário', 'usuario'].includes(n.toLowerCase())) return n;
    const d = digitsOf(row?.phone ? `${row.phone}@s.whatsapp.net` : row?.senderJid) || digitsOf(fallback);
    return d ? `@${d}` : (fallback ? clean(fallback, 20) : 'Usuário');
}

// Rótulo seguro para o prompt: jid/LID e sequências só-numéricas longas
// (ex.: 86522200076318@lid) são identificadores internos — a IA nunca deve
// vê-los nem repeti-los. Telefones reais curtos (8-13 dígitos) o dono
// reconhece, então podem aparecer. Todo o resto vira tag ("pessoa A"...).
function safePersonLabel(name, tag) {
    const n = clean(name || '', 30);
    if (n && !/@/.test(n) && !/^\d+$/.test(n)) return n; // nome humano
    if (n && /^@?\d{8,13}$/.test(n)) return n.startsWith('@') ? n : `@${n}`; // telefone real
    return tag || 'pessoa mencionada';
}

function personTag(index, total) {
    if (total > 1 && Number.isInteger(index)) return `pessoa ${String.fromCharCode(65 + (index % 26))}`;
    return 'pessoa mencionada';
}

// Número puro (@5511..., LID solto) NÃO é identidade confirmada — é só a
// falta de nome. Trata como desconhecido p/ presença e busca por nome.
function isNumericLabel(l) {
    return /^@?\d{8,15}$/.test(String(l || '').trim());
}

// Funde lista exata (por jid) + aproximada (por nome): cada fonte cobre
// grupos/épocas que a outra não viu. Dedupe por texto+tempo (±5s) p/ não
// dobrar o que está nas duas (toda msg gravada vai p/ ambas as tabelas).
// Repetição real espaçada ("Chad." 3x) é preservada.
function mergeKey(text, ts) {
    const n = String(text == null ? '' : text).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    return `${n}|${Math.floor((Number(ts) || 0) / 5000)}`;
}
function mergeMsgLists(primary, secondary) {
    const seen = new Set();
    const out = [];
    for (const r of [...(primary || []), ...(secondary || [])]) {
        const txt = r && r.text != null ? String(r.text).trim() : '';
        if (!txt) continue;
        const k = mergeKey(txt, r.timestamp);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
    }
    out.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    return out;
}

// Dígitos de LID nunca são exibidos (parecem telefone mas não são).
function isLidJid(jid) {
    return typeof jid === 'string' && jid.toLowerCase().endsWith('@lid');
}

// Tenta achar o "outro jid" da mesma pessoa (LID <-> número real) para a
// busca cobrir as mensagens salvas sob qualquer das identidades.
async function resolveAlias(sock, jid, groupJid, utils) {
    if (!jid) return null;
    try {
        if (String(jid).endsWith('@lid') && groupJid && groupJid.endsWith('@g.us')) {
            const other = await utils?.resolveLidPhoneInGroup?.(sock, String(jid).split('@')[0], groupJid);
            if (other && typeof other === 'string' && other.includes('@')) return other;
            if (other && (other.pn || other.phone)) {
                const p = String(other.pn || other.phone).replace(/\D/g, '');
                if (/^\d{8,15}$/.test(p)) return `${p}@s.whatsapp.net`;
            }
        }
        // Reverso: número citado, histórico sob LID.
        if (String(jid).endsWith('@s.whatsapp.net') && groupJid && groupJid.endsWith('@g.us')) {
            const lid = await utils?.resolvePhoneLidInGroup?.(sock, String(jid).split('@')[0], groupJid);
            if (lid && typeof lid === 'string' && lid.includes('@')) return lid;
        }
    } catch (_) {}
    return null;
}

// Extrai candidatos a grupo pelo nome: "grupo X", "do grupo X", "no X".
function extractGroupNameMention(text, groupSubjects) {
    const t = String(text || '');
    const m = t.match(/(?:grupo|gp)\s+([^?,!.]{2,60})/i);
    const candidates = [];
    if (m) candidates.push(m[1].trim());
    // tenta também o texto todo como nome (ex.: "!aidono Amigos o que acha?")
    candidates.push(t.slice(0, 60).trim());
    const lower = (s) => String(s || '').toLowerCase();
    for (const cand of candidates) {
        if (!cand) continue;
        const hit = (groupSubjects || []).find((g) => lower(g.subject).includes(lower(cand)) || lower(cand).includes(lower(g.subject)));
        if (hit) return hit;
    }
    return null;
}

async function resolveTargets(sock, m, questionText, utils, from) {
    const people = [];
    const groups = [];
    const seenP = new Set();
    const seenG = new Set();
    const ctx = m.message?.extendedTextMessage?.contextInfo || {};

    const pushPerson = (jid, nameHint) => {
        const norm = utils?.normalizeJid ? utils.normalizeJid(jid) : String(jid);
        if (!norm || seenP.has(norm)) return;
        seenP.add(norm);
        people.push({ jid: norm, nameHint: nameHint || null });
    };

    // 1. Menções (várias!) — @a @b @c.
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    for (const j of mentioned) if (j) pushPerson(j);

    // 2. Mensagem citada (respondeu alguém).
    if (ctx.participant) pushPerson(ctx.participant, ctx.pushName || null);

    // 3. Números digitados no texto (8+ dígitos; 14+ = LID).
    const phones = String(questionText || '').match(/\d{8,}/g) || [];
    for (const p of phones) {
        const jid = jidFromDigits(p);
        if (jid) pushPerson(jid);
    }

    // 4. Grupo pelo nome (via infos do dashboard).
    try {
        const infos = utils?.listDashboardGroupInfos?.() || [];
        const hit = extractGroupNameMention(questionText, infos);
        if (hit && hit.jid && !seenG.has(hit.jid)) {
            seenG.add(hit.jid);
            groups.push({ jid: hit.jid, subject: hit.subject || 'Grupo' });
        }
    } catch (_) {}

    // Aliases LID<->número para cada pessoa.
    const groupCtx = from && String(from).endsWith('@g.us') ? from : (groups[0]?.jid || null);
    for (const p of people) {
        p.alias = await resolveAlias(sock, p.jid, groupCtx, utils);
    }
    return { people, groups };
}

function fmtWhen(ts) {
    try {
        return new Date(Number(ts)).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    } catch (_) { return ''; }
}

function warningsOf(utils, groupJid, personJid) {
    try {
        const gd = utils?.getGroupData?.(groupJid) || {};
        const w = (gd.warnings && typeof gd.warnings === 'object') ? gd.warnings : {};
        // chave pode estar em LID ou número — compara pelo usuário.
        const userOf = (j) => String(j || '').split('@')[0].split(':')[0];
        const target = userOf(personJid);
        let total = Number(w[personJid]) || 0;
        if (!total) {
            for (const [k, v] of Object.entries(w)) {
                if (userOf(k) === target) { total = Number(v) || 0; break; }
            }
        }
        return total;
    } catch (_) { return 0; }
}

function wantsLogs(question) {
    return /log|erro|falha|bug|travou|parou|quebrou|comando\s+(rodou|execut|usou|foi)|quais comandos|últimos? erros?|erros? recentes?/i.test(String(question || ''));
}

// Janela de tempo em PT-BR p/ !aidono ("o que X falou há 3 dias/ontem").
// Tudo em America/Sao_Paulo (UTC-3 fixo, sem horário de verão desde 2019).
// Retorna { since, until, label } em ms ou null.
const SP_OFFSET_MS = 3 * 3600 * 1000;
function _spDayStart(nowMs, daysAgo) {
    // SP = UTC-3: subtrai p/ ler os campos do calendário paulista em UTC.
    const sp = new Date(Number(nowMs) - SP_OFFSET_MS);
    const dayUtc = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate());
    return dayUtc + SP_OFFSET_MS - daysAgo * 24 * 3600 * 1000;
}
function _fmtDay(ms) {
    try {
        return new Date(Number(ms)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
    } catch (_) { return ''; }
}
function extractAllTimeRanges(question, nowMs) {
    const now = Number(nowMs) || Date.now();
    const t = String(question || '').toLowerCase();
    if (!t) return [];
    const dayMs = 24 * 3600 * 1000;
    const narrowHour = /ess[ae] hor|nesse hor|por volta|esse hor|neste hor/.test(t);
    const applyHour = (since, until) => {
        if (!narrowHour) return { since, until, hourNote: '' };
        const tod = (now - _spDayStart(now, 0)) % dayMs; // hora atual no dia (ms)
        const center = since + tod;
        const s = Math.max(since, center - 3 * 3600 * 1000);
        const u = Math.min(until, center + 3 * 3600 * 1000);
        return { since: s, until: u, hourNote: ' por volta deste horário' };
    };
    const out = [];
    const push = (r) => {
        if (!r) return;
        const k = `${r.since}-${r.until}`;
        if (!out.some((o) => `${o.since}-${o.until}` === k)) out.push(r);
    };
    const yearNow = new Date(now - SP_OFFSET_MS).getUTCFullYear();

    // dia DD/MM[/AAAA] — mesma prioridade de antes, todas as ocorrências
    for (const m of t.matchAll(/\b(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
        if (Number(m[1]) > 31 || Number(m[2]) > 12) continue;
        const dd = Number(m[1]);
        const mm = Number(m[2]);
        let yyyy = yearNow;
        if (m[3]) yyyy = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
        let since = Date.UTC(yyyy, mm - 1, dd) + SP_OFFSET_MS;
        if (since > now) since = Date.UTC(yyyy - 1, mm - 1, dd) + SP_OFFSET_MS;
        const r = applyHour(since, since + dayMs - 1);
        push({ since: r.since, until: Math.min(r.until, now), label: `no dia ${_fmtDay(since)}${r.hourNote}` });
    }
    // há N dias / N dias atrás (dia cheio N dias atrás)
    for (const m of t.matchAll(/\bh[aá]\s+(\d{1,2})\s+dias?\b/g)) {
        const n = Math.max(1, Math.min(30, Number(m[1])));
        const since = _spDayStart(now, n);
        const r = applyHour(since, since + dayMs - 1);
        push({ since: r.since, until: Math.min(r.until, now), label: n === 1 ? `ontem (${_fmtDay(since)})${r.hourNote}` : `há ${n} dias (${_fmtDay(since)})${r.hourNote}` });
    }
    for (const m of t.matchAll(/\b(\d{1,2})\s+dias?\s+atr[aá]s\b/g)) {
        const n = Math.max(1, Math.min(30, Number(m[1])));
        const since = _spDayStart(now, n);
        const r = applyHour(since, since + dayMs - 1);
        push({ since: r.since, until: Math.min(r.until, now), label: n === 1 ? `ontem (${_fmtDay(since)})${r.hourNote}` : `há ${n} dias (${_fmtDay(since)})${r.hourNote}` });
    }
    // últimos N dias (sem \b antes do ú: \b não casa antes de letra acentuada)
    for (const m of t.matchAll(/(?:^|\s)[úu]ltimos?\s+(\d{1,2})\s+dias?\b/g)) {
        const n = Math.max(1, Math.min(30, Number(m[1])));
        push({ since: _spDayStart(now, n - 1), until: now, label: `nos últimos ${n} dias` });
    }
    if (/\banteontem\b/.test(t)) {
        const since = _spDayStart(now, 2);
        const r = applyHour(since, since + dayMs - 1);
        push({ since: r.since, until: r.until, label: `anteontem (${_fmtDay(since)})${r.hourNote}` });
    }
    if (/\bontem\b/.test(t)) {
        const since = _spDayStart(now, 1);
        const r = applyHour(since, since + dayMs - 1);
        push({ since: r.since, until: r.until, label: `ontem (${_fmtDay(since)})${r.hourNote}` });
    }
    if (/\bsemana passada\b/.test(t)) {
        push({ since: _spDayStart(now, 13), until: _spDayStart(now, 7) + dayMs - 1, label: 'na semana passada' });
    }
    if (/ess[ae] semana|esta semana|[úu]ltima semana/.test(t)) {
        push({ since: _spDayStart(now, 6), until: now, label: 'nesta semana' });
    }
    if (/\bhoje\b/.test(t)) {
        push({ since: _spDayStart(now, 0), until: now, label: `hoje (${_fmtDay(now)})` });
    }
    return out.slice(0, 3);
}
function extractTimeRange(question, nowMs) {
    const all = extractAllTimeRanges(question, nowMs);
    return all.length ? all[0] : null;
}

// Pergunta comparativa entre janelas ("ontem tem a ver com hoje?", "mudou?").
// Julgamento vai para a IA com as duas evidências — nunca no fast-path.
function isComparison(question) {
    const t = String(question || '').toLowerCase();
    return /(t[eê]m|tenha|teria).{0,15}(a ver|haver)|compar|diferen|mudou|mudan|evolu|relac|antes.{0,25}(agora|hoje|depois)|ontem.{0,25}hoje|hoje.{0,25}ontem/.test(t);
}
// Janelas p/ comparação: as 2 explícitas, ou a explícita + hoje
// ("mudou desde ontem?" compara ontem × hoje). Null = não é comparação.
function rangesForComparison(question, nowMs) {
    if (!isComparison(question)) return null;
    const now = Number(nowMs) || Date.now();
    const all = extractAllTimeRanges(question, now);
    if (!all.length) return null;
    if (all.length >= 2) return [all[0], all[1]];
    const today = { since: _spDayStart(now, 0), until: now, label: `hoje (${_fmtDay(now)})` };
    if (today.since === all[0].since && today.until === all[0].until) return null;
    return [all[0], today];
}

async function buildEvidence(sock, { people, groups }, { from, isGroup, utils, msgLimit = 15, msgChars = 150, groupMsgChars = 130, question = '', timeRange = null }) {
    const lines = [];
    const stats = { people: [], groups: [], logs: null, timeRange: timeRange ? timeRange.label : null };
    const tr = timeRange || null;
    // Janela com mais folga no fetch (até 30), mas a exibição continua curta
    // (~12) p/ caber no prompt — riqueza sem pesar.

    // Nome de grupo com proveniência: metadados ao vivo > nome nos logs > infos > jid curto.
    // Nomes genéricos ('Grupo', 'PV' etc.) contam como MISS e caem para a próxima fonte.
    const GENERIC_NAMES = new Set(['grupo', 'pv', 'privado', 'chat', 'desconhecido', 'sem nome', 'grupo atual']);
    const isGenericName = (n) => !n || GENERIC_NAMES.has(String(n).trim().toLowerCase());
    const groupNames = new Map();
    async function groupName(jid) {
        if (!jid) return 'PV';
        if (groupNames.has(jid)) return groupNames.get(jid);
        let name = null;
        try {
            const gm = await utils?.groupMetadataCached?.(sock, jid).catch(() => null);
            if (gm?.subject && !isGenericName(gm.subject)) name = gm.subject;
        } catch (_) {}
        if (!name) {
            try {
                const g = utils?.getGroupSubject?.(jid);
                if (g && !isGenericName(g)) name = g;
            } catch (_) {}
        }
        if (!name) {
            try {
                const gi = utils?.getDashboardGroupInfo?.(jid);
                if (gi?.subject && !isGenericName(gi.subject)) name = gi.subject;
            } catch (_) {}
        }
        if (!name) {
            try {
                for (const g of (utils?.listDashboardGroupInfos?.() || [])) {
                    if (g.jid === jid && g.subject && !isGenericName(g.subject)) { name = g.subject; break; }
                }
            } catch (_) {}
        }
        if (!name) name = String(jid).split('@')[0].slice(-6);
        groupNames.set(jid, name);
        return name;
    }

    // Grupo atual entra como contexto quando o comando roda em grupo.
    const groupJids = [...groups.map((g) => g.jid)];
    if (isGroup && from && !groupJids.includes(from)) groupJids.push(from);

    // Linha de resolução: diz à IA QUEM é cada alvo (o bot resolveu o
    // número/menção -> pessoa de forma determinística). Sem ela, a IA vê
    // dígitos na pergunta e nome na evidência e se recusa a ligar os dois.
    const resoParts = [];
    const isTagLabel = (l) => /^(pessoa mencionada|pessoa [A-Z])$/.test(String(l || ''));

    // Autores desconhecidos ganham tags estáveis (pessoa A/B...) em vez do jid.
    // Dígitos de LID nunca aparecem (parecem telefone, mas não são).
    const authorTags = new Map();
    let authorSeq = 0;
    const authorLabel = (ml) => {
        const raw = displayName(ml);
        if (ml?.senderJid && isLidJid(ml.senderJid) && /^@?\d+$/.test(String(raw || ''))) {
            const key = ml.senderJid;
            if (!authorTags.has(key)) authorTags.set(key, `pessoa ${String.fromCharCode(65 + (authorSeq++ % 26))}`);
            return authorTags.get(key);
        }
        const n = clean(raw || '', 30);
        if (n && !/@/.test(n) && !/^\d+$/.test(n)) return n;
        if (n && /^@?\d{8,13}$/.test(n)) return n.startsWith('@') ? n : `@${n}`;
        const key = ml?.senderJid || raw;
        if (!authorTags.has(key)) authorTags.set(key, `pessoa ${String.fromCharCode(65 + (authorSeq++ % 26))}`);
        return authorTags.get(key);
    };

    for (const [pi, p] of people.entries()) {
        // Fetch folgado e fixo (independe do msgLimit de exibição): conta
        // honesta + dedupe bom; a exibição continua curta (msgLimit/~12).
        let msgs = (tr && utils?.getMessagesBySenderRange)
            ? (utils.getMessagesBySenderRange(p.jid, p.alias, tr.since, tr.until, 50) || [])
            : (utils?.getMessagesBySender?.(p.jid, p.alias, 30) || []);
        // Linhas sem texto (mídia sem legenda) não viram evidência: a IA
        // receberia "1 msgs" sem nenhuma linha e responderia no vazio.
        // O nome delas ainda vale para o rótulo.
        const namedForLabel = msgs;
        const hasText = (x) => String(x?.text ?? '').trim() !== '';
        let mediaOnly = namedForLabel.filter((x) => !hasText(x)).length;
        msgs = namedForLabel.filter(hasText);
        let approx = false;
        const rawLabel = p.nameHint || displayName(namedForLabel[namedForLabel.length - 1] || {}, p.jid);
        let label = safePersonLabel(rawLabel, personTag(pi, people.length));
        const msgGroups = [];
        // Presença na atividade (quem fala mas nunca usou comando): dá o nome
        // e mostra em quais grupos a pessoa aparece, mesmo sem conteúdo.
        let presence = null;
        try {
            presence = utils?.findActivityName?.(p.jid, p.alias) || null;
        } catch (_) {}
        if ((!label || isTagLabel(label) || isNumericLabel(label)) && presence?.name) {
            label = safePersonLabel(presence.name, personTag(pi, people.length));
        }
        // Fallback por nome SEMPRE (mesmo com msgs exatas): cada fonte cobre
        // grupos/épocas que a outra não viu. Funde com dedupe e ordena.
        try {
            let pname = (label && !isTagLabel(label) && !isNumericLabel(label)) ? label : null;
            if (!pname) pname = utils?.getSenderName?.(p.jid) || utils?.getSenderName?.(p.alias) || null;
            if (!pname && presence?.name) pname = presence.name;
            if (pname) {
                const scope = groupJids.length > 0 ? [...groupJids, null] : [null];
                const collected = [];
                const likeFn = utils?.findMessagesByNameLike || utils?.getMessagesByPushName;
                const rangeFn = tr && utils?.getMessagesByPushNameRange ? utils.getMessagesByPushNameRange.bind(utils) : null;
                for (const gj of scope) {
                    if (rangeFn) {
                        // Busca exata por nome COM janela de tempo (SQL).
                        const extra = rangeFn(gj, pname, tr.since, tr.until, 100) || [];
                        for (const r of extra) collected.push({ gj: r.jid || gj, r });
                    } else {
                        const extra = likeFn?.call(utils, gj, pname, 100) || [];
                        // usa o jid real da linha (o escopo nulo mistura grupos)
                        for (const r of extra) collected.push({ gj: r.jid || gj, r });
                    }
                    if (collected.length >= 200) break;
                }
                // Filtro temporal p/ o caminho aproximado (LIKE sem SQL de data).
                let pool = collected;
                if (tr && !rangeFn) pool = collected.filter((c) => (c.r.time || 0) >= tr.since && (c.r.time || 0) <= tr.until);
                if (pool.length > 0) {
                    pool.sort((a, b) => (a.r.time || 0) - (b.r.time || 0));
                    for (const c of pool) c.gname = await groupName(c.gj);
                    const distinctGroups = [...new Set(pool.map((c) => c.gj || ''))].filter(Boolean);
                    for (const gj of distinctGroups) {
                        const gname = await groupName(gj);
                        if (!msgGroups.includes(gname)) msgGroups.push(gname);
                    }
                    const fbRows = pool.map(({ r, gname }) => ({ text: r.text, name: r.push_name, timestamp: r.time, fb: true, gname }));
                    msgs = mergeMsgLists(msgs.map((x) => ({ ...x, fb: false })), fbRows);
                    if (msgs.length > 0 && (isTagLabel(label) || isNumericLabel(label))) label = safePersonLabel(pname, personTag(pi, people.length));
                }
                // Nome conhecido mas zero mensagens com texto: adota o nome
                // mesmo assim — "Sem dados sobre Clara" em vez de "pessoa mencionada".
                if (msgs.length === 0 && (isTagLabel(label) || isNumericLabel(label)) && pname) {
                    label = safePersonLabel(pname, personTag(pi, people.length));
                }
            }
        } catch (_) {}
        // Só mídia sem texto no banco: conta para a dica do "Sem dados".
        let dbMediaOnly = 0;
        if (msgs.length === 0) {
            try { dbMediaOnly = Number(utils?.countMediaOnlyBySender?.(p.jid, p.alias)) || 0; } catch (_) {}
        }
        mediaOnly = Math.max(mediaOnly, dbMediaOnly);
        // Grupos das linhas exatas (só banco, sem rede) p/ tag multi-grupo.
        try {
            const tjids = [...new Set(msgs.map((x) => x.toJid).filter(Boolean))].slice(0, 10);
            for (const tj of tjids) {
                const sn = utils?.getGroupSubject?.(tj) || null;
                if (sn) {
                    const gname = clean(sn, 25);
                    if (gname && !msgGroups.includes(gname)) msgGroups.push(gname);
                }
            }
        } catch (_) {}
        // Tag de grupo quando a pessoa fala em vários (vale p/ linhas aprox).
        if (msgGroups.length > 1) {
            for (const r of msgs) {
                if (r.fb && !r.tagged) {
                    r.tagged = true;
                    r.text = `(${clean(r.gname || 'grupo', 25)}) ${r.text}`;
                }
            }
        }
        approx = msgs.some((x) => x.fb);
        // advs nos grupos relevantes
        const advParts = [];
        for (const gj of groupJids) {
            const c = warningsOf(utils, gj, p.jid);
            if (c > 0) advParts.push(`${c}/3 (${clean(await groupName(gj), 25)})`);
        }
        const where = msgGroups.length > 1 ? ` em ${msgGroups.length} grupos` : '';
        const presenceNote = (msgs.length === 0 && presence && presence.total > 0)
            ? ` — aparece em ${presence.groups.length} grupo(s), ${presence.total} msgs contadas (sem conteúdo salvo)`
            : '';
        // Com janela de tempo: conta a janela toda, exibe só o necessário.
        // msgs já é a fusão exato+aproximado com dedupe.
        const windowTotal = msgs.length;
        const showLim = tr ? Math.min(msgLimit, 12) : msgLimit;
        const shown = tr ? msgs.slice(-showLim) : msgs.slice(-msgLimit);
        const winTag = tr ? ` ${tr.label}` : ' recentes';
        const cutNote = (tr && windowTotal > shown.length) ? ` (mostrando as ${shown.length} mais recentes)` : '';
        const mediaNote = (msgs.length === 0 && mediaOnly > 0)
            ? ` (só ${mediaOnly} mídia sem texto)`
            : '';
        lines.push(`Pessoa: ${clean(label, 30)} — advs: ${advParts.length ? advParts.join(', ') : 'nenhuma'} — ${windowTotal} msgs${winTag}${approx ? ' (aproximado por nome)' : ''}${cutNote}${presenceNote}${mediaNote}:`);
        for (const ml of shown) {
            const txt = clean(ml.text, msgChars);
            if (txt) lines.push(`  [${fmtWhen(ml.timestamp)}] ${txt}`);
        }
        stats.people.push({ jid: p.jid, label, advs: advParts, msgCount: shown.length, windowTotal, mediaOnly, approx, groups: msgGroups, presence, windowMsgs: tr ? shown.map((x) => ({ text: clean(x.text, 150), timestamp: x.timestamp, name: clean(x.name || '', 25) })) : undefined });
        resoParts.push(isTagLabel(label) ? `${label} (nome não confirmado)` : `${label} (identidade confirmada pelo bot)`);
    }

    for (const g of groups) {
        let msgs = (tr && utils?.getMessagesByGroupRange)
            ? (utils.getMessagesByGroupRange(g.jid, tr.since, tr.until, 30) || [])
            : (utils?.getMessagesByGroup?.(g.jid, 20) || []);
        // Fallback fundido com dedupe (mesmo motivo do loop de pessoas).
        try {
            let extra = [];
            if (tr && utils?.getGroupMessagesRange) {
                extra = utils.getGroupMessagesRange(g.jid, tr.since, tr.until, 100) || [];
            } else {
                const all = utils?.getGroupMessages?.(g.jid, 50) || [];
                extra = tr ? all.filter((r) => (r.time || 0) >= tr.since && (r.time || 0) <= tr.until) : all;
            }
            if (extra.length > 0) {
                const fbRows = extra.map((r) => ({ text: r.text, name: r.push_name, senderJid: null, timestamp: r.time, fb: true }));
                msgs = mergeMsgLists(msgs.map((x) => ({ ...x, fb: false })), fbRows);
            }
        } catch (_) {}
        // Mesmo filtro do loop de pessoas: linha sem texto não é evidência.
        msgs = (msgs || []).filter((x) => String(x?.text ?? '').trim() !== '');
        let approx = msgs.some((x) => x.fb);
        const gname = clean(await groupName(g.jid) || g.subject, 50);
        const winTag = tr ? ` ${tr.label}` : ' recentes';
        const gShow = tr ? msgs.slice(-15) : msgs.slice(-20);
        const gCut = (tr && msgs.length > gShow.length) ? ` (mostrando as ${gShow.length} mais recentes)` : '';
        lines.push(`Grupo: ${gname} — ${msgs.length} msgs${winTag}${approx ? ' (autores por nome)' : ''}${gCut}:`);
        for (const ml of gShow) {
            const txt = clean(ml.text, groupMsgChars);
            if (txt) lines.push(`  [${fmtWhen(ml.timestamp)}] ${authorLabel(ml)}: ${txt}`);
        }
        let top = null;
        try { top = utils?.getTopMember?.(g.jid) || null; } catch (_) {}
        if (top && !/nenhum registro/i.test(String(top))) lines.push(`  Top do grupo hoje: ${clean(top, 30)}`);
        stats.groups.push({ jid: g.jid, subject: gname, msgCount: msgs.length, windowTotal: msgs.length, top, approx, windowMsgs: tr ? gShow.map((x) => ({ text: clean(x.text, 130), timestamp: x.timestamp, name: clean(x.name || '', 25) })) : undefined });
    }

    // Logs do próprio bot (só quando a pergunta é sobre isso).
    if (wantsLogs(question)) {
        try {
            const errors = utils?.getRecentLogs?.('error', 10) || [];
            const actions = (utils?.getRecentLogs?.('action', 30) || [])
                .filter((l) => /comando executado/i.test(l.text || ''))
                .slice(-10);
            if (errors.length > 0) {
                lines.push(`Erros recentes (${errors.length}):`);
                for (const el of errors) {
                    const txt = clean(el.text, 140);
                    if (txt) lines.push(`  [${fmtWhen(el.timestamp)}] ${txt}`);
                }
            } else {
                lines.push('Erros recentes: nenhum no histórico.');
            }
            if (actions.length > 0) {
                lines.push(`Comandos executados recentemente (${actions.length}):`);
                for (const al of actions) {
                    const txt = clean(al.text, 120);
                    if (txt) lines.push(`  [${fmtWhen(al.timestamp)}] ${txt}`);
                }
            }
            stats.logs = {
                errors: errors.map((e) => ({ when: e.timestamp, text: e.text })),
                commands: actions.map((a) => ({ when: a.timestamp, text: a.text }))
            };
        } catch (_) {}
    }

    if (resoParts.length > 0) {
        lines.unshift(`Alvos da pergunta (resolvidos pelo bot): ${resoParts.join('; ')}.`);
    }
    if (tr) {
        let retention = 'histórico retido: até 168h (~7 dias)';
        try {
            if (utils?.getHistoryWindowLabel) retention = utils.getHistoryWindowLabel();
            else if (utils?.readConfig) {
                const cfg = utils.readConfig();
                const h = Number(cfg?.historyHours ?? cfg?.dashboardHistoryHours) || 168;
                retention = `histórico retido: até ${h}h`;
            }
        } catch (_) {}
        lines.unshift(`Janela da pergunta: ${tr.label} (${retention}).`);
    }

    const text = lines.join('\n').slice(0, 2800);
    return { text, stats };
}

// Comparação entre 2 janelas ("ontem × hoje"): roda a evidência de cada uma
// (curta, p/ caber no prompt) e funde. O julgamento vai para a IA.
async function buildComparisonEvidence(sock, targets, { from, isGroup, utils, question = '', ranges, msgLimit = 6 }) {
    const [r1, r2] = ranges;
    const e1 = await buildEvidence(sock, targets, { from, isGroup, utils, msgLimit, msgChars: 120, groupMsgChars: 100, question, timeRange: r1 });
    const e2 = await buildEvidence(sock, targets, { from, isGroup, utils, msgLimit, msgChars: 120, groupMsgChars: 100, question, timeRange: r2 });
    const text = `=== JANELA 1: ${r1.label} ===\n${e1.text}\n\n=== JANELA 2: ${r2.label} ===\n${e2.text}`;
    const mergePeople = new Map();
    for (const p of [...(e1.stats.people || []), ...(e2.stats.people || [])]) {
        const cur = mergePeople.get(p.jid) || { ...p, msgCount: 0, windowTotal: 0, windowMsgs: [], groups: [] };
        cur.msgCount += p.msgCount || 0;
        cur.windowTotal += p.windowTotal || p.msgCount || 0;
        cur.windowMsgs = [...(cur.windowMsgs || []), ...((p.windowMsgs || []).map((x) => ({ ...x })))].slice(-12);
        for (const g of (p.groups || [])) if (!cur.groups.includes(g)) cur.groups.push(g);
        if ((!cur.label || /^pessoa (mencionada|[A-Z])$/.test(cur.label)) && p.label) cur.label = p.label;
        mergePeople.set(p.jid, cur);
    }
    const mergeGroups = new Map();
    for (const g of [...(e1.stats.groups || []), ...(e2.stats.groups || [])]) {
        const cur = mergeGroups.get(g.jid) || { ...g, msgCount: 0, windowTotal: 0, windowMsgs: [] };
        cur.msgCount += g.msgCount || 0;
        cur.windowTotal += g.windowTotal || g.msgCount || 0;
        cur.windowMsgs = [...(cur.windowMsgs || []), ...((g.windowMsgs || []).map((x) => ({ ...x })))].slice(-15);
        mergeGroups.set(g.jid, cur);
    }
    return {
        text,
        stats: {
            people: [...mergePeople.values()],
            groups: [...mergeGroups.values()],
            logs: null,
            timeRange: `${r1.label} × ${r2.label}`,
            comparison: true
        }
    };
}

// Evidência vazia de verdade: ninguém com msg/adv, nenhum grupo com msg,
// sem logs. Chamar a IA aqui só gera resposta genérica — melhor "sem dados".
function evidenceIsEmpty(stats) {
    if (!stats) return true;
    const peopleEmpty = (stats.people || []).every((p) => (p.msgCount || 0) === 0 && (p.advs || []).length === 0 && !((p.presence?.total || 0) > 0));
    const groupsEmpty = (stats.groups || []).every((g) => (g.msgCount || 0) === 0 && !g.top);
    const logsEmpty = !stats.logs || (((stats.logs.errors || []).length === 0) && ((stats.logs.commands || []).length === 0));
    const hasTargets = (stats.people || []).length > 0 || (stats.groups || []).length > 0;
    return hasTargets ? (peopleEmpty && groupsEmpty && logsEmpty) : logsEmpty;
}

// Pergunta factual sobre falas ("o que X falou ontem") x opinião ("o que acha").
// Opinião continua indo para a IA; fala com janela vai no fast-path (R$0).
function wantsSpoken(question) {
    const q = String(question || '').toLowerCase();
    return /(falou|falou|disse|disseram|mandou|mandaram|comentou|postou|escreveu|quais mensagens|mostr\w*(\s+[a-zà-ú]{1,4})?\s+mensagens)/.test(q)
        && !/(acha|acham|opini|pensa|sentimento|clima|resume|resumo|quem [ée]|top\b|quantas?\s+mensagen)/.test(q);
}

// Fast-path determinístico (sem IA). Retorna string ou null.
function matchFactual(question, evidence, { isGroup, from, utils } = {}) {
    const q = String(question || '').toLowerCase();
    if (!evidence) return null;

    const wantsAdv = /adv|advertênc|punid|warn/.test(q);
    const wantsCount = /quantas?\s+mensagen|qtd.*mensagen|quantidade.*mensagen/.test(q);
    const wantsTop = /quem mais|mais fala|mais ativ|top\b/.test(q);

    if (wantsAdv && evidence.stats.people.length > 0) {
        const parts = evidence.stats.people.map((p) =>
            `• ${p.label}: ${p.advs.length ? p.advs.join(', ') : 'nenhuma advertência'}`);
        return `⚠️ *Advertências*\n${parts.join('\n')}`;
    }
    if (wantsAdv && evidence.stats.groups.length > 0) {
        // top advs do grupo
        try {
            const gd = utils?.getGroupData?.(evidence.stats.groups[0].jid) || {};
            const w = gd.warnings || {};
            const entries = Object.entries(w).filter(([, c]) => (Number(c) || 0) > 0)
                .sort((a, b) => b[1] - a[1]).slice(0, 10);
            if (entries.length === 0) return '✅ Ninguém tem advertências neste grupo.';
            // Nunca exibe LID/dígitos crus: safePersonLabel esconde 14-15 dígitos.
            return '⚠️ *Advertências ativas*\n' + entries.map(([jid, c], i) => {
                const digits = String(jid).split('@')[0];
                const label = safePersonLabel(isLidJid(jid) ? null : `@${digits}`, personTag(i, entries.length));
                return `${i + 1}. ${label} — ${c}/3`;
            }).join('\n');
        } catch (_) { return null; }
    }
    if (wantsCount && evidence.stats.people.length > 0) {
        const parts = evidence.stats.people.map((p) => `• ${p.label}: ${p.windowTotal ?? p.msgCount} mensagens`);
        return `💬 *Mensagens (histórico)*\n${parts.join('\n')}`;
    }
    if (wantsTop) {
        const gj = evidence.stats.groups[0]?.jid || (isGroup ? from : null);
        if (gj) {
            try {
                const top = utils?.getTopMember?.(gj);
                if (top) return `🏆 *Quem mais fala:* ${top}`;
            } catch (_) {}
        }
    }
    // "O que X falou há 3 dias/ontem": resposta direta com as mensagens da
    // janela (R$0, sem IA). Só quando há janela de tempo explícita — opinião
    // ("o que acha") continua indo para a IA.
    const spoken = wantsSpoken(question);
    // Comparação ("tem a ver", "mudou") nunca vai no fast-path: o julgamento
    // precisa da IA com as duas janelas.
    if (evidence.stats.timeRange && spoken && !isComparison(q)) {
        const win = evidence.stats.timeRange;
        const fmtLine = (x, withName) => {
            const when = fmtWhen(x.timestamp);
            const who = withName && x.name ? ` ${clean(x.name, 25)}:` : '';
            return `• [${when}]${who} ${clean(x.text, 140)}`;
        };
        if (evidence.stats.people.length > 0) {
            const parts = [];
            for (const p of evidence.stats.people) {
                const list = (p.windowMsgs || []).filter((x) => x.text);
                if (!list.length) {
                    parts.push(`• ${p.label}: nada ${win} no histórico.`);
                    continue;
                }
                const extra = (p.windowTotal || list.length) > list.length ? `\n(+${(p.windowTotal || list.length) - list.length} na janela)` : '';
                parts.push(`*${p.label}* ${win} (${p.windowTotal || list.length} msgs):\n${list.map((x) => fmtLine(x, (evidence.stats.people.length > 1))).join('\n')}${extra}`);
            }
            return `💬 *O que falaram*\n${parts.join('\n\n')}`.slice(0, 3500);
        }
        if (evidence.stats.groups.length > 0 && (evidence.stats.groups[0].windowTotal || 0) > 0) {
            const gs = evidence.stats.groups[0];
            const list = (gs.windowMsgs || []).filter((x) => x.text);
            const extra = (gs.windowTotal || list.length) > list.length ? `\n(+${(gs.windowTotal || list.length) - list.length} na janela)` : '';
            return `💬 *${clean(gs.subject, 40)}* ${win} (${gs.windowTotal || list.length} msgs):\n${list.map((x) => fmtLine(x, true)).join('\n')}${extra}`.slice(0, 3500);
        }
        if (evidence.stats.groups.length > 0) {
            return `💬 Nada no grupo ${clean(evidence.stats.groups[0].subject, 40)} ${win} no histórico.`;
        }
    }
    // Logs: erros e comandos recentes (R$0, direto do banco).
    if (evidence.stats.logs) {
        if (/erro|falha|bug|travou|parou|quebrou/i.test(q)) {
            const errs = evidence.stats.logs.errors || [];
            if (errs.length === 0) return '✅ Nenhum erro registrado no histórico.';
            return '❌ *Erros recentes*\n' + errs.map((e) => `• ${clean(e.text, 140)}`).join('\n');
        }
        if (/comando|rodou|execut|usou|atividade do bot/i.test(q)) {
            const cmds = evidence.stats.logs.commands || [];
            if (cmds.length === 0) return 'ℹ️ Nenhum comando registrado no histórico.';
            return '🤖 *Comandos executados recentemente*\n' + cmds.map((c) => `• ${clean(c.text, 120)}`).join('\n');
        }
    }
    return null;
}

module.exports = { resolveTargets, resolveAlias, buildEvidence, buildComparisonEvidence, matchFactual, clean, warningsOf, wantsLogs, wantsSpoken, isComparison, extractTimeRange, extractAllTimeRanges, rangesForComparison, mergeMsgLists, safePersonLabel, personTag, displayName, jidFromDigits, digitsOf, evidenceIsEmpty };
