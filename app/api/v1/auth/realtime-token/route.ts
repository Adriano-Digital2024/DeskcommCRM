/**
 * GET /api/v1/auth/realtime-token — o token que o canal Realtime precisa.
 *
 * Por que existe: o cookie de sessão é httpOnly (CLAUDE.md), então o
 * supabase-js do browser NÃO enxerga a sessão e assina os canais como ANÔNIMO.
 * O Realtime aplica RLS por canal: canal anônimo assina, recebe "ok", e nunca
 * recebe evento nenhum — falha silenciosa que parece saúde. O fetch do board já
 * tinha sido movido para rota de API por essa mesma razão (ver useBoard);
 * o realtime ficou para trás.
 *
 * A sessão continua morando no cookie httpOnly. Isto entrega apenas o
 * access_token, em memória, para o cliente autenticar o WebSocket — nunca
 * gravado em storage, e some no reload.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // getUser() valida o JWT no servidor — é ele que autoriza a resposta.
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  // getSession() aqui NÃO autentica (o getUser acima já autenticou): serve só
  // para extrair o token que o cookie httpOnly guarda.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return fail("unauthenticated", "Sessão sem token.", 401, { requestId });
  }

  return ok(
    { access_token: session.access_token, expires_at: session.expires_at ?? null },
    { requestId },
  );
}
