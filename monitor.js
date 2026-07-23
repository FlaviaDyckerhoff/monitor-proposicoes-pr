const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALEP';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const API_BASE = 'http://webservices.assembleia.pr.leg.br/api/public';
const CONSULTA_BASE = `${API_BASE}/proposicao`;
const SITE_ALEP_BASE = 'https://www.assembleia.pr.leg.br';
const MAX_TENTATIVAS_API = Number(process.env.MAX_TENTATIVAS_API || 3);
const INTERVALO_RETRY_MS = Number(process.env.INTERVALO_RETRY_MS || 45000);
const INTERVALO_ALERTA_FALHA_MS = Number(process.env.INTERVALO_ALERTA_FALHA_MS || 12 * 60 * 60 * 1000);
const FALLBACK_NOTICIAS_DIAS = Number(process.env.FALLBACK_NOTICIAS_DIAS || 14);
const FALLBACK_MAX_ARTIGOS = Number(process.env.FALLBACK_MAX_ARTIGOS || 30);
const API_JANELA_DIAS = Number(process.env.API_JANELA_DIAS || 21);
const API_NUMERO_MAXIMO_REGISTRO = Number(process.env.API_NUMERO_MAXIMO_REGISTRO || 500);
const API_DATA_INICIAL = process.env.API_DATA_INICIAL || '';
const API_DATA_FINAL = process.env.API_DATA_FINAL || '';
const TIPOS_INCLUIR = process.env.TIPOS_INCLUIR || '';
const ENVIAR_APENAS_DESDE = process.env.ENVIAR_APENAS_DESDE || '';
const MARCAR_EXCLUIDOS_COMO_VISTOS = process.env.MARCAR_EXCLUIDOS_COMO_VISTOS === '1';
const EMAIL_ASSUNTO_PREFIXO = process.env.EMAIL_ASSUNTO_PREFIXO || '';
const DRY_RUN = process.env.DRY_RUN === '1';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escaparHtml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dataLocalIso(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(data);
  const mapa = Object.fromEntries(partes.map(p => [p.type, p.value]));
  return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function subtrairDiasLocal(data = new Date(), dias = 0) {
  const d = new Date(data.getTime());
  d.setUTCDate(d.getUTCDate() - dias);
  return dataLocalIso(d);
}

function tipoCanonico(valor) {
  return normalizarTexto(valor)
    .toUpperCase()
    .replace(/^PRO$/, 'PL')
    .replace(/^PLO$/, 'PL')
    .replace(/^PROJETO DE LEI ORDINARIA$/, 'PL')
    .replace(/^PROJETO DE LEI$/, 'PL')
    .replace(/^PROJETO DE LEI COMPLEMENTAR$/, 'PLC')
    .replace(/^EMENDA DE PLENARIO$/, 'EPL')
    .replace(/^PROPOSTA DE EMENDA A CONSTITUICAO$/, 'PEC')
    .replace(/^PROJETO DECRETO LEGISLATIVO$/, 'PDL')
    .replace(/^PROJETO DE RESOLUCAO$/, 'PR')
    .replace(/^REQUERIMENTO$/, 'REQ')
    .replace(/[^A-Z0-9]/g, '');
}

function tiposIncluidosSet() {
  if (!TIPOS_INCLUIR.trim()) return null;
  return new Set(
    TIPOS_INCLUIR.split(',')
      .map(tipoCanonico)
      .filter(Boolean)
  );
}

function dataIsoProposicao(p) {
  const valor = p && (p.dataIso || p.dataApresentacao || p.dataRecebimento || p.dataEntrada || p.data);
  if (!valor) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(String(valor))) return String(valor).slice(0, 10);
  const partes = String(valor).match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
  if (partes) return `${partes[3]}-${partes[2]}-${partes[1]}`;
  const data = new Date(String(valor));
  return Number.isNaN(data.getTime()) ? '' : dataLocalIso(data);
}

function chaveProposicao(p) {
  const tipo = tipoCanonico(p.sigla || p.tipo || p.tipoProposicao || '');
  const numero = String(p.numero || p.nro || '').replace(/\D/g, '');
  const ano = String(p.ano || '').replace(/\D/g, '');
  if (!tipo || !numero || !ano) return null;
  return `${tipo}-${numero}-${ano}`;
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}

function numeroInteiro(valor) {
  const n = parseInt(String(valor || '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function formatarDataAlepr(valor) {
  if (!valor) return '-';
  const data = new Date(String(valor));
  if (Number.isNaN(data.getTime())) return String(valor);
  return data.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function compararProposicoesEmail(a, b) {
  const tipo = compararTiposEmail(a.tipo, b.tipo);
  if (tipo !== 0) return tipo;
  const anoA = numeroInteiro(a.ano);
  const anoB = numeroInteiro(b.ano);
  if (anoA !== anoB) return anoA - anoB;
  const numeroA = numeroInteiro(a.numero);
  const numeroB = numeroInteiro(b.numero);
  if (numeroA !== numeroB) return numeroA - numeroB;
  return String(a.autor || '').localeCompare(String(b.autor || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = String(p?.tipo ?? p?.sigla ?? p?.rotulo ?? '').trim();
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || p?.natureza || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const atual = porTipo.get(tipo);
    if (!atual || partes.numeroInt > atual.numeroInt) {
      porTipo.set(tipo, {
        tipo,
        numeroInt: partes.numeroInt,
        numero: partes.numero,
        ano: partes.ano || String(p?.ano || p?.ano_proposicao || ''),
        ementa: String(p?.ementa || p?.resumo || p?.assunto || '').trim(),
        link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
        clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      });
    }
  });
  return Array.from(porTipo.values());
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      let item = casa.items.find(i => String(i?.tipo || '').toUpperCase() === rec.tipo);
      if (!item) {
        item = { tipo: rec.tipo, base: 0, mon: rec.numeroInt };
        casa.items.push(item);
      }
      const base = Number.parseInt(String(item.base || item.mon || 0), 10) || 0;
      item.tipo = rec.tipo;
      item.mon = rec.numeroInt;
      item.delta = Math.abs(rec.numeroInt - base);
      item.sentido = rec.numeroInt === base ? 'bate com o controle' : 'fonte/sistema acima';
      item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
      item.ementa = rec.ementa || item.ementa || '';
      item.link = rec.link || item.link || '';
      item.clienteSugestao = rec.clienteSugestao || item.clienteSugestao || '';
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  anotarClientesCitados(novas);
  const temFallback = novas.some(p => p.fonte === 'fallback-noticias-alep');
  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN=1 — email não enviado. Itens que seriam enviados: ${novas.length}`);
    novas.forEach(p => console.log(`  - ${p.tipo || '-'} ${p.numero || '-'}/${p.ano || '-'} | ${renderizarEmentaCliente(p)} | ${p.url || '-'}`));
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo
  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const itens = [...porTipo[tipo]].sort(compararProposicoesEmail);
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = itens.map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${escaparHtml(p.tipo || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong><a href="${escaparHtml(p.url || 'https://consultas.assembleia.pr.leg.br/#/pesquisa-legislativa')}" style="color:#1a3a5c;text-decoration:none">${escaparHtml(p.numero || '-')}/${escaparHtml(p.ano || '-')}</a></strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${escaparHtml(p.autor || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${escaparHtml(p.data || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}${p.fonte === 'fallback-noticias-alep' ? '<br><span style="color:#9a3412;font-size:11px">Fonte alternativa: notícia oficial ALEP enquanto API pública está indisponível.</span>' : ''}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ Assembleia Legislativa do Paraná — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <p style="background:#f8fafc;border:1px solid #cbd5e1;color:#334155;padding:10px;border-radius:4px;font-size:13px">
        <strong>Nota operacional:</strong> conferir a fonte oficial da ALEP para confirmar se os itens enviados estão alinhados ao site público, pois a API aberta pode apresentar defasagem temporária.
      </p>
      ${temFallback ? '<p style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px;border-radius:4px"><strong>Atenção:</strong> a API pública da ALEP está indisponível. Estes itens vieram do fallback por notícias oficiais e devem ser conferidos quando a API voltar.</p>' : ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Os números/anos acima estão hyperlinkados para a fonte oficial da ALEP.
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Paraná" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `${EMAIL_ASSUNTO_PREFIXO}${temFallback ? '⚠️ ' : '🏛️ '}Paraná: ${novas.length} nova(s) proposição(ões)${temFallback ? ' via fallback' : ''} — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

async function enviarEmailFalhaFonte(erro) {
  if (DRY_RUN) {
    console.log('🧪 DRY_RUN=1 — email de falha não enviado.');
    return false;
  }

  if (!EMAIL_REMETENTE || !EMAIL_SENHA || !EMAIL_DESTINO) {
    console.log('⚠️ Email de falha não enviado: credenciais de email ausentes.');
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const mensagem = String(erro && erro.message ? erro.message : erro).slice(0, 1200);

  await transporter.sendMail({
    from: `"Monitor Paraná" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `⚠️ ALEP/PR: fonte de proposições indisponível — ${new Date().toLocaleDateString('pt-BR')}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:760px;margin:0 auto">
        <h2 style="color:#9a3412">ALEP/PR — fonte de proposições indisponível</h2>
        <p>O monitor tentou consultar a API pública da ALEP e a fonte continua fora.</p>
        <p><strong>Erro:</strong></p>
        <pre style="white-space:pre-wrap;background:#f7f7f7;padding:12px;border:1px solid #ddd">${mensagem}</pre>
        <p style="font-size:12px;color:#666">Este alerta tem trava de repetição para evitar spam enquanto o backend da ALEP estiver instável.</p>
      </div>
    `,
  });

  console.log('⚠️ Email de falha enviado.');
  return true;
}

async function buscarProposicoesApi() {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const dataFinal = API_DATA_FINAL || dataLocalIso(hoje);
  const dataInicial = API_DATA_INICIAL || subtrairDiasLocal(hoje, API_JANELA_DIAS);

  const body = {
    ano: ano,
    numeroMaximoRegistro: API_NUMERO_MAXIMO_REGISTRO,
    dataInicial,
    dataFinal,
  };

  console.log(`🔍 Buscando proposições de ${ano}, janela ${dataInicial} a ${dataFinal}...`);

  const response = await fetch(`${API_BASE}/proposicao/filtrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const texto = await response.text();
    throw new Error(
      `API ALEP indisponível: ${response.status} ${response.statusText}. ` +
      `Resposta: ${texto.substring(0, 300)}`
    );
  }

  const json = await response.json();
  console.log('📦 Resposta da API (estrutura):', JSON.stringify(json).substring(0, 300));

  const lista = Array.isArray(json) ? json :
                json.content ? json.content :
                json.data ? json.data :
                json.lista ? json.lista :
                json.proposicoes ? json.proposicoes : [];

  console.log(`📊 ${lista.length} proposições recebidas`);
  if (lista.length === 0) {
    throw new Error('API ALEP retornou lista vazia para o ano corrente; tratando como falha para evitar verde falso.');
  }
  return lista;
}

async function buscarProposicoes() {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_API; tentativa++) {
    try {
      if (tentativa > 1) console.log(`🔁 Retry API ALEP ${tentativa}/${MAX_TENTATIVAS_API}...`);
      return await buscarProposicoesApi();
    } catch (erro) {
      ultimoErro = erro;
      console.log(`⚠️ Falha na API ALEP tentativa ${tentativa}/${MAX_TENTATIVAS_API}: ${erro.message}`);
      if (tentativa < MAX_TENTATIVAS_API) await sleep(INTERVALO_RETRY_MS);
    }
  }
  throw ultimoErro;
}

function limparHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ccedil;/g, 'ç')
    .replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&ocirc;/g, 'ô')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairTitulo(html) {
  const h1 = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return limparHtml(h1[1]);
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? limparHtml(title[1]).replace(/\s*\|\s*Assembleia Legislativa do Paraná\s*$/i, '') : '';
}

function extrairDataIso(html) {
  const time = String(html || '').match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (time) {
    const parsed = new Date(time[1].replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const data = String(html || '').match(/(\d{2})\/(\d{2})\/(20\d{2})/);
  if (data) {
    const parsed = new Date(`${data[3]}-${data[2]}-${data[1]}T12:00:00-03:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function extrairResumoArtigo(html) {
  const artigo = String(html || '').match(/<article[^>]*id=["']noticia-impressao["'][^>]*>([\s\S]*?)<\/article>/i);
  const base = artigo ? artigo[1] : String(html || '');
  const paragrafos = [...base.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => limparHtml(m[1]))
    .filter(t => t.length > 40 && !/Assembleia Legislativa do Paraná|Leia também/i.test(t));
  return paragrafos[0] || limparHtml(base).slice(0, 500);
}

function extrairAutor(texto) {
  const m = String(texto || '').match(/(?:de autoria d[ao]|autoria d[ao])\s+(deputad[ao](?: estadual)?\s+[^,.()]+(?:\([^)]*\))?)/i);
  return m ? m[1].trim() : '-';
}

function ehContextoDeProposicaoNova(titulo, texto, indice) {
  const tituloNormalizado = normalizarTexto(titulo).toLowerCase();
  const contexto = normalizarTexto(texto.slice(Math.max(0, indice - 220), indice + 260)).toLowerCase();
  if (/\b(aprovad[ao]|sancionad[ao]|promulgad[ao]|pauta|ordem do dia|homenageia|audiencia publica)\b/i.test(contexto) &&
      !/\b(tramita|apresentad[ao]|protocola|protocolad[ao]|deu entrada|preve|quer|visa|institui)\b/i.test(contexto)) {
    return false;
  }
  return /projeto/.test(tituloNormalizado) &&
    /\b(tramita|apresentad[ao]|protocola|protocolad[ao]|deu entrada|preve|quer|visa|institui)\b/i.test(contexto);
}

function extrairProposicoesDoTexto(titulo, texto) {
  const achados = [];
  const visto = new Set();
  const anoAtual = String(new Date().getFullYear());
  const padroes = [
    /(?:Projeto de Lei|Projeto de lei|PL)\s*(?:n[ºo.]*)?\s*(\d{1,5})\s*\/\s*(20\d{2})/gi,
    /(?:proposta|proposição)\s*(?:de\s*)?(?:n[ºo.]*)?\s*(\d{1,5})\s*\/\s*(20\d{2})/gi
  ];
  for (const re of padroes) {
    for (const m of texto.matchAll(re)) {
      const numero = String(m[1]);
      const ano = String(m[2]);
      if (ano !== anoAtual) continue;
      if (!ehContextoDeProposicaoNova(titulo, texto, m.index || 0)) continue;
      const chave = `PL-${numero}-${ano}`;
      if (visto.has(chave)) continue;
      visto.add(chave);
      achados.push({ tipo: 'PL', numero, ano });
    }
  }
  return achados;
}

async function buscarLinksNoticiasFallback() {
  const buscas = [
    'projeto de lei 2026',
    'PL 2026',
    'tramita Projeto de Lei 2026'
  ];
  const links = [];
  const vistos = new Set();
  for (const termo of buscas) {
    const url = `${SITE_ALEP_BASE}/search?query=${encodeURIComponent(termo)}`;
    console.log(`🛟 Fallback ALEP: buscando notícias por "${termo}"...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`⚠️ Fallback ALEP: busca retornou ${response.status} para ${termo}`);
      continue;
    }
    const html = await response.text();
    const re = /href=["'](https:\/\/www\.assembleia\.pr\.leg\.br\/comunicacao\/noticias\/[^"'#?]+|\/comunicacao\/noticias\/[^"'#?]+)["']/gi;
    for (const m of html.matchAll(re)) {
      const link = m[1].startsWith('http') ? m[1] : `${SITE_ALEP_BASE}${m[1]}`;
      if (vistos.has(link)) continue;
      vistos.add(link);
      links.push(link);
      if (links.length >= FALLBACK_MAX_ARTIGOS) return links;
    }
  }
  return links;
}

async function buscarProposicoesFallbackNoticias(estado = {}) {
  const limitePadraoMs = Date.now() - FALLBACK_NOTICIAS_DIAS * 24 * 60 * 60 * 1000;
  const limiteConfigurado = process.env.FALLBACK_NOTICIAS_DESDE || estado.inicio_falha_api || estado.ultima_sucesso_api;
  const limiteMs = limiteConfigurado && !Number.isNaN(Date.parse(limiteConfigurado))
    ? Math.max(limitePadraoMs, Date.parse(limiteConfigurado))
    : limitePadraoMs;
  const links = await buscarLinksNoticiasFallback();
  const proposicoes = [];
  const chaves = new Set();

  console.log(`🛟 Fallback ALEP: analisando ${links.length} notícia(s) oficial(is)...`);
  for (const url of links) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`⚠️ Fallback ALEP: artigo ${response.status} — ${url}`);
        continue;
      }
      const html = await response.text();
      const dataIso = extrairDataIso(html);
      if (dataIso && Date.parse(dataIso) < limiteMs) continue;

      const titulo = extrairTitulo(html);
      const resumo = extrairResumoArtigo(html);
      const texto = `${titulo}\n${resumo}\n${limparHtml(html)}`;
      const autor = extrairAutor(texto);
      for (const item of extrairProposicoesDoTexto(titulo, texto)) {
        const chave = chaveProposicao(item);
        if (!chave || chaves.has(chave)) continue;
        chaves.add(chave);
        proposicoes.push({
          id: `fallback-noticia-${chave}`,
          chave,
          tipo: item.tipo,
          numero: item.numero,
          ano: item.ano,
          autor,
          data: dataIso ? new Date(dataIso).toLocaleDateString('pt-BR') : '-',
          ementa: resumo || titulo,
          url,
          fonte: 'fallback-noticias-alep'
        });
      }
    } catch (erro) {
      console.log(`⚠️ Fallback ALEP: erro ao analisar ${url}: ${erro.message}`);
    }
  }

  console.log(`🛟 Fallback ALEP: ${proposicoes.length} proposição(ões) extraída(s) de notícias oficiais.`);
  return proposicoes;
}

function gerarId(p) {
  return p.id || p.codigo || p.idProposicao ||
    `${p.sigla || p.tipo || ''}-${p.numero || ''}-${p.ano || ''}`.replace(/\s/g, '');
}

function normalizarProposicao(p) {
  const dataBruta = p.dataApresentacao || p.dataRecebimento || p.dataEntrada || p.data;
  const normalizada = {
    id: gerarId(p),
    tipo: p.sigla || p.tipo || p.tipoProposicao || '-',
    numero: p.numero || p.nro || '-',
    ano: p.ano || '-',
    autor: p.autor || p.nomeAutor || p.autores || '-',
    data: formatarDataAlepr(dataBruta),
    dataIso: dataIsoProposicao({ data: dataBruta }),
    ementa: (p.ementa || p.descricao || '-'),
    url: `${CONSULTA_BASE}/${gerarId(p)}`,
  };
  normalizada.chave = chaveProposicao(normalizada);
  return normalizada;
}

(async () => {
  console.log('🚀 Iniciando monitor ALEPR...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);
  const chavesVistas = new Set(estado.chaves_proposicoes_vistas || []);

  let proposicoesRaw;
  let fonteUsada = 'api-public-alep';
  try {
    proposicoesRaw = await buscarProposicoes();
  } catch (erro) {
    estado.ultima_execucao = new Date().toISOString();
    estado.ultima_falha = {
      data: new Date().toISOString(),
      fonte: 'api-public-alep',
      erro: String(erro && erro.message ? erro.message : erro).slice(0, 2000),
    };

    let fallback = [];
    try {
      fallback = await buscarProposicoesFallbackNoticias(estado);
    } catch (erroFallback) {
      console.log(`⚠️ Fallback ALEP também falhou: ${erroFallback.message}`);
    }

    if (fallback.length > 0) {
      proposicoesRaw = fallback;
      fonteUsada = 'fallback-noticias-alep';
      estado.ultimo_fallback = {
        data: new Date().toISOString(),
        fonte: fonteUsada,
        total_extraido: fallback.length,
      };
    } else {
      estado.ultimo_fallback = {
        data: new Date().toISOString(),
        fonte: 'fallback-noticias-alep',
        total_extraido: 0,
      };

    const ultimoAlertaMs = estado.ultimo_alerta_falha ? Date.parse(estado.ultimo_alerta_falha) : 0;
    const deveAlertar = !ultimoAlertaMs || Date.now() - ultimoAlertaMs > INTERVALO_ALERTA_FALHA_MS;
    if (deveAlertar) {
      const alertaEnviado = await enviarEmailFalhaFonte(erro);
      if (alertaEnviado) estado.ultimo_alerta_falha = new Date().toISOString();
    } else {
      console.log('⚠️ Fonte segue indisponível; alerta de falha já enviado recentemente.');
    }

      if (!DRY_RUN) salvarEstado(estado);
      process.exitCode = 2;
      return;
    }
  }

  const proposicoes = proposicoesRaw
    .map(p => p.fonte === 'fallback-noticias-alep' ? p : normalizarProposicao(p))
    .filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);
  console.log(`📡 Fonte usada: ${fonteUsada}`);

  const tiposPermitidos = tiposIncluidosSet();
  const novasBrutas = proposicoes.filter(p => !idsVistos.has(p.id) && (!p.chave || !chavesVistas.has(p.chave)));
  const novas = [];
  const marcadasSemEmail = [];
  for (const p of novasBrutas) {
    const tipoOk = !tiposPermitidos || tiposPermitidos.has(tipoCanonico(p.tipo || p.sigla || p.tipoProposicao || ''));
    const dataOk = !ENVIAR_APENAS_DESDE || dataIsoProposicao(p) >= ENVIAR_APENAS_DESDE;
    if (tipoOk && dataOk) {
      novas.push(p);
    } else if (MARCAR_EXCLUIDOS_COMO_VISTOS) {
      marcadasSemEmail.push(p);
    }
  }
  console.log(`🆕 Proposições novas: ${novas.length}`);
  if (marcadasSemEmail.length > 0) {
    console.log(`🔇 Marcando sem email: ${marcadasSemEmail.length} proposição(ões) fora do recorte de envio.`);
  }

  if (novas.length > 0) {
    novas.sort(compararProposicoesEmail);
    await sincronizarRadar03(novas);
    await enviarEmail(novas);
    [...novas, ...marcadasSemEmail].forEach(p => idsVistos.add(p.id));
    [...novas, ...marcadasSemEmail].map(chaveProposicao).filter(Boolean).forEach(chave => chavesVistas.add(chave));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.chaves_proposicoes_vistas = Array.from(chavesVistas);
    estado.ultima_execucao = new Date().toISOString();
    if (fonteUsada === 'api-public-alep') estado.ultima_sucesso_api = estado.ultima_execucao;
    if (!DRY_RUN) salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    marcadasSemEmail.forEach(p => idsVistos.add(p.id));
    marcadasSemEmail.map(chaveProposicao).filter(Boolean).forEach(chave => chavesVistas.add(chave));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.chaves_proposicoes_vistas = Array.from(chavesVistas);
    estado.ultima_execucao = new Date().toISOString();
    if (fonteUsada === 'api-public-alep') estado.ultima_sucesso_api = estado.ultima_execucao;
    if (!DRY_RUN) salvarEstado(estado);
  }
})();
