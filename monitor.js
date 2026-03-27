const { chromium } = require('playwright');
const fs = require('fs');
const nodemailer = require('nodemailer');

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA; // App Password do Gmail
const ARQUIVO_ESTADO = 'estado.json';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_REMETENTE,
      pass: EMAIL_SENHA,
    },
  });

  const linhas = novas.map(p =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.tipo || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.autor || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.data || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.ementa || '-'}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ ALEP — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://consultas.assembleia.pr.leg.br/#/pesquisa-legislativa">consultas.assembleia.pr.leg.br</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor ALEP" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ALEP: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function buscarProposicoes() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const proposicoes = [];

  // Intercepta as respostas da API de proposições
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/public/geral/recaptcha') && url.includes('/proposicao')) {
      try {
        const json = await response.json();
        // A resposta pode ser array direto ou objeto com content/data
        const lista = Array.isArray(json) ? json :
                      json.content ? json.content :
                      json.data ? json.data : [];
        if (lista.length > 0) {
          proposicoes.push(...lista);
          console.log(`📦 Capturadas ${lista.length} proposições via API`);
        }
      } catch (e) {
        // não era JSON de proposições
      }
    }
  });

  try {
    console.log('🌐 Abrindo portal da ALEP...');
    await page.goto('https://consultas.assembleia.pr.leg.br/#/pesquisa-legislativa', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    await page.waitForTimeout(3000);

    // Pega o ano atual
    const anoAtual = new Date().getFullYear().toString();

    // Tenta preencher campo de ano (pesquisa por ano atual)
    try {
      const campoAno = await page.$('input[placeholder*="no"], input[id*="ano"], select[id*="ano"]');
      if (campoAno) {
        await campoAno.fill(anoAtual);
        console.log(`📅 Preencheu ano: ${anoAtual}`);
      }
    } catch (e) {
      console.log('Campo ano não encontrado, pesquisando sem filtro de ano');
    }

    // Aguarda o botão aparecer e clica
    console.log('🔍 Aguardando botão Pesquisar...');
    await page.waitForSelector('button.btn-search', { timeout: 15000 });
    await page.click('button.btn-search');
    console.log('✅ Clicou em Pesquisar');

    // Aguarda resposta da API (até 45s para o reCAPTCHA ser resolvido)
    console.log('⏳ Aguardando resultados...');
    await page.waitForTimeout(15000);

    // Tenta extrair da tabela de resultados caso interceptação não funcionou
    if (proposicoes.length === 0) {
      console.log('🔎 Tentando extrair da tabela HTML...');
      const linhasTabela = await page.$$eval('table tbody tr', rows =>
        rows.map(row => {
          const cols = Array.from(row.querySelectorAll('td'));
          return {
            tipo: cols[0]?.innerText?.trim() || '',
            numero: cols[1]?.innerText?.trim() || '',
            autor: cols[2]?.innerText?.trim() || '',
            data: cols[3]?.innerText?.trim() || '',
            ementa: cols[4]?.innerText?.trim() || '',
          };
        }).filter(r => r.numero)
      );
      proposicoes.push(...linhasTabela);
      console.log(`📋 Extraídas ${linhasTabela.length} proposições da tabela HTML`);
    }

  } catch (e) {
    console.error('Erro no scraping:', e.message);
  } finally {
    await browser.close();
  }

  return proposicoes;
}

// ─── NORMALIZA proposição para ID único ───────────────────────────────────────
function gerarId(p) {
  // Tenta campos da API JSON primeiro, depois HTML
  return (
    p.id ||
    p.idProposicao ||
    `${p.tipo || p.sigla || ''}-${p.numero || p.nro || ''}-${p.ano || ''}`.replace(/\s/g, '')
  );
}

function normalizarProposicao(p) {
  return {
    id: gerarId(p),
    tipo: p.sigla || p.tipo || p.tipoProposicao || '-',
    numero: p.numero || p.nro || '-',
    ano: p.ano || '-',
    autor: p.autor || p.nomeAutor || p.autores || '-',
    data: p.dataApresentacao || p.data || '-',
    ementa: (p.ementa || p.descricao || '-').substring(0, 200),
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Iniciando monitor ALEP...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada. Verifique o script.');
    process.exit(0);
  }

  const proposicoes = proposicoesRaw.map(normalizarProposicao).filter(p => p.id);
  console.log(`📊 Total de proposições obtidas: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);

    // Atualiza estado
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
