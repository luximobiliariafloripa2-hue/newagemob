# Sprint 6.3.1 — Auditoria Técnica da Assinatura

Documento produzido em auditoria de código (sem alteração de `server.js`, `services/pdf.js` ou qualquer outro arquivo do sistema). Base: estado do repositório no commit `0c895f8` (Sprint 6.3 — servidor como autoridade do hash), já publicado em `origin/main`.

---

## 1. Fluxo completo da assinatura

**Ponto de entrada:** `public/index.html` (fluxo do proprietário), etapa final de assinatura.

1. Proprietário preenche dados (dados pessoais, imóvel) e assina (desenho em canvas ou nome digitado convertido em imagem — `AG.sigImg`).
2. O navegador monta `V2E.snapshot()` — objeto de evidências do instante da assinatura: `ip` (obtido via `fetch('https://api.ipify.org?format=json')`), `navegador`, `sistemaOperacional`, `userAgent`, `dispositivo`, `resolucao`, `geolocalizacao`, `sessao`, `dataHora`/`dataHoraLocal`.
3. O navegador calcula um hash local (`V2D.hash`) via SHA-256 (Web Crypto) sobre um payload que inclui `codigo, tipo, proprietario{nome,cpf,email,zap}, imovel{tipo,end,num,bairro,cidade,valor}, assinatura (imagem), aceite, evidencias, uploads, otp, facial, liveness`.
4. O navegador envia `POST /api/autorizacoes/assinar` com: `codigo, proprietario, imovel, tipo, hash (o calculado no passo 3), evidencias, otp, facial, liveness, uploads`. **Não envia** `assinatura` (imagem) nem `aceite` — esses dois campos participam do hash do passo 3, mas nunca chegam ao servidor.
5. **Observação estrutural:** existem hoje **dois pontos no código-fonte do frontend** que disparam `POST /api/autorizacoes/assinar` para o mesmo evento de assinatura (um dentro do handler principal, outro dentro de uma sobrescrita de `v2Concluir` que faz `fetch` adicional). Ambos enviam o mesmo `codigo` e os mesmos dados; o segundo POST, por usar `db.autorizacoes.update({codigo}, ...)` (já existe rascunho após o primeiro), apenas regrava o mesmo conteúdo. Não constatado impacto funcional, mas é uma duplicação de escrita que vale investigar em sprint futura.
6. No servidor, `POST /api/autorizacoes/assinar` (`server.js:1241`):
   - Valida `codigo` e `proprietario.nome`.
   - Busca `rascunho` existente (para preservar `imobiliariaId`/`imobiliariaSlug`/`corretorId`).
   - Monta o objeto `aut` com `status: 'assinado'`, `hash: hash || null` (valor do cliente, **temporário**), `evidencias`, `validacoes` (otp/facial/liveness/uploads), timestamps próprios (`criadoEm`, `assinadoEm`, `atualizadoEm` — todos gerados pelo servidor, não pelo cliente).
   - Calcula `aut.hashDadosAutorizacao = calcularHashDadosAutorizacao(aut)`.
   - **Sobrescreve** `aut.hash = aut.hashDadosAutorizacao` — o valor do cliente recebido no passo 4 é descartado neste ponto e nunca persistido separadamente.
   - Persiste via `db.autorizacoes.update` (se havia rascunho) ou `db.autorizacoes.insert`.
   - Dispara `gerarESalvarPDFAssinatura(aut)` (gera e salva o PDF oficial).
   - Loga aviso se `imobiliariaId` ficou nulo (autorização não aparecerá no painel).
   - Notifica via SSE (`sseNotificar`) se houver `imobiliariaId`.

## 2. Fluxo de geração do PDF

1. `gerarESalvarPDFAssinatura(aut)` (`server.js:1191`, região) busca a imobiliária (`aut.imobiliariaId` ou fallback `slug: 'lux-house'`).
2. Chama `adaptarParaPDF(aut, imob)` (`server.js:1144`), que converte o formato salvo no banco para o formato esperado pelo renderizador, retornando `{ autPdf, imobPdf }`.
   - **Hoje `autPdf` contém apenas:** `codigo, tipo, proprietario{nome,cpf,rg,estadoCivil,profissao,whatsapp,email,endereco}, imovel{tipo,endereco,valor}`.
   - **Não repassa:** `hash`/`hashDadosAutorizacao`, `assinadoEm`, link de validação, nem qualquer campo de `evidencias`/`validacoes`.
3. Chama `gerarAutorizacaoPDF(autPdf, imobPdf)` (`services/pdf.js:9`), que monta o PDF via `pdfkit`: cabeçalho, seção 1 (Imobiliária), 2 (Proprietário), 3 (Imóvel), 4 (Condições — prazo, comissão, exclusividade), 5 (Assinatura Eletrônica — parágrafo fixo, não interpolado). Rodapé imprime `codigo` em fonte pequena.
4. O buffer do PDF é salvo em `storage/assinados/{codigo}.pdf`; `pdfPath` é persistido na autorização via `db.autorizacoes.update`.
5. Falha nesta etapa é tolerada — não desfaz a assinatura já persistida, apenas gera log de `'aviso'`.

**Conclusão relevante:** o PDF oficial hoje **não exibe** hash, data/hora de assinatura, nem link de validação — mesmo esses dados existindo no banco desde a Sprint 6.3. (Correção mapeada e aprovada em conceito na Sprint 6.2.1, ainda não aplicada ao código.)

## 3. Fluxo de geração do hash

Dois hashes coexistem conceitualmente, mas só um é persistido hoje:

- **Hash do cliente** (`V2D.hash`, calculado em `public/index.html`): SHA-256 sobre dados que incluem a imagem da assinatura e o aceite — nenhum dos dois chega ao servidor. **Este valor é recebido pelo servidor no campo `hash` do body, mas é imediatamente sobrescrito e nunca persistido** — hoje não existe forma de auditar posteriormente o que o navegador calculou.
- **Hash oficial do servidor** (`aut.hashDadosAutorizacao`, calculado por `calcularHashDadosAutorizacao(aut)`, `server.js:1217`): SHA-256 sobre um payload determinístico e canônico contendo `codigo, tipo, proprietario{nome,cpf,email,zap}, imovel{tipo,end,num,bairro,cidade,valor}, assinadoEm`. Calculado **uma única vez**, no momento do registro, a partir de dados já persistidos e estáveis — não depende de nada que só exista no navegador.
- `aut.hash` é definido como espelho de `aut.hashDadosAutorizacao` (compatibilidade com código/rotas que ainda leem `aut.hash`).
- **Nenhum outro tipo de hash existe hoje** — não há hash do PDF (`hashPDF`), das evidências (`hashEvidencias`) nem cadeia de eventos (`hashCadeiaEventos`). Arquitetura para esses três já foi discutida e deliberadamente adiada (ver seção 9).

## 4. Fluxo de validação pública

`GET /api/validar/:codigo` (`server.js:1490`), rota pública, sem autenticação:
1. Busca a autorização por `codigo`.
2. Se não encontrada, `404 { valido: false, erro: 'Código não encontrado.' }`.
3. Se encontrada, retorna um subconjunto de dados não sensíveis: `valido, codigo, status, tipo, hash (aut.hash || null — hoje já é o hash oficial, pois aut.hash foi sobrescrito na assinatura), assinadoEm, vencimento, proprietario{nome, cpf mascarado}, imovel{tipo,bairro,cidade}, imobiliaria{nome}`.

`public/validar.html` consome essa rota e já renderiza o hash retornado, com um pequeno texto explicativo sobre detecção de fraude por alteração de hash.

**Observação:** a rota já expõe o hash oficial corretamente (porque `aut.hash` já é o valor do servidor desde a Sprint 6.3) — nenhuma mudança é necessária aqui para a Sprint 6.2.1.

## 5. Matriz de integridade do documento

| Elemento | Gerado onde | Persistido onde | Exposto na validação pública | Exposto no PDF oficial |
|---|---|---|---|---|
| `codigo` | Servidor (`genCode`) ou cliente | `aut.codigo` | ✅ | ✅ (sem destaque visual) |
| `hashDadosAutorizacao` | Servidor (`calcularHashDadosAutorizacao`) | `aut.hashDadosAutorizacao` e espelhado em `aut.hash` | ✅ (via `aut.hash`) | ❌ |
| Hash do cliente (assinatura+aceite+evidências) | Navegador | **Não persistido** (descartado na assinatura) | ❌ | ❌ |
| `assinadoEm` | Servidor (timestamp do momento do registro) | `aut.assinadoEm` | ✅ | ❌ |
| `evidencias` (ip, navegador, SO, device, UA, geo) | Navegador (`V2E.snapshot()`) | `aut.evidencias` (objeto opaco) | ❌ | ❌ |
| `validacoes` (otp, facial, liveness, uploads) | Navegador | `aut.validacoes` | ❌ | ❌ |
| `pdfPath` | Servidor (após gerar PDF) | `aut.pdfPath` | ❌ | — (é o próprio arquivo) |
| Link de verificação pública | Rota já existe (`/validar/:codigo`) | Não persistido como string — recalculável via `getBaseUrl()` | — (é a própria rota) | ❌ |

**Leitura da matriz:** a plataforma já tem os elementos de integridade que importam juridicamente (hash oficial determinístico, timestamp do servidor, rota de verificação pública), mas o **documento físico (PDF) não expõe nenhum deles hoje** — é a lacuna central que a Sprint 6.2.1 fecha.

## 6. Cenários de teste (positivos e negativos)

**Positivos:**
1. Assinar uma autorização nova → `hashDadosAutorizacao` gravado, igual a `hash`, ambos recalculáveis a partir dos dados persistidos.
2. Duas autorizações com proprietário/imóvel idênticos mas `codigo`/`assinadoEm` diferentes → hashes diferentes (sem colisão trivial). *(Testado na Sprint 6.3.)*
3. `GET /api/validar/:codigo` retorna o hash oficial, consistente com o banco. *(Testado na Sprint 6.3.)*
4. PDF gerado e salvo em `storage/assinados/{codigo}.pdf`, `pdfPath` persistido. *(Testado nas Sprints 6.2 e 6.3.)*
5. Assinatura sem `imobiliariaId` (link avulso) → autorização é salva e validável publicamente, mas não aparece no painel da imobiliária (aviso logado). *(Comportamento pré-existente, confirmado em teste real.)*

**Negativos / não testados ainda (lacunas conhecidas):**
6. Recalcular `calcularHashDadosAutorizacao(aut)` sobre um documento após alteração manual de um campo (ex.: valor do imóvel direto no banco) e confirmar que o hash recalculado diverge do armazenado — **não testado formalmente**; é a base de qualquer futura verificação de integridade retroativa.
7. Assinatura com `evidencias` ausente ou parcial (ex.: `ip` nunca resolvido por falha do `fetch` ao ipify) → `aut.evidencias` fica com campos `null`/ausentes — comportamento correto (não quebra), mas não há teste automatizado cobrindo isso.
8. Duas chamadas quase simultâneas de `POST /api/autorizacoes/assinar` para o mesmo `codigo` (o cenário do "duplo POST" descrito na seção 1, item 5) — não há teste de condição de corrida; o segundo `update` deveria ser idempotente (mesmos dados), mas isso não foi verificado sob concorrência real.
9. `codigo` inexistente em `GET /api/validar/:codigo` → retorna 404 corretamente (comportamento simples, coberto pela leitura do código, não testado em runtime nesta auditoria).
10. Geração de PDF quando `gerarESalvarPDFAssinatura` falha (ex.: disco cheio, permissão negada) → autorização permanece assinada no banco, aviso é logado, mas **não há qualquer sinalização visível ao usuário final** de que o PDF não foi gerado. Risco de suporte (proprietário assina, PDF nunca é gerado, ninguém percebe até reclamação).

## 7. Riscos conhecidos

- **Hash do cliente é descartado sem registro.** Se no futuro surgir disputa sobre "o que o navegador realmente calculou no momento", não há como recuperar esse valor — ele nunca foi persistido. (Mitigação proposta e pausada: campo `hashCliente`.)
- **PDF oficial não exibe elementos de integridade.** Hoje o único artefato "físico" entregável ao proprietário/cartório/advogado não prova nada sozinho — é preciso acessar o sistema ou a página de validação para ver o hash. Isso reduz a força probatória do PDF como documento autônomo.
- **Falha silenciosa na geração do PDF.** Erros são apenas logados; não há alerta ativo nem re-tentativa automática.
- **Duplicidade de POST de assinatura** (seção 1, item 5) — não é um bug confirmado, mas é uma superfície de risco não investigada (dois caminhos de código fazendo a mesma escrita).
- **Dependência de serviço externo (`api.ipify.org`) para IP** — se o serviço estiver fora do ar ou bloqueado por rede corporativa, `evidencias.ip` fica `null`, sem fallback ou registro de que a captura falhou (diferente de "IP não disponível por política", fica indistinguível de "nunca tentou").
- **Nenhum mecanismo de re-verificação automática.** O sistema calcula o hash uma vez e nunca o recalcula para comparação — não há rotina (nem manual, nem agendada) que confirme periodicamente que os documentos armazenados não foram alterados por fora da aplicação (ex.: edição direta no arquivo `.db`).

## 8. Recomendações técnicas

1. **Curto prazo (Sprint 6.2.1 — já aprovada em conceito, pendente de aplicação):** expor no PDF oficial os dados que já existem: código em destaque, hash oficial, data/hora da assinatura, link de verificação, declaração de integridade. Zero dependência nova, zero mudança de regra de negócio.
2. **Curto/médio prazo:** reintroduzir `hashCliente` como campo de auditoria (pausado nesta sessão) — baixo custo, fecha a lacuna da seção 7 sobre perda do hash do navegador.
3. **Médio prazo:** investigar e eliminar (ou justificar formalmente) a duplicidade de `POST /api/autorizacoes/assinar` no frontend.
4. **Médio prazo:** adicionar sinalização ativa (não só log) quando `gerarESalvarPDFAssinatura` falhar — ex.: flag `pdfPendente: true` na autorização, visível no painel da imobiliária, para permitir reprocessamento manual.
5. **Médio prazo:** criar uma rotina (endpoint interno ou script) que recalcula `calcularHashDadosAutorizacao` sobre autorizações existentes e compara com o valor armazenado — primeiro passo prático de auditoria de integridade retroativa, sem precisar de nenhuma infraestrutura nova além da função que já existe.
6. **Longo prazo:** avançar para os hashes ainda não implementados (`hashPDF`, `hashEvidencias`, `hashCadeiaEventos`), cada um como sprint própria, conforme arquitetura já acordada (seção 9).

## 9. Roadmap da evolução jurídica do AGEMOB

```
Sprint 6.2   ✅  PDF oficial gerado e persistido pelo backend (storage/assinados/, pdfPath)
Sprint 6.3   ✅  Servidor como autoridade do hash (hashDadosAutorizacao, hash oficial)
Sprint 6.3.1 ✅  Esta auditoria — documentação da arquitetura atual antes de avançar
Sprint 6.2.1 ⏳  PDF exibindo: código em destaque, hash oficial, data/hora, link de
                 verificação, declaração de integridade (diff pronto, aprovado em
                 conceito, aplicação pendente)
Sprint 6.4   🔜  hashCliente como campo de auditoria (preservar o valor do navegador
                 sem torná-lo autoridade)
Sprint 6.5   🔜  Bloco "Registro da Assinatura" no PDF (IP, navegador, SO, dispositivo —
                 apenas os campos que existirem, sem inventar dados)
Sprint 7.x   🔮  Registro Forense completo (hashEvidencias) — formato canônico para
                 o pacote de evidências, com hash próprio
Sprint 8.x   🔮  QR Code de validação (usa a urlValidacao que já existe/existirá)
Sprint 9.x   🔮  Cadeia de Eventos (hashCadeiaEventos) — log de eventos encadeado
                 criptograficamente (criar/visualizar/OTP/facial/assinar/PDF gerado)
Sprint 10.x  🔮  hashPDF — hash do artefato PDF final, com desenho de duas etapas
                 para resolver a circularidade (não se pode hashear um PDF que
                 imprime o próprio hash)
Sprint 11.x  🔮  Certificado de Auditoria consolidado — reúne todos os hashes acima
                 em um documento/relatório único, com validação cruzada
```

---

**Encerramento:** nenhum arquivo de código foi alterado nesta auditoria. Este documento é a base para decidir, com segurança, a ordem de implementação das próximas sprints.
