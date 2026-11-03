'use strict';

// AGEMOB — logo do tenant (M9-04). Uma imagem por tenant, só PNG/JPEG
// (o PDF oficial é gerado pelo pdfkit, que só incorpora esses dois formatos).
//
// Arquivos em <storage>/marcas/<tenantId>/logo-<aleatório>.<png|jpg>, área
// separada de <storage>/tenants (evidências jurídicas). O nome enviado pelo
// usuário nunca é usado; o caminho é sempre montado e conferido aqui.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const TAMANHO_MAXIMO_BYTES = 1024 * 1024;
const TIPOS = {
  'image/png':  { extensao: 'png', magic: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
  'image/jpeg': { extensao: 'jpg', magic: Buffer.from([0xFF, 0xD8, 0xFF]) }
};
const RE_TENANT = /^[A-Za-z0-9]{8,32}$/;
const RE_ARQUIVO = /^logo-[a-f0-9]{32}\.(png|jpg)$/;
const RE_DATA_URL = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

class ErroLogo extends Error {
  constructor(codigo) { super(codigo); this.codigo = codigo; }
}

// Tabela CRC-32 do PNG (polinômio 0xEDB88320).
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// PNG íntegro: chunks com CRC correto, IHDR primeiro, IEND no fim, IDAT
// descompactável; sem entrelaçamento nem 16 bits (fora do que o PDF aceita bem).
function conferirPng(buf) {
  let pos = 8, idat = [], ihdr = null, iend = false;
  while (pos + 12 <= buf.length) {
    const tam = buf.readUInt32BE(pos);
    const tipo = buf.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + tam > buf.length) return false;
    const dados = buf.subarray(pos + 8, pos + 8 + tam);
    if (crc32(buf.subarray(pos + 4, pos + 8 + tam)) !== buf.readUInt32BE(pos + 8 + tam)) return false;
    if (!ihdr && tipo !== 'IHDR') return false;
    if (tipo === 'IHDR') ihdr = dados;
    else if (tipo === 'IDAT') idat.push(dados);
    else if (tipo === 'IEND') { iend = pos + 12 + tam === buf.length; break; }
    pos += 12 + tam;
  }
  if (!ihdr || ihdr.length !== 13 || !iend || !idat.length) return false;
  const largura = ihdr.readUInt32BE(0), altura = ihdr.readUInt32BE(4);
  if (!largura || !altura || ihdr[8] === 16 || ihdr[12] !== 0) return false;
  try { zlib.inflateSync(Buffer.concat(idat)); } catch { return false; }
  return true;
}

// JPEG íntegro o bastante: começa em SOI, termina em EOI.
function conferirJpeg(buf) {
  return buf.length > 4 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
}

// Incorporação real num PDF descartável: o que passar aqui entra no PDF oficial.
function testarNoPdf(buffer) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ErroLogo('conteudo_invalido')), 5000);
    try {
      const doc = new PDFDocument({ size: [100, 100] });
      doc.on('data', () => {});
      doc.on('error', () => { clearTimeout(timer); reject(new ErroLogo('conteudo_invalido')); });
      doc.on('end', () => { clearTimeout(timer); resolve(); });
      doc.image(buffer, 0, 0, { fit: [50, 50] });
      doc.end();
    } catch {
      clearTimeout(timer);
      reject(new ErroLogo('conteudo_invalido'));
    }
  });
}

async function validarLogo(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(TAMANHO_MAXIMO_BYTES * 4 / 3) + 64) {
    throw new ErroLogo(typeof dataUrl === 'string' ? 'arquivo_grande' : 'arquivo_invalido');
  }
  const m = RE_DATA_URL.exec(dataUrl);
  if (!m) throw new ErroLogo('formato_nao_suportado');
  const [, mime, b64] = m;
  if (b64.length % 4 !== 0) throw new ErroLogo('arquivo_invalido');
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.toString('base64') !== b64) throw new ErroLogo('arquivo_invalido');
  if (!buffer.length) throw new ErroLogo('arquivo_invalido');
  if (buffer.length > TAMANHO_MAXIMO_BYTES) throw new ErroLogo('arquivo_grande');
  const { magic } = TIPOS[mime];
  if (!buffer.subarray(0, magic.length).equals(magic)) throw new ErroLogo('conteudo_invalido');
  if (mime === 'image/png' ? !conferirPng(buffer) : !conferirJpeg(buffer)) throw new ErroLogo('conteudo_invalido');
  await testarNoPdf(buffer);
  return { buffer, mime };
}

function caminhoContido(storageBase, tenantId, arquivo) {
  if (typeof tenantId !== 'string' || !RE_TENANT.test(tenantId)) return null;
  if (arquivo !== undefined && (typeof arquivo !== 'string' || !RE_ARQUIVO.test(arquivo))) return null;
  const raiz = path.resolve(storageBase, 'marcas');
  const alvo = path.resolve(raiz, tenantId, arquivo || '');
  return alvo.startsWith(raiz + path.sep) ? alvo : null;
}

// Grava o novo arquivo (temporário → rename) e devolve o nome interno.
async function salvarLogo(storageBase, tenantId, { buffer, mime }) {
  const arquivo = `logo-${crypto.randomBytes(16).toString('hex')}.${TIPOS[mime].extensao}`;
  const destino = caminhoContido(storageBase, tenantId, arquivo);
  if (!destino) throw new ErroLogo('arquivo_invalido');
  await fs.promises.mkdir(path.dirname(destino), { recursive: true });
  const tmp = destino + '.tmp';
  await fs.promises.writeFile(tmp, buffer, { flag: 'wx' });
  await fs.promises.rename(tmp, destino);
  return arquivo;
}

async function removerArquivo(storageBase, tenantId, arquivo) {
  const alvo = caminhoContido(storageBase, tenantId, arquivo);
  if (!alvo) return;
  try { await fs.promises.unlink(alvo); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Logo atual do tenant ou null (qualquer falha = sem logo).
async function lerLogo(storageBase, imob) {
  if (!imob || !imob.logoArquivo || !TIPOS[imob.logoMime]) return null;
  const alvo = caminhoContido(storageBase, String(imob._id), imob.logoArquivo);
  if (!alvo) return null;
  try { return await fs.promises.readFile(alvo); } catch { return null; }
}

function urlLogo(imob) {
  return imob && imob.logoArquivo && TIPOS[imob.logoMime]
    ? `/api/logos/${imob._id}?v=${encodeURIComponent(imob.logoAtualizadoEm || '')}`
    : null;
}

module.exports = {
  TAMANHO_MAXIMO_BYTES, MIMES: Object.keys(TIPOS), ErroLogo,
  validarLogo, salvarLogo, removerArquivo, lerLogo, urlLogo, caminhoContido
};
