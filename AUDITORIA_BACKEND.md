# Auditoria Completa do Backend — Agemob

> Gerado por auditoria estática, sem execução de código e sem alteração de nenhum arquivo do projeto.
> Escopo: `server.js` (arquivo que roda de fato em produção — `npm start` → `node server.js`), `services/`, `routes/` e a árvore paralela `src/` (não conectada ao servidor).
> Todas as referências de linha são do `server.js` no estado atual do repositório.

---

## 1. Todas as rotas da API agrupadas por módulo

### Auth
| Método | Rota | Linha | Auth |
|---|---|---|---|
| POST | `/api/auth/login` | 222 | Pública |
| GET | `/api/auth/me` | 303 | Qualquer role autenticada |
| POST | `/api/cadastro` | 913 | Pública (auto-cadastro) |

### Super Admin — Imobiliárias / Clientes
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/admin/imobiliarias` | 325 | super_admin |
| POST | `/api/admin/imobiliarias` | 337 | super_admin |
| PUT | `/api/admin/imobiliarias/:id` | 402 | super_admin |
| PATCH | `/api/admin/imobiliarias/:id` | 415 | super_admin |
| PATCH | `/api/admin/imobiliarias/:id/status` | 457 | super_admin |
| GET | `/api/admin/imobiliarias/:id/usuarios` | 475 | super_admin |
| GET | `/api/admin/metricas` | 464 (1ª def.) e 855 (2ª def., **nunca executa**) | super_admin |
| GET | `/api/admin/ranking` | 894 | super_admin |
| POST | `/api/admin/suporte/:imobId` | 1517 | super_admin |

### Planos & Pacotes (catálogo)
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/admin/planos` | 696 | super_admin |
| POST | `/api/admin/planos` | 701 | super_admin |
| PUT | `/api/admin/planos/:id` | 711 | super_admin |
| DELETE | `/api/admin/planos/:id` | 744 | super_admin |
| GET | `/api/admin/pacotes` | 752 | super_admin |
| GET | `/api/pacotes` | 756 | Pública |
| POST | `/api/admin/pacotes` | 760 | super_admin |
| PUT | `/api/admin/pacotes/:id` | 767 | super_admin |
| DELETE | `/api/admin/pacotes/:id` | 773 | super_admin |
| POST | `/api/admin/imobiliarias/:id/creditos` | 781 | super_admin |
| PATCH | `/api/admin/imobiliarias/:id/plano` | 803 | super_admin |

### Billing / Subscriptions
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/admin/billing/metricas` | 1212 | super_admin |
| GET | `/api/admin/subscriptions` | 1218 | super_admin |
| PATCH | `/api/admin/subscriptions/:imobId/plano` | 1268 | super_admin |
| PATCH | `/api/admin/subscriptions/:imobId/status` | 1277 | super_admin |
| POST | `/api/admin/subscriptions/:imobId/creditos` | 1288 | super_admin |
| PATCH | `/api/admin/subscriptions/:imobId/resetar` | 1298 | super_admin |
| PATCH | `/api/admin/subscriptions/:imobId/limite` | 1306 | super_admin |
| GET | `/api/admin/subscriptions/:imobId/historico` | 1316 | super_admin |
| POST | `/api/admin/subscriptions/:imobId/iniciar` | 1339 | super_admin |
| GET | `/api/minha-assinatura` | 1322 | admin, corretor |
| GET | `/api/uso-plano` | 837 | admin, corretor |

### Autorizações (núcleo do produto)
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/autorizacoes` | 1000 | admin, corretor, super_admin |
| POST | `/api/autorizacoes` | 1008 | admin, corretor |
| POST | `/api/autorizacoes/rascunho` | 1040 | admin, corretor |
| POST | `/api/autorizacoes/manual` | 1073 | **Sem `authMiddleware`** — JWT validado manualmente |
| POST | `/api/autorizacoes/assinar` | 1106 | Pública (fluxo do proprietário, sem login) |
| POST | `/api/autorizacoes/:id/cancelar` | 1147 | admin, corretor |
| GET | `/api/autorizacoes/codigo/:codigo` | 966 | Pública |
| GET | `/api/validar/:codigo` (API) | 1352 | Pública |
| GET | `/api/dashboard` | 1157 | admin, corretor, super_admin |

### Boletos
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/boletos` | 1396 | admin, corretor |
| GET | `/api/admin/boletos` | 1417 | super_admin |
| POST | `/api/admin/boletos` | 1430 | super_admin |
| PATCH | `/api/admin/boletos/:id/status` | 1456 | super_admin |

### Créditos
| Método | Rota | Linha | Auth |
|---|---|---|---|
| POST | `/api/creditos/solicitar` | 1486 | admin, corretor |
| GET | `/api/creditos/historico` | 1505 | admin, corretor |

### Configuração de fluxo
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/fluxo-config` | 986 | admin, corretor, super_admin |
| POST | `/api/fluxo-config` | 991 | admin, super_admin |
| GET | `/api/fluxo-config-publico/:slug` | 1199 | Pública |

### Diversos / Infra
| Método | Rota | Linha | Auth |
|---|---|---|---|
| GET | `/api/sse` | 60 | admin, corretor |
| GET | `/api/health` | 910 | Pública |
| GET | `/api/base-url` | 963 | Pública |
| GET | `/api/imobiliaria/:slug` | 973 | Pública |
| POST | `/api/enviar-email` | 1188 | **Pública, sem nenhuma auth** |
| GET | `/validar/:codigo` (HTML) | 1553 | Pública |
| GET | `/{*path}` (SPA catch-all) | 1557 | Pública |

### Módulo de pagamento (Mercado Pago) — `routes/payments.js` e `routes/webhooks.js`
**Não fazem parte desta lista porque não estão montados em `server.js`.** Nenhum `app.use()` referencia esses arquivos — são código morto do ponto de vista do servidor que roda hoje. Detalhado na seção 13.

---

## 2. Todos os middlewares existentes

| Middleware | Onde | Aplicado em |
|---|---|---|
| `express.json({ limit: '10mb' })` | linha 173 | Global |
| `express.static('public')` | linha 174 | Global |
| `authLimiter` (`express-rate-limit`, 20 req/15min) | linha 177, 179 | `/api/auth/*` |
| `apiLimiter` (`express-rate-limit`, 100 req/min) | linha 178, 180 | `/api/*` (todas as rotas de API) |
| `authMiddleware(roles = [])` | linha 183–203 | Por rota, individualmente (ver tabela da seção 1) |
| `filtroImobiliaria(req, extra)` | linha 204–213 | **Usado em apenas 1 rota** (`GET /api/autorizacoes`, linha 1000) |

Não há: `cors`, `helmet`, middleware de validação de schema (`zod`/`joi`/`express-validator`), middleware de tratamento de erro centralizado (`app.use((err, req, res, next) => ...)`), nem logging de requisições (`morgan`).

---

## 3. Todas as rotas públicas (sem autenticação)

1. `POST /api/auth/login`
2. `POST /api/cadastro`
3. `GET /api/pacotes`
4. `GET /api/health`
5. `GET /api/base-url`
6. `GET /api/autorizacoes/codigo/:codigo` — **retorna o registro completo, sem mascarar CPF** (ver seção 7)
7. `GET /api/imobiliaria/:slug`
8. `GET /api/fluxo-config-publico/:slug`
9. `POST /api/autorizacoes/assinar` — pública por desenho (fluxo do proprietário)
10. `POST /api/enviar-email` — **pública, sem necessidade de nenhum segredo** (ver seção 12)
11. `GET /api/validar/:codigo`
12. `GET /validar/:codigo` (HTML)
13. `GET /{*path}` (catch-all SPA)
14. `POST /api/autorizacoes/manual` — **tecnicamente exige um JWT válido, mas não usa `authMiddleware`** (ver seção 4)

---

## 4. Todas as rotas protegidas

Todas as listadas nas tabelas da seção 1 com `authMiddleware([...])` explícito. Caso especial:

- **`POST /api/autorizacoes/manual` (linha 1073–1103)** não usa `authMiddleware`. Faz parsing manual do header (`req.headers.authorization?.slice(7)`, sem checar se o header começa com `"Bearer "`) e `jwt.verify` inline. Funciona porque `"Bearer "` tem exatamente 7 caracteres, mas é frágil e **não aplica nenhuma restrição de `role`** — qualquer usuário com token válido de qualquer papel (mesmo que nunca devesse ter acesso a esta ação) passa.

---

## 5. Todas as consultas ao banco de dados

Lista de todas as chamadas NeDB (`db.<coleção>.find/findOne/insert/update/remove/count`) por rota, na ordem em que aparecem no arquivo:

| Linha | Coleção | Operação | Rota |
|---|---|---|---|
| 326 | imobiliarias | find({}) | GET /api/admin/imobiliarias |
| 329–330 | autorizacoes | count ×2 | GET /api/admin/imobiliarias |
| 357–359 | imobiliarias | findOne ×3 (cnpj/cpf/creci) | POST /api/admin/imobiliarias |
| 363–364 | planos | findOne | POST /api/admin/imobiliarias |
| 369 | imobiliarias | insert | POST /api/admin/imobiliarias |
| 387 | usuarios | insert | POST /api/admin/imobiliarias |
| 405 | imobiliarias | update | PUT /api/admin/imobiliarias/:id |
| 427, 433, 437, 448 | imobiliarias / subscriptions / usuarios | update | PATCH /api/admin/imobiliarias/:id |
| 459 | imobiliarias | update | PATCH /api/admin/imobiliarias/:id/status |
| 465–470 | imobiliarias / autorizacoes | count | GET /api/admin/metricas (1ª def.) |
| 476 | usuarios | find | GET /api/admin/imobiliarias/:id/usuarios |
| 486–645 | planos / subscriptions / imobiliarias / subscription_history / billing_transactions | várias | `SubscriptionService` / `BillingService` (objetos usados por múltiplas rotas) |
| 653–667 | imobiliarias / autorizacoes | findOne / count | `verificarLimite()` (chamada por 2 rotas) |
| 684 | imobiliarias | update | `consumirCredito()` |
| 697 | planos | find | GET /api/admin/planos |
| 706 | planos | insert | POST /api/admin/planos |
| 723–737 | planos / subscriptions / imobiliarias | update | PUT /api/admin/planos/:id |
| 745 | planos | remove | DELETE /api/admin/planos/:id |
| 753 | pacotes | find | GET /api/admin/pacotes |
| 757 | pacotes | find | GET /api/pacotes |
| 763 | pacotes | insert | POST /api/admin/pacotes |
| 769 | pacotes | update | PUT /api/admin/pacotes/:id |
| 774 | pacotes | remove | DELETE /api/admin/pacotes/:id |
| 785–789 | imobiliarias / compras | findOne / update / insert | POST /api/admin/imobiliarias/:id/creditos |
| 806–808 | planos / imobiliarias | findOne / update | PATCH /api/admin/imobiliarias/:id/plano |
| 838, 842 | imobiliarias / autorizacoes | findOne / count | GET /api/uso-plano |
| 856–875 | imobiliarias / autorizacoes | find / count | GET /api/admin/metricas (2ª def., morta) |
| 895–900 | imobiliarias / autorizacoes | find / count | GET /api/admin/ranking |
| 922 | usuarios | findOne | POST /api/cadastro |
| 925 | planos | findOne | POST /api/cadastro |
| 930, 942 | imobiliarias / usuarios | insert | POST /api/cadastro |
| 967 | autorizacoes | findOne | GET /api/autorizacoes/codigo/:codigo |
| 974 | imobiliarias | findOne | GET /api/imobiliaria/:slug |
| 988 | config | findOne | GET /api/fluxo-config |
| 993 | config | update (upsert) | POST /api/fluxo-config |
| 1001–1003 | autorizacoes | find (via `filtroImobiliaria`) | GET /api/autorizacoes |
| 1010 | (verificarLimite) | — | POST /api/autorizacoes |
| 1031 | autorizacoes | insert | POST /api/autorizacoes |
| 1044, 1065 | (verificarLimite) / autorizacoes | — / insert | POST /api/autorizacoes/rascunho |
| 1099 | autorizacoes | insert | POST /api/autorizacoes/manual |
| 1112, 1130/1132 | autorizacoes | findOne / update ou insert | POST /api/autorizacoes/assinar |
| 1149, 1151 | autorizacoes | findOne / update | POST /api/autorizacoes/:id/cancelar |
| 1159 | autorizacoes | find | GET /api/dashboard |
| 1201, 1203 | imobiliarias / config | findOne | GET /api/fluxo-config-publico/:slug |
| 1221–1230 | imobiliarias / subscriptions / autorizacoes | find / findOne / count | GET /api/admin/subscriptions |
| 1309–1310 | subscriptions / imobiliarias | update | PATCH /api/admin/subscriptions/:imobId/limite |
| 1317 | subscription_history | find | GET /api/admin/subscriptions/:imobId/historico |
| 1327 | autorizacoes | count | GET /api/minha-assinatura |
| 1354 | autorizacoes | findOne | GET /api/validar/:codigo |
| 1398, 1403 | boletos | find / update | GET /api/boletos |
| 1419, 1422 | boletos / imobiliarias | find / findOne | GET /api/admin/boletos |
| 1436, 1437 | imobiliarias / boletos | findOne / insert | POST /api/admin/boletos |
| 1463, 1466, 1468, 1471, 1474 | boletos / subscriptions / imobiliarias | update / findOne | PATCH /api/admin/boletos/:id/status |
| 1489 | compras | insert | POST /api/creditos/solicitar |
| 1507 | compras | find | GET /api/creditos/historico |
| 1519, 1523 | imobiliarias / usuarios | findOne | POST /api/admin/suporte/:imobId |
| 233/240 | usuarios | findOne | POST /api/auth/login |
| 259 | imobiliarias | findOne | POST /api/auth/login |
| 305 | usuarios | findOne | GET /api/auth/me |

---

## 6. Consultas que NÃO filtram por `imobiliariaId`

Separadas em duas categorias: **(A) corretas por desenho** (rota `super_admin`, catálogo global, ou endpoint público que devolve dados não sensíveis) e **(B) risco real**.

### (A) Sem filtro, mas corretas
- Tudo em `/api/admin/*` que lista/agrega entre imobiliárias (`GET /api/admin/imobiliarias`, `/api/admin/metricas`, `/api/admin/ranking`, `/api/admin/subscriptions`, `/api/admin/boletos`) — é o próprio propósito da rota, restrita a `super_admin`.
- `GET /api/pacotes`, `GET /api/admin/planos`, `GET /api/admin/pacotes` — catálogos globais, não pertencem a uma imobiliária.
- `GET /api/imobiliaria/:slug`, `GET /api/fluxo-config-publico/:slug`, `GET /api/validar/:codigo` — públicas por desenho, mas **retornam apenas subconjuntos de campos não sensíveis** (checado campo a campo no código).
- `POST /api/autorizacoes/assinar` — pública por desenho (é o próprio fluxo de assinatura do proprietário sem login); a busca por `codigo` é intencional.

### (B) Sem filtro — risco real
1. **`GET /api/autorizacoes/codigo/:codigo` (linha 966–970)**
   ```js
   const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
   if (!aut) return res.json(null);
   res.json(aut);
   ```
   Devolve o **documento inteiro** (proprietário com CPF sem máscara, endereço, imóvel, corretor, `imobiliariaId`) para qualquer requisição não autenticada, sem checar a qual imobiliária o código pertence. Compare com `GET /api/validar/:codigo`, que devolve os mesmos dados só que mascarados e com allowlist de campos. Ver seção 7 e 12.

2. **`POST /api/enviar-email` (linha 1188–1196)** — não é uma leitura de dado de tenant, mas é uma rota totalmente pública que aciona uma ação (envio de e-mail) sem nenhum vínculo com `imobiliariaId`/usuário — qualquer chamador escolhe destinatário e conteúdo.

---

## 7. Consultas que podem permitir acesso cruzado entre imobiliárias

1. **`GET /api/autorizacoes/codigo/:codigo`** — o principal ponto de acesso cruzado real do sistema hoje. Não há autenticação nem checagem de `imobiliariaId`; um usuário da Imobiliária A que descobrir/adivinhar um código de autorização da Imobiliária B lê o registro completo dela (nome e CPF do proprietário, endereço do imóvel, valor, corretor responsável). O código tem 9 caracteres de um alfabeto de 33 símbolos (~46 bits de entropia), então não é adivinhável por força bruta — mas qualquer vazamento do código (ex.: aparece em logs, é compartilhado por engano, fica em um link salvo) expõe o registro publicamente e sem rastro de quem acessou.

2. **`POST /api/autorizacoes/manual`** — não é uma leitura cruzada (o insert usa `user.imobiliariaId` do próprio token), mas por não usar `authMiddleware(['admin','corretor'])`, um usuário autenticado com qualquer papel pode inserir registros "assinados" na sua própria imobiliária sem as checagens de limite/plano que as outras rotas de criação aplicam (`verificarLimite` não é chamado aqui). Não é acesso cruzado entre tenants, mas é uma inconsistência de controle de acesso dentro do próprio tenant.

3. **Nenhuma outra rota autenticada permite cruzamento** — todas as demais que operam sobre dados de uma imobiliária específica (`autorizacoes`, `boletos`, `compras`, `config`) usam `req.user.imobiliariaId` do JWT (não aceitam um `imobiliariaId` vindo do body/query do cliente), o que é o padrão correto: o token é a única fonte de verdade para qual tenant a operação pertence.

---

## 8. Consultas que usam `req.user` corretamente

Rotas onde o filtro por tenant vem do JWT (`req.user.imobiliariaId` ou `req.user.userId`), não de input do cliente — padrão correto:

- `GET /api/auth/me` — `db.usuarios.findOne({ _id: req.user.userId })`
- `GET /api/sse` — sala SSE isolada por `req.user.imobiliariaId`
- `GET /api/uso-plano` — `db.imobiliarias.findOne({ _id: req.user.imobiliariaId })` + `db.autorizacoes.count({ imobiliariaId: req.user.imobiliariaId, ... })`
- `GET /api/fluxo-config` / `POST /api/fluxo-config` — chave derivada de `req.user.imobiliariaId`
- `GET /api/autorizacoes` — via `filtroImobiliaria(req)` (linha 204–213, novo helper — bom padrão, mas subutilizado, ver seção 15)
- `POST /api/autorizacoes` / `POST /api/autorizacoes/rascunho` — grava `imobiliariaId: req.user.imobiliariaId`
- `POST /api/autorizacoes/:id/cancelar` — `db.autorizacoes.findOne({ _id: req.params.id, imobiliariaId: req.user.imobiliariaId })` — **exemplo do padrão mais seguro do arquivo**: combina o `_id` do path com o tenant do token na mesma query, impedindo que um admin da Imobiliária A cancele uma autorização da Imobiliária B mesmo sabendo o `_id`.
- `GET /api/dashboard` — `role === 'super_admin' ? {} : { imobiliariaId: req.user.imobiliariaId }`
- `GET /api/boletos` — `db.boletos.find({ imobiliariaId: req.user.imobiliariaId })`
- `POST /api/creditos/solicitar` / `GET /api/creditos/historico` — idem
- `GET /api/minha-assinatura` — `SubscriptionService.get(req.user.imobiliariaId)`

---

## 9. Rotas exclusivas do Super Admin

Todas com `authMiddleware(['super_admin'])` — 27 rotas: as 9 de imobiliárias/clientes, as 9 de planos/pacotes/créditos manuais, as 9 de billing/subscriptions/boletos administrativos, listadas por completo na seção 1. Nenhuma rota de escrita sensível (planos, pacotes, imobiliárias, boletos, suporte) está fora dessa proteção.

## 10. Rotas exclusivas do Admin da imobiliária (excluindo corretor)

Apenas **uma**:
- `POST /api/fluxo-config` (linha 991) — `authMiddleware(['admin','super_admin'])`, sem `corretor`.

Todo o resto do sistema que distingue papéis trata `admin` e `corretor` de forma idêntica (mesma lista de roles permitidas). Ou seja, **hoje não existe separação real de permissões entre o admin da imobiliária e um corretor** dentro do painel — um corretor tem acesso às mesmas rotas que o admin, exceto a única listada acima. Isso é relevante para a seção 15 (melhoria de arquitetura) se o produto pretende ter hierarquia real entre esses papéis (ex.: só admin gerenciar créditos, ver billing, etc. — hoje `POST /api/creditos/solicitar`, `GET /api/boletos`, `GET /api/minha-assinatura` etc. são abertas a `corretor` também).

## 11. Rotas compartilhadas (mais de um papel)

- `admin` + `corretor`: `/api/sse`, `/api/uso-plano`, `/api/autorizacoes` (GET/POST), `/api/autorizacoes/rascunho`, `/api/autorizacoes/:id/cancelar`, `/api/boletos`, `/api/creditos/solicitar`, `/api/creditos/historico`, `/api/minha-assinatura`
- `admin` + `corretor` + `super_admin`: `/api/fluxo-config` (GET), `/api/autorizacoes` (GET), `/api/dashboard`

---

## 12. Possíveis vulnerabilidades de segurança

Em ordem de severidade:

1. **Exposição pública de dados completos e não mascarados** — `GET /api/autorizacoes/codigo/:codigo` (linha 966). Sem autenticação, sem máscara de CPF, sem escopo por tenant. É o mesmo dado que `GET /api/validar/:codigo` expõe de forma correta (mascarado, campos mínimos) — a diferença entre as duas rotas é o gap de segurança. **Recomendação**: aplicar a mesma allowlist/máscara de `/api/validar/:codigo`, ou exigir autenticação.

2. **Endpoint de envio de e-mail totalmente público** — `POST /api/enviar-email` (linha 1188). Qualquer requisição externa pode usar a conta Brevo do Agemob como um relay de e-mail arbitrário (spam, phishing usando o domínio/reputação do remetente configurado). **Recomendação**: exigir `authMiddleware`, ou pelo menos vincular a uma ação legítima do sistema (ex.: reenvio de notificação de uma autorização específica, validado pelo `codigo`) em vez de aceitar destinatário/assunto/corpo livres.

3. **Segredos JWT com fallback fraco e inconsistente entre si.** O arquivo tem hoje **dois valores-padrão diferentes** para o mesmo segredo:
   - linha 17: `const JWT_SECRET = process.env.JWT_SECRET || 'agemob-dev-secret-mude-em-producao'` (usado em `/api/cadastro`, `/api/admin/suporte/:imobId`, `/api/autorizacoes/manual`)
   - linhas 192 e 274: `process.env.JWT_SECRET || 'agemob-dev-secret'` (usado em `authMiddleware` e no login) — **string diferente da constante acima**.

   Se a variável de ambiente `JWT_SECRET` não estiver definida (ex.: ambiente local, ou uma falha de configuração no deploy), tokens emitidos por `/api/cadastro` ou pelo "modo suporte" seriam assinados com um segredo e verificados pelo `authMiddleware` com outro — falhando a autenticação de forma silenciosa e confusa. Mais grave: com a env var ausente, os dois segredos são **strings fixas conhecidas publicamente** (estão neste próprio código e no `.env.example`), permitindo forjar tokens de `super_admin`. **Recomendação**: um único `JWT_SECRET` centralizado, sem fallback — o processo deve falhar ao subir se a env var não estiver definida em produção.

4. **Senhas padrão hardcoded como fallback** — `SUPER_ADMIN_PASS || 'LuxAdmin2026!'` (linha 89) e `LUX_ADMIN_PASS || 'lux2026'` (linha 141), usadas de fato no `seed()` se as env vars não existirem. Mesmo raciocínio do item 3.

5. **Lógica de login com alias não documentado** (linhas 238–244):
   ```js
   if (!user && login === 'admin' || login === 'admin@agemob.com.br') {
     user = await db.usuarios.findOne({ email: 'admin@agemob.com.br', ativo: true });
   }
   ```
   Por precedência de operadores, isso equivale a `(!user && login === 'admin') || (login === 'admin@agemob.com.br')`. Na prática, permite logar como super admin digitando literalmente `admin` no campo de e-mail. Não é uma falha de autenticação em si (ainda exige a senha correta), mas é um comportamento não intencional/não documentado que facilita adivinhação de qual conta é a privilegiada.

6. **`POST /api/autorizacoes/manual` bypassa o middleware central de auth** (linha 1073) — parsing manual de token (`slice(7)` sem checar prefixo `"Bearer "`), sem checagem de `role`, sem chamar `verificarLimite`. Qualquer papel autenticado pode inserir uma autorização já com `status: 'assinado'` sem consumir crédito nem respeitar o limite do plano.

7. **Vazamento de mensagem de erro interna ao cliente** — padrão `catch(e) { res.status(500).json({ erro: e.message }) }` repetido em ~35 rotas. Expõe detalhes internos (nomes de campo, mensagens de driver do NeDB) que facilitam reconhecimento da stack por um atacante.

8. **Ausência de `helmet`/CORS/CSP** em todo o projeto — sem cabeçalhos de segurança HTTP padrão.

9. **Rate limiting único e genérico** (100 req/min por IP em todo `/api/*`) — não há limite dedicado e mais restritivo para rotas sensíveis a abuso, como `/api/enviar-email` ou `/api/autorizacoes/assinar`.

10. **Rota duplicada `GET /api/admin/metricas`** (linhas 464 e 855) — a segunda definição nunca executa (Express usa a primeira rota registrada que casa o path). Não é uma vulnerabilidade por si, mas é uma armadilha: se um dev "corrigir" um bug editando a versão de baixo (mais completa, com `alertasLimite`), a correção não terá efeito nenhum em produção.

11. **"Modo suporte" (`POST /api/admin/suporte/:imobId`, linha 1517)** gera um JWT de `admin` real (2h) para o super admin agir como o admin de qualquer imobiliária. É uma feature intencional e fica logada na criação (`log('suporte', ...)`), mas nenhuma ação subsequente feita com esse token fica marcada como "feita em modo suporte" nos logs de negócio — só o evento inicial de entrada é auditável.

---

## 13. Código duplicado

### Dentro do próprio `server.js`
- Construção do payload do JWT (`userId, nome, email, role, imobiliariaId, imobiliariaSlug, imobiliariaNome`) repetida em 4 lugares: login (264), cadastro (952), modo suporte (1527) — cada um com pequenas variações de campos.
- `GET /api/admin/metricas` definida duas vezes (464 e 855) — a segunda é módulo morto.
- Lógica de "porcentagem de uso do plano" (`calcularPorcentagem`) e "verificação de limite" (`verificarLimite`) usadas em pelo menos 5 rotas diferentes sem um único ponto central de verdade fora da função already-compartilhada.

### Entre `server.js` e a árvore paralela `src/` (não conectada ao servidor)
A pasta `src/domains` e `src/shared` contém uma **réplica quase linha-a-linha** de boa parte do `server.js`, nunca importada por ele (confirmado: nenhum `require('./src/...')` existe em `server.js`):

| Arquivo em `src/` | Duplica a lógica de |
|---|---|
| `src/domains/clientes/clientes.controller.js` + `.routes.js` | Rotas `/api/admin/imobiliarias*`, `/api/admin/metricas`, `/api/admin/ranking`, `/api/imobiliaria/:slug`, `/api/admin/suporte/:imobId` — inclusive reproduz o bug da rota `/api/admin/metricas` duplicada, com um comentário próprio documentando o bug |
| `src/domains/financeiro/limite.service.js` | `verificarLimite`, `consumirCredito`, `calcularPorcentagem` (linhas 652–691 do server.js) |
| `src/shared/seed.js` | função `seed()` (linhas 85–148) |
| `src/shared/validadores.js` | `validarCPF`/`validarCNPJ` (linhas 819–832) |
| `src/shared/codigo.js` | `genCode()` (linhas 158–162) |
| `src/shared/sse.js` | `sseNotificar` + rota SSE (linhas 48–80) |
| `src/shared/email.js` | `enviarEmailBrevo` + rota `/api/enviar-email` (linhas 1090–1114/1188) |
| `src/shared/logger.js` | função `log()` (linhas 153–156) |
| `src/middlewares/auth.js` | `authMiddleware` (linhas 183–203) — porém já desatualizado frente à versão atual do `server.js` (não tem o `filtroImobiliaria`, usa o `JWT_SECRET` importado em vez do fallback inline) |
| `src/middlewares/rateLimit.js` | `authLimiter`/`apiLimiter` (linhas 177–178) |
| `src/domains/auth/*` (criado nesta sessão) | Rotas de login/me/cadastro — extraído do antigo `src/domains/usuarios`, também não conectado |
| `routes/payments.js` + `routes/webhooks.js` + `services/paymentService.js` | Módulo de pagamento Mercado Pago inteiro — não referenciado por `server.js`; `db.pagamentos` (coleção que esses arquivos esperam) nem existe no objeto `db` real |

**Nenhum arquivo em `src/` ou `routes/{payments,webhooks}.js` é executado quando o servidor sobe.** Um desenvolvedor (ou uma IA) editando esses arquivos pode facilmente achar que está corrigindo o comportamento real do sistema sem nenhum efeito em produção.

---

## 14. Funções que podem ser reutilizadas

Já existem como funções isoladas e **deveriam ser o único ponto de verdade** (hoje coexistem com cópias em `src/`):

- `genCode()` — geração de código de autorização
- `validarCPF(cpf)` / `validarCNPJ(cnpj)` — chamadas em `POST /api/admin/imobiliarias`, mas **nunca são de fato invocadas nas validações do corpo da requisição** (estão definidas mas não usadas em nenhum `if` — CPF/CNPJ inválidos passam sem checagem de dígito verificador, apenas checagem de presença)
- `verificarLimite(imobiliariaId)` / `consumirCredito` / `calcularPorcentagem` — usadas de forma consistente dentro do `server.js`, mas duplicadas em `src/domains/financeiro`
- `filtroImobiliaria(req, extra)` (linha 204) — **o melhor candidato a padrão único de escopo por tenant**, mas usado em apenas 1 das ~20 rotas que fazem `find`/`count` filtrando por `imobiliariaId` manualmente. Se fosse adotado de forma consistente, eliminaria boa parte da inconsistência apontada nas seções 6–8.
- A construção do JWT (payload + `jwt.sign`) deveria virar uma função única `gerarToken(user, imobiliaria, opts)` — hoje reimplementada 4 vezes com pequenas diferenças de campos incluídos.
- O padrão "buscar imobiliária por `slug`, devolver só campos públicos" se repete quase idêntico em `GET /api/imobiliaria/:slug` e dentro de `GET /api/fluxo-config-publico/:slug`.

---

## 15. Melhorias de arquitetura

1. **Resolver a divergência `server.js` vs `src/`** antes de qualquer outra coisa — hoje é a maior fonte de risco de "correção fantasma" (editar o lugar errado). Ou termina a migração e conecta `src/domains` de fato ao Express, ou remove a árvore paralela.
2. **Adotar `filtroImobiliaria` como padrão único** para toda query que hoje monta `{ imobiliariaId: req.user.imobiliariaId }` manualmente — reduz a chance de esquecer o filtro numa rota nova.
3. **Corrigir a rota duplicada `/api/admin/metricas`** — decidir qual das duas versões é a correta e remover a outra.
4. **Unificar o segredo JWT** em uma única constante sem fallback, com verificação no boot (`process.exit(1)` se ausente em produção).
5. **Centralizar a criação de token** numa função `gerarToken()`.
6. **Adicionar um error handler global do Express** (`app.use((err, req, res, next) => ...)`) e trocar `catch(e) { res.json({erro: e.message}) }` por um erro genérico ao cliente + log detalhado no servidor.
7. **Adicionar `helmet` e uma política de CORS explícita.**
8. **Decidir o destino do módulo de pagamento** (`routes/payments.js`, `routes/webhooks.js`, `services/paymentService.js`) — hoje representa trabalho pronto e não utilizado; se for para integrar, falta criar a coleção `db.pagamentos` e montar os routers.
9. **Definir permissões reais entre `admin` e `corretor`** — hoje só uma rota (`POST /api/fluxo-config`) diferencia os dois papéis; se o produto pretende ter hierarquia (ex.: só admin mexe em billing/créditos), isso precisa ser desenhado e aplicado de forma consistente.
10. **Validação de entrada centralizada** (schema por rota) — hoje cada handler faz seus próprios `if (!campo)`, de forma inconsistente (alguns validam CPF/CNPJ com dígito verificador só na função utilitária que não é chamada; outros nem verificam tipo).

---

*Relatório gerado em modo somente-leitura — nenhum arquivo de código foi alterado.*
