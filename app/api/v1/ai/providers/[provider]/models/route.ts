/**
 * GET /api/v1/ai/providers/:provider/models
 *
 * Lê do catálogo curado `ai_models` (tabela GLOBAL, RLS read-all).
 * Retorna modelos não-deprecated ordenados por default-first depois preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter", "agentrouter"]);

const MODEL_COLUMNS =
  "id, provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider, deprecated_at, released_at";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { provider } = await ctx.params;

  if (!PROVIDERS.has(provider)) {
    return fail("not_found", "Provider desconhecido.", 404, { requestId });
  }

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_models")
    .select(MODEL_COLUMNS)
    .eq("provider", provider)
    .is("deprecated_at", null)
    .order("is_default_for_provider", { ascending: false })
    .order("input_price_per_million_cents", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar modelos.", 500, { requestId });
  }

  return ok({ models: data ?? [] }, { requestId });
}
