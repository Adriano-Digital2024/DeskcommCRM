/**
 * GET /api/v1/contacts/[id]/timeline
 *
 * Returns polymorphic timeline (`crm_lead_activities`) for a contact, merging
 * direct `contact_id` activities with activities attached to leads owned by
 * this contact. Two RLS-scoped queries client-side (supabase-js does not
 * compose `.or` with subqueries cleanly), then merge → sort → cursor-paginate.
 *
 * Filters:
 *   - type: repeatable query param (?type=order_created&type=message_inbound)
 *   - cursor: opaque base64 of (performed_at, id)
 *   - limit: 1..100 (default 50)
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import type { TimelineItem, TimelineItemView } from "@/lib/types/contacts";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * As colunas que a timeline entrega. **Tem que acompanhar `TimelineItem`**
 * (`lib/types/contacts.ts`) — e essa concordância não é vigiada por nada: isto
 * é uma string, o `.select()` aceita qualquer coisa, e o resultado é convertido
 * para `TimelineItem` sem o compilador conferir.
 *
 * Já custou uma vez: a `0071` criou `reason`/`actor_kind`, o tipo passou a
 * declará-los, a tela passou a lê-los — e esta lista ficou para trás. Como os
 * campos são **opcionais** no tipo, `it.reason` virava `undefined`, o corpo da
 * linha caía no resumo do payload (JSON de UUID na cara do usuário) e todo ator
 * virava "não registrado". Tudo isso compilando verde: a interrogação do
 * opcional é que cala o compilador.
 *
 * Campo novo em `TimelineItem` → campo novo AQUI, no mesmo commit.
 */
const TIMELINE_COL_LIST = [
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

const TIMELINE_COLS = TIMELINE_COL_LIST.join(", ");

interface Cursor {
  performed_at: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(raw: string): Cursor | null {
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
async function comNomeDoAtor(
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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const url = new URL(req.url);
  const types = url.searchParams.getAll("type").filter(Boolean);
  const cursorRaw = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "50", 10) || 50, 1), 100);

  let cursor: Cursor | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    }
  }

  // Verify contact accessible (RLS will filter); 404 if not.
  const { data: contactRow, error: cErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .maybeSingle();
  if (cErr) return fail("internal_error", cErr.message, 500, { requestId });
  if (!contactRow) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  // Resolve owned lead ids first.
  const { data: leadRows, error: lErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("contact_id", contactId);
  if (lErr) return fail("internal_error", lErr.message, 500, { requestId });

  const leadIds = (leadRows ?? []).map((r) => (r as { id: string }).id);

  // Pull last (limit + 1) from each side to detect has_more after merge.
  // We over-fetch slightly to keep merge correct.
  const FETCH = limit + 1;

  const buildQuery = (column: "contact_id" | "lead_id", values: string | string[]) => {
    let q = supabase
      .from("crm_lead_activities")
      .select(TIMELINE_COLS)
      .order("performed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(FETCH);
    if (Array.isArray(values)) q = q.in(column, values);
    else q = q.eq(column, values);
    if (types.length > 0) q = q.in("type", types);
    if (cursor) {
      q = q.or(
        `performed_at.lt.${cursor.performed_at},and(performed_at.eq.${cursor.performed_at},id.lt.${cursor.id})`,
      );
    }
    return q;
  };

  const directQ = buildQuery("contact_id", contactId);
  const leadQ =
    leadIds.length > 0 ? buildQuery("lead_id", leadIds) : Promise.resolve({ data: [], error: null });

  const [directRes, leadRes] = await Promise.all([directQ, leadQ]);

  if (directRes.error) {
    return fail("internal_error", directRes.error.message, 500, { requestId });
  }
  if ("error" in leadRes && leadRes.error) {
    return fail("internal_error", leadRes.error.message, 500, { requestId });
  }

  // Cast duplo porque a lista de colunas agora é montada com `join()`: o
  // supabase-js infere o shape a partir da STRING LITERAL do select, e a
  // string dinâmica apaga essa inferência (vira GenericStringError[]). A troca
  // é deliberada — perde-se uma inferência que já não protegia contra o bug
  // real (campo do tipo fora do SELECT compilava verde) e ganha-se o portão de
  // exaustividade acima, que protege.
  const merged = new Map<string, TimelineItem>();
  for (const row of (directRes.data ?? []) as unknown as TimelineItem[]) merged.set(row.id, row);
  for (const row of (leadRes.data ?? []) as unknown as TimelineItem[]) merged.set(row.id, row);

  const sorted = Array.from(merged.values()).sort((a, b) => {
    if (a.performed_at !== b.performed_at) {
      return a.performed_at < b.performed_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });

  const hasMore = sorted.length > limit;
  const pageRows = hasMore ? sorted.slice(0, limit) : sorted;

  // Quem agiu, com NOME — resolvido aqui, na borda, e não na tela. É a mesma
  // decisão do dono agente no board: o dado de exibição viaja com a linha, em
  // vez de a tela ter de descobrir sozinha (e mostrar "Agente" genérico quando
  // não descobre). Sem filtro de is_active/archived: quem AGIU agiu, mesmo que
  // o agente tenha sido desligado depois.
  const page = await comNomeDoAtor(supabase, pageRows);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ performed_at: last.performed_at, id: last.id })
      : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
