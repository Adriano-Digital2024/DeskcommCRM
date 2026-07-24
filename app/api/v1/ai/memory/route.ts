/**
 * Épico Operação Visível (F1) — memória geral da org (spec harness, migration
 * 0067): documento versionado (versões imutáveis + ponteiro, mesmo padrão de
 * `ai_agents`/`ai_agent_versions`) e entradas de aprendizado (manual/flywheel).
 *
 * GET: estado completo para a tela — documento ativo, histórico de versões e
 * entradas não-propostas. POST: publica conteúdo novo como versão e move o
 * ponteiro (o clique É o gate humano — mesmo padrão de publish de agente).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const postSchema = z.object({ content: z.string().min(1).max(50_000) });

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "org_memory" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  const { data: pointer } = await admin
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", org.orgId)
    .maybeSingle();

  let document: {
    version_id: string;
    version_number: number;
    content: string;
    created_at: string;
  } | null = null;

  if (pointer?.version_id) {
    const { data: ver } = await admin
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id as string)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (ver) {
      document = {
        version_id: ver.id as string,
        version_number: ver.version_number as number,
        content: ver.content as string,
        created_at: ver.created_at as string,
      };
    }
  }

  const { data: versions, error: versionsErr } = await admin
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", org.orgId)
    .order("version_number", { ascending: false });
  if (versionsErr) {
    return fail("internal_error", "Erro ao carregar versões da memória.", 500, { requestId });
  }

  const { data: entries, error: entriesErr } = await admin
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at")
    .eq("organization_id", org.orgId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });
  if (entriesErr) {
    return fail("internal_error", "Erro ao carregar entradas da memória.", 500, { requestId });
  }

  return ok({ document, versions: versions ?? [], entries: entries ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "org_memory" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "content é obrigatório.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: maxRow } = await admin
    .from("org_memory_versions")
    .select("version_number")
    .eq("organization_id", org.orgId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  // ponytail: select-max + insert não é atômico sob publicação concorrente; publicação
  // é admin-only pela tela. Se virar concorrente, usar advisory lock por org.
  const nextVersion = ((maxRow?.version_number as number | null) ?? 0) + 1;

  const { data: ver, error: verErr } = await admin
    .from("org_memory_versions")
    .insert({
      organization_id: org.orgId,
      version_number: nextVersion,
      content: parsed.data.content,
      created_by: authUser.id,
    })
    .select("id, version_number")
    .single();
  if (verErr || !ver) {
    return fail("internal_error", "Erro ao publicar versão da memória.", 500, { requestId });
  }

  const { error: ptrErr } = await admin.from("org_memory_pointers").upsert(
    { organization_id: org.orgId, version_id: ver.id, updated_at: new Date().toISOString() },
    { onConflict: "organization_id" },
  );
  if (ptrErr) {
    return fail("internal_error", "Erro ao ativar a versão da memória.", 500, { requestId });
  }

  await audit({
    action: "ai.org_memory_published",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "org_memory_versions",
    resourceId: ver.id as string,
    requestId,
    metadata: { version_number: ver.version_number },
  });

  return ok({ version_id: ver.id, version_number: ver.version_number }, { requestId });
}
