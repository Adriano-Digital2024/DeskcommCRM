import type { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";
import type { TimelineItem, TimelineItemView } from "@/lib/types/contacts";

/**
 * As peças que as DUAS timelines compartilham — a do contato e a do lead.
 *
 * Extraídas em vez de copiadas: a lista de colunas tem um portão de
 * exaustividade contra `TimelineItem`, e uma segunda cópia dele começaria
 * idêntica e divergiria no primeiro campo novo, sem nada acusar. É a mesma
 * razão pela qual o formulário do dossiê foi extraído e não duplicado.
 */
export const TIMELINE_COL_LIST = [
  "id",
  "organization_id",
  "lead_id",
  "contact_id",
  "source_module",
  "source_id",
  "type",
  "payload",
  "metadata",
  "performed_at",
  "performed_by_user_id",
  "actor_kind",
  "actor_agent_id",
  "reason",
  "evidence",
] as const satisfies readonly (keyof TimelineItem)[];

/**
 * O PORTÃO, em tempo de compilação — o comentário acima virou regra executável.
 *
 * `satisfies keyof TimelineItem` pega a primeira direção: pedir coluna que o
 * tipo não conhece não compila. O `Faltando` abaixo pega a segunda, que é a que
 * doeu de verdade: campo novo no tipo e esquecido no SELECT deixa de ser um
 * bug silencioso (opcional vira `undefined`, tela cai no fallback, tudo verde)
 * e passa a ser erro de tipo, com o nome do campo que falta na mensagem.
 */
type ColunasPedidas = (typeof TIMELINE_COL_LIST)[number];
type Faltando = Exclude<keyof TimelineItem, ColunasPedidas>;
const _todoCampoDoTipoEstaNoSelect: Faltando extends never
  ? true
  : ["TIMELINE_COL_LIST não pede estes campos de TimelineItem:", Faltando] = true;
void _todoCampoDoTipoEstaNoSelect;

export const TIMELINE_COLS = TIMELINE_COL_LIST.join(", ");

export interface Cursor {
  performed_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
export function decodeCursor(raw: string): Cursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed.id !== "string" || typeof parsed.performed_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Anexa o nome do agente e da pessoa que agiram, para a linha não dizer só "Agente". */
export async function comNomeDoAtor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: TimelineItem[],
): Promise<TimelineItemView[]> {
  const agentIds = [...new Set(rows.map((r) => r.actor_agent_id).filter((v): v is string => !!v))];
  const userIds = [...new Set(rows.map((r) => r.performed_by_user_id).filter((v): v is string => !!v))];

  const nomeAgente = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data } = await supabase.from("ai_agents").select("id, name").in("id", agentIds);
    for (const a of (data ?? []) as Array<{ id: string; name: string }>) nomeAgente.set(a.id, a.name);
  }

  const nomeUsuario = new Map<string, string>();
  if (userIds.length > 0 && isServiceRoleConfigured()) {
    const admin = createAdminClient();
    await Promise.all(
      userIds.map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        const nome = data?.user?.user_metadata?.full_name;
        if (typeof nome === "string" && nome.trim() !== "") nomeUsuario.set(id, nome);
      }),
    );
  }

  return rows.map((r) => ({
    ...r,
    actor_agent_name: r.actor_agent_id ? (nomeAgente.get(r.actor_agent_id) ?? null) : null,
    actor_user_name: r.performed_by_user_id
      ? (nomeUsuario.get(r.performed_by_user_id) ?? null)
      : null,
  }));
}

