/**
 * AGEMOB — Testes de regressão do PDF oficial (M11)
 *
 * Executar: node --test tests/
 *
 * Usa só dependências do projeto (pdfkit, qrcode) e módulos nativos. O teste
 * de ponta a ponta sobe o server.js real com DATA_DIR/STORAGE_DIR em pasta
 * temporária do sistema, sem e-mail (Brevo desligada) e com chave Ed25519
 * descartável: nunca toca data/, storage/ nem serviços externos.
 *
 * Requisitos cobertos: cláusulas jurídicas íntegras, logo do tenant,
 * assinatura manuscrita, código único, QR Code, certificado de assinatura,
 * trilha de auditoria, integridade do PDF, Dossiê e cadeia de custódia.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { gerarAutorizacaoPDF } = require('../services/pdf');

const RAIZ = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const norm = (s) => s.replace(/\s+/g, '');

// ── Fixtures binárias (PNG gerado aqui, sem dependências) ──
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function png(w, h, pintado) {
  const chunk = (tipo, dados) => { const t = Buffer.from(tipo); const len = Buffer.alloc(4); len.writeUInt32BE(dados.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, dados]))); return Buffer.concat([len, t, dados, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = [];
  for (let y = 0; y < h; y++) { const l = Buffer.alloc(1 + w * 3, 255); l[0] = 0; for (let x = 0; x < w; x++) if (pintado(x, y)) { l[1 + x * 3] = 10; l[2 + x * 3] = 30; l[3 + x * 3] = 80; } linhas.push(l); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(linhas))), chunk('IEND', Buffer.alloc(0))]);
}
const ASSINATURA = png(301, 91, (x, y) => Math.abs(y - (45 + 30 * Math.sin(x / 20))) < 2.5);
const CONJUGE = png(303, 93, (x, y) => Math.abs(y - (46 + 25 * Math.cos(x / 15))) < 2.5);
const SELFIE = png(120, 160, (x, y) => (x - 60) ** 2 + (y - 70) ** 2 < 1600);
const LOGO = png(37, 23, (x) => x < 12);
const DOC_PDF = Buffer.from('%PDF-1.4\n% documento ficticio de teste\n');
const dataUrl = (mime, b) => `data:${mime};base64,${b.toString('base64')}`;

// ── Leitura do PDF gerado pelo pdfkit ──
// Fontes padrão do pdfkit usam WinAnsi: 0x80–0x9F diferem do latin1.
const WINANSI = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ' };
const winAnsi = (hex) => [...Buffer.from(hex, 'hex')].map(b => WINANSI[b] || String.fromCharCode(b)).join('');
function objetos(buf) {
  const s = buf.toString('latin1'); const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const corpo = m[2]; const i = corpo.indexOf('stream'); let dict = corpo, stream = null;
    if (i >= 0 && /^\s*<</.test(corpo)) {
      dict = corpo.slice(0, i); let ini = i + 6; if (corpo[ini] === '\r') ini++; if (corpo[ini] === '\n') ini++;
      stream = Buffer.from(corpo.slice(ini, corpo.lastIndexOf('endstream')), 'latin1');
      if (/FlateDecode/.test(dict)) { try { stream = zlib.inflateSync(stream); } catch { stream = null; } }
    }
    objs.set(Number(m[1]), { dict, stream });
  }
  return objs;
}
function lerPdf(buf) {
  const objs = objetos(buf);
  const raiz = [...objs.values()].find(o => /\/Type \/Pages/.test(o.dict) && /\/Kids/.test(o.dict));
  const kids = [...raiz.dict.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map(k => Number(k[1]));
  const paginas = kids.map(k => {
    const p = objs.get(k);
    const H = Number(p.dict.match(/\/MediaBox \[0 0 [\d.]+ ([\d.]+)\]/)[1]);
    const conteudo = objs.get(Number(p.dict.match(/\/Contents (\d+) 0 R/)[1])).stream.toString('latin1');
    const texto = [...conteudo.matchAll(/\[([^\]]*)\]\s*TJ/g)]
      .map(op => winAnsi([...op[1].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]).join(''))).join('\n');
    const rects = [...conteudo.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/g)].map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    const ys = [...conteudo.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)].map(m => H - Number(m[1]));
    const imagens = [...conteudo.matchAll(/([-\d.]+) 0 0 (-?[\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/I\d+ Do/g)].map(m => ({ y: +m[4], h: Math.abs(+m[2]) }));
    return { H, texto, rects, ys, imagens };
  });
  const imagensDim = [...objs.values()].filter(o => /\/Subtype \/Image/.test(o.dict))
    .map(o => ({ w: Number((o.dict.match(/\/Width (\d+)/) || [])[1]), h: Number((o.dict.match(/\/Height (\d+)/) || [])[1]), mascara: !/\/SMask/.test(o.dict) && /\/DeviceGray/.test(o.dict) }));
  return { paginas, imagensDim, texto: paginas.map(p => p.texto).join('\n') };
}
const temImagem = (pdf, w, h) => pdf.imagensDim.some(i => i.w === w && i.h === h && !i.mascara);

// QR vetorial: reconstrói a matriz a partir dos retângulos e compara com a
// matriz esperada para a URL (mesma biblioteca, mesmo nível de correção).
function qrConfere(pagina, url) {
  const esperado = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
  const n = esperado.size; let achados = 0, corretos = 0;
  pagina.rects.forEach((fundo, i) => {
    if (!(Math.abs(fundo.w - fundo.h) < 0.01 && fundo.w > 50 && fundo.w < 120)) return;
    const p = fundo.w / (n + 8);
    const grade = Array.from({ length: n }, () => new Array(n).fill(false));
    let mods = 0;
    for (const r of pagina.rects.slice(i + 1)) {
      if (!(r.x >= fundo.x - 0.01 && r.y >= fundo.y - 0.01 && r.x + r.w <= fundo.x + fundo.w + 0.01 && r.y + r.h <= fundo.y + fundo.h + 0.01 && r.h < 6)) { if (mods) break; continue; }
      mods++;
      const lin = Math.round((r.y - fundo.y) / p) - 4, c0 = Math.round((r.x - fundo.x) / p) - 4, qtd = Math.round(r.w / p);
      for (let c = c0; c < c0 + qtd; c++) if (lin >= 0 && lin < n && c >= 0 && c < n) grade[lin][c] = true;
    }
    if (!mods) return;
    achados++;
    let igual = true;
    for (let r = 0; r < n && igual; r++) for (let c = 0; c < n; c++) if (grade[r][c] !== !!esperado.get(r, c)) { igual = false; break; }
    if (igual) corretos++;
  });
  return { achados, corretos };
}

// ── Cláusulas jurídicas oficiais (texto congelado; qualquer alteração deve ser deliberada) ──
const CLAUSULAS = {
  prazo: 'PRAZO E RENOVAÇÃO — A presente autorização terá validade inicial de 365 (trezentos e sessenta e cinco) dias, contados da data de assinatura, com vencimento previsto para',
  prazoFim: 'Ao término do prazo, será renovada automaticamente por períodos iguais e sucessivos, até manifestação contrária de qualquer das partes, comunicada formalmente com antecedência mínima de 30 (trinta) dias do vencimento.',
  comissao: (parte) => `COMISSÃO DE CORRETAGEM — Será devida comissão de 6% (seis por cento) sobre o valor total da venda efetivamente realizada. A comissão permanecerá integralmente devida caso o imóvel seja vendido, durante a vigência desta autorização, a cliente apresentado ${parte}, originado de suas campanhas de marketing, cadastrado em seus sistemas ou apresentado por seus parceiros.`,
  exclusividade: (parte) => `EXCLUSIVIDADE — Toda negociação do imóvel deverá ser conduzida exclusivamente ${parte}. Caso o proprietário realize a venda diretamente ou por intermédio de terceiros durante o prazo de exclusividade, a comissão contratada permanecerá devida.`,
  semExcCorretor: 'MODALIDADE SEM EXCLUSIVIDADE — O proprietário poderá anunciar ou negociar o imóvel por meio de imobiliárias ou outros corretores, sendo a comissão devida apenas ao profissional ou empresa que efetivamente intermediar a venda.',
  semExcImob: 'MODALIDADE SEM EXCLUSIVIDADE — O proprietário poderá anunciar ou negociar o imóvel por meio de outras imobiliárias, sendo a comissão devida apenas à imobiliária que efetivamente intermediar a venda.',
  assinada: 'Este documento foi assinado eletronicamente, atendendo aos requisitos de integridade, autenticidade e não repúdio previstos na legislação brasileira (MP 2.200-2/2001 e Lei 14.063/2020). A assinatura e o log de evidências integram este instrumento.',
  registro: 'Este documento foi registrado eletronicamente pela plataforma AGEMOB. Sua autenticidade pode ser verificada a qualquer momento utilizando o código da autorização e o hash criptográfico acima. Qualquer alteração posterior no conteúdo poderá invalidar sua integridade criptográfica, tornando o hash incompatível com o registro original armazenado pela plataforma.'
};

const IMOBILIARIA = { tipo: 'imobiliaria', razao: 'Imobiliária Ficta Ltda.', cnpj: '11.111.111/0001-11', creci: 'J-111', endereco: 'Rua Ficta, 1 - Centro, Cidade Teste' };
const CORRETOR = { tipo: 'corretor', razao: 'Corretor Ficto', cnpj: '', creci: 'F-333', endereco: '' };
const autBase = (codigo, tipo) => ({
  codigo, tipo, hash: sha('dados-' + codigo), assinadoEm: '2026-11-04T18:26:37.120Z', urlValidacao: `https://agemob.invalid/validar/${codigo}`,
  proprietario: { nome: 'Pessoa Ficta de Teste', cpf: '000.000.001-91', whatsapp: '(48) 90000-0000', email: 'ficta@teste.invalid', endereco: 'Rua A, 1 - B, C' },
  imovel: { tipo: 'Casa', endereco: 'Rua Imóvel, 2 - D, E', valor: 980000 }
});
const arquivo = (caminho, mime, b) => ({ caminhoRelativo: caminho, sha256: sha(b), mimeType: mime, tamanhoBytes: b.length });
const evidenciasCompletas = (n = 12) => ({
  servidor: { assinadoEm: '2026-11-04T18:26:37.120Z', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  criadoEm: '2026-11-04T17:58:00.000Z',
  arquivos: [arquivo('assinatura/principal.png', 'image/png', ASSINATURA), arquivo('biometria/selfie.png', 'image/png', SELFIE),
    arquivo('documentos/up_cnh.pdf', 'application/pdf', DOC_PDF), arquivo('assinantes_adicionais/sig_conjuge_0.png', 'image/png', CONJUGE)],
  imagens: { assinatura: { mimeType: 'image/png', buffer: ASSINATURA }, selfie: { mimeType: 'image/png', buffer: SELFIE },
    assinantes: [{ campo: 'sig_conjuge', indice: 0, mimeType: 'image/png', buffer: CONJUGE }] },
  declarados: { otp: [{ canal: 'E-mail', destino: 'ficta@teste.invalid', validadoEm: '04/11/2026, 15:07:32' }], dispositivo: { fusoHorario: 'America/Sao_Paulo (UTC-3)' } },
  eventos: [
    ...Array.from({ length: n }, (_, i) => ({ tipo: 'etapa_concluida', origem: 'declarado', dataHoraCliente: new Date(Date.parse('2026-11-04T18:00:00Z') + i * 1000).toISOString(), detalhe: `Etapa ${i}` })),
    { tipo: 'biometria_executada', origem: 'declarado', dataHoraCliente: '2026-11-04T18:20:00.000Z', detalhe: 'compatibilidade 97% APROVADO' },
    { tipo: 'evidencia_ingerida', origem: 'gerado_pelo_backend', dataHoraServidor: '2026-11-04T18:26:37.100Z', ip: '203.0.113.7' },
    { tipo: 'assinatura_realizada', origem: 'gerado_pelo_backend', dataHoraServidor: '2026-11-04T18:26:37.100Z', ip: '203.0.113.7' }
  ],
  hashEvidencias: sha('registro')
});

// Verificações comuns a qualquer PDF oficial assinado.
function conferirPdfOficial(buf, { aut, imob, ev, logo }) {
  const pdf = lerPdf(buf);
  const t = norm(pdf.texto);
  const n = pdf.paginas.length;
  // Cláusulas jurídicas íntegras
  const corretor = imob.tipo === 'corretor';
  for (const c of [CLAUSULAS.prazo, CLAUSULAS.prazoFim, CLAUSULAS.comissao(corretor ? 'pelo corretor autônomo' : 'pela imobiliária'), CLAUSULAS.assinada, CLAUSULAS.registro])
    assert.ok(t.includes(norm(c)), `cláusula ausente ou alterada: ${c.slice(0, 60)}…`);
  if (aut.tipo === 'exclusiva') assert.ok(t.includes(norm(CLAUSULAS.exclusividade(corretor ? 'pelo corretor autônomo autorizado' : 'pela imobiliária autorizada'))), 'cláusula de exclusividade');
  else assert.ok(t.includes(norm(corretor ? CLAUSULAS.semExcCorretor : CLAUSULAS.semExcImob)), 'cláusula sem exclusividade');
  assert.ok(!t.includes(norm('será assinado eletronicamente')), 'PDF assinado não pode dizer "será assinado"');
  // Identificação do tenant
  if (corretor) assert.ok(t.includes(norm('1. CORRETOR AUTÔNOMO AUTORIZADO')) && t.includes(norm(imob.creci)) && !t.includes('CNPJ'));
  else assert.ok(t.includes(norm('1. IMOBILIÁRIA AUTORIZADA')) && t.includes(norm(imob.cnpj)));
  // Código único: no cabeçalho e no rodapé de todas as páginas, com numeração
  pdf.paginas.forEach((p, i) => {
    const tp = norm(p.texto);
    assert.ok(tp.includes(norm(`Código ${aut.codigo}`)) && tp.includes(norm(`Página ${i + 1} de ${n}`)), `rodapé da página ${i + 1}`);
    const conteudo = [...p.ys, ...p.imagens.map(im => im.y + im.h), ...p.rects.filter(r => r.y > 45).map(r => r.y + r.h)].filter(y => y < p.H - 44);
    const ocupacao = (Math.max(0, ...conteudo) - 62) / (p.H - 120);
    assert.ok(ocupacao >= 0.12, `página ${i + 1} praticamente vazia (${Math.round(ocupacao * 100)}%)`);
  });
  // Logo
  if (logo) assert.ok(temImagem(pdf, logo.w, logo.h), 'logo do tenant');
  else assert.ok(!temImagem(pdf, 37, 23), 'logo não deveria aparecer');
  // Assinatura manuscrita na mesma página do bloco de assinatura, com nome e CPF
  const pAss = pdf.paginas.findIndex(p => norm(p.texto).includes(norm('6. ASSINATURA E VALIDAÇÃO')));
  assert.ok(pAss >= 0, 'bloco de assinatura');
  assert.ok(norm(pdf.paginas[pAss].texto).includes(norm(`${aut.proprietario.nome} · CPF ${aut.proprietario.cpf}`)), 'nome e CPF junto da assinatura');
  if (ev.imagens?.assinatura) {
    assert.ok(temImagem(pdf, 301, 91), 'imagem da assinatura manuscrita');
    assert.ok(pdf.paginas[pAss].imagens.length >= 1, 'assinatura na página do bloco');
  }
  // QR Code: na página da assinatura e no certificado, apontando para a validação pública
  const qrs = pdf.paginas.map(p => qrConfere(p, aut.urlValidacao));
  assert.ok(qrs[pAss].corretos >= 1, 'QR na página da assinatura');
  assert.equal(qrs.reduce((s, q) => s + q.corretos, 0), qrs.reduce((s, q) => s + q.achados, 0), 'todo QR deve apontar para a URL de validação');
  assert.ok(qrs.reduce((s, q) => s + q.corretos, 0) >= 2, 'QR também no certificado');
  // Certificado
  assert.ok(t.includes(norm('CERTIFICADO DE ASSINATURA E CONJUNTO PROBATÓRIO')));
  if (aut.hash) assert.ok(t.includes(aut.hash), 'hash oficial da autorização');
  (ev.arquivos || []).forEach(a => assert.ok(t.includes(a.sha256), `SHA-256 de ${a.caminhoRelativo}`));
  if (ev.servidor?.ip) assert.ok(t.includes(norm(`Endereço IP da conexão:${ev.servidor.ip}`)), 'IP registrado pelo servidor');
  if (ev.imagens?.selfie) assert.ok(t.includes(norm('Não constitui reconhecimento facial, comparação biométrica nem prova de vida.')), 'ressalva da selfie');
  const semRessalva = t.replace(norm('Não constitui reconhecimento facial, comparação biométrica nem prova de vida.'), '');
  assert.ok(!/compatibilidade|APROVADO|CONFIRMADA/i.test(semRessalva), 'nenhuma alegação biométrica');
  assert.ok(!/validad[oa]peloservidor/i.test(t), 'OTP nunca como validado pelo servidor');
  if (ev.declarados?.otp?.length) assert.ok(t.includes(norm('informada como validada pelo dispositivo')));
  // Trilha
  assert.ok(t.includes(norm('REGISTRO CRONOLÓGICO DE EVENTOS')));
  const linhasTrilha = (pdf.texto.match(/^(Servidor|Dispositivo)$/gm) || []).length;
  const esperado = (ev.eventos || []).length + (ev.criadoEm ? 1 : 0);
  assert.equal(linhasTrilha, esperado, 'trilha com todos os eventos reais, nenhum inventado');
  return pdf;
}

test('gerador: imobiliária, exclusiva, logo, selfie, documentos, cônjuge, OTP declarado', async () => {
  const aut = autBase('TESTEIMB1', 'exclusiva'); const ev = evidenciasCompletas();
  const buf = await gerarAutorizacaoPDF(aut, { ...IMOBILIARIA, logo: LOGO }, ev);
  conferirPdfOficial(buf, { aut, imob: IMOBILIARIA, ev, logo: { w: 37, h: 23 } });
});

test('gerador: corretor autônomo, sem exclusividade, sem selfie, sem documentos', async () => {
  const aut = autBase('TESTECOR1', 'simples');
  const ev = { ...evidenciasCompletas(0), arquivos: [arquivo('assinatura/principal.png', 'image/png', ASSINATURA)],
    imagens: { assinatura: { mimeType: 'image/png', buffer: ASSINATURA }, selfie: null, assinantes: [] }, declarados: { otp: [], dispositivo: null } };
  ev.eventos = ev.eventos.filter(e => e.origem === 'gerado_pelo_backend');
  const buf = await gerarAutorizacaoPDF(aut, CORRETOR, ev);
  const pdf = conferirPdfOficial(buf, { aut, imob: CORRETOR, ev });
  assert.ok(pdf.texto.includes('nenhum documento anexado') && !pdf.texto.includes('Selfie do signatário'));
});

test('gerador: trilha extensa pagina com cabeçalho repetido e sem páginas órfãs', async () => {
  const aut = autBase('TESTEEXT1', 'exclusiva'); const ev = evidenciasCompletas(200);
  const pdf = conferirPdfOficial(await gerarAutorizacaoPDF(aut, IMOBILIARIA, ev), { aut, imob: IMOBILIARIA, ev });
  assert.ok(pdf.paginas.filter(p => /Data e hora\nOrigem\nEvento\nDetalhe/.test(p.texto)).length >= 3);
});

test('gerador: logo corrompida é ignorada e o PDF continua completo', async () => {
  const aut = autBase('TESTELOG1', 'exclusiva'); const ev = evidenciasCompletas();
  conferirPdfOficial(await gerarAutorizacaoPDF(aut, { ...IMOBILIARIA, logo: Buffer.from('não é imagem') }, ev), { aut, imob: IMOBILIARIA, ev });
});

// ── Ponta a ponta: servidor real, banco e storage temporários ──
test('ponta a ponta: assinatura → PDF oficial → Dossiê íntegro e cadeia de custódia', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agemob-pdf-test-'));
  const DATA = path.join(tmp, 'data'), STORAGE = path.join(tmp, 'storage');
  const BASE = 'https://homolog.agemob.invalid';
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const filho = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PORT: String(porta),
    DATA_DIR: DATA, STORAGE_DIR: STORAGE, BASE_URL: BASE, JWT_SECRET: 'jwt-teste-' + crypto.randomBytes(8).toString('hex'),
    SUPER_ADMIN_PASS: 'Sup3r-' + crypto.randomBytes(6).toString('hex'), BREVO_API_KEY: '', BREVO_SENDER: '',
    DOSSIE_SIGNING_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    INFINITEPAY_API_KEY: 'inchk_teste', INFINITEPAY_HANDLE: 'agemob-teste' } });
  t.after(() => { filho.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await new Promise((ok, falha) => {
    let saida = '';
    const tempo = setTimeout(() => falha(new Error('servidor não subiu: ' + saida)), 60000);
    filho.stdout.on('data', d => { saida += d; if (saida.includes('rodando')) { clearTimeout(tempo); ok(); } });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('exit', () => falha(new Error('servidor encerrou: ' + saida)));
  });
  let ip = 1;
  const api = async (metodo, url, corpo, token, extra = {}) => {
    const headers = { 'x-forwarded-for': `10.20.0.${ip++ % 250 + 1}`, ...extra };
    if (corpo !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(`http://127.0.0.1:${porta}${url}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, j, buf };
  };
  const conta = async (corpo) => {
    await api('POST', '/api/cadastro', { senha: 'senha123', telefone: '48999999999', ...corpo });
    return (await api('POST', '/api/auth/login', { email: corpo.email, senha: 'senha123' })).j.token;
  };
  const tokImob = await conta({ tipoCliente: 'imobiliaria', nome: 'Imobiliária Ficta Ltda.', cnpj: '11.111.111/0001-11', creci: 'J-111', responsavel: 'Rita Ficta', email: 'imob@teste.invalid' });
  const tokCorr = await conta({ tipoCliente: 'corretor', nome: 'Corretor Ficto', cpf: '529.982.247-25', creci: 'F-333', responsavel: 'Corretor Ficto', email: 'corr@teste.invalid' });
  assert.equal((await api('PUT', '/api/minha-identidade/logo', { arquivo: dataUrl('image/png', LOGO) }, tokImob)).status, 200, 'upload da logo');

  const lerColecao = (nome) => { const u = {}; for (const l of fs.readFileSync(path.join(DATA, nome + '.db'), 'utf8').split('\n').filter(Boolean)) { const d = JSON.parse(l); if (d.$$indexCreated) continue; if (d.$$deleted) delete u[d._id]; else u[d._id] = d; } return Object.values(u); };
  const casos = [
    { token: tokImob, imob: IMOBILIARIA, tipo: 'exclusiva', completo: true, logo: { w: 37, h: 23 } },
    { token: tokCorr, imob: CORRETOR, tipo: 'simples', completo: false }
  ];
  for (const c of casos) {
    const codigo = (await api('POST', '/api/autorizacoes', {}, c.token)).j.codigo;
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
    const corpo = {
      codigo, tipo: c.tipo,
      proprietario: { nome: 'Pessoa Ficta de Teste', cpf: '000.000.001-91', email: 'ficta@teste.invalid', zap: '(48) 90000-0000', end: 'Rua A', num: '1', bairro: 'B', cidade: 'C' },
      imovel: { tipo: 'Casa', end: 'Rua Imóvel', num: '2', bairro: 'D', cidade: 'E', valor: 980000 },
      otp: c.completo ? [{ canal: 'E-mail', destino: 'ficta@teste.invalid', validadoEm: '04/11/2026, 15:07:32' }] : [],
      facial: c.completo ? { compatibilidade: 97, aprovado: true } : null, liveness: c.completo ? { aprovado: true } : null, uploads: [],
      assinatura: dataUrl('image/png', ASSINATURA),
      selfie: c.completo ? dataUrl('image/png', SELFIE) : null,
      documentos: c.completo ? [{ campo: 'up_cnh', b64: dataUrl('application/pdf', DOC_PDF) }] : [],
      assinantes: c.completo ? [{ campo: 'sig_conjuge', indice: 0, b64: dataUrl('image/png', CONJUGE) }] : [],
      eventos: c.completo ? [{ tipo: 'Sessão iniciada', detalhe: 'Chrome · Android', dataHora: '2026-11-04T18:00:00.000Z', sessao: 's1' },
        { tipo: 'Reconhecimento facial', detalhe: 'compatibilidade 97% APROVADO', dataHora: '2026-11-04T18:10:00.000Z', sessao: 's1' }] : []
    };
    const r = await api('POST', '/api/autorizacoes/assinar', corpo, null, { 'user-agent': ua, 'x-forwarded-for': '203.0.113.41' });
    assert.equal(r.status, 200, 'assinatura aceita');
    const reg = lerColecao('autorizacoes').find(a => a.codigo === codigo);
    const pdfBaixado = await api('GET', `/api/autorizacoes/${codigo}/pdf`);
    assert.equal(pdfBaixado.status, 200);
    const autPdf = { codigo, tipo: c.tipo, hash: reg.hash, urlValidacao: `${BASE}/validar/${codigo}`, proprietario: { nome: 'Pessoa Ficta de Teste', cpf: '000.000.001-91' } };
    const ev = {
      servidor: { ip: '203.0.113.41' }, criadoEm: true, arquivos: reg.evidenciasRecebidas.arquivos,
      imagens: { assinatura: true, selfie: c.completo || null }, declarados: { otp: corpo.otp },
      eventos: [...corpo.eventos, 'evidencia_ingerida', 'assinatura_realizada']
    };
    conferirPdfOficial(pdfBaixado.buf, { aut: autPdf, imob: c.imob, ev, logo: c.logo });
    assert.ok(norm(lerPdf(pdfBaixado.buf).texto).includes(norm(`Navegador e sistema:Chrome · Android`)), 'User-Agent recebido pelo servidor');
    // Integridade do PDF e Dossiê
    const dir = path.join(STORAGE, reg.dossiePath);
    const hashes = JSON.parse(fs.readFileSync(path.join(dir, 'hashes.json'), 'utf8'));
    assert.equal(hashes.componentesDossie.pdfOficial.sha256, sha(pdfBaixado.buf), 'hash do PDF registrado no Dossiê');
    const v = await api('GET', `/api/validar/${codigo}`);
    assert.equal(v.j.valido, true, 'validação pública: Dossiê íntegro');
    const custodia = JSON.parse(fs.readFileSync(path.join(dir, 'custodia', 'eventos.json'), 'utf8'));
    assert.ok((custodia.eventos || custodia).length > 0, 'cadeia de custódia gravada');
    // Adulteração do PDF é detectada pela validação pública
    const arqPdf = path.join(STORAGE, 'assinados', `${codigo}.pdf`);
    const original = fs.readFileSync(arqPdf);
    fs.writeFileSync(arqPdf, Buffer.concat([original, Buffer.from('\n% adulterado')]));
    assert.equal((await api('GET', `/api/validar/${codigo}`)).j.valido, false, 'PDF adulterado deve invalidar a verificação');
    fs.writeFileSync(arqPdf, original);
    assert.equal((await api('GET', `/api/validar/${codigo}`)).j.valido, true);
    // Reenvio idempotente não regenera o PDF já assinado
    await api('POST', '/api/autorizacoes/assinar', corpo, null, { 'user-agent': ua });
    assert.equal(sha(fs.readFileSync(arqPdf)), sha(original), 'PDF assinado não é regenerado');
  }
});
