// Contratos e constantes da camada de recebimento de evidências (Micro-Sprint 2.3.5.0/2.3.5.1).
// Puramente declarativo — nenhuma função aqui toca disco, rede ou banco.

const VERSAO_SCHEMA_EVIDENCIAS = 1;
const ALGORITMO_HASH = 'SHA-256';

// Magic number = primeiros bytes reais do arquivo, conferidos contra o MIME declarado,
// para impedir que um tipo seja disfarçado de outro.
const MIME_WHITELIST = {
  'image/png':       { extensao: 'png', magicNumber: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
  'image/jpeg':      { extensao: 'jpg', magicNumber: Buffer.from([0xFF, 0xD8, 0xFF]) },
  'application/pdf': { extensao: 'pdf', magicNumber: Buffer.from([0x25, 0x50, 0x44, 0x46]) }
};

const LIMITES_EVIDENCIA = {
  assinaturaPrincipalBytes: 2 * 1024 * 1024,
  selfieBytes:              5 * 1024 * 1024,
  documentoBytes:           8 * 1024 * 1024,
  assinaturaAdicionalBytes: 2 * 1024 * 1024,
  maxDocumentos:            10,
  maxAssinantesAdicionais:  6,
  // Declarado como referência nesta etapa; express.json({ limit }) só muda quando
  // a rota realmente passar a receber esses campos (Micro-Sprint 2.3.5.5).
  bodyGlobalBytes:          20 * 1024 * 1024
};

// Nomes-base determinísticos — nunca o nome enviado pelo cliente.
// Sem extensão: a extensão final vem do MIME já validado (MIME_WHITELIST), nunca do
// nome/extensão que o cliente informou.
const CATALOGO_ARQUIVOS_INCOMING = {
  assinatura: {
    categoria: 'assinatura',
    exigeIndice: false,
    resolver: () => 'assinatura/principal'
  },
  selfie: {
    categoria: 'biometria',
    exigeIndice: false,
    resolver: () => 'biometria/selfie'
  },
  up_rg: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_rg'
  },
  up_cnh: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_cnh'
  },
  up_cpf: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_cpf'
  },
  up_resid: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_resid'
  },
  up_matricula: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_matricula'
  },
  up_iptu: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_iptu'
  },
  up_escritura: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_escritura'
  },
  up_procuracao: {
    categoria: 'documentos',
    exigeIndice: false,
    resolver: () => 'documentos/up_procuracao'
  },
  sig_conjuge: {
    categoria: 'assinantes_adicionais',
    exigeIndice: true,
    resolver: (indice) => `assinantes_adicionais/sig_conjuge_${indice}`
  },
  sig_coprop: {
    categoria: 'assinantes_adicionais',
    exigeIndice: true,
    resolver: (indice) => `assinantes_adicionais/sig_coprop_${indice}`
  },
  sig_testemunhas: {
    categoria: 'assinantes_adicionais',
    exigeIndice: true,
    resolver: (indice) => `assinantes_adicionais/sig_testemunhas_${indice}`
  }
};

module.exports = {
  VERSAO_SCHEMA_EVIDENCIAS,
  ALGORITMO_HASH,
  MIME_WHITELIST,
  LIMITES_EVIDENCIA,
  CATALOGO_ARQUIVOS_INCOMING
};
