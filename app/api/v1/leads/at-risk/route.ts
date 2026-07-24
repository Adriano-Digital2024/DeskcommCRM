/**
 * Radar de Risco (desilhamento C1 — doutrina do sistema vivo). GET → demandas
 * ABERTAS (`crm_leads.status='open'`) que esfriaram, para o humano ver o que está
 * morrendo sem ninguém olhar. Enriquece com follow-up agendado (`cron_jobs` kind='at')
 * — se a IA prometeu voltar, a demanda está "em voo", não abandonada. Ver
 * docs/doctrine/sistema-vivo.md.
 *
 * Admin client bypassa RLS: TODA query filtra organization_id explicitamente
 * (resolvido do JWT via requireRole, nunca do body).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  classifyRisk,
  compareRisk,
  RISK_COLD_HOURS,
  type RiskBucket,
} from "@/lib/leads/risk-radar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ponytail: teto do pool varrido (leads abertos mais frios primeiro). Escala do
// tenant-alvo (~centenas de leads abertos) cabe nisso; se um tenant estourar, vira
// query paginada com índice (organization_id, status, last_activity_at).
const SCAN_CAP = 500;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  min_hours: z.coerce.number().int().min(0).max(2000).default(RISK_COLD_HOURS),
});

export interface AtRiskLead {
  id: string;
  title: string;
  contact_id: string | null;
  contact_name: string | null;
  owner_user_id: string | null;
  assignee_kind: "user" | "ai" | null;
  last_activity_at: string | null;
  hours_since_activity: number;
  risk: RiskBucket;
  in_flight: boolean;
  next_followup_at: string | null;
  conversation_id: string | null;
  pipeline_id: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "leads_at_risk" });
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
  const { limit, min_hours } = parsed.data;

  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: leads, error: leadsErr } = await admin
    .from("crm_leads")
    .select("id, title, contact_id, owner_user_id, last_activity_at, created_at, pipeline_id")
    .eq("organization_id", org.orgId)
    .eq("status", "open")
    .order("last_activity_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_CAP);
  if (leadsErr) {
    return fail("internal_error", "Falha ao carregar o radar.", 500, { requestId });
  }

  const rows = leads ?? [];
  const contactIds = [...new Set(rows.map((l) => l.contact_id).filter((c): c is string => c !== null))];

  // Follow-ups agendados no futuro por contato (mais próximo primeiro) — "em voo".
  const followupByContact = new Map<string, string>();
  // Uma conversa por contato (qualquer serve para o deep-link do inbox) + assignee.
  const convByContact = new Map<string, { id: string; assignee_kind: "user" | "ai" | null }>();
  const nameByContact = new Map<string, string | null>();

  if (contactIds.length > 0) {
    const [followups, convs, contacts] = await Promise.all([
      admin
        .from("cron_jobs")
        .select("contact_id, next_run_at")
        .eq("organization_id", org.orgId)
        .eq("kind", "at")
        .eq("enabled", true)
        .gt("next_run_at", nowIso)
        .in("contact_id", contactIds),
      admin
        .from("conversations")
        .select("id, contact_id, assignee_kind")
        .eq("organization_id", org.orgId)
        .in("contact_id", contactIds),
      admin
        .from("contacts")
        .select("id, name, display_name")
        .eq("organization_id", org.orgId)
        .in("id", contactIds),
    ]);

    for (const f of followups.data ?? []) {
      const prev = followupByContact.get(f.contact_id);
      if (!prev || f.next_run_at < prev) followupByContact.set(f.contact_id, f.next_run_at);
    }
    for (const c of convs.data ?? []) {
      if (!convByContact.has(c.contact_id)) {
        convByContact.set(c.contact_id, { id: c.id, assignee_kind: c.assignee_kind ?? null });
      }
    }
    for (const p of contacts.data ?? []) {
      nameByContact.set(p.id, p.display_name ?? p.name ?? null);
    }
  }

  const radar: AtRiskLead[] = [];
  const counts: Record<RiskBucket, number> = { critico: 0, em_risco: 0, em_voo: 0, em_dia: 0 };

  for (const l of rows) {
    const lastActivity = l.last_activity_at ?? l.created_at;
    if (!lastActivity) continue;
    const nextFollowupAt = l.contact_id ? followupByContact.get(l.contact_id) ?? null : null;
    const { bucket, hoursSinceActivity, onRadar } = classifyRisk({
      lastActivityAt: new Date(lastActivity),
      now,
      inFlight: nextFollowupAt !== null,
    });
    if (!onRadar || hoursSinceActivity < min_hours) continue;
    const conv = l.contact_id ? convByContact.get(l.contact_id) ?? null : null;
    counts[bucket] += 1;
    radar.push({
      id: l.id,
      title: l.title,
      contact_id: l.contact_id,
      contact_name: l.contact_id ? nameByContact.get(l.contact_id) ?? null : null,
      owner_user_id: l.owner_user_id,
      assignee_kind: conv?.assignee_kind ?? null,
      last_activity_at: l.last_activity_at,
      hours_since_activity: Math.round(hoursSinceActivity),
      risk: bucket,
      in_flight: nextFollowupAt !== null,
      next_followup_at: nextFollowupAt,
      conversation_id: conv?.id ?? null,
      pipeline_id: l.pipeline_id,
    });
  }

  radar.sort((a, b) =>
    compareRisk(
      { bucket: a.risk, hoursSinceActivity: a.hours_since_activity },
      { bucket: b.risk, hoursSinceActivity: b.hours_since_activity },
    ),
  );
  const items = radar.slice(0, limit);

  return ok(
    {
      items,
      counts: { critico: counts.critico, em_risco: counts.em_risco, em_voo: counts.em_voo },
      total: radar.length,
    },
    { requestId },
  );
}
