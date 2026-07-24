/**
 * GET /api/v1/ai/agents/assignable — destinos de atribuição que são AGENTES
 * (CRM Vivo Wave 1 / migration 0070): o par de /api/v1/team/assignable, que
 * lista os humanos.
 *
 * Por que uma rota nova em vez de reusar GET /api/v1/ai/agents: aquela é
 * manager+ (configuração de agente). Um `agent` (vendedor) precisa ver de quem
 * é o card e transferir o negócio — mesma exceção deliberada e MÍNIMA que a
 * rota de humanos já documenta. Exposto o mínimo: id, nome e a versão
 * PUBLICADA no momento da leitura (o tooltip "Nome · v3" resolve por join,
 * nunca congela a versão no lead).
 *
 * Auth: cookie session; organization_id vem do JWT — nunca do body/query.
 * RLS-scoped (createClient), sem admin client: não há nada aqui que a RLS do
 * tenant não deva mostrar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface AssignableAgent {
  agent_id: string;
  name: string;
  /** null quando o agente ainda não tem versão publicada. */
  version_number: number | null;
  /**
   * Só agente ativo é DESTINO de atribuição — mas todo agente não arquivado
   * entra na lista, porque ela também é o dicionário que RESOLVE o nome do
   * dono no card. Desligar um bot não pode transformar os negócios dele em
   * cards anônimos.
   */
  is_active: boolean;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const { data: agents, error } = await supabase
    .from("ai_agents")
    .select("id, name, published_version_id, is_active")
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = (agents ?? []) as Array<{
    id: string;
    name: string;
    published_version_id: string | null;
    is_active: boolean;
  }>;

  const publishedIds = rows.map((a) => a.published_version_id).filter((v): v is string => !!v);
  const versionById = new Map<string, number>();
  if (publishedIds.length > 0) {
    const { data: versions, error: versionsErr } = await supabase
      .from("ai_agent_versions")
      .select("id, version_number")
      .eq("organization_id", orgId)
      .in("id", publishedIds);
    if (versionsErr) return fail("internal_error", versionsErr.message, 500, { requestId });
    for (const v of (versions ?? []) as Array<{ id: string; version_number: number }>) {
      versionById.set(v.id, v.version_number);
    }
  }

  const result: AssignableAgent[] = rows.map((a) => ({
    agent_id: a.id,
    name: a.name,
    version_number: a.published_version_id
      ? (versionById.get(a.published_version_id) ?? null)
      : null,
    is_active: a.is_active,
  }));

  return ok(result, { requestId });
}
