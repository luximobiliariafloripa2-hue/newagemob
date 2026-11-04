/**
 * AGEMOB — Geração do PDF oficial da Autorização de Venda (servidor)
 *
 * Três seções: (1) Autorização de Venda, (2) Certificado de Assinatura
 * Eletrônica e (3) Trilha de Auditoria. Cláusulas e textos jurídicos são os
 * mesmos da versão anterior; muda só a apresentação.
 *
 * Regras de evidência:
 * - "Verificado pelo servidor" só para o que o próprio servidor recebeu ou
 *   observou: arquivos (hash SHA-256 calculado no servidor), IP da conexão,
 *   User-Agent da requisição, horário oficial e eventos gerados pelo backend.
 * - O que só o navegador afirma (OTP validado, geolocalização, fuso, eventos
 *   do fluxo) aparece rotulado como declarado pelo dispositivo.
 * - Selfie é apenas imagem registrada: nunca reconhecimento facial,
 *   comparação biométrica ou prova de vida.
 * - Nada é inventado: seção ou linha sem dado não é impressa.
 *
 * Paginação: rodapé desenhado no fim (bufferPages) com margem inferior
 * zerada, para nunca abrir página nova; blocos (assinatura, QR, linhas)
 * medidos antes de desenhar e movidos inteiros quando não cabem.
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const BRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const COR = {
  navy: '#04273B', ouro: '#C9A227', texto: '#101828', suave: '#344054',
  cinza: '#667085', claro: '#98A2B3', linha: '#D0D5DD', fundo: '#F4F6F9'
};
const FUSO = 'America/Sao_Paulo';
const M = 50;         // margem lateral
const TOPO = 62;      // início do conteúdo (abaixo da faixa)
const BASE = 58;      // margem inferior reservada ao rodapé

const ROTULO_ARQUIVO = {
  assinatura: 'Assinatura manuscrita',
  selfie: 'Selfie do signatário',
  up_rg: 'Documento — RG',
  up_cnh: 'Documento — CNH',
  up_cpf: 'Documento — CPF',
  up_resid: 'Comprovante de residência',
  up_matricula: 'Matrícula do imóvel',
  up_iptu: 'Carnê de IPTU',
  up_escritura: 'Escritura',
  up_procuracao: 'Procuração',
  sig_conjuge: 'Assinatura — cônjuge/companheiro(a)',
  sig_coprop: 'Assinatura — coproprietário(a)',
  sig_testemunhas: 'Assinatura — testemunha'
};
const PAPEL_ASSINANTE = {
  sig_conjuge: 'Cônjuge/companheiro(a)',
  sig_coprop: 'Coproprietário(a)',
  sig_testemunhas: 'Testemunha'
};
const ROTULO_EVENTO = {
  link_aberto: 'Abertura do link de autorização',
  sessao_iniciada: 'Sessão iniciada',
  etapa_iniciada: 'Etapa iniciada',
  etapa_concluida: 'Etapa concluída',
  etapa_abandonada: 'Preenchimento abandonado',
  erro_interrupcao: 'Erro ou interrupção',
  geo_autorizada: 'Geolocalização autorizada',
  geo_recusada: 'Geolocalização recusada',
  aceite_registrado: 'Aceite expresso registrado',
  aceite_desmarcado: 'Aceite expresso desmarcado',
  otp_enviado: 'Envio de código de verificação',
  otp_validado: 'Código de verificação informado como validado',
  otp_invalido: 'Código de verificação incorreto',
  documento_enviado: 'Envio de documento',
  selfie_capturada: 'Selfie capturada',
  biometria_executada: 'Etapa de reconhecimento facial',
  liveness_executado: 'Etapa de prova de vida',
  assinatura_realizada: 'Assinatura eletrônica registrada',
  assinatura_adicional_realizada: 'Assinatura adicional registrada',
  evidencia_ingerida: 'Evidências recebidas e armazenadas',
  pdf_baixado: 'Download do PDF',
  pdf_reenviado: 'Reenvio do PDF'
};
// Resultado desses eventos é afirmado só pelo navegador: o detalhe declarado
// não é reproduzido, para não sugerir verificação que não ocorreu.
const RESULTADO_NAO_VERIFICADO = new Set(['biometria_executada', 'liveness_executado', 'otp_validado']);

function dataHoraBR(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (isNaN(d.getTime())) return null;
  const data = d.toLocaleDateString('pt-BR', { timeZone: FUSO });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: FUSO });
  return { data, hora, completo: `${data} às ${hora}`, curto: `${data} ${hora}` };
}

function texto(v, max = 300) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function tamanhoLegivel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

const FORMATO_MIME = { 'image/png': 'Imagem PNG', 'image/jpeg': 'Imagem JPEG', 'application/pdf': 'Arquivo PDF' };

// "assinatura/principal.png" → { campo: 'assinatura' };
// "assinantes_adicionais/sig_conjuge_0.png" → { campo: 'sig_conjuge', indice: 0 }
function campoDoArquivo(caminhoRelativo) {
  if (typeof caminhoRelativo !== 'string' || !caminhoRelativo) return null;
  const nome = caminhoRelativo.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  if (caminhoRelativo.startsWith('assinatura/')) return { campo: 'assinatura', indice: null };
  if (caminhoRelativo.startsWith('biometria/')) return { campo: 'selfie', indice: null };
  const adicional = /^(sig_[a-z]+)_(\d+)$/.exec(nome);
  if (adicional) return { campo: adicional[1], indice: Number(adicional[2]) };
  return { campo: nome, indice: null };
}

// Leitura simples do User-Agent recebido pelo servidor (o texto integral
// também é impresso, para conferência).
function descreverUserAgent(ua) {
  if (!ua) return null;
  const so = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : null;
  const nav = /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : null;
  const tipo = /iPad|Tablet/.test(ua) ? 'Tablet'
    : /Mobi|iPhone|Android/.test(ua) ? 'Dispositivo móvel' : 'Computador';
  return { resumo: [nav, so].filter(Boolean).join(' · ') || 'Não identificado', tipo };
}

function gerarAutorizacaoPDF(aut, imob, evidencias = {}) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: 'A4', bufferPages: true,
        margins: { top: TOPO, bottom: BASE, left: M, right: M },
        info: { Title: `Autorização de Venda — ${aut.codigo}`, Author: 'AGEMOB', Creator: 'AGEMOB', Producer: 'AGEMOB' }
      });
    } catch (e) { return reject(e); }

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      desenharDocumento(doc, aut, imob || {}, evidencias || {});
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function desenharDocumento(doc, aut, imob, ev) {
  const W = doc.page.width;
  const H = doc.page.height;
  const CW = W - 2 * M;
  const LIMITE = H - BASE;

  const tipoTxt = aut.tipo === 'exclusiva' ? 'COM EXCLUSIVIDADE' : 'SEM EXCLUSIVIDADE';
  const agora = new Date();
  const emissao = dataHoraBR(agora);
  const assinatura = dataHoraBR(ev.servidor?.assinadoEm || aut.assinadoEm);
  const venc = new Date(Date.now() + 365 * 864e5);
  const urlValidacao = aut.urlValidacao || null;

  // ── Faixa superior: desenhada em toda página nova da seção corrente ──
  let faixa = { titulo: '', invertida: false };
  function desenharFaixa() {
    const fundo = faixa.invertida ? COR.ouro : COR.navy;
    const filete = faixa.invertida ? COR.navy : COR.ouro;
    doc.save();
    doc.rect(0, 0, W, 38).fill(fundo);
    doc.rect(0, 38, W, 2.2).fill(filete);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11.5)
      .text(faixa.titulo, M, 14, { width: CW, lineBreak: false, ellipsis: true });
    doc.restore();
    doc.x = M; doc.y = TOPO;
  }
  doc.on('pageAdded', desenharFaixa);
  let aoQuebrarPagina = null; // ex.: redesenhar cabeçalho da tabela da trilha

  function garantir(altura) {
    if (doc.y + altura > LIMITE) {
      doc.addPage();
      if (aoQuebrarPagina) aoQuebrarPagina();
      return true;
    }
    return false;
  }

  // Nova seção: continua na mesma página (com barra de título) quando cabe
  // inteira no espaço restante ou quando a página atual ainda está pouco
  // ocupada; senão começa em página nova. Evita páginas quase vazias.
  function novaSecao(titulo, invertida, alturaSecao = Infinity) {
    aoQuebrarPagina = null;
    faixa = { titulo, invertida };
    const usado = (doc.y - TOPO) / (LIMITE - TOPO);
    const cabeInteira = doc.y + 40 + alturaSecao <= LIMITE;
    if (!cabeInteira && usado > 0.45) {
      doc.addPage();
    } else {
      doc.y += 10;
      const y = doc.y;
      doc.rect(M, y, CW, 20).fill(invertida ? COR.ouro : COR.navy);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10)
        .text(titulo, M + 8, y + 6, { width: CW - 16, lineBreak: false, ellipsis: true });
      doc.x = M; doc.y = y + 30;
    }
  }

  function titulo(t) {
    garantir(16 + 26); // título nunca fica sozinho no fim da página
    doc.moveDown(0.25);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COR.navy).text(t, M, y, { width: CW });
    doc.moveTo(M, doc.y + 1).lineTo(M + CW, doc.y + 1).lineWidth(0.5).strokeColor(COR.linha).stroke();
    doc.x = M; doc.y += 5;
  }

  function linha(rotulo, valor, opts = {}) {
    const v = (valor === undefined || valor === null || valor === '') ? '—' : String(valor);
    const lw = opts.lw ?? 150;
    const vw = CW - lw;
    const fonteV = opts.mono ? 'Courier' : 'Helvetica';
    const tamV = opts.mono ? 7.8 : (opts.tam || 9);
    doc.font('Helvetica-Bold').fontSize(9);
    const hl = rotulo ? doc.heightOfString(rotulo, { width: lw - 8 }) : 0;
    doc.font(fonteV).fontSize(tamV);
    const hv = doc.heightOfString(v, { width: vw });
    const h = Math.max(hl, hv);
    garantir(h + 3);
    const y = doc.y;
    if (rotulo) doc.font('Helvetica-Bold').fontSize(9).fillColor(COR.texto).text(rotulo, M, y, { width: lw - 8 });
    doc.font(fonteV).fontSize(tamV).fillColor(opts.cor || COR.suave).text(v, M + lw, y, { width: vw });
    doc.x = M; doc.y = y + h + 3.5;
  }

  function paragrafo(t, tam = 8.8, cor = COR.suave) {
    doc.font('Helvetica').fontSize(tam);
    garantir(Math.min(doc.heightOfString(t, { width: CW, lineGap: 1.6 }), 3 * (tam + 2)));
    doc.fillColor(cor).text(t, M, doc.y, { width: CW, align: 'justify', lineGap: 1.6 });
    doc.x = M; doc.moveDown(0.45);
  }

  function nota(t) {
    doc.font('Helvetica-Oblique').fontSize(7.8);
    garantir(doc.heightOfString(t, { width: CW }) + 4);
    doc.fillColor(COR.cinza).text(t, M, doc.y, { width: CW });
    doc.x = M; doc.moveDown(0.35);
  }

  // QR Code vetorial (módulos como retângulos), com zona de silêncio.
  function desenharQR(url, x, y, lado) {
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const total = n + 8;
    const p = lado / total;
    doc.save();
    doc.rect(x, y, lado, lado).fill('#FFFFFF');
    doc.fillColor('#000000');
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.modules.get(r, c)) { c++; continue; }
        const ini = c;
        while (c < n && qr.modules.get(r, c)) c++;
        doc.rect(x + (ini + 4) * p, y + (r + 4) * p, (c - ini) * p, p);
      }
    }
    doc.fill('#000000');
    doc.restore();
  }

  function imagem(img, x, y, opts) {
    if (!img || !Buffer.isBuffer(img.buffer)) return false;
    if (img.mimeType !== 'image/png' && img.mimeType !== 'image/jpeg') return false;
    try { doc.image(img.buffer, x, y, opts); return true; } catch { return false; }
  }

  const imagens = ev.imagens || {};
  const arquivos = Array.isArray(ev.arquivos) ? ev.arquivos : [];

  // ═════════════ 1. AUTORIZAÇÃO DE VENDA ═════════════
  faixa = { titulo: 'AGEMOB  ·  AUTORIZAÇÃO DE VENDA ' + tipoTxt, invertida: false };
  desenharFaixa();

  let comLogo = false;
  if (imob.logo) {
    try { doc.image(imob.logo, W - M - 110, 48, { fit: [110, 36], align: 'right', valign: 'center' }); comLogo = true; } catch { comLogo = false; }
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COR.texto)
    .text('AUTORIZAÇÃO DE VENDA DE IMÓVEL ' + tipoTxt, M, TOPO - 4, { width: comLogo ? CW - 120 : CW });
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(8.6).fillColor(COR.cinza)
    .text(`Código: ${aut.codigo}  ·  Emitida em ${emissao.completo} (horário de Brasília)`, M, doc.y, { width: comLogo ? CW - 120 : CW });
  doc.y = Math.max(doc.y, comLogo ? 86 : 0) + 5;
  doc.moveTo(M, doc.y).lineTo(M + CW, doc.y).lineWidth(0.8).strokeColor(COR.ouro).stroke();
  doc.y += 6;

  if (imob.tipo === 'corretor') {
    titulo('1. CORRETOR AUTÔNOMO AUTORIZADO');
    linha('Nome:', imob.razao);
    if (imob.creci) linha('CRECI:', imob.creci);
    if (imob.endereco) linha('Endereço:', imob.endereco);
  } else {
    titulo('1. IMOBILIÁRIA AUTORIZADA');
    linha('Razão social:', imob.razao);
    linha('CNPJ:', imob.cnpj);
    if (imob.creci) linha('CRECI:', imob.creci);
    linha('Endereço:', imob.endereco);
  }

  const prop = aut.proprietario || {};
  titulo('2. PROPRIETÁRIO');
  linha('Nome:', prop.nome);
  linha('CPF:', prop.cpf);
  if (prop.rg) linha('RG:', prop.rg);
  if (prop.estadoCivil) linha('Estado civil:', prop.estadoCivil);
  if (prop.profissao) linha('Profissão:', prop.profissao);
  linha('Contato:', [prop.whatsapp, prop.email].filter(Boolean).join('  ·  '));
  if (prop.endereco) linha('Endereço:', prop.endereco);

  const imv = aut.imovel || {};
  titulo('3. IMÓVEL');
  linha('Tipo:', imv.tipo);
  linha('Endereço:', imv.endereco);
  if (imv.matricula) linha('Matrícula:', `${imv.matricula}${imv.cartorio ? ' · ' + imv.cartorio : ''}`);
  if (imv.areaPrivativa || imv.areaTotal)
    linha('Áreas:', `Privativa ${imv.areaPrivativa || '—'} m²  ·  Total ${imv.areaTotal || '—'} m²`);
  if (imv.dormitorios != null)
    linha('Composição:', `${imv.dormitorios || 0} dorm · ${imv.suites || 0} suítes · ${imv.banheiros || 0} banheiros · ${imv.vagas || 0} vagas`);
  linha('Valor de venda:', BRL(imv.valor));
  linha('Comissão de corretagem (6%):', BRL(imv.valor * 0.06));
  if (imv.descricao) linha('Descrição:', imv.descricao);

  titulo('4. CONDIÇÕES');
  paragrafo(`PRAZO E RENOVAÇÃO — A presente autorização terá validade inicial de 365 (trezentos e sessenta e cinco) dias, contados da data de assinatura, com vencimento previsto para ${venc.toLocaleDateString('pt-BR', { timeZone: FUSO })}. Ao término do prazo, será renovada automaticamente por períodos iguais e sucessivos, até manifestação contrária de qualquer das partes, comunicada formalmente com antecedência mínima de 30 (trinta) dias do vencimento.`);
  // Só a identificação da parte autorizada acompanha o tipo do tenant; o texto das cláusulas é o mesmo.
  const corretor = imob.tipo === 'corretor';
  paragrafo(`COMISSÃO DE CORRETAGEM — Será devida comissão de 6% (seis por cento) sobre o valor total da venda efetivamente realizada. A comissão permanecerá integralmente devida caso o imóvel seja vendido, durante a vigência desta autorização, a cliente apresentado ${corretor ? 'pelo corretor autônomo' : 'pela imobiliária'}, originado de suas campanhas de marketing, cadastrado em seus sistemas ou apresentado por seus parceiros.`);
  if (aut.tipo === 'exclusiva') {
    paragrafo(`EXCLUSIVIDADE — Toda negociação do imóvel deverá ser conduzida exclusivamente ${corretor ? 'pelo corretor autônomo autorizado' : 'pela imobiliária autorizada'}. Caso o proprietário realize a venda diretamente ou por intermédio de terceiros durante o prazo de exclusividade, a comissão contratada permanecerá devida.`);
  } else {
    paragrafo(corretor
      ? 'MODALIDADE SEM EXCLUSIVIDADE — O proprietário poderá anunciar ou negociar o imóvel por meio de imobiliárias ou outros corretores, sendo a comissão devida apenas ao profissional ou empresa que efetivamente intermediar a venda.'
      : 'MODALIDADE SEM EXCLUSIVIDADE — O proprietário poderá anunciar ou negociar o imóvel por meio de outras imobiliárias, sendo a comissão devida apenas à imobiliária que efetivamente intermediar a venda.');
  }

  titulo('5. ASSINATURA ELETRÔNICA');
  // O PDF oficial só é emitido após a assinatura registrada pelo servidor:
  // o tempo verbal acompanha o estado comprovado (assinadoEm do servidor).
  paragrafo(`Este documento ${assinatura ? 'foi assinado' : 'será assinado'} eletronicamente, atendendo aos requisitos de integridade, autenticidade e não repúdio previstos na legislação brasileira (MP 2.200-2/2001 e Lei 14.063/2020). A assinatura e o log de evidências integram este instrumento.`);

  // ── 6. Assinatura e validação: bloco único, nunca partido ──
  const imgAssinatura = imagens.assinatura;
  const temImgAssinatura = !!(imgAssinatura && Buffer.isBuffer(imgAssinatura.buffer));
  const LADO_QR = 88;
  const adicionais = Array.isArray(imagens.assinantes) ? imagens.assinantes : [];
  // Assinaturas adicionais entram na altura do bloco: todas as assinaturas
  // ficam juntas na mesma página.
  const alturaBloco = 30 + Math.max((temImgAssinatura ? 64 : 34) + 40, urlValidacao ? LADO_QR + 22 : 0) + adicionais.length * 78;
  garantir(Math.min(alturaBloco + 16, LIMITE - TOPO));
  titulo('6. ASSINATURA E VALIDAÇÃO');
  const yBloco = doc.y;
  const larguraEsq = urlValidacao ? CW - LADO_QR - 18 : CW;
  const linhaStatus = assinatura
    ? `Assinada eletronicamente em ${assinatura.completo} (horário de Brasília, registro do servidor) e registrada na plataforma AGEMOB.`
    : 'Assinada eletronicamente e registrada na plataforma AGEMOB.';
  doc.font('Helvetica').fontSize(8.6).fillColor(COR.suave).text(linhaStatus, M, yBloco, { width: larguraEsq });
  let y = doc.y + 4;
  if (temImgAssinatura && imagem(imgAssinatura, M + 4, y, { fit: [210, 58], valign: 'bottom' })) y += 60;
  else y += 30;
  doc.moveTo(M, y).lineTo(M + 250, y).lineWidth(0.7).strokeColor(COR.cinza).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COR.texto)
    .text(`${texto(prop.nome)}  ·  CPF ${texto(prop.cpf)}`, M, y + 4, { width: larguraEsq });
  doc.font('Helvetica').fontSize(7.8).fillColor(COR.cinza)
    .text('Proprietário(a) outorgante', M, doc.y + 1, { width: larguraEsq });
  let yFimEsq = doc.y;
  if (urlValidacao) {
    const xQR = M + CW - LADO_QR;
    desenharQR(urlValidacao, xQR, yBloco, LADO_QR);
    doc.font('Helvetica').fontSize(6.8).fillColor(COR.cinza)
      .text('Valide pelo QR Code ou em:', xQR - 20, yBloco + LADO_QR + 3, { width: LADO_QR + 20, align: 'center' })
      .text(urlValidacao, xQR - 20, doc.y, { width: LADO_QR + 20, align: 'center' });
    yFimEsq = Math.max(yFimEsq, doc.y);
  }
  doc.x = M; doc.y = yFimEsq + 6;

  // Assinantes adicionais (imagens recebidas pelo servidor), cada bloco inteiro.
  adicionais.forEach((a) => {
    garantir(86);
    const y0 = doc.y + 4;
    const ok = imagem(a, M + 4, y0, { fit: [180, 48], valign: 'bottom' });
    const yl = y0 + (ok ? 50 : 26);
    doc.moveTo(M, yl).lineTo(M + 250, yl).lineWidth(0.7).strokeColor(COR.cinza).stroke();
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(COR.texto)
      .text(`${PAPEL_ASSINANTE[a.campo] || 'Assinante adicional'} — assinatura ${Number(a.indice) + 1}`, M, yl + 4, { width: CW });
    doc.x = M; doc.y += 6;
  });

  // ═════════════ 2. CERTIFICADO DE ASSINATURA ═════════════
  novaSecao('AGEMOB  ·  CERTIFICADO DE ASSINATURA ELETRÔNICA', true);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COR.texto)
    .text('CERTIFICADO DE ASSINATURA E CONJUNTO PROBATÓRIO', M, doc.y, { width: CW });
  doc.moveDown(0.3);
  paragrafo(`Este certificado integra de forma inseparável o documento "Autorização de Venda ${tipoTxt}", código ${aut.codigo}, e reúne as evidências registradas no momento da assinatura, separando o que foi verificado pelo servidor do que foi apenas informado pelo dispositivo do signatário.`);

  titulo('SIGNATÁRIO PRINCIPAL');
  linha('Nome completo:', prop.nome);
  linha('CPF:', prop.cpf);
  if (prop.whatsapp) linha('Telefone:', prop.whatsapp);
  if (prop.email) linha('E-mail:', prop.email);

  titulo('IMÓVEL OBJETO');
  linha('Imóvel:', [imv.tipo, imv.endereco].filter(Boolean).join(' · '));
  linha('Valor:', BRL(imv.valor));

  titulo('REGISTRO DO SERVIDOR NO MOMENTO DA ASSINATURA');
  if (assinatura) linha('Data e hora da assinatura:', `${assinatura.completo} (horário de Brasília)`);
  if (ev.servidor?.ip) linha('Endereço IP da conexão:', ev.servidor.ip);
  const ua = descreverUserAgent(ev.servidor?.userAgent);
  if (ua) {
    linha('Navegador e sistema:', ua.resumo);
    linha('Tipo de dispositivo:', ua.tipo);
    linha('User-Agent recebido:', texto(ev.servidor.userAgent, 400), { tam: 7.6 });
  }

  titulo('EVIDÊNCIAS RECEBIDAS E VERIFICADAS PELO SERVIDOR');
  nota('Arquivos recebidos, validados (formato e conteúdo) e armazenados pelo servidor. O hash SHA-256 de cada arquivo foi calculado pelo próprio servidor.');
  const ordem = (c) => c === 'assinatura' ? 0 : c === 'selfie' ? 1 : c.startsWith('sig_') ? 3 : 2;
  const listaArquivos = arquivos
    .map(a => ({ ...a, ...campoDoArquivo(a.caminhoRelativo) }))
    .filter(a => a.campo && /^[0-9a-f]{64}$/i.test(String(a.sha256 || '')))
    .sort((a, b) => ordem(a.campo) - ordem(b.campo));
  const temDocumentos = listaArquivos.some(a => ordem(a.campo) === 2);
  listaArquivos.forEach((a) => {
    const rot = ROTULO_ARQUIVO[a.campo] || 'Arquivo anexado';
    const sufixo = a.campo.startsWith('sig_') ? ` (${Number(a.indice) + 1})` : '';
    const desc = [FORMATO_MIME[a.mimeType] || a.mimeType, tamanhoLegivel(a.tamanhoBytes)].filter(Boolean).join(' · ');
    garantir(30);
    linha(rot + sufixo + ':', desc);
    linha('', 'SHA-256 ' + a.sha256, { mono: true });
    if (a.campo === 'selfie') {
      linha('', 'Imagem registrada como evidência. Não constitui reconhecimento facial, comparação biométrica nem prova de vida.', { tam: 7.8, cor: COR.cinza });
    }
  });
  if (!listaArquivos.length) linha('Arquivos:', 'nenhum arquivo registrado');
  if (!temDocumentos) linha('Documentos anexos:', 'nenhum documento anexado');

  // Declarações do dispositivo: só o que veio no registro, rotulado como tal.
  const otps = (Array.isArray(ev.declarados?.otp) ? ev.declarados.otp : [])
    .filter(o => o && (o.canal || o.destino));
  const disp = ev.declarados?.dispositivo && typeof ev.declarados.dispositivo === 'object' ? ev.declarados.dispositivo : {};
  const declarados = [];
  otps.forEach(o => declarados.push(['Confirmação por código:',
    `informada como validada pelo dispositivo via ${texto(o.canal, 40) || 'canal não informado'}${o.destino ? ' (' + texto(o.destino, 80) + ')' : ''}${o.validadoEm ? ' em ' + texto(o.validadoEm, 40) : ''}`]));
  if (disp.geolocalizacao) declarados.push(['Geolocalização:', texto(disp.geolocalizacao, 120)]);
  if (disp.fusoHorario) declarados.push(['Fuso horário:', texto(disp.fusoHorario, 80)]);
  if (disp.resolucao) declarados.push(['Resolução de tela:', texto(disp.resolucao, 80)]);
  if (disp.sessao) declarados.push(['Sessão:', texto(disp.sessao, 80)]);
  if (declarados.length) {
    titulo('INFORMAÇÕES DECLARADAS PELO DISPOSITIVO');
    nota('Informadas pelo navegador do signatário e preservadas no registro da assinatura. Não foram verificadas pelo servidor.');
    declarados.forEach(([k, v]) => linha(k, v));
  }

  titulo('INTEGRIDADE E VALIDAÇÃO');
  linha('Código da autorização:', aut.codigo);
  linha('Status da autorização:', 'Assinada eletronicamente e registrada na plataforma AGEMOB.');
  linha('Documento emitido em:', `${emissao.completo} (horário de Brasília)`);
  if (aut.hash) {
    linha('Algoritmo criptográfico:', 'SHA-256');
    linha('Hash oficial da autorização:', aut.hash, { mono: true });
  }
  if (ev.hashEvidencias) linha('Hash do registro de evidências:', ev.hashEvidencias, { mono: true });
  if (urlValidacao) linha('Verificação pública:', urlValidacao);
  linha('Plataforma emissora:', 'AGEMOB — Sistema de Autorizações Digitais para Imobiliárias e Corretores.');
  paragrafo('Este documento foi registrado eletronicamente pela plataforma AGEMOB. Sua autenticidade pode ser verificada a qualquer momento utilizando o código da autorização e o hash criptográfico acima. Qualquer alteração posterior no conteúdo poderá invalidar sua integridade criptográfica, tornando o hash incompatível com o registro original armazenado pela plataforma.');
  nota('Após a emissão, o hash SHA-256 deste PDF é registrado no Dossiê Digital da autorização, assinado digitalmente pela plataforma e acompanhado de carimbo do tempo quando disponível. Essa conferência é feita na verificação pública.');

  // Selfie + QR lado a lado, bloco inteiro.
  const imgSelfie = imagens.selfie;
  const temSelfie = !!(imgSelfie && Buffer.isBuffer(imgSelfie.buffer) && /^image\/(png|jpeg)$/.test(imgSelfie.mimeType || ''));
  if (temSelfie || urlValidacao) {
    garantir(LADO_QR + 30);
    const y0 = doc.y + 4;
    let yFim = y0;
    if (temSelfie && imagem(imgSelfie, M, y0, { fit: [96, LADO_QR], align: 'left', valign: 'top' })) {
      doc.font('Helvetica').fontSize(7).fillColor(COR.cinza)
        .text('Selfie capturada (imagem registrada)', M, y0 + LADO_QR + 3, { width: 150 });
      yFim = Math.max(yFim, doc.y);
    }
    if (urlValidacao) {
      const xQR = M + CW - LADO_QR;
      desenharQR(urlValidacao, xQR, y0, LADO_QR);
      doc.font('Helvetica').fontSize(6.8).fillColor(COR.cinza)
        .text('Validação pública', xQR - 20, y0 + LADO_QR + 3, { width: LADO_QR + 20, align: 'center' });
      yFim = Math.max(yFim, doc.y);
    }
    doc.x = M; doc.y = yFim + 6;
  }

  // ═════════════ 3. TRILHA DE AUDITORIA ═════════════
  const eventos = montarTrilha(ev);
  const col = [
    { t: 'Data e hora', w: 86 },
    { t: 'Origem', w: 58 },
    { t: 'Evento', w: 150 },
    { t: 'Detalhe', w: CW - 86 - 58 - 150 }
  ];
  const fontes = ['Helvetica', 'Helvetica', 'Helvetica-Bold', 'Helvetica'];
  const linhasTrilha = eventos.map((e) => {
    const celulas = [e.quando ? e.quando.curto : '—', e.origem, e.evento, e.detalhe || ''];
    let h = 0;
    celulas.forEach((v, i) => {
      doc.font(fontes[i]).fontSize(7.8);
      h = Math.max(h, doc.heightOfString(v || ' ', { width: col[i].w - 8 }));
    });
    return { celulas, h };
  });
  const alturaTrilha = (linhasTrilha.length ? 100 : 80) + linhasTrilha.reduce((s, l) => s + l.h + 5.5, 0);
  novaSecao(`AGEMOB  ·  TRILHA DE AUDITORIA  ·  ${aut.codigo}`, false, alturaTrilha);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COR.texto)
    .text('REGISTRO CRONOLÓGICO DE EVENTOS', M, doc.y, { width: CW });
  doc.moveDown(0.3);
  const recebidos = dataHoraBR(ev.servidor?.assinadoEm || aut.assinadoEm);
  nota('Horários em horário de Brasília. Origem "Servidor": registrado pelo servidor AGEMOB. Origem "Dispositivo": evento informado pelo navegador do signatário, com o horário do próprio dispositivo'
    + (recebidos ? `, recebido pelo servidor junto com a assinatura em ${recebidos.completo}.` : '.'));

  function cabecalhoTabela() {
    const y0 = doc.y;
    doc.rect(M, y0, CW, 15).fill(COR.fundo);
    let x = M;
    doc.font('Helvetica-Bold').fontSize(7.8).fillColor(COR.navy);
    col.forEach(c => { doc.text(c.t, x + 4, y0 + 4, { width: c.w - 8, lineBreak: false }); x += c.w; });
    doc.x = M; doc.y = y0 + 18;
  }
  if (!eventos.length) {
    linha('Eventos:', 'nenhum evento registrado');
  } else {
    garantir(15 + 18 + 14);
    cabecalhoTabela();
    aoQuebrarPagina = cabecalhoTabela;
    linhasTrilha.forEach(({ celulas, h }) => {
      garantir(h + 6);
      const y0 = doc.y;
      let x = M;
      celulas.forEach((v, i) => {
        doc.font(fontes[i]).fontSize(7.8).fillColor(i === 2 ? COR.texto : COR.suave)
          .text(v || '', x + 4, y0, { width: col[i].w - 8 });
        x += col[i].w;
      });
      const yl = y0 + h + 2.5;
      doc.moveTo(M, yl).lineTo(M + CW, yl).lineWidth(0.3).strokeColor(COR.linha).stroke();
      doc.x = M; doc.y = yl + 3;
    });
    aoQuebrarPagina = null;
  }
  doc.moveDown(0.6);
  nota(`Trilha gerada pela plataforma AGEMOB para a autorização ${aut.codigo}. A trilha completa e a cadeia de custódia permanecem preservadas no Dossiê Digital.`);

  // ── Rodapé em todas as páginas (margem inferior zerada: não cria página) ──
  doc.removeListener('pageAdded', desenharFaixa);
  const faixaPaginas = doc.bufferedPageRange();
  const totalPaginas = faixaPaginas.count;
  for (let i = 0; i < totalPaginas; i++) {
    doc.switchToPage(faixaPaginas.start + i);
    const margemOriginal = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(M, H - 40).lineTo(M + CW, H - 40).lineWidth(0.6).strokeColor(COR.ouro).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(COR.claro)
      .text(`Documento gerado eletronicamente pela plataforma AGEMOB · Autorizações Imobiliárias Inteligentes · Código ${aut.codigo}`,
        M, H - 34, { width: CW - 70, lineBreak: false, ellipsis: true })
      .text(`Página ${i + 1} de ${totalPaginas}`, M + CW - 70, H - 34, { width: 70, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margemOriginal;
  }
}

// Monta a trilha a partir de fatos registrados: criação da autorização
// (servidor), eventos declarados pelo dispositivo e eventos do backend.
function montarTrilha(ev) {
  const lista = [];
  let seq = 0;
  const add = (quandoBruto, origem, evento, detalhe) => {
    const quando = dataHoraBR(quandoBruto);
    lista.push({ quando, ts: quando ? new Date(quandoBruto).getTime() : Number.MAX_SAFE_INTEGER, seq: seq++, origem, evento, detalhe });
  };
  if (ev.criadoEm) add(ev.criadoEm, 'Servidor', 'Autorização criada pelo emissor', 'Rascunho e link de assinatura gerados');
  const nArquivos = Array.isArray(ev.arquivos) ? ev.arquivos.length : 0;
  (Array.isArray(ev.eventos) ? ev.eventos : []).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const rotulo = ROTULO_EVENTO[e.tipo] || texto(e.tipo, 60);
    if (e.origem === 'gerado_pelo_backend') {
      let detalhe = e.ip ? `IP ${texto(e.ip, 60)}` : '';
      if (e.tipo === 'evidencia_ingerida') detalhe = `${nArquivos} arquivo(s) com hash SHA-256 calculado pelo servidor` + (e.ip ? ` · IP ${texto(e.ip, 60)}` : '');
      add(e.dataHoraServidor, 'Servidor', rotulo, detalhe);
    } else {
      const detalhe = RESULTADO_NAO_VERIFICADO.has(e.tipo)
        ? 'Resultado informado pelo dispositivo; não verificado pelo servidor'
        : texto(e.detalhe, 160);
      add(e.dataHoraCliente, 'Dispositivo', rotulo, detalhe);
    }
  });
  return lista.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
}

module.exports = { gerarAutorizacaoPDF };
