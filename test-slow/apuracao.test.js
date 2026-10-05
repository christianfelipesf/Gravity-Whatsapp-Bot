const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

function fixtureEA20() {
    return {
        ele: '6257',
        hg: '18:43:29',
        dg: '04/10/2026',
        and: 'p',
        tf: 'n',
        carg: [{
            cd: '1',
            agr: [{
                n: '280001801177',
                nm: 'PARTIDO LIBERAL',
                tp: 'i',
                com: 'PL',
                par: [{
                    n: '22',
                    sg: 'PL',
                    cand: [{
                        n: '22', sqcand: '280002551544', nm: 'FLAVIO NANTES BOLSONARO',
                        nmu: 'FLAVIO BOLSONARO', vap: '24212947', pvap: '50,41', pvapn: '50,410304719',
                        st: '', vs: [{ nm: 'ALFREDO GASPAR DE MENDONÇA NETO', nmu: 'ALFREDO GASPAR', sgp: 'PL' }]
                    }]
                }]
            }, {
                n: '280001800617',
                nm: 'BRASIL PRONTO PRA MAIS',
                tp: 'c',
                com: 'PSB / PDT / PCDOB / PT / PV / PSOL / REDE',
                par: [{
                    n: '13',
                    sg: 'PT',
                    cand: [{
                        n: '13', sqcand: '280002542548', nm: 'LUIZ INÁCIO LULA DA SILVA',
                        nmu: 'LULA', vap: '19903245', pvap: '41,44', pvapn: '41,437692213',
                        st: '', vs: [{ nm: 'GERALDO JOSE RODRIGUES ALCKMIN FILHO', nmu: 'GERALDO ALCKMIN', sgp: 'PSB' }]
                    }]
                }]
            }]
        }],
        s: { ts: '499248', st: '207533', pst: '41,57', pstn: '41,569119956' },
        e: { c: '50227792', a: '13258875' },
        v: { tv: '50227792', vnom: '48031741', vb: '869509', pvb: '1,73', tvn: '1326542', ptvn: '2,64' }
    };
}

describe('apuracao (TSE presidente)', () => {
    let apuracao;
    beforeEach(() => {
        delete require.cache[require.resolve('../src/services/apuracao')];
        apuracao = require('../src/services/apuracao');
        apuracao.clearCache();
    });

    it('buildUrl usa o padrão EA20 oficial', () => {
        assert.strictEqual(
            apuracao.buildUrl('6257', 'br'),
            'https://resultados.tse.jus.br/oficial/ele2026/6257/dados/br/br-c0001-e006257-u.json'
        );
        assert.strictEqual(
            apuracao.buildUrl('6258', 'sp'),
            'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp-c0001-e006258-u.json'
        );
    });

    it('fotoUrl usa sqcand', () => {
        assert.strictEqual(
            apuracao.fotoUrl('6257', '280002551544'),
            'https://resultados.tse.jus.br/oficial/ele2026/6257/fotos/br/280002551544.jpeg'
        );
    });

    it('parseEA20 ordena por votos e extrai vice/partido/seções', () => {
        const d = apuracao.parseEA20(fixtureEA20(), { cdEleicao: '6257', uf: 'br' });
        assert.strictEqual(d.turno, 1);
        assert.strictEqual(d.abrangenciaNome, 'BRASIL');
        assert.strictEqual(d.candidatos.length, 2);
        assert.strictEqual(d.candidatos[0].nomeUrna, 'FLAVIO BOLSONARO');
        assert.strictEqual(d.candidatos[0].votos, 24212947);
        assert.strictEqual(d.candidatos[0].pct, '50,41');
        assert.strictEqual(d.candidatos[0].partido, 'PL');
        assert.strictEqual(d.candidatos[0].vice, 'ALFREDO GASPAR');
        assert.strictEqual(d.candidatos[1].nomeUrna, 'LULA');
        assert.strictEqual(d.secoes.apuradas, 207533);
        assert.strictEqual(d.secoes.pct, '41,57');
        assert.strictEqual(d.votos.brancos, 869509);
        assert.strictEqual(d.votos.nulos, 1326542);
        assert.strictEqual(d.atualizacao, '18:43:29');
    });

    it('fetchApuracaoAuto prefere 2º turno com dados; cai para 1º se 2T vazio/404', async () => {
        const fx1 = fixtureEA20();
        const fx2 = fixtureEA20();
        fx2.s.st = '0';
        fx2.carg[0].agr.forEach((a) => a.par.forEach((p) => p.cand.forEach((c) => { c.vap = '0'; })));
        const fetchFn = async (url) => {
            if (url.includes('/6258/')) {
                if (url.includes('/br/')) return { ok: true, json: async () => fx2 };
                return { ok: false, status: 404 };
            }
            return { ok: true, json: async () => fx1 };
        };
        const res = await apuracao.fetchApuracaoAuto('br', fetchFn);
        assert.strictEqual(res.turno, 1);
        assert.strictEqual(res.data.candidatos[0].votos, 24212947);
    });

    it('fetchApuracaoAuto usa o 2º turno quando há dados', async () => {
        const fx2 = fixtureEA20();
        const fetchFn = async (url) => {
            if (url.includes('/6258/')) return { ok: true, json: async () => fx2 };
            throw new Error('não deveria buscar o 1T');
        };
        const res = await apuracao.fetchApuracaoAuto('br', fetchFn);
        assert.strictEqual(res.turno, 2);
    });

    it('fetchApuracaoAuto lança NAO_INICIOU quando TSE retorna 404', async () => {
        const fetchFn = async () => ({ ok: false, status: 404 });
        await assert.rejects(() => apuracao.fetchApuracaoAuto('br', fetchFn), (e) => e.code === 'NAO_INICIOU');
    });

    it('fetchApuracao rejeita UF inválida', async () => {
        await assert.rejects(() => apuracao.fetchApuracao('6257', 'xx', async () => ({})), (e) => e.code === 'UF_INVALIDA');
    });

    it('fmtInt formata em pt-BR', () => {
        assert.strictEqual(apuracao.fmtInt(24212947), '24.212.947');
    });

    it('comando apuracao carrega sem roubar o alias !votacao do !enquete', () => {
        const cmd = require('../src/commands/apuracao');
        assert.strictEqual(cmd.name, 'apuracao');
        assert.ok(!cmd.aliases.includes('votacao'), '!votacao continua sendo do !enquete');
        for (const a of ['eleicao', 'presidentes', 'urnas']) assert.ok(cmd.aliases.includes(a));
        const enquete = require('../src/commands/enquete');
        assert.ok(enquete.aliases.includes('votacao'));
    });

    it('gera imagem estilo rank (JPEG válido)', async () => {
        const { generateApuracaoImage } = require('../src/services/apuracaoImage');
        const buf = await generateApuracaoImage({
            candidatos: [
                { nomeUrna: 'FLAVIO BOLSONARO', numero: '22', partido: 'PL', vice: 'ALFREDO GASPAR', votos: 24212947, votosFmt: '24.212.947', pct: '50,41' },
                { nomeUrna: 'LULA', numero: '13', partido: 'PT', vice: 'GERALDO ALCKMIN', votos: 19903245, votosFmt: '19.903.245', pct: '41,44' }
            ],
            turno: 1,
            abrangenciaNome: 'BRASIL',
            secoesPct: '41,57',
            secoesPctNum: 41.57,
            secoesApuradasFmt: '207.533',
            secoesTotalFmt: '499.248',
            atualizacao: '18:43:29',
            finalizada: false,
            botName: 'TesteBot',
            resumo: { validos: '48.031.741', brancos: '869.509', brancosPct: '1,73', nulos: '1.326.542', nulosPct: '2,64' }
        });
        assert.ok(Buffer.isBuffer(buf));
        assert.ok(buf.length > 10000, `imagem muito pequena: ${buf.length}`);
        assert.strictEqual(buf[0], 0xFF);
        assert.strictEqual(buf[1], 0xD8);
    });
});
