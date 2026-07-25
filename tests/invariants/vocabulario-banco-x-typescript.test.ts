import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O CHECK do banco e o tipo do TypeScript falam o MESMO vocabulário.
 *
 * Achado do `@MaestroConexoes`/`@Arquiteto`: a entrega curou a divergência de
 * listas com gate de **compilador** — `Record<ActivityType, string>` exaustivo,
 * `satisfies keyof TimelineItem`. Isso resolve listas que vivem as duas em
 * TypeScript, e é elegante.
 *
 * **Mas o compilador não enxerga o banco.** Esta é a única classe de divergência
 * que o gate atual não pega *por construção*, e o modo de falha é o pior de
 * todos: passa no `typecheck`, passa no `lint`, passa no unitário — e aparece em
 * produção como `23514` num INSERT de caminho pouco exercitado. É o perfil exato
 * do intermitente que já custou duas rodadas de diagnóstico nesta entrega.
 *
 * A justificativa não é doutrina, é **taxa**: quatro pares desse eixo nasceram
 * em dois dias (`actor_kind` na 0071, `owner_kind` na 0070, `agent_inbox_items.kind`
 * e o que vier na 0073).
 *
 * ⚠️ **Ausência de CHECK aqui é DECISÃO, não lacuna.** `crm_lead_activities.type`
 * fica deliberadamente **sem** CHECK — está escrito com o motivo em
 * `lib/leads/activity-vocabulary.ts`: um clone com tipo legado quebraria no
 * `update.sh`, e a doutrina de migrations proíbe. Este invariante cobre **apenas
 * colunas que JÁ TÊM CHECK**. Quem ler isto daqui a três meses e quiser
 * "completar" adicionando um CHECK em `type` estaria consertando o que está
 * certo.
 */

/** Os pares. Coluna nova com CHECK de conjunto → uma linha aqui. */
const PARES: Array<{ tabela: string; coluna: string; ts: string[]; origem: string }> = [
  {
    tabela: "crm_lead_activities",
    coluna: "actor_kind",
    // lib/leads/activity-emitter.ts → ActivityActorKind
    ts: ["user", "ai", "system", "rule", "contact"],
    origem: "ActivityActorKind (lib/leads/activity-emitter.ts)",
  },
  {
    tabela: "crm_leads",
    coluna: "owner_kind",
    // lib/types/leads.ts → OwnerKind (o `null` do tipo é a ausência de dono, e
    // não um valor do CHECK — por isso não entra na lista).
    ts: ["user", "ai"],
    origem: "OwnerKind (lib/types/leads.ts)",
  },
  {
    tabela: "crm_lead_scores",
    coluna: "ai_probability_band",
    // lib/kanban/score-band.ts → ScoreBand. Nasce com o par no mesmo commit da
    // migration: a taxa deste eixo é de quatro pares em dois dias, e todos os
    // que divergiram divergiram por terem nascido sozinhos.
    ts: ["frio", "morno", "quente"],
    origem: "ScoreBand (lib/kanban/score-band.ts)",
  },
  {
    tabela: "crm_leads",
    coluna: "status",
    // lib/types/leads.ts → LeadStatus.
    //
    // Este par entra como PROVA do conserto do extrator, não por acaso: é a
    // coluna com DUAS constraints casando por substring (a que define o enum e a
    // que amarra `closed_at`). Com o extrator antigo, o `limit 1` sem `order by`
    // podia devolver [lost, won] — e o par reprovaria por motivo falso.
    ts: ["open", "won", "lost"],
    origem: "LeadStatus (lib/types/leads.ts)",
  },
  {
    tabela: "agent_inbox_items",
    coluna: "kind",
    // lib/agent-engine/db/repository.ts → InboxKind.
    //
    // Este par nasceu de um defeito REAL, não de zelo: a lista do TS ficou 3
    // valores atrás do banco e ninguém soube. Pior, o dev checkou a lista
    // contra o BANCO DE DEV, que estava numa versão ANTERIOR da constraint e
    // não aceitava `followup_dead` — enquanto lib/followup/engine.ts o insere.
    // O aviso que existe para salvar um follow-up travado era rejeitado pelo
    // banco, em silêncio, num caminho fire-and-forget.
    //
    // Por isso este invariante lê do Postgres DESCARTÁVEL que nasce do
    // `baseline.sql` versionado (TEST_DB_CONTAINER), nunca do banco de dev: o
    // banco de dev conta o que aconteceu com ele, não o que o sistema promete.
    ts: [
      "qr_rescan",
      "job_dead",
      "event_dead",
      "budget_exceeded",
      "handoff",
      "promotion_review",
      "judge_unaligned",
      "followup_dead",
      "snooze_expired",
      "next_action_ambiguous",
      "risk_backlog_seeded",
      "other",
    ],
    origem: "InboxKind (lib/agent-engine/db/repository.ts)",
  },
];

/** Tira um nível de parênteses externos, se ele envolver a expressão inteira. */
function desembrulha(expr: string): string {
  let e = expr.trim();
  while (e.startsWith("(") && e.endsWith(")")) {
    let nivel = 0;
    let fechaNoFim = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") nivel++;
      else if (e[i] === ")") {
        nivel--;
        if (nivel === 0 && i < e.length - 1) {
          fechaNoFim = false;
          break;
        }
      }
    }
    if (!fechaNoFim) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/**
 * Os literais de uma constraint — **só se ela DEFINIR o vocabulário**.
 *
 * A versão anterior casava por substring (`like '%= ANY (ARRAY[%'`), e isso
 * seleciona qualquer constraint que MENCIONE valores da coluna. Medido no banco:
 * `crm_leads.status` tem duas, e a diferença entre elas é a diferença entre
 * medir o vocabulário e medir uma regra de negócio —
 *
 *   crm_leads_status_enum ............ CHECK (status = ANY (ARRAY[open, won, lost]))   ← DEFINE
 *   crm_leads_closed_at_consistency .. CHECK (... status = ANY (ARRAY[won, lost]) AND closed_at IS NOT NULL)  ← só menciona
 *
 * Hoje passaria por SORTE, porque `limit 1` sem `order by` escolhe uma das duas
 * e as duas têm literais parecidos. No dia em que uma regra composta injetar um
 * valor que não é vocabulário, o invariante aprova ou reprova por motivo FALSO —
 * e invariante que erra por motivo falso é pior que invariante nenhum, porque é
 * obedecido.
 *
 * Aceita as duas formas que DEFINEM: `col = ANY (ARRAY[...])` e a variante com
 * `col IS NULL OR ...`, que é como se escreve "opcional, mas se vier tem de ser
 * um destes".
 */
function literaisSeDefine(def: string, coluna: string): string[] | null {
  const semCheck = desembrulha(def.trim().replace(/^CHECK\s*/i, ""));
  const col = coluna.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "col IS NULL OR <resto>" — a permissão de nulo não descaracteriza a definição.
  const semNulo = desembrulha(
    desembrulha(semCheck).replace(new RegExp(`^\\(?${col}\\)?\\s+IS NULL\\)?\\s+OR\\s+`, "i"), ""),
  );

  const m = new RegExp(`^\\(?${col}\\)?\\s*=\\s*ANY\\s*\\(ARRAY\\[(.+)\\]\\)$`, "is").exec(semNulo);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'::text/g)].map((x) => x[1]!).sort();
}

/**
 * O vocabulário que o banco aceita para a coluna.
 *
 * Se DUAS constraints definirem o conjunto, isto RECUSA em vez de escolher —
 * mesmo princípio do `resolveActiveLeadForContact`. Adivinhar num instrumento de
 * medição é pior que num roteador: o roteador erra um card, o instrumento erra o
 * veredito sobre todos.
 */
function valoresDoCheck(tabela: string, coluna: string): string[] {
  const bruto = sql(
    `select pg_get_constraintdef(k.oid)
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
      where k.contype = 'c'
        and c.relname = '${tabela}'
        and a.attname = '${coluna}'
      order by k.conname`,
  );

  const definidoras = bruto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((def) => ({ def, valores: literaisSeDefine(def, coluna) }))
    .filter((x): x is { def: string; valores: string[] } => x.valores !== null);

  if (definidoras.length > 1) {
    throw new Error(
      `${tabela}.${coluna}: ${definidoras.length} constraints DEFINEM o vocabulário — ` +
        `me recuso a escolher uma, porque escolher errado dá veredito falso sobre ` +
        `todos os pares. Constraints:\n` +
        definidoras.map((d) => `  ${d.def}`).join("\n"),
    );
  }
  return definidoras[0]?.valores ?? [];
}

describe("vocabulário: banco × TypeScript", () => {
  it("a tabela de pares não pode vir vazia", () => {
    // Sem esta guarda, esvaziar PARES faria a suíte passar sem verificar nada —
    // verde vácuo no nível do arquivo, que esta entrega já pegou duas vezes.
    expect(PARES.length).toBeGreaterThan(0);
  });

  for (const par of PARES) {
    it(`${par.tabela}.${par.coluna} aceita exatamente o que ${par.origem} declara`, () => {
      const noBanco = valoresDoCheck(par.tabela, par.coluna);
      expect(
        noBanco.length,
        `${par.tabela}.${par.coluna} não tem CHECK de conjunto — ou a coluna mudou, ou o par saiu da lista`,
      ).toBeGreaterThan(0);

      const noTs = [...par.ts].sort();
      expect(
        noBanco,
        `divergência de vocabulário — o compilador NÃO pega esta:\n` +
          `  banco aceita: ${noBanco.join(", ")}\n` +
          `  ${par.origem} declara: ${noTs.join(", ")}`,
      ).toEqual(noTs);
    });
  }
});
