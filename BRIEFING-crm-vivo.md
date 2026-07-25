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
