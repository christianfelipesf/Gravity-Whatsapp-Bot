// Origem aproximada pelo número (DDI/DDD) — sem API externa, offline.
// DDD cobre a área, não a cidade exata.

const DDI_PAIS = {
    '1': { pais: 'EUA/Canadá', iso: 'US' },
    '7': { pais: 'Rússia/Cazaquistão', iso: 'RU' },
    '20': { pais: 'Egito', iso: 'EG' },
    '27': { pais: 'África do Sul', iso: 'ZA' },
    '30': { pais: 'Grécia', iso: 'GR' },
    '31': { pais: 'Holanda', iso: 'NL' },
    '32': { pais: 'Bélgica', iso: 'BE' },
    '33': { pais: 'França', iso: 'FR' },
    '34': { pais: 'Espanha', iso: 'ES' },
    '39': { pais: 'Itália', iso: 'IT' },
    '40': { pais: 'Romênia', iso: 'RO' },
    '41': { pais: 'Suíça', iso: 'CH' },
    '43': { pais: 'Áustria', iso: 'AT' },
    '44': { pais: 'Reino Unido', iso: 'GB' },
    '45': { pais: 'Dinamarca', iso: 'DK' },
    '46': { pais: 'Suécia', iso: 'SE' },
    '47': { pais: 'Noruega', iso: 'NO' },
    '48': { pais: 'Polônia', iso: 'PL' },
    '49': { pais: 'Alemanha', iso: 'DE' },
    '51': { pais: 'Peru', iso: 'PE' },
    '52': { pais: 'México', iso: 'MX' },
    '53': { pais: 'Cuba', iso: 'CU' },
    '54': { pais: 'Argentina', iso: 'AR' },
    '55': { pais: 'Brasil', iso: 'BR' },
    '56': { pais: 'Chile', iso: 'CL' },
    '57': { pais: 'Colômbia', iso: 'CO' },
    '58': { pais: 'Venezuela', iso: 'VE' },
    '59': { pais: 'Uruguai', iso: 'UY' },
    '60': { pais: 'Malásia', iso: 'MY' },
    '61': { pais: 'Austrália', iso: 'AU' },
    '62': { pais: 'Indonésia', iso: 'ID' },
    '63': { pais: 'Filipinas', iso: 'PH' },
    '64': { pais: 'Nova Zelândia', iso: 'NZ' },
    '65': { pais: 'Singapura', iso: 'SG' },
    '66': { pais: 'Tailândia', iso: 'TH' },
    '81': { pais: 'Japão', iso: 'JP' },
    '82': { pais: 'Coreia do Sul', iso: 'KR' },
    '84': { pais: 'Vietnã', iso: 'VN' },
    '86': { pais: 'China', iso: 'CN' },
    '90': { pais: 'Turquia', iso: 'TR' },
    '91': { pais: 'Índia', iso: 'IN' },
    '92': { pais: 'Paquistão', iso: 'PK' },
    '93': { pais: 'Afeganistão', iso: 'AF' },
    '94': { pais: 'Sri Lanka', iso: 'LK' },
    '95': { pais: 'Mianmar', iso: 'MM' },
    '98': { pais: 'Irã', iso: 'IR' },
    '212': { pais: 'Marrocos', iso: 'MA' },
    '213': { pais: 'Argélia', iso: 'DZ' },
    '216': { pais: 'Tunísia', iso: 'TN' },
    '351': { pais: 'Portugal', iso: 'PT' },
    '352': { pais: 'Luxemburgo', iso: 'LU' },
    '353': { pais: 'Irlanda', iso: 'IE' },
    '354': { pais: 'Islândia', iso: 'IS' },
    '355': { pais: 'Albânia', iso: 'AL' },
    '356': { pais: 'Malta', iso: 'MT' },
    '357': { pais: 'Chipre', iso: 'CY' },
    '358': { pais: 'Finlândia', iso: 'FI' },
    '359': { pais: 'Bulgária', iso: 'BG' },
    '370': { pais: 'Lituânia', iso: 'LT' },
    '371': { pais: 'Letônia', iso: 'LV' },
    '372': { pais: 'Estônia', iso: 'EE' },
    '373': { pais: 'Moldávia', iso: 'MD' },
    '374': { pais: 'Armênia', iso: 'AM' },
    '375': { pais: 'Bielorrússia', iso: 'BY' },
    '376': { pais: 'Andorra', iso: 'AD' },
    '377': { pais: 'Mônaco', iso: 'MC' },
    '380': { pais: 'Ucrânia', iso: 'UA' },
    '381': { pais: 'Sérvia', iso: 'RS' },
    '382': { pais: 'Montenegro', iso: 'ME' },
    '383': { pais: 'Kosovo', iso: 'XK' },
    '385': { pais: 'Croácia', iso: 'HR' },
    '386': { pais: 'Eslovênia', iso: 'SI' },
    '387': { pais: 'Bósnia', iso: 'BA' },
    '389': { pais: 'Macedônia do Norte', iso: 'MK' },
    '420': { pais: 'Tchéquia', iso: 'CZ' },
    '421': { pais: 'Eslováquia', iso: 'SK' },
    '423': { pais: 'Liechtenstein', iso: 'LI' },
    '502': { pais: 'Guatemala', iso: 'GT' },
    '503': { pais: 'El Salvador', iso: 'SV' },
    '504': { pais: 'Honduras', iso: 'HN' },
    '505': { pais: 'Nicarágua', iso: 'NI' },
    '506': { pais: 'Costa Rica', iso: 'CR' },
    '507': { pais: 'Panamá', iso: 'PA' },
    '509': { pais: 'Haiti', iso: 'HT' },
    '591': { pais: 'Bolívia', iso: 'BO' },
    '592': { pais: 'Guiana', iso: 'GY' },
    '593': { pais: 'Equador', iso: 'EC' },
    '594': { pais: 'Guiana Francesa', iso: 'GF' },
    '595': { pais: 'Paraguai', iso: 'PY' },
    '598': { pais: 'Uruguai', iso: 'UY' },
};

// DDD -> UF / região / referência / clima (resumo curto)
const DDD_INFO = {
    '11': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Capital e Região Metropolitana', clima: 'Tropical de altitude — verão quente/chuvoso, inverno ameno e seco' },
    '12': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Vale do Paraíba e Litoral Norte (S. J. dos Campos)', clima: 'Tropical de altitude — quente e úmido, serra mais fria' },
    '13': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Baixada Santista e Vale do Ribeira (Santos)', clima: 'Tropical litorâneo — quente e úmido o ano todo' },
    '14': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Centro-Oeste paulista (Bauru, Marília, Jaú)', clima: 'Tropical — verão quente/chuvoso, inverno seco e ameno' },
    '15': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Sorocaba e região (Itapetininga)', clima: 'Tropical de altitude — verões quentes, invernos secos' },
    '16': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Ribeirão Preto, Araraquara e S. Carlos', clima: 'Tropical — quente, verão chuvoso e inverno seco' },
    '17': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Noroeste paulista (S. J. do Rio Preto, Barretos)', clima: 'Tropical — quente, uma das áreas mais quentes do estado' },
    '18': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Oeste paulista (Pres. Prudente, Araçatuba)', clima: 'Tropical — muito quente no verão, inverno seco' },
    '19': { uf: 'SP', estado: 'São Paulo', regiao: 'Sudeste', ref: 'Campinas e região (Piracicaba)', clima: 'Tropical de altitude — quente/chuvoso no verão' },
    '21': { uf: 'RJ', estado: 'Rio de Janeiro', regiao: 'Sudeste', ref: 'Capital e Região Metropolitana', clima: 'Tropical atlântico — quente e úmido, verão com temporais' },
    '22': { uf: 'RJ', estado: 'Rio de Janeiro', regiao: 'Sudeste', ref: 'Interior e litoral norte (Campos, Cabo Frio)', clima: 'Tropical — quente, com áreas mais secas no norte' },
    '24': { uf: 'RJ', estado: 'Rio de Janeiro', regiao: 'Sudeste', ref: 'Região serrana e sul (Petrópolis, V. Redonda)', clima: 'Tropical de altitude na serra — mais frio e úmido' },
    '27': { uf: 'ES', estado: 'Espírito Santo', regiao: 'Sudeste', ref: 'Vitória e região central/norte', clima: 'Tropical litorâneo — quente e úmido' },
    '28': { uf: 'ES', estado: 'Espírito Santo', regiao: 'Sudeste', ref: 'Sul capixaba (Cachoeiro de Itapemirim)', clima: 'Tropical — quente e úmido no litoral, ameno na serra' },
    '31': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Belo Horizonte e região metropolitana', clima: 'Tropical de altitude — verão chuvoso, inverno seco e friozinho' },
    '32': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Zona da Mata e sul (Juiz de Fora)', clima: 'Tropical de altitude — úmido, inverno ameno a frio' },
    '33': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Leste e nordeste (Gov. Valadares, T. Otoni)', clima: 'Tropical — quente, com áreas de transição p/ semiárido' },
    '34': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Triângulo Mineiro (Uberlândia, Uberaba)', clima: 'Tropical continental — quente, verão chuvoso e inverno seco' },
    '35': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Sul e sudoeste (Poços de Caldas, Pouso Alegre)', clima: 'Tropical de altitude — um dos climas mais amenos de MG' },
    '37': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Centro-Oeste (Divinópolis)', clima: 'Tropical de altitude — verão chuvoso, inverno seco' },
    '38': { uf: 'MG', estado: 'Minas Gerais', regiao: 'Sudeste', ref: 'Norte e noroeste (Montes Claros)', clima: 'Semiárido/tropical — quente e mais seco' },
    '41': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Curitiba, região metropolitana e litoral', clima: 'Subtropical úmido — invernos frios, verão ameno' },
    '42': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Centro-Sul (Ponta Grossa, Guarapuava)', clima: 'Subtropical — frio no inverno, com geadas na serra' },
    '43': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Norte (Londrina, Apucarana)', clima: 'Subtropical/tropical — quente no verão, inverno ameno' },
    '44': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Noroeste (Maringá, Umuarama)', clima: 'Subtropical — quente e úmido no verão' },
    '45': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Oeste e sudoeste (Cascavel, Foz do Iguaçu)', clima: 'Subtropical — quente e úmido, temporais no verão' },
    '46': { uf: 'PR', estado: 'Paraná', regiao: 'Sul', ref: 'Sudoeste (F. Beltrão, Pato Branco)', clima: 'Subtropical úmido — inverno frio' },
    '47': { uf: 'SC', estado: 'Santa Catarina', regiao: 'Sul', ref: 'Norte e Vale do Itajaí (Joinville, Blumenau)', clima: 'Subtropical úmido — verão quente, inverno frio' },
    '48': { uf: 'SC', estado: 'Santa Catarina', regiao: 'Sul', ref: 'Florianópolis e sul (Criciúma)', clima: 'Subtropical litorâneo — úmido, inverno ameno no litoral' },
    '49': { uf: 'SC', estado: 'Santa Catarina', regiao: 'Sul', ref: 'Oeste e serra (Chapecó, Lages)', clima: 'Subtropical de altitude — inverno rigoroso, geadas e neve ocasional' },
    '51': { uf: 'RS', estado: 'Rio Grande do Sul', regiao: 'Sul', ref: 'Porto Alegre e região metropolitana', clima: 'Subtropical — verões quentes, invernos frios' },
    '53': { uf: 'RS', estado: 'Rio Grande do Sul', regiao: 'Sul', ref: 'Sul (Pelotas, Rio Grande)', clima: 'Subtropical/temperado — ventoso e frio no inverno' },
    '54': { uf: 'RS', estado: 'Rio Grande do Sul', regiao: 'Sul', ref: 'Serra e norte (Caxias do Sul, Passo Fundo)', clima: 'Subtropical de altitude — inverno rigoroso, vinho e neve ocasional' },
    '55': { uf: 'RS', estado: 'Rio Grande do Sul', regiao: 'Sul', ref: 'Centro e oeste (Santa Maria, Uruguaiana)', clima: 'Subtropical — calor forte no verão, frio no inverno' },
    '61': { uf: 'DF', estado: 'Distrito Federal', regiao: 'Centro-Oeste', ref: 'Brasília e entorno (GO)', clima: 'Tropical de altitude — seca no inverno, chuva no verão' },
    '62': { uf: 'GO', estado: 'Goiás', regiao: 'Centro-Oeste', ref: 'Goiânia e região', clima: 'Tropical continental — quente, seca marcada no inverno' },
    '63': { uf: 'TO', estado: 'Tocantins', regiao: 'Norte', ref: 'Todo o estado (Palmas)', clima: 'Tropical — muito quente, seca no inverno (Jalapão)' },
    '64': { uf: 'GO', estado: 'Goiás', regiao: 'Centro-Oeste', ref: 'Sudoeste goiano (Rio Verde, Caldas Novas)', clima: 'Tropical — quente, águas termais e seca no inverno' },
    '65': { uf: 'MT', estado: 'Mato Grosso', regiao: 'Centro-Oeste', ref: 'Cuiabá e região', clima: 'Tropical continental — uma das capitais mais quentes do país' },
    '66': { uf: 'MT', estado: 'Mato Grosso', regiao: 'Centro-Oeste', ref: 'Interior (Rondonópolis, Sinop)', clima: 'Tropical/equatorial de transição — quente e úmido' },
    '67': { uf: 'MS', estado: 'Mato Grosso do Sul', regiao: 'Centro-Oeste', ref: 'Todo o estado (Campo Grande, Dourados)', clima: 'Tropical/pantaneiro — quente, com friagem no inverno' },
    '68': { uf: 'AC', estado: 'Acre', regiao: 'Norte', ref: 'Todo o estado (Rio Branco)', clima: 'Equatorial — quente e muito úmido, friagem no inverno' },
    '69': { uf: 'RO', estado: 'Rondônia', regiao: 'Norte', ref: 'Todo o estado (Porto Velho)', clima: 'Equatorial — quente e úmido o ano todo' },
    '71': { uf: 'BA', estado: 'Bahia', regiao: 'Nordeste', ref: 'Salvador e região metropolitana', clima: 'Tropical litorâneo — quente e úmido' },
    '73': { uf: 'BA', estado: 'Bahia', regiao: 'Nordeste', ref: 'Sul (Ilhéus, Porto Seguro)', clima: 'Tropical úmido — praias quentes o ano todo' },
    '74': { uf: 'BA', estado: 'Bahia', regiao: 'Nordeste', ref: 'Norte e Chapada (Juazeiro)', clima: 'Semiárido — quente e seco no sertão' },
    '75': { uf: 'BA', estado: 'Bahia', regiao: 'Nordeste', ref: 'Feira de Santana e nordeste baiano', clima: 'Tropical/semiárido de transição — quente' },
    '77': { uf: 'BA', estado: 'Bahia', regiao: 'Nordeste', ref: 'Oeste e sudoeste (Barreiras, V. da Conquista)', clima: 'Tropical de altitude no sudoeste — mais ameno; oeste quente' },
    '79': { uf: 'SE', estado: 'Sergipe', regiao: 'Nordeste', ref: 'Todo o estado (Aracaju)', clima: 'Tropical — quente e úmido no litoral, seco no sertão' },
    '81': { uf: 'PE', estado: 'Pernambuco', regiao: 'Nordeste', ref: 'Recife e região metropolitana', clima: 'Tropical litorâneo — quente e úmido' },
    '82': { uf: 'AL', estado: 'Alagoas', regiao: 'Nordeste', ref: 'Todo o estado (Maceió)', clima: 'Tropical — praias quentes, sertão mais seco' },
    '83': { uf: 'PB', estado: 'Paraíba', regiao: 'Nordeste', ref: 'Todo o estado (João Pessoa, C. Grande)', clima: 'Tropical no litoral, semiárido no interior' },
    '84': { uf: 'RN', estado: 'Rio Grande do Norte', regiao: 'Nordeste', ref: 'Todo o estado (Natal, Mossoró)', clima: 'Tropical/semiárido — sol quase o ano todo, ventos fortes' },
    '85': { uf: 'CE', estado: 'Ceará', regiao: 'Nordeste', ref: 'Fortaleza e região metropolitana', clima: 'Tropical — quente, ventoso, chuvas no 1º semestre' },
    '86': { uf: 'PI', estado: 'Piauí', regiao: 'Nordeste', ref: 'Teresina e norte (Parnaíba)', clima: 'Tropical/semiárido — muito quente' },
    '87': { uf: 'PE', estado: 'Pernambuco', regiao: 'Nordeste', ref: 'Interior (Petrolina, Salgueiro)', clima: 'Semiárido — quente e seco (vale do S. Francisco)' },
    '88': { uf: 'CE', estado: 'Ceará', regiao: 'Nordeste', ref: 'Interior (Juazeiro do Norte, Sobral)', clima: 'Semiárido — quente e seco no sertão' },
    '89': { uf: 'PI', estado: 'Piauí', regiao: 'Nordeste', ref: 'Sul (Picos, Floriano)', clima: 'Semiárido — quente e seco' },
    '91': { uf: 'PA', estado: 'Pará', regiao: 'Norte', ref: 'Belém e região metropolitana', clima: 'Equatorial — quente, úmido e chuvoso' },
    '92': { uf: 'AM', estado: 'Amazonas', regiao: 'Norte', ref: 'Manaus e região', clima: 'Equatorial — quente e úmido o ano todo' },
    '93': { uf: 'PA', estado: 'Pará', regiao: 'Norte', ref: 'Oeste (Santarém)', clima: 'Equatorial — quente e úmido' },
    '94': { uf: 'PA', estado: 'Pará', regiao: 'Norte', ref: 'Sul e sudeste (Marabá, Parauapebas)', clima: 'Equatorial de transição — quente, mineração e Carajás' },
    '95': { uf: 'RR', estado: 'Roraima', regiao: 'Norte', ref: 'Todo o estado (Boa Vista)', clima: 'Equatorial/tropical — quente, lavrado e serra fria' },
    '96': { uf: 'AP', estado: 'Amapá', regiao: 'Norte', ref: 'Todo o estado (Macapá)', clima: 'Equatorial — quente, úmido e chuvoso' },
    '97': { uf: 'AM', estado: 'Amazonas', regiao: 'Norte', ref: 'Interior do Amazonas', clima: 'Equatorial — quente e úmido' },
    '98': { uf: 'MA', estado: 'Maranhão', regiao: 'Nordeste', ref: 'São Luís e região', clima: 'Tropical/equatorial de transição — quente e úmido' },
    '99': { uf: 'MA', estado: 'Maranhão', regiao: 'Nordeste', ref: 'Interior (Imperatriz, Caxias)', clima: 'Tropical — quente, transição Amazônia/sertão' },
};

// Resumo curto da cidade/área de referência (1 frase — DDD cobre a área, não a rua exata)
const RESUMO_CIDADE = {
    '11': 'São Paulo, maior metrópole do país: centro financeiro e cultural, Av. Paulista e gastronomia do mundo todo.',
    '12': 'São José dos Campos, polo aeroespacial (ITA/Embraer) e porta do Litoral Norte.',
    '13': 'Santos, maior porto da América Latina: praia, Museu do Café e terra do Pelé.',
    '14': 'Bauru, cidade do sanduíche famoso e polo universitário do centro-oeste paulista.',
    '15': 'Sorocaba, cidade industrial histórica perto de Itu e do turismo rural.',
    '16': 'Ribeirão Preto, capital do agronegócio e da cerveja artesanal, com campus da USP.',
    '17': 'São José do Rio Preto, polo médico e comercial do noroeste, famosa pelo calor.',
    '18': 'Presidente Prudente, principal cidade do oeste paulista e polo universitário.',
    '19': 'Campinas, polo de tecnologia e da Unicamp, com a Lagoa do Taquaral.',
    '21': 'Rio de Janeiro, a cidade maravilhosa: Cristo Redentor, Copacabana, samba e carnaval.',
    '22': 'Região dos Lagos (Cabo Frio/Búzios): praias claras, turismo e petróleo em Macaé.',
    '24': 'Petrópolis, a cidade imperial na serra: palácios e refúgio de inverno.',
    '27': 'Vitória, capital-ilha com praias e o Convento da Penha.',
    '28': 'Cachoeiro de Itapemirim, terra de Roberto Carlos e do mármore capixaba.',
    '31': 'Belo Horizonte, capital do pão de queijo: Savassi, Praça da Liberdade e bares.',
    '32': 'Juiz de Fora, polo universitário da Zona da Mata na rota Rio-BH.',
    '33': 'Governador Valadares, sob o Pico da Ibituruna às margens do Rio Doce.',
    '34': 'Uberlândia, polo logístico e universitário do Triângulo Mineiro.',
    '35': 'Poços de Caldas, estância hidromineral com teleférico e águas termais.',
    '37': 'Divinópolis, polo industrial e universitário do centro-oeste mineiro.',
    '38': 'Montes Claros, portal do sertão e maior cidade do norte de MG.',
    '41': 'Curitiba, a capital ecológica: Jardim Botânico, Ópera de Arame e frio.',
    '42': 'Ponta Grossa, Campos Gerais com Vila Velha e o Buraco do Padre.',
    '43': 'Londrina, a capital do café no norte do Paraná, com a UEL.',
    '44': 'Maringá, cidade planejada e arborizada, famosa pela Catedral.',
    '45': 'Foz do Iguaçu: Cataratas, Itaipu e tríplice fronteira.',
    '46': 'Francisco Beltrão, polo agro e comercial do sudoeste paranaense.',
    '47': 'Joinville, maior cidade de SC: indústria, Festival de Dança e colonização alemã.',
    '48': 'Florianópolis, a ilha da magia com dezenas de praias e polo tech.',
    '49': 'Chapecó, capital do oeste catarinense: agroindústria e Chapecoense.',
    '51': 'Porto Alegre, capital do chimarrão às margens do Guaíba, terra do Grenal.',
    '53': 'Pelotas, terra do doce e do charque, com casarões históricos.',
    '54': 'Caxias do Sul, capital da serra gaúcha: vinho, uva e Festa da Uva.',
    '55': 'Santa Maria, cidade universitária (UFSM) no coração do RS.',
    '61': 'Brasília, capital modernista de Niemeyer com o Eixo Monumental.',
    '62': 'Goiânia, capital verde do sertanejo, cheia de parques e bares.',
    '63': 'Palmas, capital mais nova do país e porta do Jalapão.',
    '64': 'Caldas Novas e Rio Verde: maiores águas termais do mundo e potência do agro.',
    '65': 'Cuiabá, porta do Pantanal e uma das capitais mais quentes do país.',
    '66': 'Nortão do MT (Sinop/Rondonópolis): fronteira agrícola da soja e do milho.',
    '67': 'Campo Grande, capital do Pantanal sul, terra do tereré.',
    '68': 'Rio Branco, capital acreana da Amazônia, terra de Chico Mendes.',
    '69': 'Porto Velho, às margens do Madeira, com a ferrovia Madeira-Mamoré.',
    '71': 'Salvador, primeira capital do Brasil: Pelourinho, acarajé e carnaval afro.',
    '73': 'Porto Seguro, onde o Brasil começou: praias, axé e Trancoso.',
    '74': 'Juazeiro, terra do São Francisco com vinhos tropicais e forró.',
    '75': 'Feira de Santana, maior entroncamento do Nordeste, terra da Micareta.',
    '77': 'Oeste baiano (Barreiras): fronteira agrícola da soja no cerrado.',
    '79': 'Aracaju, capital tranquila com a Orla de Atalaia.',
    '81': 'Recife, a Veneza brasileira: Olinda, frevo e Porto de Galinhas ali perto.',
    '82': 'Maceió, paraíso das piscinas naturais e das jangadas da Pajuçara.',
    '83': 'João Pessoa, ponto mais oriental das Américas, com pôr do sol no Jacaré.',
    '84': 'Natal, a cidade do sol: dunas de Genipabu e o maior cajueiro do mundo.',
    '85': 'Fortaleza: Beira-Mar, jangadas e forró, porta das praias do Ceará.',
    '86': 'Teresina, única capital nordestina fora do litoral, quente às margens do Parnaíba.',
    '87': 'Petrolina, o sertão que virou vinhedo às margens do São Francisco.',
    '88': 'Juazeiro do Norte, terra do Padre Cícero e das romarias do Cariri.',
    '89': 'Picos, capital do mel no sertão piauiense.',
    '91': 'Belém, porta da Amazônia: Ver-o-Peso, açaí, tacacá e Círio de Nazaré.',
    '92': 'Manaus, metrópole na selva com o Teatro Amazonas e o Encontro das Águas.',
    '93': 'Santarém, onde o Tapajós encontra o Amazonas, com Alter do Chão.',
    '94': 'Carajás (Marabá/Parauapebas): maior província mineral do mundo.',
    '95': 'Boa Vista, no lavrado de Roraima, porta do Monte Roraima.',
    '96': 'Macapá, às margens do Amazonas, com o Marco Zero do Equador.',
    '97': 'Interior do Amazonas: rios, floresta e comunidades ribeirinhas.',
    '98': 'São Luís, ilha do reggae com casarões de azulejo e Bumba Meu Boi.',
    '99': 'Imperatriz, segunda maior do MA e portal da Amazônia oriental.',
};

// Resumo curto dos países mais comuns (estrangeiras)
const PAIS_RESUMO = {
    '1': 'EUA/Canadá: América do Norte, inglês, grandes metrópoles e tecnologia.',
    '351': 'Portugal: país ibérico de praias, fado, vinho do Porto e Lisboa.',
    '54': 'Argentina: terra do tango, do churrasco e da Patagônia, com Buenos Aires.',
    '56': 'Chile: país estreito entre Andes e Pacífico, vinhos e deserto do Atacama.',
    '57': 'Colômbia: café, Caribe (Cartagena) e Bogotá nas montanhas.',
    '58': 'Venezuela: Caribe, tepuyes e as quedas do Salto Ángel.',
    '59': 'Uruguai: praias, churrasco e Montevidéu às margens do Prata.',
    '598': 'Uruguai: praias, churrasco e Montevidéu às margens do Prata.',
    '51': 'Peru: Machu Picchu, Lima e a culinária mais premiada da América do Sul.',
    '52': 'México: tacos, mariachis, praias caribenhas e Cidade do México.',
    '595': 'Paraguai: Assunção, Itaipu e o coração da América do Sul.',
    '591': 'Bolívia: La Paz nas alturas, Salar de Uyuni e cultura andina.',
    '593': 'Equador: linha do Equador, Galápagos e Quito colonial.',
    '81': 'Japão: tecnologia, sushi, templos e as cerejeiras de Tóquio e Kioto.',
    '86': 'China: Grande Muralha, Pequim/Xangai e a maior população do mundo.',
    '82': 'Coreia do Sul: Seul, K-pop, tecnologia e palácios.',
    '91': 'Índia: Taj Mahal, Bollywood e uma das culturas mais antigas do mundo.',
    '39': 'Itália: Roma, pizza, arte renascentista e a Costa Amalfitana.',
    '34': 'Espanha: Madri/Barcelona, flamenco, tapas e praias mediterrâneas.',
    '33': 'França: Paris, Torre Eiffel, vinhos e a Riviera.',
    '49': 'Alemanha: Berlim, cervejas, castelos e indústria forte.',
    '44': 'Reino Unido: Londres, pubs, história e o Big Ben.',
};

function flagEmoji(iso) {
    if (!iso || iso.length !== 2) return '';
    const up = String(iso).toUpperCase().replace(/[^A-Z]/g, '');
    if (up.length !== 2) return '';
    // XK (Kosovo) não tem bandeira em regional-indicator — retorna vazio
    if (up === 'XK') return '';
    const base = 0x1F1E6;
    return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

function onlyDigits(s) {
    return String(s || '').replace(/\D/g, '');
}

// Extrai DDI do início do número usando a tabela (tenta 3, 2 e 1 dígitos).
function splitDdi(digits) {
    const d = onlyDigits(digits);
    if (d.length < 7) return null;
    for (const len of [3, 2, 1]) {
        const cand = d.slice(0, len);
        if (DDI_PAIS[cand]) return { ddi: cand, resto: d.slice(len) };
    }
    return null;
}

function getRegiaoInfo(digits) {
    const d = onlyDigits(digits);
    if (!d || d.length < 7) return null;
    const split = splitDdi(d);
    if (!split) {
        return { digitos: d, ddi: null, pais: 'Desconhecido', iso: null, estrangeira: null, desconhecido: true };
    }
    const { ddi, resto } = split;
    const entry = DDI_PAIS[ddi];
    if (ddi !== '55') {
        return {
            digitos: d,
            ddi,
            pais: entry ? entry.pais : `Código +${ddi}`,
            iso: entry ? entry.iso : null,
            estrangeira: true,
            resumo: PAIS_RESUMO[ddi] || null,
            desconhecido: false
        };
    }
    // Brasil: resto deve ter DDD (10 ou 11 dígitos)
    const ddd = resto.slice(0, 2);
    const info = DDD_INFO[ddd];
    if (!info || resto.length < 10) {
        return { digitos: d, ddi, pais: 'Brasil', iso: 'BR', estrangeira: false, ddd: /^\d{2}$/.test(ddd) ? ddd : null, resumo: (ddd && RESUMO_CIDADE[ddd]) || null, desconhecido: !info };
    }
    return { digitos: d, ddi, pais: 'Brasil', iso: 'BR', estrangeira: false, ddd, ...info, resumo: RESUMO_CIDADE[ddd] || null, desconhecido: false };
}

function formatRegiaoLines(info) {
    if (!info) return ['│ 🌍 *Origem:* número oculto/privado (LID) — região indisponível'];
    if (info.desconhecido && !info.ddi) return ['│ 🌍 *Origem:* desconhecida (número inválido)'];
    const flag = info.iso ? ` ${flagEmoji(info.iso)}` : '';
    if (info.estrangeira) {
        const out = [
            `│ 🌍 *País:* ${info.pais}${flag} (estrangeira)`,
            `│ 📍 *Cidade/País:* ${info.pais} — cidade exata indisponível (só DDI +${info.ddi})`
        ];
        if (info.resumo) out.push(`│ 📝 *Resumo:* ${String(info.resumo).slice(0, 300)}`);
        return out;
    }
    const lines = [`│ 🌍 *País:* Brasil 🇧🇷`];
    if (info.ddd && DDD_INFO[info.ddd]) {
        const r = DDD_INFO[info.ddd];
        lines.push(`│ 📍 *Região:* ${r.regiao} • ${r.uf} — ${r.ref} (DDD ${info.ddd})`);
        lines.push(`│ 🌡️ *Clima:* ${r.clima}`);
        const resumo = info.resumo || RESUMO_CIDADE[info.ddd];
        if (resumo) lines.push(`│ 📝 *Resumo:* ${String(resumo).slice(0, 300)}`);
    } else {
        lines.push(`│ 📍 *Região:* Brasil — DDD ${info.ddd || 'desconhecido'} (área não mapeada)`);
    }
    return lines;
}

module.exports = { DDI_PAIS, DDD_INFO, RESUMO_CIDADE, PAIS_RESUMO, flagEmoji, onlyDigits, splitDdi, getRegiaoInfo, formatRegiaoLines };
