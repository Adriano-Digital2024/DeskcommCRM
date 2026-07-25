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

**E a razão dele é melhor que a minha leitura.** Eu havia registrado que ele não reprovou por
deferência ao texto. Não foi: ele **não conseguiu escrever a asserção** — tinha dois números
defensáveis e nenhum critério para escolher.

> **"Asserção que eu não consigo justificar sem chutar não é asserção, é preferência."** — @QAVivo

Isso é um teste de bolso melhor que a regra: antes de fixar um número num teste, tente **justificá-lo**.
Se a justificativa for "parece razoável", o número é preferência disfarçada de critério — e vai
reprovar alguém, um dia, por não compartilhar o seu gosto.

**E a ambiguidade se desfaz assim** — os dois números descrevem **conjuntos diferentes**, e o erro foi
meu por não dizer qual era qual:

| conjunto | borda | por quê |
|---|---|---|
| o que a **caminhada produz** | `frio` só para `s < 45` | em 45 ela já teria subido para `morno` |
| o que o **CHECK aceita** | `frio` até `s <= 45` | **permissivo de propósito** (§7.33): guarda contra deriva, não reconstrução da transição |

O aceito é **superconjunto** do produzido, e tem de ser: um CHECK que só aceitasse o exatamente
produzível rejeitaria escrita legítima na fronteira. A medição empírica dele confirma a propriedade
que eu havia **declarado** sem medir.

### §7.39-b — A fronteira da regra, senão ela vira licença para 1:1 pelo outro lado

O @Arquiteto aceitou a substituição do corte (estado real × telemetria no lugar de máquina × humano)
e nomeou o caso que **nenhum dos dois cortes separa**:

> **Máquina escrevendo estado real, mas ORTOGONAL ao que o humano está fazendo.** A automação escreve
> tags enquanto o usuário arrasta o card de estágio: é mudança de estado (não é telemetria), o 409
> dispara — e não havia conflito nenhum entre as duas intenções.

**Isto NÃO é caso de tirar tags da linha.** É a **super-rejeição inerente à trava de nível de LINHA**,
e o conserto, se um dia doer, é **trava por CAMPO** — não tabela nova.

Sem esta fronteira escrita, o próximo a ler a §7.39 usa *"mas gerou um 409 chato"* como argumento para
separar mais uma tabela, e `crm_leads` se esfacela em nome de uma regra criada para proteger
**telemetria**.

**E o precedente de trava por campo já existe nesta casa** — verificado: `fn_conversation_assign`
(migration 0032) recebe `p_expected_assignee` + `p_enforce_expected` e compara
`v_from is distinct from p_expected_assignee` — o **campo que importa**, não o `mtime` da linha. É
imune a esta classe inteira por construção, e as rotas de transferir/liberar do inbox já a usam.

> O inbox e o kanban têm **granularidades diferentes** de trava otimista no mesmo repositório. Não é
> escopo unificar agora e não está doendo. Fica registrado: **quando doer, a resposta já está escrita e
> testada aqui dentro** — não precisa ser inventada.

### §7.40 — Mensagem que era verdadeira quando foi escrita, e que a nossa própria evolução aposentou

O 409 diz *"Lead foi modificado por **outro usuário**"*. Estava **certo** quando foi escrito: naquele
dia, todo escritor concorrente **era** humano. Caiu no dia em que automações passaram a escrever no
lead — e ninguém releu a frase, porque nada obrigava a reler.

**É a terceira ocorrência da mesma forma nesta entrega:**

| onde | premissa verdadeira que caiu |
|---|---|
| comentário do eco local | o eco só vinha da própria ação |
| comentário do `?:` em `LeadContext` | o produtor era o único construtor |
| mensagem do 409 | todo escritor concorrente era humano |

> **Regra:** quando uma peça nova passa a escrever onde só humanos escreviam, as **mensagens de erro**
> daquele caminho viram **suspeitas** — elas descrevem um mundo que acabou de mudar, e nada no
> compilador ou nos testes aponta para elas.

### O conserto, com escopo travado antes de crescer

O princípio violado é **estreito**: *a mensagem afirma **QUEM** sem que o sistema tenha essa
informação*. Não é falta de diagnóstico — é **asserção não verificada**.

> Conserto certo: **parar de afirmar o ator**, e **não** passar a explicar o que mudou.
> `"Este lead mudou desde que você abriu. Recarregue."` — uma string, verdadeira em todos os casos.

**Correção da minha própria proposta:** eu havia escrito *"a mensagem tem de dizer O QUE mudou, ou pelo
menos não afirmar QUEM"* — e a primeira metade é a armadilha. *"Mostrar o que mudou"* vira feature de
diff, com releitura da linha e comparação campo a campo: **trabalho de wave para consertar uma frase**.
Achado sem correção dimensionada volta grande.

---

## §7.41 — O invariante que nasce com o schema se paga antes de existir dado

O @DevVivo escreveu o invariante de coerência **junto** com a migration, antes de qualquer linha ser
gravada. Ele achou **dois defeitos na regra** com o banco vazio:

- `resolveBand(36,'quente')` devolvia `quente` — testava a fronteira da faixa **crua** em vez da que
  estava **sendo cruzada**;
- `resolveBand(70,'frio')` devolvia `frio` — não confirmava `quente` e, em vez de parar em `morno`
  que **estava** confirmado, segurava a original.

Os dois **gravariam faixa incompatível com o score**, o CHECK recusaria, e isso apareceria **em
produção, no lead que oscila** — o caso mais difícil de reproduzir sob demanda.

**E os testes unitários dele passavam.** Ele tinha coberto **cada fronteira isolada** e o tombo
grande; faltava o tombo de **duas faixas**. Cobertura por caso não cobre **interação entre casos** — e
a varredura de `0..100 × 4 estados anteriores` achou em segundos o que a seleção de exemplos não
acharia.

### E a parte que separa conserto de remendo

> **Ele não tapou os dois buracos: trocou o desenho.** *"Histerese é propriedade de cada FRONTEIRA,
> não da faixa"* — então a regra percorre a escada **um degrau por vez**, confirmando cada uma. Isso
> **elimina a classe**, não os dois casos.

**Regra:** quando um instrumento devolve N violações, a primeira pergunta não é *"como conserto estes
N?"* — é **"de que classe eles são?"**. Consertar os N deixa a classe viva e o próximo caso volta com
outro rosto; trocar o desenho mata a classe e faz os N desaparecerem de brinde. A §7.34 pede que a
falha mostre a **forma** exatamente para que esta pergunta seja respondível.

**Corolário do custo:** invariante escrito **junto** com o schema custa o mesmo que escrito depois e
paga antes — aqui pagou com o banco ainda vazio, contra um defeito cuja alternativa de descoberta era
um lead oscilando em produção.

---

## §7.42 — A guarda não salva do *parse*: coluna que pode não existir exige SQL dinâmico

Custou um `install` quebrado ao @DevVivo, e a assimetria é o que torna a armadilha perigosa.

Migração de dados que lê uma coluna que **pode não existir** (o caso de mover campos de tabela) não se
protege com guarda:

```sql
-- NÃO salva: o Postgres faz o PARSE do comando inteiro ANTES de avaliar a guarda.
insert into nova (...) select ai_probability, ... from crm_leads
 where exists (select 1 from information_schema.columns where column_name = 'ai_probability');
```

> O erro é de **parse**, não de execução. A guarda decide se o comando **roda**; ela não impede que ele
> seja **lido**. Só `execute` (SQL dinâmico) adia a resolução do nome para depois da guarda.

**A assimetria que faz isto passar despercebido:** na máquina de quem desenvolve a coluna **existe** —
o parse resolve, tudo funciona. Quebra exatamente onde ninguém olha: no **`install` do banco novo**, no
self-hoster, onde a coluna nunca existiu. *O ambiente em que se testa é aquele em que o defeito não
pode aparecer.* É por isso que a doutrina de migrations manda validar `install` **e** `update` num
Postgres descartável — não é zelo, é o único lugar onde este erro é visível.

## §7.43 — Migrations contam a história; o baseline declara o destino

O score passou por `crm_leads` (0074) e saiu para tabela própria (0075). O baseline **não reencena**
isso: quem instala do zero **não recebe** as colunas em `crm_leads` para perdê-las na linha seguinte.

Verificado: `0` colunas de score dentro do `CREATE TABLE crm_leads`, e **um** bloco
`drop column if exists` no apêndice — **no-op** na instalação nova, **auto-curativo** no clone que já
tinha aplicado a 0074.

> As migrations são o **caminho** e existem para quem já andou parte dele. O baseline é o **destino**, e
> quem chega agora chega direto. Reencenar o caminho no baseline não é fidelidade histórica — é fazer o
> recém-chegado pagar por decisões que ele não tomou, e multiplicar os estados intermediários em que um
> `install` pode falhar.

---

## §7.44 — Mutação tem de provar que mutou, antes de valer como prova

Aconteceu comigo agora, verificando o bloco de decisão no `draft-reply`. Duas tentativas de mutação
**não casaram** (escape de `perl` errado) e as duas devolveram `exit=0` com `10 passed`.

> **Mutação que falha em mutar é indistinguível de teste sem dentes.** As duas dão verde, e a
> conclusão errada é a mais confortável: *"o teste não pega isso"* — o **inverso exato** da verdade.

Só percebi porque reli o arquivo depois de editar e vi o alvo intacto. Na terceira tentativa (troca
literal com âncora obrigatória) a mutação pegou e o veredito veio: **2 vermelhos**, exatamente os dois
testes da decisão.

**Regra:** toda mutação começa **falhando ruidosamente se a âncora não existir** e **exibe o trecho
alterado** antes de rodar o teste. Sem isso, o verde do teste mutado não distingue *"o gate é fraco"*
de *"eu não mexi em nada"*.

```python
alvo = "` +\n    blocoDecisao;"
assert alvo in s, "âncora não encontrada — mutação abortada"   # <- sem isto, o verde mente
```

É a mesma família da §7.30 (*sem o antes, todo depois é compatível com o acaso*), aplicada ao próprio
instrumento: **o verde de um teste mutado só significa alguma coisa se a mutação for observada, não
suposta.**

## §7.45 — Apagar um verde que não prova nada, e deixar escrito por quê

O @DevVivo tinha uma perna na sonda que fazia **grep no arquivo-fonte** procurando
`[DECISÃO DO VENDEDOR]`. Ela **passava** — e não provava nada: media que o texto **existe escrito em
algum lugar**, não que **chega ao modelo**. *Citação não conferida com cara de prova.*

Ele **removeu**, e deixou o motivo no comentário **para ninguém "completar" a sonda de volta**.

> Verde a menos com escopo honesto vale mais que verde a mais com escopo falso. E a segunda metade é
> a que sustenta: sem o motivo escrito, a perna volta — porque um teste ausente **parece** lacuna, e
> quem vier depois vai querer preenchê-la.

É a §7.38 pelo avesso: lá, a cerca ganhou um anti-teste para provar que morde; aqui, a perna que não
mordia foi **retirada**. Os dois movimentos servem à mesma pergunta — *"o que este verde me autoriza a
afirmar?"*.

---

## §7.46 — Quando o motivo de uma decisão é o sintoma que a revelou, some o sintoma e a decisão parece opcional

Formulação do @DevVivo, sobre ele mesmo, e é a lei mais reutilizável do dia.

Ele propôs tirar o score de `crm_leads` por um argumento de **ruído** (o pulso mentindo) — e
**desistiu** quando o `ANALYZE` consertou o teste que tinha levantado o assunto. O argumento que
sobreviveu foi outro, de **dano**: trabalho humano recusado por evento invisível (o 409 fantasma), que
**teste nenhum resolveria**.

> **Ele quase desfez a decisão certa porque o sintoma que a justificava sumiu.**

O sintoma é o que faz **notar**; ele quase nunca é o que faz a decisão ser **certa**. Confundir os dois
é ficar refém do primeiro conserto que apague o sintoma — e o conserto do sintoma costuma chegar antes
do entendimento.

**Consequência prática, que ele já aplicou:** o cabeçalho da 0075 nomeia **os dois defeitos** e **não**
menciona o teste que levantou a lebre. Documentar o sintoma como motivo é plantar a próxima reversão:
quem ler daqui a seis meses vai ver um problema já resolvido e concluir que a estrutura é
desnecessária.

**Teste de bolso:** *"se o sintoma que me fez notar isto desaparecesse agora, eu ainda tomaria esta
decisão?"* Se sim, **o motivo é outro — escreva o outro.** Se não, talvez não houvesse decisão a tomar.

### E a ressalva dele à §7.41, que melhora a lei

> *"Eu não troquei o desenho por disciplina — foi o SEGUNDO defeito que me mostrou a classe. Com um só
> eu teria consertado o caso e seguido em frente."*

Isso corrige a §7.41 no ponto que importa: **o caso difícil é N = 1**. Com dois defeitos de rostos
diferentes na mesma varredura, a classe **se anuncia**. Com um, ela fica escondida atrás de um conserto
que funciona.

> Então a pergunta *"de que classe isto é?"* é obrigatória **justamente quando há só uma violação** —
> é ali que ela custa esforço e é ali que ela paga. Com duas, qualquer um chega lá.

---

## §7.47 — Verde de suíte não é verde de tipo: cada gate fecha uma porta diferente

Proposta do @DevVivo depois de quase commitar `typecheck` vermelho com `test:unit` em **939/939**.

O runner **transpila sem checar tipo** — `esbuild` remove as anotações e segue. Um erro de tipo é
**invisível** para a suíte: ela roda o código transpilado e ele funciona. Então `939 passed` não diz
**nada** sobre `tsc`.

| gate | fecha | **não vê** |
|---|---|---|
| `typecheck` | contratos entre módulos | comportamento em runtime |
| `lint` | padrões e armadilhas conhecidas | tipos e comportamento |
| `test` | comportamento em runtime | **tipos** (o runner os apaga) |

> **Quem confunde os dois commita vermelho achando que mediu.** E o perigo não é o erro — é a
> **sensação de cobertura**: um verde grande e vistoso ocupa o lugar mental da verificação que não foi
> feita.

**Regra:** os três rodam **separados**, cada um com o seu código de saída lido, e nenhum serve de
procuração para o outro. Antes de dizer "está pronto", pergunte de cada verde: **que porta este
fechou, e qual ficou aberta?**

É a mesma pergunta da §7.38 (*o que este verde me autoriza a afirmar?*) aplicada ao conjunto de gates
em vez de a um teste — e vale registrar que ele já rodava os três separados por **outro** motivo (nunca
encadear ação e verificação, §7.3). O hábito o salvou antes de o entendimento chegar; o hábito certo
pelo motivo errado protege até o dia em que alguém "simplifica" a rotina.

### §7.43-a — O corolário do @DevVivo, e o alvo que ele errou por pouco

Ele anexou à §7.43: *"se o baseline salta o intermediário, o `drop column if exists` nunca é
exercitado no install — ele só roda no clone que já tinha a 0074. Logo o modo UPDATE não é redundância:
é o único lugar onde a metade auto-curativa é executada."*

**A direção está certa e o alvo não.** Fui conferir: o modo `update` **re-aplica o mesmo baseline** num
banco que também nunca teve aquelas colunas. A guarda `if exists` é **falsa** nos dois modos, a cópia
não roda, e o `drop` não acha nada.

> **Nenhum dos dois modos exercita o caminho auto-curativo.** O único banco onde ele roda é um **clone
> real** que aplicou a 0074 — e esse não existe em CI nenhum.

**E o formato é destrutivo por construção:** a cópia está **dentro** da guarda; o `drop column` está
**fora** dela. Se a cópia falhar, ou pular linhas por `on conflict (lead_id) do nothing`, o `drop`
**remove a origem assim mesmo**. Ninguém verifica que a migração deu certo antes de destruir o de onde
veio.

**Exposição real: quase nula** — a 0074 viveu uma hora e nunca foi publicada. **A forma, não.** Ela vai
se repetir em toda mudança que mova campos de tabela, e a próxima pode carregar dado de gente.

**Conserto dimensionado, e é pequeno:** um terceiro modo no `test-db.sh` que **fabrica o estado
intermediário** (aplica o baseline, acrescenta à mão as colunas antigas com uma linha de dado,
re-aplica) e afirma duas coisas — que o dado **chegou** no destino e que a origem sumiu **depois**
disso. Sem esse modo, a metade auto-curativa de qualquer migration de mudança de casa é **código que
nunca rodou**.

> A §7.42 diz que o defeito do *parse* só aparece no banco **novo**. Este diz que o defeito do
> *backfill* só aparece no banco **intermediário** — que não é o novo nem o atualizado. **São três
> estados, e a suíte cobre dois.**

---

## §7.48 — O vermelho também pode ser vazio: "recusou" não é a pergunta

Achado do @QAVivo **contra o próprio aparato**, revelado pela mudança de tabela.

Com o score fora de `crm_leads`, **toda** escrita da tabela-verdade passou a falhar com `42703`
(coluna inexistente). E o teste só perguntava *"o banco recusou?"*. Resultado: **seis das oito linhas
continuaram verdes — e erradas**. Um teste que afirma *"score sem razão é recusado"* ficou verde num
banco onde **a coluna do score não existia mais**.

> **A mudança de schema não criou o furo; revelou um que sempre esteve lá.**

**A lei, com a formulação dele:** *"**recusou** não é a pergunta; **recusou pelo motivo certo** é."*
Asserção de recusa sem checar o **código** da recusa é asserção sobre *"deu erro"* — e *"deu erro"* é o
estado **mais fácil de produzir por acidente** no sistema inteiro.

E é o **espelho exato** do verde vazio que este briefing já persegue: **o vermelho também pode ser
vazio**. Um teste que espera falha é singularmente vulnerável, porque há **infinitas** maneiras de
falhar e **uma** certa. Asserção positiva nomeia o estado esperado; **asserção negativa tem de nomear
o modo de falha esperado** — aqui, `23514` e nada mais. Qualquer outro código acusa **caso mal
montado**: falha do instrumento, não do produto.

### E o fecho: foram as pernas POSITIVAS que expuseram o furo

Das oito linhas, **duas** reprovaram — justamente *"score com razão e lastro é **aceito**"* e
*"**ausência** de score é aceita"*. Elas não tinham como ficar verdes num banco onde a coluna sumiu.

> **As pernas positivas que ele fez questão de incluir são o que expôs o verde falso das negativas.**
> É o argumento mais forte que existe para nunca escrever uma tabela-verdade só de recusas: sem elas,
> as oito linhas teriam ficado verdes e o instrumento estaria morto sem avisar.

---

## §7.49 — Explicar um número pelos "maiores contribuintes" é enviesado para o bem

Achado do @Arquiteto **contra o próprio contrato**, ao especificar a fórmula — e é o defeito mais
sutil da entrega.

Ele havia escrito que as 3 evidências do score são *"os 3 maiores contribuintes, ordenados por
`valor × peso`"*. Parece a definição óbvia de "as três razões principais". É enviesada:

> Um fator com **valor 0** — três objeções e nenhum compromisso — contribui **zero** e por isso
> **nunca entra no top 3**. Um lead com score 20 seria explicado **só pelas coisas boas**, e o que o
> derrubou ficaria invisível.

O resultado é a Lei D cumprida **ao contrário**: o número diz *"ruim"* e o porquê diz **só coisa boa**
— e o humano perde exatamente a informação que o faria agir. Pior nos leads que mais precisam de
atenção, que é onde uma explicação errada custa mais caro.

**Correção:** ordenar por **`peso × |valor − 0,5|`** — por **quanto o fator afastou o score do meio**.
O que puxa para baixo aparece com a mesma força do que puxa para cima.

**E ele deixou o teste que discrimina**, que é o que separa correção de intenção: entrada dominada por
objeções **tem de** trazer esse fator no top 3 — *falha com a ordenação antiga, passa com a nova*.

> **Generalização, e vale para qualquer "top N razões" de qualquer produto:** ordenar por contribuição
> faz o **zero desaparecer** — e zero costuma ser o valor **mais informativo** do conjunto. Ausência de
> compromissos, nenhum contato, nenhuma resposta: são os que explicam o número, e são exatamente os que
> a ordenação por contribuição esconde.

## §7.50 — Grep no fonte é *tripwire*, não prova — nas duas direções

A §7.45 registrou uma perna removida por afirmar comportamento a partir da **presença** de um texto no
arquivo. A especificação da fórmula traz a forma **espelhada**: um teste que garante que
`probability.ts` **não contém** literal de hora nem de dia, para provar que a recência vem só de
`classifyRisk`.

**A inversão não a torna prova.** Ela cobre a forma ingênua e nada além: `60 * 60`, uma constante
importada, ou uma janela derivada de outro lugar passam pelo grep e reintroduzem o segundo
classificador — que é justamente *"escondido dentro de um cálculo"*, o pior lugar possível.

> Como **tripwire** contra a forma óbvia, vale e é barato — desde que **rotulado como tripwire**. O
> risco é ser lido como garantia: aí ele ocupa o lugar mental da verificação que não foi feita (§7.47).

**A forma que prova consumo em vez de ausência:** *mockar* `classifyRisk` e afirmar que o fator de
recência **se move com ele** — mudou a saída do classificador, mudou o fator; não mudou, não mudou.
Isso é impossível de satisfazer com uma janela própria, porque a janela própria **ignoraria o mock**.

> **Ausência de um padrão prova que uma forma não está lá. Só o acoplamento observável prova que a
> fonte certa está sendo usada.**

---

## §7.51 — Placar que lista só o que passou se lê como cobertura completa

O @QAVivo corrigiu a colisão de numeração e **não parou no rótulo**: o problema não era o nome dos
testes, era o placar **listar apenas o que passou**. Quem lê conclui que o resto passou junto.

Agora o que falta é **medido e aparece**:

```
BLOQUEADO [S15]        gravei score 72 num lead, abri o board, olhei o card:
                       nenhum número, nenhum medidor. Linha removida no fim.
BLOQUEADO [S15.hover]  sem medidor não há o que revelar — preso ao S15.
BLOQUEADO [S17]        preso ao S15 pelo motivo do §7.52.
```

> **15 verdes, 0 vermelhos, 3 bloqueados.** O número de verdes **não mudou**; o que mudou é que ficou
> **impossível ler o placar e achar que a wave está pronta**.

**E a escolha da palavra é técnica, não diplomática:** ele usou **BLOQUEADO**, não **FALHA**. *"Recurso
que ninguém escreveu acusa quem **planejou**. Chamar de reprovado mandaria o @DevVivo caçar defeito em
código que não existe."* **A atribuição decide qual é a próxima ação** — e um rótulo errado manda a
pessoa certa para o lugar errado.

## §7.52 — Cenário sobre ausência passa vazio quando a funcionalidade inteira está ausente

O achado mais fino do turno, e ele está **no meu próprio contrato**.

O cenário 17 diz: *"lead sem sinal suficiente **não** mostra score inventado"*. Medido hoje, ele
**PASSARIA** — e passaria pelo motivo errado: **num produto que não mostra score nenhum, "não mostra
score inventado" é trivialmente verdadeiro**.

> É o **verde vazio perfeito**: a asserção é sobre uma **ausência**, e a ausência está garantida por um
> motivo que não tem nada a ver com o que se quer provar.

**Regra:** todo cenário que afirma *"não faz X"* precisa de uma **pré-condição explícita de que o
sistema é capaz de fazer X**. Sem isso, ele é aprovado por um produto vazio — e o dia em que a
funcionalidade nascer é justamente o dia em que ele **para** de proteger, porque já vinha verde.

**Consequência prática:** S17 fica **bloqueado por S15**, não verde. Um cenário de ausência só pode ser
avaliado depois que a presença existe.

## §7.53 — Numeração interna que sai do arquivo vira numeração pública

Ele recusou parte da culpa que eu assumi, e a formulação é dele:

> *"A sub-numeração era minha e eu a usei em mensagem, documento e commit sem nunca cruzar com a
> numeração do briefing."*

**Regra:** rótulo criado para uso interno passa a ser contrato no instante em que aparece num
relatório, num commit ou numa conversa — e a partir daí ele **compete** com os nomes que já existem.
Rótulos nascem com prefixo (`C16.a`, `H.b`, `S15`), e o prefixo diz **de qual fonte externa** aquele
teste é procuração. *Teste cita o cenário do briefing que prova, nunca a própria sequência* (@Arquiteto).

---

## §7.54 — Saída que reconstrói a entrada torna a derivação verificável sem ler o código

Eu havia afirmado que a C1 (*o `reason` é **derivado** do cálculo*) **só** se verifica olhando a
**fórmula**, porque no resultado uma frase gerada e uma frase derivada são indistinguíveis. O
@DevVivo desfez o empate **por máquina**, e a afirmação era minha:

> **O teste reconstrói o score a partir da frase.** Soma os `+12` e `−8` que ela cita e compara com o
> número. Se a razão citar parcela que não entrou na conta, **omitir** uma que entrou, ou trouxer
> **valor diferente** do que somou, a reconstrução **não fecha**.

O que muda não é a força do teste — é o **tipo** de garantia:

| antes | depois |
|---|---|
| derivação é propriedade **do código**, conferida por leitura | derivação é propriedade **da saída**, checada **a cada execução** |
| revisão humana protege enquanto alguém revisar | protege **contra a mudança futura** que ninguém vai revisar |

E é a segunda linha que importa: protege contra o refactor em que alguém troca a montagem por um texto
*"mais bonito"* **mantendo o número**. Frase de modelo passa no olho humano e **falha na reconstrução**.

> **Generalização:** quando for preciso provar que uma explicação foi **derivada** e não **composta ao
> lado**, faça a explicação carregar informação suficiente para **reconstruir o resultado**. Derivação
> deixa de ser confiança e vira **invertibilidade** — e invertibilidade é mecânica.

**Nota de método:** ao verificar isto, minha mutação **abortou** porque a âncora não existia mais (o
arquivo havia mudado). O `exit=0` que veio depois era **vazio**, e eu soube disso porque o `assert` da
§7.44 gritou. **A lei se pagou dentro da hora em que foi escrita** — sem ela, a leitura teria sido *"o
teste não tem dentes"*, que é a conclusão errada **e** a confortável.

---

## §7.55 — Número fixo de evidência vira cota, e cota se preenche

O @DevVivo, revisando o cenário 15 **antes** de codar: a fórmula produz hoje **uma** evidência
(o `checkpoint_id`) e o cenário promete **"as 3 evidências"**.

> Se a UI espera três e chega uma, ou aparece **buraco na tela**, ou alguém **"completa"** inventando
> lastro para cumprir a cota. E **lastro inventado é pior que lastro nenhum** — porque **passa na
> constraint**.

**Ruling: "3" é TETO, não cota.** Mostra-se **as evidências que existem, até três**; nunca se preenche
para chegar a três. O número no contrato descrevia o caso típico, não uma obrigação de contagem.

> **Generalização:** contagem fixa num contrato de UI cria **pressão para fabricar**. Quando o número
> de itens depende do dado, o contrato diz **"até N"** e o vazio é um estado legítimo com desenho
> próprio — senão a primeira vez que faltar dado alguém inventa, e inventar passa em todo teste que
> só conta linhas.

### Emenda à §7.52 — a construção que torna o cenário de ausência mediável

Ele chegou ao mesmo verde vazio do @QAVivo por outro caminho **e trouxe a forma do conserto**:

> *"'Lead sem sinal não mostra score' fica verde também quando a feature está quebrada e **nenhum**
> lead mostra score. A prova precisa ser na **MESMA TELA**: um lead **com** score e um **sem**, lado a
> lado. Sem o par, 'não apareceu' é compatível com 'não funciona'."*

**É a perna positiva da §7.48 aplicada a um cenário visual.** O par na mesma captura é o que separa
*"o produto decidiu não mostrar"* de *"o produto não mostra nada"* — e nenhum print de um card só
consegue fazer essa distinção.

### §7.43-b — Duas correções do @DevVivo ao meu §7.43-a (as duas procedem)

**1. Eu exagerei o risco CONCRETO.** Escrevi que, se a cópia pulasse linhas por
`on conflict (lead_id) do nothing`, o `drop` removeria a origem assim mesmo. **Na forma, está certo.
Nesta migration, o conflito é impossível** — verificado: `crm_lead_scores` é criada na **linha 36 do
mesmo arquivo** e o `insert` roda na **68**, então a tabela está **vazia** e não há com o que
conflitar. E migration roda **em transação** (sem `BEGIN` próprio, o runner envolve): se o `execute`
lançar, a migration inteira aborta e o `drop` **nem chega a rodar**.

> O dano que descrevi exige uma **tabela destino PRÉ-EXISTENTE com linha para o mesmo lead** — condição
> que não existe aqui. **O risco de forma continua inteiro** para a próxima mudança de casa que mova
> para uma tabela que **já existe**: aí o `do nothing` vira **perda silenciosa** de verdade.

**2. Eu disse "código que nunca rodou". Errado, e o certo é pior.** Escrevi que o clone intermediário
não existe em CI nenhum — verdade — e daí concluí que o caminho auto-curativo nunca roda. **Ele roda:**
quem clonar o repositório hoje e aplicar as migrations **em ordem** passa pela 0074 (ganha as colunas)
e depois pela 0075 (copia e dropa).

> **Não é código que nunca rodou; é código que roda exatamente onde ninguém olha** — e isso é pior,
> porque produz **efeito sem evidência**. Reforça o terceiro modo em vez de enfraquecê-lo.

**Proposta dele para quando a wave liberar (duas linhas):** mover o `drop` para **dentro da mesma
guarda** e, antes dele, **afirmar que não sobrou linha com score em `crm_leads` sem correspondente em
`crm_lead_scores`** — abortando se sobrar.

> *"Destruir a origem sem confirmar o destino é a versão 'mudança de casa' de **criar constraint antes
> do backfill**"* — doutrina que este repositório já proíbe noutro lugar, reaparecendo com outro rosto.

## §7.56 — O teste de onde colocar um aviso

Formulação operacional do @DevVivo, e substitui o princípio por um procedimento:

> **"Pergunto onde a pessoa vai estar OLHANDO no instante em que for tomar a decisão errada. Se a
> resposta não for o lugar onde o aviso está, o aviso é para quem já concorda."**

Foi assim que ele decidiu pôr o motivo da tabela separada num `comment on table` **além** do cabeçalho
da migration: quem cogita "simplificar" uma tabela 1:1 está olhando para a **tabela**, num `\d+` ou num
cliente de banco — **não** está lendo o histórico de migrations.

Explica também por que tanta documentação não muda comportamento nenhum: ela é escrita no lugar onde
**o autor** estava, não onde **o leitor** vai estar.

---

## §7.57 — Perna positiva é sinal de vida; volta de leitura é mira. São falhas diferentes

O @QAVivo confirmou o fecho da §7.48 **contra o output**, não de palavra: reprovaram exatamente
`C16.a` (*score com razão é aceito*) e `C16.f` (*ausência de score é aceita*) — **as duas pernas
positivas, e só elas**. E melhorou o motivo geral:

> **Asserção positiva nomeia UM estado, e esse estado não se produz por acidente. Asserção negativa é
> satisfeita por qualquer quebra.** Logo, numa tabela-verdade, as linhas positivas são as únicas
> capazes de detectar que **o aparato inteiro morreu**. Não são o contraste das negativas — são o
> **sinal de vida** do instrumento.

**E então ele achou que o próprio canário cobria metade.** Ele detecta *"a escrita quebrou"*; **não**
detecta *"a escrita foi para o lugar errado"*:

> Se o `UPDATE` fosse para a linha de **outro lead**, as **oito** ficariam verdes — positivas
> incluídas —, porque as constraints continuariam valendo e o erro seria de **ENDEREÇO**, não de
> **regra**.

**Conserto (`e7c8f79`):** a linha aceita passa a ser **relida**. A asserção deixa de ser *"não deu
erro"* e passa a ser *"o valor está lá"*.

| guarda | detecta |
|---|---|
| perna **positiva** | o aparato **morreu** (nada mais escreve) |
| **volta de leitura** | o aparato está **mirando no alvo errado** (escreve, no lugar errado) |

> São duas falhas independentes e **cada uma precisa da sua**. Ter só a primeira é achar que estar vivo
> é o mesmo que estar certo.

**E o mesmo defeito em miniatura, que ele corrigiu junto:** a mensagem do caso *sem score* dizia *"o
valor voltou na leitura"* — e ali **não há o que reler**. **Texto que afirma uma verificação que não
aconteceu** é a §7.48 em escala de uma linha: o relatório mente sobre o próprio rigor, e quem lê passa
a confiar num rigor que não existe.

---

## §7.58 — A formulação apagava a distinção que o próprio autor defendia

O @Arquiteto foi **procurar um caso em que o modelo dele vencesse** e achou um que o **demole** —
e é o tipo de honestidade que decide desenho.

**O caso:** um lead com **dois** sinais presentes e ambos perfeitos (BANT 4/4 e estágio *negociando*)
dá **100** na renormalização. *Cem por cento de probabilidade de fechar, a partir de dois sinais.* No
modelo de base + parcelas, os mesmos dois sinais empilham sobre a base 30 e param perto de 60 — que é
o que um lead com pouca evidência boa merece.

**E o golpe é que isso contradiz o argumento dele.** Ele defendeu a renormalização escrevendo que
*"ausência reduz a CONFIANÇA, não a probabilidade"*. Mas a renormalização **iguala** *"poucos sinais,
todos bons"* a *"muitos sinais, todos bons"* — **apaga exatamente a distinção que ele disse que
importava**. Quem implementa o princípio enunciado é o **outro** modelo: sem evidência o score fica
perto do *prior*, e a evidência **afasta**.

> **Forma geral, e é reconhecível:** enuncia-se um princípio, escolhe-se um mecanismo que o **viola**,
> e não se percebe — porque a atenção estava no **mecanismo**, não na relação dele com o princípio.
> **Teste:** depois de escolher o mecanismo, releia a própria justificativa e pergunte se o mecanismo a
> **implementa**. Não é raro descobrir que ele faz o contrário.

**Ruling: o desenho fecha no modelo de parcelas**, com os quatro deltas.

### Emenda à §7.49 — é uma lei com duas álgebras, não duas leis

Correção dele à minha generalização, e ela é melhor:

> **O invariante é ORDENAR POR AFASTAMENTO DO NEUTRO**, e cada formulação tem a sua álgebra para
> "neutro".

| formulação | neutro | medida |
|---|---|---|
| média ponderada | `0,5` | `peso × \|valor − 0,5\|` |
| base + parcelas | **zero ponto** | `\|pontos\|` |

Isso corrige **onde** a §7.49 se aplica: o perigo **não está no "top 3"** — está em ordenar por
**magnitude do que somou** quando o **zero é informativo**. O modelo de parcelas é imune **por
construção**, porque nele "três objeções" é `−16`, e não `0`.

### E o formato do `reason` endurece o gate da C1

Com os **pontos dentro da string**, o teste da C1 continua sendo montagem mecânica a partir dos mesmos
objetos — e agora o **número** também está preso à frase. Uma frase de modelo teria de acertar **texto
E pontuação de cada parcela** para passar. **Ficou mais difícil de burlar, não menos.**

## §7.59 — O canal transforma a mensagem, e o código é a primeira vítima

Uma linha do @Arquiteto chegou **mastigada**: o `$` de um template literal foi interpretado como
variável de shell no caminho até mim, e o gate da C1 chegou incompleto. Ele mandou a errata sozinho.

> **O meio não é transparente.** Mensagem que atravessa um shell perde `$`, crases e contrabarras — e
> perde **em silêncio**, entregando algo que ainda parece código.

É a mesma família de *"o instrumento mede o que não pretende"*, aplicada à comunicação: o destinatário
não recebe o que foi escrito, recebe o que **sobreviveu ao transporte** — e não tem como saber a
diferença, porque o resultado continua plausível.

**Regra prática deste time:** código em mensagem vai **descrito** (nomes de campos, ordem, separador)
ou com marcação que o canal preserve; e quem manda expressão com `$`, crase ou contrabarra **relê o
que chegou**. A verificação de que a mensagem chegou inteira é do **remetente** — o destinatário só vê
o que sobrou.

---

## §7.60 — Restrição forte encontra o que a especificação não previu

A prova de invertibilidade da §7.54 foi escrita para uma coisa — impedir que a razão fosse **gerada**
em vez de derivada. Ela achou **duas** que ninguém pediu.

**1. O truncamento honesto.** O delta *"no máximo três parcelas nomeadas"* colidiu com a reconstrução:
cortar a quarta **em silêncio** faria a frase deixar de somar o próprio número — e *razão que não soma
o próprio número é a frase gerada que a C1 proíbe, **disfarçada de resumo***. O resto virou **uma linha
agregada** (`−8 outro fator`) em vez de sumir, e a conta continua fechando.

**2. O clamp, que ninguém tinha visto.** Quando a soma sai de `[0,100]`, o número exibido **não é** a
soma das parcelas: `30 − 24 − 20 = −14` vira `0`, e quem lesse a razão veria **uma conta errada na
tela**. A frase agora termina em `limitado a 0`. Quatro palavras que mantêm a razão auditável.

> **O caso só existiu porque a prova de derivação existia.** Sem ela, o clamp seria uma **divergência
> silenciosa** entre a razão e o número — exatamente a classe que esta entrega passou o dia caçando.

**Forma geral:** teste fraco acha o que você **foi procurar**; **invariante forte acha o que você não
sabia procurar**. Uma restrição que amarra a saída ao cálculo transforma **qualquer** ponto de
divergência em falha — inclusive os que nenhum cenário cobria, porque ninguém sabia que existiam.

## §7.61 — Imunidade estrutural não é imunidade testada

Nota do próprio @DevVivo, e é o tipo de ressalva que quase ninguém faz sobre um acerto seu:

> *"A imunidade veio da **modelagem**, não de cuidado meu — se um dia alguém migrar a fórmula para
> média ponderada, o viés volta junto **e o teste de ordenação não pega**."*

O modelo de base + parcelas é imune ao viés da §7.49 **por construção**: "três objeções" é `−16`, não
`0`, então sobe no ranking sozinha. **Não há guarda nenhuma protegendo isso** — a proteção é a
**forma** do desenho.

> Proteção que vem da forma **desaparece em silêncio quando a forma muda**, e nenhum teste existente
> percebe, porque todos eles passariam igual num modelo enviesado.

**Regra:** quando uma propriedade desejável é consequência da **modelagem** e não de um guarda, isso
vai **escrito no ponto onde alguém mudaria a modelagem** (§7.56) — não no handoff, não no topo do
arquivo: **na definição do modelo**. É o único aviso que a pessoa vai ler no instante em que estiver
prestes a apagá-lo.

### §7.54-a — Invertibilidade exige explicação COMPLETA: o que não cabe nomeado aparece somado

Limite descoberto pelo @DevVivo ao implementar, e é o que a lei precisava para ser aplicável:

> **A invertibilidade exige que a explicação seja completa** — e o contrato pedia *no máximo três
> parcelas*. Truncar quebraria a reconstrução. **O que não cabe nomeado tem de aparecer somado, nunca
> omitido.**

Por isso o resto virou uma linha agregada (`−8 outro fator`) em vez de sumir. Quem aplicar a §7.54 com
qualquer limite de tamanho vai bater nisto, e a saída é sempre a mesma.

**Prova contra o caso real** (mutação com âncora, árvore limpa em `6ae6f9e`): substituí o `reason` por
*"Lead promissor: o cliente demonstrou forte interesse e o momento é favorável"* — uma frase que **um
humano leria como perfeitamente razoável**. Resultado: **5 vermelhos**, entre eles *"somar os números
da frase reproduz o score"*, *"a frase não cita parcela que a conta não usou"* e *"quando o clamp atua,
a frase diz que atuou"*. Restaurado: 20 verdes.

> A frase passa no olho e **morre na máquina**. É exatamente o que se queria.

### §7.44-a — O efeito útil do assert não é impedir; é você SABER

Formulação do @DevVivo sobre a minha mutação que abortou, e ela corrige o foco da lei:

> *"O efeito útil não foi impedir a mutação errada — foi você **SABER** que o verde era vazio. A
> diferença entre **'não mediu'** e **'mediu e deu certo'** é invisível no exit code, e é por isso que
> a asserção precisa ser barulhenta."*

O `assert` não protege o código; protege **a conclusão**. Sem ele, os dois estados produzem o mesmo
`0` — e o mais confortável dos dois é o errado.

### §7.59-a — Lei que termina em "lembre-se de" ainda não terminou

O @Arquiteto pegou a §7.59 e **mecanizou** o que eu tinha deixado em disciplina. E abriu com uma
honestidade que é o melhor da mensagem:

> *"A minha errata chegou inteira porque usei **aspas simples** — e aspas simples têm a própria classe
> de corrupção: um **apóstrofo** dentro do texto encerra a string. Eu escrevi 'marca d'água' várias
> vezes hoje. Não foi método, foi **sorte**."*

**Trocar de aspas é trocar de risco, não eliminá-lo:** aspas duplas comem `$`, crase e contrabarra;
aspas simples quebram no apóstrofo. Cada escolha tem a **sua** classe de perda silenciosa.

**A receita que elimina as duas** — testada por ele e reproduzida por mim com as quatro armadilhas
juntas (`${x}`, crase, `\n`, `d'água`) e mais um template literal inteiro: **todas sobreviveram**.
Heredoc com o **delimitador entre aspas** desliga toda expansão dentro do bloco; passar a variável
entre aspas duplas **não reexpande** — o shell expande uma vez e para.

**E a correção que importa para a lei:** eu havia escrito *"a verificação de integridade é do
remetente"*. O diagnóstico está certo — quem recebe só vê o que sobrou, então o destinatário não pode
ser o guarda. Mas *"o remetente verifica"* **ainda é uma promessa que alguém tem de lembrar de
cumprir**, às onze da noite, na décima mensagem do dia.

> Com o bloco literal **não há o que lembrar: não existe expansão para acontecer.** A integridade deixa
> de ser **verificação** e passa a ser **propriedade do transporte**.

**Generalização, e ela vale para tudo o que foi escrito hoje:** quando uma lei termina em *"lembre-se
de"*, ela ainda não terminou. É o mesmo movimento do carimbo, do `assert` da §7.44 e do `satisfies` da
§7.48 — **doutrina só protege depois que vira instrumento**, e enquanto for texto ela compete com o
cansaço.

**Nota de rodapé, e ela reforça a lei:** ao enviar a resposta usando a própria receita, eu a quebrei —
dois heredocs com o **mesmo delimitador** no mesmo bloco. A receita é boa; o uso dela ainda tem
superfície. *Instrumento também precisa de instrumento.*

---

## §7.62 — Invariante que não guarda o que o consumidor lê é decorativo

Achado do @QAVivo no **primeiro tiro** do aparato de tela, e verificado por mim contra o banco:

| escrita | banco | tela |
|---|---|---|
| `{activity_ids:[…]}` | **aceita** | *"Sem evidências registradas"* |
| `{factors:[…]}` | **recusa** (`23514`) | — |
| as duas juntas | aceita | aparece |

O `CHECK` soma `activity_ids + message_ids + checkpoint_ids`. O board lê
`ai_probability_evidence.factors`. **A interseção é vazia.**

> **A Lei do porquê está sendo cobrada numa chave que a UI nunca lê.** O score pode nascer *"com
> evidência"* para o banco e *"sem evidência"* para o humano — que é **exatamente a pessoa para quem a
> lei existe**.

E nada obriga a segunda chave: o único payload que satisfaz a constraint **e** aparece na tela carrega
as duas, **por acordo tácito entre dois arquivos que não se conhecem**.

**Conserto:** o `CHECK` passa a exigir **as duas coisas** — pelo menos uma âncora (`activity_ids |
message_ids | checkpoint_ids`) **e** `factors` não vazio. Uma sem a outra produz evidência **ilegível**
(traceável e muda) ou **inrrastreável** (legível e sem destino). Migration com a tríplice, e **limpando
linhas sem `factors` ANTES** da constraint — aqui são 0 de 2, mas um clone pode ter, porque o `CHECK`
nunca exigiu.

### E a parte que dói: isto já estava proibido por escrito

O `CLAUDE.md` deste repositório lista, no item 6 dos anti-patterns: **"`jsonb` lock-in (UI lê path
direto sem schema central)"**. É exatamente isto, e aconteceu assim mesmo.

> A proibição era **texto**. É a §7.59-a aplicada à doutrina mais antiga da casa: **enquanto for texto,
> ela compete com o cansaço** — e perde, porque `jsonb` é justamente onde a checagem de tipo termina e
> nada avisa que dois arquivos discordaram.

**Terceira ocorrência nesta entrega** de duas listas que precisavam concordar morando em arquivos
diferentes (as duas anteriores: vocabulário de `agent_inbox_items`, e o `customer_redact` × `redact`
do LGPD noutra frente). **A recorrência é o argumento**: não é distração de ninguém, é a ausência de um
instrumento.

## §7.63 — Rótulo que promete mais do que a asserção cobre

Erro que o @QAVivo achou **em si mesmo** e que eu quero nomeado, porque é o mais silencioso da família:

> O critério se chamava *"mostra as evidências que existem (2)"* e **não assertava isso** — só checava
> a razão.

**É a §7.48 no NOME em vez de no corpo.** E passa despercebido justamente porque o verde **parece**
cobrir o que o título diz: quem lê o relatório lê o **rótulo**, não a asserção. O nome do teste é a
única parte que a maioria das pessoas vai ler — e é a única parte que nada verifica.

**Regra:** o nome do critério é **contrato com quem lê o placar**. Se ele promete `N`, a asserção conta
`N`. Renomear é tão legítimo quanto assertar — o que não pode é a distância entre os dois.

---

## §7.64 — Quando dois estados produzem a mesma observação, o sistema tem de expor a diferença

Diagnóstico do @Arquiteto sobre a suspeita de regressão no realtime, e ele começou **eliminando o
suspeito que era dele** — com leitura, não com medição:

> A mudança do eco local foi recomendação dele, e a suspeita óbvia era que a marca viva estivesse
> engolindo evento remoto. **Não é:** em `useBoard`, o `qc.invalidateQueries` roda **antes** da
> checagem do eco (linha 75 contra 80). O `return` antecipado pula **só o pulso**, nunca a atualização
> do dado. Hipótese riscada da lista sem gastar rodada.

**O suspeito que sobra é o que produz intermitente por construção:** `useRealtimeChannel` **devolve**
`{ status }` (linha 148), mapeando `SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED`. E `useBoard` o
chama (linha 113) **sem atribuir o retorno**. O hook também não religa.

| estado real | o que se observa |
|---|---|
| a assinatura morreu | **silêncio** |
| nada aconteceu | **silêncio** |

> **O valor que separa duas famílias inteiras de causa existe — e é jogado fora na linha seguinte.**

**E a cronologia fecha sem precisar de bug na Wave 3:** ela acrescentou `crm_lead_activities` à
publicação, ou seja, **aumentou o tráfego de realtime do projeto inteiro**. Mais tráfego eleva a chance
de erro transitório de canal. *A Wave 3 não precisa ter defeito para ter tornado isto mais provável* —
e essa é uma direção de caça diferente de *"o que a gente quebrou"*.

**Regra:** quando dois estados distintos produzem a **mesma observação**, o sistema **expõe a
diferença** — senão toda investigação precisa **reproduzir**, e falha intermitente vira
**infalsificável**. O discriminador mais barato quase sempre já existe: procure o valor que o código
**calcula e descarta**.

**E é dívida pela doutrina desta própria entrega:** assinatura que morre em silêncio é **peça sem sinal
de vida** — o *"log morto"* do checklist, na versão mais cara, porque **a tela continua parecendo
certa**.

### Critério de aceite do quinto marcador (sem gosto envolvido)

Do @Arquiteto, e ele tira o julgamento do terreno da opinião:

> No tamanho **renderizado**, um observador tem de distinguir o marcador do **contato** do marcador do
> **agente** **sem legenda**. Se precisar de legenda para distinguir, **a forma falhou** — e a saída
> **não** é engrossar o tracejado, **é trocar a forma**.

### §7.59-b — O ponteiro evita precisar; o bloco literal protege quando não dá para evitar

O @Arquiteto reordenou a §7.59-a e a ordem dele é a certa. **A evidência estava na nossa frente o dia
inteiro:**

> O problema **nunca apareceu nos contratos**. Ele vinha mandando contrato como **arquivo**, com o
> caminho na mensagem, e **nenhum chegou corrompido** — porque o conteúdo **não atravessa o canal**, só
> o ponteiro. A corrupção aconteceu na **única** vez em que ele embutiu código na própria mensagem.

**Então a regra que fecha isto não é um verbo novo — é a que já usávamos e foi abandonada por preguiça
naquele parágrafo:** conteúdo longo ou código vai em **arquivo**; a mensagem leva o **ponteiro** e o
essencial **descrito**.

| mecanismo | o que faz |
|---|---|
| **ponteiro para arquivo** | **evita precisar** embutir — o conteúdo nunca entra no canal |
| **bloco literal** (§7.59-a) | **protege a execução** quando embutir é curto e inevitável |

> **Instrumento que remove a necessidade vence instrumento que protege a execução.** É a mesma
> hierarquia da §7.36: **produzir estado válido vence validar estado inválido**.

*(E existe o verbo que anexa arquivo: `lina handoff --context <arquivo>` — verificado. Mas `handoff` é
verbo de **delegação**, não de recado, e muda a semântica num board com dono e estado. Fica disponível
para contrato, que **é** uma delegação com contexto; não para conversa.)*

### E o critério de parada da escada de instrumentos

Meu rodapé dizia *"instrumento também precisa de instrumento"* — verdade, e o meu tropeço provou. Ele
apontou que a frase **não tem fundo**: toda camada nova tem superfície nova. E deu o critério que
faltava:

> O critério de parada **não é** *"não sobrou risco"*, é **"o risco que sobrou é menor que o custo da
> próxima camada"**. Com arquivo + ponteiro, o risco que sobra é **escrever o caminho errado** — e esse
> **falha ALTO**: o destinatário não acha o arquivo e **fala**.

> **Falha barulhenta é onde a escada pode parar. Foi a falha SILENCIOSA que nos custou o dia.**

Isso generaliza para **todos** os guardas construídos nesta entrega: o objetivo nunca foi eliminar
risco — foi **converter risco silencioso em risco barulhento**. Um `assert` que aborta, um `CHECK` que
recusa, um carimbo que se acusa de árvore suja, um teste que fica vermelho: todos fazem a mesma coisa,
que é **trocar a falha que ninguém vê pela falha que grita**.

---

## §7.65 — Limpeza que depende do processo sobreviver não é limpeza

Erro do @DevVivo que virou a lei mais operacional da entrega. Ele rodou a sonda com `| head`, o pipe
fechou, o **SIGPIPE matou o processo antes do `finally`**, e a proposta que a sonda tinha removido para
liberar o slot **ficou apagada**. A execução seguinte **não percebeu**: o banco já parecia normal — só
que sem a proposta que existia.

> **Achei porque fui conferir o estado, não porque algo reclamou.**

**A lição não é sobre o `head`, é sobre a FORMA da reposição:**

> `finally` é uma **promessa que só vale se o processo cooperar em morrer**. E **quem morre não repõe,
> por definição.**

**O conserto:** a reposição virou **idempotente e roda na ENTRADA**. A sonda anota um bilhete **antes**
de tirar; a próxima execução repõe pelo que morreu.

| quando anotar | consequência |
|---|---|
| **depois** de mutar | anota o que **talvez não tenha acontecido** |
| **antes** de mutar | no pior caso **repõe o que já estava lá** — o erro **barato** |

**E ele provou matando a sonda no meio**, não afirmando: rodou com `head` de novo, confirmou estado
nulo e bilhete gravado, e a execução seguinte imprimiu *"repus a proposta que uma execução anterior
deixou pendente"* — e o texto voltou.

**Regra:** toda sonda que muta estado precisa de reposição que funcione **sem a cooperação do processo
que mutou**. O padrão anterior (*"limpa o que escreve"*) estava certo na **intenção** e frágil na
**implementação** — e a fragilidade só aparece no dia em que alguém usa um pipe.

### E a fidelidade da reposição: restaurado ≠ reescrito

Ele recuperou o texto **da origem** (`lead_checkpoints.next_action`, seq 100), não inventou um
parecido:

> Repor com texto **aproximado** apagaria a diferença entre **RESTAURADO** e **REESCRITO** — e ninguém
> depois teria como saber qual dos dois aconteceu.

É a mesma família da âncora inventada (§C8) e do lastro que não resolve: **um dado plausível no lugar
certo é indistinguível do verdadeiro, e por isso é pior que um buraco**.

**Nota contra mim:** rodei sondas com `| grep` e `| tail` o dia inteiro. Conferi o banco — **zero**
resíduo. Mas não por método: `grep` e `tail` **consomem o stream até o fim**; foi o `head` que fecha
cedo. **Escolhi o pipe seguro por acaso**, exatamente como o @Arquiteto escolheu as aspas seguras por
acaso (§7.59-a). Duas vezes no mesmo dia a diferença entre incidente e nada foi **sorte na escolha da
ferramenta** — que é precisamente o argumento para tirar a proteção da escolha e pôr no mecanismo.

### §7.54-b — A sabotagem tem de ser a mais PLAUSÍVEL, não a mais errada

Refinamento do @DevVivo comparando as duas mutações que testaram a reconstrução da razão. Ele sabotou
com *"Lead promissor, cliente demonstrou forte interesse"*; eu usei uma versão mais longa e mais
verossímil. O ponto dele:

> **Quanto MAIS razoável a frase, mais o teste importa** — porque é a frase razoável que **passaria
> numa revisão humana**.

Cinco vermelhos contra uma frase que **qualquer revisor aprovaria** é a melhor demonstração possível de
que a garantia **não depende de ninguém estar atento**. Sabotar com algo obviamente errado testa se o
teste existe; sabotar com algo **plausível** testa se ele **substitui a atenção humana** — que é para
isso que ele foi escrito.

**Regra:** ao escolher a mutação, pergunte *"esta versão passaria numa revisão?"*. Se a resposta é não,
a mutação é fraca — ela mede o que o olho já pegaria.

## §7.66 — Duas superfícies do mesmo objeto precisam de um modelo que explique a diferença

Armadilha que o @DevVivo antecipou da Wave 6, antes de haver código:

> O Sheet vai querer mostrar o score **e** a próxima ação **juntos**, sem a precedência do card — e aí
> o usuário vê no dossiê **um número que o card esconde**, sem entender por que os dois discordam.

**A discordância em si está certa** — o slot do card é uma decisão de **orçamento de espaço**, não de
**verdade**. Card e dossiê mostram o mesmo lead em **resoluções** diferentes, e o dossiê tem espaço.

**O problema é que o usuário não tem como saber disso.** Sem um modelo que explique, a leitura natural
de *"o card não mostra"* é *"não existe"* — e aí o dossiê parece contradizer, não detalhar.

> **Duas superfícies mostrando o mesmo objeto com informações diferentes exigem que a diferença seja
> LEGÍVEL.** Se o usuário precisa de explicação verbal para reconciliar duas telas, a interface está
> pedindo emprestada uma memória que ele não tem.

**E isto é evidência para a decisão pendente**, não um problema separado: se o card carregar a faixa na
própria linha da proposta (uma palavra, sem elemento novo), card e dossiê **passam a concordar** — o
card mostra a versão curta, o dossiê a longa. A incoerência some porque deixa de existir, não porque
foi explicada.

---

## §7.67 — A regra não falha por esquecimento; falha por não-reconhecimento

Introspecção do @DevVivo sobre por que o anti-pattern nº 6 do `CLAUDE.md` (*"jsonb lock-in — UI lê path
direto sem schema central"*) aconteceu **estando escrito**, e é a coisa mais profunda dita nesta
entrega:

> *"Eu li aquele arquivo hoje. O que faltou **não foi lembrar da regra** — foi **PERCEBER que eu estava
> naquele caso**: quando escrevi `factors` dentro do `evidence`, o `CHECK` já existia e eu não pensei
> nele como **'outra lista'**, pensei como **'a constraint que já passa'**. A regra estava na minha
> cabeça e **o caso não se apresentou como o caso**."*

**Isto explica por que a §7.59-a é verdadeira.** Doutrina falha **não** porque a pessoa esqueceu — mas
porque **regras são indexadas pelo enunciado e a realidade não chega rotulada**. Ninguém encontra "duas
listas que precisam concordar"; encontra "uma constraint que já está passando" e "um campo novo que a
tela precisa". A mesma situação, dois nomes, e só um deles bate com a regra.

> **Instrumento não depende de reconhecimento.** O `CHECK` não precisa saber que aquilo é "duas listas"
> — ele recusa a escrita. É por isso que instrumento vence memória: **memória exige que você classifique
> corretamente a situação no instante em que está dentro dela**, que é exatamente quando a classificação
> é mais difícil.

**Regra derivada:** ao escrever uma lei, pergunte **como o caso vai se apresentar** a quem estiver
dentro dele. Se o enunciado só é reconhecível de fora, ele não vai ser aplicado de dentro — e precisa
virar instrumento antes de valer.

## §7.68 — Guardar a existência não impede a divergência de conteúdo

O @DevVivo derrubou o meu conserto, e o argumento procede:

> Eu propus que o `CHECK` exigisse **as duas** chaves (âncoras **e** `factors`). Isso guarda a
> **existência** e deixa a **divergência de conteúdo** aberta: quem gravar `activity_ids:[X]` e um
> `factor` com âncora apontando para `Y` **satisfaz a constraint e mente do mesmo jeito**.

**Duas listas obrigatórias continuam sendo duas listas.** O conserto teria trocado *"podem não existir
juntas"* por *"existem juntas e podem discordar"* — que é um caso mais raro e **mais difícil de
detectar**, porque agora ambas passam.

**Ruling: UMA FONTE SÓ.** O `CHECK` exige `factors` não-vazio **e pelo menos um factor com âncora**; as
chaves de arrays de ids **saem** do `evidence` do score. O banco passa a cobrar **exatamente o caminho
que a UI lê** — não há duas listas, então **não há o que divergir**. E a promessa do cenário 15 fica
cobrada **por construção**: *"hover revela"* vira `factors` não-vazio; *"clique leva"* vira pelo menos
uma âncora.

**O preço, aceito com os olhos abertos:** `crm_lead_activities.evidence` (0071) continua com arrays de
ids. **As duas tabelas passam a ter formatos diferentes** — e está certo, porque são coisas diferentes:
**atividade cita FATOS de N tabelas; score cita PARCELAS de um cálculo.** Forçar o mesmo formato foi o
que criou o problema. **Uniformidade de forma entre coisas que significam coisas diferentes é
semelhança acidental, não coerência.**

> **E a diferença tem de ser legível onde alguém tentaria "unificar"** (§7.56): comentário na coluna
> dizendo por que o formato difere e que unificar reintroduz o problema das duas listas. Sem isso, a
> unificação vai parecer limpeza — de novo.

---

## §7.69 — Lei preditiva se paga: a varredura da §7.64 achou duas, e a segunda contradiz o nosso DoD

O @Arquiteto usou a §7.64 como **ferramenta**, não como registro: *procurar o valor que o código calcula
e descarta*. Dois acertos, os dois verificados por mim.

**ACERTO 1 — a cegueira não é do board, é da casa.** Nove consumidores chamam `useRealtimeChannel`;
**sete descartam** o status. Cegos hoje: conversas, mensagens, notas, agent runs, alertas, saúde de
tenant e o buscador de conhecimento. **A caixa de entrada é mais usada que o board.**

> As duas linhas no `useBoard` consertam **a superfície onde a gente por acaso olhou**. E capturar no
> ponto de chamada são **sete chances de esquecer**, mais uma a cada hook novo.

**Ruling:** o sinal de canal morto sai **do HOOK**, não do chamador — um único lugar que, ao entrar em
`channel_error`/`timed_out`, registre. Cobre os nove **e os que ainda não existem**. Mesma escolha do
carimbo, do `assert` e do bloco literal: **instrumento no lugar de promessa**.

*(Nota de método: minha primeira contagem discordou da dele em um ponto. Fui conferir **o meu
instrumento** antes de reportar divergência — meu `grep` não pegava `return useRealtimeChannel(...)`,
que **propaga** o status. Ele estava certo; o meu padrão é que era estreito. §7.35 aplicada a mim.)*

**ACERTO 2 — três dos quatro caminhos engolem a falha de gravar atividade.** Verificado:
`_handler` (edição) e `move/route` (arrastar) fazem **`console.error`**; `bulk/route` não trata; só
`next-action` devolve **500**.

> **O DoD deste épico afirma *"100% das mutações de lead geram `crm_lead_activities`, zero escrita
> anônima"*. Com três caminhos engolindo, isso pode ser silenciosamente MENOS que 100% e ninguém fica
> sabendo** — a linha some da timeline e **nada distingue *"não houve atividade"* de *"não consegui
> gravar"***.

É a §7.64 na letra, **no barramento de que a entrega inteira depende**. E `console.error` em rota de
servidor é o **anti-pattern nº 14 do próprio `CLAUDE.md`** — segunda regra escrita da casa violada hoje,
pelo mesmo motivo da §7.67: o caso não se apresentou como o caso.

### E a inconsistência aponta a regra certa, não a uniformização

Dos quatro caminhos, um falha **alto** e três falham **baixo**. Qual está certo? **Os dois** — e o
discriminador é o **papel** da atividade:

| papel da atividade | falha | por quê |
|---|---|---|
| **é o registro da decisão** (aprovar, ignorar) | **alto (500)** | é a **evidência do consentimento humano**; perdê-la em silêncio é pior que recusar a operação |
| **é o rastro de mutação já ocorrida** (o card já moveu) | **baixo** | bloquear deixaria **o negócio refém da timeline** |

**Mas "falhar baixo" não pode ser `console.error`.** A casa já tem doutrina para exatamente isto, no
audit log (`CLAUDE.md`:66): *"falha de write em audit gera alerta, não bloqueia a mutação principal"*.
O rastro perdido vai para `event_log` + alerta, **pelo mesmo caminho**.

> `console.error` em rota de servidor é a **definição de log morto**: existe, ninguém lê, e o item 4 do
> checklist do sistema vivo reprova. **Falhar baixo é escolher não bloquear — não é escolher não
> contar.**

---

## §7.70 — Intenção não é efeito: pré-condição lida na aba que agiu mede o otimismo

Furo que o @QAVivo achou **na própria sonda da Wave 3**, e é o mais perigoso da entrega porque estava
**dentro da pré-condição**:

> O `12.a` declarava *"a ação aconteceu"* lendo a coluna do card **na aba que agiu** — que é a
> atualização **otimista**, aplicada **antes de qualquer resposta**.

**Consequência:** se a mutação **falhasse**, aquela aba continuaria mostrando o card no lugar novo, o
`12.a` **passaria**, e todo mundo iria caçar realtime **enquanto a escrita nunca aconteceu**.

> A pré-condição da cadeia tinha de ser **"persistiu"** e estava sendo **"apareceu"**. **Intenção não é
> efeito** — e UI otimista é, por desenho, a intenção desenhada antes do efeito existir.

**Regra:** toda pré-condição de cadeia confronta a **fonte**, nunca a superfície que **iniciou** a ação.
Quem age tem interesse: a tela que disparou a mutação mostra o resultado pretendido **mesmo quando ele
não ocorreu**.

## §7.71 — Decompor antes de acusar: três instrumentos cegos lidos como defeito do produto

O alarme de regressão no realtime foi **retirado**, e a forma como foi retirado vale mais que o alarme.
Verifiquei com o **mesmo instrumento** que estabeleceu a falha: **23 verdes, 0 vermelhos** — o evento
chega, o card pulsa, a ação local não pulsa, duas mudanças remotas produzem dois pulsos.

**E ele se recusou a inventar causa:**

> *"NÃO reproduzi a falha que reportei, e não tenho causa. As duas rodadas de antes foram observação
> real naquele momento; **não vou inventar explicação ambiental para fechar a história**."*

Observação não reproduzida **fica não reproduzida**. O que sobra é **instrumento**: a sonda existe e,
na próxima vez, responde em cinco minutos **qual elo caiu** em vez de abrir uma caça.

**Os três erros que ele achou na própria sonda são todos do mesmo tipo — instrumento cego lido como
defeito do produto:**

| erro | o que teria sido reportado |
|---|---|
| contador procurava `'event':'UPDATE'`; o quadro real diz `'type':'UPDATE'` | *"a entrega falhou"* — **sobre uma entrega viva** |
| alvo de `limit(2)` e destino = estágio do 2º lead; caindo no mesmo estágio, o elo era **pulado em silêncio** | *"zero quadros"* — **sem nada ter sido disparado** (o alvo sorteado que ele apontou em sonda alheia de manhã) |
| o arrasto por teclado não engatou | *"zero quadros na aba B"* — **idêntico** ao que se vê quando a entrega falha |

> **Os três só apareceram porque ele decompõe antes de acusar.** Reportar no primeiro sinal teria
> mandado o @DevVivo caçar um defeito inexistente — **três vezes**.

**A cadeia que ele instrumentou** (token responde · o token **vale**, com `role`/`sub`/validade
decodificados · o join entra **com identidade** · a entrega chega · o card **anda**) é o que converte
*"o realtime não funciona"* — afirmação inútil — em **qual elo**. E o elo 2 existe porque `200` **não é
token bom**: a versão anterior provava que a resposta não era cacheada e chamava isso de prova.

---

## §7.72 — Dois instrumentos para a mesma pergunta, um deles quebrado, fabrica vermelho falso

O @QAVivo **removeu** uma sonda dele (`9128a6a`): a sonda do canal tinha um elo *"mudança nascida na UI
de outra aba"* com arrasto por teclado escrito à mão — **e o dele não engatava, a rota nem era
chamada**. E *"zero quadros na aba B"* é o que se vê **tanto** quando a entrega falha **quanto** quando
nada foi movido.

> **Dois instrumentos para a mesma pergunta, um deles quebrado, é como se fabrica um vermelho falso.**

**E isto NÃO contradiz a §7.35** (instrumentos independentes concordando é evidência) — a distinção é
**quem pode disparar sozinho**:

| arranjo | efeito |
|---|---|
| instrumentos independentes que você **compara** | concordância é **evidência**; divergência manda **voltar a medir** |
| instrumentos independentes que **cada um pode acusar sozinho** | cada um é **uma chance a mais de falso alarme** |

**Redundância só é segurança quando é confrontada.** Sem confronto, ela é **superfície**. Ele deixou a
travessia entre abas **num aparato só** — o que tem o helper que funciona **e** a guarda de que a ação
**persistiu** (§7.70).

### E uma decisão de desenho que se pagou sem ninguém tocar nela

O aviso de contaminação (exigir `band` mudou o que o card renderiza) **poderia** ter envenenado o
`12.d.visivel`, que **compara pixels**. Não envenenou, por uma escolha antiga:

> Ele compara **DURANTE × DEPOIS**, não **antes × depois**. Um card que perdeu o medidor **perde nas
> duas fotos igualmente** — então a diferença continua sendo **só o overlay do pulso**.

A escolha foi feita por outro motivo (*"comparar duas fotos com mais de uma variável mudando é teste
confundido"*) e protegeu contra uma contaminação **que ainda não existia**. É o que desenho bom faz:
**paga em situações que não foram previstas**. Guarda escolhido pelo princípio certo cobre casos que o
autor não imaginou; guarda escolhido para passar no caso de hoje cobre exatamente o caso de hoje.

### O fecho do incidente, e ele é o que a §7.71 pede

`23/0/0` no aparato completo, `5/5` no cenário de duas abas com tenant B, e a cadeia do canal medida
elo a elo — com **status e identidade na mesma linha**: `data-realtime-status=subscribed` **ao lado de**
`role=authenticated` lido do JWT no quadro de join.

> **O status diz que CONECTOU; o JWT diz QUEM. Sozinho, nenhum dos dois fecha.**

E o que ele **não** sabe continua dito: a falha original **não foi reproduzida** e **não há causa**.
Duas rodadas determinísticas aconteceram, e nenhuma explicação ambiental foi inventada para fechar a
história.

---

## §7.73 — A cura da morte silenciosa pode criar uma morte silenciosa nova, e ela é pior

Ponto central do contrato da Wave 7, do @Arquiteto, e é **recursivo**: a wave existe para fazer o
estado *"esfriando"* virar **demanda**. E a demanda que ela cria **também pode morrer**.

> Proposta de reativação que ninguém decide **fica pendente para sempre**, e o lead volta a ser card
> parado — **agora com um botão em cima, o que é pior, porque parece que alguém está cuidando**.

**A doença do épico, vestida de cura.** E é mais cara que a original: um card parado **sem nada** é
legível como abandono; um card parado **com uma proposta pendente** simula atenção, e simulação de
atendimento adia a intervenção humana em vez de provocá-la.

**Regra:** proposta pendente **tem prazo**, e vencida vira **item de caixa** — mesmo destino e mesmo
motivo da ambiguidade da Wave 4: **demanda sem dono não mora no Kanban**. Não expira em silêncio e não
fica no card fingindo que alguém vai decidir.

> **Toda solução para "algo morre sem ninguém ver" precisa responder o que acontece quando a própria
> solução não for atendida.** Se a resposta for "fica lá", a solução é um adiamento com interface
> melhor.

### E a wave é MENOR do que o briefing sugere — porque alguém foi medir

Ele mediu em vez de assumir o §4, e **metade já está entregue**. Verifiquei os três:

| item | estado | evidência |
|---|---|---|
| reconciliação da §3.3 (radar × card) | **feito** | `at-risk/route.ts` usa `classifyRisk` + `resolveStageWindow`, com o comentário *"para o radar e o card nunca discordarem do mesmo lead"* |
| esfriando visível no card | **feito** | `coolingIds` sai de `useAtRiskLeads` e desce até `StageColumn` |
| precedência do cenário 24 | **feito** | `resolveCardState` devolve `awaiting` antes de `cooling` |
| **o ciclo** | **falta** | **zero** consumidores de *cooling/at_risk* no engine ou no follow-up |

> *"Hoje **esfriando** é só um ESTADO VISUAL: nada nasce dele."* — confirmado por varredura.

**Medir antes de despachar encolheu a wave inteira.** O briefing descrevia o escopo pelo que **faltava
quando foi escrito**; o repositório respondeu o que falta **agora**. Contrato herdado sem medição
manda construir o que já existe.

### A proposta nasce de TEMPLATE, não de modelo

Aceito, e a ordem dos motivos dele é a certa: **custo sem retorno** (uma chamada de modelo por lead
frio para produzir proposta que talvez ninguém aprove — e leads frios são, por definição, a maior e
mais parada população da base); **auditabilidade** (template versionado diz **qual versão** produziu
aquela frase; texto de modelo não diz nada); **determinismo** (o cenário 23 fica reproduzível).

E há um quarto que fecha com a Wave 5: **o template é a derivação**. A §7.54 estabeleceu que prosa
gerada não é auditável porque não se reconstrói; um `reentry_template_version` é exatamente o
equivalente — a frase tem **procedência verificável**. O modelo entra **depois do aceite**, no
`followup_turn` que a Wave 4 já enfileira.

---

## §7.74 — Migration reaplicada isoladamente é viagem no tempo que não volta sozinha

O invariante novo (o par `{coluna jsonb, chaves que o CHECK guarda × chaves que o código lê}`)
**pagou-se na estreia**, achando uma contaminação que ninguém sabia existir — e ela era da Wave 3.

**Verificado:** `lead-activities-barramento.test.ts` reaplica a migration **0071** para provar o
backfill dela. Mas a 0071 faz `drop constraint if exists` + `add constraint` de
`crm_lead_activities_ai_needs_evidence` **com apenas `run_ids` e `trace_ids`** — e a **0072** existe
justamente para acrescentar `llm_call_ids`.

> Reaplicar a 0071 **DESFAZ a 0072** para todos os testes que rodam depois no mesmo container. O banco
> de teste ficava numa versão **que o repositório já não tem**, e qualquer invariante posterior media
> **o passado sem saber**.

**Regra:** teste que reaplica uma migration para provar o efeito dela precisa reaplicar **tudo o que
veio depois e tocou os mesmos objetos** — senão deixa o banco no passado.

**E o preço é assimétrico, que é o que torna isto caro:**

> **Quem contamina passa. Quem mede depois falha. E a investigação começa no lugar errado** — olhando a
> vítima, que é o código mais novo e portanto o suspeito natural.

## §7.75 — Quando o novo passa isolado e falha em conjunto, o problema quase nunca é o novo

Nota de método do @DevVivo sobre como chegou lá, e ela vale mais que o achado:

> O `CHECK` estava certo no dev, certo no install fresco, certo depois do update, e o invariante
> **passava isolado (3/3)**. Falhava **só na suíte**. Isso deixa **uma** explicação — outro teste mexe —
> e ela estava **a um `psql` de distância**: medir a constraint **antes** e **depois** de rodar o
> arquivo suspeito.

**Ele levou quatro tentativas erradas antes dessa**, procurando erro **no próprio extrator** — o
suspeito natural, porque era código novo.

> **"Quando o novo passa isolado e falha em conjunto, o problema quase nunca é o novo."**

É o **inverso do instinto**, e o instinto tem uma explicação: o código novo é o que mudou, então parece
a causa. Mas *"passa sozinho, falha acompanhado"* é a **assinatura de contaminação sofrida**, não de
defeito próprio — o novo é a **vítima**, e é vítima justamente porque é o único que ainda não tinha
aprendido a conviver com o estado que os outros deixam.

**Discriminador barato, e é sempre o mesmo:** meça o estado **antes e depois** de rodar o suspeito. É a
§7.30 (*sem o antes, todo depois é compatível com o acaso*) aplicada a **testes que compartilham
ambiente** em vez de a sondas.

---

## §7.76 — Canal de telemetria entupido faz ausência de erro parecer ausência de problema

Conexão do @DevVivo sobre o achado lateral dos `429`, e ela **reabre uma conclusão** que eu tinha dado
por fechada.

O incidente do realtime fechou **sem causa** (§7.71). Mas o túnel do Sentry estava respondendo **429**.
Se o caminho de reporte está barrado por volume, **erro do board pode não ter chegado lá** — e o
sintoma investigado tinha exatamente a assinatura de um **erro silencioso no cliente**:
`CHANNEL_ERROR` capturado e reportado, ou uma exceção no `onChange` morrendo no handler.

> ***"Não apareceu nada no Sentry"* precisa sair da lista de argumentos até o 429 ser entendido.**
> Ausência de sinal por **canal entupido** tem exatamente a mesma cara de ausência de problema.

**É a §7.64 aplicada à telemetria** — e é a aplicação mais cara dela, porque a telemetria é **a camada
que existe para distinguir os dois estados**. Quando ela cai, todas as outras investigações herdam a
ambiguidade sem saber.

**Isto não explica a falha.** Explica **por que não temos rastro dela** — e reclassifica o *"sem
causa"* de *"nada aconteceu"* para *"podemos ter perdido a evidência"*. As duas frases levam a ações
diferentes: a primeira encerra, a segunda manda consertar o canal antes do próximo incidente.

**Regra:** antes de tratar ausência de erro como evidência, **prove que o canal de erro estava
aberto**. Telemetria não medida é telemetria suposta — e o único jeito de ter fé nela é ela **se
reportar viva**, como qualquer outra peça (item 4 do checklist do sistema vivo).

### E a contaminação de schema pode ter atravessado a investigação

Ele conectou o próprio achado da §7.74 à caça: **se alguma sonda roda depois de um teste que reaplica
migration, ela pode estar medindo um schema do passado.** Vale conferir a ordem de execução antes de
confiar em qualquer vermelho que dependa de schema — inclusive os já arquivados.

---

## §7.77 — A resposta a um incidente não reproduzido é instrumentar, não caçar mais

O @QAVivo usou o tempo depois do alarme retirado no lugar certo. A frase que decide:

> **O problema de hoje não foi a falha: foi ela ter voltado sozinha levando junto o estado que a
> explicaria.**

Incidente não reproduzido não se resolve caçando com mais empenho — **a janela em que a evidência
existia já fechou**. O que se pode fazer é garantir que **a próxima ocorrência nasça explicada**.

O estado do canal da aba B passa a ser **coletado sempre** e impresso quando a entrega falha: status
declarado na tela, quantos *joins*, se levaram `access_token`, que papel o JWT diz, quantas respostas,
quantos quadros chegaram.

> **Registro que só guarda o sintoma condena a próxima pessoa a repetir a caça inteira.** A diferença
> entre um relatório que diz *"não chegou"* e um que diz **qual elo caiu** é a diferença entre uma
> tarde e cinco minutos.

## §7.78 — Diagnóstico que nunca rodou é diagnóstico não testado

E o coletor **é exercitado**: `DIAG=1` imprime **no caminho feliz** (verificado — a linha só suprime o
diagnóstico quando o evento chegou **e** `DIAG` não está ligado).

> **Descobrir que o coletor estava quebrado NO DIA da falha custaria a única janela em que o estado
> existia.**

É a mesma lógica do `SELFCHECK` da cerca (§7.38): **instrumento que nunca foi exercitado é promessa,
não instrumento**. E vale mais para diagnóstico do que para teste, porque diagnóstico **só roda quando
já é tarde** — o único momento em que ele é usado é o único em que não dá para consertá-lo.

**E ele achou dois descuidos nesse trecho pequeno**, os dois da família do dia: o diagnóstico era
**calculado e só interpolado no ramo de falha**, então `DIAG=1` não mostrava nada. **Cálculo sem
destino** — idêntico ao carimbo que voltava vazio. *Achou porque rodou o modo forçado em vez de confiar
que funcionava.*

### Fecho da §7.67 — a versão dele é mais dura, e encerra a doutrina do dia

> *"Eu apontei o alvo sorteado em sonda alheia de manhã e escrevi o meu à tarde. Conhecer a armadilha
> não imuniza porque, **no momento do erro, ela não parece a armadilha** — parece 'pegar um lead
> qualquer para disparar'. O que imuniza não é lembrar da regra, é **o instrumento se recusar a rodar
> sem alvo determinístico**."*

> **Regra na cabeça compete com pressa. Regra no código, não.**

É o fecho de tudo o que foi escrito hoje. As 80+ seções deste documento **não protegem ninguém
enquanto forem texto** — protegem quando viram `assert`, `CHECK`, `satisfies`, carimbo, `SELFCHECK`,
bloco literal, ponteiro para arquivo. **A doutrina é o rascunho do instrumento**, e o instrumento é a
única parte que sobrevive ao cansaço.

---

## §7.79 — Toda ponte tem duas direções, e o contrato costuma descrever uma

Achado do @Arquiteto no contrato da Wave 8, e é o de maior dano dos oito porque **o briefing não faz a
pergunta**.

O §4 descreve a ponte num sentido só: **agente avança, card anda**. Falta o inverso: **e quando o
humano move o card?**

**Verificado:** `LEAD_STAGE_TRANSITIONS` é estritamente para a frente
(`new→contacted→qualifying→qualified→negotiating→won`, mais `lost`) — **não existe retrocesso**. Logo,
depois de um movimento manual para trás, os dois funis divergem, e **no próximo avanço do agente o
espelho desfaz a colocação do humano sem aviso nenhum**.

> O vendedor arrasta para *"Proposta enviada"*, volta dez minutos depois e **o card está em outro
> lugar**. Ninguém errou e ninguém consegue explicar — a assinatura do defeito que **ensina
> desconfiança**, a mesma família do 409 fantasma (§7.39).

**Regra:** **quando há conflito, o espelho PROPÕE — não sobrescreve.** É a lei que já governa a
entrega inteira: quando o alvo é ambíguo, não adivinha (§3.2); nada é feito em nome do humano sem ele
(Wave 4).

> **Sobrescrever é adivinhar que o agente sabe mais do que quem arrastou o card.**

**E a detecção não precisa de coluna nova** — é uma pergunta ao barramento da Wave 3: *existe atividade
`stage_changed` com `actor_kind='user'` mais recente que a última com `actor_kind='ai'`?* Se sim,
conflito, e o espelho escreve no **slot da Wave 4** (*"Agente sugere mover para Negociação"*) em vez de
mover. **Terceira wave seguida em que o barramento paga o que custou.**

**Generalização:** todo mecanismo que sincroniza dois sistemas precisa responder **"e quando o outro
lado muda?"**. Contrato que descreve a sincronia num sentido só não está incompleto — está **errado**,
porque o sentido omitido vai acontecer de qualquer jeito, só que **sem regra**.

### E a mesma FK, decisão oposta, pelo motivo certo

Ele contrariou **a própria decisão da Wave 1**, de propósito: aqui é `ON DELETE SET NULL`, não
`RESTRICT`.

| Wave 1 — `owner_agent_id` | Wave 8 — `crm_lead_id` |
|---|---|
| o dono é **identidade**: não pode sumir | é **atalho** (§3.2), não identidade |
| `RESTRICT` | `SET NULL` — o estado cognitivo do contato continua válido, e o ponteiro é **recalculável** por `resolveActiveLeadForContact` |

> Impedir o delete seria **dar ao atalho o peso de dono** — e o §3.2 diz exatamente o contrário.

**Mesmo mecanismo, decisão oposta, porque o significado difere.** Consistência de mecanismo entre
coisas que significam coisas diferentes é a mesma **semelhança acidental** da §7.68.

---

## §7.80 — "A rota não emite" e "o tipo não existe" são diagnósticos diferentes

Eu afirmei que editar um campo não gera atividade, medindo **a rota**. O @QAVivo verificou pelo
**vocabulário** — a fonte única de escrita e leitura, **exaustiva por construção** — e o diagnóstico
mudou de natureza. Verificado: **sete tipos**, e nenhum é *"o humano mudou um campo"*.

| diagnóstico | natureza | custo |
|---|---|---|
| *"a rota não emite"* | **esquecimento** | uma linha |
| *"o TIPO não existe"* | **estrutural** | **não há o que emitir** |

E o segundo tem uma consequência que o primeiro não tem: criar o tipo **força um rótulo** (o mapa é
`Record<ActivityType, string>`, fechado pelo compilador) — e portanto **força alguém a decidir como
isso se chama para o usuário**. O cenário 20 não pede código novo; pede **vocabulário novo**.

### E a assimetria tem origem: o vocabulário cresceu por um lado só

**Cinco dos sete tipos nascem do que a IA faz** (`ai_turn`, `send_vetoed`, `handoff_triggered`,
`next_action_approved`, `next_action_dismissed`).

> **A IA deixa rastro; o humano, não.** Numa entrega cujo contrato é continuidade IA↔humano, **quem
> some do registro é justamente o lado que precisa ser auditável quando algo dá errado — e é o lado que
> responde por decisão.**

**Vocabulário que cresce por um lado só registra um lado só**, e a falta não se anuncia: cada tipo novo
parecia necessário quando foi criado, e nenhum momento apresentou a pergunta *"e o outro lado?"*. É a
§7.67 numa escala maior — não é o caso que não se apresenta, é **a ausência** que não se apresenta.

### As quatro armadilhas que ele encodou, e cada uma tem seu jeito de ficar verde à toa

| cenário | a armadilha |
|---|---|
| **18** — o dossiê abre | *"o Sheet abriu"* **não é o cenário**: o cenário é a **ORDEM**, e ordem se mede por **posição vertical**, não por presença. Três seções fora de ordem passariam numa asserção de presença. |
| **19** — colapso | precisa de **caso E vizinho**: três eventos do mesmo ator para agrupar **e um de outro ator ao lado**. Sem o vizinho, *"colapsou"* não distingue **agrupar** de **esconder**. |
| **19** — colapso | e se prova pelo **NÚMERO**: o bloco diz quantos, e expandir revela **exatamente esses**. *"Aparece menos linha"* também é o que se vê quando a timeline **perdeu eventos**. |
| **20** — editar | **duas metades que falham separado**: salvar pode funcionar **e** o registro não existir. Asserta o valor persistido **e** a linha com ator humano. |

**E o banco barrou o seed dele, e estava certo:** `crm_lead_activities_ai_needs_evidence` recusou uma
atividade de IA sem `run/trace/llm_call`. **A lei do porquê vale também para o REGISTRO**, e a
constraint fez o trabalho dela contra um cliente descuidado — o próprio autor do teste. *E não é o caso
do score: aqui a chave que o banco exige é a mesma que o consumidor usa.*

---

## §7.81 — Limitação de ferramenta empurra para o desenho errado, e chega disfarçada de pragmatismo

*"Pelo menos um fator **com** âncora"* parece exigir **subconsulta**, e `CHECK` não aceita. O movimento
óbvio é recuar para **duas listas paralelas** — que é **exatamente o desenho que a §7.68 acabou de
matar**.

A saída foi **jsonpath** (verificado no banco):

```
ai_probability_evidence @? '$."factors"[*]."ancora"'::jsonpath
```

É **expressão, não subquery** — e é o que permite exigir a âncora **dentro do fator** em vez de numa
lista paralela.

> *"Sem isso eu teria sido empurrado de volta para as duas listas **por limitação de ferramenta**."*

**Regra:** quando a ferramenta parece proibir o desenho certo, o recuo disponível costuma ser **o
desenho errado** — e ele chega **disfarçado de pragmatismo**, porque "o banco não deixa" soa como
restrição da realidade e não como falta de procura. **Procure a saída antes de ceder**; e se ceder,
registre que cedeu **por limitação**, não por escolha — senão o próximo lê o desenho ruim como
deliberado.

## §7.82 — Instrumento vence também a INTENÇÃO CORRETA MAL EXECUTADA

Este é um eixo **novo**, e o @DevVivo o nomeou sobre si mesmo. A §7.67 dizia que doutrina falha por
**não-reconhecimento** — você não vê que está no caso. Aqui:

> *"Eu **SABIA** a regra da tríplice, **escrevi o código para cumpri-la**, e ainda assim entreguei
> incompleto — porque o erro não foi de conhecimento, foi de **execução parcial que passou
> despercebida**."*

O `MANIFEST` ficou sem a linha da 0077 porque o script **abortou antes de escrevê-la**. Quem pegou foi
o **pre-commit da tríplice indivisível** — *"o guard achou exatamente o que o meu script deixou pela
metade, sem eu saber que tinha deixado"*.

> **Instrumento não só vence memória; vence também a intenção correta mal executada — um modo de falha
> que memória nenhuma cobre**, porque a memória estava **certa**. Não há o que lembrar melhor.

**E os outros dois erros da mesma sessão têm a mesma forma — script que falha em silêncio:**

| erro | o que teria acontecido |
|---|---|
| o script que reescrevia o baseline **falhou calado** | `test:db` passou **338 medindo o baseline ANTIGO** — **verde sobre o estado errado**, e ele teria reportado sucesso com a migration só no dev |
| a correção seguinte **cortou uma linha a mais** | `drop constraint` órfão, que **só apareceu no install** |

O primeiro é o mais assustador: **a suíte inteira verde, medindo o artefato errado**. É a §7.42 pelo
avesso — lá o defeito só aparecia no banco novo; aqui o **acerto** só aparecia no banco novo, e o
ambiente de todo dia dizia que estava tudo bem.

> **Os três só apareceram porque ele rodou em vez de supor.** Script que faz três coisas e falha na
> segunda deixa a primeira feita e a terceira ausente — e nada nessa combinação **parece** erro.

---

## §7.83 — Antes de dar significado novo a um símbolo, verifique o que ele já carrega

**Eu decidi errado e o @QAVivo pegou antes de existir código** — que é exatamente por que o aparato foi
armado primeiro.

Aceitei do @Arquiteto que o quinto ator (`contact`) ganhasse marcador **tracejado**, pelo motivo de que
*"é o único ator fora da organização"*. O motivo é real. **Mas eu não verifiquei o que o tracejado já
significa.** Medido:

```
actorShape:  user | contact → "filled"      ← contato JÁ é gente
             ai             → "ring"
             system | rule  → "dashed"      ← "nem gente nem agente"
```

O eixo que a forma codifica é **gente / agente / máquina**. Mover o contato para tracejado **põe uma
pessoa no balde das máquinas** — e não elimina colisão: **troca *"duas pessoas com a mesma forma"* por
*"uma pessoa junto de duas máquinas"***.

**E o meu próprio critério já estava satisfeito:** *distinguir contato de agente sem legenda* —
preenchido contra anel, hoje. **Pedi uma mudança que não era necessária e que quebraria um sistema
coerente.**

> **Ruling revertido: `contact` permanece `filled`.** A forma codifica gente/agente/máquina; **quem
> especificamente** fica no **texto ao lado** — exatamente como a distinção `user` × `rule` já faz.

**Regras que ficam:**

1. **Antes de atribuir significado novo a um símbolo, leia o significado que ele já carrega.** Um
   símbolo com semântica declarada não é espaço livre — é vocabulário em uso.
2. **Critério já satisfeito não justifica mudança.** Eu estabeleci um teste, ele passava antes da
   mudança, e mesmo assim mandei mudar. O teste existia para **aprovar**, e eu o usei como se fosse
   uma **exigência de alteração**.
3. **E a doutrina do módulo estava escrita e contra a decisão:** *"um quarto desenho obrigaria o
   usuário a decorar um alfabeto no kanban e outro na timeline, para dizer o que a palavra já diz."*
   Se um dia a decisão mudar, **o comentário muda junto** — senão volta a doença do dia (código e
   comentário discordando).

**Nota factual:** o quinto ator tem **zero linhas** no banco (`user` 173, `ai` 3; `contact`, `system` e
`rule` não existem em dado). Qualquer prova visual dele exige **caso construído** — e isso precisa
estar declarado na evidência, senão a captura sugere um fluxo que ninguém exercita.

### E o instrumento que só o uso real revelaria

O @QAVivo encodou o ponto do Sheet do único jeito que funciona: **abrir e fechar uma vez não revela
assinatura órfã — canal órfão só incomoda quando ACUMULA.** Então o teste abre e fecha **cinco vezes**
e compara `phx_join` com `phx_leave` no socket. Se desassina, cada entrada tem a sua saída; **se não, a
diferença é o vazamento, em número.**

**E a régua para "o dossiê mostra mais que o card" ficou operável:** *contradição é **a mesma grandeza
com valor diferente*** (card diz 72%, dossiê diz 65%). Mostrar o que o card escondeu **por orçamento de
espaço** é **mais informação**, não contradição — e não reprova.

---

## §7.84 — Entregável que mora fora do git não existe para o próximo

**Quarta ocorrência do mesmo padrão nesta entrega**, achada pelo @Arquiteto e verificada por mim:

```
git ls-files docs/architecture/  →  agent-turn.html, agent-turn.workflow.json
git ls-tree origin/main          →  os mesmos dois
ocorrências de owner_kind, actor_kind, ai_probability, next_action,
crm_lead_activities, agent_stage_hint no que ESTÁ rastreado  →  ZERO
```

O mapa vivo do sistema **existe no disco** (worktree principal) e **está fora do git**. O único mapa
versionado é o do turno do agente — **ele nem cobre o lado CRM**.

### E isso muda o diagnóstico do checklist, que é por que não é reclamação

No worktree do CRM Vivo esses arquivos **não existem**. Então o item 7 do `sistema-vivo`
(*"atualizei o mapa vivo?"*) **não foi negligenciado** nas waves 1–5 — **era inatendível**. E o DoD 13
do `CLAUDE.md` está aberto pela mesma razão.

> *"Não atualizado"* lê-se como **desleixo**. *"Inatendível"* é outro diagnóstico e aponta para outro
> conserto. **Registrar a diferença é o que impede a próxima pessoa de procurar culpa onde havia
> impossibilidade.**

### O agravante, e é o que torna esta a pior da família

> **A evidência local faz parecer cumprido.** Você olha a pasta, vê o arquivo, marca o item — e o
> check passa **sobre um estado que só você enxerga**.

É a §7.28 pelo outro lado: lá, *o guarda só tem poder sobre documento versionado*; aqui, **o entregável
que não é versionado não existe** — e as duas frases são a mesma moeda. Nas outras três ocorrências de
hoje (o `BRIEFING`, os dois `HANDOFF`, o aparato das sondas) a cura foi a mesma: **versionar primeiro e
deixar o instrumento cobrar**.

**Regra:** ao fechar qualquer item de DoD que aponte para um artefato, a pergunta não é *"o arquivo
existe?"* — é **`git ls-files`**. Artefato é entregável; entregável mora no repositório; **o que mora
só no disco é rascunho, por definição, independentemente de estar pronto.**

---

## §7.85 — O mesmo mecanismo pode ser errado como política e certo como última linha

Eu disse que *"falhar baixo não pode ser `console.error`"*. O @DevVivo implementou com um cuidado que
eu não tinha especificado, e ele está certo:

> O `console.error` **não sumiu — desceu de política para segunda linha**. Se até o `event_log`
> falhar, o log do processo é tudo o que sobra — **e aí ele está certo, porque o próprio canal de aviso
> morreu**.

> ***"A diferença entre 'primeira linha' e 'última linha' é exatamente o que faltava: antes, a única
> linha era a que não conta."***

**Banir o mecanismo teria removido a única coisa que sobrevive quando tudo mais falha.** A regra não é
*"nunca use X"* — é **"X não pode ser a política; X é o que resta quando a política falha"**. Um
anti-pattern costuma ser um mecanismo **na posição errada**, não um mecanismo ruim.

## §7.86 — Campo ausente lê-se como "não tentou"; campo nulo lê-se como "tentou e não sei"

Caso que só aparece em runtime, e ele cobriu: `undefined` **some do JSON**, então o alerta chegaria
**sem o campo** — *"como se ninguém tivesse tentado descobrir a causa"*. Virou `null` **explícito**
(`erro: f.erro ?? null`).

> **Ausência e desconhecido são afirmações diferentes, e o JSON as colapsa** a menos que você seja
> explícito. Quem lê um alerta sem o campo de causa conclui que **o diagnóstico não foi feito**; quem
> lê `causa: null` sabe que **foi feito e não achou** — e a segunda leitura muda o que a próxima
> pessoa vai investigar.

É a mesma distinção que o épico já paga em outro lugar: `score = null` significa *"não sei"* e
`score = 0` significa *"calculei e deu zero"* (§Wave 5). **A lição repete porque a linguagem esconde a
diferença por padrão.**

### E o bulk era o pior dos três, por um motivo que os outros não têm

`N` leads movidos, e **uma** falha de atividade sumia junto com as `N−1` que deram certo. Não é só
*"não contava"*:

> **O buraco na timeline não tinha nem TAMANHO CONHECIDO**, porque a operação inteira reportava
> sucesso.

Falha parcial dentro de um lote que reporta sucesso **colapsa "algumas falharam" em "todas
funcionaram"** — e a perda deixa de ser mensurável, não só de ser vista.

### Emenda à §7.76 — encerramento por ausência de evidência fica provisório

Nota dele, e ela é melhor que a minha formulação:

> O valor prático da §7.76 **não é** saber que o Sentry estava com `429`. É que ***"sem causa
> encontrada"* passa a significar coisas diferentes conforme a telemetria esteja de pé ou não.**
> Enquanto o `429` não for entendido, **todo encerramento por ausência de evidência neste board fica
> provisório.**

Isso **reclassifica um incidente já arquivado** (§7.71) sem reabri-lo: ele continua fechado, e o
fechamento carrega uma ressalva escrita. **Fechar com ressalva é diferente de fechar** — e a diferença
só existe se estiver registrada.

---

## §7.87 — O buraco com recibo é pior que o buraco

Eu tinha ligado o `console.error` ao script que falha calado (§7.82): mesma forma — a intenção existe,
o código existe, o efeito não acontece. O @DevVivo acrescentou a diferença, e ela inverte a gravidade:

| falha | o que acontece |
|---|---|
| script que falha calado | **aborta** — deixa a terceira parte ausente, e o guard pega |
| `console.error` | **completa com sucesso** — a rota devolve `200`, o usuário vê o card mover |

> **Script que falha calado deixa um buraco. `console.error` deixa um buraco E UM RECIBO DE QUE DEU
> TUDO CERTO.**

O recibo é o que torna a segunda pior: não há sintoma para investigar, e **o único prejudicado é o
registro que ninguém vai procurar hoje** — só daqui a três meses, quando alguém perguntar por que a
timeline tem um vão.

## §7.88 — O que segurou a decisão certa foi PROXIMIDADE, não caráter

Correção que ele fez **sobre si mesmo**, para a §7.81 não ficar com o crédito errado:

> *"Eu não 'não cedi' por disciplina. Tentei a subconsulta, o Postgres recusou, e a primeira coisa que
> me passou pela cabeça foi **'então volto para os arrays de ids'**. Só não voltei porque tinha acabado
> de escrever, no commit anterior, **por que** as duas listas eram ruins — o texto estava **a dois
> minutos de distância**. Se a 0076 tivesse sido semana passada, **eu teria cedido e chamado de
> pragmatismo**."*

> **O que o segurou foi proximidade, não caráter.**

E isso **reforça** a §7.56 em vez de enfraquecê-la, acrescentando a dimensão que faltava: o aviso não
precisa só estar **onde** a pessoa vai olhar — precisa estar **recente o bastante para ainda estar ao
alcance**. Motivo escrito **junto do desenho** é o que impede alguém de desfazê-lo quando a ferramenta
empurra; motivo escrito **em outro lugar, semanas antes**, perde para o cansaço da tarde.

> **Registrar o porquê junto do desenho não é documentação — é a única forma de o argumento ainda estar
> presente no instante da tentação.**

## §7.89 — O verde declara o que mediu, não o que você queria medir

O erro que mais o incomoda, e a análise dele é a mais precisa da entrega:

> *"Suíte inteira verde medindo o artefato errado. **O verde não mentiu sobre o que mediu** — mediu
> certo o baseline antigo. **Mentiu sobre o que eu achava que estava medindo**, e essa distância não
> aparece em lugar nenhum do output."*

O instrumento foi **honesto**. A lacuna está entre **o artefato medido** e **o artefato pretendido** —
e **nada no resultado carrega essa distância**. Nenhum grau de rigor no teste corrige isso, porque o
teste está certo.

**E a cura já existe no nosso próprio aparato, aplicada no lugar errado:** o `carimbo` das sondas
declara **contra qual commit** e **com quais dependências sujas** aquela medição vale. É exatamente
esta lei, aplicada a sondas — e **não aplicada à suíte**.

> **Proposta dimensionada:** `test:db` declara o **hash do `baseline.sql` que aplicou**. Uma linha no
> começo do output. Com ela, *"338 passed"* deixa de ser um número solto e passa a ser **um número com
> sujeito** — e o dia em que o script de reescrita falhar calado, o verde vai vir **com o hash
> antigo** e a distância aparece **sem ninguém precisar suspeitar**.

---

## §7.90 — O cano de leitura faz parte do instrumento, e é onde a evidência morre

O @QAVivo registrou o que quase todo mundo descartaria: numa rodada o placar deu **22/1** e **ele não
sabe qual critério falhou** — porque **o próprio `grep` dele filtrou a linha da falha para fora da
saída**.

> **O aparato mediu certo. A LEITURA é que perdeu o dado.**

É um modo de falha distinto de *"o teste é fraco"*: o instrumento de **medição** funcionou, e o
instrumento de **observação** descartou o resultado. E é a mesma família do meu `| grep` de manhã, que
mascarou um código de saída — **duas vezes no mesmo dia, o cano de leitura comeu a evidência**.

**Regra:** filtro sobre saída de teste é parte do instrumento e precisa da mesma disciplina — **capture
tudo que NÃO passa**, nunca só o que você foi procurar. Filtro escrito para achar uma coisa **decide
sozinho** que o resto não importa.

### E ele registrou o que não conseguiu explicar

> *"Houve um vermelho, não sei qual foi, não se repetiu em duas tentativas. Registro porque **'apareceu
> e sumiu' é exatamente o tipo de coisa que a gente perde quando só anota o que fechou bem**."*

Segunda vez que ele se recusa a fechar uma história com teoria (§7.71). **Observação sem explicação é
dado; teoria confortável no lugar dela é ruído com aparência de conhecimento.** E o custo de anotar é
uma linha; o custo de não anotar aparece na terceira ocorrência, quando ninguém lembra das duas
primeiras.

### O coletor local, e por que ele não substitui telemetria

Aceitando a ressalva da §7.76, ele fez o diagnóstico da aba B coletar **ele mesmo** console de erro,
exceção de página e requisição falha, junto com o estado do canal.

> **Coletor local não substitui telemetria — garante que a evidência exista NO MOMENTO da falha, que é
> quando ela existe.** Foi exatamente o que faltou quando a entrega falhou duas vezes e voltou sozinha.

**E ele se pagou na primeira execução:** apanhou o `429` **do lado do navegador**. O estrangulamento é
observável **no cliente**, não só no servidor — o que significa que a evidência estava ao alcance o
tempo todo, num lugar onde ninguém tinha ido olhar.

---

## §7.91 — A forma pré-voo: rode o critério de aceite contra o estado atual ANTES de exigir a mudança

O @Arquiteto converteu o meu erro da §7.83 em **passo mecânico**, que é mais útil que a lição:

> **Antes de exigir uma mudança, rode o critério de aceite contra o ESTADO ATUAL.** Se ele já passa, a
> mudança precisa de **outra** justificativa — e aí **ou a justificativa de verdade aparece, ou a
> mudança cai sozinha**.

Custa um minuto e pega uma **classe inteira**:

> **Toda vez que alguém propõe mudar algo que já satisfaz o próprio critério, existe um motivo NÃO
> ENUNCIADO em jogo** — que pode ser bom, mas **precisa ser dito**.

No meu caso o critério era *"distinguir contato de agente sem legenda"*, e **preenchido contra anel já
passava**. Eu criei um teste para **aprovar** e o usei para **mandar alterar** — e o motivo real
(*"quero separar cliente de operador"*) nunca foi enunciado, então nunca foi discutido.

É o mesmo movimento de tudo o que foi construído hoje: **trocar "lembre-se de verificar" por um passo
que produz o resultado**.

### E a forma do erro dele, nomeada por ele

> *"Raciocinei da **distinção que eu queria expressar** direto para um **símbolo livre**, sem perguntar
> **qual eixo o vocabulário existente codifica**. Para acrescentar um símbolo não basta ter uma
> distinção real — é preciso saber o eixo, senão a distinção nova entra atravessada e **desorganiza a
> antiga**."*

Duas perguntas, e a segunda é a que se pula: *"a distinção é real?"* (era) e **"qual eixo o vocabulário
já codifica?"** (gente / agente / nem um nem outro). Distinção real no eixo errado **destrói mais do
que acrescenta**.

### Consequência derivada para a Wave 6, que entra no contrato

Como `filled` cobre **`user` E `contact`**, o **rótulo do bloco colapsado** no dossiê tem de vir de
`actorLabel` — **do texto** —, nunca da forma. Verificado: `actorLabel` devolve *"Você/time"*,
*"Agente"*, *"Cliente"*, *"Automação"* — **cinco rótulos para cinco atores**, enquanto a forma tem
três.

> Sem isso, **um bloco colapsado de ações do CLIENTE se lê igual a um bloco do TIME**. O agrupamento em
> si está seguro (a tupla de ator inclui `actor_kind` e os dois nunca se fundem); **o risco mora só no
> rótulo** — que é onde a informação chega ao usuário.

---

## §7.92 — O helper que recusa o caso degenerado: três propriedades, três falhas diferentes

O @QAVivo pegou a própria frase (*"regra na cabeça compete com pressa; regra no código, não"*) e a
aplicou a si mesmo: `escolherAlvo()` virou o **único caminho** para escolher alvo de sonda. Três
propriedades, e cada uma mata uma falha distinta:

| propriedade | falha que mata |
|---|---|
| lista **vazia falha alto** | alvo `undefined` e **critério pulado em silêncio** — foi assim que um elo inteiro da sonda do canal sumiu **enquanto o veredito "zero quadros" continuava sendo impresso** |
| **ordenação explícita no helper** | alvo sorteado (§7.31): duas execuções escolhem o **mesmo** alvo ainda que o banco devolva em outra ordem |
| **log de qual foi escolhido e entre quantos** | veredito sem sujeito (§7.89): *"reprodução começa por saber contra o que se mediu"* |

> A primeira é a pior das três e vale nomear sozinha: **critério pulado em silêncio enquanto o placar
> segue de pé** é o formato de erro mais caro que existe — não há vermelho para investigar **e** há um
> verde para confiar.

**E repare no movimento:** quem formulou a lei foi o primeiro a perceber que ainda dependia de lembrar
dela. Doutrina aplicada ao próprio autor é o teste mais duro que ela sofre.

### E o critério que afirma o comportamento BOM, não só a ausência do ruim

No `D25` (âncora sem alvo vira texto, não link nem exceção) ele escreveu o **porquê junto**:

> *"Critério que diz 'não pode quebrar' **sem dizer por que** vira, na próxima leitura, alguém
> 'consertando' o caso legítimo."*

É a §7.56 aplicada ao **teste**: o aviso tem de estar onde a pessoa vai estar olhando — e quem for
"melhorar" um caso que parece defeito estará olhando **o critério**, não o handoff.

---

## §7.93 — Mesmo mecanismo, polaridade oposta: a semelhança é que convida ao erro

Aviso do @DevVivo sobre a minha decisão 7 da Wave 6, e ele evita um defeito que **só apareceria depois
de pronto**:

| superfície | o que fazer com a PRÓPRIA ação | por quê |
|---|---|---|
| card (board) | **suprimir** o pulso | quem moveu **já teve o feedback**; repetir é ruído |
| timeline (dossiê) | **mostrar** | a própria ação é **justamente o que se quer ver registrado** |

> Se alguém transplantar `marcarEcoLocal`/`ehEcoLocal` para a timeline **por parecer a mesma coisa**, a
> prova do cenário 20 **some exatamente para quem a produziu** — e some **em silêncio**, porque a
> atividade **foi** gravada.

**A semelhança é a armadilha.** Dois usos do mesmo mecanismo com polaridades opostas parecem
duplicação a quem lê rápido — e "remover duplicação" é o refactor mais aplaudido que existe. **O motivo
tem de estar escrito no código do dossiê**, não no contrato: quem for unificar estará olhando o
componente (§7.56).

## §7.94 — Herdar por cópia é criar duas listas

Eu decidi que *"superfície nova herda as decisões da superfície antiga"* (§ regra 4 da Wave 6). Ele
apontou o buraco:

> **Herdar por CÓPIA é como as duas listas: funciona no dia e diverge no mês.**

Verificado: o rótulo honesto da âncora está **inline** hoje (`ScoreSlot.tsx:107`, um ternário dentro do
JSX). "Herdar" por cópia significaria **duplicar o ternário** no dossiê — e no dia em que um dos dois
mudar, as duas telas passam a dizer coisas diferentes sobre o mesmo dado, sem nada acusar.

> **Conserto: extrair o rótulo para uma função única que as duas telas chamam. Assim "herda" vira
> MECANISMO em vez de INTENÇÃO.**

**Terceira vez hoje que uma decisão minha é convertida em instrumento por quem a recebeu** — e as três
seguem o mesmo padrão: eu digo o que tem de acontecer, e alguém pergunta *"o que garante que continue
acontecendo?"*.

## §7.95 — A armadilha mora no encontro do contrato com o código

Observação de método dele, e é a explicação do porquê a lista de oito existiu:

> *"Eu não as achei **lendo o contrato duas vezes**; achei **lendo o CÓDIGO com o contrato na
> cabeça**."*

A colisão clique-×-seleção só apareceu ao abrir o `KanbanCard` e ver o `onClick` chamando `onSelect`. A
do colapso-×-realtime só apareceu ao procurar assinante de `crm_lead_activities` e não achar nenhum.

> **Contrato descreve o que DEVE existir. Código mostra o que JÁ existe. A armadilha mora no encontro
> dos dois** — e por isso releitura atenta do contrato **não** as encontra, por mais cuidadosa que seja.

**Corolário operacional:** a leitura que antecede a implementação não é *"reler o contrato"*, é
**percorrer o código que o contrato vai tocar, com o contrato na cabeça**. Custa mais e é a única que
produz a lista.

---

## §7.96 — O meta-instrumento tinha a mesma doença, e no lugar mais caro possível

O `carimbo` é o que dá validade a **todo veredito emitido nesta entrega**. E ele tinha o defeito
central do dia — verificado por mim:

```
git status --porcelain -- caminho/que/nao/existe   →   saída VAZIA, exit 0
```

**Indistinguível de "limpo".** Então uma dependência **renomeada** sumia da cadeia **em silêncio**, e o
carimbo seguia dizendo *"todas limpas — o veredito vale para este commit"*, enquanto a prova declarava
depender de um arquivo **que não está mais lá**.

> **Ausência com cara de aprovação — de novo, e desta vez no instrumento que autentica todos os
> outros.**

**Conserto (`4a177e7`):** dependência declarada que não existe **estoura, nomeando o arquivo**. E o
@QAVivo **conferiu o acervo antes de alarmar**: nenhum aparato declara caminho inexistente hoje, então
**nenhum veredito saiu com elo faltando**. O guarda é preventivo — e morde.

### O aparato passa a declarar a si mesmo

Ideia do @DevVivo, creditada por ele, com o argumento certo:

> **Instrumento não commitado produz veredito irreprodutível do mesmo jeito que produto não
> commitado.**

Os carimbos declaravam só as dependências do **produto** — então podiam dizer *"todas limpas"*
**enquanto a RÉGUA mudava debaixo do resultado**. Seis aparatos passam a entrar na própria lista. **E o
mecanismo se pegou na primeira execução:** com o arquivo recém-editado, o carimbo **recusou** chamar
aquilo de veredito; depois do commit, *"todas limpas"*.

### E a ressalva sobre os vereditos de hoje, que é o movimento mais raro da entrega

> *"Os vereditos de hoje foram carimbados **sem o aparato na lista**. As dependências de produto
> estavam limpas, e eu commitava o aparato antes de rodar **na maioria das vezes** — mas 'na maioria
> das vezes' não é uma garantia, **e agora é**. Não estou retirando nenhum veredito; estou dizendo
> **qual era o alcance real da garantia** que os acompanhava."*

**Declarar o alcance real de uma garantia passada, sem retirar o resultado**, é distinto de retratar-se
— e é mais raro. Retratação apaga; **isto recalibra**. Quem ler os placares de hoje daqui a três meses
saberá exatamente o que eles garantiam, em vez de herdar uma confiança que ninguém mediu.

*(E o falso positivo dele na própria checagem — casou uma palavra dentro de um **comentário** — é a
§7.25 outra vez, em escala de cinco linhas. Instrumento que não distingue comentário de dado. Quarta
ocorrência do casamento por substring nesta entrega.)*

---

## §7.97 — Não-ligação deliberada não se desenha, se DECLARA

O mapa vivo do subsistema entrou no git (`504db12`) — escrito pelo @Arquiteto, **commitado por mim
porque ele se recusou**, com o argumento certo: *"não vou ser a pessoa que escreve um mapa sobre não
versionar coisas e o deixa fora do git"*. Enquanto estivesse não rastreado, seria a **quinta**
ocorrência da §7.84.

**Validado de forma independente:** 24 peças, 44 arestas, 6 faixas, 3 cards · **zero** referências
quebradas · **zero** peças com menos de duas arestas — o DoD 13 cumprido **por construção**, não por
inspeção.

### O validador pegou um erro do próprio autor

> Na primeira passada, o *"Filtro Responsável"* tinha **uma aresta só** — **uma ilha DENTRO do mapa que
> existe para provar que não há ilhas.** A segunda aresta era real e ele não a tinha visto.

**Melhor prova de que o validador serve do que qualquer verde de primeira.** Instrumento que só confirma
o que o autor já acreditava não foi testado — foi consultado.

### E a decisão de modelagem que dá nome à lei

*"Score fora do realtime"* entrou como **card de invariante**, não como aresta:

> **Não-ligação deliberada não se desenha, se declara.** Uma aresta ausente é indistinguível de uma
> aresta **esquecida** — o desenho não tem como dizer *"aqui NÃO liga, de propósito"*.

É a §7.86 na topologia: **ausência e decisão são afirmações diferentes**, e a notação as colapsa a menos
que você seja explícito. Idem os outros três cards (*timeline registra estado e obrigação, não trabalho
de máquina*; *checkpoint por diff, nunca por retrato*; *`crm_lead_id` é atalho com `SET NULL`,
`owner_agent_id` é identidade com `RESTRICT`*): **a forma não mostra o que mais custou a descobrir.**

### E a ressalva do autor sobre o próprio artefato

> *"O mapa descreve o desenho **CONTRATADO** das oito waves. As waves 6, 7 e 8 **não existem em
> código** — então ele é **planta, não fotografia**. **Plano não é estado, inclusive quando o plano é
> meu.**"*

Um mapa que não declara isso é lido como **inventário**, e quem chegar depois vai procurar no código
peças que ninguém escreveu — perdendo tempo e concluindo que o mapa está errado, quando ele está
**adiantado**.

---

## §7.98 — As duas metades da regra têm SINAIS OPOSTOS: separe ação de verificação, encadeie preparação com medição

Correção do @DevVivo, e é a mais importante desta seção porque **uma leitura descuidada de uma lei
nossa foi o que o empurrou para o erro**.

**Primeiro, o limite da minha proposta do hash** (§7.89): ele **não teria sido salvo** por ela. O
arquivo no disco estava velho porque o script abortou — então `test:db` teria impresso **o hash do
arquivo velho**, e ele o leria como o certo.

> **Número com sujeito só ajuda quem sabe qual sujeito queria.**

**Segundo, o que o teria pegado — e era mais barato:** ele rodou o script de reescrita e o `test:db` no
**mesmo comando, separados por quebra de linha, não por `&&`**. O script abortou com `ValueError`,
imprimiu o traceback, **e o `test:db` rodou assim mesmo**, medindo o baseline que o script nunca chegou
a reescrever. **Com `&&`, o segundo nem teria começado.**

### E a lei que ele corrige é nossa

*"Nunca encadeie a AÇÃO com a VERIFICAÇÃO no mesmo comando"* **não** quer dizer *"nunca use `&&`"*.

| par | regra | por quê |
|---|---|---|
| **ação × verificação** (commit × teste) | **SEPARE** | encadeado, você **commita sem ler** |
| **preparação × medição** (script × suíte) | **ENCADEIE com `&&`** | medir depois de preparação que falhou é **medir outra coisa** |

> **As duas metades têm sinais opostos.** *"Eu tinha internalizado a primeira metade e aplicado a
> segunda ao contrário."*

**Doutrina supergeneralizada causa dano** — e este é o primeiro caso registrado nesta entrega em que uma
lei nossa, lida sem a distinção, **produziu** o erro em vez de evitá-lo.

### E eu cometi o mesmo erro hoje, duas vezes — a §7.44 é esta lei por outro ângulo

Minhas mutações falhadas (§7.44) tinham **exatamente esta forma**: `cp backup` · `mutar` · `rodar
teste` · `restaurar`, separados por **quebra de linha**. A mutação não pegou, e **o teste rodou assim
mesmo**, sobre código intacto — devolvendo verde que eu quase li como *"o teste não tem dentes"*.

> A §7.44 (`assert` da âncora) e a §7.98 (`&&`) são **o mesmo remédio por dois caminhos**: o `assert`
> faz a **preparação falhar alto**; o `&&` faz a **medição não acontecer**. Qualquer um resolve; **os
> dois juntos** cobrem também o caso em que a preparação falha **sem** código de erro.

**E o fecho, que é dele:** a proposta do hash fica **melhor acompanhada desta nota** — senão alguém lê
*"338 passed, baseline `X`"* e ainda assim rodou sobre preparação quebrada. **O hash diria a verdade
sobre um estado que ninguém queria.**

---

## §7.99 — Corrigir é tirar a instância; tornar inescrevível é tirar a possibilidade

Formulação do @QAVivo sobre a tríplice final, e ela separa duas coisas que eu vinha tratando como uma:

> **"O defeito não foi corrigido, foi tornado INESCREVÍVEL."**

Verificado: a constraint não exige duas chaves irmãs — exige `factors` não-vazio **com a âncora
DENTRO** (`evidence @? '$."factors"[*]."ancora"'`). Os dois vocabulários viraram **um**, e a âncora
deixa de **poder** existir sem a frase que a explica.

| abordagem | efeito |
|---|---|
| a minha (exigir as **duas** chaves) | **corrige**: o estado ruim continua escrevível, só que mais difícil |
| a dele (**uma** fonte, âncora dentro) | **elimina**: não há payload que o banco aceite e a tela não leia |

> **Teste para distinguir:** depois do conserto, **alguém ainda consegue escrever o estado ruim?** Se
> sim, foi corrigido. Se não, foi eliminado. E só o segundo dispensa vigilância.

## §7.100 — Instrumento que perde a pergunta original mas ganha uma guarda vale mais que apagado

O par de controle da tela nasceu para separar duas hipóteses: *"a tela não sabe mostrar evidência"* ×
*"a tela lê outra chave"*. Com a §7.99, **a segunda hipótese deixou de existir**.

> **Ele não virou inútil — virou CERCA.** Se alguém reintroduzir a divergência, ele volta a acusar.

**E isto NÃO contradiz a §7.45** (apagar o verde que não prova nada) — a distinção é limpa:

| caso | destino |
|---|---|
| a perna do `grep` no fonte | **nunca** provou nada → **apagar** |
| o par de controle | provou algo **real** que deixou de ser possível → **manter como cerca** |

> O critério não é *"ainda responde à pergunta original?"* — é **"ainda fica vermelho se algo
> regredir?"**. Instrumento cujo alvo foi eliminado **guarda a eliminação**.

### E duas coisas menores que ele fez certo, e que só aparecem quando alguém as declara

**1. Critério que sobrevive à mudança de contrato com o nome antigo MENTE.** O `C16.k` afirmava que
lastro só em `factors` é recusado — **verdade no contrato antigo, e exatamente o defeito**; virou o
payload **canônico**. Ele renomeou e inverteu. É a §7.63 outra vez, agora disparada por **mudança de
contrato** em vez de por descuido de escrita.

**2. Ele declarou a NÃO-ação.** Não renomeou retroativamente as imagens já citadas pelas narrativas —
*"renomear quebraria as citações por um ganho de rótulo"* — e disse isso **explicitamente**, *"para não
parecer que esqueci"*. **Não-ação declarada é decisão; não-ação silenciosa é indistinguível de
esquecimento** — e quem lê depois não tem como saber a diferença.

**E o carimbo do caso fabricado virou mecanismo:** `-CASO-CONSTRUIDO` no nome do arquivo, como o
`-ARVORE-SUJA`. Antes, que a prova usava caso construído só se percebia pelo **título do lead dentro do
print** — **acidente, não declaração**.

---

## §7.101 — Auditar o próprio contrato antes de despachá-lo (a §7.91 aplicada a si)

O @Arquiteto rodou as premissas do **próprio contrato da Wave 6** contra o `HEAD` **antes** de eu
despachá-lo. **Duas das três mudaram, as duas para melhor** — verificado por mim:

| premissa do contrato | estado real |
|---|---|
| *"o cabeçalho do dossiê depende de alargar o `CardInput`"* | **já alargado**: `probability`, `band`, `scoreFactors`, `scoreReason` |
| *"cuidado com `TIMELINE_COLS` sem `actor_kind`"* | **já inclui**, e o arquivo carrega a cicatriz: *"Já custou uma vez"* |
| cenário 20 (PATCH não emite atividade) | **de pé** — único que ainda exige trabalho |

> Contrato escrito há horas e despachado **sem auditoria** manda alguém construir **o que já existe**.
> É a lição da Wave 7 (§7.79) aplicada **preventivamente**, e ao próprio documento.

**E a autocrítica mais dura é sobre o segundo item:**

> ***"Eu apontei um risco que já era cicatriz. Meu aviso chegou depois do prejuízo, não antes."***

**Aviso que chega depois do dano é registro, não prevenção** — e há um jeito barato de saber em qual
dos dois você está: **procure a cicatriz no código**. Se o comentário já explica o estrago, o seu
alerta é eco.

## §7.102 — Doutrina que virou raciocínio para de ser citada

O sinal mais forte de que tudo isto valeu não é o tamanho deste documento. É o que ele viu de passagem
no `card-state.ts`:

> Os comentários carregam a doutrina **sem citá-la** — *"`null` e `0` são COISAS DIFERENTES"*, *"a
> faixa PERSISTIDA, nunca derivada aqui"*, *"lastro inventado passa na constraint"*.

> ***"O contrato sobreviveu ao contato com o teclado, que é o único teste que importa para um
> contrato. Quem escreveu não estava seguindo regra — estava usando o RACIOCÍNIO da regra."***

**Doutrina citada é doutrina ainda externa** — a pessoa lembra que existe uma regra e vai buscá-la.
**Doutrina que virou raciocínio aparece como o motivo local, em português, sem número de seção** — e é
nesse estado que ela sobrevive à saída de quem a escreveu.

> **Meta destas 100 seções:** não serem lidas. Serem **instrumento** (§7.59-a) ou **raciocínio**
> (§7.102). Enquanto forem citação, ainda dependem de alguém lembrar.

### E o fecho sobre erro examinado

> *"Você reverteu o tracejado e eu transformei o seu erro em checagem; eu errei o eixo do símbolo e
> você nomeou a forma do meu erro melhor do que eu tinha nomeado. **Nenhum de nós dois teria chegado
> sozinho nas duas metades** — e o que fica no repositório não é quem acertou, **é a checagem**."*

> **Acerto de primeira não deixa instrumento. Erro examinado deixa.**

---

## §7.103 — O código não é neutro: ele carrega decisões antigas cujo motivo não está no contrato de hoje

O @DevVivo achou uma tensão na minha decisão *"Enter abre o dossiê"*, e a origem dela tem **duas waves
de idade**:

O card é `div` com `role="group"` **deliberadamente** (`KanbanCard.tsx:84`): o dnd marca o handle como
`role="button"`, e com o menu de ações dentro isso virava **nested-interactive** no axe. A Wave 2
escolheu `group` para manter foco e teclado do dnd **sem aninhar dois controles**.

> **Enter-para-abrir pede semântica de ATIVAÇÃO, e ativação mora em `button`.** Voltar a
> `role="button"` **reintroduz exatamente o problema que a Wave 2 resolveu**.

**Ruling: opção (c)** — o card continua `group`, e **o TÍTULO vira o elemento ativável** (`button`),
com o clique no card ainda abrindo por conveniência do mouse.

| caminho | mouse | teclado | leitor de tela | Wave 2 |
|---|---|---|---|---|
| (a) `group` + `onKeyDown` | ✅ | ✅ | ❌ **não anuncia que há o que ativar** | preservada |
| (b) `role="button"` | ✅ | ✅ | ✅ | **desfeita** (nested-interactive volta) |
| **(c) título como `button`** | ✅ | ✅ | ✅ | **preservada** |

**Por que (a) não serve:** cria uma ação que **existe e não é descoberta**. Usuário de mouse ganha;
usuário de leitor de tela não sabe que existe — e **nada sinaliza a diferença**. Não é ausência de
recurso, é **assimetria silenciosa**, que é pior porque nem aparece como falta.

### E a extensão da §7.95 que este caso obriga

A §7.95 diz que a armadilha mora no **encontro do contrato com o código**. Este caso acrescenta a
dimensão **temporal**:

> **O código não é neutro — ele encapsula decisões passadas cujo motivo não está no contrato de hoje.**
> *"Clicar no card abre o Sheet"* não menciona teclado nem `role`; o `role="group"` está lá por um
> problema de acessibilidade de duas waves atrás, **e ninguém lembraria de consultar**.

Ou seja: percorrer o código antes de implementar (§7.95) não é só ver **o que existe** — é ver **por
que existe**. E isso só funciona porque **o motivo estava escrito no lugar certo** (§7.56): o comentário
do `role="group"` explica o nested-interactive **ali**, e não num handoff.

**Sem esse comentário, a decisão de duas waves atrás teria sido desfeita hoje sem ninguém perceber** —
e o defeito voltaria com o nome de "melhoria de acessibilidade".

---

## §7.104 — Instrumento que percorre o sistema por caminho diferente do usuário mede outro sistema

O @QAVivo mediu o vazamento de assinatura no inbox: **8 tópicos assinados, 8 saíram, zero órfãos**. E o
que decidiu a medição foi **uma escolha de método**, sem a qual a sonda teria dito o **contrário do
certo**:

> **Navegação por CLIQUE, nunca por `goto`.** O `goto` recarrega a página, destrói o contexto de JS e
> **mata os canais junto** — sob recarga, **vazamento nenhum é observável**.

> *"Eu teria escrito 'não vaza' sobre uma tela que vazasse em todo uso real. **O vazamento só existe na
> navegação client-side, que é a que o usuário faz.**"*

**Regra:** o instrumento tem de percorrer o sistema **pelo caminho do usuário**. Um atalho de
navegação que o usuário não usa **muda o sistema medido** — e o defeito que só existe no caminho real
fica **estruturalmente invisível**, sem que nada no resultado indique isso. É a §7.70 (*intenção não é
efeito*) na camada de navegação: **atalho de teste não é uso**.

## §7.105 — Agregado que você não sabe ler não é dado

**O instrumento esteve errado duas vezes antes de estar certo — e ele não mandou o primeiro número.**

**1.** *"Entradas menos saídas"* **não significa nada aqui**: o `supabase-js` manda um `phx_leave`
**antes** do `phx_join` do mesmo tópico (derrubando a instância anterior) e outro na desmontagem —
**2 entradas e 4 saídas por visita**. A primeira versão relatou **diferença negativa**, um número que
ele **não sabia ler**. A conta certa é **por TÓPICO**: *entrou e nunca saiu?*

**2.** O regex do uuid casava 36 caracteres **a partir de qualquer ponto**, deixando um dígito solto no
nome (`inbox<id>0`). **"Nome deformado num relatório é ruído que parece dado."**

> *"Se eu tivesse mandado, vocês teriam recebido **'saídas maiores que entradas' como se fosse
> achado**."*

**Regra:** número que você não consegue **interpretar** não é resultado — é sinal de que o modelo do
instrumento está errado. **Pare e vá aos dados crus**; reportar o agregado incompreendido transfere a
confusão para quem lê, **com a autoridade de quem mediu**.

### E o achado de passagem, verificado: duas assinaturas por visita

Confirmado: `InboxLayout.tsx:106` **e** `ConversationList.tsx:32` chamam `useConversationsRealtime`
com os mesmos argumentos — **duas assinaturas `postgres_changes` sobre as mesmas tabelas**, ou seja
**o dobro de trabalho por evento** do lado do servidor.

**Não é defeito de correção — é de custo**, e ninguém sentiria hoje. Fica como **dívida nomeada com
conserto dimensionado**: içar a assinatura para o layout e deixar a lista consumir só o cache da query.
E ele a trouxe **como pergunta, não como acusação** — que é a forma certa para algo que **pode ser
deliberado**.

---

## §7.106 — Instrumento só vale depois que reprovou alguém, e o autor é o primeiro candidato

Corolário do @Arquiteto à §7.97, e ele é o **critério de aceitação** de tudo o que foi construído hoje:

| instrumento | quem ele reprovou primeiro |
|---|---|
| validador de grafo | **o próprio autor** — a ilha dentro do mapa que existe para provar que não há ilhas |
| sonda do veto | inverteu o veredito **depois da cura**, provando que media o produto e não a si mesma |
| `carimbo` | **pegou o autor na primeira execução**, recusando chamar de veredito uma árvore suja |
| `assert` da mutação (§7.44) | **me pegou**, transformando um verde vazio em aborto ruidoso |
| tabela-verdade da constraint | **pegou o QA**, recusando o seed dele por falta de lastro |

> **Nenhum desses foi "testado" abrindo e vendo passar.**

**Regra:** o padrão de aceitação de instrumento novo não é *"rodou sem erro"* — é **"reprovou algo que
deveria reprovar"**, e o caminho mais barato para isso é **submetê-lo ao próprio autor**. Instrumento
que nunca disse "não" é **promessa**; instrumento que disse "não" a quem o escreveu é **instrumento**.

## §7.107 — O formato mais fácil de editar é o que envelhece mentindo

Nota dele sobre o render do mapa, aplicada antes de existir o render — e virou
`docs/architecture/README.md` (versionado, `HEAD` atual):

> **O JSON é a FONTE; o HTML é DERIVADO. Se divergirem, o HTML é que está errado.**

O motivo mora **no README daquele diretório** e não num handoff, porque **é ali que a decisão errada
seria tomada** (§7.56). E a razão é fina:

> **O HTML é o formato mais fácil de abrir e editar** — uma correção feita nele **parece funcionar**,
> **some na próxima geração**, e nesse intervalo **a fonte deixou de ser fonte sem ninguém decidir
> isso**.

É a mesma família de *"lastro inventado passa na constraint"*: o caminho de menor atrito produz um
resultado **plausível e errado**, e nada no momento acusa. **Onde há fonte e derivado, a facilidade de
edição está no lado errado** — e é por isso que a regra precisa estar escrita, não deduzida.

### E a extensão dele ao invariante da Wave 7

> *"Se inverter a ordem entre produtor e validador **não** produzir escrita recusada, o validador não
> está validando nada — **e nesse caso o problema deixa de ser a ordem e passa a ser o validador**."*

O teste não checa só a **ordem**: checa a **existência** do validador. Um invariante que passa nas duas
ordens não provou que a ordem importa — provou que **nada está sendo validado**.

---

## §7.108 — Alvo ausente e critério ausente são duas ausências diferentes

O @QAVivo cometeu, à tarde, a lei que escreveu de manhã — **no mesmo arquivo onde a escreveu**:
acrescentou dois critérios (`D19.rotulo`, `D25`) e **não os incluiu na lista do retorno antecipado**.
No caminho *"o dossiê não existe"*, os dois **simplesmente não apareciam**.

> **Sem vermelho para investigar, e com o placar de pé** — o formato exato que ele transformou em lei
> horas antes (§7.92).

**E a análise de por que o próprio helper não o salvou é o que vale:**

> *"Escrevi um helper para que a LISTA VAZIA não passasse em silêncio, e caí no vizinho — o CRITÉRIO
> que nunca chega a ser avaliado. **O helper cobre o alvo ausente, não o critério ausente.** São duas
> ausências diferentes e a segunda ainda depende de eu lembrar."*

| ausência | quem já cobre |
|---|---|
| **alvo** ausente (lista vazia) | `escolherAlvo()` — falha alto (§7.92) |
| **critério** ausente (nunca avaliado) | **ninguém** — ainda depende de memória |

**O mecanismo que fecha a segunda, e é dele:** o placar **declara a lista COMPLETA de critérios no
início** e **cobra cada um no fim**. Critério declarado e não reportado vira falha — e aí *"não
apareceu"* deixa de ser indistinguível de *"não existe"*.

> É a §7.51 na sua forma profunda: lá, o placar não **listava** o que faltava; aqui, o placar **não tem
> como saber** que faltava. Declarar antes de medir é o que transforma ausência em **discrepância**.

### E os dois critérios que entraram

**`D19.rotulo`** — consequência da reversão do marcador (§7.83): como `filled` cobre `user` **e**
`contact`, o rótulo do bloco colapsado **não pode sair da forma**. Verificado: cinco nomes
(`Você/time`, `Agente`, `Cliente`, `Automação`, `Sistema`) contra **três formas**. Sem isso, três ações
do **cliente** se leem como três do **time** — e o dossiê passa a **mentir sobre quem fez o quê**.

**E o caso é CONSTRUÍDO e declarado:** o seed cria três atividades do quinto ator, que tem **zero
linhas** no banco real. *Sem o caso, o critério não teria o que medir* — e sem a **declaração**, a
captura sugeriria um fluxo que ninguém exercita.

**`D20`** — o `reason` tem de **nomear o campo alterado**, como asserção **separada**: *"alterou"* sem
dizer o quê é a mesma frase vazia recusada no score. **Três metades que falham separado:** salvar,
registrar, e **dizer o que mudou**.

> **Registro que não permite discordar não serve para auditar.**

---

## §7.109 — Guarda que vive no fluxo que vigia herda as falhas desse fluxo

O @QAVivo construiu o mecanismo da §7.108 — `criarPlacar(nome, esperados)`, com a lista declarada
**antes** de medir, ausente saindo como falha **do instrumento** e registro **fora** da lista também
estourando, porque **a lista é o contrato**. Provado **mordendo**: um `D99.inexistente` declarado e
nunca registrado fechou o placar com `1 AUSENTES`, nomeando-o (§7.106).

**E a ironia vale mais que o mecanismo:** na primeira execução **o placar não imprimiu**. O caminho
*"o dossiê não existe"* usa `return`, que sai da função inteira — e com o fechamento **depois do
`try`**, o mecanismo contra critério pulado estava, **ele mesmo, sendo pulado**.

> **O guarda tinha exatamente a doença que foi construído para curar.**

Conserto: o fechamento vive no **`finally`**. E a generalização:

> **Um guarda que vive no mesmo fluxo que ele vigia herda as falhas desse fluxo.** O que interrompe o
> trabalho interrompe o guarda — `return`, exceção, `SIGPIPE` (§7.65), processo morto. O guarda precisa
> viver **fora** do fluxo: `finally`, wrapper, processo separado.

**E só apareceu porque ele rodou e olhou a saída** em vez de confiar que tinha funcionado — **terceira
aplicação da §7.78 hoje**, e a mais literal: o diagnóstico que nunca rodou estava quebrado.

## §7.110 — Reverte-se a LINHA da demonstração, não o arquivo

Deslize operacional dele, e é o tipo que qualquer um de nós comete: para desfazer a mutação de
demonstração, rodou `git checkout` **no arquivo** — e levou junto **toda a adoção do placar que ainda
não estava commitada**. Refez.

> **Mutação e commit são vizinhos perigosos.**

**Regra:** reverta **a linha** que você mutou, ou **commite antes de demonstrar**. E a razão é geral:

> **A operação de desfazer tem granularidade própria, e ela quase nunca é a granularidade do que você
> fez.** Você mutou uma linha; `git checkout` opera no **arquivo**. O desfazer é mais grosso que o
> fazer — e a diferença é sempre trabalho não commitado de outra pessoa, ou seu.

*(Meu método de hoje — `cp` para backup e restaurar — é imune a isto por acidente, não por escolha: ele
restaura exatamente o que foi salvo. Registro para que a imunidade vire escolha.)*

### E uma notícia: o cenário 20 deixou de ser impossível

`lead_edited` **já existe** no vocabulário, com o rótulo *"Dados do negócio alterados"* — verificado. O
bloco que era **estrutural** (§7.80: *o tipo não existe*) foi fechado, e o `D20.contrato` virou verde.
Sobram as outras duas metades: **emitir** e **dizer o que mudou**.

---

## §7.111 — O precedente seguro pode ser inseguro no campo vizinho

O @Arquiteto pegou um **vazamento de dado pessoal na minha decisão do cenário 20**, e chegou **antes**
da implementação — depois seria o aviso-cicatriz que ele mesmo tinha acabado de reconhecer como falha
(§7.101).

Eu decidi que o `reason` da edição carrega *"quais campos mudaram"*. Duas implementações naturais, e
**uma vaza**:

| precedente | conteúdo | risco |
|---|---|---|
| `stageChangeReason` → *"Movido de X para Y"* | **nomes de estágio** = configuração do tenant | nenhum |
| o mesmo padrão em campos de lead | `title`, `description`, `custom_fields` | **o título É o nome do cliente** |

**Verificado:** o exemplo do próprio briefing (linha 143) é *"Clínica Vitalis — implantes"* — e o §9
(linha 498) é explícito: **"nenhuma PII nova em log, `reason` ou `evidence`"**.

> **O padrão parece inofensivo porque o PRIMEIRO caso era.** Precedente seguro cria confiança que
> atravessa para o campo vizinho — onde o mesmo formato carrega outro tipo de dado.

**Ruling: o `reason` NOMEIA CAMPOS, NUNCA VALORES.** *"Dados do negócio alterados: título, valor e
etiquetas"* cumpre o propósito — o humano vê **o quê** mudou e vai ao lead ver o conteúdo, que está a
um clique **e é onde ele deve estar**.

### E a exceção tem de ser dita JUNTO, senão a regra quebra a Wave 4

A atividade de **autorização vencida** mostra antes-e-depois **de propósito**: ali o texto é **a
proposta do próprio agente**, escrita por máquina e **livre de PII por contrato**, e o antes-e-depois é
**a informação inteira** — sem ele o humano reaprova às cegas.

> A regra **não** é *"reason nunca mostra antes e depois"*. É **"reason nunca mostra VALOR DE CAMPO DO
> LEAD"**. Duas regras que parecem opostas e não são, porque **a origem do texto é diferente**.

**Regra geral:** ao proibir um formato, verifique se o que você está proibindo é **a forma** ou **a
procedência**. Proibir a forma pega casos legítimos; proibir a procedência pega o que importa.

### E o argumento que fecha: duplicar em superfície mais exposta

Os valores **já existem** em `api_audit_log` (verificado: `audit()` nas linhas 309, 451 e 622 do
handler), **sob o controle de acesso do audit** — que é onde esse dado deve morar.

> Duplicar valor de campo na timeline criaria **um segundo lugar com o mesmo dado e MENOS proteção** —
> e a timeline é a superfície que aparece em **captura de tela, exportação e ticket de suporte**. É a
> superfície **mais compartilhada** do produto.

**Dado sensível não se copia para onde é mais fácil de ver. A pergunta não é "quem pode acessar?", é
"onde esta tela vai parar?".**

---

## §7.112 — Ensaiar o instrumento contra alvo análogo, antes de o alvo real existir

O @QAVivo estendeu a §7.78 a um caso que ela não cobria: **critério armado e bloqueado também é
diagnóstico que só roda quando já é tarde.**

> Sete critérios do aparato da Wave 6 **nunca rodaram**. Eles destravam **todos de uma vez** no dia em
> que o dossiê nascer — **exatamente o dia em que ninguém tem tempo de descobrir que um localizador não
> resolve.**

**A solução:** `ENSAIO=1` exercita a maquinaria contra o `EditLeadDialog` — o diálogo com campos que
**existe hoje**. E a disciplina que torna isso honesto:

> **O resultado do ensaio NÃO entra no placar.** Misturar *"o instrumento funciona"* com *"o cenário
> passa"* seria **fabricar verde** — o dossiê continua não existindo.

### E o ensaio achou dois defeitos, os dois invisíveis até então

| defeito | o que teria acontecido no dia da entrega |
|---|---|
| a medição de **ordem** devolvia `null` para o cabeçalho (o título é `value` de input, não texto, e o localizador só olhava texto) | o critério **falharia por defeito do MEDIDOR**, e o vermelho apontaria **para quem construiu** |
| o contador de assinatura marcava **0 entradas e 0 saídas** (`page.on('websocket')` só vê sockets abertos **depois** de anexado) | **BLOQUEADO FALSO**: acusaria **ausência de recurso** onde havia **ausência de escuta** |

**A segunda distinção é a mais fina do dia:**

> **Ausência de recurso e ausência de escuta produzem o mesmo zero** — e o placar as confundiria. É a
> §7.64 aplicada ao **próprio instrumento de medida**: dois estados, uma observação.

**Depois do conserto:** a ordem resolve (cabeçalho `300.9`, campos `272.9`) e o contador marca `3/5` na
página inteira **enquanto reporta ZERO nos ciclos do diálogo** — que é **o certo**, porque o
`EditLeadDialog` não assina nada.

> **Zero MEDIDO, não zero cego.** *"Ontem eu não saberia distinguir os dois; hoje a saída distingue."*

**Regra:** instrumento que vai ser usado numa janela estreita (entrega, incidente, migração) precisa ser
**ensaiado contra o análogo mais próximo que já existe** — e o ensaio precisa ser **declaradamente
separado** do veredito, senão ele vira o verde que ninguém pediu.

---

## §7.113 — A cadeia de instrumentos começa com alguém aceitando ser reprovado pelo próprio trabalho

Observação do @Arquiteto sobre a lista da §7.106, e ela muda o que aquela lista significa:

> Dos cinco instrumentos, **três reprovaram quem os escreveu** e dois reprovaram outra pessoa — **e os
> dois que pegaram outra pessoa só existiam porque alguém já tinha sido pego antes por um instrumento
> próprio.**

| instrumento | reprovou | existia porque |
|---|---|---|
| validador de grafo | o autor | — |
| `carimbo` | o autor | — |
| sonda do veto | o autor | — |
| `assert` da mutação | **outra pessoa** | eu tinha sido pego por um verde vazio |
| tabela-verdade | **outra pessoa** | alguém já tinha sido pego por um vermelho vazio |

> **Não é uma coleção de cuidados independentes — é uma CADEIA.** E o primeiro elo foi **alguém aceitar
> ser reprovado pelo próprio trabalho**.

**E a consequência é operacional, não moral:**

> *"Se esse hábito morrer, os outros quatro viram formalidade em dois meses — **vão continuar rodando e
> parando de dizer não**."*

> **Um time onde só os outros erram não constrói instrumento, constrói protocolo.**

É por isso que a reversão do tracejado (§7.83) e a ilha dentro do mapa (§7.97) **valem mais registradas
do que escondidas**: elas não são confissões, são **o elo que mantém a cadeia viva**.

## §7.114 — "O que sobrou que não é de ninguém?" — a pergunta de fim de frente

O mapa fora do git (§7.84) foi achado por uma pergunta **banal**, e ele faz questão de que ela conte
como **hábito** e não como talento:

> *"Terminei os oito contratos — **o que sobrou que não é de ninguém?**"*

**Por que ela funciona:** uma wave **tem dono**; o que não é wave **não tem** — e por isso mesmo
ninguém vai bater lá. O trabalho órfão não é o mais difícil, é o **menos endereçado**: cada pessoa
fecha a própria fila e o que está entre as filas fica.

> **Quem fecha a própria fila deveria perguntar isso ANTES de anunciar que fechou.**

Custa um minuto, e nesta entrega achou o **único artefato do épico sem dono** — que por acaso era o que
provava a lei mais repetida do dia.

---

## §7.115 — O `&&` só protege se o comando à esquerda FOR a verificação, não quem a imprime

O @DevVivo commitou com `typecheck` vermelho **três mensagens depois de me explicar a §7.98** — e a
falha entrou por uma **terceira forma** que nenhuma das duas metades da lei cobria.

Ele rodou os três gates com `;` e encadeou o commit a um `&&` que dependia do **`grep`**, não do
`typecheck`. O `grep` achou a linha `Tests`, saiu com **zero**, e o commit passou.

> **A verificação RODOU, IMPRIMIU `1`, E NÃO BLOQUEOU NADA.**

`grep && git commit` **parece** encadeamento e é **decoração**: o que passou foi o `grep`. A §7.98
cobria *"separe ação de verificação"* e *"encadeie preparação com medição"* — faltava:

> **O `&&` só vale se o comando à esquerda for A VERIFICAÇÃO, não um comando que apenas a IMPRIME.**
> Filtro, formatador e `tee` propagam **o próprio** sucesso, não o do que está sendo lido — é a §7.90
> (o cano de leitura) com **consequência de escrita**.

*(E o `TS2307` em si era legítimo de ignorar — import por URL dentro de `page.evaluate`, que o `tsc`
não resolve **e não deveria**, porque quem executa aquilo é o Chrome. Mas isso é irrelevante: o defeito
foi o gate não ter bloqueado, não o erro que ele deixou passar.)*

### E a frase dele é o limite honesto destas 115 seções

> **"Doutrina cobre a forma que você já viu; a próxima falha entra pela forma que falta."**

É a companheira da §7.67. Doutrina falha de **duas** maneiras, e elas são independentes:

| falha | por quê |
|---|---|
| **não-reconhecimento** (§7.67) | o caso não se apresenta como o caso |
| **incompletude** (§7.115) | o caso tem uma **forma que a regra não antecipou** |

**A segunda não se cura escrevendo mais regras** — cada formulação nova tem a sua própria borda. Cura-se
com **instrumento** (que não depende de reconhecer a forma) e com **relatar a variante quando ela
aparece**, que foi o que ele fez: falhou, nomeou a variante, e a lei ficou maior que o erro.

> **Quem escreveu a lei e falhou nela na mesma hora não invalidou a lei — completou-a.** A alternativa
> era não contar, e a lei seguiria com o buraco, esperando outra pessoa.

---

## §7.116 — O que salvou foi o absurdo, não o cuidado

Acréscimo do @QAVivo à §7.105, e é a coisa mais honesta da mensagem:

> *"Não foi disciplina. A diferença NEGATIVA **não cabia em nenhuma explicação que eu tivesse**. Se
> ela tivesse dado um número **plausível e errado** — digamos 2 órfãos por visita — **eu teria
> reportado**. O que me salvou foi o resultado ser ABSURDO, não eu ser cuidadoso."*

**Terceira vez hoje que alguém recusa crédito e a recusa melhora a regra** (§7.59-a: *não foi método,
foi sorte*; §7.88: *foi proximidade, não caráter*). O padrão é o mesmo e a consequência também:

> **Defesa que depende de o erro ser gritante não é defesa** — é sorte com boa reputação. O erro
> plausível passa pela mesma porta, e passa mais frequentemente, porque **erros plausíveis são mais
> comuns que absurdos**.

**Conserto dele:** os quadros crus **saem sempre** no log da sonda, não só quando algo parece errado.
A leitura deixa de depender de o agregado chamar atenção.

## §7.117 — Comparação transforma suspeita em dívida medida

As duas superfícies que assinam estão fechadas: **inbox 8 tópicos em 4 visitas (dois por visita)**,
**kanban 4 em 4 (um por visita)**, `12 entraram · 12 saíram · zero órfãos`.

**E a comparação vale mais que os dois zeros.** A observação anterior sobre o inbox era uma **suspeita
sem régua** — *"dois canais, será que é demais?"*. Agora é:

> **"Dois onde a superfície vizinha resolve com UM."**

O board virou **contraexemplo**: prova que **uma assinatura basta para a mesma classe de tela**. A
dívida deixa de ser palpite e passa a ter **magnitude e viabilidade** — e o conserto dimensionado
(içar a assinatura para o layout) fica **sustentado por um caso que já funciona assim**.

> **Suspeita vira dívida quando existe um vizinho que faz diferente e funciona.** Sem o vizinho, é
> opinião sobre arquitetura; com ele, é diferença medida entre duas soluções para o mesmo problema.

### E o atalho quase repetido, em outra escala

A primeira versão visitava `/app/kanban` — que é a **LISTA de pipelines**. O canal só nasce **dentro**
do pipeline.

> Ele teria medido **uma tela que não assina nada** e concluído *"o board não vaza"* sobre uma
> superfície **nunca visitada**. **Parecer que se visitou sem ter entrado é a mesma família de atalho
> que o `goto`** (§7.104): o instrumento percorre um caminho que o usuário não percorre, e o defeito
> fica **estruturalmente invisível**.

Pegou **olhando o log de navegação em vez de confiar na URL** — e a linha
`[nav] board por clique → /app/pipelines/<id> (15 cards)` é o que **prova que entrou**. **URL não é
presença; conteúdo é.**

---

## §7.118 — Medir onde o risco existe antes de converter por reflexo

O @QAVivo construiu o mecanismo da §7.108 e, **antes** de aplicá-lo aos outros quatro aparatos, foi
**medir onde o modo de falha tem por onde entrar**:

| aparato | saídas antecipadas no fluxo |
|---|---|
| `capture-wave-3` | **nenhuma** |
| `capture-wave-4` | **nenhuma** |
| `capture-wave-5-tela` | **nenhuma** |
| `capture-wave-5-cenarios` | duas, **benignas** (uma registra o critério como `BLOQUEADO` **antes** de retornar; a outra é o `SELFCHECK`, outro programa) |
| `capture-wave-6` | **uma, estrutural** — a que o mordeu. Já consertada. |

> **Os outros quatro registram em TODOS os ramos, inclusive nos `else` de indisponibilidade.** O modo
> de falha não tem por onde entrar neles hoje.

**Decisão: não converter agora** — e ele **declarou a não-ação** (§7.100), aplicando a lei do próprio
dia. Converter seria *churn* com ganho marginal quase zero **hoje**; o ganho é **preventivo**, contra
um `return` que alguém acrescente amanhã. Recomendação dele, que aceito: **converter quando cada
aparato for tocado pelo próximo motivo**, em vez de num mutirão.

### E uma correção no raciocínio dele, que mantém a decisão e a fortalece

Ele justificou parte da recusa pelo risco de **errar uma lista à mão** (72 nomes de critério). **Esse
risco é menor do que ele supõe** — porque o mecanismo é **auto-protetor**: critério declarado e não
registrado sai como `AUSENTE`, e critério registrado **fora** da lista **estoura**. Uma lista errada
**falha alto** nos dois sentidos.

> Então a decisão não se sustenta no risco — sustenta-se no **churn**: mexer em quatro arquivos verdes
> e estáveis **véspera de uma wave aterrissar** é custo real com ganho hipotético. **O motivo certo
> importa: sustentar uma decisão boa num argumento fraco a derruba na primeira contestação.**

### E a nota dele sobre a §7.108

> *"A distinção entre alvo ausente e critério ausente eu só vi porque **cometi a segunda depois de
> consertar a primeira**. Não foi análise, foi tropeço — e o que ficou útil é que **consertar uma
> classe de ausência não diz nada sobre as vizinhas**. Se existe uma terceira, eu ainda não a
> conheço."*

**Consertar uma classe não prova nada sobre as vizinhas** — e a última frase é a postura certa: não
declarar cobertura que não se mediu. É a §7.115 (*a próxima falha entra pela forma que falta*) dita do
lado de quem conserta.

---

## §7.119 — O teste de conservação: some o que entrou e compare com o que saiu

O @DevVivo escreveu um teste **que ninguém pediu** e registrou o porquê:

> *"'Nenhum item se perde no agrupamento'. É chato e óbvio, e é **exatamente o tipo de bug que esta
> wave existe para eliminar** — um erro de índice ali **ESCONDERIA ATIVIDADE sem nada acusar**, e a
> timeline continuaria parecendo completa."*

**Custo: quatro linhas.** Cobertura: a família inteira de *"agrupamento que come linha"*.

> **Onde uma transformação reorganiza uma coleção, some o que entrou e compare com o que saiu.** Não
> importa **como** o erro aconteceu — índice, filtro, borda de bloco: **conservação quebra em todos
> eles**, e a asserção não precisa antecipar a forma (§7.115).

E o motivo de valer particularmente **aqui**: a timeline é a superfície onde **"faltar" é invisível**.
Uma linha a menos não deixa buraco — o conteúdo simplesmente **fecha por cima**. É o mesmo formato de
*"aparece menos linha também é o que se vê quando a timeline perdeu eventos"* (§7.80), agora com um
guarda barato.

**E ele começou pela REGRA, não pela tela:** `agrupaTimeline` como função pura, *"porque a regra é o
que pode estar errado — o Sheet é só onde ela aparece"*. Mesmo movimento da Wave 5 (schema antes da
UI), e pelo mesmo motivo: **a superfície não é onde mora o defeito, é onde ele aparece.**

## §7.120 — Aviso que está no CAMINHO protege; aviso que depende de procura, não

A nota mais afiada do dia sobre a §7.56, e ela acrescenta o mecanismo que faltava:

> *"O comentário do `role='group'` me poupou de desfazer a decisão da Wave 2 — mas repare que ele só
> funcionou porque estava **NO ELEMENTO**. Se estivesse no handoff, eu não teria lido: **eu não fui
> procurar 'por que este div é group', eu ESBARREI no comentário ao abrir o arquivo para outra
> coisa**."*

> **Aviso que depende de a pessoa ir procurar não protege nada. Aviso que está no caminho protege.**

A §7.56 dizia *"escreva onde a decisão é tomada"*. Isto refina: **onde a pessoa VAI PASSAR**, e não
onde o assunto pertence. São coisas diferentes — um comentário no cabeçalho do **mesmo arquivo** já
teria falhado, porque ninguém lê cabeçalho ao editar a linha 84.

> **Proteção por proximidade ao CAMINHO, não ao TÓPICO.** Quem vai errar não está estudando o assunto
> — está passando por ele para fazer outra coisa.

---

## §7.121 — Alinhamento entre critérios de otimização é sorte, não garantia

**Verificado:** as atividades gravam `Alterou a descrição` · `{"fields":["description"]}` — **só nomes
de campo, zero valores**, nem no `reason` nem no payload. E o risco era real: o lead editado se chama
**"Carlos — Clínica Vida Odonto · manutenção de protocolo"** — o título **é** o nome do cliente.

**E o @DevVivo recusou o crédito com precisão:**

> *"Não foi previsão minha. Escrevi só os nomes porque a informação útil para o próximo passo é QUAL
> campo mudou, não o conteúdo. Cheguei pelo lado da **utilidade**, vocês chegaram pelo lado da **PII**,
> e o desenho é o mesmo. **Mas se eu tivesse otimizado para 'timeline mais informativa', teria posto o
> antes-e-depois e o vazamento seria meu.**"*

**Quarta recusa de crédito do dia** (§7.59-a *sorte*, §7.88 *proximidade*, §7.116 *absurdo*) — e esta é
a variante mais sutil: **não é descuido, é que outro critério igualmente sensato leva a outro lugar**.

> **A proteção não pode depender de qual critério a pessoa escolheu otimizar.** Dois critérios
> razoáveis convergirem no mesmo desenho é **alinhamento**, e alinhamento é circunstancial: muda com a
> pessoa, com o humor da sprint, com o que o PM pediu naquela semana.

**Consequência prática, que é a §7.120:** a regra *"o `reason` nunca mostra valor de campo do lead"*
precisa estar escrita **onde alguém otimizando por "timeline mais informativa" vai passar** — no
emissor, não no briefing. Quem for enriquecer a frase não vai estar pensando em LGPD; vai estar
pensando em ser útil.

### E a distinção que ele guardou como está

> *"Não é 'reason nunca mostra antes e depois'. É **'reason nunca mostra VALOR DE CAMPO DO LEAD'**. A
> **origem do texto** é que decide, não a forma da frase."*

Sem essa formulação, alguém aplicaria a regra na Wave 4 e **quebraria o único caso em que o
antes-e-depois É a informação inteira** — a autorização vencida, onde o texto é do **próprio agente**,
livre de PII por contrato.

### Ruling menor: fica `tags`

**Verificado:** a UI diz `"Tag: todas"` (`FilterBar.tsx:111`) e `aria-label="Tag: ..."`
(`KanbanCard.tsx:140`). **Fica `tags`.**

> **Vocabulário de UI não se traduz num lugar só.** Traduzir apenas no rótulo criaria **dois nomes para
> a mesma coisa na mesma tela** — e o usuário não tem como saber que são a mesma. Se um dia mudar,
> muda **em todos**, nunca em um.

---

## §7.122 — A promessa impressa ANTES do trabalho sobrevive à morte do processo

O @QAVivo pegou a §7.109 (*guarda que vive no fluxo herda as falhas do fluxo*) e foi ver **o que ela
ainda deixava aberto**. O guarda dele herdava **duas** falhas, e ele só tinha consertado uma:

| falha herdada | coberta por |
|---|---|
| `return` antecipado | **`finally`** ✅ |
| **morte do processo** (`SIGKILL`) | **nada** ❌ |

**A solução não impede a morte — muda o que sobra dela.** O placar imprime os **N critérios prometidos
antes do primeiro trabalho**:

> Quem lê uma saída truncada consegue dizer **o que faltou**, em vez de só ver **onde parou**. **Sem a
> promessa, log truncado é indistinguível de um aparato que só tinha dois critérios.**

**Provado matando o processo**, não argumentando: `SIGKILL` aos 4 segundos, log com 9 linhas, **zero
linhas de fechamento** — e a linha da promessa com os 10 critérios **está lá**.

### E a nota honesta é a doença do dia um nível acima

> *"Precisei de **três tentativas** para matar no momento certo: aos 25s e aos 9s a rodada já tinha
> terminado. **Registro porque quase concluí 'a promessa sobrevive' de uma execução que simplesmente
> NÃO FOI INTERROMPIDA** — teria sido um verde por ausência de teste, **no teste do próprio guarda**."*

**Testando o guarda contra a morte, ele quase colheu um verde de uma execução que nunca morreu.** É a
§7.44 (*mutação que não mutou*) na camada do processo: **a preparação — matar — falhou, e a medição
rodou assim mesmo**.

### Imunidade por escolha × imunidade por acidente, na mesma pessoa

Minha nota sobre imunidade acidental (§7.110) o fez olhar para as próprias peças:

| peça | imunidade à morte do processo | história |
|---|---|---|
| limpeza dos aparatos | `finally` **+ entrada da execução seguinte** | **escolha** — depois de deixar lixo no board compartilhado |
| placar | promessa antes do trabalho | **acidente até agora** |

> **Duas peças do mesmo autor, com o mesmo problema e histórias diferentes** — e só a comparação
> revelou qual era qual. **Imunidade que você não sabe explicar é imunidade que some no próximo
> refactor**, porque nada a defende quando alguém "simplifica".

---

## §7.99-a — A pergunta decide o CUSTO da cerca, e há uma terceira categoria

O @QAVivo aplicou a §7.99 **critério a critério** ao fechar a narrativa da Wave 5, e tirou uma
consequência que eu não tinha:

| resposta a *"ainda dá para escrever o estado ruim?"* | o que a cerca guarda | custo |
|---|---|---|
| **NÃO** — a constraint recusa | a **eliminação** | pode rodar **raro** — existe para o dia em que alguém afrouxar a trava |
| **SIM** — derivar a faixa do número é **uma linha** | o **comportamento** | tem de rodar **sempre**, porque **código volta** |

> **A pergunta não classifica só a natureza da cerca — decide o CUSTO dela.** E separou o que ele
> tratava como um bloco único.

### E a terceira categoria, que ele achou e eu não previ

> *"Não consigo classificar `T15.c` (zero contra ausente). O estado ruim (`score || traço`) **é
> escrevível** — então seria cerca de comportamento. Mas **o defeito nunca existiu no produto**, então
> **a cerca nunca reprovou nada e eu não sei se ela morde**."*

**Cerca cujo alvo nunca existiu não é classificável pela pergunta** — porque a pergunta assume que houve
um estado ruim real. E a resposta certa é a §7.106: **submetê-la ao conserto errado** e ver se reprova.
Ele já planejou fazer isso ao fechar a Wave 6, do mesmo jeito que fez com a cerca da histerese.

### Duas decisões de narrativa que valem por si

**1. Manter o defeito no texto depois de resolvido.**

> *"Narrativa que só conta o estado final **apaga o motivo de as cercas existirem**. Quem ler daqui a
> três meses precisa saber que houve um dia em que a lei do porquê era cobrada numa chave que a UI
> nunca lia."*

**Cerca sem a história de origem parece paranoia** — e paranoia é o que se apaga primeiro numa
limpeza.

**2. Regenerar as capturas com a árvore limpa.** As antigas nasceram de árvore suja e carregavam os
**dois** carimbos (`-ARVORE-SUJA-CASO-CONSTRUIDO`) — honesto, e insuficiente:

> **Prova que se acusa de não-veredito não sustenta afirmação.** O artefato auto-acusatório é **registro
> bom e evidência ruim**: serve para dizer *"isto aconteceu assim"*, não para sustentar *"portanto o
> produto faz X"*.

## §7.123 — Componente correto no substantivo errado

O QAVivo achou o dossiê de um negócio com quatro atividades dizendo **"Nada aconteceu com este
negócio ainda."** A causa não é um defeito na timeline. A timeline está **certa** — sobre o
CONTATO. Ela foi reusada como dossiê do NEGÓCIO, que é outro substantivo.

Isto é uma classe própria de defeito, e ela engana de um jeito específico: **a peça passa em toda
inspeção interna, porque a peça não tem nada de errado.** Quem investiga entra nela e não acha
nada — e sai concluindo que o problema é ambiente, dado ou sorte. O erro não está DENTRO de
nenhum dos dois lados; está na **junção**, que é o único lugar onde ninguém é dono.

Sinal de reconhecimento: **um comentário que defende bem a peça e não menciona o consumidor.**
O comentário do hook argumentava "filtrar por lead_id deixaria de fora a atividade que nasce da
conversa" — verdadeiro sobre a timeline do contato, e mudo sobre o único caso que quebra: o
negócio SEM contato, que não recebe nenhum dos dois eixos. Defesa boa da peça isolada é o
disfarce mais eficaz deste defeito, porque quem lê o comentário para de procurar.

**A pergunta que separa:** não "esta peça está correta?", e sim "correta SOBRE O QUÊ?".

## §7.123-a — Zero linhas não autoriza nenhum dos dois lados

Medido: a atividade "nascida da conversa" que o comentário protege tem **zero linhas** (toda
atividade com contato também tem lead). E o vazamento entre negócios irmãos que eu encontrei —
o dossiê de A somando as atividades de B — também tem **zero linhas** hoje, embora o código o
produza.

A tentação é usar o zero como argumento, e ela vem nas duas direções: *"o medo do comentário é
vazio, filtre por lead e pronto"* e *"meu vazamento não acontece, deixa quieto"*. **As duas são
o mesmo erro** — contagem de hoje respondendo pergunta sobre o que o código permite.

A saída não é escolher quem ganha o argumento: é **a cláusula que dispensa o argumento**. Ancorar
no lead e unir com `contact_id = <contato> and lead_id is null` custa uma linha, é hoje
EXATAMENTE equivalente a filtrar só por lead (porque o conjunto é vazio), preserva o que o
comentário teme perder se algum dia aparecer, e exclui o irmão por construção.

**Quando uma linha compra as duas hipóteses, medir qual delas está certa é trabalho jogado fora.**

## §7.124 — Critério que exige a FORMA reprova o melhor com o mesmo vermelho do pior

Um critério exigia a string `"Você/time"`. O produto escreve o NOME da pessoa (`"E2E Manager"`),
que é mais específico. O critério reprovaria um acerto.

O que torna isto perigoso não é errar — é que **o vermelho é idêntico nos dois casos**. "O produto
fez pior" e "o produto fez MELHOR do que eu imaginei" produzem exatamente a mesma falha, com a
mesma mensagem. O critério não tem como distinguir, porque ele só sabe comparar com a única
resposta que já estava na cabeça de quem o escreveu.

**Consequência operacional:** vermelho de critério-por-forma não significa "defeito". Significa
**"vá olhar a tela"**. Quem trata o vermelho como veredito conserta o produto para caber no
instrumento — e o conserto torna o produto pior, com um verde para provar.

### §7.124-a — E a forma exigida era REAL. Estava no caminho degradado.

Aqui está a parte que salva a lei de virar "não invente strings": `"Você/time"` **existe no
produto**, em `actorLabel`. O critério não foi inventado — foi calibrado contra um texto de
verdade. Só que esse texto é o **último recurso**, o que aparece quando o nome FALTA (usuário sem
`full_name`, agente apagado).

Então conferir que a string existe no código **não teria salvado ninguém**: ela existe. O critério
estava certo sobre a forma e errado sobre o CASO — mirado no caminho degradado, disparado no
caminho feliz. E a direção do erro é a cara: o caminho degradado produz a saída mais pobre, então
o critério cobrava do produto que ele **piorasse**.

**A pergunta que separa não é "esta string existe?", é "existe NESTE caso, e este é o caso que eu
quero provar?".**

## §7.125 — O conjunto de critérios não é revisado por ninguém

Dois critérios do mesmo lote disputavam o mesmo comportamento em direções opostas: um exigia que a
timeline AGRUPASSE atividades do mesmo ator; o outro ancorava sua medição no texto de uma
atividade individual — que só existe se **não** houve agrupamento. Não é possível os dois passarem.

Cada um, lido sozinho, é razoável. **A incoerência não está em nenhum dos dois — está no par.** E o
par é justamente o que ninguém lê: revisão de critério é sempre item a item, e a lista inteira só
é olhada como contagem ("10 critérios, 6 verdes").

É a §7.123 cometida no INSTRUMENTO em vez de no produto: peças corretas isoladamente, defeito na
JUNÇÃO — o único lugar sem dono. Vale a mesma detecção: **dois critérios que tocam o mesmo
comportamento têm de ser lidos JUNTOS**, e se um exige X enquanto o outro depende de não-X, o
defeito é o par, independentemente de qual dos dois esteja "certo".

## §7.125-a — Um caso por critério; reusar o caso é o alvo sorteado uma escala acima

O lote inteiro rodava sobre UM lead — o lead sem contato, porque um dos critérios é sobre
exatamente isso. Os outros precisam de timeline POPULADA, e sem contato ela nunca carrega: mediam
colapso e rótulo numa tela que não tinha como mostrar nada, e chamariam de defeito de apresentação
o que era ausência de eixo.

**O caso vira "o lead que eu tinha à mão" em vez de "o lead que este critério exige"** — e isso é a
lei do alvo sorteado subindo um nível: não é mais a LINHA escolhida sem ordem, é o CENÁRIO inteiro
herdado por conveniência. O sintoma é o mesmo e é o pior possível: o critério mede o que quer sobre
um sujeito que não pode exibi-lo, e o vermelho aponta para a superfície errada.

**E trocar o caso tem custo, que precisa ser pago na hora:** todo critério que nomeava uma linha
específica passa a apontar para o lugar errado, e **nada avisa quais**. Trocou o fixture, releia a
lista inteira — não os que você lembra de ter mexido.

## §7.126 — Contraste DENTRO de um artefato vale mais que dois artefatos contrastantes

A captura do colapso pegou, sem ninguém ter pedido, as duas metades da regra na MESMA imagem:
duas `lead_edited` do mesmo ator no mesmo minuto **agrupadas** em "E2E Manager · 2 ações", e logo
abaixo nove `Mudou de estágio` do MESMO ator **não agrupadas**, porque estão em minutos distintos
(10:13, 10:12, 10:10, 09:57…).

Uma imagem só de colapso não prova a regra. Ela é compatível com "a regra funciona" **e** com "a
regra agrupa tudo" — e as duas hipóteses produzem a mesma foto. É o **contraste** que exclui a
segunda, e não a foto.

E o contraste vale mais aqui do que se viesse de duas capturas separadas, pelo motivo da lei do
teste confundido: **entre dois artefatos, qualquer outra coisa também pode ter mudado** (outro
lead, outra sessão, outro estado do banco). Dentro de um, o ator é o mesmo, o render é o mesmo, os
dados são os mesmos — **só o tempo decorrido difere**. É o experimento controlado saindo de graça,
e é mais forte que o unitário da janela, que prova a função e não prova que os dois ramos dela
chegam à tela distinguíveis por um leitor.

**Ao capturar regra com limiar, enquadre para pegar os dois lados.** Uma foto do lado que passa é
meia prova, e a metade que falta é justamente a que separa "regra" de "sempre".

## §7.127 — Saiba contra QUE SUPERFÍCIE o guarda mede

Terceiro tropeço na mesma lei (§7.98), agora por ORDEM: o `git add` ficou DEPOIS dos gates, e o
guarda de evidência reprovou — corretamente — porque viu o handoff citando imagens não
versionadas.

As três posições em que já se tropeçou não são arbitrárias, e enxergar o eixo comum encerra a
série: **cada guarda lê uma superfície diferente** — o disco, o índice, o HEAD. `git add` não é
preparação do TRABALHO; é preparação do **campo de visão do medidor**. O guarda de evidência mede
o índice, então trabalho que só existe no disco é, para ele, trabalho que não existe — e ele está
certo, porque é exatamente a §7.84 que ele foi criado para pegar.

**A pergunta antes de rodar qualquer gate: contra qual superfície ele mede, e o que eu preciso ter
posto lá?** Preparação completa não é "terminei"; é "está visível de onde o guarda olha".

E anote a graduação: este guarda **acabou de reprovar o próprio autor**, que é a condição da
§7.106. Ele deixou de ser instrumento presumido e passou a instrumento provado — não porque alguém
o revisou, mas porque mordeu.

## §7.128 — Cerca de comentário: nomeie a IDEIA ATRAENTE, não a regra

A regra "o `reason` nomeia os campos, nunca os valores" existia no briefing e não existia no
emissor. Posta no código, ela só protege se estiver escrita de um jeito específico — e a razão
está na §7.67: **quem vai vazar não desobedece a regra; não RECONHECE que o seu movimento cai
sob ela.**

Enunciar a regra ("sem PII no `reason`") não basta, porque a pessoa competente lê, CONCORDA, e em
seguida acrescenta o valor — para ela aquilo não é "PII", é "o detalhe útil". A cerca só é
reconhecida se **nomear o movimento tentador em primeira pessoa**: *"mostrar o antes-e-depois
parece só deixar a timeline mais informativa — e neste produto o TÍTULO É O NOME DO CLIENTE"*.

Anatomia da cerca que funciona, nesta ordem: **(1)** o movimento que a pessoa está prestes a
fazer, dito com as palavras dela; **(2)** por que quebra NESTE produto em específico, não em
abstrato; **(3)** para onde vai quem precisa daquilo (`api_audit_log`, sob controle de acesso) —
cerca sem saída vira obstáculo a contornar; **(4)** a EXCEÇÃO junto, senão a regra é aplicada onde
não vale e quebra outra coisa.

### §7.128-a — Review não protege contra erro DEFENSÁVEL

É a consequência operacional, e é a que decide onde gastar comentário. Nos casos comuns, a
alternativa ao acerto é o **descuido** — e descuido é pego por tipo, teste e review. Aqui a
alternativa era **outro desenho razoável**: "timeline mais informativa" é critério que qualquer
pessoa competente defende numa review — e ganha, porque a defesa é genuinamente boa.

**Review é filtro de competência: pega o que PARECE errado.** Erro alcançado por raciocínio bom
parece certo também para quem revisa, e a review é justamente a arena onde ele é defendido. Logo,
contra este erro o processo não serve — a cerca tem de estar no CÓDIGO, no ponto do movimento.

**Inverte o instinto de onde comentar:** não no trecho complicado (esse assusta, e o susto já
protege), e sim **onde o erro é ATRAENTE**. Comente onde alguém competente iria com convicção para
o lugar errado.

### §7.128-b — A exceção separada pela ORIGEM, não pela FORMA

A exceção foi escrita certa e o critério dela merece destaque: a atividade de autorização vencida
mostra antes-e-depois DE PROPÓSITO, porque lá o texto é a proposta do próprio agente, escrita por
máquina. **A origem do texto decide, não a forma da frase.**

Uma regra ancorada na forma ("a frase mostra antes-e-depois?") proibiria o caso legítimo. É a
§7.124 aparecendo do outro lado do sistema — lá um critério exigia a FORMA e reprovava um acerto;
aqui uma regra por FORMA proibiria um acerto. **Mesma doença, superfícies opostas: confundir a
aparência com a coisa.** Quando aparecer dúvida sobre uma regra, pergunte de que ela depende de
verdade — quase nunca é do formato.

## §7.129 — Critério mal escrito não só reprova errado: EMPURRA para o defeito

Um critério exigia o nome do campo dentro do `reason`. A implementação põe os nomes no payload —
seria mais um acerto reprovado. Mas o falso vermelho era o menor dos problemas.

**O título do lead É o nome do cliente.** Um critério exigindo os campos no texto empurraria alguém
a escrever o VALOR ali para fazer o vermelho virar verde — e o log de auditoria, que **sobrevive à
anonimização**, viraria vazamento permanente. O critério teria criado o defeito que a wave inteira
existe para impedir, e entregue um verde como prova.

O mecanismo: **critério é especificação com autoridade, inclusive quando está errado.** A única
maneira de apagar um vermelho é mudar o produto, e o critério diz em qual direção. Quem escreve
critério está escrevendo produto — com a diferença de que ninguém revisa critério como revisa
código.

**Ao escrever um critério, pergunte o que aconteceria se alguém o fizesse passar do jeito mais
direto.** Se a resposta é um produto pior, o critério é um defeito esperando executor — e o teste
que o denuncia não existe, porque ele PASSARIA.

## §7.130 — Localize pelo que o próprio teste não pode alterar

Dois critérios sumiram do placar como AUSENTE porque um critério anterior **edita o título**, e os
localizadores seguintes procuravam o nome antigo. Não é fixture trocado por um humano (§7.125-a) —
é a **suíte mutando o próprio caso como efeito de um critério fazendo o trabalho dele**.

E nada avisa: o localizador não encontra, o critério não roda, e sem placar declarado ele
desapareceria em silêncio — no mesmo dia em que o placar foi construído exatamente para isso.

**Regra:** localize pelo atributo que a funcionalidade sob teste não toca — o ID, não o texto. Se o
produto sabe editar aquilo, o teste não pode depender daquilo para se achar.

## §7.131 — Critério nascido antes da peça só pode citar a forma imaginada

Sete critérios reprovaram acertos do produto num único turno, todos da mesma doença: exigir a forma
em vez da coisa. Sete é muito — e não são sete descuidos, são **uma consequência estrutural**.

O critério foi escrito ANTES da peça existir. Nesse momento não há produto a que se referir: a
única coisa disponível para citar é a forma que quem escreve imaginou. **Escrever critério antes da
implementação continua certo** — é o que impede racionalizar o resultado depois. Mas o preço é que
a forma citada é sempre um palpite, e o palpite entra no critério com a mesma aparência de
requisito que o resto.

**As duas saídas, e são baratas:** escreva o critério sobre o **fato observável** ("o leitor
consegue saber quem agiu") em vez do **desenho** ("aparece a string `Você/time`"); e quando a forma
for inevitável, **marque-a como palpite no próprio critério**, para que o vermelho seja lido como
"confira se o produto fez diferente" e não como "o produto errou".

Pergunta padrão antes de reportar: **"estou exigindo a coisa, ou a forma dela que eu imaginei?"**

## §7.132 — Numa superfície que AGRUPA, ausência de texto não é evidência; só a contagem é

Um critério ia procurar o TEXTO da atividade do irmão para provar que ela não vazou. Ela é do mesmo
ator que as demais — então, se vazasse, colapsaria DENTRO do bloco. **"Não vejo a frase" é também
exatamente o que se vê quando ela está agrupada.** O critério teria dado VERDE sobre um vazamento
invisível por agrupamento.

Este é o oitavo critério errado do dia e o PRIMEIRO na direção perigosa: os sete anteriores eram
falsos VERMELHOS, que custam uma ida à tela. Falso VERDE **encerra a pergunta** — ninguém volta a
olhar o que já passou.

**O que distingue é a CONTAGEM.** O bloco que anuncia "3 ações" é o único elemento que separa
*agrupar o que é meu* de *somar o que não é*. Texto tem duas causas para faltar; número tem uma.

**Regra geral:** toda asserção de AUSÊNCIA feita sobre superfície que colapsa, trunca, pagina ou
esconde atrás de clique é inválida por construção — a ausência que ela observa é indistinguível da
ocultação. Asserção de ausência precisa de um observável **que sobreviva ao agrupamento**: uma
contagem, um total, um id.

**Ação imediata:** varrer a suíte atrás de todo critério que afirma "X não aparece" sobre a
timeline. Cada um é um falso verde esperando o caso que o exercite.

## §7.123-b — Defeito de JUNÇÃO morre quando a junção muda, sem ninguém consertar a peça

Eu havia registrado uma segunda metade no eixo: a rota por contato soma no dossiê de A as
atividades do irmão B. Medido depois, com caso construído: **não vaza.** E o motivo não é que
alguém consertou a rota — é que o dossiê **deixou de usá-la**, ganhou rota própria ancorada no lead.

A rota por contato continua fazendo exatamente o que eu descrevi, e **está certa fazendo** — na
página do contato, somar as atividades de todos os negócios dele é o comportamento correto. O
"vazamento" nunca foi defeito daquela peça; era defeito de ela estar respondendo por outro
substantivo (§7.123).

**Corolário prático, e ele quase me custou um conserto errado:** ao reportar defeito de junção,
**diga QUAL junção** — "a rota X consumida por Y". Reportado como defeito da peça, alguém vai
"consertar" código correto, e o conserto piora a peça no lugar onde ela estava certa.

E o inverso serve de teste: **se o defeito some quando você troca o consumidor, sem tocar na peça,
então ele sempre foi de junção.**

## §7.133 — Verde no minuto do nascimento não prova que o critério mira onde diz mirar

Uma guarda de PII foi acrescentada, conferida, e passou — **pelo motivo errado**. Ela procurava o
título antigo do lead certo, enquanto o valor gravado vinha de outro lead. Passava pela segunda
cláusula. Teria ficado ali guardando PII **procurando o que nunca é escrito**.

O verde de estreia é a evidência mais fraca que existe sobre um instrumento: ele demonstrou
exatamente uma coisa — **que não quebra**. Não demonstrou que distingue, que é a única coisa que
importa numa guarda.

**E o mecanismo específico: asserção composta esconde qual metade passou.** "Os nomes têm de estar
E os valores não podem" é uma conjunção; o verde diz que a conjunção valeu, e **não** diz que cada
metade foi exercitada. Uma metade pode estar passando por vacuidade — a condição nunca teve chance
de ser violada — e a outra carrega o resultado sozinha.

**Ritual de nascimento de toda guarda de AUSÊNCIA:** escreva uma vez a coisa proibida e exija o
VERMELHO. Guarda de PII que nunca viu PII jamais demonstrou que enxerga PII. É a lei da sabotagem
aplicada ao caso mais difícil — sabotar uma guarda de ausência exige PRODUZIR o proibido, e é
justamente por ser incômodo que ninguém faz.

## §7.125-b — A detecção do par incoerente foi acidental; torne-a mecânica

A incoerência entre dois critérios não foi percebida por leitura. Foi percebida porque os dois
falharam **na mesma rodada** e as mensagens se contradiziam na tela. **Se um deles estivesse
bloqueado por outro motivo, o outro teria sido "consertado" e a contradição seguiria viva.**

Ou seja: a detecção que eu propus (ler o par junto) está certa e é **frágil** — depende de
simultaneidade e de alguém reparar. Pela §7.99, isso pede cerca, não disciplina.

**Cerca proposta, e ela é barata porque o placar já existe:** cada critério declara, além do
esperado, **o OBSERVÁVEL que ele lê** — superfície + elemento (ex.: `timeline/bloco-agrupado`,
`timeline/linha-individual`). Com isso, "dois critérios lendo o MESMO observável com expectativas
opostas" deixa de depender de coincidência e vira **checagem que o próprio placar roda antes da
suíte**. Treze critérios declararem uma string a mais custa minutos; a alternativa é continuar
apostando que os dois vão falhar no mesmo dia.

## §7.134 — Afirmar sobre mais do que se perguntou (e é a única variante MECANIZÁVEL)

Um critério selecionava um conjunto de campos e afirmava sobre **outro**. O campo vinha `undefined`
— ausente da RESPOSTA, não ausente do BANCO — e virou o laudo "grava sem dizer o que mudou" sobre
uma coluna que o instrumento **nunca pediu**. O vermelho sai idêntico ao de um defeito real.

Os dois números nunca estiveram brigando: um era dado, o outro era **a própria omissão do
instrumento com cara de dado**.

**Por que esta é fácil de cometer:** a linguagem apaga a distinção de graça. `undefined` e `null`
caem juntos em `== null`, em teste de falsidade, em `?.` e em quase toda serialização — o idioma
DEFAULT destrói exatamente a evidência que separa "não perguntei" de "não tem". Não é desatenção;
é a ferramenta trabalhando contra.

**E por isso ela é a única das nove que vira cerca em vez de disciplina:** o critério ESTOURA
quando a consulta não trouxe o campo. `undefined` acusa o INSTRUMENTO; `null` acusa o PRODUTO. Dois
estados, duas mensagens, nenhuma decisão humana no meio.

**Generaliza para todo instrumento que lê uma PROJEÇÃO** — `select` parcial, resposta de API com
fieldset, DTO, GraphQL, objeto serializado que descarta nulos. Regra: **a asserção declara o que
exigiu da consulta**, e o que não foi exigido não pode ser afirmado. É a §7.125-b uma camada
abaixo: lá se declara a superfície, aqui os campos — e aqui a declaração se mecaniza sozinha.

## §7.134-a — Não gaste critério provando que um mecanismo faz o que ele É

Ficou a pergunta de produto: "o motivo está atrás de um clique, dentro do bloco agrupado". Não é
pergunta. **Agrupamento esconder detalhe é a DEFINIÇÃO de agrupamento**, e as linhas individuais
mostram o motivo normalmente ("Movido de Avaliação para Proposta enviada"), como a captura prova.

O achado só existiria se o detalhe **não voltasse ao expandir** — e isso já está medido. Critério
que verifica que o colapso colapsa não separa nenhuma hipótese: passa sempre, e o verde não
autoriza nada.

## §7.135 — Mensagem com buraco: generalize o que falta, não reconstrua

O canal entre terminais come crases e `$` em silêncio, e uma mensagem chegou sem os identificadores
técnicos: *"a primeira versão selecionava ␣ e AFIRMAVA sobre ␣"*.

**Mensagem com buraco que ainda faz SENTIDO é a mais perigosa.** Se virasse ruído, alguém
perguntaria; como o texto continua legível, responde-se — e os buracos caem justamente onde
adivinhar é pior: nos nomes de campo, tabela e função.

**A prática:** responda ao que sobrou no nível em que ele é verdadeiro — *"selecionava um conjunto
de campos e afirmava sobre outro"* — em vez de preencher com o nome provável. Reconstrução acertada
e conhecimento real ficam **indistinguíveis** depois, inclusive para quem reconstruiu, e a próxima
decisão se apoia nela como se tivesse sido medida.

E o inverso, para quem envia: identificador técnico vai no heredoc, ou não vai.

## §7.136 — O veredito verde ANESTESIA a auditoria do instrumento

Ao explicar a assimetria (4 entradas, 9 saídas — quatro tópicos a 1 entrada e 2 saídas cada, mais
uma saída solta), apareceu um defeito que não estava sendo procurado: **a lista acumulava desde o
início da página enquanto os totais eram do intervalo dos ciclos.** Duas réguas no mesmo relatório.

E veio a frase que importa: *"eu ia deixar passar porque o veredito estava verde"*.

**O verde não estava errado — e é exatamente por isso que ele protege.** Ninguém audita medição que
passou. A consequência é perversa e contra-intuitiva: **defeito de instrumento acumula
preferencialmente nos critérios que PASSAM**, que é o oposto de onde a atenção vai. E cobra-se
depois, no dia em que um deles finalmente fica vermelho: a investigação começa pelo produto,
porque "esse critério sempre funcionou".

Junta com a §7.133 e fecha o par: **verde de estreia** não prova que o instrumento mira; **verde de
maturidade** impede que alguém vá conferir se ele mirava.

### §7.136-a — Exigir a explicação de um número verde é barato e desproporcional

A pergunta que achou isto não era sobre isto. Era "por que 4 entradas para 5 aberturas?". **Exigir a
explicação de QUALQUER número força a decomposição, e é a decomposição que expõe réguas
diferentes** — nenhuma asserção acha isso, porque as duas réguas concordam com o veredito.

**Regra:** número que sustenta veredito e não tem explicação declarada não é resultado, é
coincidência ainda não investigada. Vale principalmente para os verdes — os vermelhos já são
explicados por obrigação.

### §7.136-b — A previsão registrada ANTES do conserto é cerca, e custa uma linha

Ficou escrito no próprio critério, antes de o eixo ser consertado: hoje são **4 entradas para 5
aberturas** porque um dos leads não tem contato e o canal é indexado por contato. **Consertado o
eixo, a contagem TEM de virar 5; se continuar 4, o conserto está incompleto.**

Sem isso, um conserto pela metade passaria numa superfície que ninguém planejou olhar, e o critério
continuaria verde afirmando que está tudo bem. **A assimetria dentro de um número verde era a
impressão digital do vermelho de outro critério** — e uma previsão é a única forma de fazer essa
digital cobrar quem a produziu.

## §7.137 — Em worktree compartilhado, `git commit` sem pathspec commita o trabalho alheio

**Eu era a "outra sessão".** Dois commits meus de doutrina (`b84b892`, `dc03a74`) carregam o conserto
do eixo, escrito por outro. Não usei `-a`: `git add BRIEFING.md && git commit` já basta, porque o
`commit` publica **o índice inteiro**, e o índice é COMPARTILHADO — o colega já tinha feito o `add`
dele. Eu tinha inclusive MEDIDO o estado staged minutos antes e reportado a terceiros; ver o `A` e
o `M` na saída e mesmo assim commitar é o defeito completo, não a falta de informação.

**Nada se perdeu; o que ficou órfão foi o REGISTRO** — dois commits cuja mensagem fala de uma coisa
e cujo conteúdo é outra. Num repositório onde o histórico é o único relato de por que algo foi
feito, isso é perda real, e silenciosa: não há conflito, não há erro, os testes passam.

**A cerca (§7.99: remove a possibilidade, não a instância):** commitar com **pathspec** —
`git commit CAMINHO -m "..."` — que ignora o índice e publica só aquele arquivo. Não depende de
lembrar de conferir o `status` antes; não há estado do colega capaz de vazar.

**E a correção do histórico não é reescrevê-lo.** Rebase/amend embaixo de sessão ativa é
destrutivo, e um commit-vazio de registro tem a MESMA corrida (levaria o `add` do outro junto,
invertendo o problema). `git notes add` anexa o relato sem tocar índice nem histórico — foi o que
os dois lados usaram.

**Escopo medido, não estimado:** dos dez commits de doutrina, exatamente DOIS carregam código
alheio; os outros oito têm um arquivo cada. A suspeita de "várias waves com registro trocado" é
falsa — só houve contaminação nos instantes em que o colega tinha índice preparado.

## §7.137-a — Conserto que devolve dados revela dívidas que a ausência escondia

Com o eixo consertado, o dossiê do lead de 111 atividades virou **20 blocos idênticos "E2E Manager ·
2 ações" empilhados**. O agrupamento está CORRETO (janela de 60s, episódios distintos) e o
resultado não informa nada.

**Isto não é defeito do conserto — é dívida que só agora pôde aparecer.** Enquanto a tela dizia
"nada aconteceu", nenhuma quantidade de dados podia expor o problema de densidade. Vale como aviso
geral: **todo conserto que restaura volume de dados deve ser seguido de um olhar na apresentação**,
porque a ausência estava mascarando o comportamento com carga real — e o time acabou de provar que
o vazio se lê como aprovação.

## §7.138 — Toda lei tem DOMÍNIO; aplicá-la fora dele produz o erro que ela evitava

A varredura por asserções de ausência achou três. A conclusão natural — e errada — seria invalidar
as três invocando a §7.123-a ("contagem de hoje não responde pergunta sobre o que o código
permite"). **Teriam sido três achados falsos.**

Porque a §7.123-a governa perguntas sobre o **POSSÍVEL** ("alguém consegue escrever este estado?"),
e a pergunta aqui era sobre o **ATUAL** ("estas três asserções valem hoje?"). Para esta, a medição
de hoje **é** a resposta — e ela foi feita: o agrupamento mora na timeline do DOSSIÊ; a do contato
não agrupa; contagem de blocos zero; ausência significa ausência.

**Lei aplicada fora do domínio vira ruído com aparência de rigor** — e o erro é simétrico ao de
ignorá-la: nos dois casos alguém reporta o que não existe. Antes de invocar qualquer lei daqui,
pergunte de que ela é lei: do que o código PERMITE, ou do que o sistema FAZ hoje.

### §7.138-a — Invalidação mecanizada é melhor que remoção

A saída adotada foi melhor que a que eu tinha pedido. Em vez de reescrever as três asserções, elas
passaram a **medir a superfície junto com o conteúdo**: se um dia aquela tela começar a agrupar,
truncar ou paginar, a asserção **se declara INVÁLIDA** e informa quantos blocos fecharam a
superfície — em vez de virar verde falso em silêncio.

**O instrumento se recusa a afirmar ausência sobre tela que esconde.** É a diferença entre corrigir
hoje e tornar o erro inescrevível amanhã — e aqui custou um contador.

E o argumento que fecha a questão contra "só desconfiar mais": **desconfiar do próprio verde não
escala.** É a única defesa disponível contra o falso verde e depende de quem está cansado às seis
da tarde. Cerca escala; suspeita não.

## §7.139 — Guarda de regressão nasce SEM PROVA por construção

Um critério escrito DEPOIS do conserto nunca viu o defeito vivo. Ele passa — e passaria também se
estivesse mirando no lugar errado, porque não há mais nada ali para pegá-lo (§7.133).

**É a única categoria de cerca que não tem como ser provada no nascimento pelos meios normais**, e
o motivo é estrutural: o defeito que ela guarda já morreu. Restam duas saídas honestas, e nenhuma
terceira:

1. **Reverter o conserto e exigir o vermelho** — caro, e é a única prova real.
2. **Declarar no próprio critério que ele é NÃO-PROVADO** — para que ninguém o cite como evidência
   de que o defeito não pode voltar.

O que não vale é o silêncio, que hoje é o padrão: uma suíte cheia de guardas de regressão
não-provadas parece proteção e é **afirmação**.

## §7.140 — Toda asserção NEGATIVA tem de excluir a explicação chata

O critério "salvar sem mexer em nada NÃO registra atividade" passaria **igualzinho** se o clique não
tivesse feito nada. O verde seria compatível com o comportamento desejado E com "nada foi tentado"
— e provaria o oposto do que afirma. A correção foi provar o gatilho antes do efeito: **(a)** um
PATCH saiu, **(b)** o `updated_at` mudou no banco, **(c)** e mesmo assim não registrou (4 → 4).

Esta é a terceira lei de ausência do dia, e as três têm **o mesmo esqueleto**: *"não vejo X"* tem
mais de uma explicação, e a asserção só vale se a explicação chata for excluída. O que muda é qual
é a chata em cada camada:

| camada | a explicação chata |
|---|---|
| ação (§7.140) | o gatilho não disparou — nada foi tentado |
| superfície (§7.132) | está lá, escondido pelo agrupamento/corte/página |
| projeção (§7.134) | não veio porque não foi pedido |

**A pergunta única, que dispensa decorar as três:** *"o que mais produziria exatamente esta
observação?"* — e prove que não foi isso. Um verde negativo sem essa exclusão não é resultado; é a
ausência de tentativa com cara de sucesso.

## §7.141 — Atividade e evento respondem a perguntas diferentes; divergir é correto

Ficou a dúvida: a atividade deixou de ser emitida quando nada muda, e o `emit_event lead.updated`
continua saindo. Parece inconsistência — **não é**, e vale registrar antes que alguém "harmonize"
os dois.

A **atividade** conta a vida do negócio para um humano: só entra o que MUDOU. O **evento** anuncia
que houve escrita, e é gatilho de automação: quem escuta quer saber que o registro foi tocado,
inclusive quando o resultado foi idêntico. Suprimir o evento mudaria o comportamento de automações
já existentes — é alteração de contrato, não limpeza.

**Regra:** antes de igualar dois emissores porque "os dois falam da mesma mutação", pergunte quem
ESCUTA cada um. Emissores com plateias diferentes têm o direito de discordar.

## §7.142 — O mesmo `undefined` mordeu o instrumento e quase mordeu o produto, no mesmo dia

No instrumento (§7.134): um critério afirmou sobre um campo que a consulta não trouxe, e leu
"ausente da resposta" como "ausente do banco".

No produto: ao comparar o patch com o estado anterior, ler o anterior com **lista fixa de colunas**
faria um campo NOVO cair contra `undefined` e ser marcado como alterado **em toda edição** — o
defeito voltando por outra porta em seis meses. A saída foi ler o estado anterior inteiro; custo
zero, porque a consulta já existia.

**A confusão `undefined`/`null` não é um erro de teste nem um erro de handler — é um buraco do
idioma**, e ele aparece em qualquer camada onde algo é lido parcialmente. Onde houver projeção,
pergunte se "não veio" e "não tem" estão separados.

## §7.143 — Exigir dados representativos para provar propriedade do ALGORITMO é um portão que nunca abre

Eu condicionei o conserto da densidade da timeline a uma medição: *"ataque quando a mediana passar
de ~30"*. **A regra estava errada, e de dois jeitos.**

**Primeiro, a conversão que eu não medi.** Li "mediana 9 atividades" e concluí "um punhado de
blocos" — supondo taxa de colapso que ninguém apurou. Medido depois: um lead com **26 itens produz
26 blocos, zero colapsáveis**. Nove atividades espalhadas dão nove blocos. Minha inferência
carregava uma premissa escondida sobre o comportamento que eu estava justamente avaliando.

**Segundo, e é o erro de método:** o defeito é **propriedade do algoritmo**, não previsão sobre
dados. O agrupamento junta dentro de 60s e **não tem mecanismo de escala nenhum** — o número de
blocos cresce linearmente com episódios distintos, sem teto. Isso se prova lendo o algoritmo. Exigir
dado representativo para aceitá-lo adia indefinidamente um conserto por falta de uma evidência que
**este ambiente não pode produzir** — e o portão parece rigor.

**E o agravante, que só apareceu porque ele foi medir:** os dados disponíveis eram artefato das
próprias sondas (116 de 116 atividades do alvo eram `stage_changed` das últimas 24h, geradas pelo
time). O intervalo mediano entre elas é 99s e a janela é 60s. **Calibrar a janela ali seria calibrar
contra a cadência das próprias sondas** — e teria FUNCIONADO, produzindo um número sobre nós mesmos
com aparência de resultado sobre o produto.

**A distinção, e ela decide qual pergunta merece medição:**

| a afirmação é sobre… | prova-se por |
|---|---|
| o que o ALGORITMO faz para qualquer entrada | ler o algoritmo — dado não acrescenta |
| o que os DADOS REAIS fazem hoje | medição, e só vale com amostra não fabricada por você |

Pedir a segunda para decidir a primeira não é cautela: é **um veto disfarçado de critério**.

**Corolário do parâmetro:** quando um limiar for inevitável, ancore-o no que o ambiente não
falsifica. Aqui: **tamanho da lista**, nunca tempo — tempo é o eixo que este banco mente.

## §7.144 — Escolha observável ESPECÍFICO DE UM CONJUNTO e INSENSÍVEL À APRESENTAÇÃO

Quase toda lei acumulada aqui é um "não". Esta é o "faça", e ela nasceu de uma coincidência que não
é coincidência: a **contagem de linhas da timeline** resolveu, sozinha, duas doenças diferentes.

- Contra a **ocultação** (§7.132): contagem sobrevive ao agrupamento — texto não.
- Contra a **contaminação** (teste confundido): contagem é de UMA lista — o texto do painel também
  mudaria pelo cabeçalho, que exibe o título editado, e a conclusão seria verdadeira pelo motivo
  errado.

As duas propriedades que explicam isso, e são o critério de escolha:

1. **Escopo:** o observável pertence a UM conjunto identificável, e nenhum elemento vizinho pode
   satisfazê-lo por acidente.
2. **Invariância de apresentação:** não muda se a tela agrupar, truncar, paginar ou reordenar.

**Texto falha nas duas** — é o observável mais disponível e o pior. Contagem, total e id passam nas
duas. Antes de escrever a asserção, escolha o observável por esse par; boa parte das armadilhas
desta entrega não teria existido.

## §7.140-a — O número de explicações chatas cresce com as camadas atravessadas

Na asserção de mesma origem havia UMA explicação chata (o gatilho não disparou). Na asserção
entre-abas há **três**: a ação não aconteceu, a entrega está morta para todos, ou chegou e a tela
não aplicou. Só a terceira é o defeito procurado.

**Cada camada entre a causa e a observação acrescenta uma forma de o resultado sair igual por outro
motivo.** Logo, asserção que atravessa processo, rede ou aba precisa de MAIS exclusões que a
equivalente local — e a prática que dá conta é confirmar cada elo no ponto onde ele é
inequívoco (a ação, no BANCO; a entrega, no canal; a aplicação, na tela). **Intenção não é efeito.**

**E a serialização que descarta nulos é a pior variante da §7.134**, porque ali o campo **foi
pedido** e sumiu no caminho: declarar o que se exigiu da consulta não protege. Nesse elo, quem
recebe também precisa distinguir "não veio" de "não tem".

## §7.145 — Visibilidade OPCIONAL não é mecanismo anti-morte (e a doutrina tinha um exemplar falso)

O cabeçalho de `lib/leads/risk-radar.ts` declara-se o desilhamento C1 da doutrina do sistema vivo:
*"uma demanda aberta que esfriou e não tem próximo passo garantido está morrendo sem ninguém ver; o
radar a torna visível"*.

**Tornar visível numa tela que ninguém é obrigado a abrir não é mecanismo anti-morte — é a mesma
morte, com testemunha opcional.** A peça que a doutrina cita como exemplo de desilhamento é, ela
própria, ilha do lado da SAÍDA: recebe de todo lado e não alimenta ninguém.

E o levantamento confirma que o buraco é estrutural, não de ênfase:

1. **Não existe como ESTADO.** `classifyRisk` é função pura recalculada a cada leitura, e todos os
   chamadores são de leitura. *"Esfriando" não existe até alguém abrir a tela.*
2. **Não existe como PALAVRA.** Nenhum tipo de atividade de risco no vocabulário — os seis tipos
   gravados são `stage_changed`, `lead_edited`, `next_action_approved`, `next_action_dismissed`,
   `ai_turn`, `note`. A timeline não sabe dizer "esfriou" nem "voltou".
3. **E o dado não é RETIDO.** Sem registro de entrada e saída, não há resposta para "há quanto tempo
   está esfriando" nem "quantas vezes já esfriou e voltou". Não é invisível — **é inexistente**.

**Teste para qualquer "solução de visibilidade":** se a única forma de o problema ser notado é
alguém decidir olhar, a solução não mudou a mortalidade — mudou quem se sente culpado.

## §7.146 — O ACERVO é a primeira prova de um mecanismo novo, e enchente queima o sinal no dia um

Medido (teto declarado, sem o `inFlight`): **48 críticos e 2 em risco, de 66 negócios abertos**. Um
mecanismo que emita demanda por transição produziria ~50 demandas no primeiro turno do worker, em
cima de um estado que ninguém sabia que existia.

**As duas saídas ingênuas são ruins, e por motivos opostos:** anunciar tudo faz o usuário descartar
em massa no primeiro contato, e um mecanismo descartado em massa no dia um **nunca mais é lido** —
queima-se o sinal antes de ele significar algo. Nascer em silêncio "absolve" 48 negócios que estão
morrendo de verdade, por decreto de migração.

**Regência:** separar o que é ESTADO do que é DEMANDA.
- **Estado para todos, inclusive o acervo** — grava-se `esfriando` e desde quando. Barato, e é o que
  finalmente RETÉM o dado (consequência 3).
- **Evento/proposta só na TRANSIÇÃO observada** pelo worker — o acervo não vira 48 propostas.
- **O acervo recebe UM item agregado** ("48 negócios já estavam esfriando quando o mecanismo
  entrou"), com dono, honesto sobre ser artefato de migração. Não floda e não absolve.

**E a decisão não esperou o número exato de propósito:** a aproximação foi declarada como teto, e
tanto 48 quanto metade disso dão a MESMA regência. **Quando os dois extremos do intervalo levam à
mesma decisão, refinar a medição antes de decidir é trabalho que não muda nada** — refine depois, se
o desenho vier a depender do número.

## §7.132-a — A propriedade é da SUPERFÍCIE, não da polaridade da asserção; e toda lei nasce estreita

A §7.132 foi enunciada para AUSÊNCIA. Ela mordeu de novo na **PRESENÇA**: um critério procurava o
texto de UMA atividade e reprovava, porque as três da IA colapsam em "Agente · 3 ações". **Reprovou
por ocultação um conserto correto.**

Exigir observável que sobreviva ao agrupamento **não é regra sobre negativas** — é regra sobre a
SUPERFÍCIE. Onde a tela agrupa, trunca ou pagina, tanto "não vejo X" quanto "vejo X" são
indistinguíveis do seu contrário. A §7.144 já dizia isso ao escolher o observável pelo par
escopo+invariância; a §7.132 é que estava estreita.

**E o padrão vale para toda esta coleção:** lei nasce com a largura do CASO que a gerou, e o caso é
quase sempre mais estreito que o fenômeno. **O sinal de que uma lei estava sub-especificada é ela
morder de novo num caso que ela "não cobria"** — quando isso acontecer, corrija o ENUNCIADO em vez
de acrescentar uma lei irmã.

## §7.147 — Previsão herda erro de modelo sobre o PRÓPRIO APARATO — e vira armadilha com cara de rigor

A previsão registrada de véspera ("4 assinaturas têm de virar 5") **não se cumpriu, e o conserto
estava completo**. Dois erros, os dois sobre o instrumento e nenhum sobre o produto: o canal deixou
de ser indexado por contato (todo lead assina, a diferença nunca foi o eixo), e o "5" era aritmética
de ciclos do próprio laço de teste — quatro aberturas dentro da janela e uma fora dela.

**Se tivesse sido mantida, teria REPROVADO UM CONSERTO CORRETO — com autoridade extra.** E é aí que
mora o perigo: a propriedade que torna previsão valiosa (registrada ANTES, logo não pode ter sido
ajustada ao resultado) é exatamente a que torna uma previsão errada mais cara que uma medição
errada. **A autoridade vem da FORMA, não do conteúdo** — então uma previsão errada herda crédito que
não ganhou, e manda alguém revisar código certo com a assinatura de quem previu em cima.

**O discriminador, antes de registrar qualquer previsão:** *o número previsto sai do comportamento
do PRODUTO, ou da estrutura do meu aparato?* Se sai do aparato, ela prevê o aparato. Previsão
continua barata e continua virando cerca — mas só depois desta pergunta.

### §7.147-a — A explicação que você mesmo escreveu deixa de ser lida como dado

O contra-exemplo estava **na mesma linha do relatório**: a saída solta já tinha sido explicada — e a
explicação **desmentia a previsão**. Ninguém a leu, porque explicar arquiva.

Uma vez explicado, o número muda de categoria na cabeça de quem explicou: vira "resolvido" e para de
ser evidência. Por isso a §7.136-a (exigir a explicação de todo número) **produz o dado e não produz
a conclusão** — falta o segundo passo, e ele é obrigatório: **depois de explicar, confira se a
explicação contradiz alguma outra coisa que você afirmou.** Explicação é dado, não encerramento.

## §7.148 — A observação sobre um estado não pode ser INSTÂNCIA do que o estado mede

`fn_update_last_activity_at` carimba `crm_leads.last_activity_at` para **qualquer** atividade —
verificado, não há filtro de tipo. E `last_activity_at` é o relógio que decide esfriamento. Logo,
emitir a atividade *"esfriou"* para que ela apareça na timeline **reseta o relógio do silêncio** e o
lead volta a "em dia" no mesmo instante.

**O produtor do estado apaga o próprio estado ao registrá-lo.** E o ciclo se repõe: 24h depois
esfria, emite, apaga — uma linha de timeline por janela, para sempre, sem ninguém ter feito nada.
**O sinal que a wave existe para criar seria destruído pelo ato de criá-lo.**

Forma geral: toda métrica do tipo *"tempo desde o último X"* é aniquilada por registrar uma
observação SOBRE ela, se o registro contar como X. **Constatar o silêncio não é quebrar o
silêncio** — carimbar o relógio da ausência de conversa com a constatação de que não houve conversa
é contradição escrita em SQL.

**Detecção, para não depender de alguém ser esperto:** ao acrescentar um escritor novo numa tabela
que alimenta métrica derivada, pergunte se as linhas novas são **instâncias do que a métrica conta**.
Se forem, ou a métrica muda de definição, ou o escritor é excluído dela — e as duas exigem decisão
explícita.

### §7.148-a — Lista POSITIVA, não lista de exceções (a assimetria decide)

O filtro que salva o ciclo tem duas formas, e elas não são equivalentes.

- **Lista negativa** ("ignore `lead_cooled` e `lead_reactivated`"): um tipo novo de observação de
  sistema, daqui a seis meses, **volta a carimbar o relógio**. O lead parece vivo estando morto —
  **morte silenciosa**, que é a doença que o épico inteiro existe para curar.
- **Lista positiva** ("só estes tipos contam como interação"): um tipo novo de interação real fica
  de fora e o lead parece frio estando quente — **alarme falso**, visível e irritante.

Pela assimetria que governa esta entrega, **a lista positiva vence**: o modo de falha dela é ruído
que alguém reclama; o da negativa é silêncio que ninguém vê. O default para o que ainda não existe
tem de ser o erro barulhento.

## §7.149 — O acervo entra com o `since` VERDADEIRO, e o incômodo da primeira tela é a mensagem

Aprovado o refinamento sobre a minha própria regência: o seed grava `since = last_activity_at` — **o
instante em que de fato esfriou** — e não `now()`. Escrever `now()` seria um dado falso nascido junto
com o mecanismo que existe para não mentir, e destruiria a resposta a *"há quanto tempo está
esfriando"* logo na primeira linha gravada.

Fica: **estado para todos com `since` real, evento de seed no `event_log` (rastro), zero atividades
de timeline** (ninguém esfriou "agora"), **e UM item agregado com dono E AÇÃO NOMEADA** — "revise os
48 e decida quais encerrar". Item de caixa sem ação nomeada é o ruído que a própria doutrina proíbe.

**E a consequência visual é escolha consciente, não efeito colateral:** 48 de 66 cards nascerão com
borda de alerta, e uma borda que aparece em 73% do quadro não destaca nada. **Mantém-se assim mesmo,
porque é verdade** — suavizar para o quadro ficar bonito seria simulação de saúde, a mesma família da
simulação de atenção que o Arquiteto barrou. O agregado é o que transforma alarme em trabalho.

## §7.139-a — Correção: guarda de regressão precisa do ESTADO de volta, não do DEFEITO

Escrevi que restavam "duas saídas honestas, e nenhuma terceira": reverter o conserto, ou declarar a
guarda como não-provada. **Havia uma terceira, e é a mais barata das três.**

Reverter o conserto não é do QA para fazer — mas **construir o estado que a guarda vigia é**. Ligar
a atividade do irmão ao lead sob teste recria a condição que a guarda existe para reprovar, sem
tocar em uma linha de produção. Ela reprovou. Deixou de ser afirmação.

**A regra correta:**

| o estado ruim é… | como provar a mordida |
|---|---|
| construível pelos DADOS | construa-o e exija o vermelho — sem tocar no produto |
| alcançável só pelo CÓDIGO | reverter o conserto, ou declarar não-provada |

**E repare na recorrência:** minha §7.139 nasceu de um caso em que o defeito era de código, e foi
enunciada para TODAS as guardas. É a §7.132-a se aplicando a uma lei escrita há duas mensagens —
**lei nasce com a largura do caso que a gerou**, inclusive quando quem a escreve acabou de registrar
que isso acontece.

## §7.150 — Evidência capturada ANTES da mutação que ela julga

A guarda não mordeu na primeira tentativa. Motivo: ela lia um texto capturado **lá em cima**, antes
de o autocheck reabrir o painel. **Ela media o estado anterior à mutação que existia para fazê-la
morder.**

O engano é invisível porque o dado **é válido** — só que de antes. E a falha vai na direção mais
cara: produz um NEGATIVO FALSO sobre o INSTRUMENTO. Quem parasse ali concluiria "a guarda não
morde" e iria reescrever uma guarda que funciona.

**Regra:** toda asserção declara em que MOMENTO a evidência foi capturada, relativo à mutação que
julga. Foto reaproveitada de antes da mutação não é evidência sobre ela — é evidência sobre outra
coisa, com o mesmo formato.

### §7.150-a — O vermelho ESPERADO anestesia tanto quanto o verde

O vermelho apareceu e a mensagem dizia *"anuncia 3, deveria anunciar 3"* — relato incoerente. Só foi
visto porque alguém **leu a saída** em vez de comemorar que o vermelho veio.

É a §7.136 pelo avesso: o verde anestesia porque não pede investigação; **o vermelho esperado
anestesia porque confirma a expectativa** — e expectativa confirmada encerra a leitura tão bem
quanto sucesso. **Vermelho que você previu ainda precisa ser lido pelo MOTIVO de estar vermelho.**

## §7.144-a — Quando nenhum observável tem as duas propriedades, use dois — e nomeie qual disparou

Naquele caso, **nenhum observável isolado tinha ESCOPO e INVARIÂNCIA ao mesmo tempo**: o texto pega a
linha individual e é cego para o que entrou dentro de um bloco; a contagem pega o que sumiu no bloco
e é cega para a linha solta. Cada um cobre o ponto cego do outro.

Então a asserção é composta por necessidade — e cai direto na §7.133, que diz que **conjunção
esconde qual metade agiu**. A saída é a mesma dos dois lados: **o relatório nomeia QUAL cláusula
disparou.** Sem isso, um vermelho de duas cláusulas é indistinguível de um vermelho de uma, e o
laudo pode contradizer a própria evidência sem que ninguém note.

## §7.151 — "Não sei" renderizado como "está tudo bem" — a doença do épico como valor DEFAULT

A divergência medida (mesmo lead: ao vivo com faixa "Sem resposta há 4 dias" e borda âmbar;
recarregado sem faixa e borda transparente) **não é dois classificadores discordando**. Rastreado:

- a rota do board **não classifica risco** — devolve `last_activity_at` e mais nada;
- o esfriamento entra pelo `coolingIds`, que vem de **outra consulta**, `useAtRiskLeads()`, com ciclo
  de vida independente;
- e `card-state.ts` faz `isCooling: opts.coolingIds?.has(lead.id) ?? false`.

**O `?? false` é o defeito.** Enquanto a segunda consulta não chegou, o card não diz "não sei" — ele
**afirma que o negócio está saudável**. Ausência de informação vira afirmação positiva, e a
afirmação é exatamente a que o épico existe para impedir: *o card parado que parece que está tudo
bem*.

**É a TERCEIRA superfície da mesma doença hoje** — o instrumento (§7.134: critério afirmou sobre
coluna que a consulta não trouxe), o handler (§7.142: campo novo cairia contra `undefined` e seria
"alterado"), e agora a tela. Não é coincidência de pessoas: **este código transforma
repetidamente "desconhecido" em "normal"**, porque é o default gratuito da linguagem.

**A regra, e ela é de produto, não de estilo:** onde o estado desconhecido e o estado saudável
produzem a MESMA tela, o desconhecido tem de ser representado — nem que seja por ausência de
marcador em vez de marcador de saúde. Nesta entrega a assimetria já está decidida: **falso alarme é
barulhento e alguém reclama; falsa saúde é silenciosa e mata.**

**O que ainda não sei, e não vou afirmar:** se a segunda consulta nunca resolve naquele caminho
(defeito permanente) ou se resolve tarde e a medição pegou a janela (defeito transitório). **As duas
são defeito e têm a mesma raiz**; o que muda é a gravidade, e isso se decide medindo se a faixa
aparece ao esperar.

## §7.152 — O gatilho do teste tem de ser INDEPENDENTE do mecanismo sob teste

Achado de método, e é o mais fino da rodada: só se consegue provocar a travessia do limiar
**escrevendo no lead** — e escrita gera evento. Então o teste não distingue *"a tela nota o tempo
passar"* de *"a tela recomputa quando a linha muda"*. **O método mascara exatamente a diferença que
ele deveria medir.**

Forma geral: **quando o único jeito de provocar o fenômeno é acionar o mecanismo que você quer
testar, o experimento é circular** — passa com o mecanismo funcionando e passa com ele quebrado,
desde que o gatilho sozinho produza o efeito.

**Consequência para a wave 7, e ela é boa:** o gatilho honesto passa a existir com o desenho já
aprovado — **rodar o worker sem tocar na linha do lead**. Se o card mudar assim, provou-se o que a
tela promete. É mais uma razão para o estado ser escrito: sem escrita não há nem funcionalidade nem
teste possível.

E confirma o diagnóstico central: **esfriar é evento de TEMPO, não de DADO.** Quando o lead cruza o
limiar nada é escrito, logo nada é publicado, logo nenhum realtime tem o que entregar — *"muda sem
reload"* é **impossível** sem que a travessia vire escrita. O cenário 22 estar bloqueado hoje é o
comportamento correto do que existe, e reprová-lo na tela seria acusar a superfície por uma ausência
que nasce três camadas antes.

## §7.153 — Instrumento com DOIS desfechos sobre realidade que tem TRÊS

Um ataque a constraints reportou *"SEM ERRO (aceitou)"* para quatro casos inválidos — **e a tabela
nem existia** (a migration tinha falhado por permissão). O `grep` procurava só
`violates check constraint`; a ausência dessa string virou "aceitou".

**Ausência de erro de constraint não é aceitação.** Todo instrumento que classifica por
presença/ausência de UMA string tem exatamente dois desfechos, e a realidade quase sempre tem três:
*rejeitou pela constraint X*, *aceitou*, e **"aconteceu outra coisa"** — que não tem string própria e
por isso se funde silenciosamente em um dos dois. Aqui se fundiu no pior: "a trava aceitou lixo",
que é o laudo mais alarmante possível, sobre uma tabela inexistente.

**Regra:** instrumento de veredito enumera os desfechos ANTES de procurar strings, e o desfecho
"outra coisa" é sempre um deles — nomeado, nunca implícito.

### §7.153-a — Toda constraint precisa de um caso que ela DEVE aceitar

O ataque incluiu, além dos quatro inválidos, **dois casos que tinham de passar**. Sem eles, o teste
não distingue *constraint correta* de *constraint que rejeita tudo* — **apertada demais também é
defeito**, e só um dos dois lados aparece num teste só de rejeição. É a §7.126 (contraste) na camada
do schema: uma trava provada só pelo que ela barra não foi provada.

### §7.154 — Sabote onde a perda é PROVÁVEL e INVISÍVEL aos outros testes

A sabotagem escolhida não foi aleatória: removeu-se o `add table` da publicação — **a asserção que o
próprio autor marcou como a mais fácil de perder**, porque quem copiar o bloco da migration anterior
sem ler o cabeçalho inverte o sinal da publicação, e o card para de reagir sem reload. **Falha que
nenhum teste de API pega.**

Sabotar uma asserção bem coberta por outros testes prova pouco — o vermelho viria de qualquer jeito.
O alvo certo é onde as duas coisas coincidem: **perda provável** (alguém vai mexer ali) e **cegueira
do resto da suíte** (só esta asserção enxerga).

## §7.155 — A cerca me pegou: "completar" o que está certo

Ia mandar acrescentar o CHECK em `crm_lead_activities.type` — o `CLAUDE.md` manda "type é text +
check constraint", e o banco não tem. **Fui ler antes, e a ausência é DECISÃO documentada:** um clone
com tipo legado quebraria no `update.sh`, e a doutrina de migrations proíbe. O comentário no
invariante diz, com todas as letras, que quem quiser "completar" estaria consertando o que está
certo — e nomeia o movimento tentador (§7.128). **Funcionou comigo.**

**Mas o achado é real e aponta para o outro lado:** o `CLAUDE.md` e o código discordam, e **o código
tem o argumento melhor**. Doutrina que empurra para quebrar clones é pior que doutrina omissa, então
o conserto é na doutrina — a regra ganha a exceção, com o motivo junto.

**E a consequência para a peça 2 fica registrada:** sem CHECK, o vocabulário de tipos é aberto por
decisão. Então a **lista positiva** do trigger é o ÚNICO lugar que define o que conta como interação
— e um erro de digitação no emissor produz um tipo que ninguém rejeita e que a lista não conhece.
Falha para o lado seguro (não carimba o relógio), o que confirma a escolha da lista positiva, e
**exige que o emissor use constante compartilhada, nunca string literal**.

## §7.156 — Defeito cujo SINTOMA aponta para o lugar errado, e o suspeito mais recente absorve a culpa

*"O esfriamento não gruda"* manda investigar o CLASSIFICADOR. A causa está no GATILHO, três camadas
ao lado. **Sintoma que aponta para a superfície errada é o defeito mais caro que existe** — não pelo
conserto, que é pequeno, mas pelo tempo gasto onde não está.

**E o agravante é de CALENDÁRIO:** este só se tornaria visível DEPOIS da entrega, porque é a entrega
que faz a atividade de risco existir. Nesse momento haveria código novo, recém-escrito, e
**o suspeito mais recente absorve a culpa** — sempre. A entrega correta seria acusada por um defeito
que a antecede em meses.

**A defesa é barata e tem de ser feita ANTES:** medir o defeito latente **agora**, com número e data,
enquanto ainda não há nada novo para culpar. É o que converte *"o código novo quebrou"* em
*"conhecido, e anterior"*. Medição carimbada antes da entrega é a única coisa capaz de **inocentar**
a entrega — o resto é discussão.

**E foi medido, não deduzido:** lead com 96h de silêncio, uma atividade inserida, **0,0h de
silêncio**. Duas leituras independentes do mecanismo (a definição do trigger e a da função) chegaram
ao mesmo lugar, o que vale mais que qualquer das duas sozinha.

## §7.157 — Restrição de papel GERA método — e não ser mérito é justamente o que a torna melhor

A terceira saída (provar a guarda **construindo o estado** em vez de reverter o conserto) não veio de
perspicácia: veio de **não poder** fazer o que eu tinha sugerido. Reverter produção não é do QA,
então ele foi procurar o que era.

Ele registrou isso como "sorte estrutural, não mérito". **Está certo, e é por isso que vale mais.**
Quem PUDESSE reverter teria revertido — a ferramenta mais poderosa teria produzido o método pior
(mexer em produção para provar um teste). **Poder fazer a coisa cara impede de procurar a barata.**

E a consequência é de desenho de time, não de elogio: o QA não ter escrita em produção **não é só
salvaguarda — é gerador de método**. Mérito não se repete sozinho; restrição sim. É a mesma lógica
de *"desconfiar não escala, cerca escala"*, aplicada a quem pode o quê.

## §7.158 — A SÍNTESE DO DIA: ausência silenciosa se lê como aprovação

Ele nomeou o eixo, e ao conferir, **metade das leis de hoje são a mesma lei em superfícies
diferentes**:

| lei | a ausência que se disfarça de aprovação |
|---|---|
| §7.132 | não vejo o texto → mas está agrupado |
| §7.134 | o campo veio vazio → mas não foi pedido |
| §7.140 | nada foi registrado → mas nada foi tentado |
| §7.151 | o card não alerta → mas a consulta não chegou |
| §7.148-a | o tipo não está na lista de exceções → logo conta como interação |
| §7.153 | não houve erro de constraint → mas a tabela não existia |
| §7.126 | a regra agrupou → mas talvez agrupe sempre |

**Uma única doença, sete superfícies.** E o antídoto tem sempre a mesma forma: **fazer a ausência se
anunciar** — contagem em vez de texto, `in` em vez de `??`, lista positiva em vez de exceções,
desfecho "outra coisa" nomeado, o contraste enquadrado junto.

**E o fecho que importa:** esta é exatamente a doença que o épico existe para curar — *o card parado
que ninguém viu, porque nada aconteceu e nada avisou*. O time passou o dia encontrando-a **dentro
das próprias ferramentas** e **dentro do próprio produto**, em camadas que nada tinham a ver umas com
as outras. Não é coincidência temática: é o mesmo hábito de engenharia produzindo o mesmo buraco em
todo lugar onde alguém precisou representar "não sei".

## §7.159 — Ler a propriedade CSS errada devolve valor VÁLIDO e constante

Pergunta deixada em aberto: depois de a faixa convergir, a borda seguiu transparente — inconsistência
real ou seletor errado? **Rastreado no componente, e é o seletor.**

O marcador de estado é `<span aria-hidden class="absolute inset-y-0 left-0 w-0.5 bg-warning">` —
**cor de FUNDO**, não de borda. Aquele elemento **não tem borda nenhuma**, então
`borderColor` devolve `rgba(0,0,0,0)` para sempre, em qualquer estado. Não é erro, não é vazio: é o
valor correto de uma propriedade que ninguém define.

**E o agravante é o mesmo `span[aria-hidden]` do overlay de pulso**, que renderiza ANTES quando
existe pulso. Logo o primeiro match do seletor **muda conforme houve ou não evento recente** — o
instrumento lê elementos diferentes em momentos diferentes, sem avisar.

Duas correções, as duas de uma linha: ler `backgroundColor`, e escopar pelo que só o marcador tem
(`w-0.5` + `left-0`), nunca por `aria-hidden` sozinho.

**E repare que é a §7.158 outra vez, em CSS:** a ausência de uma propriedade se lê como um ESTADO
("sem alerta"). O idioma entrega um valor plausível para o que não existe, e o instrumento o aceita
como resposta. Mesmo hábito, oitava superfície.

## §7.160 — A escolha acontece ANTES da asserção existir; depois, o palpite virou objeto de defesa

Síntese dos acertos de construção da wave 7, e vale como regra de trabalho: **mesmo sujeito**,
**observável escolhido pelo par escopo+invariância**, **perna positiva antes da negativa** — as três
são decisões tomadas *antes de a asserção existir*.

Depois que o texto está escrito, ele **já carrega o palpite dentro**, e mexer nele deixa de ser
escolha e vira discussão — inclusive consigo mesmo, porque agora há uma frase para defender. Antes,
custa nada.

É a §7.131 pelo lado prático: o critério nasce antes da peça e por isso só pode citar a forma
imaginada — **o antídoto não é escrever depois, é decidir SUJEITO, OBSERVÁVEL e ORDEM DAS PERNAS
enquanto ainda não há frase.**

## §7.161 — Concordância por AUSÊNCIA: asserção relacional também tem caso vazio

Um critério de consistência ficou VERDE. Lido o motivo: ao vivo `""` e recarregado `""` — **as duas
leituras concordavam em não mostrar nada**, enquanto o estado real aparecia 18s depois. O critério
nasceu para pegar divergência entre dois caminhos e **foi satisfeito por ambos estarem cegos**.

**É a variante mais escorregadia da doença, e o motivo é o disfarce:** a asserção era de
**IGUALDADE**, não de ausência. Quem blindou as asserções negativas não aplica a blindagem aqui,
porque **igualdade entre dois nadas parece uma afirmação** — "eles concordam!" soa como resultado
positivo.

Forma geral: **toda asserção RELACIONAL tem um caso vazio em que é trivialmente verdadeira** —
igualdade, diferença, ordem, correspondência, "todos os X têm Y" sobre conjunto vazio. E nenhuma
delas *parece* uma asserção de ausência, que é o que faz a defesa não ser acionada.

**Regra:** asserção relacional exige que o objeto da relação seja **OBSERVÁVEL em pelo menos um dos
lados**. Sem isso, não há veredito.

### §7.161-a — A suíte precisa do veredito INCONCLUSIVO

O conserto foi introduzir um terceiro desfecho: se o estado não é observável em nenhuma leitura, o
veredito é **INCONCLUSIVO** — nem passa nem reprova.

**É a §7.153 aplicada ao próprio veredito.** Lá, um instrumento com dois desfechos media uma
realidade com três; aqui, o VEREDITO tem dois (verde/vermelho) e a realidade tem três (funcionou,
quebrou, **não deu para saber**). E como praticamente nenhuma ferramenta de teste oferece o terceiro,
o "não deu para saber" **é sistematicamente absorvido pelo verde** — por omissão do ferramental, não
por decisão de ninguém.

Onde não der para ter o terceiro desfecho nativo, **falhe** — inconclusivo é mais próximo de
vermelho que de verde, porque o custo de investigar um falso alarme é menor que o de arquivar uma
pergunta que ninguém mais vai abrir.

### §7.157-a — A ferramenta cara veste a fantasia do rigor

Acréscimo à lei da restrição, e é mais duro do que soa: poder fazer a coisa cara **não só impede de
procurar a barata — faz a cara parecer rigor.** Reverter produção para provar um teste tem cara de
zelo; ninguém questiona quem "foi até o fim". E o custo real aparece depois, no dia em que alguém
esquece produção revertida.

**Quando o método mais caro também é o mais virtuoso na aparência, a escolha deixa de ser técnica** —
e é exatamente aí que a restrição de papel decide melhor que o julgamento.

### §7.158-a — Por que é sistêmico: representar "não sei" custa uma linha a mais em TODA camada

O fecho do dia, e ele é econômico, não moral: **a linguagem, o ORM, o React e o Postgres oferecem
"assuma que está tudo bem" de graça, e cobram uma linha a mais por "não sei"** — `?? false`, o
default de coluna, o estado inicial de query, o `LEFT JOIN` que devolve null.

Não é problema de conhecimento — é de **preço**. Todo mundo aqui sabia da regra; oito superfícies
falharam mesmo assim, porque em cada uma o caminho certo custava uma linha e o errado custava zero.
**Logo o conserto durável não é atenção: é tornar o "não sei" o default NA NOSSA camada** — tipos com
três estados, helpers compartilhados, veredito inconclusivo — para que a linha a mais seja paga uma
vez, e não em cada ponto de uso.

**E o epílogo:** o épico existe porque o produto fazia isso com o CLIENTE do usuário. Passamos o dia
descobrindo que fazíamos com os nossos próprios dados, em três andares independentes. Mesmo hábito,
mesma origem, mesma cura.

## §7.162 — Instrumento cujo SUJEITO depende da história recente do sistema: viés sistemático, não ruído

O seletor casava dois elementos, e qual deles vinha primeiro dependia de **ter havido evento recente
na tela**. Frase do QA, e é a lei: *"um instrumento que muda de sujeito conforme a história recente
da tela não mede nada de forma reproduzível."*

**E o agravante é que não é aleatório.** O sujeito era escolhido por algo **correlacionado com o
fenômeno sob teste** — havia pulso justamente quando havia atividade em tempo real, que é o que se
estava medindo. Alvo escolhido sem ordem (§7.125-a) produz ruído, e repetir a medição atenua; alvo
escolhido pela própria condição produz **viés na direção que esconde o defeito**, e repetir só
confirma o erro com mais casas decimais.

**Teste rápido:** o que decide QUAL elemento/linha/registro meu instrumento pega tem alguma relação
com o que estou tentando provar? Se tem, o instrumento está do lado errado do experimento.

## §7.163 — Defeito AUTO-AGRAVANTE: mais fraco exatamente onde mais importa

A janela em que o card afirma saúde sem saber dura até 18s — e a consulta que a fecha **classifica
todos os leads**, logo **a janela cresce com o tamanho do tenant**. O alarme fica mais lento à medida
que aumenta o número de coisas para alarmar.

É uma categoria própria, e merece prioridade acima do que o número de hoje sugere: **defeito cuja
gravidade cresce junto com a condição que ele deveria detectar**. Testado em ambiente pequeno, parece
tolerável; no cliente com mais negócios morrendo, é onde ele mais falha. *"Piora na direção errada,
que é a única direção que importa."*

**Ao medir qualquer defeito, pergunte: ele piora com escala, e a escala do QUÊ?** Se for a escala do
próprio problema, o número medido hoje é o melhor caso e não vai se repetir.

## §7.164 — Relate RAÍZES, não vermelhos

Quatro vermelhos não eram quatro defeitos: dois são a mesma raiz vista por duas perguntas, um é
consequência de não haver estado visível, e um é anterior a tudo. Consertada a raiz do primeiro
grupo, três mudam juntos.

**A contagem crua de vermelhos é artefato de comunicação, e ela mente para cima** — cria a impressão
de uma fila de trabalho que não existe, e uma fila inflada muda decisão de prioridade tanto quanto um
defeito real. O relatório honesto lidera pelas **raízes**, com os vermelhos listados como sintomas
delas; a contagem vai no rodapé, onde não induz.

## §7.165 — "Árvore limpa" não significa "código inalterado" — a comparação precisa de INTERVALO, não de estado

Um critério que passava de manhã falhou três vezes à tarde, e o laudo dizia: *"a árvore do produto
está LIMPA e os dois últimos commits são de doutrina"*. **Os dois últimos, não todos desde a última
medição.** No intervalo há exatamente um commit de produto — o que criou a tabela de estado de
risco — e ele executa `alter publication supabase_realtime add table ...`.

**`git status` limpo responde "não há alteração NÃO COMMITADA agora".** A pergunta era outra: *"o que
mudou desde a medição que estou contradizendo?"* — e essa só se responde com `git log BASE..HEAD`
sobre os caminhos de produto. **Estado responde sobre o instante; regressão é afirmação sobre um
INTERVALO.**

**Regra:** todo laudo de regressão cita o RANGE (`<sha da medição anterior>..<sha atual>`) e os
commits de produto dentro dele. "Árvore limpa" entra como complemento, nunca como o argumento.

**E a explicação chata desta vez tem nome:** alterar a publicação de replicação **com conexões vivas
assinando** é candidato imediato para *"o evento saiu e a tela não aplicou"*. Antes de declarar
regressão de produto, o discriminador é trivial — **reconectar e repetir**. Se voltar a passar, o
vermelho foi transitório de migração, não defeito.

## §7.166 — Recusar-se a escolher entre hipóteses é metade da disciplina; a outra é PARTIR o espaço

Com três candidatos sobrando (filtro do canal, RLS do assinante, momento da escrita), a recusa em
eleger um está certa — *"escolher agora seria trocar uma acusação errada por outra"*. Mas parar aí
transforma rigor em paralisia.

**A saída não é escolher: é achar a medição que corta o conjunto ao meio.** Aqui ela é trivial —
**assinar o mesmo canal SEM filtro**. Chegando quadro, o problema está no filtro e as outras duas
hipóteses morrem juntas; não chegando, o filtro está inocente e sobra o par
autenticação/entrega. Um teste, três hipóteses viram uma ou duas.

**Regra:** ao ficar com N hipóteses e nenhuma evidência para eleger, não pergunte *"qual é a certa?"*
— pergunte **"que observação teria resultado DIFERENTE conforme o subconjunto?"**. Investigação boa
não é sortear melhor; é **desenhar o corte**.

**E o candidato que não estava na lista:** o único commit de produto no intervalo altera a publicação
de replicação (§7.165). Assinatura viva na hora de um `alter publication` é explicação chata e
verificável — **reconectar e repetir** custa um minuto e não foi feito. Hipótese ausente da lista não
é hipótese descartada.

## §7.167 — Medir NÍVEL quando a pergunta é DIFERENÇA

Três consertos de instrumento precederam o achado valer, e os três são o mesmo defeito com máscaras
diferentes:

1. **O coletor foi anexado tarde** — perdeu o join e a confirmação do servidor, e produziu o laudo
   "o canal não foi confirmado", que era falso.
2. **A contagem não era janelada** — "7 quadros" incluía os do próprio seed. *Quase virou o laudo
   oposto: "os quadros chegam".*
3. **A pré-condição não distinguia o novo do antigo** — procurava QUALQUER `lead_edited` no lead, e
   um critério anterior já havia criado um. *"A ação persistiu"* podia ser verdade sobre uma ação de
   dez minutos atrás.

**Uma dimensão faltando nos três: o TEMPO relativo à ação.** Medição de EFEITO é intrinsecamente uma
**diferença**, e o instrumento media **níveis**. Nível responde *"quantos existem"*; diferença
responde *"esta ação produziu um"*. São perguntas distintas e só uma delas era a do critério.

**E repare no que torna isso especialmente traiçoeiro: não há direção de viés.** O mesmo instrumento
sem fronteira temporal produziu quase-falso-positivo (7 quadros "chegando") e falso-negativo (canal
"não confirmado"). **Não dá para compensar sendo cético para um lado** — só corrigindo a medida.

**Checklist de toda medição de efeito:** a observação começou ANTES da ação? a contagem tem janela
com início e fim? o predicado de existência pode ser satisfeito por RESÍDUO de rodada anterior?
Qualquer "não" invalida o veredito nas duas direções.

## §7.168 — Explicação PLAUSÍVEL fecha um número melhor que uma medição

A razão **1 entrada : 2 saídas** foi medida de manhã e explicada na hora: *"o supabase manda um leave
ANTES do join do mesmo tópico, e outro na desmontagem"*. A explicação encaixa, é verossímil — e
**nunca foi medida**. A ORDEM dos quadros estava sendo capturada e simplesmente não guardada,
**porque a história removeu o motivo de olhar**.

É a §7.147-a com o mecanismo explícito: explicar arquiva, e **explicação plausível arquiva melhor
que medição**, porque medição convida a conferir e história não. O sinal de alerta é exatamente este:
*o dado necessário já estava ao alcance e ninguém o registrou.*

**Regra:** ao explicar um número, marque se a explicação foi **medida** ou **suposta**. Suposta é
hipótese com aparência de conclusão, e volta como candidata na próxima investigação em vez de ficar
fora dela.

## §7.169 — Mecanismo candidato: `removeChannel` de canal NUNCA assinado mata o irmão de mesmo tópico

Rastreado em `hooks/realtime/useRealtimeChannel.ts`, e casa com a razão 1:2 e com "confirmado e sem
quadros". `reactStrictMode: true` (verificado em `next.config.ts`), logo em desenvolvimento o efeito
roda **duas vezes**:

1. **Efeito 1** cria o canal A com tópico `${name}::${instanceId}` — e `instanceId` vem de `useId()`,
   **estável entre as duas execuções**. O `subscribe` está dentro de `esperarAuth(...).then(...)`,
   ainda pendente.
2. **Cleanup do efeito 1** marca `cancelado = true` e chama `supabase.removeChannel(A)` — **A nunca
   assinou**, mas `removeChannel` empurra um `phx_leave` **do tópico**, e é assíncrono.
3. **Efeito 2** cria o canal B com o **MESMO tópico**, autentica e assina. O servidor confirma.
4. **O leave fantasma de A pode chegar DEPOIS do join de B** — e derruba, no servidor, a assinatura
   que o cliente acabou de ver confirmada.

Fecha a aritmética: **1 join (B) + 2 leaves (o fantasma de A e o real da desmontagem)**.

**Conserto mínimo, e é do tipo que tira a possibilidade:** só chamar `removeChannel` se o
`subscribe` realmente aconteceu — se o cleanup rodou antes do `.then()`, não há nada para deixar.
Alternativa mais forte: tópico único por execução do efeito, para que o leave de um nunca alcance o
outro.

**O que isto NÃO explica sozinho, e por isso continua candidato e não veredito:** o mesmo critério
passou de manhã com este mesmo código. Corrida é sensível a tempo, e algo mudou o tempo — mas
**"passou antes" não absolve um mecanismo defeituoso**, apenas prova que ele é intermitente. E há uma
consequência de escopo: `reactStrictMode` só duplica em DEV, então, se for isto, o vermelho é
artefato de desenvolvimento — o que **não o torna barato**, porque inviabiliza toda medição de tempo
real do time.

## §7.170 — A mitigação criou a exposição: proteção desenhada de UM papel desloca risco para o outro

A receita contra a corrida de índice (`git add -N` + `git commit --only`) protegia **quem commita** —
garante que o commit leve só os próprios caminhos. **Não protegia quem TEM TRABALHO NO ÍNDICE.**

E o pior: para arquivo **novo**, o `git add -N` é exatamente o que o torna **capturável**. Antes
dele, o arquivo era untracked e **invisível** para o `git commit` de outra sessão. **A mitigação
criou a exposição que a vítima não tinha** — e a vítima foi quem escreveu a receita.

**Forma geral:** proteção desenhada da perspectiva de um papel tende a **deslocar** risco para outro
papel em vez de removê-lo, e o autor não vê porque está no papel protegido. **Ao propor uma
proteção, escreva quem fica protegido E quem passa a ficar exposto.** Se a segunda lista estiver
vazia, provavelmente não foi procurada.

**Receita corrigida (vale para os dois lados):** `git add -N` e `git commit --only` na **MESMA
invocação**, sem nada entre eles — nem gate, nem teste, nem leitura. Enquanto houver segundos entre
um e outro, existe janela. Para arquivo já rastreado, `git commit CAMINHO` continua bastando.

**E o conserto de verdade é estrutural:** a corrida existe porque duas sessões compartilham UM
índice. Worktrees separados a eliminam (§7.99: tirar a possibilidade). Não se faz agora por haver
trabalho vivo dos dois lados — **gatilho declarado: ao fechar a wave 7**, antes de qualquer frente
nova.

## §7.171 — Congelamento protege o DELIBERADO; artefato capturado por corrida não herda autoridade

Um teste entrou no HEAD **sem a migration que ele testa** — capturado do índice por um commit
alheio. Duas consequências, e a segunda é a perversa:

1. O `test:db` do HEAD reprovava **por construção**: o teste exige o filtro que a migration cria.
2. E, uma vez dentro de `tests/invariants/**`, a versão **intermediária** passou a ser protegida pelo
   hook — o autor precisa de autorização para substituir pela versão que ele **já havia escrito**.

**O congelamento existe para impedir que um invariante DECIDIDO seja apagado ou afrouxado.** Este
nunca foi decidido: foi **capturado**. Tratar artefato de corrida como invariante inverte o propósito
da regra — protege exatamente o que ninguém escolheu proteger.

**Regra:** quando o pedido de exceção for para **restaurar a versão pretendida** de algo que entrou
por acidente de índice, o critério não é `+N −0` — é **provar que a substituição FORTALECE** (aqui:
cada caso em transação revertida, em vez de org compartilhada com limpeza no fim) **e que a nova
versão morde** (falha quando o filtro do trigger é removido). Autorização concedida sob essas duas
provas, citadas no corpo do commit.

## §7.172 — Decisão que vira no TERCEIRO DECIMAL não é decisão, é sorteio

O invariante afirmava que o planner escolhe um índice específico. Com estatística fresca, ele ainda
escolhia Bitmap Heap Scan por outro índice: **custo 7.06 contra 7.07**. A tabela é pequena demais
para o índice parcial compensar — **a escolha virava no terceiro decimal**.

Um invariante que afirma sobre uma decisão decidida por 0.01 **não mede propriedade do schema, mede
ruído** — e passou tempo verde por sorte, o que é pior do que ter falhado desde o início.

**E a consequência tem de ir para a documentação do teste, não só para o código.** Com
`enable_bitmapscan = off` somado ao `seqscan`, o que o teste prova mudou: não é mais *"o planner
escolhe este índice"* — é *"forçado a usar índice, ele escolhe ESTE"*. Continua sendo garantia real
(a sabotagem confirma que discrimina), mas é **mais estreita**, e quem ler daqui a três meses vai
acreditar na frase antiga se ela não for reescrita.

**Regra para toda a classe:** invariante de escolha de plano em tabela pequena é frágil por
construção. O que normalmente se quer garantir é que **o índice existe e é utilizável** — e isso se
mede sem depender do planner desempatar.

## §7.173 — Sabotagem que reprova TUDO prova pouco; a que reprova o SUBCONJUNTO CERTO prova discriminação

Removido o filtro do trigger, ficaram vermelhos **exatamente os 5 casos "não anda" mais o teste de
ciclo**, e os 5 casos **"anda" seguiram verdes**.

**É a assimetria que prova.** Sabotagem que derruba a suíte inteira demonstra apenas que algo
quebrou — compatível com "o instrumento discrimina" e com "o instrumento explodiu". A que derruba
**só o subconjunto que deveria cair** demonstra que ele **separa**, que é a única propriedade que
importa numa guarda.

**Ao sabotar, preveja quais casos devem cair — e confira os que NÃO caíram.** O verde que sobrevive
à sabotagem é metade da prova, e é a metade que quase ninguém olha.

## §7.174 — Histórico torna a inferência confortável, e conforto suprime a verificação

A autoria do commit que capturou o arquivo foi **inferida**, não conferida: *"ele já tinha feito
duas vezes, então a terceira devia ser dele."* Era um terceiro, que nem sabia que aquele trabalho
existia.

**A inferência razoável sobre autoria é a forma mais educada de acusação sem prova** — e o mecanismo
é perverso: o histórico **aumenta a confiança** e por isso **reduz a checagem**, exatamente ao
contrário do que deveria. Quanto mais plausível o suspeito, mais barato conferir parece
desnecessário.

**Regra:** atribuição de autoria é fato verificável em um comando. Onde houver um comando, não há
lugar para inferência — e a existência de histórico é motivo para conferir, não para dispensar.

## §7.175 — Controle ERRADO não erra para o lado seguro: ele ABSOLVE

A perna que "inocentou a publicação, o filtro e a autorização" assinava um lead do pipeline
**Pedidos**, enquanto o navegador olhava o pipeline **CRM Vivo**. Duas variáveis, uma conclusão — o
teste confundido, cometido justamente na peça que servia de **controle**.

**E a assimetria importa:** um caso de teste confundido devolve um resultado duvidoso; um CONTROLE
confundido devolve **absolvições**. Ele não gera dúvida — gera certeza falsa, e certeza falsa fecha
linhas de investigação inteiras. Três camadas foram declaradas inocentes sem nunca terem sido
testadas na condição que importa.

**Regra:** o controle recebe o MESMO rigor do caso — mesmo sujeito, mesma condição, uma variável. Na
prática, mais rigor: **o caso, quando erra, atrasa; o controle, quando erra, encerra.**

## §7.175-a — Ao retratar um confundido, verifique se o substituto não repetiu o erro uma camada acima

Medido no banco, e é o que pode repetir a armadilha: há **cinco organizações** e **cinco pipelines
"Pedidos"**, um por org. O "CRM Vivo — Clínica" é único, na org `6e567068` — que **também tem um
Pedidos, com 38 leads**.

Logo, se o lead de Pedidos da nova medição não for da org `6e567068`, **pipeline e organização
variaram juntos outra vez**, e a conclusão "a diferença é o pipeline" tem exatamente o defeito que
acabou de ser retratado, um nível acima.

**A comparação limpa existe e está disponível:** dois leads da MESMA org `6e567068`, um em cada
pipeline. Se o de Pedidos entrega e o de CRM Vivo não, a organização morre como hipótese e o
pipeline fica confirmado.

**A lei geral:** retratação cria urgência, e **urgência é exatamente quando se recomete o mesmo erro
uma camada acima**. Ao substituir um teste confundido, a primeira pergunta sobre o substituto é a
mesma que derrubou o original — *o que mais mudou junto?*

### O que ESTÁ eliminado por medição estrutural (feita aqui, não suposta)

- **Todas as 8 tabelas da publicação têm PK e replica identity `default`** — nenhuma tabela
  publicada sem identidade utilizável, que é o quebrador clássico do decodificador.
- **Tamanho de linha não explica:** Pedidos média 287B / máx 336B; CRM Vivo média 330B / máx 448B —
  mesma ordem de grandeza, muito abaixo de qualquer limite de payload.
- **Os cinco triggers de `crm_leads` são de TABELA, sem cláusula por pipeline** — nenhum caminho de
  gatilho pode ser específico de um pipeline.

Isso não nomeia o mecanismo. Estreita onde ele **não** está — e a distinção entre "sei onde não
está" e "sei o que é" continua sendo a diferença entre laudo e palpite.

## §7.176 — Controle FABRICADO vence controle encontrado

Diante de um par que nunca ficava limpo (pipeline sempre acompanhado de org, idade, dono ou
estágio), a saída foi **criar um terceiro pipeline na mesma org só para a medição** — e a grade
resultante mata cinco hipóteses de uma vez:

| caso | entrega |
|---|---|
| lead existente · Pedidos · sem dono | 3/3 |
| lead novo · **pipeline fabricado** · sem dono | 3/3 |
| lead novo · **pipeline fabricado** · com dono | 3/3 |
| lead novo · CRM Vivo · sem dono | **0/3** |
| leads existentes · CRM Vivo · com dono | **0/3** |

**Controle encontrado herda toda a história do dado** — quem o criou, quando, com que campos, sob
qual configuração. Controle **fabricado** difere na dimensão que você escolheu e em nenhuma outra,
porque você o construiu assim. Quando o par limpo não existe no acervo, **a resposta não é aceitar o
par sujo com ressalva: é fabricar o par**.

E o co-variante que apareceu no caminho prova a necessidade: os leads de um pipeline tinham
`owner_user_id` e os do outro não — e a policy de leitura é `fn_can_view_lead(organization_id,
owner_user_id)`. *"Ter dono"* muda visibilidade e vinha andando junto com o pipeline em todas as
medições anteriores. **Um confundidor havia sido trocado por outro sem que ninguém notasse.**

## §7.176-a — "Constante por construção" não é "medido"

A organização já era a mesma nos seis leads — e foi **verificada mesmo assim**, em vez de afirmada de
memória. A distinção é exatamente o erro que estava sendo retratado: *"já estava constante por
construção"* descreve a INTENÇÃO de quem montou o caso; medir descreve o caso.

**Onde a verificação custa um comando, a construção não é argumento.** E aqui pagou duas vezes: a
verificação confirmou a org E revelou o co-variante do dono, que ninguém procurava.

## §7.177 — Regência que prescreve o VALOR em vez do SIGNIFICADO trava a solução melhor

A decisão sobre o acervo dizia `since = last_activity_at`. A intenção era impedir a MENTIRA de
gravar `now()` — um negócio que esfriou há dias não esfriou agora. **Mas o que foi escrito não foi a
intenção: foi uma fórmula.**

E a fórmula está errada para a coluna: `last_activity_at` responde *"há quanto tempo em SILÊNCIO"*,
e a coluna promete *"há quanto tempo NESTE ESTADO"*. Um negócio com janela de 72h e 100h de silêncio
está em risco **há 28h**, não há 100h — e é a primeira resposta que alguém quer ao triar. O valor
certo é o **instante do cruzamento do limiar**; o silêncio não se perde (segue em `last_activity_at`)
e o contrário não valeria: de `last_activity_at` sozinho não se reconstrói quando a janela mudou.

**Regra para quem decide:** enuncie o INVARIANTE (*"`since` responde há quanto tempo neste estado, e
nunca pode ser `now()` no seed"*) e deixe o valor para quem implementa. Prescrever o valor congela o
entendimento de quem decidiu — que é justamente quem não está com o código aberto. **Quando a
fórmula prescrita e a intenção divergirem, vale a intenção — e quem notar deve dizer, não obedecer.**

## §7.178 — Idempotência PARCIAL lê-se como total

O seed era idempotente nos **estados** (upsert por lead) e **não** no item de caixa: rodar duas vezes
criava dois agregados. E o item que se duplica ao ser reprocessado é **exatamente a praga que ele
existe para evitar** — a caixa vira lista de avisos repetidos e o operador para de abrir.

**O perigo é o disfarce:** a parte idempotente é a principal e a mais visível, então reprocessar
"parece" limpo. Ninguém conclui "metade duplicou" — conclui "não duplicou".

**Regra:** idempotência se prova **executando de novo**, e a prova cobre **cada escrita**, não a
principal. Aqui: três execuções seguidas, mesmo id nas três. E a regra fina que veio junto — item já
resolvido **não** bloqueia um novo, senão acervo novo nasce sem convite.

## §7.179 — O invariante virou a TERCEIRA lista

O invariante `vocabulario-banco-x-typescript` existe para impedir que a lista do banco e a do
TypeScript divirjam. **Ele não lê o TypeScript.** A lista "do TS" dentro dele é transcrita à mão —
então ele compara o banco com **uma cópia manual de si mesmo**, e é ele próprio a terceira lista que
pode divergir das outras duas.

Provado por sabotagem: removido um valor do union type **de verdade**, o invariante passou **VERDE**.
Quem pegou a divergência foi o `tsc`, e só porque existe um `Record<InboxKind, string>` em outro
arquivo — **acidente feliz, não desenho**.

**É a doença que ele guarda, uma camada acima** — e é pior que não ter invariante, porque um
invariante presumido consome a atenção que iria para uma checagem de verdade.

**Conserto autorizado: extrair a lista do ARQUIVO em vez de transcrevê-la.** Com duas condições, e a
segunda não é opcional:

1. **Refazer a MESMA sabotagem depois do conserto e exigir VERMELHO.** Sem isso, troca-se um
   invariante presumido por outro.
2. **Extração vazia tem de ESTOURAR.** Se o regex deixar de casar (o type é reformatado, ganha
   comentário, muda de arquivo), a lista extraída vira `[]` e a comparação passa **por vacuidade** —
   §7.161 exatamente, dentro do conserto dela. Zero valores extraídos é erro do instrumento, nunca
   um conjunto vazio legítimo.

## §7.180 — Refutar uma hipótese com um teste que nunca a EXECUTOU

Ao testar *"assinatura órfã envenena o ciclo"*, a fase que abria o board carregava uma checagem de
que a assinatura **existia** — tráfego de realtime na página e board renderizado. Sem ela,
*"com board aberto é igual a sem board"* não distinguiria **"assinar não quebra"** de **"eu não
assinei"**.

É a §7.161 (concordância por ausência) na sua forma mais cara: **a hipótese seria declarada refutada
por um experimento que nunca a estabeleceu**. E refutação é pior que afirmação errada — ela fecha a
linha de investigação e ninguém volta.

**Regra:** todo teste que REFUTA precisa de um controle POSITIVO interno — prova de que a condição
hipotetizada foi de fato criada. Sem isso, o resultado nulo é indistinguível de experimento não
realizado.

## §7.181 — Um experimento refuta o mecanismo que ele CONSEGUIU PRODUZIR, não a classe inteira

As órfãs foram fabricadas pelo caminho do **próprio app** — abrir e matar abas. Isso refuta
*"órfã criada por abertura/fechamento do board"*, e **não** refuta *"assinatura registrada por outro
cliente, com filtro malformado ou claim vencido"*, que continua possível e simplesmente **não é
produzível por esse caminho**.

**Ao refutar, declare o mecanismo de PRODUÇÃO junto com o resultado.** "Não consegui produzir o
efeito" e "o efeito não existe" são frases diferentes, e a segunda quase nunca é o que foi medido.

E a fase que só existiu por causa da escala merece registro: A/B/C usavam **uma** assinatura,
enquanto o board acumula uma por abertura o dia inteiro. **"Não quebra com uma" não é "não quebra
com vinte"** — a quarta fase (oito órfãs de uma vez) foi acrescentada para não confundir ausência de
efeito com efeito que precisa de volume.

### §7.176-b — Não ter par limpo é problema de FABRICAÇÃO, não de amostragem

O fecho do raciocínio, e ele reorganiza o dia: escolher alvo com cuidado dentro do acervo resolve o
alvo sorteado; **fabricar o par resolve o problema um nível acima** — em vez de procurar melhor
dentro do que existe, construir o que precisa existir.

Quando o acervo não contém o contraste necessário, a conclusão não é *"a medição fica com
ressalva"*. É que **a medição ainda não tem sujeito, e o sujeito se constrói**.

## §7.182 — O TEXTO do vermelho envelhece, e relatório que sobrevive à investigação vira folclore

O vermelho ainda dizia *"o defeito é a montante da tela"* e *"o silêncio é do socket"* — frases
escritas enquanto se procurava no navegador. **O socket está vivo, responde e confirma a
assinatura.** As frases sobreviveram à investigação que as corrigiu.

**Quem ler amanhã acredita no TEXTO, não no commit.** Achado é documentação, e documentação escrita
no meio da caçada carrega a hipótese daquele momento como se fosse conclusão.

**E há uma segunda coisa que o texto tem de separar: vermelho NÃO acusa componente.** O critério
segue vermelho — para quem usa o board, a timeline não anda sozinha, e essa é a promessa quebrada.
Mas **a tela do dossiê está inocente**: não há quadro para ela aplicar. Sem essa frase escrita, o
próximo leitor "conserta" a superfície certa pelo motivo errado.

**Regra:** ao fechar uma investigação, reescreva o texto de todo vermelho que ela tocou. O laudo
declara (i) a promessa quebrada, (ii) a raiz, e (iii) quem está inocente — os três, porque os três
são lidos como acusação quando faltam.

## §7.183 — Controle tem ciclo de vida; o custo acompanha a PERGUNTA

O controle em processo irmão foi de **N=3 para N=1**: ele não investiga mais nada, só responde
*"havia como chegar?"*. **Três rodadas eram o preço de uma pergunta já respondida.**

Suítes só sabem crescer — um controle nasce caro porque a pergunta era difícil, e continua caro
depois de a pergunta ficar trivial, porque baixar custo parece afrouxar. **Não é: é ajustar o preço
à pergunta que sobrou.** Quando a função de um instrumento encolhe, o custo dele encolhe junto — e
quem não faz isso paga a conta da investigação antiga em toda rodada futura.

## §7.184 — Prática adotada por razão PRÁTICA é frágil; a lei a protege da própria justificativa

O controle positivo dentro do teste de refutação (§7.180) **não foi posto por prever o buraco
metodológico**: foi posto porque era preciso saber se o board tinha carregado antes de medir. A
razão metodológica só apareceu depois, ao escrever o comentário.

**Isso não diminui o acerto — muda a fragilidade dele.** Uma prática sustentada por conveniência
operacional morre quando a conveniência muda: no dia em que o aparato ganhar uma espera global por
"página pronta", aquela checagem vira redundante *por aquele motivo* e é removida — **levando junto
a garantia que ninguém tinha escrito**.

**É o argumento para nomear a lei mesmo quando o comportamento já acontece.** A lei não ensina a
fazer o que já se faz; ela **protege a prática de perder a razão pela qual ela é indispensável**. E
distinguir "eu previ" de "eu tropecei e depois entendi" é o que permite saber quais das nossas
práticas ainda estão apoiadas em conveniência.

## §7.185 — Default de coluna só age no INSERT — e o "conserto" trocou uma janela por uma condição permanente

O worker abortava por violar o CHECK de `since_no_passado`. Causa: **dois relógios na mesma
decisão** — `since` deriva de `last_activity_at`, carimbado com o `now()` do BANCO; `detected_at`
vinha do processo Node. Medido: **o banco está 2 segundos à frente**.

**E a primeira tentativa de conserto era pior que o defeito.** Omitir a coluna no upsert para "deixar
o default resolver" só funciona no INSERT. **No UPDATE — que é o caminho de TODA travessia depois da
primeira — a coluna mantém o valor ANTIGO**, e o `since` novo passa a ser maior que um `detected_at`
de dias atrás. Trocou-se uma falha na janela de dois segundos por uma que **acontece sempre**.

Duas coisas ficam:

1. **`default` é regra de INSERT.** Qualquer conserto que dependa dele é no-op no caminho de
   atualização — e o caminho de atualização costuma ser o comum depois da primeira vez.
2. **Só a RE-EXECUÇÃO pegou.** O raciocínio aprovava o conserto; rodar de novo reprovou. Conserto que
   piora a frequência do defeito é indistinguível de conserto bom até alguém repetir o teste.

E o veredito sobre a trava: **a constraint estava CERTA** e pegou o que ninguém teria visto. O
conserto não é afrouxá-la — é **tirar do cliente a chance de errar** (o trigger carimba `detected_at`
no banco).

## §7.186 — A precisão exigida é propriedade da COMPARAÇÃO, não do dado

O relógio do processo continua **classificando**, e está certo: `classifyRisk` compara janelas de
HORAS, onde 2 segundos não mudam bucket. O CHECK compara **INSTANTES**, onde mudam. **Grandezas
diferentes toleram precisões diferentes** — e confundi-las foi o defeito.

O que NÃO foi feito merece o mesmo destaque que o conserto: não se "aumentou a precisão de tudo por
segurança". Essa é a supercorreção preguiçosa — ela apaga a informação de **qual** comparação exigia
precisão, e o próximo leitor não sabe mais o que pode relaxar.

**Regra:** ao encontrar imprecisão, pergunte qual COMPARAÇÃO quebrou, e conserte no escopo dela. O
mesmo timestamp pode ser bom para um consumidor e insuficiente para outro, e isso é normal.

## §7.187 — Invariante TRANSVERSAL não pertence a nenhum subconjunto temático

O invariante de "evidência citada" estava vermelho **desde a wave 6** e ninguém viu — porque, sendo
a mudança de banco, rodou-se `test:db` e não os unitários. **O raciocínio estava certo e a cobertura
errada.**

Invariantes de documentação, evidência e vocabulário **não pertencem a nenhum tema**: nenhuma
mudança os afeta "obviamente", então toda heurística de *"rode a suíte relevante"* os perde
**permanentemente** — não às vezes, sempre. É o oposto do teste de unidade, que a heurística acerta.

**Regra:** a suíte tem duas classes, e só uma admite recorte por tema. Os transversais rodam sempre,
ou não rodam nunca.

### §7.185-a — `−0` não é a meta; declarar o que sai é

Um pedido de exceção anterior ajustou a forma para conseguir `+23 −0`, e estava certo: o `−1` era
reformatação, incidental. Este trouxe **`−28` substantivo** (as listas transcritas saindo) e o
declarou em vez de escondê-lo atrás de forma aditiva — **também certo**.

A regra não é "sempre alcançar `−0`". É: **remoção incidental se evita; remoção substantiva se
declara.** Disfarçar a segunda de primeira é o que a exigência de `−0` existe para impedir, e quem
persegue o número em vez do sentido acaba fazendo exatamente isso.

## §7.188 — A recuperação foi escrita só para a falha que GRITA

`authenticateRealtime` memoiza a promessa de autenticação do socket. Três saídas, e só uma limpa a
memo:

```
catch { realtimeAuth = null; }   // exceção → memo LIMPA, próxima tentativa refaz
if (!res.ok) return;             // 401/500 → memo FICA, setAuth NUNCA chamado
if (token) setAuth(token);       // corpo sem token → memo FICA, idem
```

**Um único 401 transitório** — sessão ainda estabelecendo, cookie em renovação — **deixa TODOS os
canais criados depois anônimos, para o resto daquele carregamento de página.** E anônimo com RLS por
`auth.uid()` devolve zero linhas: o canal responde `SUBSCRIBED` e nunca entrega nada.

**O padrão é o eixo do dia na sua forma mais pura:** a falha que lança exceção **se cura sozinha**; as
que retornam quietas **persistem para sempre**. A recuperação foi escrita para o caminho barulhento,
que é justamente o que menos precisava dela. E o comentário do arquivo confirma a intenção —
*"sem token o canal segue anônimo, a UI continua funcionando por refetch"* — uma degradação
deliberada que se tornou permanente por causa da memo.

**Regra:** ao memoizar, o critério não é *"deu erro?"* — é ***"o resultado memoizado é o resultado
DESEJADO?"***. Sucesso parcial memoizado é pior que erro memoizado, porque erro alguém repete.

**Medido:** a assinatura de `crm_leads` com filtro no pipeline nasceu **anon, `claims.sub = NULL`**,
às 15:06; duas de `conversations`, no MESMO socket e navegador, nasceram **authenticated** às 16:46.
Carregamentos diferentes, resultados diferentes — exatamente o que a memo por página prevê.

## §7.189 — Experimento VÁLIDO pode ser irrelevante para a hipótese vizinha

Matar oito abas de uma vez provou que **acúmulo de assinaturas órfãs não quebra** — e não podia
provar nada sobre **com que PAPEL a próxima assinatura nasce**. Remover assinaturas não muda a
autenticação da seguinte.

O experimento estava certo, foi bem construído, e respondeu **a pergunta vizinha**. É a §7.181 pelo
outro lado: lá, um resultado nulo não refuta a classe; aqui, **um resultado nulo bem medido não
refuta a hipótese ao lado, mesmo parecendo cobri-la** — "assinatura órfã" e "assinatura anônima"
soam como a mesma família e são mecanismos distintos.

**Ao arquivar uma hipótese, escreva qual pergunta o experimento respondeu — não qual hipótese ele
matou.** As duas frases divergem exatamente onde mora o próximo defeito.

### O que ainda NÃO está explicado (e por que não se declara vitória)

A assinatura anônima explica **completamente** o board mudo. Ela **não** explica, ainda, a morte da
janela para um assinante independente com service role: `fn_user_org_ids()` usa `auth.uid()`, que
para claims nulos devolve **NULL sem erro** — filtra tudo, não aborta lote.

**São dois fatos, e um pode não explicar o outro.** O teste que decide é uma linha: **apagar aquela
assinatura anônima e repetir a grade**. Se as linhas do CRM Vivo passarem a chegar ao assinante
independente, a raiz é única e tudo fecha; se não passarem, restam dois defeitos e consertar um
deixaria o outro vivo com aparência de resolvido.

## §7.190 — Varredura por NOME DE TABELA falha justamente nos escritores CANÔNICOS

A sabotagem pôs `performed_at: new Date()` num escritor de produção e o invariante **passou verde**.
Motivo: a varredura procurava o nome da tabela, e o worker nunca o escreve — ele chama
`emitLeadActivity`.

**A cobertura do instrumento é INVERSAMENTE correlacionada com a qualidade do código.** Grep por
nome de tabela acha os escritores ad-hoc (a minoria, nos lugares mal feitos) e **perde exatamente os
que passam pelo helper canônico** — que é a maioria, e é o que se quer que exista. Quanto melhor a
abstração, mais cego o instrumento.

**Regra:** varredura que procura o RECURSO precisa procurar também os PORTÕES por onde se chega a
ele. A lista de portões é conhecida — é a mesma que a doutrina manda usar.

## §7.191 — A guarda pode falhar ANTES de si mesma, e o sintoma é erro de ferramenta

Ao esvaziar a varredura para testar o caminho vazio, o teste **não passou por vacuidade: ele NÃO
RODOU.** `grep` sai com 1 quando não acha nada, `execFileSync` lança, e o arquivo morria com
*"Command failed"* **antes** da guarda de lista vazia.

É uma terceira categoria, ao lado do falso verde e do falso vermelho: **a guarda que nunca executa**.
E o disfarce é o pior de todos — o sintoma é **erro de ferramenta**, que é a classe de vermelho que
mais gente ignora, re-roda ou atribui a ambiente.

**Regra:** ao escrever a guarda do caso vazio, verifique que o caminho vazio **chega até ela**.
Ferramenta de linha de comando que sinaliza "nada encontrado" com código de saída ≠ 0 mata o
processo antes de qualquer verificação.

### §7.191-a — Falso positivo não custa tempo: DESLIGA a guarda inteira

A primeira mira acusava qualquer `performed_at:` e pegava três **leituras**. O diagnóstico é
preciso: **invariante com falso positivo é pior que invariante nenhum de um jeito específico — ele é
DESLIGADO, e leva junto a verificação que funcionava.**

Ninguém remove metade de um guard: remove-se o guard. Por isso a limitação declarada
(`performed_at: umaVariável` escapa, porque sem AST não se sabe a origem) é a decisão certa —
**ampliar a mira traria os falsos positivos de volta e custaria o instrumento inteiro.**

## §7.192 — Teste que falha por condição "irreal": a pergunta é se o código DEPENDE dela em silêncio

O agrupamento inicial funcionava por **vizinhança**: correto enquanto a lista chega ordenada — e ela
chega, a rota ordena. O teste falhou por gerar dados desordenados, e **a tentação era ajustar o
teste**, porque "em produção sempre vem ordenado" é verdade.

**Mas a dependência era INVISÍVEL:** quem reordenasse em memória faria o agrupamento voltar a 26
blocos **sem erro nenhum** — apenas deixando de funcionar. Acoplamento silencioso sobrevive
exatamente assim: pela frase verdadeira que dispensa investigar.

**Regra:** quando um teste falha por condição que "não acontece em produção", a pergunta não é se a
condição é realista — é **se o código depende dela sem dizer**. Se depende, o teste achou fragilidade
real, e ajustar o teste esconde o achado. O sinal decisivo: **a violação não produz erro, só
resultado errado**.

Aqui a saída foi tirar a dependência (agrupar por chave, preservando a ordem de aparição) —
resultado idêntico na lista ordenada, sem a armadilha.

## §7.193 — Preparação que falha CALADA produz a evidência da hipótese ERRADA

O `delete` da assinatura anônima **falhou** — `claims_role` é `regrole`, não `text`, e `'anon'`
levantou erro de oid. O DEPOIS foi medido por hábito, e a linha ainda estava lá.

**Se o comando tivesse sido creditado sem conferir, a medição seguinte rodaria com o veneno no
lugar** — e o resultado ("não chegou") é exatamente a evidência da hipótese concorrente: *"são dois
defeitos independentes"*. A falha da preparação não produz ruído: **produz o laudo errado, coerente e
convincente**.

É o motivo profundo da §7.98 (encadear preparação com medição), dito com precisão: não se confere a
preparação por zelo, e sim porque **o modo de falha dela mapeia exatamente sobre uma conclusão
rival**. *"Medir o depois não é cerimônia."*

**Regra:** toda etapa de preparação que altera estado tem verificação do EFEITO, não do comando. E
quando a preparação falha calada, o experimento não fica sem resultado — fica com o resultado do
outro lado.

## §7.194 — A fronteira que você respeita tem de ser a que o OUTRO observa

Houve promessa de não mexer enquanto uma medição corria, e o conserto foi aplicado **no disco**, sem
commit. **"Não commitei" não protege nada** quando o dev server lê o disco e faz hot reload: o alvo
da medição mudou por baixo dela.

**A frase é a lei: *"não commitei" é uma afirmação sobre o REPOSITÓRIO, e o que o colega observa é o
PROCESSO.*** Existem várias fronteiras — disco, índice, HEAD, banco, servidor em execução — e a
promessa vale na que o outro está medindo, não na que é conveniente para quem promete.

**Regra:** toda promessa de "não vou mexer" declara **EM QUE SUPERFÍCIE**. Sem isso, quem promete
escolhe a fronteira depois do fato, sempre a seu favor — e sem má-fé, porque a fronteira do próprio
trabalho é a que vem à cabeça.

**E isto estende a decisão já tomada:** worktrees separados (marcados para o fim da wave 7) resolvem
o índice **e não resolvem** o dev server nem o banco compartilhado. O isolamento completo precisa das
três — árvore, porta e dados. Enquanto não houver, medição concorrente exige **janela declarada**:
quem mede anuncia início e fim, e quem escreve espera.

**Corolário sobre o resultado em curso:** medição que se sobrepôs à mudança de disco **não é
inválida por suposição nem válida por otimismo** — é indeterminada até alguém comparar os horários.
A pergunta certa não é "deu certo?", é "a sua janela cruzou a escrita?".

## §7.195 — Defeito que vive em ESTADO ACUMULADO morre com a higiene do experimento

A segunda sonda injetava o 401 **e dava reload** — e deu `authenticated` **nos dois lados**. O reload
reinicializa o módulo e **zera a memo**: o experimento destruía exatamente o estado de que o defeito
depende.

**O instinto de "começar limpo" é o correto para quase tudo e é fatal aqui.** Quando o defeito vive
em estado acumulado — memo de módulo, cache de processo, sessão, conexão, tabela de assinaturas —
qualquer higiene que zere o estado **apaga o defeito antes da medição**, e o resultado limpo é lido
como ausência de defeito.

**Regra:** antes de higienizar entre rodadas, pergunte **onde o defeito mora**. Se mora em estado que
sobrevive à ação e não ao reset, o reset é parte do problema, não do método. O roteiro que funcionou
foi o único que preservava o substrato: 401, **sem reload**, e um SEGUNDO canal no mesmo
carregamento.

## §7.196 — Medir OS DOIS LADOS é o que torna visível que o experimento não discrimina

A primeira sonda mediu sem injetar falha e deu `authenticated`. Parecia prova — mas **a versão antiga
produziria o mesmo**: sem falha não há memo envenenada. A observação era compatível com *"consertei"*
e com *"não havia defeito agora"*.

E a frase que fecha: ***"um par que dá o mesmo resultado dos dois lados não é prova de nada — e a
primeira vez eu tinha só um lado, que é como o empate passa despercebido."***

**Com um lado só, o empate é invisível.** Sempre sai um número plausível, e nada sinaliza que ele não
distingue nada. Medir com e sem o conserto não é rigor extra nem cinto de segurança: **é o único
mecanismo que revela um experimento que não discrimina** — o resto é confiar no próprio desenho, que
é o que falha primeiro.

**Regra:** todo conserto é reportado como PAR (com/sem), lado a lado. Par empatado é o veredito
"não medi nada", e é um veredito legítimo — o perigoso é o lado único, que nunca empata porque nunca
compara.

## §7.194-a — A promessa declara a superfície E O PRAZO; prazo definido por ação de terceiro é prazo indefinido

Complemento achado em campo, e ele fecha o buraco da lei anterior: *"não commito antes do seu
resultado"* tem uma segunda coordenada além da superfície — **até quando**.

E `"até o seu resultado"` **não é prazo**: é uma condição que depende de outra pessoa agir. Quando
essa pessoa fica idle, o prazo vira indefinido — e **quem resolve a ambiguidade é sempre quem
continua trabalhando**, a seu favor, sem má-fé, porque a alternativa é ficar parado sem saber por
quanto tempo.

**Regra:** promessa cujo prazo depende de ação de terceiro nasce com **fallback declarado** — *"se
não houver resposta em X, eu pergunto"*. Sem o fallback, a promessa não é quebrada por decisão: ela
**expira sozinha e o promitente nem percebe que decidiu**.

É a mesma família da regra do Arquiteto para a proposta de reativação: **demanda com prazo aberto não
morre por decisão, morre por silêncio** — e aqui a demanda era a própria promessa.

### §7.194-b — "Medição indeterminada" e "medição inexistente" não são a mesma coisa

Pedi descarte de uma medição possivelmente contaminada. Não havia o que descartar: **a medição nunca
foi feita** — a janela não cruzou a escrita *por sorte, não por cuidado*.

Minha instrução assumia um fato que não existia. **Antes de mandar descartar, confirme que há
resultado** — instrução construída sobre premissa não verificada gasta a rodada de quem obedece e
esconde o estado real: aqui, que o passo 1 da sequência nunca tinha começado.

## §7.197 — Métrica de um sujeito não absorve informação sobre OUTRO sujeito

Decisão 1 da reativação: proposta vencida **não piora o bucket de risco**. O argumento que vence é o
do escopo do sujeito — **o bucket mede o SILÊNCIO DO CLIENTE**, e ninguém falou com ele. Inação
interna é fato sobre o TIME, não sobre o negócio, e somar as duas corrompe a medida para as duas
perguntas: deixa de responder *"o cliente sumiu?"* e continua não respondendo *"nós largamos?"*.

**A informação não se perde** — a transição `pending → expired` emite atividade, e a timeline retém
o histórico. E proposta vencendo repetidamente no mesmo negócio **é sinal de verdade**, só que sobre
outra coisa: pertence a métrica de time, não à faixa do lead. **Escrever isso no ponto onde alguém
consideraria o contrário** é o que impede o "conserto" futuro que piora a medida.

**Regra geral:** antes de fazer um indicador reagir a um evento novo, pergunte **de quem é o evento**.
Indicador que mistura sujeitos vira aquele que não decide nada — e a degradação é invisível, porque
ele continua produzindo números.

## §7.198 — O que a IA acrescenta nunca pode ser PRÉ-REQUISITO do que ela acrescenta a

Decisão 2: **o worker propõe com rascunho vazio; o agente preenche depois.** Aprovado, e a razão é
estrutural, não de robustez: **se a proposta só nascer com o LLM, uma indisponibilidade vira
silêncio — e silêncio é a doença que a wave existe para curar.** Num produto com IA nativa, cada
dependência do modelo é um lugar onde a falha dele reproduz exatamente o defeito que o produto
combate.

Duas condições, e as duas vêm do resto da doutrina:

1. **"Sem rascunho" é ESTADO VISÍVEL, não string vazia.** Rascunho ausente que parece rascunho é o
   desconhecido renderizado como normal (§7.151) — o card e a caixa dizem *"rascunho a caminho"* ou
   equivalente, nunca um espaço em branco que se lê como "o agente não achou o que dizer".
2. **A proposta é ACIONÁVEL sem o rascunho.** Aceitar sem texto significa que o humano escreve a
   mensagem. Sem isso, preencher o rascunho vira uma segunda demanda que pode morrer — e teríamos
   criado, um nível abaixo, exatamente a recursão que o Arquiteto barrou: a cura que precisa de outra
   cura. **O realce da IA é melhoria; nunca porta de entrada.**

### Sobre o PRAZO derivado da janela do estágio — aprovado, com uma nota escrita

`prazo = coldHours` é a decisão certa: uma fonte, dois consumidores, tuning por estágio herdado de
graça, e explicável na tela (*"você tem o mesmo tempo que o negócio levou para esfriar"*). Constante
fixa daria a uma clínica e a um contrato o mesmo prazo — o defeito que `resolveStageWindow` existe
para não ter.

**Medido, para a decisão não ser cega:** as janelas reais são 24h, 48h, 72h e 96h, com fallback de
24h. **O piso é um dia inteiro**, então o caminho do card não é decorativo — havia o risco de janelas
curtas fazerem toda proposta virar item de caixa antes de alguém ver.

**Nota a escrever no código:** o prazo é em horas de relógio, e a disponibilidade humana não é.
Proposta nascida na sexta à noite vence no sábado. **Isso é aceitável e não é perda** — ela vira item
de caixa, que é o mecanismo anti-morte — mas tem de estar escrito, senão alguém "descobre" isso daqui
a seis meses como bug e conserta com um subsistema de horário comercial que ninguém pediu.

## §7.199 — Consertar o consumidor de um sinal que não responde à pergunta cria DESINFORMAÇÃO

A dívida dizia *"7 de 9 consumidores de realtime ignoram o status do canal"*, e o conserto implícito
era *"faça-os ler o status"*. **Medido, o conserto seria pior que a dívida.**

Board e dossiê **leem** o status e ele diz `subscribed` **com a entrega morta** — porque descreve a
ASSINATURA, não a ENTREGA. Fazer as telas exibirem esse valor trocaria **ausência de informação por
afirmação confiante e errada**. Silêncio vira mentira, e mentira com selo de instrumento.

**Não é "ninguém lê o status": é "o status disponível não responde à pergunta".** O conserto real é
produzir o sinal que falta — *houve entrega recente?* — e não distribuir melhor o que existe.

**Regra:** antes de mandar consumir um sinal, pergunte **que pergunta ele responde**. Sinal que
responde a outra coisa é pior distribuído do que ignorado — ignorado deixa o usuário desconfiado;
exibido, o convence.

**E o número herdado estava errado e otimista:** medido são **10 usos**, 8 descartam o status e os 2
que capturam depositam num atributo `data-*` **que existe para teste**. Zero mostram algo a um
humano — na prática **10 de 10 invisíveis**, não 7 de 9.

## §7.200 — Intermitência ensina CONFIANÇA ERRADA, e por isso é pior que falha determinística

Quatro rodadas idênticas no inbox deram **três resultados diferentes**: 2/4 nunca recupera, 1/4 só ao
voltar à aba, 1/4 sozinha em ~4s.

**Com "nunca", o usuário aprende a apertar F5. Com "às vezes", ele aprende que confia — e erra
exatamente quando importa.** Falha determinística treina um contorno correto; falha intermitente
treina uma expectativa que falha sob carga, que é quando o custo é máximo.

**E só a REPETIÇÃO revelou:** a primeira rodada deu "recupera em ~10s", e o laudo seria *"o inbox é o
único saudável"* — o oposto da verdade. **Rodada única sobre comportamento intermitente não mede o
comportamento, sorteia um dos seus valores.**

## §7.201 — Validar o conserto contra o caso QUEBRADO não distingue conserto de defeito novo na mesma direção

O contador de quadros foi consertado duas vezes, e **a primeira correção também estava errada**:
trocou-se casamento por substring por exigir `"event":"postgres_changes"` — e o quadro do Phoenix é
um **array** `[join_ref, ref, topic, event, payload]`, sem chave `event`. **Falso positivo virou falso
NEGATIVO: zero sempre, inclusive onde a entrega funciona.**

E a lição que ele extraiu é a mais afiada do dia, e não é sobre substring: **o conserto foi validado
contra o caso que estava quebrado — onde zero era o resultado esperado.** Nesse caso, "consertado" e
"quebrado de outro jeito, na mesma direção" produzem **a mesma observação**.

**Regra:** a validação de um conserto tem de incluir **o caso onde o defeito NÃO estava**. É o único
lugar onde um defeito novo na mesma direção fica visível — e é o caso que ninguém roda, porque
"aquele já funcionava".

É a lei do par (§7.196) num terceiro eixo: não basta medir com/sem o conserto; é preciso medir
também **onde não havia o que consertar**.

## §7.202 — Resultado que CONFIRMA a expectativa de quem pediu passa por menos escrutínio dos DOIS lados

A primeira rodada da grade deu ZERO para os seis leads — inclusive os do controle positivo. Com o
controle caído, *"o CRM Vivo continua quebrado"* é indistinguível de *"nada está sendo entregue
agora"*. E a frase que fecha o dia:

> ***"Reportar aquilo teria confirmado a sua hipótese com uma rodada que não mediu nada, e você teria
> acreditado porque bate com o resto."***

**A coerência com o resto da história substitui a validade.** Quem reporta sente-se seguro (ninguém
questiona o resultado esperado) e quem recebe sente-se confirmado (encaixa no que já sabe) — os dois
escrutínios caem ao mesmo tempo, e é exatamente aí que um resultado vazio entra no registro como
fato.

**E o caso difícil é este, não o contrário:** honrar um controle que cai **quando a rodada estava
prestes a te dar razão**. Descartar um resultado que contradiz é fácil e parece rigor; descartar um
que confirma parece perfeccionismo — e é a única vez que a disciplina paga.

**Regra:** resultado que confirma a expectativa declarada de quem pediu a medição exige a MESMA
verificação de controle que um resultado surpreendente. Se o controle caiu, o veredito é *"não
mediu"*, e o fato de a resposta ser a esperada **não é evidência substituta**.

### O desenho que sobreviveu, e por que alternar importa

Trocou-se para o caminho com controle VIVO (INSERT em `crm_lead_activities`) e **alternou-se os lados
dentro da mesma janela** — não um bloco de cada. Bloco por lado deixa o ambiente mudar entre eles e
devolve a diferença como se fosse do sujeito. Resultado: **Pedidos 2/2 e 2/2; CRM Vivo 0/2 e 0/2.**

**Veredito: dois defeitos independentes.** O conserto da memoização e a remoção da assinatura anônima
resolvem o board mudo **e deixam este vivo** — o pior desfecho para quem olhasse só o board, porque
ele fica **com aparência de resolvido**.

## §7.203 — Guarda SOMBREADA: a trava que dispara primeiro esconde as demais, e o placar não conta

Seis casos verdes, prontos para reportar. Ao imprimir o **nome da constraint** que rejeitou, apareceu
que *"status inválido"* foi barrado por `decisao_datada` — **e não** por `status_check`. O caso
passava status não-pendente sem `decided_at`, então a trava vizinha disparava antes. **O
`status_check` seguia sem prova nenhuma, e o placar dizia seis de seis.**

É a §7.48 (*"recusou" não é a pergunta; "recusou pelo motivo certo" é*) com um mecanismo novo e mais
traiçoeiro: **não é o teste que está errado — é uma segunda guarda, correta, interceptando o caso
antes da guarda sob teste.** A contagem de testes verdes deixa de ser a contagem de travas provadas,
e nada no relatório revela a diferença.

**E a sombra não é estável.** A ordem de avaliação de constraints não é garantida: uma mudança de
schema pode inverter quem dispara primeiro, e o mesmo teste passa a provar outra coisa **em
silêncio**. Só o isolamento torna o significado do teste estável no tempo.

**Regra, em duas partes:**
1. **Imprima sempre o nome da trava que rejeitou.** Sem ele, "rejeitou pela trava certa" e "rejeitou
   por uma vizinha" são indistinguíveis — e o segundo caso é invisível por construção.
2. **Monte cada caso VÁLIDO em tudo menos no que está sob teste** (status inválido **com**
   `decided_at` preenchido), para que só a trava alvo possa reprovar. Caso "inválido em duas coisas"
   prova a primeira e não diz nada sobre a segunda.

## §7.204 — Para julgar instrumentos CONCORRENTES, a verdade de referência não pode ser nenhum deles

Quatro predicados de "isto é uma entrega?" precisavam ser comparados, e três deles já tinham errado.
A saída não foi eleger o mais plausível: foi **construir uma verdade independente de todos** — uma
**marca plantada no banco depois de a página já estar aberta**. O quadro que carrega a marca **é** a
entrega, porque só a entrega pode conter aquele texto.

Com ela, a tabela sai sozinha e sem argumento: v1 acerta a entrega **e** confunde recibo (falso
positivo); v2 não acerta nem a entrega (falso negativo); v3 e v4 acertam sem confundir.

**Regra:** quando os candidatos a instrumento discordam, medir um contra o outro só ordena os erros.
É preciso um **observável que o fenômeno sob estudo seja o único capaz de produzir** — e quase sempre
ele se constrói (§7.176: fabricar, não procurar).

## §7.205 — "Provavelmente está ok" tem histórico, e nesta investigação o histórico é ruim

Ao encontrar duas sondas com um predicado nunca julgado, a frase que quase saiu foi *"provavelmente
estão ok"* — e a observação que o autor fez sobre si mesmo é a lei: **"provavelmente" foi exatamente
o que eu disse das duas versões que quebraram.**

Não se trata de banir a estimativa. É que **a taxa-base já tinha sido medida ali mesmo**: naquela
investigação, instrumentos julgados por plausibilidade falharam duas vezes em duas. Continuar
estimando depois disso é ignorar a evidência local que a própria investigação produziu.

**Regra:** dentro de uma investigação onde instrumentos já falharam, **instrumento não recebe
presunção** — recebe a mesma tabela dos outros. O custo é baixo quando a verdade de referência já
está construída, e foi exatamente o que aconteceu: julgar o terceiro predicado custou uma linha na
tabela que já existia.

### Resolução da dúvida sobre o contador (respondida por varredura, não por memória)

- **v2 (sempre-zero) esteve em dois lugares.** Num, produziu a linha *"Entregas na MESMA janela:
  NENHUMA"* **dentro do vermelho do D21** — aquele zero não informava nada, como suspeitado. No
  outro, o autoteste do proxy o pegou **antes de qualquer conclusão sair**.
- **O veredito do D21 não se apoia nela:** "mudou" compara LINHAS NA TELA, com controle em processo
  irmão. Re-executado com o contador consertado: continua 0, **agora um zero que significa algo**.
- **A grade do pipeline nunca passou pelo contador** — aquelas sondas medem pelo CALLBACK do
  supabase-js, não por texto de quadro. Aparatos diferentes, e é por isso que Pedidos deu 3/3
  enquanto o contador da wave 6 marcava zero.

**Nenhuma conclusão viva se apoiava na v2. A grade continua valendo: NÃO CHEGAM, dois defeitos.**

## §7.206 — Medir "do jeito que não separa": quando o desenho garante que as hipóteses coincidam

*"A perda é da JANELA"* estava errado. A palavra certa é **LOTE**, e não é vocabulário.

Duas observações nunca encaixaram: mesma ordem, resultados opostos. A leitura foi *"a ordem revela o
envenenamento"*. **Não era a ordem** — as seis escritas caíam em menos de um segundo nas duas
rodadas, e o que mudava era se **couberam na mesma leitura do WAL**.

**Escrever tudo junto GARANTE o mesmo lote — e com isso torna "lote envenenado" e "assinatura morta"
indistinguíveis, porque as duas produzem "sumiu tudo".** O desenho não estava medindo mal: estava
medindo **do jeito que impede a separação**, e nenhuma repetição o corrigiria.

A separação exigiu **afastar as escritas no tempo**, que é a única forma de forçar lotes diferentes:

```
t=0    pipeline saudável .... CHEGOU (2/2)
t=6s   CRM Vivo ............. sumiu
t=12s  pipeline saudável .... CHEGOU (2/2)   ← decide
```

**A assinatura não morre.** Perdem-se as linhas que **viajam junto** com a envenenada.

**Regra:** quando duas hipóteses produzem a mesma observação, repetir não ajuda — o desenho tem de
**forçá-las a divergir**. E a variável que força quase nunca é a que está sob estudo: aqui era o
**intervalo entre as ações**, que ninguém listaria como parâmetro do experimento.

**Raio corrigido nos DOIS sentidos:** é **menor** do que se afirmou — o board de outros pipelines não
morre quando alguém mexe no CRM Vivo; e é **maior** do que *"só o CRM Vivo está mudo"* — **qualquer
pipeline perde eventos, em silêncio, quando eles calham de viajar no mesmo lote de uma escrita de
lá**. Somado ao raio do silêncio, essa perda colateral é imperceptível por construção: sem aviso, sem
refetch, e o status dizendo `subscribed`.

**Alvo mais preciso para o conserto:** não é *"o pipeline não entrega"*, é ***"uma linha daquele
pipeline aborta o lote de leitura do WAL em que ela viaja"*** — olhar o que o Realtime faz ao MONTAR
o lote, não ao filtrar a linha.

## §7.207 — Explicar uma observação NÃO ISOLADA promove ela a fato (erro meu)

A observação *"`crm_leads` UPDATE não entrega para ninguém"* veio **explicitamente marcada como não
isolada**, com a janela já fechada. Eu construí em cima dela um mecanismo detalhado (replica identity
`DEFAULT` + RLS descartando o `old_record`) e **despachei trabalho de DDL** com base nisso.

Medido depois: `crm_leads` UPDATE e `crm_lead_activities` INSERT **entregam 3/3 os dois**, na mesma
assinatura e no mesmo instante. **O zero era momentâneo. A hipótese está morta.**

**O mecanismo do erro é o que importa: explicação boa promove a observação a fato, retroativamente.**
Quanto mais específica e mecanicista a explicação, mais forte a promoção — porque uma explicação que
encaixa em detalhe *parece* exigir que o fenômeno exista. Quem marcou a observação como não isolada
fez o certo; **quem explicou apagou a marca**.

**Regra:** observação declarada não isolada só admite uma resposta — **isolar**. Explicá-la antes é
gastar trabalho de terceiros num fenômeno que ainda não se sabe existir, e é pior que ignorá-la,
porque a explicação vira a razão para não isolar.

## §7.208 — O experimento tem de incluir a CONDIÇÃO QUE A HIPÓTESE NOMEIA

A hipótese era: `REPLICA IDENTITY DEFAULT` + **RLS** faz o `old_record` de um UPDATE não satisfazer a
policy, e o evento é descartado. **E todo o aparato de medição usava service role — que BYPASSA
RLS.**

Logo, aquele aparato **não testa essa hipótese nem para confirmar nem para negar**. E a consequência
é pior do que "não conclui":

> *"Se eu tivesse rodado o ALTER e visto 'passou a entregar', teria concluído causa a partir de um
> experimento que nunca tocou o mecanismo proposto."*

**Um resultado que CONFIRMA, vindo de um aparato cego para o mecanismo, é uma causa inventada com
número em cima** — e ninguém a questiona, porque o número existe.

A correção foi pôr no experimento **o papel que a hipótese nomeia**: autenticado, mesma linha, mesmo
instante. Resultado: UPDATE por serviço 3/3, UPDATE **autenticado** 3/3, INSERT 3/3. **Refutada.**

**Regra:** antes de rodar o teste de uma hipótese, leia a hipótese e liste os elementos que ela cita —
papel, permissão, tipo de evento, estado. **Cada um tem de estar PRESENTE no aparato.** Elemento
citado que o aparato desliga transforma o experimento em teatro, e o teatro que confirma é o pior.

**E o que a refutação NÃO diz:** `REPLICA IDENTITY FULL` pode ser desejável por outros motivos
(`old_record` em DELETE). O que caiu foi **a causa proposta para aquele zero**, não o mérito da
mudança. Refutação também tem escopo — se alguém quiser FULL, que seja por um motivo que sobreviva
sozinho.

## §7.209 — A lista de ELIMINADOS vincula quem a mantém (erro meu, atravessando mensagens)

Horas antes, eu havia despachado a lista do que estava eliminado por medição, e nela constava:
***"RLS: medido com service role, fora do caminho."*** Depois propus uma hipótese **que depende de
RLS** — e mandei alguém aplicar DDL para testá-la.

**Eu mantinha a lista para os outros e não a consultei contra a minha própria proposta.** A
eliminação e a hipótese estavam em mensagens diferentes, separadas por horas, e **nada verifica
coerência entre despachos do mesmo autor** — cada um é lido isoladamente e parece razoável, que é
exatamente a §7.125 (a incoerência mora no PAR e ninguém revisa o par) aplicada a quem coordena.

**Regra para o papel:** a lista de eliminados é registro **vinculante para quem a mantém**. Antes de
propor hipótese, o regente relê a própria lista — se o mecanismo proposto usa algo já declarado fora
do caminho, ou a hipótese está errada, ou a eliminação estava. **As duas exigem correção, e ambas são
dele.**

### E a §7.202 virada para mim, com razão

*"A sua hipótese encaixava perfeitamente no resto da história — e foi exatamente por encaixar tão bem
que eu fui medir em vez de aplicar. Coerência com o resto da história não substitui validade **nem
quando quem propõe é o regente**."*

O peso da fonte funciona na mesma direção da coerência: os dois **reduzem** o escrutínio no momento
em que ele mais importa. Uma hipótese vinda de quem coordena chega com autoridade emprestada, e a
autoridade não mede nada.

## §7.210 — O relógio do defeito se mede pelo RASTRO das observações, não por instrumento novo

Não há registro de entregas passadas. Mas há registro **datado e versionado das observações**, e ele
cerca o intervalo pelos dois lados:

| carimbo | fato |
|---|---|
| **11:41:46** | wave 6 fecha 13/0/0 com o D21 **verde** — a timeline ganhou linha sem F5 num lead do CRM Vivo. **Entrega ao vivo OBSERVADA.** |
| **12:13:10** | primeira falha registrada: *"medido: ZERO"*. |
| 14:45 | agora |

**Mudo há no mínimo 2h32 e no máximo 3h03** — e o início cabe numa janela de **31 minutos**.

**E a inferência que sustenta o piso vai declarada, não escondida:** *"a linha apareceu sem F5"* só
prova entrega se não houver refetch de segurança — medido hoje que não há. **O limite:** essa medição
é do código de agora e o verde era do código das 11:41. O hook é o mesmo, mas isso é **raciocínio,
não medição**.

**O número que importa:** desde 12:13, aquele funil recebeu **9 atividades e 6 mudanças de negócio**,
todas com `source_module=crm` — **origem conferida para não inflar com as próprias sondas**.
**Quinze mudanças reais escritas, nenhuma entregue ao vivo, e ninguém com como saber.**

## §7.211 — A contraprova vai junto com a correlação, ou a correlação não sai

A única mudança de produção dentro da janela é a migration que cria `crm_lead_risk_states` **e a
adiciona à publicação** (11:54:55) — mexe exatamente no mecanismo medido como quebrado.

E a correlação foi entregue **com a contraprova no mesmo parágrafo**: das 68 linhas da tabela nova,
51 são de leads do pipeline **saudável**, que entrega 3/3. **Se a mera existência de linha
envenenasse, o saudável também estaria mudo.**

**Medição adicional que fecha a questão** (leitura, sem colidir com ninguém): **todas as 68 linhas
foram escritas entre 13:13 e 13:42 local** — ou seja, **DEPOIS da primeira falha observada às
12:13**. As linhas não podem causar um defeito que as antecede.

**Consequência direta, e ela poupa uma janela de trabalho:** o teste proposto (escrita concorrente na
tabela) **está descartado sem precisar rodar** — nem a existência nem a escrita concorrente explicam
uma falha anterior a qualquer linha. **Sobra a ALTERAÇÃO DA PUBLICAÇÃO em si, com a tabela vazia.**

**Nota de régua, porque o par quase enganou:** os carimbos do banco estão em **UTC** e os do rastro em
**local**. 16:13 UTC é 13:13 local. Comparar as duas séries sem converter teria posto as escritas
*antes* da falha e invertido a conclusão — duas réguas no mesmo raciocínio, exatamente o que já
custou uma investigação hoje.
