# Wave 1 — CORE 1: a IA é dona do negócio · 2026-07-24 · implementação concluída

> Bloco do **@DevVivo** para o `HANDOFF-crm-vivo.md` (quem escreve o handoff oficial é o
> orquestrador — §10). Prova visual oficial dos cenários 1-4: **@QAVivo**.

## O que entrou

**Schema (os 3 artefatos, obrigatórios juntos)**
- `supabase/migrations/20260725000000_0070_crm_lead_owner_kind.sql` — `crm_leads.owner_kind ('user'|'ai')` + `owner_agent_id uuid references ai_agents(id) on delete set null`, no padrão da 0032: backfill **antes** da constraint, CHECK `crm_leads_owner_kind_coherence` em forma de implicação (drop+add, re-aplicável), índice parcial `idx_crm_leads_owner_agent`.
- `supabase/baseline.sql` — apêndice idempotente `-- ---- crm_leads owner_kind/owner_agent_id (migration 0070) ----`.
- `supabase/migrations/MANIFEST.md` — linha da 0070. Numeração conferida com `git ls-tree` em **todas** as branches (0068/0069 tomados por `feat/harness-*`).
- `fn_emit_event_on_lead_change()` re-assentada (`create or replace`, corpo da 0043 + ramo do agente): `lead.assigned` passa a disparar quando `owner_agent_id` muda, com `from_agent_id`/`to_agent_id`/`owner_kind`.

**Código**
- `lib/types/leads.ts` — `OwnerKind` + `owner_kind`/`owner_agent_id` no `Lead`.
- `lib/database.types.ts` — colunas em Row/Insert/Update + FK `crm_leads_owner_agent_id_fkey → ai_agents`.
- `lib/schemas/leads.ts` — `owner_agent_id` no `updateLeadSchema`. **`owner_kind` não é aceito do cliente.**
- `app/api/v1/leads/_handler.ts` — `updateLeadHandler` deriva `owner_kind`, zera o outro dono (exclusividade), 422 se vierem os dois, e valida que o agente é **da mesma org** (a FK garante existência, não tenancy).
- `app/api/v1/ai/agents/assignable/route.ts` *(nova)* — agentes atribuíveis, role `agent`+, RLS-scoped. Devolve `is_active` e a **versão publicada resolvida na leitura**.
- `hooks/kanban/useAssignableAgents.ts` *(nova)*.
- `lib/kanban/owner.ts` + `owner.test.ts` *(novas)* — `resolveLeadOwner()`, função pura e única de "quem é o dono".
- `components/kanban/OwnerBadge.tsx` + teste — agente = círculo vazado com anel, iniciais em mono, **mesmo 24px e mesmo peso** do humano; rótulo/tooltip `Nome · vN`.
- `KanbanCard` / `StageColumn` / `KanbanBoard` — passam o dono resolvido.
- `KanbanCardActions` — transferir humano↔agente; submenu só para quem pode escrever (`usePermission("pipeline.move_card")`).
- `lib/kanban/filters.ts` + `FilterBar` — `LeadFilters.ownerUserId` → `owner`, aceitando `agent:<uuid>`; agentes na **mesma** lista dos humanos; "Sem responsável" agora exige ausência dos **dois** donos.

## Checklist sistema-vivo (as 7 respostas)

1. **Quem me alimenta:** `PATCH /api/v1/leads/[id]` (cookie de sessão; org do JWT, nunca do body) e, nas próximas waves, o próprio agente ao assumir o negócio. O nome/versão do dono vem de `ai_agents`/`ai_agent_versions` por join na leitura.
2. **Quem eu alimento:** `event_log` (`lead.assigned` com `to_agent_id`), o board (`GET /api/v1/pipelines/[id]/board`), o filtro de responsável e o índice parcial que serve às métricas por agente. Wave 3 pendura a timeline nesse mesmo evento.
3. **Log que emito:** `event_log` via trigger + `api_audit_log` via `audit({action:"lead.updated"})` com `fields`.
4. **Onde apareço na tela:** no card (avatar + nome + tooltip `Nome · vN`), no seletor "Responsável" e no menu de transferência. Provado em screenshot.
5. **Anti-morte:** o dono agente é o que permite a Wave 5 cobrar próxima ação de um negócio que nenhum humano está olhando — hoje, um lead de bot fica sem dono e ninguém é cobrado. Nesta wave o mecanismo ainda é o do humano (o lead nunca fica sem `owner_kind` coerente; a constraint impede estado ambíguo).
6. **Continuidade IA↔humano:** transferir agente→humano e humano→agente pelo mesmo menu, com o evento `lead.assigned` carregando **de quem para quem** — o próximo dono sabe que houve troca. O resumo contextual (o que o agente já sabia) entra na Wave 3, quando a timeline existir.
7. **Mapa vivo:** *não aplicável nesta base* — `docs/architecture/` nesta branch tem só `agent-turn.workflow.json`/`.html`; o mapa do sistema (`deskcomm-system.architecture.json`) **não existe em `origin/main`**, é arquivo ainda não commitado da branch `feat/operacao-visivel`. Não há o que re-renderizar aqui. Quando os dois se encontrarem, as peças a acrescentar estão listadas abaixo.

## Verificação visual (prova do @DevVivo; a oficial é do @QAVivo)

Instância própria do Playwright (o browser MCP estava com o QA), dev server da entrega na **3020**, login real como `e2e-manager`, tudo pela UI.

| # | Cenário | Resultado | Evidência |
|---|---|---|---|
| A | Atribuir lead a agente pelo menu do card | Card passa de "Sem responsável" para `LA · Lia — AgendaPlus` | `wave-1-dono-agente.png`, `wave-1-card-agente.png` |
| B | Agente é par do humano | avatar **24×24px** (igual ao humano), `font-family: IBM Plex Mono`, `background: rgba(0,0,0,0)` (vazado), `border 1px` + ring; sem emoji, sem badge "AI" | medido por `getComputedStyle`, não a olho |
| C | Tooltip nome · versão | `Lia — AgendaPlus · v24` (versão **publicada hoje**, resolvida por join) | log da prova |
| D | Transferência de volta | Volta a "Sem responsável" e persiste | `wave-1-revertido.png` |
| E | Board inteiro | Humanos (`EM`, `EA` preenchidos) e agentes (`LA`, `BE` vazados) lado a lado | `wave-1-dono-agente.png` |

Screenshots em `/private/tmp/claude-501/-Users-rafaelmelgaco-DeskcommCRM/9579c957-fb23-4342-9df1-c208137c2c03/scratchpad/` (não escrevi em `evidence/`, que é do QA — copiar para lá se quiser referenciar no handoff oficial).

Qualidade: `pnpm typecheck` **0**, `pnpm lint` **0 errors** (151 warnings pré-existentes do repo), `npm run test:unit` **807/807** (113 arquivos), incluindo 16 testes novos/atualizados de `OwnerBadge` e `resolveLeadOwner`. Exit codes lidos **sem** `| tail`.

## Bugs encontrados

| Sintoma | Causa raiz | Correção | Re-testado |
|---|---|---|---|
| Card com dono agente aparecia como `?` + rótulo genérico "Agente" (lead do Caio Ribeiro) | A rota `assignable` filtrava `is_active=true`. Ela serve a **dois** propósitos que eu tratei como um: lista de *destinos* (picker) e dicionário de *resolução de nome* (exibição) | **1ª tentativa (minha, substituída):** relaxar o filtro da rota `assignable` e devolver `is_active`. **Correção final (decisão do orquestrador):** ver abaixo | Sim — mas a 1ª correção foi revertida |

### Correção definitiva — o dado de exibição viaja com o lead

**Registro antes de mexer.** O orquestrador achou o mesmo sintoma de forma independente e vetou a
minha correção com razão: relaxar o filtro do `assignable` conserta o sintoma **no lugar errado** —
a rota é um *picker*, e os filtros dela estão certos. Minha versão ainda deixava o agente
**arquivado** anônimo (eu tinha registrado isso como débito aceito; ele não aceitou, e está certo:
"peça que perde a identidade do dono é peça que morre sem ninguém ver").

Decisão implementada:
- `GET /api/v1/pipelines/[id]/board` passa a devolver, para cada lead com dono agente, o **nome e a
  versão publicada** — join server-side em `ai_agents`/`ai_agent_versions` **sem** filtro de
  `is_active`/`archived_at`, com `organization_id` filtrado explicitamente (da org do pipeline
  validado por RLS, nunca do body).
- `GET /api/v1/ai/agents/assignable` **volta ao estado de picker**: `is_active = true` e
  `archived_at is null`. O campo `is_active` sai do payload e os filtros locais na UI saem junto.
- `resolveLeadOwner` deixa de depender de um mapa de agentes: lê o dono direto do lead. A cadeia
  `KanbanBoard → StageColumn` perde a prop `agentsById`.
- Fixture de regressão preservada: o lead de agente **inativo** do seed fica como está (não mexi no
  seed) e o teste `lead de agente inativo continua exibindo nome` fixa o comportamento.

### Gaps de propagação — três escritores de dono fora da regra (achado do orquestrador)

**Registro antes de mexer.** O PATCH estava certo, mas ele não era o único a escrever dono:

| # | Escritor | Defeito | Efeito |
|---|---|---|---|
| 1 | `createLeadHandler` (`_handler.ts`) | INSERT grava `owner_user_id` e não grava `owner_kind`/`owner_agent_id` | Lead nasce **com dono e sem `owner_kind`** — o CHECK aceita (3º ramo), então é **drift silencioso**: filtro e métricas por `owner_kind` não enxergam o lead |
| 2 | `bulk` `case "assign"` | patch só com `owner_user_id` + `assigned_at` | (a) atribuir humano em massa a lead de dono agente → **23514 derruba o lote inteiro**; (b) sem dono anterior → mesmo drift do gap 1, em lote |
| 3 | MCP (`lib/mcp/tools/leads.ts`) | `crm_create_lead` herda o gap 1 | **A IA corrompendo o próprio registro de posse** — é a superfície pela qual o agente mexe no CRM |

Correção: **um helper puro compartilhado**, `resolveOwnerPatch()` em `lib/leads/owner-patch.ts`, que
devolve sempre o trio coerente `{owner_user_id, owner_agent_id, owner_kind}` ou recusa "dois donos".
Create, patch, bulk e MCP passam por ele. Guarda na função compartilhada, não em cada chamador — é o
único que cobre o escritor que ainda não foi escrito.

Verificado na leitura: `crm_update_lead` (MCP) **não** monta patch próprio, chama o
`updateLeadHandler` — então herda a regra de graça. O gap real do MCP era só o create.

**Prova dos gaps corrigidos**

| Caminho | Como provei | Resultado |
|---|---|---|
| create com dono humano | `POST /api/v1/leads` com a sessão do usuário logado (a UI **não** expõe responsável no "Novo Lead" — não há tela para isto) | 201, `owner_kind='user'` (antes: `null` = drift) |
| create com dono agente | idem | 201, `owner_kind='ai'`, humano zerado |
| create com os dois donos | idem | **422** com mensagem explicável (não 500 do banco) |
| create sem dono | idem | 201, trio todo `null` |
| **bulk assign sobre lead de dono AGENTE** | **pela UI**: criei um lead próprio, atribuí ao agente pelo menu, selecionei e usei "Atribuir a… → Eu" | Card foi de `LA · Lia — AgendaPlus` para `EM · E2E Manager`, **zero erro na tela** (antes: 23514 derrubava o lote) |
| estado no banco após o bulk | `psql` no lead da prova | `owner_kind='user'`, humano preenchido, **agente zerado**, `assigned_at` setado |
| constraint + helper contra Postgres real | `pnpm test:db` (container efêmero, baseline aplicado) | `tests/invariants/lead-owner-kind.test.ts` — 6 casos, incluindo os 3 estados que o banco **recusa** |

Os leads de prova foram apagados ao final (board de volta a 11 leads); nenhuma fixture do QA foi tocada.

`pnpm test:db` também revalidou o **apêndice do baseline**: `install` (banco novo, `ON_ERROR_STOP=1`)
e `update` (re-aplicação) verdes — o gate do item 7 da doutrina de migrations.

## O que ficou para trás (e por quê)

- **Mapa vivo não atualizado porque não existe nesta branch** (só `agent-turn.workflow.json`). Quando o `deskcomm-system.architecture.json` chegar aqui, precisam entrar com grau ≥2: `resolveLeadOwner` (board → resolve → card), a rota `ai/agents/assignable` (UI → rota → `ai_agents`/`ai_agent_versions`) e a aresta `crm_leads → ai_agents` via `owner_agent_id`.
- **E2E de regressão (`kanban-owner-filter`, `rbac-roles`, `risk-radar`) não rodados por mim** — exigem `next build` + `next start` em porta própria e o QA está com o ambiente. Risco concentrado no `kanban-owner-filter` (renomeei `LeadFilters.ownerUserId → owner`; o **param de URL `?owner=` não mudou**).
- **`createLeadSchema` não ganhou `owner_agent_id`** — criar um lead já nascendo de um agente não está no contrato da wave; hoje se cria e depois se atribui.
- **Tooltip é `title` nativo**, não o `Tooltip` do design system. Motivo: não há `TooltipProvider` global e montar um por card no board é custo sem retorno agora. **Upgrade:** trocar por Radix quando o dossiê (Wave 6) já trouxer o provider.
- **Agente ARQUIVADO que ainda seja dono** cai no rótulo genérico. Mesma degradação que já existe para dono humano fora da lista de membros.
- **Seed com dono agente** é do @QAVivo (`scripts/seed-*`) — já vi cards com agente no board, então parece coberto.

## Débito / risco introduzido

- **RLS não conhece o dono agente.** `fn_can_view_lead(organization_id, owner_user_id)` trata lead de dono agente como "não atribuído" no modo `own_and_unassigned`. Ninguém perde acesso (é mais permissivo, não menos), mas quando existir política "só meus leads", lead de agente vai vazar para todo mundo desse modo. **Dói** quando a Wave 8 ligar o funil do agente ao Kanban com times grandes.
- **`lead.assigned` cresceu de payload.** Nenhum consumidor lê hoje (grepado), então é seguro — mas quem for consumir precisa tratar `to_user_id` e `to_agent_id`, nunca só o primeiro.
- **`is_active` no payload da rota assignable** é informação de configuração exposta a `agent`. É um booleano sem PII; se incomodar, dá para devolver só para manager+ e resolver nome por outro caminho.

## Decisões tomadas no caminho

- **`owner_kind` é derivado no servidor**, nunca aceito do body. Alternativa descartada: aceitar os três campos e confiar na constraint — funciona, mas transforma erro de cliente em 500 do banco em vez de 422 explicável.
- **Estendi o trigger `lead.assigned` para o agente** (além do contrato). Alternativa descartada: deixar para a Wave 3 — mas aí a coluna nasceria ilha e atribuir a um agente seria mutação silenciosa, exatamente a doença que esta entrega cura.
- **Rota nova em vez de reusar `GET /api/v1/ai/agents`** (manager+). Alternativa descartada: baixar o RBAC daquela rota — ela expõe `system_prompt`, `guardrails` e `config`; um vendedor não precisa disso para saber de quem é o card.
- **Filtro por agente reusa o param `?owner=`** com prefixo `agent:`. Alternativa descartada: um segundo seletor "Agente" na FilterBar — dois controles para a mesma pergunta ("de quem é isto?") é o começo do card inflado que a §5 proíbe.
