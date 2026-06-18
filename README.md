# AGEMOB · Autorizações Imobiliárias Inteligentes

Sistema de captação e assinatura digital de Autorizações de Venda, integrado à **Clicksign (API v3 / Envelopes)**.

## Como rodar

```bash
npm install
npm start
# abra http://localhost:3000
```

Requer **Node.js 18+** (usa `fetch` nativo).

## Configurar a Clicksign

1. Na Clicksign, acesse **Configurações → API** e gere um **Access Token** (comece pelo ambiente Sandbox: https://sandbox.clicksign.com).
2. No AGEMOB, clique na engrenagem ⚙️ (canto superior direito) e informe:
   - **API Key** (Access Token)
   - **Ambiente**: Sandbox ou Produção
   - **Autenticação do signatário**: e-mail (padrão), WhatsApp ou SMS
3. Cadastre o **Webhook** na Clicksign (Configurações → Webhooks):
   - URL: `https://SEU_DOMINIO/api/webhook/clicksign`
   - Eventos: `sign`, `close`, `auto_close`, `refusal`, `cancel`, `deadline`
   - Copie o **HMAC Secret** gerado e cole nas Configurações do AGEMOB.
   - Para testes locais, exponha a porta com `ngrok http 3000` e use a URL gerada.

## Fluxo de assinatura

1. Corretor clica em **NOVA CAPTAÇÃO** e preenche proprietário, imóvel e valor.
2. O sistema gera automaticamente a Autorização de Venda (PDF com todas as cláusulas: 365 dias, renovação automática, aviso de 30 dias, comissão de 6%, exclusividade).
3. Ao clicar em **Enviar para Assinatura**, o servidor:
   - gera o PDF e salva em `storage/originais/`;
   - cria o envelope na Clicksign, anexa o documento (base64), adiciona o signatário, define os requisitos (assinar + autenticação), ativa o envelope e dispara a notificação por e-mail.
4. O proprietário recebe o link e assina.
5. O webhook atualiza o status automaticamente: **Aguardando Assinatura → Visualizado → Documento Assinado** (ou Recusado/Cancelado). O PDF assinado e o certificado são baixados para `storage/assinados/`.

## Status

Rascunho · Aguardando Assinatura · Visualizado · Assinado · Recusado · Cancelado

## Segurança

- API Key e HMAC Secret ficam **somente no servidor** (banco `data/config.db` ou `.env`); o frontend recebe apenas a chave mascarada.
- Webhook validado por **HMAC SHA-256** (header `Content-Hmac`) com comparação em tempo constante.
- Todas as chamadas à API são validadas; falhas de comunicação retornam erro tratado e são gravadas em `data/logs.db` (consulta em `GET /api/logs`).

## Estrutura

```
agemob/
├── server.js              # API REST + webhook + indicadores
├── services/clicksign.js  # Integração Clicksign v3 (envelopes)
├── services/pdf.js        # Geração da Autorização de Venda (pdfkit)
├── public/index.html      # Frontend (painel, captação, configurações)
├── data/                  # Banco NeDB (autorizações, config, logs)
├── storage/originais/     # PDFs gerados
└── storage/assinados/     # PDFs assinados + certificados
```
