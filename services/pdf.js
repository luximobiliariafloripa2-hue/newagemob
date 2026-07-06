/**
 * AGEMOB — Geração do PDF da Autorização de Venda (servidor)
 * Mantém o mesmo conteúdo e cláusulas do documento original.
 */
const PDFDocument = require('pdfkit');

const BRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function gerarAutorizacaoPDF(aut, imob) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 52, right: 52 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tipoTxt = aut.tipo === 'exclusiva' ? 'COM EXCLUSIVIDADE' : 'SEM EXCLUSIVIDADE';
    const agora = new Date();
    const venc = new Date(Date.now() + 365 * 864e5);
    const W = doc.page.width;

    // Faixa superior (identidade AGEMOB)
    doc.rect(0, 0, W, 40).fill('#0B7A5C');
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(13)
      .text('AGEMOB  ·  AUTORIZAÇÃO DE VENDA ' + tipoTxt, 52, 14);

    doc.fill('#101828').moveDown(2);
    doc.fontSize(15).text('AUTORIZAÇÃO DE VENDA DE IMÓVEL ' + tipoTxt, 52, 60);
    doc.font('Helvetica').fontSize(9).fillColor('#475467')
      .text(`Código: ${aut.codigo}  ·  Emitida em ${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR')}`)
      .moveDown(0.8);

    const titulo = t => doc.moveDown(0.6).fillColor('#101828').font('Helvetica-Bold').fontSize(11).text(t).moveDown(0.3);
    const linha = (k, v) => {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#101828').text(k + ' ', { continued: true });
      doc.font('Helvetica').fillColor('#344054').text(String(v ?? '—'));
    };
    const paragrafo = t => doc.font('Helvetica').fontSize(9.5).fillColor('#344054').text(t, { align: 'justify', lineGap: 2 }).moveDown(0.4);

    titulo('1. IMOBILIÁRIA AUTORIZADA');
    linha('Razão social:', imob.razao);
    linha('CNPJ:', imob.cnpj);
    linha('Endereço:', imob.endereco);

    titulo('2. PROPRIETÁRIO');
    linha('Nome:', aut.proprietario.nome);
    linha('CPF:', aut.proprietario.cpf);
    if (aut.proprietario.rg) linha('RG:', aut.proprietario.rg);
    if (aut.proprietario.estadoCivil) linha('Estado civil:', aut.proprietario.estadoCivil);
    if (aut.proprietario.profissao) linha('Profissão:', aut.proprietario.profissao);
    linha('Contato:', `${aut.proprietario.whatsapp || ''}  ·  ${aut.proprietario.email || ''}`);
    if (aut.proprietario.endereco) linha('Endereço:', aut.proprietario.endereco);

    titulo('3. IMÓVEL');
    linha('Tipo:', aut.imovel.tipo);
    linha('Endereço:', aut.imovel.endereco);
    if (aut.imovel.matricula) linha('Matrícula:', `${aut.imovel.matricula}${aut.imovel.cartorio ? ' · ' + aut.imovel.cartorio : ''}`);
    if (aut.imovel.areaPrivativa || aut.imovel.areaTotal)
      linha('Áreas:', `Privativa ${aut.imovel.areaPrivativa || '—'} m²  ·  Total ${aut.imovel.areaTotal || '—'} m²`);
    if (aut.imovel.dormitorios != null)
      linha('Composição:', `${aut.imovel.dormitorios || 0} dorm · ${aut.imovel.suites || 0} suítes · ${aut.imovel.banheiros || 0} banheiros · ${aut.imovel.vagas || 0} vagas`);
    linha('Valor de venda:', BRL(aut.imovel.valor));
    linha('Comissão de corretagem (6%):', BRL(aut.imovel.valor * 0.06));
    if (aut.imovel.descricao) linha('Descrição:', aut.imovel.descricao);

    titulo('4. CONDIÇÕES');
    paragrafo(`PRAZO E RENOVAÇÃO — A presente autorização terá validade inicial de 365 (trezentos e sessenta e cinco) dias, contados da data de assinatura, com vencimento previsto para ${venc.toLocaleDateString('pt-BR')}. Ao término do prazo, será renovada automaticamente por períodos iguais e sucessivos, até manifestação contrária de qualquer das partes, comunicada formalmente com antecedência mínima de 30 (trinta) dias do vencimento.`);
    paragrafo('COMISSÃO DE CORRETAGEM — Será devida comissão de 6% (seis por cento) sobre o valor total da venda efetivamente realizada. A comissão permanecerá integralmente devida caso o imóvel seja vendido, durante a vigência desta autorização, a cliente apresentado pela imobiliária, originado de suas campanhas de marketing, cadastrado em seus sistemas ou apresentado por seus parceiros.');
    if (aut.tipo === 'exclusiva') {
      paragrafo('EXCLUSIVIDADE — Toda negociação do imóvel deverá ser conduzida exclusivamente pela imobiliária autorizada. Caso o proprietário realize a venda diretamente ou por intermédio de terceiros durante o prazo de exclusividade, a comissão contratada permanecerá devida.');
    } else {
      paragrafo('MODALIDADE SEM EXCLUSIVIDADE — O proprietário poderá anunciar ou negociar o imóvel por meio de outras imobiliárias, sendo a comissão devida apenas à imobiliária que efetivamente intermediar a venda.');
    }

    titulo('5. ASSINATURA ELETRÔNICA');
    paragrafo('Este documento será assinado eletronicamente, atendendo aos requisitos de integridade, autenticidade e não repúdio previstos na legislação brasileira (MP 2.200-2/2001 e Lei 14.063/2020). A assinatura e o log de evidências integram este instrumento.');

    titulo('6. VALIDAÇÃO E AUTENTICIDADE');
    linha('Status da autorização:', 'Assinada eletronicamente e registrada na plataforma AGEMOB.');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0B7A5C').text(aut.codigo);
    doc.moveDown(0.3);
    if (aut.assinadoEm) {
      const dAssin = new Date(aut.assinadoEm);
      linha('Data e hora da assinatura:', `${dAssin.toLocaleDateString('pt-BR')} às ${dAssin.toLocaleTimeString('pt-BR')}`);
    }
    linha('Documento emitido em:', `${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR')}`);
    if (aut.hash) {
      linha('Algoritmo criptográfico:', 'SHA-256');
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#101828').text('Hash oficial da autorização (SHA-256):');
      doc.font('Courier').fontSize(8).fillColor('#475467').text(aut.hash, { width: W - 104 });
    }
    if (aut.urlValidacao) {
      doc.moveDown(0.2);
      linha('Verificação pública:', aut.urlValidacao);
    }
    linha('Plataforma emissora:', 'AGEMOB — Sistema de Autorizações Digitais para Imobiliárias e Corretores.');
    doc.moveDown(0.4);
    paragrafo('Este documento foi registrado eletronicamente pela plataforma AGEMOB. Sua autenticidade pode ser verificada a qualquer momento utilizando o código da autorização e o hash criptográfico acima. Qualquer alteração posterior no conteúdo poderá invalidar sua integridade criptográfica, tornando o hash incompatível com o registro original armazenado pela plataforma.');

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9).fillColor('#101828');
    doc.text('_______________________________________________');
    doc.text(`${aut.proprietario.nome}  ·  CPF ${aut.proprietario.cpf}`);

    // Rodapé
    doc.fontSize(7.5).fillColor('#98A2B3')
      .text(`Documento gerado eletronicamente pela plataforma AGEMOB · Autorizações Imobiliárias Inteligentes · Código ${aut.codigo}`,
        52, doc.page.height - 42, { width: W - 104, align: 'center' });

    doc.end();
  });
}

module.exports = { gerarAutorizacaoPDF };
