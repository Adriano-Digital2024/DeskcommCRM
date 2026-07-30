/**
 * POST /api/v1/channel-sessions/[id]/reconnect — reconecta um canal caído.
 *
 * WAHA: stop + start no WAHA (start é idempotente). Se o WhatsApp foi
 * deslogado do celular, o WAHA volta para SCAN_QR_CODE e o usuário reescaneia.
 *
 * Meta Cloud: verifica o token de acesso e atualiza o status para WORKING
 * se válido, ou FAILED se expirado/inválido. Aceita opcionalmente um novo
 * token no body (meta_access_token) para atualizar credenciais expiradas.
 *
 * Admin only. organization_id vem da sessão — nunca do path/body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { MetaCloudClient } from "@/lib/meta/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, provider, waha_session_name, meta_phone_number_id, meta_waba_id, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  if (session.provider === "meta_cloud") {
    return reconnectMeta(supabase, req, session, activeOrg, user, id, requestId);
  }

  return reconnectWaha(supabase, session, activeOrg, user, id, requestId);
}

async function reconnectMeta(
  supabase: Awaited<ReturnType<typeof createClient>>,
  req: NextRequest,
  session: {
    id: string; provider: string; waha_session_name?: string | null;
    meta_phone_number_id?: string | null; meta_waba_id?: string | null; status: string;
  },
  activeOrg: { orgId: string },
  user: { id: string },
  id: string,
  requestId: string,
): Promise<Response> {
  if (!session.meta_phone_number_id) {
    return ok({
      id,
      provider: "meta_cloud",
      status: "FAILED",
      reason: "meta_phone_number_id não configurado. Reconfigure a integração.",
    }, { requestId });
  }

  let body: { meta_access_token?: string } = {};
  try {
    body = await req.json();
  } catch {}

  const admin = createAdminClient();
  let accessToken: string | null = null;

  if (body.meta_access_token) {
    accessToken = body.meta_access_token;
  } else {
    const { data: full } = await admin
      .from("channel_sessions")
      .select("meta_access_token_encrypted")
      .eq("id", id)
      .maybeSingle();

    if (full?.meta_access_token_encrypted) {
      const { data: token } = await admin.rpc("fn_decrypt_meta_token", {
        p_ciphertext: full.meta_access_token_encrypted,
        p_encryption_key: env.WAHA_BYO_ENCRYPTION_KEY,
      });
      accessToken = token as string | null;
    }
  }

  if (!accessToken) {
    return ok({
      id,
      provider: "meta_cloud",
      status: "FAILED",
      reason: "Token de acesso Meta não encontrado ou corrompido. Reconfigure a integração com um novo token.",
    }, { requestId });
  }

  const client = new MetaCloudClient(session.meta_phone_number_id, accessToken);
  const tokenValid = await client.verifyToken();

  const updateData: Record<string, unknown> = {
    last_health_check_at: new Date().toISOString(),
  };

  if (tokenValid) {
    updateData.status = "WORKING";
    updateData.status_reason = null;
    updateData.consecutive_health_fails = 0;
    updateData.last_status_change_at = new Date().toISOString();

    if (body.meta_access_token) {
      const { data: encrypted } = await admin.rpc("fn_encrypt_meta_token", {
        p_plaintext: body.meta_access_token,
        p_encryption_key: env.WAHA_BYO_ENCRYPTION_KEY,
      });
      if (encrypted) {
        updateData.meta_access_token_encrypted = encrypted;
      }
    }
  } else {
    updateData.status = "FAILED";
    updateData.status_reason = "Token de acesso Meta expirado ou inválido. Gere um novo token no Meta Developer Portal e reconecte.";
    updateData.last_status_change_at = new Date().toISOString();
  }

  await supabase
    .from("channel_sessions")
    .update(updateData)
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id);

  void audit({
    action: "channel.reconnected",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { provider: "meta_cloud", meta_phone_number_id: session.meta_phone_number_id, token_valid: tokenValid },
  });

  return ok({
    id,
    provider: "meta_cloud",
    status: tokenValid ? "WORKING" : "FAILED",
    reason: tokenValid ? null : "Token de acesso Meta expirado ou inválido. Para reconectar: gere um novo token de acesso permanente no Meta Developer Portal (WhatsApp > Configurações da API > Gerar Token) e cole-o no campo abaixo.",
  }, { requestId });
}

async function reconnectWaha(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: {
    id: string; provider: string; waha_session_name?: string | null;
    meta_phone_number_id?: string | null; status: string;
  },
  activeOrg: { orgId: string },
  user: { id: string },
  id: string,
  requestId: string,
): Promise<Response> {
  if (!session.waha_session_name) {
    return fail(
      "waha_not_configured",
      "Sessão WAHA não configurada. Crie um novo canal do WhatsApp.",
      502,
      { requestId },
    );
  }

  const waha = getWahaClient();
  if (!waha) {
    return fail(
      "waha_not_configured",
      "O serviço do WhatsApp (WAHA) não está ativo. Verifique se o container está rodando e tente de novo.",
      503,
      { requestId },
    );
  }

  try {
    await waha.stopSession(session.waha_session_name);
    const remote = (await waha.startSession(session.waha_session_name)) as { status?: string };
    const nextStatus = remote.status ?? "STARTING";
    await supabase
      .from("channel_sessions")
      .update({
        status: "STARTING",
        last_status_change_at: new Date().toISOString(),
        consecutive_health_fails: 0,
      })
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);

    void audit({
      action: "channel.reconnected",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { waha_session_name: session.waha_session_name, provider: "waha" },
    });

    return ok({ id, status: nextStatus, provider: "waha" }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return fail("waha_error", wahaFriendlyError(msg), 502, { requestId });
  }
}
