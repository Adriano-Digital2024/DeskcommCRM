/**
 * GET /api/v1/ai/cases/:id — detalhe do caso + timeline (spec 15 §7, Wave 5).
 * Read-only via PostgREST, org-scoped, 404 honesto.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: caseRow, error: caseErr } = await admin
    .from("agent_cases")
    .select(
      "id, title, summary, blocker, status, source, opened_at, closed_at, conversation_id, conversations:conversation_id(contacts:contact_id(name, phone_number))",
    )
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (caseErr) return fail("internal_error", "Falha ao carregar o caso.", 500, { requestId });
  if (!caseRow) return fail("not_found", "Caso não encontrado.", 404, { requestId });

  const { data: events, error: eventsErr } = await admin
    .from("agent_case_events")
    .select("id, kind, actor_kind, actor_user_id, human_action, body, created_at")
    .eq("organization_id", org.orgId)
    .eq("case_id", id)
    .order("created_at", { ascending: true });
  if (eventsErr) return fail("internal_error", "Falha ao carregar a timeline.", 500, { requestId });

  const row = caseRow as unknown as {
    id: string;
    title: string;
    summary: string;
    blocker: string;
    status: string;
    source: string;
    opened_at: string;
    closed_at: string | null;
    conversation_id: string;
    conversations: { contacts: { name: string | null; phone_number: string | null } | null } | null;
  };

  return ok(
    {
      id: row.id,
      title: row.title,
      summary: row.summary,
      blocker: row.blocker,
      status: row.status,
      source: row.source,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
      conversation_id: row.conversation_id,
      contact_name: row.conversations?.contacts?.name ?? null,
      contact_phone: row.conversations?.contacts?.phone_number ?? null,
      events: events ?? [],
    },
    { requestId },
  );
}
