/**
 * GET /api/v1/ai/cases — lista os casos humanos da org (spec 15 §7, Wave 5).
 * Read-only via PostgREST (`createAdminClient`) — a escrita de estado do caso
 * mora em POST /api/v1/ai/cases/[id]/reply (pg.Pool do engine, ver ADR ali).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const OPEN_STATUSES = ["awaiting_human", "awaiting_lead"] as const;
const RESOLVED_STATUSES = ["resolved", "escalated", "cancelled"] as const;

const querySchema = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
});

type CaseRow = {
  id: string;
  title: string;
  summary: string;
  blocker: string;
  status: string;
  opened_at: string;
  conversation_id: string;
  conversations: { contacts: { name: string | null; phone_number: string | null } | null } | null;
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const statuses = parsed.data.status === "open" ? OPEN_STATUSES : RESOLVED_STATUSES;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_cases")
    .select(
      "id, title, summary, blocker, status, opened_at, conversation_id, conversations:conversation_id(contacts:contact_id(name, phone_number))",
    )
    .eq("organization_id", org.orgId)
    .in("status", statuses as unknown as string[])
    .order("opened_at", { ascending: false });
  if (error) {
    return fail("internal_error", "Falha ao carregar os casos.", 500, { requestId });
  }

  const rows = (data ?? []) as unknown as CaseRow[];
  const cases = rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    blocker: r.blocker,
    status: r.status,
    opened_at: r.opened_at,
    conversation_id: r.conversation_id,
    contact_name: r.conversations?.contacts?.name ?? null,
    contact_phone: r.conversations?.contacts?.phone_number ?? null,
  }));

  const { count: openCount } = await admin
    .from("agent_cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .in("status", OPEN_STATUSES as unknown as string[]);

  return ok({ cases, open_count: openCount ?? 0 }, { requestId });
}
