# Validação Pós-Sprint 1 — Agemob Backend

> Validação somente-leitura. Nenhum arquivo de código foi alterado durante esta verificação — apenas o servidor foi iniciado temporariamente (via `node server.js`, depois encerrado) para testar rotas em tempo de execução. Isso gera/atualiza os arquivos `data/*.db` (comportamento normal de runtime, já cobertos pelo `.gitignore`), não código-fonte.

---

## 1. Erros de sintaxe

```
node --check server.js
```
**Resultado: nenhum erro.** O arquivo é sintaticamente válido após as 4 alterações da Sprint 1.

---

## 2. Rotas registradas

Todas as **58 rotas** presentes antes da Sprint 1 continuam registradas, na mesma ordem, com os mesmos métodos e middlewares. Conferido via extração de todas as chamadas `app.get/post/put/patch/delete(...)` e comparação linha a linha com o inventário do `AUDITORIA_BACKEND.md`.

Nenhuma rota foi removida, renomeada ou teve o método HTTP alterado. As duas únicas rotas com mudança de comportamento (esperadas, da própria Sprint 1) foram:
- `GET /api/autorizacoes/codigo/:codigo` — mesmo path/método, corpo da resposta reduzido (ver seção 6)
- `POST /api/enviar-email` — mesmo path/método, ganhou um middleware extra (`emailLimiter`)

**Observação pré-existente (não é regressão da Sprint 1):** `GET /api/admin/metricas` continua definida duas vezes (linha 465 e linha 856). A segunda nunca é executada — Express usa a primeira rota registrada que casa o path. Já documentado no `AUDITORIA_BACKEND.md`, item 12.10.

---

## 3. Referências quebradas

Nenhuma referência quebrada foi introduzida pela Sprint 1.

**Achado pré-existente, não causado pela Sprint 1, mas relevante para esta validação:** `public/checkout.html` e `public/checkout-resultado.html` chamam rotas `/api/pagamentos/config`, `/api/pagamentos/planos`, `/api/pagamentos/criar-pedido` e `/api/pagamentos/pedido/:id`. Nenhuma dessas rotas existe em `server.js` — o módulo `routes/payments.js` nunca foi montado (`app.use(...)` correspondente não existe), como já registrado no `AUDITORIA_BACKEND.md`.

Testado ao vivo nesta validação:
```
GET /api/pagamentos/config → HTTP 200, Content-Type: text/html, 345462 bytes
```
Isso **não** é um 404 — cai no catch-all `app.get('/{*path}', ...)` (linha 1564) e devolve o HTML inteiro do SPA (`public/index.html`). O frontend faz `fetch(...).then(r => r.json())`, então essa chamada quebra com um erro de parse JSON no navegador (`Unexpected token '<'`) em vez de um erro HTTP claro. A tela de checkout está, portanto, inoperante hoje — independente da Sprint 1.

---

## 4. Variáveis e funções não utilizadas

Contagem de referências dos identificadores tocados pela Sprint 1 e dos principais helpers do arquivo (declaração + usos):

| Identificador | Ocorrências | Situação |
|---|---|---|
| `JWT_SECRET` | 6 | OK — declaração + 5 usos consistentes (login, `authMiddleware`, cadastro, `/api/autorizacoes/manual`, modo suporte) |
| `emailLimiter` | 2 | OK — declarado e aplicado na rota |
| `filtroImobiliaria` | 2 | OK — declarado e usado em `GET /api/autorizacoes` (pré-existente à Sprint 1) |
| `authLimiter` / `apiLimiter` | 2 cada | OK |
| `verificarLimite`, `consumirCredito`, `calcularPorcentagem`, `genCode`, `getBaseUrl`, `SubscriptionService`, `BillingService`, `sseNotificar`, `enviarEmailBrevo`, `gerarCodigoBoleto` | ≥2 cada | OK, todos usados |

**Achados pré-existentes (não introduzidos pela Sprint 1):**
- `validarCPF` e `validarCNPJ` (linhas 819–832) — declaradas, **nunca chamadas** em nenhuma rota. `POST /api/admin/imobiliarias` valida apenas presença de CNPJ/CPF, não o dígito verificador.
- `cnpjLimpo` (linha 922, dentro de `POST /api/cadastro`) — declarada, **nunca usada** depois.

Nenhuma variável foi removida incorretamente pela Sprint 1 — as duas edições de `JWT_SECRET` substituíram expressões inline por uma referência à constante já existente, sem remover nenhuma declaração.

---

## 5. Imports inválidos

Todos os `require(...)` de `server.js` foram conferidos:

| Import | Tipo | Status |
|---|---|---|
| `dotenv`, `express`, `express-rate-limit`, `jsonwebtoken`, `bcryptjs`, `nedb-promises` | dependência npm | Presente em `package.json` |
| `path`, `fs` | módulo nativo do Node | OK |
| `./services/pdf` (`gerarAutorizacaoPDF`) | arquivo local | Existe, exporta o símbolo esperado |
| `require('bcryptjs')` (linha 447, redeclaração local dentro de um handler) | pré-existente | Válido em JS (escopo de função), redundante mas não é erro |
| `require('jsonwebtoken')` (linha 1084, dentro de `/api/autorizacoes/manual`) | pré-existente | Válido, redundante com o `jwt` já importado no topo do arquivo |

Nenhum import quebrado. Nenhum import foi adicionado ou removido pela Sprint 1.

---

## 6. Rotas usadas pelo frontend — todas testadas contra `server.js`

Extraí todas as chamadas `fetch('/api/...')` de `public/index.html`, `public/landing.html`, `public/validar.html`, `public/checkout.html` e `public/checkout-resultado.html` (44 chamadas únicas) e cruzei com as rotas registradas.

**Resultado: todas existem, exceto as 4 de `/api/pagamentos/*`** (achado pré-existente da seção 3, não relacionado à Sprint 1).

Testes específicos nas duas rotas alteradas nesta sprint:

- **`GET /api/autorizacoes/codigo/:codigo`** — testado ao vivo com um código inexistente: retorna `null` (comportamento inalterado). Revisei `public/index.html:1215-1228`: o código só lê `dados.preenchidoPorCorretor`, `dados.proprietario` e `dados.imovel` — exatamente os três campos que a rota ainda devolve. **Nenhuma quebra funcional.**
- **`POST /api/enviar-email`** (`public/index.html:4627`) — continua pública, mesmo path/método/corpo de resposta; só ganhou um limite de 5 req/15min por IP, que não afeta o uso legítimo (1 envio de OTP por tentativa). **Nenhuma quebra funcional.**

---

## 7. Warnings encontrados

1. **`dotenv` imprime uma linha promocional no boot** (ex.: `◇ injected env (0) from .env // tip: ⌘ override existing { override: true }`), com o texto do "tip" mudando a cada execução. Confirmado como comportamento do próprio pacote `dotenv` (versão instalada — não é injeção de terceiros). Cosmético, não afeta funcionamento, mas polui o log de produção.
2. **`GET /api/admin/metricas` duplicada** (seção 2) — sem efeito funcional hoje, mas é uma armadilha para futuras edições (editar a segunda definição não tem efeito).
3. **`/api/pagamentos/*` retorna HTML com status 200 em vez de 404** para rotas inexistentes — comportamento do catch-all do SPA, mascarando o real problema (rota não implementada) como uma resposta "de sucesso" inválida no frontend.
4. Nenhum warning de depreciação do Node ou de `express`/`nedb-promises` foi observado na saída padrão/erro ao iniciar o servidor.

---

## Resumo

| Item verificado | Resultado |
|---|---|
| 1. Sintaxe | ✅ OK |
| 2. Rotas registradas | ✅ Todas presentes, nenhuma perdida |
| 3. Referências quebradas | ⚠️ 1 achado pré-existente (`/api/pagamentos/*`, não causado pela Sprint 1) |
| 4. Variáveis/funções não usadas | ⚠️ 2 achados pré-existentes (`validarCPF`/`validarCNPJ`, `cnpjLimpo`) — nenhum causado pela Sprint 1 |
| 5. Imports inválidos | ✅ Nenhum |
| 6. Rotas do frontend | ✅ Nenhuma quebra causada pela Sprint 1 (as 2 rotas alteradas foram testadas e continuam compatíveis) |
| 7. Warnings | 3 listados acima, nenhum crítico |

**Conclusão: as 4 alterações da Sprint 1 não introduziram nenhuma regressão, referência quebrada, rota perdida ou quebra de compatibilidade com o frontend.** Os achados listados nas seções 3, 4 e 7 já existiam antes da Sprint 1 e ficam registrados aqui apenas porque a verificação pedida é ampla — nenhum deles foi causado pelas mudanças desta sprint.

---

*Relatório gerado em modo somente-leitura — nenhum arquivo de código foi alterado durante esta validação.*
