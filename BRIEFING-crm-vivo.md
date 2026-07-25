# BRIEFING — CRM Vivo · contrato de trabalho do time

> Documento único de conduta desta entrega. **Todo mundo do time lê isto inteiro antes
> de tocar em qualquer coisa.** Não existe versão resumida. Se você recebeu uma tarefa
> sem ter lido este arquivo, pare e leia.
>
> Regência: **Assistente e Testes** (orquestrador desta entrega, palavra final).
> Aprovação humana: **Rafael**.

---

## 0. Onde o trabalho acontece

- **Worktree:** `/Users/rafaelmelgaco/DeskcommCRM-crm-vivo`
- **Branch:** `feat/crm-vivo`, criada de `origin/main` (`3b4c193`)
- **Próxima migration livre:** `0070` (a base vai até `0067`)
- **Dev server desta entrega:** porta **3020** (3000/3001/3010 são de outras sessões — **não encoste**)
- **Worker alheio vivo na 8787:** de outra sessão. **Não mate, não reinicie.**

Existem outros worktrees vivos (`.claude/worktrees/*`, `DeskcommCRM-qa`, `DeskcommCRM-main-preview`,
`DeskcommCRM-vendaval*`). **Nenhum deles é seu.** Trabalhe só no worktree acima.

---

## 1. A missão

O DeskcommCRM existe para que **todo lead que entra vire uma venda feita ou um problema
resolvido** — nunca um card parado que ninguém viu.

O sistema tem duas metades que funcionam e não se conhecem: uma **pensa** (harness:
`lead_state`, `lead_checkpoints`, `before_send_traces`, `ai_agent_runs`) e outra **registra**
(CRM: `crm_leads`, `crm_stages`, `crm_lead_activities`, o Kanban).

**Vamos construir o sistema nervoso entre elas.** O que a IA pensa vira coisa que o humano
vê, decide e devolve; o que o humano decide vira contexto que a IA usa para retomar.

> Um CRM não fica inteligente quando você pluga uma IA nele.
> Fica inteligente quando cada peça passa a conversar com as outras.

---

## 2. Diagnóstico — verificado no código, não redescubra

| # | Achado | Evidência (já conferida) |
|---|---|---|
| 1 | **Dois funis paralelos sobre a mesma pessoa** | `lead_state` (`migrations/…0050_agent_harness.sql:237-248`) — `unique (organization_id, contact_id)`, `stage` CHECK hard-coded `new\|contacted\|qualifying\|qualified\|negotiating\|won\|lost`. `crm_leads` (`baseline.sql:1454`) — `pipeline_id`/`stage_id` customizáveis. **Zero FK entre os dois.** |
| 2 | **IA é 1ª classe na conversa, não no negócio** | `0032_conversation_assignee_kind.sql` criou `conversations.assignee_kind ('user'\|'ai')` — o comentário diz *"IA como assignee de 1ª classe"*. `crm_leads.owner_user_id uuid` (`baseline.sql:1467`) só aceita humano. **O padrão já foi inventado nesta casa e não foi propagado.** |
| 3 | **O raciocínio da IA é gravado e descartado** | `lead_checkpoints` (`0050:217-229`: `commitments`, `objections`, `next_action`, `rolling_summary`) e `lead_state.next_action` (`0050:245`). **Consumidores em `app/`, `components/`, `hooks/`: ZERO.** Nenhum `.tsx` referencia `next_action`. |
| 4 | **A timeline não é realtime** | `baseline.sql:4080` — publicação recebe `messages, conversations, crm_leads, ai_agents, ai_agent_runs, ai_knowledge_sources`. **`crm_lead_activities` não está na lista.** |
| 5 | **CORE 5 não é greenfield** | `lib/leads/risk-radar.ts` já existe na main (`classifyRisk`, buckets `critico\|em_risco\|em_voo\|em_dia`), com `/app/radar`, `/api/v1/leads/at-risk`, e-2-e e unit. Usa **janelas fixas 24h/72h** e **ignora** `crm_stages.expected_duration_hours`. |
| 6 | **Wave 8 tem soquete pronto** | `lib/agent-engine/edge/crm/move-lead-stage.ts` é um stub que devolve `{ok:false, reason:'not_configured', detail:'espelho de kanban entra na Fase 2 da fusão'}`, chamado em `inbound-turn.ts:995` como warn-only. |
| 7 | **Cardinalidade: NÃO é 1:1** | `inbound-turn.ts:519` → `const leadId = job.contact_id`. No harness, "lead" **é o contato**. `lead_state` é `unique(org, contact)`; `idx_crm_leads_org_contact` é **não-único** → uma pessoa pode ter **N** negócios abertos. |

### O que já existe e **NÃO** se reconstrói
Pipelines, estágios, Kanban, drag-and-drop, custom fields, tags, `lost_reason`, `OwnerBadge`,
`components/ui/sheet.tsx`, o Radar de Risco, `classifyRisk`. Reusar, nunca duplicar.

---

## 3. Decisões tomadas — **não reabra**

**3.1 — Ponte, não fusão.** Os dois funis do Achado 1 **não** viram uma tabela.
- `lead_state` = **estado cognitivo** do agente por contato (BANT, objeções, próxima ação). Memória de trabalho, não funil.
- `crm_leads` = **o negócio** (valor, dono, estágio comercial).
- A ponte: `lead_state` ganha `crm_lead_id` (FK) e `crm_stages` ganha `agent_stage_hint text` — mapa enum→estágio **configurável por pipeline**, preservando a promessa multi-nicho.

**3.2 — O ponteiro não é identidade** (consequência do Achado 7). `lead_state.crm_lead_id`
aponta para o **negócio corrente** do contato. A resolução mora numa função pura testável
(`resolveActiveLeadForContact`): *lead aberto mais recentemente ativo no pipeline default*;
recalcula quando o alvo fecha; **quando o alvo é ambíguo ou inexistente, NÃO adivinha** —
registra atividade e segue. Mover o card errado do cliente errado é o único bug desta
entrega visível para o cliente final.

**3.3 — CORE 5 é reconciliação.** `classifyRisk` vira **fonte única**; a janela passa a vir de
`crm_stages.expected_duration_hours` com fallback nas constantes atuais. Card e `/app/radar`
consomem o mesmo estado. **Um segundo classificador de esfriamento é rejeição automática de
review** — seria cometer, dentro da cura, exatamente a doença que estamos curando.

**3.4 — Escopo fechado.** Os 5 CORES da §4 e nada além. Achou algo valioso fora disso?
**Anote no handoff e siga.** Escopo que cresce no meio é como esta entrega falha.

**3.5 — Realtime sem firehose.** O board **já** escuta `crm_leads` filtrado por `pipeline_id`
(`hooks/kanban/useBoard.ts:45-57`) e o trigger `fn_update_last_activity_at` (`baseline.sql:759`)
faz toda atividade tocar o lead. Logo: **o board nunca assina `crm_lead_activities`**; quem
assina é o dossiê, **filtrado por `lead_id=eq.<id>`**. Assinatura org-wide de atividade é
rejeição automática de review.

---

## 4. Escopo — os 5 CORES

### CORE 1 — A IA é dona do negócio *(fundação)*
`crm_leads` ganha `owner_kind ('user'|'ai')` + `owner_agent_id` (FK → `ai_agents`), **no padrão
da 0032**: CHECK em forma de implicação, backfill **antes** da constraint. O agente vira
assignee de 1ª classe: filtro "responsável", métricas, recebe e transfere leads.

### CORE 2 — Timeline unificada com raciocínio visível *(coração)*
`crm_lead_activities` vira o **barramento único** da vida do lead: ganha `actor_kind
('user'|'ai'|'system'|'rule')`, `actor_agent_id`, `reason text`, `evidence jsonb`
(trace_ids/run_ids, no formato de `flywheel_distiller_proposals.evidence`) — **e entra na
publicação `supabase_realtime`**. Passam a emitir atividade: `ai_agent_runs`,
`lead_checkpoints` (objeções e compromissos), `before_send_traces` (**inclusive as decisões de
NÃO enviar**), mudanças de `stage_id`, e `agent_inbox_items` de handoff.

### CORE 3 — Score de probabilidade com evidência *(Lei do porquê)*
`crm_leads` ganha `ai_probability numeric(5,2)`, `ai_probability_reason text`,
`ai_probability_evidence jsonb`, `ai_probability_at timestamptz`. **Não invente sinal novo:**
leia `lead_checkpoints.objections`/`commitments`, `lead_state.qualification` (BANT), recência
de `last_activity_at`. **Regra dura: score sem `reason` não é gravado — constraint no banco,
não boa intenção.** Quem calcula é **worker consumindo `event_log`**, nunca trigger.

### CORE 4 — Próxima ação no card *(maior impacto, menor esforço)*
`lead_state.next_action` / `lead_checkpoints.next_action` sobem para o card com a decisão
humana: **Aprovar · Editar · Ignorar**. Cada clique vira atividade (CORE 2) — **a recusa é
sinal, não clique perdido.**

### CORE 5 — Esfriando + re-engajamento *(fecha o ciclo)*
Gatilho vindo do funil: lead `open` com `last_activity_at` além do `expected_duration_hours`
do estágio → o agente propõe ou dispara a reativação, conforme alçada. Reusa a maquinaria
existente (`reentry_*`, `pacing_ledger`, `job_queue`, follow-ups) e `classifyRisk` (§3.3).
**Ciclo inteiro visível:** funil detecta → agente age → resultado volta como atividade e move
o card.

### Fora de escopo — anote, não implemente
Aprendizado por deal perdido (flywheel) · forecasting por confiança · alçada configurável de
fechamento · estágios adaptativos · territórios dinâmicos.

---

## 5. Contrato de UI — inegociável

> A tentação é empilhar: score + próxima ação + alerta, cada um num bloco novo.
> **Isso mata o Kanban.** O card não ganha informação — **ganha estado**.

- **Lei A — o card responde 4 perguntas e nada além:** *quanto vale · vai fechar · o que fazer agora · quem está tocando*. O que não responde uma delas vai para hover ou painel.
- **Lei B — orçamento fixo:** 5 elementos, 3 faixas, **altura constante**. O card **não cresce** com dados.
- **Lei C — um accent por vez.** Cor é semântica de estado, nunca decoração.
- **Lei D — nenhum número sem o porquê a ≤1 clique.**

### Anatomia
```
┌─┬──────────────────────────────────────────────┐
│ │  Clínica Vitalis — implantes             ⋮   │  ① identidade
│ │  R$ 12.400                                   │  ② valor · tabular-nums
│▓│  ▇▇▇▇▇▇▇▁▁▁ 72%   Enviar case Vitalis   →    │  ③ a linha do agente
│ │  ⊙ Agente Beta                3d em Negociação│  ④ dono  ⑤ tempo no estágio
└─┴──────────────────────────────────────────────┘
 ↑ borda de estado · 2px · a única cor do card
```

### Um slot, três estados — nunca três blocos
A faixa ③ **alterna** por precedência estrita, **nunca acumula**:

| Precedência | Estado | Mostra | Borda |
|---|---|---|---|
| 1º | Aguardando você | `Propõe: enviar proposta [Aprovar] [✕]` | `accent` |
| 2º | Esfriando | `Sem resposta há 6 dias · Reativar?` | `warning` |
| 3º | Normal | medidor + próxima ação | neutra |

Um lead pode estar nos três — **mostra só o que exige decisão agora**. Não existe quarto
estado: erro, budget e handoff sem dono vivem em `agent_inbox_items`, não no Kanban.

**A precedência é UMA FUNÇÃO PURA TESTÁVEL** (`resolveCardState(lead) → {estado, borda, conteúdo}`),
consumida pelo card, pelo radar e pelos testes. Precedência reimplementada em componente é
rejeição de review.

### Decisões visuais específicas
- **Tags saem do card** → hover. Exceção: **uma** tag canônica (`crm_pipelines.settings.canonical_tags`, já existe) como ponto de 6px ao lado do título.
- **O agente é par do humano.** Humano = círculo **preenchido** com iniciais. Agente = círculo **vazado com anel** + inicial em mono, **mesmo tamanho e peso**, tooltip `Agente Beta · v3`. **Proibido:** emoji 🤖, badge "AI" colorido, avatar cartunesco, gradiente.
- **Score = micro-barra 3px + número** em `text-xs tabular-nums`. Não é badge colorido.

### O dossiê substitui o formulário
`EditLeadDialog` (5 campos) vira **Sheet lateral** (`components/ui/sheet.tsx` já existe). A ordem **é** a mudança:
1. **Cabeçalho vivo** — título, valor, estágio, dono, score com as 3 evidências abertas e clicáveis para o momento da conversa.
2. **Timeline** — linha vertical fina; marcador por ator (preenchido = humano, anel = agente, quadrado = sistema); raciocínio da IA em texto secundário. Realtime. Eventos consecutivos do mesmo ator no mesmo minuto **colapsam** em bloco expansível (`Agente respondeu · 3 ações`).
3. **Campos** — o formulário de hoje, íntegro, **por último**.

### Movimento: vivo é o que responde, não o que se agita
- Evento chega → o card **pulsa uma vez** (ring accent → fade, `--duration-base`/`--ease-out`).
- Texto que mudou → **crossfade** `--duration-fast`. Card que troca de coluna → **transição de posição**, nunca teleporte.
- **Proibido:** animação em loop, spinner permanente, badge "AO VIVO" piscando, contador subindo.
- `prefers-reduced-motion` → pulso vira mudança de fundo estática. **Não é opcional.**
- **Só tokens do design system** (`surface`, `border`, `text-muted`, `accent`, `warning`, `--duration-*`, `--ease-*`, todos em `app/globals.css`). **Nenhum hex solto em componente.**

---

## 6. As waves — ordem obrigatória

| Wave | Entrega | Item no plano Lina |
|---|---|---|
| **0** | Seed de demonstração determinístico | `CRMV0` |
| **1** | CORE 1 — dono agente | `CRMV1` |
| **2** | **O slot** — card em 3 faixas, tags fora | `CRMV2` |
| **3** | CORE 2 — barramento + realtime | `CRMV3` |
| **4** | CORE 4 — próxima ação no slot | `CRMV4` |
| **5** | CORE 3 — score com evidência | `CRMV5` |
| **6** | O dossiê — Sheet substitui o dialog | `CRMV6` |
| **7** | CORE 5 — esfriando + reativação | `CRMV7` |
| **8** | A ponte (§3.1) | `CRMV8` |

**Por que a Wave 2 vem antes das features:** criar o lugar antes de ter o que pôr nele. Se a
UI vier depois, cada feature vira "mais um bloco" e ninguém consegue tirar.

**Wave 0 é obrigatória e incremental.** `scripts/seed-crm-vivo.ts` nasce cobrindo o que o
schema de hoje permite e **ganha um bloco a cada wave** que adiciona coluna. Idempotente e
re-executável desde o primeiro dia. Cobertura mínima ao fim: 1 lead de dono humano · 1 de
dono agente · 1 aguardando decisão · 1 esfriando · 1 com score alto · 1 com score baixo ·
1 sem dono · 1 com valor nulo · 1 com título de 120 caracteres · 1 com 8 tags.
Segue o padrão de `scripts/seed-e2e-kanban.ts` e **não colide** com os títulos dele
(o e2e `kanban-owner-filter.spec.ts` depende deles).

---

## 7. Protocolo de verificação visual — o ponto mais importante deste briefing

**Não se aceita teste de fumaça, asserção de API, checagem de banco ou "compilou" como prova.**
A evidência é **a tela**, na perspectiva de um usuário real, via Playwright, com screenshot.
**Um teste que passa sem ninguém ter visto a tela não é teste.**

- Toda verificação navega **pela UI como usuário**: login real, clique, arrasto, digitação. Nada de bater na rota interna ou chamar o endpoint.
- Todo cenário produz **screenshot nomeado** `wave-<n>-<cenario>.png` em `evidence/`, referenciado no handoff.
- Cenário de realtime roda com **duas abas/contextos**: a mudança aparece na segunda **sem reload**. **Precisou de F5 = falhou.**
- Bug encontrado: **registre no handoff ANTES de corrigir** (sintoma, causa raiz, correção) e re-teste o cenário do zero.
- Rode os e2e existentes a cada wave — em especial `kanban-owner-filter.spec.ts`, `rbac-roles.spec.ts` e `risk-radar.spec.ts`. **Regressão silenciosa é falha.**
- **Prova ao longo, não no fim.** Cada avanço tangível é mostrado na tela quando acontece.

### Cenários, wave a wave

**Wave 1 — dono agente**
1. Kanban → criar lead → atribuir a um agente. Card mostra avatar **vazado com anel** + tooltip nome·versão. *Falha se aparecer "Sem responsável" ou emoji.*
2. Filtro "Responsável" lista agentes junto dos humanos; filtrar por agente devolve só os dele.
3. Transferir agente→humano e humano→agente. Ambos persistem após reload.
4. `viewer` **não** consegue reatribuir (RBAC intacto).

**Wave 2 — o slot**
5. Board com o seed: nenhum card ultrapassa a altura definida; nenhum tem mais de 5 elementos.
6. Densidade **Compacta** — todos legíveis e alinhados.
7. Lead com título de 120 caracteres, valor nulo e 8 tags **não** quebra o layout.
8. Screenshot do board inteiro antes/depois lado a lado no handoff.

**Wave 3 — barramento + realtime**
9. **Duas abas.** Aba A move card de estágio → aba B o card se move **e** a atividade aparece na timeline, **sem reload**.
10. Ação do agente → atividade nasce com ator = agente e `reason` visível.
11. Uma decisão de **não** enviar (`before_send_traces`) aparece na timeline. *Silêncio do agente também é evento.*
12. O card **pulsa uma vez** e para. *Falha se ficar animando.*

**Wave 4 — próxima ação**
13. Card com próxima ação mostra a linha do agente com os botões. **Aprovar** executa e gera atividade; **Ignorar** também gera atividade.
14. Lead sem próxima ação mostra o estado normal — **nunca** slot vazio ou "—".

**Wave 5 — score**
15. Card mostra medidor + número. Hover revela as **3 evidências**; clique leva ao momento da conversa.
16. Gravar score sem `reason` → **rejeitado pelo banco**. Prove com o erro.
17. Lead sem sinal suficiente **não** mostra score inventado.

**Wave 6 — dossiê**
18. Clicar no card abre o Sheet: cabeçalho → timeline → campos.
19. Timeline colapsa eventos consecutivos do mesmo ator; expandir mostra detalhes.
20. Editar campo salva e **aparece na timeline** com ator = humano.
21. Sheet aberto + ação do agente na outra aba → entra na timeline ao vivo.

**Wave 7 — esfriando**
22. Lead que estoura `expected_duration_hours` muda para **Esfriando** com borda `warning`, **sem reload**.
23. Aceitar reativação → agente envia → atividade registrada → estado volta ao normal e o card anda. **Ciclo inteiro numa gravação de tela.**
24. Precedência: esfriando **e** com próxima ação pendente mostra **só** "Aguardando você".

**Wave 8 — a ponte**
25. Agente move o lead no funil dele → card se move no Kanban, respeitando `agent_stage_hint`.
26. Pipeline com estágios customizados (nomes de clínica) mapeia corretamente.
27. **Sem regressão na inbox:** conversa, atribuição e handoff continuam funcionando.

### A DOENÇA ÚNICA — e o antídoto  *(descoberto em campo pelo `@QAVivo`)*

Todos os defeitos desta entrega — **os do produto e os do nosso próprio ferramental** —
tiveram a mesma forma e só mudaram de superfície:

| Superfície | Como se manifestou |
|---|---|
| `catch` em script de evidência | engolia o erro do locator e entregava um PNG que não provava nada |
| `UPDATE` no seed | engolia o erro `23514`, afetava 0 linhas e **reportava sucesso** |
| Menu de lote | não dizia o que **não** tinha — nem humanos, nem agentes |
| Contagem no relatório | `10/11` sem nomear o item que faltou; a falha some no número |
| Asserção de teste | aprovava exatamente o que deveria reprovar (menu segregado passava) |
| Comentário no código | afirmava *"agentes na MESMA lista"* com o separador na linha seguinte |
| Card no board | perdia o nome do dono e virava `? Agente` |
| `next_action` da IA | calculado, gravado e **nunca exibido a ninguém** |
| Evidência histórica | **destruível sem aviso** — o script sobrescrevia a única cópia do "antes" |
| Canal de realtime | `useBoard` **descartava** o `status`: canal que nunca assina é invisível ao app |
| Teste de LGPD | **mockava o RPC** — provava que a chamada acontece, não que funciona |
| Backfill da migration | só o caminho de **instalação limpa** era exercido; o de `update` quebrava |

**Todas são a mesma coisa: a falha existe e ninguém vê.**

E é **exatamente a doença que esta entrega existe para curar no produto** — *"nada morre por
falta de resposta, resolução, ou porque ninguém viu"*. Ela estava se reproduzindo **dentro do
nosso próprio ferramental** enquanto a caçávamos no CRM. Um time que constrói um sistema para
tornar o invisível visível estava, ele mesmo, produzindo invisibilidade em cinco superfícies
diferentes.


### As três formas mais caras — todas encontradas nesta entrega, todas anteriores a ela

1. **Cobertura que prova a chamada, não o efeito.** O teste do LGPD mockava o RPC. Resultado:
   a anonimização estava quebrada e havia um teste verde apontando para ela.
2. **Sinal de falha descartado.** `useRealtimeChannel` devolve `status`; `useBoard` joga fora.
   Um canal que nunca assina não gera erro, log nem pixel — e num recurso de tempo real
   **a ausência de evento é indistinguível de "nada aconteceu ainda"**.
3. **Caminho nunca exercido.** O backfill quebrava só no `update.sh` de quem **já tem** o banco —
   ou seja, exatamente no self-hoster que a doutrina de migrations existe para proteger.

**A pergunta que pega as três:** *"o que este teste aprovaria que eu reprovaria olhando?"*
Se a resposta não for "nada", o teste está frouxo.

**E a pergunta irmã, para código:** *"o que precisaria concordar para isto continuar certo?"*
Se a resposta for "duas coisas", já está errado — foi assim que nasceram as três duplicações
desta entrega (dois hooks para a mesma rota, a regra de dono em quatro escritores, o tipo
redigitado).

### A cadeia de diagnóstico — cada vermelho manda para um lugar diferente

*(do `@QAVivo`, ao investigar uma intermitência própria em vez de chamá-la de flaky)*

Um cenário de ponta a ponta esconde **três perguntas distintas**. Separe-as, e cada falha aponta
para uma área diferente:

| Nível | Pergunta | Vermelho significa |
|---|---|---|
| 1 | **A ação aconteceu?** | interação/foco — nada depois é conclusivo |
| 2 | **O evento chegou?** | canal, assinatura, publicação |
| 3 | **O visual mudou?** | o componente |

> Um teste com três níveis não é mais caro — é um teste que **não faz o time procurar no lugar
> errado**.

**E não conviva com deriva.** A intermitência vinha do card mudar de coluna a cada execução:
a correção não foi estabilizar o teste, foi **tornar o estado inicial determinístico**. É a
diferença entre consertar e tolerar.

### Vazamento pode ser COMPORTAMENTAL, não só visual

No negativo de outro tenant, não basta *"o dado alheio não aparece"*. O card da outra organização
**não pode nem reagir** a um evento da nossa: **um card que pulsa por evento alheio denuncia
assinatura mal filtrada mesmo sem exibir um byte**.

> Quase todo teste de isolamento verifica **conteúdo**. Poucos verificam **reação**.

### O sinal barato: **resposta constante é suspeita**

*(do `@MaestroConexoes`, ao descobrir que suas quatro medições batiam no middleware)*

> **Sistema real varia. Resposta idêntica em tentativas repetidas quase sempre quer dizer que
> você parou antes do sistema** — está batendo num intermediário: cache, proxy, middleware, mock.

**A ausência de ruído é o ruído.** E é um sinal **barato**: não exige entender o sistema, só
reparar que ele está calmo demais.

### Declare o ALCANCE junto do veredito

Toda aprovação ou reprovação diz **como** foi obtida:

- *"provado por leitura do código"*
- *"provado na conexão"*
- *"não provei — e aqui está quem prova barato"*

> **Aprovação sem alcance declarado é opinião com carimbo.** Vale para todos, inclusive para o
> regente.

### Três estados, não dois — e o verde que não vale

*(do `@QAVivo`, montando os cenários de tempo real)*

**INCONCLUSIVO é um veredito, e a maioria das suítes não o tem.** Antes de julgar o
comportamento, meça a **pré-condição**. Se ela falhou, o cenário sai **inconclusivo**, nunca
reprovado.

> Sem esse terceiro estado, pré-condição quebrada vira "falha da coisa sob teste" — e manda o
> implementer caçar animação quando o problema é **entrega**.

**VERDE VÁCUO não é verde.** *"O pulso para"* é trivialmente verdadeiro quando o pulso **nunca
começa**. Critério satisfeito por **ausência** em vez de por comportamento deve ser marcado
**vácuo**, não verde.

> **Verde vácuo é pior que vermelho: ele conta como cobertura.**

**Afirmação sobre o tempo exige medição no tempo.** *"Pulsa uma vez"* é claim sobre **série
temporal** — uma foto não distingue *"está pulsando agora"* de *"vai pulsar para sempre"*.
Amostrar em intervalo e **contar transições** é o único jeito; e a assinatura amostrada deve
incluir o que muda no modo de acessibilidade (`background`), senão o detector aprova o caminho
reduzido por não enxergá-lo.

### O grupo de controle — e a pergunta que cobre todas as armadilhas de contagem

*(do `@QAVivo`, depois de cair na própria armadilha uma hora após consertá-la)*

Um verde só vale se o instrumento estivesse medindo. **Antes de reportar que o filtro encontra,
prove que o filtro filtra:** rode o caso que deveria ESCONDER o item. Se ele não esconder, o
verde anterior não provava nada — provava que o filtro não aplicou.

> Testa-se o caso positivo e assume-se que o negativo se comporta. **Quase todo QA de software
> pula essa etapa.**

**A pergunta que generaliza as três armadilhas de contagem desta entrega** (esqueleto de tabela,
corrida de hidratação, contagem antes do filtro aplicar):

> ## *"Existe um estado intermediário que satisfaz esse contador sem satisfazer a afirmação?"*

Se existe, o contador está medindo a coisa errada. **Esperar "algo apareceu" é diferente de
esperar "o conteúdo certo apareceu".**

### Como se prova de verdade: **uma perna no código, outra no banco**

*(formulação do `@MaestroConexoes`, depois de refazer uma prova que ele mesmo tinha errado)*

| Prova | O que demonstra | O que **não** demonstra |
|---|---|---|
| Só o **código** (chamar a função, ver o objeto) | que a função devolve o que promete | que o banco aceita aquilo |
| Só o **SQL** (escrever à mão, ver o erro) | que o banco se defende | que o código produz aquele SQL |

**A doença mora no vão entre os dois.** Cada metade sozinha é um verde que não significa nada.

**A execução certa, que fecha o ciclo:** mesmo registro, `savepoint`, os dois lado a lado — o
caso errado sendo **rejeitado** e o caso que o código realmente produz sendo **aceito**, tudo
revertido no fim.

> Isso não prova só que está certo: prova que **a correção é a razão** de estar certo. É a
> diferença entre *"passou"* e *"passou por causa disto"*.

Corolário para revisão: **antes de reportar bloqueante, releia o arquivo no HEAD e cite a linha
lida.** Se a linha não bate com o comportamento provado, o snapshot é que está velho.

> ## O ANTÍDOTO: FAZER A COISA GRITAR
>
> Falhar alto em vez de degradar · listar o menu inteiro em vez de checar se "existe um" ·
> colar o placar no nome do item · contar os separadores em vez de confiar no comentário ·
> **contaminar de propósito para ver se o conserto reage**.
>
> Um artefato que afirma sucesso enquanto o efeito real falhou é pior que a falha crua:
> a falha crua alguém conserta; a falha silenciosa alguém aprova.

**Aplicação prática, obrigatória:** toda vez que você escrever uma verificação, pergunte
*"o que este teste aprovaria que eu reprovaria na mão?"*. Se a resposta não for "nada", o
teste está frouxo — e teste frouxo é a quinta superfície da mesma doença.

### Armadilhas de instrumentação — regras permanentes (descobertas em campo)

Estas custaram falhas reais nesta entrega. Valem para **todo** script de evidência.

1. **Não ancore em `getByRole('heading')` no board.** O card é `role='button'` (drag handle do
   dnd) e, pela regra ARIA de *children presentational*, o `h3` de dentro **perde** o papel de
   heading quando o dnd hidrata. Quem usa esse seletor funciona **por corrida**: resolve antes
   da hidratação e quebra depois, de forma intermitente. Âncora correta: **`[data-rfd-draggable-id]`**
   — atenção ao prefixo, é `rfd` (`@hello-pangea/dnd`), **não** `rbd`.
2. **`networkidle` não basta no board** — os cards montam depois. É possível ver **zero** cards
   num board com 11. Espere deterministicamente pelo primeiro card.
3. **Nunca use `sleep` fixo para contornar espera.** *"Sleep só transforma erro em
   intermitência."*
4. **`catch` em script de evidência nunca degrada para artefato pior.** Ou captura o alvo, ou
   **falha alto** dizendo qual locator não resolveu. Um PNG que existe e não prova nada é pior
   que nenhum PNG.
5. **Valide o retângulo do que capturou.** Card com `width < 200` ou `height < 80` não é card —
   o script deve falhar.
6. **Se o script disser "board vazio", olhe a tela antes de reportar.** Já aconteceu: o script
   viu zero cards, o board tinha 11.
7. **Nunca valide com pipe.** `pnpm typecheck | tail` faz o exit code virar o do `tail` — um
   vermelho passa como verde. Redirecione para arquivo e leia `$?`.
8. **Comentário não é prova de conformidade.** Já aconteceu de um comentário afirmar "agentes
   na MESMA lista" com o separador logo abaixo. O critério é o código e o pixel.

### Acessibilidade e a régua visual (toda wave que toca UI)
- `axe-core` sem violação nova.
- Teclado: card focável, botões de decisão alcançáveis, foco visível.
- **Teste do metro:** olhe o screenshot do board a um metro. Dá para dizer *quem é o dono* e *quais cards pedem atenção* sem ler? Se não, o design falhou — **reporte, não maquie**.

---

## 8. Checklist `sistema-vivo` — gate de toda peça

Carregue a skill `sistema-vivo` (`.claude/skills/sistema-vivo/`). Para **cada** peça nova,
responda **por escrito** no handoff:

1. **Quem me alimenta?** — aresta de entrada, fonte real (não do body).
2. **Quem eu alimento?** — aresta de saída. "Ninguém" = ilha → desilhe ou justifique.
3. **Que atividade/log eu emito?** — `event_log`, `audit()` de `lib/audit/`, ou `crm_lead_activities`.
4. **Onde eu apareço na tela?** — log só no banco é log morto.
5. **Qual meu mecanismo anti-morte?** — demanda aberta tem próximo passo garantido ou resolução registrada.
6. **Qual a continuidade IA↔humano?** — a IA entrega resumo contextual (não conversa crua); o humano deixa input estruturado para a IA retomar.
7. **Atualizei o mapa vivo?** — `docs/architecture/*.json` re-renderizado. Peça nova entra com **≥2 arestas**.

---

## 9. Não-negociáveis do repositório

- **Multi-tenant:** `organization_id` + RLS em **toda** tabela e coluna nova. Handler com service role filtra `organization_id` manualmente, de fonte confiável — **nunca do body**.
- **Migrations:** arquivo versionado em `supabase/migrations/` **+** apêndice idempotente no `supabase/baseline.sql` **+** linha no `MANIFEST.md`. Os três andam juntos. Idempotente, portável em psql puro (sem `BEGIN`/`COMMIT`, sem temp table), **backfill ANTES da constraint**. Nunca edite migration aplicada — forward-fix.
- **Trigger Postgres NUNCA faz HTTP.** Side effect é `event_log` + worker.
- **Idempotência** em POST de criação; `unique (organization_id, external_id)` + captura `23505`.
- **`getUser()`** no server, nunca `getSession()`.
- **LGPD:** nenhuma PII nova em log, `reason` ou `evidence`. Não crie caminho novo que vaze.
- **Realtime:** tabela nova que a UI observa entra na publicação — respeitando §3.5.
- **Zod** em todo input externo. **Sem `console.log`** merged.
- Wrappers `ok()`/`fail()` de `lib/api/wrappers.ts`. **`ok()` já embrulha em `{data}`** — não faça `ok({data: row})`.

---

## 10. Como o time opera

### Papéis
| Quem | Papel | Escreve em |
|---|---|---|
| **Assistente e Testes** | Orquestrador · **palavra final** | `HANDOFF-crm-vivo.md`, `BRIEFING-crm-vivo.md` |
| **@Arquiteto** | Contratos abertos, **uma wave à frente** | Nada de produção — decisões por mensagem |
| **@DevVivo** | Implementação da wave corrente | **Único** com escrita em código de produção |
| **@QAVivo** | Prova visual Playwright, specs, screenshots | `tests/`, `evidence/`, `scripts/seed-*` |

### Regras duras
1. **Um implementer por vez no worktree.** `@DevVivo` implementa; `@QAVivo` só escreve em `tests/`, `evidence/` e seeds. Se os dois precisarem do mesmo arquivo, **para e fala comigo.**
2. **Nenhuma wave avança sem prova na tela** aprovada por mim. Não é formalidade: eu olho o screenshot.
3. **Bug vai para o handoff ANTES da correção.** Corrigir calado é apagar evidência.
4. **Reporte quando começa, quando termina e quando trava** — `lina ask "@Assistente e Testes" "<status>" --intent status`.
5. **Travou? Traga o problema mastigado e um caminho.** Devolver problema cru é falha sua.
6. **Não amplie escopo.** Achou algo? Handoff, e segue.
7. **`git push` / merge / deploy: proibido sem autorização do Rafael.** Commit local por wave, sim.
8. **Não afirme "funciona" sem evidência observada.** Rodou, leu o output, viu a tela. Um staff engineer aprovaria? Se não, itera antes de mostrar.

### Definition of Done por wave
- [ ] `pnpm typecheck` e `pnpm lint` zerados (**sem `| tail`** — o pipe mascara o exit code)
- [ ] Testes unit/e2e relevantes existem e passam
- [ ] RLS testada se tocou tabela tenant-aware
- [ ] Migration versionada + apêndice no `baseline.sql` + linha no `MANIFEST.md`
- [ ] Checklist `sistema-vivo` (7 respostas) escrito no handoff
- [ ] **Grau ≥ 2:** toda peça tem entrada **e** saída. Nenhuma ilha.
- [ ] Nenhum campo calculado sem `reason`/`evidence` — **com constraint no banco**
- [ ] 100% das mutações de lead geram `crm_lead_activities` com `actor_kind`. **Zero escrita anônima.**
- [ ] Realtime provado com **duas abas, sem F5**
- [ ] Régua visual da §5 inteira, inclusive densidade Compacta e teste do metro
- [ ] E2E existentes verdes · `axe` sem violação nova
- [ ] `HANDOFF-crm-vivo.md` atualizado: screenshots, bugs, **o que ficou para trás**, débito
- [ ] Commit atômico da wave

---

## 11. O handoff — `HANDOFF-crm-vivo.md`

Atualizado ao fim de **cada** wave, com dia e hora. **Nunca reescreva o histórico: só acrescente.**

```markdown
## Wave N — <nome>  ·  <data/hora>  ·  <status>

### O que entrou
- <mudança> — arquivos tocados, migration, componente

### Checklist sistema-vivo (as 7 respostas)
1. Quem me alimenta: … 2. Quem eu alimento: … 3. Log que emito: …
4. Onde apareço na tela: … 5. Anti-morte: … 6. Continuidade IA↔humano: …
7. Mapa vivo atualizado: sim/não

### Verificação visual
| # | Cenário | Resultado | Screenshot |
|---|---|---|---|

### Bugs encontrados
| Sintoma | Causa raiz | Correção | Re-testado |
|---|---|---|---|

### O que ficou para trás (e por quê)
- <item> — motivo, e o que precisa para ser retomado

### Débito / risco introduzido
- <item> — onde dói se não for pago

### Decisões tomadas no caminho
- <decisão> — alternativa descartada e o porquê
```

**"O que ficou para trás" é obrigatório e não pode ficar vazio por conveniência.**
Simplificou, cortou caso de borda, adiou teste? Está registrado ali.
**O que não está no handoff, não aconteceu.**

---

**Feature que só cabe no card inflando o card não está pronta.
Teste que passou sem ninguém ver a tela não é teste.**

---

## §7.1 — Duas leis que nasceram medindo (adendo à doutrina)

### Lei: espere por CONTEÚDO, nunca por relógio

Derivada pelo `@QAVivo` depois de a mesma armadilha trocar de roupa **quatro vezes num dia**:
esqueleto de tabela, hidratação do board, contagem lida antes do filtro, e busca disparada por
clique. Em todos, o leitor do teste encontrou um estado intermediário e o tratou como final.

`waitForTimeout` é uma aposta de que a máquina estará pronta em N ms. Ela ganha na sua máquina e
perde na do CI — e quando perde, o vermelho acusa a feature em vez do teste.

> **Pergunta-teste, que é melhor que a original:**
> *"Existe um estado intermediário que satisfaz meu leitor sem satisfazer a afirmação?"*
>
> Se existe, o leitor está frouxo. Espere pelo texto/elemento que **só existe quando a afirmação é
> verdadeira**.

Corolário provado nesta rodada: **pixel prova que algo apareceu; texto prova o quê.** Uma asserção
de "renderizou N itens" aprovaria uma timeline despejando uuid no rosto do usuário.

### Lei: REPROVADO e BLOQUEADO são vermelhos diferentes

O cenário 12 (o card pulsa uma vez e para) estava marcado *reprovado*. Fui ao código: **zero**
ocorrência de `pulse`/`animate`/`keyframes` no kanban, zero de "acabou de chegar", e zero de
`prefers-reduced-motion` — que o §5 exige. Não havia defeito de pulso: **não havia pulso**.

| Vermelho | Significa | Quem age |
|---|---|---|
| **Reprovado** | a peça existe e está errada | quem construiu |
| **Bloqueado** | a peça não existe ainda | quem planeja (eu) |

Confundir os dois manda alguém caçar fantasma num commit correto. **Todo vermelho declara qual dos
dois é**, e "bloqueado" nomeia o bloco que falta.

> Isto foi a **terceira** subespecificação minha na Wave 3 — primeiro ninguém ficou com a
> *exibição*, depois nomeei uma superfície onde havia duas, agora um cenário testava peça nunca
> pedida. As três têm a mesma raiz: **eu escrevi "o único lugar que faz X" de memória.** Regra
> nova e sem exceção: esse número sai de `grep`, e vai no despacho junto do alcance.

## §7.2 — Mais duas leis, ambas nascidas de erro meu

### Lei: código e briefing vencem a minha mensagem

Despachei ao `@QAVivo` o critério de ator **invertido** — "disco preenchido = agente" — quando eu
mesmo, uma hora antes, tinha conferido o `OwnerBadge` e escrito a versão **correta** (agente =
vazado com anel). Não foi desconhecimento: foi erro de transcrição de um fato **já verificado**.

O QA implementou pelo código e me reportou o conflito, em vez de obedecer. Se tivesse obedecido, a
regra invertida entraria num teste que o time inteiro herdaria como verdade.

> **Quando o despacho conflitar com o código ou com este briefing, implemente pelo código/briefing
> e reporte o conflito.** Não peça permissão para isso.
>
> Ordem errada obedecida vira lei. Ordem errada contestada vira correção.

### Lei: asserção negativa anda em par com prova de conteúdo

O `@QAVivo` encontrou, **dentro do próprio teste que escreveu para evitar isso**, um verde vácuo:
os critérios *"nenhum uuid visível"* e *"nenhum rótulo cru"* passavam com a **tela vazia** — porque
asserção negativa é trivialmente verdadeira na ausência. Ele tinha pegado o painel oculto (a página
tem dois; o primeiro é invisível).

A cura dele: um critério `10.pre` que exige conteúdo, e sem conteúdo os demais são
**inconclusivos**, não verdes.

> **Toda asserção "X não aparece" anda em par com "e havia conteúdo onde X poderia aparecer".**
> Sem o par, ausência de tela vira aprovação.

Terceira aparição da família *verde vácuo* no dia — e a primeira nascida dentro de um teste
escrito de propósito contra ela. Ninguém está imune por saber da regra.

## §7.3 — Protocolo de revisão: forward-fix, nunca "segura o commit"

Três vezes num dia, mensagens cruzaram: revisei código que já estava no histórico, e o
`@QAVivo` mediu tela que mudou entre duas rodadas dele. Não é acidente de nenhum dos três — é
**propriedade do canal**. Pedir *"não commite ainda"* tenta impor sincronia onde não há.

> **Ninguém segura commit esperando revisão.** Commite quando estiver pronto; a revisão é do
> **commit**, e correção vira **commit novo em cima** — nunca pedido de desfazer o anterior.

Isto não é invenção: é a **doutrina de migrations deste repo aplicada a commits**. Lá já está
escrito que migration aplicada não se edita — corrige-se com uma *forward-fix*. Mesma forma:
estado já publicado não se reescreve, se corrige adiante. Funciona **porque aceita a assincronia
em vez de brigar com ela**.

Efeito colateral que fecha outro buraco: some a tentação do commit gordo. O `1e4511d` engoliu três
blocos justamente porque estavam **presos esperando liberação**. Se não há por que segurar, não há
por que empilhar.

**Corolário para quem mede:** ao reportar, declare o commit contra o qual mediu. Número sem HEAD é
número sobre alvo em movimento — foi o que fez o `@QAVivo` acertar ao tratar a própria medição como
*sinal*, não veredito.

## §7.4 — Três leis que vieram do QA, medindo contra mim

### Lei: texto extraído responde "o que está escrito", nunca "como está desenhado"

Reportei `"Mudou de estágio· Você/time"` como defeito cosmético, lendo `innerText`. O `@QAVivo` foi
à **imagem**: o espaço existe, vem de margem CSS, e `innerText` não representa isso. Meu defeito
era artefato da minha instrumentação.

Terceira medida frouxa minha no mesmo dia — relógio em vez de conteúdo, `<li>` sem escopo, e agora
DOM confundido com olho. O padrão é único: **eu lia o DOM e afirmava sobre a tela.**

> Afirmação sobre **aparência** (espaço, alinhamento, tamanho, cor) não se faz por `innerText`. Ou
> mede no *computed style*, ou olha o print.

### Lei: medição vira REGISTRO, não veredito do momento

Formulação do `@QAVivo`, melhor que a minha:

> *"A lição não é 'desconfie do regente'; é que **medição registrada protege contra erro de
> transcrição de qualquer um**, inclusive o meu."*

Ele só pegou meu critério de ator invertido porque tinha **medido a geometria na Wave 1 e
guardado** — 24×24, peso 600, agente vazado com anel. Sem esse registro, teria obedecido de boa-fé,
e não por falha dele. O que foi medido na Wave 1 defendeu a Wave 3 de um erro meu.

### E o diagnóstico mais afiado do dia, nas palavras dele

Sobre o dado que parava na borda da API e mesmo assim compilava verde:

> *"Quem deixou de ver foi o **compilador**, que era justamente o vigia."*

O `?` do campo opcional calou o único vigia automático que existia ali. É a mesma família do dia
inteiro — *a falha existe e ninguém vê* — mas desta vez o cego era a ferramenta contratada para
enxergar.

## §7.5 — A lei mais forte do dia: prove a testemunha quebrando o que ela vigia

Perguntei ao `@DevVivo` a pergunta-antídoto de sempre — *"o que este teste aprovaria que eu
reprovaria olhando?"*. Ele não respondeu com argumento. **Sabotou o emissor no `moveLeadHandler`,
rodou o invariante, viu reprovar** (`expected +0 to be 1`), restaurou e conferiu o diff limpo.

> **Um teste que nunca foi visto falhando não é testemunha — é decoração.** Ele passa, mas por
> motivo desconhecido.
>
> A única prova de que um teste enxerga é **quebrar o que ele vigia e exigir que ele grite.**

Isso vale sempre que a peça sob teste tem uma **testemunha única**. O `moveLeadHandler` engole a
falha do emissor de propósito (a timeline não pode derrubar a operação que descreve) — logo não há
nenhum outro sinal, e um invariante silencioso ali cega o sistema inteiro.

**As duas direções, cobertas por duas pessoas sem combinar:** ele viu o invariante **falhar** com
o emissor quebrado; eu rodei a suíte no mesmo `8b0a9a5` e vi **passar** com ele inteiro (48
arquivos · 323 testes · install e update do baseline). O par também prova que a restauração foi
completa — sabotagem remanescente teria aparecido na minha rodada.

### Corolário achado no caminho

O `sqlLiteral` do dublê não tratava `jsonb`: `evidence` e `payload` virariam a string
`'[object Object]'` no banco, o dublê aceitaria e o teste **passaria**. Mesma doença do dia — *a
falha existe e ninguém vê* — agora na camada de serialização, e encontrada porque alguém foi olhar
sem ter sido mandado.

## §7.6 — Sinal adjacente não é prova (e o falso negativo custa mais)

O `@QAVivo` ia reportar *"o socket abre como anônimo"* depois de ler `apikey=anon` na URL do
WebSocket. Parou: **`apikey` é sempre a chave pública, por desenho do Supabase** — o valor seria
idêntico com a hipótese verdadeira ou falsa. Quem carrega a identidade é o `access_token` dentro
do **quadro de assinatura**.

> **Antes de usar um sinal como prova, pergunte: *"este valor poderia ser exatamente este mesmo se
> a minha hipótese fosse FALSA?"*** Se poderia, ele não distingue nada — é sinal adjacente, não
> evidência.

Corrigir a **pergunta** foi o que tornou possível o experimento que fechou o caso: A/B na mesma
página, mesma sessão, **mesmo socket**, dois canais — um pelo hook curado (com token), outro
abrindo `.channel()` direto (sem token). **Uma variável: o caminho do código.** Com a pergunta
errada, os dois nem eram comparáveis.

### O falso negativo é o erro caro deste time

Na primeira rodada o canal **nem chegou a assinar** — a tabela vive atrás de uma aba, e o hook só
assina quando ela abre. Reportar *"não confirmado"* ali teria feito o regente **arquivar a suspeita
como infundada**, e os quatro canais mortos ficariam no código com carimbo falso de *verificado*.

> **Falso positivo vira retrabalho; falso negativo vira caso encerrado por engano.** Quando a
> medição não confirma, a primeira pergunta é *"eu medi a coisa certa?"* — não *"então não
> existe"*.

### Corolário sobre escolher alvo

Sugeri o alvo mais **barato** (`useAlertsRealtime`). O QA recusou com argumento melhor: aquele hook
escuta **broadcast**, não `postgres_changes` — e broadcast pode chegar sem identidade, então
qualquer resultado seria inconclusivo. Escolheu um alvo com dado real e filtro por linha.

> **Um caso conclusivo vale mais que um barato.** Barato que não distingue hipóteses custa o
> tempo inteiro e não devolve informação.

## §7.7 — Duas leis de disciplina, vindas de um falso alarme

### Lei: conferir antes de escalar

O `@DevVivo` reportou **disco cheio, 211 MB livres**, com proposta de apagar 8,2 GB de arquivos do
Rafael. Medida real antes de repassar:

| | |
|---|---|
| `df /System/Volumes/Data` | 460 GB · **19 GB livres** · 96% |
| `npm run test:unit` na hora | **877/877, exit 0** |

O erro: `df /` no macOS mostra o volume de **sistema selado**, não o de dados. O `ENOSPC` era
**real mas transitório** — a 96%, um pico de escrita temporária estoura e o espaço volta.

> **Sintoma verdadeiro com causa raiz falsa é a combinação mais perigosa**, porque o sintoma real
> empresta credibilidade ao diagnóstico errado.
>
> A regra que o regente cobra do time vale para o regente: **repassar pânico como fato é a versão
> gerencial de aprovar sem olhar.** Escalar ao humano é ação com custo — merece a mesma verificação
> que qualquer outra afirmação.

**O que o `@DevVivo` fez certo, e não se apaga pelo diagnóstico errado:** não apagou nada, separou
o que era de quem, marcou o build **em uso** pelo servidor de testes, e escalou em vez de decidir.
Ação irreversível em ambiente compartilhado é gate humano; ele parou no lugar certo.

### Lei: nunca encadeie a ação com a verificação

Ele commitou dentro do mesmo `teste && commit`, e o commit entrou com a suíte vermelha.

> `teste && commit` executa o commit **antes de você ler o resultado** — você delega ao shell uma
> decisão que era sua, de tomar **depois de olhar**.
>
> É irmão do `cmd | tail`, que já deu falso verde nesta entrega: em ambos, **o encadeamento
> esconde exatamente o resultado que você precisava ver.**
>
> Rode. **Leia.** Depois commite. Dois comandos.

## §7.8 — "Pulsar uma vez" não é "mudar uma vez" (o critério que o QA corrigiu no regente)

Despachei o critério do pulso como *"conte transições numa janela; ficar animando reprova"*. Está
**errado**, e do jeito pior: uma transição suave amostrada a cada 150ms produz vários estados
intermediários enquanto a cor interpola. **Quanto melhor a animação, mais passos ela mostra** — o
limite punia a implementação caprichada e premiaria uma animação dura.

A formulação certa, do `@QAVivo`:

> **"Pulsar UMA vez" não é "mudar uma vez".** O que define *uma vez* é o **episódio** — quantas
> vezes o elemento saiu do repouso — mais a exigência de **assentar** ao fim.
>
> `episódios === 1` (saiu do repouso uma única vez) · `assentou` (as últimas amostras são iguais
> ao repouso).
>
> **Loop reprova por não assentar, não por contar muitos passos.** É a distinção certa.

Regra geral que se extrai: **conte eventos do fenômeno, não amostras do instrumento.** Métrica
presa à taxa de amostragem mede a régua, não a coisa.

### E a trava de acessibilidade que ele pôs sem eu pedir

O critério de `prefers-reduced-motion` tem duas pernas — *(a) não animou* e *(b) o estado continua
legível por outro meio* — e **só conta quando o pulso existe**; sem pulso, volta sozinho para
**bloqueado** em vez de aprovar.

Sozinha, a perna (a) é trivialmente verdadeira quando não há animação nenhuma. Seria verde vácuo
outra vez — desta vez **vestido de acessibilidade**, onde é mais difícil de enxergar, porque a
ausência de movimento é o resultado esperado.

## §7.9 — Duas leis sobre o instrumento (a última fronteira do verde vácuo)

### Lei: dois instrumentos discordando é bug de instrumento, nunca achado

O `@QAVivo` amostrava o card a cada 150ms para medir uma animação de **320ms** — mas cada amostra
custa uma ida e volta ao navegador, então o intervalo **efetivo** passava dos 320ms. **Ele piscava
mais devagar que a coisa que queria ver.**

O que denunciou não foi o produto: foi uma **contradição interna na mesma rodada** — um critério
dizia *"4 inícios de animação"* e outro dizia *"0 episódios"*, mesmo card, mesmo instante.

> **Dois instrumentos discordando sobre o MESMO fato no MESMO instante é bug de instrumento —
> nunca achado sobre o produto.**
>
> E o desempate não é por preferência: **vence o instrumento mais próximo do fenômeno.** Evento
> nativo (`animationstart`) bate amostragem, sempre. Amostrar é reconstruir o fenômeno a partir de
> fotos; escutar o evento é perguntar a ele.

Corolário prático: **toda métrica presa a um intervalo de amostragem precisa declarar o intervalo
do fenômeno que mede.** Se o fenômeno é mais rápido que a régua, a régua inventa o resultado.

### Lei: nomeie o que o seu número NÃO é

O QA registrou que *"6 inícios de animação"* **não** significa *"6 piscadas na tela"* — uma única
animação dispara mais de um `animationstart` (propriedades animadas em paralelo, re-render do
elemento). Por isso os critérios são `>=1`, `>=2` e *"nenhum início tardio"*, e **não**
*"exatamente 1"*.

> **Nomear o que a métrica NÃO mede vale tanto quanto nomear o que ela mede.** Sem isso, alguém lê
> o número ao pé da letra daqui a três meses e constrói uma decisão em cima de uma leitura que o
> autor sabia ser falsa.

### E a disciplina de despacho que fecha o ciclo

Antes de mandar alguém caçar o vermelho restante (`12.c`, a aba que age também pulsa), **duas
hipóteses foram eliminadas no código**: a rota de move faz **um único** `UPDATE`, e há **uma
única** assinatura na página. E o despacho ficou **retido** por uma pergunta de fato — *como
exatamente a aba agiu?* —, porque a resposta decide se é **defeito do produto** ou **artefato do
teste**.

> Mandar alguém caçar defeito que talvez não exista é o custo do falso positivo. **Eliminar
> hipóteses antes de despachar é trabalho do regente, não do executor.**

## §7.10 — A sonda também suja, e a pior sujeira é a que foi feita para ser vista

Achado do `@MaestroConexoes` sobre a sonda do cenário 11: ela chamava o emissor de produção
(decisão certa) e **deixava a linha para sempre** — num lead real que três sessões usam, dizendo
*"Não enviei: limite de ritmo atingido"* para um envio que nunca foi tentado.

> Uma sonda que empurra `position_in_stage` suja **invisivelmente**. Uma sonda cujo objetivo é
> **renderizar** suja **visivelmente por construção**: o rastro dela aparece em qualquer print
> futuro daquela tela, provando outra coisa qualquer.

E o agravante: o regente havia **escrito** *"zero `send_vetoed` neste banco"* — e a própria sonda
mudou o fato afirmado. Quem contou depois foi outro.

> **Toda sonda que ESCREVE declara como desfaz, no mesmo arquivo.** O gancho normalmente já
> existe: aqui o `traceId` era único por execução e virou a cláusula de limpeza. Se não houver
> gancho exato, a sonda não está pronta.

### Corolário: dado do meu banco não é dado

A sonda cravava o UUID do tenant. Só existe **neste** banco, e o projeto é **aberto** — um clone
receberia *"sem lead aberto"* sem entender por quê. A doutrina de migrations já proíbe (*"não
hardcode IDs do seu tenant"*), e o motivo vale fora dela.

> **Sonda que depende de dado específico do meu banco não é sonda — é anotação pessoal.** A fonte
> certa é o que o seed gera.

### E a forma final do verde vácuo: o check que RELATA e não DECIDE

A sonda calculava `comMotivo`, **imprimia**, e decidia a saída sem ele. Podia dizer *"motivo
legível: NÃO"* e sair com código **zero**.

> Não é teste que falta — é teste que **parece cobrir**. Todo valor calculado numa verificação ou
> entra na condição de saída, ou vira comentário. **Ficar no meio é enfeite que passa por
> cobertura.**

Registrado sem desconto: este defeito foi escrito pelo regente **depois** de passar o dia cobrando
exatamente isto dos outros. Conhecer a regra não imuniza — o que protege é alguém revisando.

## §7.11 — Prova commitada com dependência solta (a oitava roupa)

Achado do `@MaestroConexoes`: **cinco sondas já commitadas** importavam `tests/qa-helpers.ts` —
que **não estava no repositório**. `git ls-files` não o conhecia.

As provas estavam no histórico e **nenhuma rodava** para quem fizesse checkout: quebrariam no
`import`, antes de qualquer medição. E o `evidence/` também estava fora — o handoff apontava para
imagens que só existiam numa máquina.

> **A regra do `§7.3` não bastaria aqui.** "Declare o commit" foi cumprido: o commit existia, e
> mesmo assim não reproduzia — porque a **dependência** ficou fora.
>
> **A regra ganha um passo: além de declarar o commit, confira que o que a prova IMPORTA está
> nele.** Prova commitada com dependência solta dá a mesma falsa segurança de uma documentação
> apontando para arquivo que não existe.

**Como se confere de verdade** (não basta `git add`): `git archive HEAD tests/ | tar -x -C tmp` e
olhar o que saiu. A pergunta não é *"eu commitei?"* — é *"o que o git entrega contém tudo o que a
prova precisa?"*.

Critério de escopo usado: versionar o **aparato** (obrigatório — um arquivo destravou cinco
sondas) e as **imagens que o handoff cita** (~450 KB), não o `evidence/` inteiro (6,7 MB). Um
documento que aponta para caminho inexistente é afirmação sem lastro; o resto é arquivo morto.

## §7.12 — O alvo que você MUTA e o que você OBSERVA têm que ser o mesmo

Confissão do `@DevVivo`, e é a mais cara do dia:

> *"Minhas 7 provas anteriores davam 'não mudou' porque eu mutava o lead por UUID e fotografava um
> card achado por TEXTO — eram leads diferentes. **O instrumento mentia, não o código.**"*

Sete rodadas afirmando que o produto estava quebrado, e o quebrado era a régua. **É o pior tipo
de falso negativo**: teria levado alguém a reescrever código que funcionava.

> **O alvo que você muta e o alvo que você observa têm que ser a MESMA entidade, identificada do
> MESMO jeito.** Mutar por `id` e observar por texto são dois seletores cuja equivalência você
> está **supondo**.

### E essa suposição é a forma de quase todos os erros da wave

| supus equivalentes | e não eram |
|---|---|
| `id` do lead × versão da linha (`updated_at`) | o trigger bumpa a versão: o 2º evento chega com outra |
| nome da animação × animação visível | o nome é idêntico numa versão que não desenha nada |
| classe presente × animação reiniciada | a classe fica; a animação só recomeça se o nó for novo |
| `run_ids` × ids de `ai_agent_runs` | guardava id de `llm_calls` — outra tabela |
| tipo declarado no `TimelineItem` × coluna pedida no `SELECT` | a lista ficou para trás, e o opcional calou o compilador |

**Sempre a mesma forma:** dois identificadores tratados como o mesmo, sem nada verificando. É a
versão "de identidade" da doença central da entrega — *a falha existe e ninguém vê* —, e a pergunta
que a pega é a do `§7.6`: *"este sinal seria idêntico se minha hipótese fosse falsa?"*.

## §7.13 — Mecanize. Não prometa. (a lição que fecha a wave)

Três terminais chegaram à mesma conclusão por caminhos independentes, e ela é o resumo da
sessão inteira.

**A prova de que disciplina não basta** é o próprio regente: escreveu a lei do alvo em movimento
(`§7.3`), cobrou dela o time inteiro — e **caiu nela duas vezes**, medindo contra árvore suja.
Depois enunciou o critério da evidência citada e **vazou minutos depois**, na mesma leva em que o
aplicou: seis referências continuaram apontando para o vazio. E, uma hora após impor *"não
encadeie a ação com a verificação"*, commitou no mesmo bloco em que rodou os testes.

> Conhecer a regra, ter **escrito** a regra e ter **cobrado** a regra não impediram nenhuma das
> três quebras. **Isso não é falha de caráter — é limite de memória sob pressão. E a resposta para
> limite de memória é ARTEFATO, não promessa.**

### O que virou artefato nesta wave

| lei | como deixou de depender de disciplina |
|---|---|
| vocabulário e colunas têm que concordar | `Record` exaustivo + `satisfies` — **não compila** se divergir |
| a prova declara contra o que mediu | `carimbar()` imprime HEAD + sujeira das dependências **declaradas**, e marca o print `-ARVORE-SUJA` |
| documento não aponta para o vazio | teste que lê os docs e **falha nomeando** a imagem fora do `git ls-files` |
| o lastro da IA existe de verdade | constraint no banco + invariante que foi **visto falhando** com o emissor sabotado |

**O padrão comum:** cada uma **decide**, nenhuma apenas **relata**. Valor calculado que só é
impresso é enfeite que passa por cobertura — foi assim que uma sonda desta wave podia dizer
*"motivo legível: NÃO"* e sair com código zero.

> E o teste do artefato é o mesmo do resto: **ele já pegou algo real?** O `carimbar()` pegou na
> primeira execução. O check de evidência pegou seis. Artefato que nunca acusou nada ainda não
> provou que enxerga.

## §7.14 — Critério antes da medição, e o número que mede o laptop

O `@Arquiteto` recusou revisar a janela do `12.c` com os arquivos modificados no disco — *"qualquer
parecer meu seria parecer sobre um estado que ninguém reproduz"* — e, em vez de esperar parado,
**fixou o critério antes de existir número**.

> **Critério combinado antes da medição faz o resultado decidir sozinho.** Critério escolhido
> depois vira opinião a posteriori, e aí quem discute ganha, não quem mediu.

### E a falsificação aplicada ao AMBIENTE, não ao sinal

A pergunta do `§7.6` — *"este valor seria idêntico se minha hipótese fosse falsa?"* — normalmente
se aplica ao sinal. Ele apontou para o outro lado:

> *"Sim, se medido só no seu laptop. Máquina rápida com banco vazio dá folga em qualquer janela e
> não discrimina nada."*

**Um número medido só no ambiente confortável mede o ambiente, não o sistema.** E este produto é
vendido para rodar em **VPS modesta** — uma medição sem rodada degradada (banco com carga, rede
estrangulada) produz um verde sobre um ambiente que nenhum cliente tem.

Corolário para toda medida de tempo: **olhe o máximo e o p99, nunca a média.** A média esconde
exatamente o caso que quebra.

### O atalho que dissolve a discussão

Ele fechou com a observação que reordena tudo: se o que entrar for o **vínculo ao ciclo de vida**,
a disputa "4s contra 1,5s" **desaparece** — o tempo vira só rede de segurança para mutação que
nunca assenta, e o valor exato deixa de importar para a correção.

> **A primeira pergunta não é qual número, é qual DESENHO.** Discutir a constante antes de decidir
> a arquitetura é otimizar um parâmetro que talvez não precise existir.

## §7.15 — "Eliminada" e "não-medida" não são a mesma coisa

O regente registrou no handoff três hipóteses como **eliminadas**. O `@DevVivo` mediu e mostrou que
uma delas não estava: *"a rota faz um único `UPDATE`"* era um **fato verdadeiro** do qual se tirou
a **conclusão falsa** de que havia um evento — o segundo nasce do **trigger, depois** da rota.

> **Hipótese sem registro algum, alguém ainda investiga. Hipótese marcada como eliminada, ninguém
> reabre.** Por isso escrever "eliminada" no lugar de "não-medida" é pior que não escrever nada:
> fecha a porta com a chave do lado de fora.

**Como distinguir, na hora de escrever:** *eliminada* exige que a medição contradiga a hipótese.
Verificar um fato adjacente e **inferir** dali não elimina — descreve. No registro, a diferença
cabe numa palavra: *"medi X e o resultado foi Y"* versus *"vi X, então suponho Y"*.

Vale para o corolário do `§7.6`: a pergunta *"este sinal seria idêntico se minha hipótese fosse
falsa?"* também se aplica ao que se declara **descartado**.

## §7.16 — Observação x invariante (quando o carimbo é obrigatório, e quando é desperdício)

Distinção do `@Arquiteto`, e ela impede que a regra do carimbo vire ruído:

| | o que é | envelhece? | precisa de carimbo? |
|---|---|---|---|
| **Observação** | afirmação sobre um **instante** — *"`JANELA_MS` vale 4000"*, *"a rota chama o emissor"* | sim, às vezes em minutos | **sim, sempre** |
| **Invariante** | afirmação sobre o **desenho** — vale para qualquer versão que o implemente | não | não |

> **Instantes não se acumulam em verdade.** Por isso, com o arquivo em movimento, ele **recusou
> reler**: outra leitura só produziria outra divergência para explicar depois.

**Exemplo real desta wave, e é o que tornou a distinção necessária:** o regente leu
`JANELA_MS = 2_000` com a marca sobrevivendo; o `@Arquiteto` leu `4_000` com consumo único.
Nenhum dos dois leu errado — o arquivo mudou entre as leituras. **Duas observações verdadeiras e
incompatíveis.**

E as duas armadilhas que ele mandou eram **invariantes**, por isso valiam sem carimbo de conteúdo:

- *"ler a marca não pode destruí-la"* — vale nos **dois** desenhos, porque a causa raiz ("uma ação
  minha gera N eventos") não depende de qual deles entrou. **Obrigatória.**
- *"mutações sobrepostas no mesmo lead precisam de contador"* — vale **só** no ciclo de vida; com
  temporizador puro, some.

> Alerta prévio **não substitui revisão** — é anterior ao commit por construção. O carimbo que
> acompanha um alerta serve para dizer *"isto é aviso, não parecer"*.

## §7.17 — Simulação mental herda as premissas de quem simula

O `@Arquiteto` alertou que **mutações sobrepostas no mesmo card** precisavam de contador. O regente
**simulou a linha do tempo, concluiu que a sobrescrita bastava e dispensou o contador** — pedindo
só um comentário. O `@DevVivo` foi verificar e a armadilha **era real**; corrigiu com o contador.

**Onde a simulação falhou:** ela usou `A` assentando em 300 ms e `B` em 500 ms. Com esses números a
sobrescrita realmente basta. Ela deixa de bastar **quando o handler demora** — `A` em 300, `B` em
2600, e um evento de `B` em 2000 já encontra a marca vencida.

> As premissas de tempo confortáveis foram usadas na análise **imediatamente seguinte** àquela em
> que se aceitou, do próprio `@Arquiteto`, que o handler pode ser lento numa VPS modesta.

**É o erro do "medido no meu laptop" (`§7.14`) aplicado a uma simulação mental — onde é mais fácil
de cometer, porque não se percebe que se escolheu um número.** Numa medição real o ambiente é
visível; numa simulação, ele é implícito e otimista por padrão.

> **Ao simular, declare os tempos como parâmetro e rode o caso lento.** Se a conclusão muda entre
> o caso rápido e o lento, a simulação não decidiu nada — apenas descreveu o caso confortável.

E a mesma família apareceu no instrumento do `@DevVivo`: a sonda sorteava o alvo com `limit(1)` sem
`order`, e quando calhava a coluna à direita o card nascia **fora da viewport** — o arrasto por
teclado não acontecia e ela morria no `waitForResponse`. Duas execuções perdidas. É o `position`
empatado que derrubou a sonda do regente, em outra roupa: **alvo sorteado é premissa escondida.**

## §7.18 — Carimbo na MENSAGEM, não só na sonda

Observação do `@Arquiteto` ao fechar a wave, e o número dela é o argumento:

> **Cinco das seis confusões do dia foram afirmação em MENSAGEM sobre estado que já tinha mudado —
> não sonda mal rodada.**

O carimbo entrou nas sondas e resolveu o lado da medição. O lado do **relato** ficou descoberto: o
regente disse *"não fez contador"* (verdade num commit, mentira dois commits depois), o `@QAVivo`
assinou verdes contra um desenho superado, e duas leituras do mesmo arquivo produziram valores
opostos — todas afirmações em mensagem, nenhuma sonda com defeito.

> **Todo relato de estado abre com `HEAD` e sujeira dos arquivos citados.** Assim a divergência
> aparece **na hora de ler**, não três mensagens depois — quando já custou o trabalho de alguém.

Custa uma linha. É a mesma troca de estimativa por fato observado que o `carimbar()` fez na
medição, aplicada à conversa.

### E duas coisas AFIRMADAS, para ninguém "consertar" depois

Registradas a pedido do `@Arquiteto`, porque parecem defeito a quem lê rápido:

1. **O `delete` de marca vencida é CORRETO.** Removê-lo numa sobrecorreção troca um bug por um
   vazamento — marca vencida é lixo.
2. **`aberta` ser atualizada a cada nova marca empurra o fallback para frente, e isso é o
   desejado**: enquanto eu ajo, a ação continua sendo minha.

## §7.19 — Desacordo entre gente competente vira TESTE, não argumento

O regente simulou e dispensou o contador; o `@Arquiteto` insistiu que era necessário. O `@DevVivo`
não escolheu um lado: **rodou as duas versões lado a lado** e transformou a discordância em dois
testes.

| teste | passa sem contador? | o que prova |
|---|---|---|
| *"a linha do tempo comum (B assenta logo após A)"* | **sim** | a simulação do regente estava certa **para os números que ele escolheu** |
| *"A assenta e B PENDURA"* | **não** | é onde a sobrescrita deixa de bastar — o caso do handler lento |

> **O teste útil é o que reprova de UM lado só.** O que passa nos dois registra o acordo; o que
> discrimina é o que encerra a discussão.

E o ganho é de prazo longo: daqui a seis meses ninguém precisa reconstituir a conversa — basta ver
**qual fica vermelho**. Argumento envelhece e some do histórico; teste discriminante fica no
repositório e reprova sozinho.

> Corolário: quando duas pessoas competentes discordam sobre comportamento, a pergunta certa não é
> *"quem tem razão?"* — é ***"que medição separaria as duas hipóteses?"***. Se nenhuma separa, a
> discordância é sobre gosto, e aí decide quem tem a palavra final. Se alguma separa, argumentar
> mais é desperdício.

## §7.20 — Com árvore em movimento: invariante sim, veredito não

Formulação do `@Arquiteto` ao fechar, e ela resolve a tensão que apareceu quatro vezes na wave:

> **Com árvore em movimento eu não emito VEREDITO, mas emito INVARIANTE. As duas coisas não
> competem, e a segunda é justamente a que cabe antes do commit.**

O alerta prévio das duas armadilhas do eco local **só pagou porque foi escrito com o disco sujo**.
Se ele tivesse esperado o commit "para revisar direito", a segunda teria entrado — e teria virado
um intermitente, que foi o que custou duas rodadas de diagnóstico neste mesmo dia.

| | quando cabe | por quê |
|---|---|---|
| **Veredito** | só com árvore limpa e `HEAD` carimbado | é afirmação sobre um estado; estado em movimento não se afirma |
| **Invariante** | a qualquer momento, inclusive no meio da edição | é afirmação sobre o desenho; não depende do rascunho no disco |

**Recusar-se a revisar não é o mesmo que não contribuir.** Esperar o commit para dizer tudo é
guardar para depois o que só tem valor antes.

## §7.21 — Comentário que diz o PORQUÊ é artefato, não documentação

Fecho da wave, observação do `@DevVivo` sobre si mesmo:

> *"Eu só testei o caso lento porque tinha acabado de escrever o comentário dizendo que a cascata
> estica em VPS. **Foi o texto que me lembrou, não disciplina.**"*

O comentário não descreveu um comportamento — **causou** um. É a mesma família do `carimbar()` e do
check de evidência citada: peça que muda o que a próxima pessoa faz, em vez de registrar o que a
anterior fez.

> **Comentário que repete o código é documentação. Comentário que declara o PORQUÊ — a alternativa
> descartada, o custo assimétrico, o caso que estica — é artefato.** O primeiro envelhece e mente;
> o segundo trabalha.

Foi por isso que esta wave insistiu em três coisas que parecem excesso e não são: registrar a
**tentativa fracassada** (o `inset` que não sobreviveu ao contexto de pintura), registrar o que
**não se deve consertar** (o `delete` de marca vencida, o avanço do `aberta`), e registrar **as três
linhas do tempo** em vez de só a que venceu.

## §7.22 — A premissa de tempo, na medição, vira ORDEM DE OPERAÇÕES

O `@QAVivo` produziu dois vermelhos falsos ao remedir o pulso, e os dois são a mesma coisa que o
`§7.17` descreve para simulação:

1. **Fotografou logo após disparar.** A animação dura 320 ms e **o próprio screenshot consome parte
   disso** — pegou o card já em repouso, e o pixel deu igual.
2. **Passou a esperar o overlay nascer, mas começou a esperar DEPOIS do gatilho** — chegar atrasado
   por construção; o disparo já tinha consumido a janela.

> **Na simulação a premissa de tempo é implícita; na medição ela vira ORDEM DE OPERAÇÕES.**
> Arme a espera **antes** do gatilho, sempre. Instrumento que só começa a observar depois de agir
> mede o rastro, não o evento.

### E o antídoto que ele nomeou é o mais barato que existe

O que o salvou não foi releitura: foi rodar **a sonda do regente**, que deu `PASS` com repouso,
durante e depois distintos. **A contradição entre duas ferramentas disse qual estava errada.**

> **Ferramenta independente medindo a mesma coisa é o antídoto mais barato para vermelho falso.**
> É o `§7.9` usado de forma construtiva: lá a contradição denunciou o instrumento; aqui ela foi
> **provocada de propósito** para ter um segundo voto.

E o fecho, nas palavras dele, que é a tese da última hora desta wave:

> ***"Trabalho feito que não chega a quem clona não está entregue."***

## §7.23 — Nem todo delta invalida um veredito

O `@QAVivo` assinou a Wave 3 com carimbo em `b73b0fe`, e o `HEAD` já tinha andado. A regra do
`§7.3` diria "remeça" — e estaria errada aqui.

**A pergunta não é *"o HEAD andou?"*, é *"o delta toca a CADEIA DECLARADA?"***. Verificado:
`git diff --name-only b73b0fe..HEAD` devolveu apenas `BRIEFING` e `HANDOFF` — **zero arquivos de
comportamento**. O veredito vale.

> Sem esta cláusula a regra vira paralisia: cada linha de handoff escrita invalidaria todas as
> provas do time, e a disciplina que existe para tornar o verde confiável passaria a impedir que
> exista verde.

É a `§7.16` (observação × invariante) aplicada ao **delta**: o que importa não é a distância em
commits, é se algum deles cruza a cadeia que a prova declarou depender.

**Como se checa, em uma linha:**
```
git diff --name-only <commit-medido>..HEAD | grep -vE '^(docs?/|.*\.md$|evidence/)'
```
Vazio → o veredito sobrevive. Não vazio → nomeie o que mudou e decida se aquilo podia mexer no
resultado.

## §7.24 — Armadilha acoplada, e a exceção que se cobra sozinha

Revisão do `@MaestroConexoes` no check de evidência: quatro buracos, e o terceiro é o que separa
revisão de **lista de defeitos**.

> Ele mandou **não consertar o segundo sozinho** — porque a correção óbvia **ativa** o terceiro:
> ampliar a cobertura sem corrigir a normalização transformaria o check em **máquina de falso
> positivo**, reprovando documentos corretos *por um caminho que ele mesmo inventou*.

**Achar dois defeitos é bom. Achar que consertar um deles dispara o outro é revisão de verdade.**
Antes de aplicar um conserto óbvio, pergunte: *o que este conserto passa a exercitar que hoje não
é exercitado?*

### E a exceção que não apodrece

A cobertura nova revelou que a doença era do **repositório**: 15 documentos de outras épicas com
referência morta. Duas saídas ruins e uma boa:

| saída | por quê não |
|---|---|
| portão duro contra todos | quebra a suíte de todo mundo por dívida que não é de quem entrega |
| excluí-los em silêncio | é a lista arbitrária que esta wave já reprovou |
| **quarentena enumerada** | o passivo fica **visível e contável**, e o portão fica duro para o que nasce daqui em diante |

> **E a quarentena EXIGE que o item ainda esteja quebrado.** Consertou, sai da lista, ou o vermelho
> aparece.
>
> **Lista de exceção que ninguém revisa vira permissão permanente.** A que se cobra sozinha é a
> única honesta — e custa três linhas.

Provado por mutação: um documento limpo colocado na quarentena faz o teste acusar
(*"está em LEGADO e já não tem referência morta — REMOVA-O da lista"*).

## §7.25 — Instrumento que casa por substring não separa USAR de MENCIONAR

Quinto buraco do check de evidência, achado pelo `@MaestroConexoes`, e o mais fundo: o extrator
casava **qualquer token** terminado em extensão de imagem — pedaço de URL, rota em exemplo de
código, chave de storage, e até **elisão** (os três pontos do texto virando caminho).

> É a mesma família do guard que travou o time pela manhã, lendo a palavra proibida **dentro do
> texto** de uma mensagem. **Casar por substring não distingue *usar* de *mencionar*** — e quanto
> mais preciso o documento, mais exemplos ele contém, e mais o instrumento se engana.

**Ler SINTAXE, não texto:** `![alt](caminho)`, `[texto](caminho)`, caminho entre crases — e
descartar blocos de código cercados, URLs e, um nível mais fundo, **templates e globs**
(`wave-<n>-<cenario>.png`, `onda1-*.png` nomeiam **padrão**, não arquivo).

### E o efeito colateral que quase congelou a quarentena

A quarentena exige que o item **ainda** esteja quebrado, para não virar permissão permanente. Mas
se o que segura o documento é **artefato do extrator**, a condição é **permanentemente verdadeira**
— o documento nunca sai da lista, mesmo pagando a dívida real inteira.

> **Um instrumento impreciso não só mede errado: ele pode tornar a própria correção impossível.**
> Sete documentos estavam nesse estado. O número real caiu de 15 para **9**.

### O anti-apodrecimento tem DOIS lados

O primeiro só dispara para item que o teste **alcança**. Ao corrigir o extrator, seis itens saíram
da cobertura e viraram **peso morto invisível**.

| lado | pergunta | reprova quando |
|---|---|---|
| direto | o item ainda está quebrado? | consertou e não removeu |
| **reverso** | o item ainda é alcançado? | saiu da cobertura e ficou na lista |

**Toda lista de exceção precisa dos dois.** Com um só, ela apodrece pelo lado que ninguém olha.

## §7.26 — "Mencionar não é usar" atravessou TRÊS camadas no mesmo dia

| camada | o que aconteceu |
|---|---|
| **guard de comandos** | leu o verbo proibido **dentro do texto** de uma mensagem e travou o terminal — *"quanto mais preciso o relatório, maior a chance de ele se auto-bloquear"* |
| **extrator, 1ª versão** | leu o caminho **dentro do exemplo de código** e contou como dívida |
| **extrator, 2ª versão** | leu o caminho **dentro da tabela que EXPLICA os caminhos ruins** — documentar o falso positivo criou falso positivo |
| **o próprio transporte** | o `zsh` do `@MaestroConexoes` interpretou a crase do exemplo como substituição de comando, e o exemplo chegou **vazio** na mensagem que reportava o problema |

> **Nenhum casador de texto sabe a diferença entre usar e mencionar.** E a quarta linha é a mais
> engraçada e a mais instrutiva: **o meio comeu o exemplo do problema que a mensagem descrevia**.

Duas coisas que se tiram disso, e a segunda é a que economiza tempo:

1. **Quem explica um defeito de casamento de texto vai ser mordido por ele.** Escrever sobre a
   armadilha exercita a armadilha — é o único tipo de documentação que dispara o que documenta.
2. **O sinal tem que ser inequívoco na ORIGEM.** Ajustar o casador não resolve enquanto os dois
   usos forem escritos igual: aqui, crase significa *"literal"*, não *"citação"*. A saída foi
   trocar o sinal ambíguo pela **presença de caminho** — nome puro é arquivo, caminho escrito é
   exemplo.

## §7.27 — Número que o instrumento calcula não se escreve à mão

Terceira vez que o mesmo mecanismo mordeu, contada pelo `@MaestroConexoes`: **medir, escrever o
número no documento, apertar o instrumento, e o documento ficar para trás** — com a autoridade que
documento tem. A dívida foi **15 → 9 → 8**, e cada valor esteve certo por algumas horas.

A pergunta dele é melhor que o conserto:

> *"Número que o teste já calcula toda rodada precisa mesmo estar escrito à mão no handoff?
> Enquanto estiver, ele vai desatualizar de novo no próximo aperto."*

**Não precisa.** Trocar `9` por `8` conserta hoje e apodrece amanhã; **apontar para a fonte não
apodrece nunca**. O documento passou a dizer *onde* a lista vive e *como rodar*, sem copiar o
valor.

> É a lei central da wave aplicada ao próprio documento: **substituir o fato mantido à mão pelo
> artefato que se mantém sozinho.**

E há um detalhe que faz o ponteiro valer mais que o número: a lista **não é anotação**. O
anti-apodrecimento **direto** exige que cada item ainda tenha referência morta; o **reverso**
proíbe fantasma. Ela é **verdade imposta a cada execução** — não retrato de quando alguém olhou.

### E a regra final não foi de ninguém: foi a UNIÃO

Observação dele ao ratificar: o critério que funcionou é `começa com evidence/` **OU** `não tem
barra nenhuma`.

| proposta | salva |
|---|---|
| prefixo (`@MaestroConexoes`) | a **tabela de ruídos** do handoff, que cita caminhos completos |
| nome puro (regente) | as **narrativas**, que citam por nome de arquivo |

**Nenhum dos dois critérios sozinho cobria os dois estilos de escrita do time.** Cada um enxergava
os documentos que costumava ler.

## §7.28 — O guarda só tem poder sobre documento versionado

Observação do `@QAVivo` ao fechar a wave, e ela inverte a intuição de quem vai usar o check:

> *"Com `wave-3.md` solto no disco ele passava 17/17 e não cobrava nada — verde vazio clássico. Foi
> por isso que o documento entrou antes de eu perguntar qualquer coisa a ele."*

A cobertura é **consequência** do versionamento, não pré-requisito dele. Documento fora do `git` é
invisível ao guarda, então perguntar antes de versionar devolve um verde que não significa nada.

> **Ordem correta:** versione o documento **primeiro**, rode, e deixe o guarda **nomear** o que
> falta. Não decida o que versionar e confira depois — a decisão é dele, e ele decide melhor.

Funcionou literalmente: narrativa no índice → reprovou nomeando **12 capturas** citadas e fora do
`git` → adicionadas exatamente essas → **18/18**.

### E o que ficou de fora, nomeado com motivo

Três exclusões deliberadas, e a segunda é a mais fina:

| fora | por quê |
|---|---|
| capturas de LGPD | a narrativa **não as cita** — entram no mesmo commit de quem citar |
| sondas `-ARVORE-SUJA` | **existem para se acusarem, não para servirem de prova** — são o guarda se demonstrando, não evidência |
| capturas de outro autor | não são suas para versionar (`§7.3`: commita-se o que se escreveu) |

**Exclusão com motivo escrito é decisão; exclusão silenciosa é esquecimento.** As três continuam
cobráveis pelo guarda no instante em que alguém as citar.

---

## §7.29 — Tipo e teste são camadas, não alternativas

Nasceu do bloco 4.5, e o raciocínio errado é sedutor porque **cada metade dele é verdadeira**.

`last_human_decision` entrou no `LeadContext` como **opcional** (`?:`) para contornar o hook que
congela `tests/invariants/**` — um campo obrigatório obrigaria a acrescentar uma linha ao
`fakeLeadContext` de um invariante existente. A justificativa foi escrita no código:

> *"A garantia que interessa não é fixture de teste declarar o campo — é o PRODUTOR sempre
> preenchê-lo, e isso está coberto por `get-lead-context-decisao.test.ts`."*

O produtor **está** coberto. O teste **existe** e passa. E mesmo assim a troca foi ruinosa, porque
as duas coisas não cobrem o mesmo conjunto:

| camada | cobre | não vê |
|---|---|---|
| **tipo obrigatório** | **todo mundo** que constrói um `LeadContext`, hoje e no futuro | valor errado, filtro de org ausente |
| **teste do produtor** | o produtor de verdade, com valor e org conferidos | o próximo lugar que montar um contexto |

**Medição que encerra a discussão** — não argumento, número:

| estado | `tsc --noEmit` |
|---|---|
| `?:` + fixture omitindo o campo | **0 erros** — compilador calado sobre um contexto que nasce cego |
| obrigatório + o mesmo fixture | **TS2741**, apontando a linha |

> Trocar uma garantia de **compilação sobre todos** por um teste de runtime sobre **um** é trocar
> um bloqueio **visível** por uma cegueira **silenciosa**.

**O agravante, e é o que torna esta lei necessária:** a lição já estava escrita no próprio
`HANDOFF`, duas vezes — na linha 3217 (*"o campo é obrigatório, não opcional… campo opcional deixa o
próximo nascer sem a decisão e ninguém percebe"*) e na 2150, de uma wave anterior (*"a interrogação
do opcional é que calava o compilador"*). **Documentar não é aplicar.** Uma lição registrada não
gera atrito no momento da decisão; só o instrumento gera.

**Regra:** quando um guard bloquear, a pergunta não é *"como faço isto passar?"* — é *"o meu
contorno paga o preço em qual outro lugar?"*. `freeze-invariants.sh` existe para impedir que um
invariante seja **apagado ou afrouxado**, não que ele continue **compilando** quando um tipo ganha
campo: acrescentar linha a um fixture é **adição**. A exceção documentada existe e cobra prova —
`DESKCOMM_GOV_INVARIANTS_EDIT=1` com o `+N −0` **medido** no corpo do commit. Se o `−0` não
aparecer, o bloqueio estava certo.

### §7.29-a — Duas emendas do @DevVivo, e a segunda vale para tudo

Ele aceitou a lei e acrescentou o que faltava: **o sinal de alarme prático**, que dispara *antes* de
o erro acontecer.

> **Quando o contorno de um bloqueio for AFROUXAR alguma coisa, o contorno está errado por
> construção — guard nenhum é satisfeito legitimamente removendo garantia.**

Isto é operável de um jeito que a lei sozinha não era. Diante de um bloqueio, não é preciso julgar a
qualidade do próprio raciocínio (que é justamente o que falha na hora): basta olhar a **forma** do
contorno. Se ele *tira* uma garantia — torna opcional, remove `not null`, alarga um tipo, silencia
um aviso — está errado sem precisar de mais análise. O guard nunca pede isso.

E a segunda emenda é maior que o episódio, maior que este épico:

> **Argumento que aparece exatamente quando você precisa dele merece desconfiança.**

O argumento *"o teste do produtor já cobre"* era verdadeiro, estava disponível — e **surgiu no
instante exato em que havia um bloqueio a contornar**. Raciocínio motivado não se apresenta como
desculpa; ele se apresenta como **um bom argumento**, e é por isso que convence. O sinal não é a
qualidade do argumento, é a **coincidência temporal** entre a necessidade e o aparecimento dele.

**Como usar, em uma pergunta:** *"eu teria defendido isto ontem, sem o bloqueio na frente?"* Se a
resposta é não, o argumento nasceu da necessidade e não da análise — e precisa passar por uma
medição antes de valer. Neste caso a medição existia e era barata: `tsc` com e sem a interrogação,
**0 erros contra TS2741**. Trinta segundos teriam desfeito a convicção.

### §7.29-b — O furo da minha própria regra, e as camadas medidas

O @QAVivo verificou a §7.29 e trouxe três coisas. A primeira **conserta a regra que eu ensinei ao
time**, e por isso vem antes.

**1. `+N −0` em `tests/invariants/` é necessário, não suficiente.**

Eu escrevi que a exceção do freeze se cobra pelo número medido: `git diff --cached --numstat
tests/invariants/` com `−0` prova que a mudança é aditiva. Prova que é aditiva **ali**. Não diz nada
sobre o resto do commit — e foi *exatamente fora dali* que o afrouxamento aconteceu, no `?:` de um
tipo em `lib/`. Uma regra que mede só onde o guard olha herda o ponto cego do guard.

> **Corrigido:** o `−0` vale para o diretório congelado; a leitura do **commit inteiro** procurando
> garantia removida (opcional, `not null` que sai, tipo que alarga, aviso silenciado) é obrigatória
> e é humana. Ele fez: conferiu que o outro arquivo do commit mudava *apenas* a interrogação e o
> comentário.

**2. Uma mutação não basta quando há mais de um jeito de a garantia falhar.**

*"Campo ausente quebra"* e *"campo `undefined` quebra"* **não são a mesma garantia**: um campo
tipado `X | null | undefined` passa na primeira e dá falso conforto. Duas mutações, dois erros
distintos:

| mutação | erro |
|---|---|
| apagar a linha do fixture | `TS2741 — Property 'last_human_decision' is missing … but required` |
| trocar o valor por `undefined` | `TS2322 — Type 'undefined' is not assignable to 'UltimaDecisaoHumana \| null'` |

**3. A §7.29 deixou de ser argumento e virou medição — nas duas pontas.**

Eu tinha provado que o **tipo** tem dentes. Faltava provar que o **teste do produtor** também tem —
sem isso, *"são camadas diferentes"* era retórica confortável. Ele mutou o produtor para devolver
`last_human_decision: null` sempre: mutação **válida no tipo**, então o compilador não salva.
Reproduzido de forma independente por mim:

| estado | `tsc` | `get-lead-context-decisao.test.ts` |
|---|---|---|
| base | 0 | **4/4** |
| produtor sempre `null` | **0** — cego, como previsto | **1 reprovado** — *"a decisão mais recente chega com ação, sentido e quando"* |
| restaurado | 0 | 4/4 |

> Cada camada reprova o que a outra deixa passar. **Isso é a lei medida, não argumentada** — e é a
> diferença entre uma doutrina que se sustenta e uma que só soa bem.

---

## §7.30 — Sem o antes, todo depois é compatível com o acaso

Formulação do @DevVivo, e é melhor que a minha ("procedência"), porque diz **por que** a leitura
prévia é obrigatória em vez de recomendável.

Dois instrumentos caíram nisto no mesmo dia, por caminhos diferentes:

| instrumento | o que mediu | o que afirmava medir |
|---|---|---|
| sonda dele | mutou um lead por **UUID** e fotografou um card achado por **texto** | que aquele card refletia aquela mutação |
| sonda minha | contou avisos **só depois** de abrir o board | que o board **criou** o aviso |

> Nos dois casos o instrumento mediu **uma coisa parecida com a certa** — e verde de coisa parecida
> é indistinguível de verde da coisa certa.

**Regra:** todo instrumento que afirma *"X causou Y"* lê o estado **antes**, e o veredito é a
**diferença**. Sem a leitura prévia, o verde não distingue "aconteceu agora" de "já estava lá".

## §7.31 — Alvo sorteado: `limit 1` sem `order by` é premissa escondida

Apareceu em **três instrumentos diferentes no mesmo dia** — já é padrão, não coincidência. Uma sonda
que mede um alvo diferente a cada execução não produz veredito comparável: **o verde de hoje não
fala do vermelho de ontem**, e a instabilidade se disfarça de flakiness.

**Regra:** `limit 1` sempre com `order by` explícito e determinístico, e o critério de ordenação é
parte do que a sonda declara medir.

## §7.32 — Casei por substring de novo, no instrumento que eu tinha acabado de escrever

A §7.25 diz: *"instrumento que casa por substring não separa USAR de MENCIONAR"*. Eu a escrevi. E o
extrator do invariante de vocabulário seleciona a constraint com
`pg_get_constraintdef(...) like '%= ANY (ARRAY[%'` — **substring** —, o que casa com **qualquer**
constraint que *mencione* valores daquela coluna, não só a que **define** o vocabulário.

**Não é hipotético.** Medido no banco, três colunas já têm **duas** constraints que casam:

| coluna | constraints que casam |
|---|---|
| `crm_leads.status` | 2 |
| `followup_enrollments.status` | 2 |
| `job_queue.kind` | 2 |

E o mecanismo, em `crm_leads.status`, é exemplar:

```
crm_leads_status_enum            CHECK (status = ANY (ARRAY['open','won','lost']))          ← DEFINE
crm_leads_closed_at_consistency  CHECK (... status = ANY (ARRAY['won','lost']) AND ...)     ← MENCIONA
```

Combinado com o `limit 1` sem `order by` (§7.31), o instrumento escolhe **uma das duas ao acaso**.
Hoje passa por **sorte**: as duas contêm o mesmo conjunto de literais. Noutra tabela, a regra de
negócio injeta valores que não são vocabulário e o invariante aprova ou reprova por motivo falso —
e um invariante que erra por motivo falso é pior que invariante nenhum, porque é obedecido.

**Regra:** o extrator seleciona a constraint **cujo predicado É o enum** (a definição inteira, não
um pedaço dela), e **se mais de uma casar, reprova em vez de escolher** — o mesmo princípio de
`resolveActiveLeadForContact`, que se recusa a adivinhar em empate. Adivinhar num instrumento de
medição é pior que adivinhar num roteador: o roteador erra um card, o instrumento erra o veredito
sobre todos.

---

## §7.33 — DIRC-C pergunta "pode ser calculado?"; falta perguntar "é função PURA?"

Lição do @Arquiteto, registrada com o nome dele porque ele a formulou ao se refutar.

Ele propôs **não persistir** a faixa de score: pelo DIRC (C de *Calcular*), faixa se deriva do score,
e valor derivado persistido é duplicação. O raciocínio é o certo — para **função pura**. Faixa com
histerese **não é função do score, é função do HISTÓRICO**: depende da faixa anterior, por definição.

> **Ele tratou dependência de caminho como se fosse derivação** — confundiu o que **parece**
> derivável com o que **é** derivável.

**E a refutação decisiva foi dele contra si mesmo, não minha.** Eu mostrei que a variante sem memória
**pisca**. Ele foi ao traçado seguinte e achou o modo pior: ela **engole travessia real**. Com
`prev=69`, `now=71` ela corretamente não dispara — e deixa `prev` **acima** do corte; quando o score
sobe de verdade para 76, a condição *"prev < corte"* é falsa e **nada dispara**. Trocaria piscar por
**silêncio**, e pela regra de assimetria do épico silêncio é a falha cara.

**Teste de bolso antes de invocar DIRC-C:** *"esta saída depende só das entradas de agora, ou também
de por onde o valor passou?"* Se depende do caminho, é **estado** — e estado não se recupera do
último valor. Persistir é o certo; o que a duplicação ameaça se resolve com **CHECK de coerência**,
não deixando de persistir.

### O CHECK de coerência, e o lado que eu tinha deixado aberto

Propus `quente ⇒ score ≥ 65` e `frio ⇒ score ≤ 45` — e **esqueci o teto do `morno`**. Sem ele,
`morno` com score **92** é gravável: faixa velha enquanto o score disparou, exatamente a divergência
que o CHECK existe para impedir. Fechava dois dos três lados. Pelas transições
(`frio→morno` ≥45 · `morno→frio` ≤35 · `morno→quente` ≥75 · `quente→morno` ≤65), `morno` só existe
entre **35 e 75**. Somado: **faixa sem score é impossível** — a faixa é a memória de uma travessia, e
sem número não houve travessia.

**E uma propriedade do CHECK que fica declarada para ninguém "corrigir" depois:** ele é **permissivo
na fronteira** de propósito (`<= 45`, `>= 65`, e não `<`/`>`). É um guarda contra **deriva**, não uma
reconstrução exata da transição — a transição exata é trabalho do TypeScript. Um CHECK apertado
demais rejeitaria escrita **legítima** (`numeric(5,2)` põe 44,99 e 45,00 dos dois lados de um limiar
inteiro), e guarda que reprova o certo é pior que guarda ausente: ensina a desligá-lo.

---

## §7.34 — Falha que não mostra a FORMA do defeito custa uma rodada

A varredura exaustiva achou **9 violações**; os exemplos escolhidos à mão tinham achado **4** — menos
da metade. Isso já era o esperado (exemplo acha o que quem escreveu já suspeitava). O que **não** era
esperado é que o ganho maior não estivesse na contagem, e sim no **formato da saída**.

| saída | o que entrega |
|---|---|
| nove linhas soltas | nove casos, e a forma fica para quem lê **adivinhar** |
| `70-74 vindo de 'frio'` · `36-39 vindo de 'quente'` | duas faixas **contíguas**, só na zona do meio — a **causa** aparece sozinha |

A segunda forma **mostra o defeito**: a banda morta do limiar **distante** bloqueando a transição
inteira em vez de um degrau. Quem vai consertar lê a causa direto da falha, sem gastar uma rodada de
investigação para reconstruí-la.

> **Regra:** asserção sobre domínio varrido **comprime** as violações (faixas, agrupamento por
> entrada), nunca despeja caso a caso. O teste não termina no veredito — ele termina quando entrega
> a **forma**.

**Corolário que salvou este achado de ser confundido com instrumento quebrado:** rode também os
**controles** — casos que devem **passar**. `75+` vindo de frio, `≤35` vindo de quente, `45-69` vindo
de frio e `40-65` vindo de quente **acertam**. Um achado que reprova tudo não distingue defeito de
sonda furada; um achado com **forma precisa e bordas certas** distingue.

## §7.35 — Duas invariantes independentes apontando o mesmo conjunto

O defeito da faixa foi apontado por dois caminhos que não se falam:

- **não-mentira** — a faixa exibida nunca fica a mais de um degrau da régua crua → **9/303**
- **fidelidade ao contrato** — a função concorda com a régua escrita no comentário acima dela →
  **os mesmos 9/303**

Uma compara com o **comportamento esperado**; a outra compara com a **especificação escrita**.
Chegarem ao **mesmo conjunto** é evidência de que o defeito é **um só** — e não dois problemas
sobrepostos que exigiriam dois consertos.

> Quando instrumentos independentes **divergem** no conjunto, há mais de um defeito (ou um dos
> instrumentos está errado) — e essa é a hora de parar de consertar e voltar a medir.

---

## §7.36 — Defeito latente muda de severidade quando a trava que o codifica entra

Achado do @Arquiteto, e é o tipo de interação que só aparece quando alguém olha **duas peças ao mesmo
tempo**. Nenhum de nós tinha conectado.

O defeito da caminhada (`frio` sobrevivendo com score 72) era **latente e visual**: a faixa nem chega
ao card ainda. Mas o CHECK de coerência que acabamos de endurecer diz `frio ⇒ score ≤ 45`. Então
`frio` com 72 **viola a trava**. No instante em que o delta de coerência entrar, o defeito deixa de
ser rótulo errado e vira **falha de escrita 23514** — o worker do score **para de persistir**.

**Medido, e é o mesmo conjunto pelos três caminhos:**

| instrumento | viola |
|---|---|
| não-mentira (contra a régua crua) | 9/303 |
| fidelidade (contra o comentário virado código) | 9/303 |
| **CHECK de coerência (erro na escrita)** | **9/303** |
| os três simultaneamente | **9** |

> **Regra de ordem:** o código que **produz** o estado entra **junto ou antes** da constraint que o
> **valida**. Nunca depois. Invertida a ordem, troca-se um rótulo errado por um worker que não grava
> — sintoma barato por sintoma caro.

**E o inverso é a parte bonita, que justifica o desenho inteiro:** a caminhada é exatamente o que
torna o CHECK **satisfazível**. `frio` só sobrevive com score < 45 (senão teria subido), `morno` só
entre 35 e 75, `quente` só acima de 65. **O CHECK é a imagem algébrica da caminhada** — a mesma regra
em duas linguagens, uma imperativa e uma declarativa. É *por isso* que a divergência vira
**impossível** em vez de improvável: não há duas fontes de verdade, há uma regra escrita duas vezes,
e a segunda recusa o que a primeira não produziria.

> **Corolário:** quando uma constraint e um algoritmo codificam a mesma regra, eles **nascem juntos**.
> Separados no tempo, o primeiro a chegar define um comportamento que o segundo vai quebrar.

### Três detalhes da caminhada, todos do @Arquiteto

1. **Salto de dois degraus emite UMA atividade, não duas.** Score indo de 30 a 90 num recálculo passa
   por `morno`, mas `morno` **nunca existiu no tempo** — emitir duas linhas fabricaria uma história
   que não aconteceu. Mesma lei da marca d'água: não mentir sobre **quando**.
2. **`band_since` é carimbado uma vez, na faixa final.** Carimbar no degrau intermediário registraria
   uma permanência de zero segundo.
3. **A assimetria da primeira leitura é deliberada:** com `anterior = null` vale a régua crua (42
   nasce `morno`), embora *subir* de `frio` exija 45. Primeira leitura **não tem história para
   proteger**. Sem esta frase escrita, alguém "uniformiza" os dois caminhos e reintroduz o problema
   pelo outro lado.

### E a resposta à pergunta de modelagem

Régua de três faixas com **banda única** está certa; a banda não é o defeito, a **formulação** é.
Banda por transição seriam **quatro números sem dado de calibração para girá-los** — o "botão que
ninguém sabe girar" que já rejeitamos nos pesos. O ruído é uniforme ao longo da escala (um campo BANT
vale 8,75; a virada de vitalidade vale 10,5), então não há razão para uma fronteira ter mais atrito
que a outra. Se um dia uma fronteira **provar** ser mais barulhenta, aí vira quatro — com a medição
na mão.

---

## §7.37 — Âncora derivada do instrumento não vigia o instrumento

O @QAVivo armou 14 âncoras contra a caminhada e escreveu **todas à mão a partir da régua declarada**.
A tentação era gerá-las de `porDegrau` ou de `faixaCrua` — e é exatamente aí que a cerca morreria:

> **Teste derivado da implementação concorda com a implementação por construção.** Ele reprova
> mudanças acidentais e aprova qualquer erro que já esteja na fonte da derivação.

E as âncoras são as **bordas**, onde conserto de um-a-mais quebra: o primeiro valor que confirma cada
transição e o último que não confirma — `45/44` vindo de frio, `75/74` de morno, `65/66` de quente,
`35/36` de morno. Mais as travessias reais e as leituras sem memória.

**De pé HOJE, antes de qualquer conserto** — que é o que se pede de uma cerca de regressão: ela existe
para dizer o que **não pode mudar**, e para isso precisa estar verde antes.

## §7.38 — Cerca que nunca reprovou pode ser decoração: submeta-a ao conserto ERRADO

Eu exigi *"depois do conserto, a varredura vai a 0/303 **e** os controles continuam de pé"*. Isso é
uma exigência escrita — e exigência escrita não reprova ninguém. Ele a tornou **mecânica**:
`SELFCHECK=1` aplica o conserto **errado que eu mesmo nomeei** (devolver sempre a régua crua) e mede
quem reprova.

| instrumento | veredito sobre o atalho |
|---|---|
| varredura de não-mentira | **0 violações** — *pareceria consertado* |
| anti-pisca | **reprova** — 6 trocas na série oscilante (limite: 1) |
| as 14 âncoras | **reprova** — 4/14 quebradas |

Conferido de forma independente: o atalho quebra exatamente `44` de frio, `74` de morno, `66` de
quente e `36` de morno — **4**, e a varredura vai a zero **por construção**, porque a régua crua está
a distância zero dela mesma.

> **O atalho passa na invariante nova e é barrado pelas outras duas.** É assim que uma exigência de
> duas metades deixa de depender de boa-fé: existe quem reprove quem cumprir só a primeira.

**Regra:** toda cerca nasce com o seu próprio anti-teste — o conserto errado **mais plausível**,
aplicado de propósito, e a lista de quem o barra. Se ninguém barrar, a cerca é decoração.

### Corolário — a disciplina de mutação tem uma fronteira: o arquivo do colega

O caminho óbvio era mutar `lib/kanban/score-band.ts`, como fizemos no fixture do 4.5 e no produtor do
`get-lead-context`. Ele **não** fez: o arquivo está **não rastreado** na árvore do @DevVivo — ou seja,
está sendo escrito **neste minuto**. A régua alternativa ficou **local ao auto-teste**.

> Mutação vale contra código commitado ou seu; **nunca contra arquivo que outra sessão tem aberto**.
> Duas mãos no mesmo arquivo é a receita de dois trabalhos se destruírem — e o dano não aparece como
> erro, aparece como resultado que ninguém consegue reproduzir.

---

## §7.39 — Onde um valor mora não é detalhe: pergunte quem mais lê o *mtime* da linha

Achado do @Arquiteto sobre a decisão C, e é um **segundo** motivo — mais grave que o meu — que
sozinho já justificaria a tabela separada. Verificado nas três pernas:

| peça | evidência |
|---|---|
| `trg_crm_leads_updated_at` | `BEFORE UPDATE ON crm_leads FOR EACH ROW` — bump em **qualquer** escrita |
| `app/api/v1/leads/[id]/move/route.ts:94` | `.eq("updated_at", input.expected_updated_at)` → 409 *"Concurrent edit"* |
| `trg_update_last_activity_at` | `AFTER INSERT ON crm_lead_activities` → toca o lead |

Com o score dentro de `crm_leads`, **um recálculo em segundo plano invalida o arrasto em voo de um
usuário**: ele solta o card e recebe *"alguém editou este lead"* — e ninguém editou.

> Pulso mentindo é **ruído visual**. Isto é **trabalho humano recusado por um evento invisível**, sem
> pista de causa — e o usuário não conclui "o sistema recalculou"; conclui "o sistema é instável".

**A regra generalizável:** ao decidir onde um valor de escrita frequente mora, a pergunta não é só
"quem lê esta coluna?", é **"quem mais lê o *mtime* da linha?"**. Trava otimista e realtime chaveiam
pela **linha**, não pela coluna — então uma coluna quente dentro de uma linha com trava otimista é
**rejeição invisível de trabalho humano concorrente**.

**E a composição fica correta pelo caminho que já existe, sem regra nova:** recálculo comum não toca
`crm_leads` → não pulsa e não invalida trava (telemetria, §C9). Travessia de faixa **emite atividade**
→ o trigger toca o lead → **aí** o board pulsa, pelo motivo certo. *Silêncio para telemetria, pulso
para mudança de estado.* A decisão C não contradiz a C9: **ela a completa**.

### O único risco real: os seis campos migram EM BLOCO

O CHECK de coerência amarra `ai_probability_band` a `ai_probability` **na mesma linha** — e **CHECK
não atravessa tabela**. Se por conveniência de renderização a faixa ficar em `crm_leads` e o score for
para a tabela nova, a garantia morre, e o substituto seria um trigger de validação cruzada — pior em
tudo.

> `score, reason, evidence, at, band, band_since` vão **juntos, ou não vai nenhum**. Quando alguém
> propuser *"só a faixa fica no lead, para o card não precisar do join"*, a resposta já está decidida:
> aí a divergência volta a ser **improvável** em vez de **impossível**, que foi exatamente o que se
> comprou com o CHECK.

**E o motivo entra no comentário da migration, não só no handoff.** Tabela 1:1 é a coisa que a próxima
pessoa mais quer "simplificar" de volta para dentro do lead — e ao fazer isso reintroduz, **em
silêncio**, o pulso que mente **e** o 409 fantasma. Sem a frase no arquivo, a simplificação **parece
limpeza**.

### §7.39-a — A regra virou consulta, e a consulta achou coisa

O @Arquiteto afiou a §7.39 até ela poder ser **caçada**, em vez de depender de alguém lembrar de
perguntar:

> **O patológico é MÁQUINA escrevendo em linha que HUMANO segura sob trava otimista.** Se quem escreve
> a coluna quente é outro **humano**, o 409 é **legível** — *"fulano editou este lead"* é verdade e a
> pessoa entende. A rejeição só vira **invisível** quando o escritor é processo de fundo, porque aí
> não existe fulano nenhum para nomear.

**Os três canais desta casa, todos chaveados pela LINHA:** (1) `trg_*_updated_at` + a trava otimista da
rota; (2) a publicação de realtime + os filtros do cliente; (3) gatilhos que rodam em **qualquer**
update — `trg_emit_event_on_lead_change` é `AFTER INSERT OR UPDATE ... FOR EACH ROW` e só decide
**depois** de comparar campo.

**E o discriminador de quando pagar a tabela separada**, senão a regra vira desculpa para 1:1 em todo
lugar: **frequência de escrita × número de canais de linha**. Valor escrito uma vez na vida do lead não
paga tabela nem com três canais; valor escrito a cada mensagem paga com um só. O score é o segundo
caso; **a maioria das colunas é o primeiro**.

**Rodei a varredura em vez de só registrá-la.** Resultado:

| pergunta | resposta medida |
|---|---|
| quais rotas usam trava otimista? | **uma** — `move/route.ts`, sobre `crm_leads` |
| há escritor de máquina nessa linha hoje? | **sim, um** — a ação de automação `assign_owner` |
| ele é patológico? | **não** — escreve `owner_user_id`, **mudança de estado real**; o 409 é legítimo |

**Refinamento que a varredura obrigou:** o discriminador não é máquina-versus-humano, é **mudança de
estado versus telemetria**. Máquina escrevendo estado real produz 409 **correto** (o lead mudou
mesmo); máquina escrevendo telemetria produz 409 **falso**. O score é telemetria — por isso sai da
linha.

**Achado nomeado, pré-existente, pequeno e visível:** a mensagem do 409 é literalmente *"Lead foi
modificado por **outro usuário**. Recarregue e tente novamente."* Quando o escritor é a automação, essa
frase é **falsa** — a pessoa vai procurar um colega que não existe. O texto embute a premissa de que
todo escritor concorrente é humano, e ela deixou de valer no dia em que automações passaram a escrever
no lead.

### §7.36-a — A ambiguidade era minha, e o instrumento certo a resolveu sem reprovar por ela

O @QAVivo foi armar a invariante de coerência e esbarrou num texto meu que diz **duas coisas**: a
§7.33 escreve `frio ⇒ score <= 45`; a §7.36 escreve *"frio só sobrevive com score **< 45**"*.

**Ele não reprovou por isso** — e essa foi a decisão certa. Em vez de asserir uma borda que a
especificação não fixa, **varreu e leu de volta** o intervalo que o banco aceita, assertando apenas o
que os dois textos concordam e deixando o intervalo como **saída** do teste:

```
frio 0..45 · morno 35..75 · quente 65..100 — bordas INCLUSIVAS
```

> **Reprovar por ambiguidade de especificação é reprovar o produto por defeito do texto.** Quando a
> spec não fixa a borda, o instrumento mede a borda e a **reporta**, em vez de arbitrar.

**E a ambiguidade se desfaz assim** — os dois números descrevem **conjuntos diferentes**, e o erro foi
meu por não dizer qual era qual:

| conjunto | borda | por quê |
|---|---|---|
| o que a **caminhada produz** | `frio` só para `s < 45` | em 45 ela já teria subido para `morno` |
| o que o **CHECK aceita** | `frio` até `s <= 45` | **permissivo de propósito** (§7.33): guarda contra deriva, não reconstrução da transição |

O aceito é **superconjunto** do produzido, e tem de ser: um CHECK que só aceitasse o exatamente
produzível rejeitaria escrita legítima na fronteira. A medição empírica dele confirma a propriedade
que eu havia **declarado** sem medir.
