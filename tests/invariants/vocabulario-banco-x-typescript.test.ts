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
      "other",
    ],
    origem: "InboxKind (lib/agent-engine/db/repository.ts)",
  },
];

/** Extrai os literais de um `CHECK (x = ANY (ARRAY['a'::text, 'b'::text]))`. */
function valoresDoCheck(tabela: string, coluna: string): string[] {
  const def = sql(
    `select pg_get_constraintdef(k.oid)
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
      where k.contype = 'c'
        and c.relname = '${tabela}'
        and a.attname = '${coluna}'
        and pg_get_constraintdef(k.oid) like '%= ANY (ARRAY[%'
      limit 1`,
  ).trim();
  return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
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
