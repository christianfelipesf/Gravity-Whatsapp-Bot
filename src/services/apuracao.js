'use strict';

/**
 * apuracao.js — Apuração da eleição presidencial (TSE, tempo real).
 *
 * Fonte oficial: arquivos EA20 unificados do TSE
 *   https://resultados.tse.jus.br/oficial/ele2026/<cdEleicao>/dados/<uf>/<uf>-c0001-e<cd6>-u.json
 * Códigos vindos do ele-c.json oficial:
 *   pleito 3220 (1º turno 04/10/2026) → eleição federal 6257 (Presidente, cdt2 6258)
 *   2º turno (25/10/2026) → eleição federal 6258
 * Fotos oficiais: https://resultados.tse.jus.br/oficial/ele2026/<cdEleicao>/fotos/br/<sqcand>.jpeg
 */

const BASE = 'https://resultados.tse.jus.br/oficial/ele2026';
const ELEICAO_1T = '6257';
const ELEICAO_2T = '6258';
const CARGO_PAD = 'c0001';
const CACHE_TTL_MS = 60 * 1000;

const UFS = new Set([
    'br', 'ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms',
    'mt', 'pa', 'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se',
    'sp', 'to', 'zz'
]);

const UF_NAMES = {
    br: 'BRASIL', ac: 'ACRE', al: 'ALAGOAS', am: 'AMAZONAS', ap: 'AMAPÁ',
    ba: 'BAHIA', ce: 'CEARÁ', df: 'DISTRITO FEDERAL', es: 'ESPÍRITO SANTO',
    go: 'GOIÁS', ma: 'MARANHÃO', mg: 'MINAS GERAIS', ms: 'MATO GROSSO DO SUL',
    mt: 'MATO GROSSO', pa: 'PARÁ', pb: 'PARAÍBA', pe: 'PERNAMBUCO',
    pi: 'PIAUÍ', pr: 'PARANÁ', rj: 'RIO DE JANEIRO', rn: 'RIO GRANDE DO NORTE',
    ro: 'RONDÔNIA', rr: 'RORAIMA', rs: 'RIO GRANDE DO SUL', sc: 'SANTA CATARINA',
    se: 'SERGIPE', sp: 'SÃO PAULO', to: 'TOCANTINS', zz: 'EXTERIOR'
};

// Cache simples em memória: key `${cdE}:${uf}` -> { at, data }
const _cache = new Map();

function pad6(cd) {
    return String(cd).padStart(6, '0');
}

/** Monta a URL do EA20 unificado. Ex: ele2026/6257/dados/br/br-c0001-e006257-u.json */
function buildUrl(cdEleicao, uf) {
    const u = String(uf || 'br').toLowerCase();
    const e = `e${pad6(cdEleicao)}`;
    return `${BASE}/${cdEleicao}/dados/${u}/${u}-${CARGO_PAD}-${e}-u.json`;
}

/** URL da foto oficial pelo sqcand. */
function fotoUrl(cdEleicao, sqcand) {
    return `${BASE}/${cdEleicao}/fotos/br/${sqcand}.jpeg`;
}

function num(v) {
    if (v === null || v === undefined) return 0;
    const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function int(v) {
    const n = parseInt(String(v == null ? '0' : v).replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}

function norm(s) {
    return String(s == null ? '' : s).trim();
}

/**
 * Normaliza o JSON EA20 unificado para o formato do bot.
 * @param {Object} j JSON do TSE
 * @param {Object} meta { cdEleicao, uf }
 */
function parseEA20(j, meta) {
    const cdEleicao = meta && meta.cdEleicao ? String(meta.cdEleicao) : ELEICAO_1T;
    const uf = norm((meta && meta.uf) || 'br').toLowerCase() || 'br';
    const turno = cdEleicao === ELEICAO_2T ? 2 : 1;

    const carg = Array.isArray(j && j.carg) ? j.carg[0] : null;
    const agrs = (carg && Array.isArray(carg.agr)) ? carg.agr : [];

    const candidatos = [];
    for (const agr of agrs) {
        const pars = Array.isArray(agr.par) ? agr.par : [];
        for (const par of pars) {
            const cands = Array.isArray(par.cand) ? par.cand : [];
            for (const c of cands) {
                const vice = Array.isArray(c.vs) && c.vs[0] ? c.vs[0] : null;
                candidatos.push({
                    numero: norm(c.n),
                    sqcand: norm(c.sqcand),
                    nome: norm(c.nm),
                    nomeUrna: norm(c.nmu || c.nm),
                    partido: norm(par.sg || agr.com || ''),
                    coligacao: norm(agr.com || agr.nm || ''),
                    vice: norm(vice && (vice.nmu || vice.nm)),
                    vicePartido: norm(vice && vice.sgp),
                    votos: int(c.vap),
                    pct: norm(c.pvap || '0,00'),
                    pctNum: num(c.pvapn != null ? c.pvapn : c.pvap),
                    situacao: norm(c.st),
                    foto: c.sqcand ? fotoUrl(cdEleicao, norm(c.sqcand)) : null
                });
            }
        }
    }
    candidatos.sort((a, b) => b.votos - a.votos);

    const s = (j && j.s) || {};
    const vv = (j && j.v) || {};
    const ee = (j && j.e) || {};

    const secoesTotal = int(s.ts);
    const secoesApuradas = int(s.st);
    const secoesPctNum = num(s.pstn != null ? s.pstn : s.pst);

    return {
        eleicao: norm((j && j.ele) || cdEleicao),
        turno,
        abrangencia: uf,
        abrangenciaNome: UF_NAMES[uf] || uf.toUpperCase(),
        atualizacao: norm(j && (j.hg || j.ht)),
        data: norm(j && (j.dg || j.dt)),
        finalizada: (j && (j.and === 'f' || j.tf === 's')) || false,
        secoes: {
            total: secoesTotal,
            apuradas: secoesApuradas,
            pct: norm(s.pst || '0,00'),
            pctNum: secoesPctNum
        },
        votos: {
            comparecimento: int(ee.c),
            abstencoes: int(ee.a),
            validos: int(vv.vnom != null ? vv.vnom : vv.vv),
            brancos: int(vv.vb),
            brancosPct: norm(vv.pvb || '0,00'),
            nulos: int(vv.tvn != null ? vv.tvn : vv.vn),
            nulosPct: norm(vv.ptvn || vv.pvn || '0,00'),
            total: int(vv.tv)
        },
        candidatos
    };
}

async function _fetchJson(url, fetchFn) {
    const f = fetchFn || fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
        const r = await f(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (WhatsAppBot apuracao/1.0)' },
            signal: ctrl.signal
        });
        if (!r.ok) {
            const err = new Error(`TSE HTTP ${r.status}`);
            err.status = r.status;
            throw err;
        }
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

function _getCache(key) {
    const hit = _cache.get(key);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.data;
    return null;
}

function _setCache(key, data) {
    _cache.set(key, { at: Date.now(), data });
    if (_cache.size > 40) {
        const oldest = _cache.keys().next().value;
        _cache.delete(oldest);
    }
}

/**
 * Busca a apuração de uma eleição/UF.
 * @param {string} cdEleicao '6257' | '6258'
 * @param {string} uf 'br' | sigla
 * @param {Function} fetchFn fetch injetável (testes)
 */
async function fetchApuracao(cdEleicao, uf, fetchFn) {
    const cd = String(cdEleicao || ELEICAO_1T);
    const u = String(uf || 'br').toLowerCase();
    if (!UFS.has(u)) {
        const err = new Error(`UF inválida: ${uf}`);
        err.code = 'UF_INVALIDA';
        throw err;
    }
    const key = `${cd}:${u}`;
    const hit = _getCache(key);
    if (hit) return hit;
    const j = await _fetchJson(buildUrl(cd, u), fetchFn);
    const data = parseEA20(j, { cdEleicao: cd, uf: u });
    _setCache(key, data);
    return data;
}

/** Tem apuração com algum dado? (seções apuradas > 0 ou candidatos com votos) */
function _temDados(d) {
    if (!d) return false;
    if (d.secoes && d.secoes.apuradas > 0) return true;
    if (Array.isArray(d.candidatos) && d.candidatos.some((c) => c.votos > 0)) return true;
    return false;
}

/**
 * Automático: prefere 2º turno se já houver dados, senão 1º turno.
 * Retorna { turno, data }. Se nada publicado ainda, lança erro com code:
 *  - 'NAO_INICIOU' (404 nos dois) → apuração só a partir das 17h (horário de Brasília)
 */
async function fetchApuracaoAuto(uf, fetchFn) {
    const u = String(uf || 'br').toLowerCase();
    // 2º turno primeiro (se já rolou, é o vigente)
    try {
        const d2 = await fetchApuracao(ELEICAO_2T, u, fetchFn);
        if (_temDados(d2)) return { turno: 2, data: d2 };
    } catch (e) {
        if (e && e.code === 'UF_INVALIDA') throw e;
        // 404/erro no 2T é esperado antes do 2º turno — cai para o 1T
    }
    try {
        const d1 = await fetchApuracao(ELEICAO_1T, u, fetchFn);
        if (_temDados(d1)) return { turno: 1, data: d1 };
        const err = new Error('Apuração ainda não disponível');
        err.code = _temDados(d1) ? 'SEM_DADOS' : 'NAO_INICIOU';
        err.data = d1;
        throw err;
    } catch (e) {
        if (e && (e.code === 'NAO_INICIOU' || e.code === 'UF_INVALIDA')) throw e;
        if (e && e.status === 404) {
            const err = new Error('Apuração ainda não disponível');
            err.code = 'NAO_INICIOU';
            throw err;
        }
        throw e;
    }
}

/** "24212947" → "24.212.947" */
function fmtInt(n) {
    try {
        return Number(n || 0).toLocaleString('pt-BR');
    } catch (_) {
        return String(n || 0);
    }
}

function clearCache() {
    _cache.clear();
}

module.exports = {
    BASE,
    ELEICAO_1T,
    ELEICAO_2T,
    UFS,
    UF_NAMES,
    buildUrl,
    fotoUrl,
    parseEA20,
    fetchApuracao,
    fetchApuracaoAuto,
    fmtInt,
    clearCache
};
