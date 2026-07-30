import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { MetaCloudClient } from "@/lib/meta/client";
import { createChannelSchema, CHANNEL_COLUMNS } from "@/lib/schemas/channels";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("channel_sessions")
    .select(CHANNEL_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { provider, display_name } = parsed.data;

  if (provider === "meta_cloud") {
    return createMetaSession(req, parsed.data, activeOrg, user, requestId);
  }

  return createWahaSession(activeOrg, user, requestId, display_name);
}

async function createMetaSession(
  _req: NextRequest,
  input: { display_name?: string; meta_phone_number_id?: string; meta_waba_id?: string; meta_access_token?: string },
  activeOrg: { orgId: string },
  user: { id: string },
  requestId: string,
): Promise<Response> {
  const { display_name, meta_phone_number_id, meta_waba_id, meta_access_token } = input;

  if (!meta_phone_number_id || !meta_waba_id || !meta_access_token) {
    return fail(
      "validation_failed",
      "Meta Cloud API requer meta_phone_number_id, meta_waba_id e meta_access_token.",
      422,
      { requestId },
    );
  }

  const client = new MetaCloudClient(meta_phone_number_id, meta_access_token);
  const valid = await client.verifyToken();
  if (!valid) {
    return fail(
      "meta_error",
      "Token de acesso Meta inválido. Verifique as credenciais e tente novamente.",
      502,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const encryptionKey = env.WAHA_BYO_ENCRYPTION_KEY;

  const { data: encrypted } = await admin.rpc("fn_encrypt_meta_token", {
    p_plaintext: meta_access_token,
    p_encryption_key: encryptionKey,
  });

  const { data: created, error: insErr } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: activeOrg.orgId,
      provider: "meta_cloud",
      engine: "META_CLOUD",
      display_name: display_name ?? null,
      status: "WORKING",
      phone_number: null,
      meta_phone_number_id,
      meta_waba_id,
      meta_access_token_encrypted: encrypted as unknown as string,
      status_reason: null,
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      last_status_change_at: new Date().toISOString(),
      metadata: { connected_via: "meta_cloud_api" },
    })
    .select(CHANNEL_COLUMNS)
    .single();

  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "insert_failed", 500, { requestId });
  }

  void audit({
    action: "channel.connected",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: created.id,
    requestId,
    metadata: { provider: "meta_cloud", meta_phone_number_id, meta_waba_id },
  });

  return ok(created, { requestId, status: 201 });
}

async function createWahaSession(
  activeOrg: { orgId: string },
  user: { id: string },
  requestId: string,
  displayName?: string,
): Promise<Response> {
  const waha = getWahaClient();
  if (!waha) {
    return fail(
      "waha_not_configured",
      "O serviço do WhatsApp (WAHA) não está ativo. Suba o container e tente de novo.",
      503,
      { requestId },
    );
  }

  const supabase = await createServerClient();
  const sessionName = `org_${activeOrg.orgId.slice(0, 8)}_${randomUUID().replace(/-/g, "").slice(0, 6)}`;

  const { data: created, error: insErr } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: activeOrg.orgId,
      provider: "waha",
      waha_session_name: sessionName,
      display_name: displayName ?? null,
      engine: "NOWEB",
      webhook_path_token: randomUUID().replace(/-/g, ""),
      webhook_secret_encrypted: Buffer.from([0]),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      metadata: {},
    })
    .select(CHANNEL_COLUMNS)
    .single();

  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "channel_session_insert_failed", 500, { requestId });
  }

  try {
    await waha.startSession(sessionName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await supabase
      .from("channel_sessions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("id", created.id);
    return fail("waha_error", wahaFriendlyError(msg), 502, { requestId });
  }

  void audit({
    action: "channel.connected",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: created.id,
    requestId,
    metadata: { waha_session_name: sessionName, provider: "waha" },
  });

  return ok(created, { requestId, status: 201 });
}
