import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { MetaCloudClient } from "@/lib/meta/client";
import { isChannelStatus } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, provider, waha_session_name, display_name, phone_number, status, meta_phone_number_id, meta_waba_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  if (session.provider === "meta_cloud") {
    return checkMetaSession(await supabase, session, requestId);
  }

  return checkWahaSession(await supabase, session, requestId);
}

async function checkMetaSession(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: {
    id: string; provider: string; waha_session_name?: string; display_name?: string | null;
    phone_number?: string | null; status: string; meta_phone_number_id?: string | null; meta_waba_id?: string | null;
  },
  requestId: string,
): Promise<Response> {
  const admin = createAdminClient();
  const { data: full } = await admin
    .from("channel_sessions")
    .select("meta_access_token_encrypted")
    .eq("id", session.id)
    .maybeSingle();

  let liveStatus = session.status;
  let phoneNumber = session.phone_number as string | null;
  let metaValid = false;

  if (full?.meta_access_token_encrypted && session.meta_phone_number_id) {
    const { data: token } = await admin.rpc("fn_decrypt_meta_token", {
      p_ciphertext: full.meta_access_token_encrypted,
      p_encryption_key: env.WAHA_BYO_ENCRYPTION_KEY,
    }) as { data: string | null };

    if (token) {
      const client = new MetaCloudClient(session.meta_phone_number_id, token as string);
      try {
        metaValid = await client.verifyToken();
        if (metaValid) {
          liveStatus = "WORKING";
          const phoneInfo = await fetch(
            `https://graph.facebook.com/v22.0/${session.meta_phone_number_id}?fields=display_phone_number`,
            { headers: { Authorization: `Bearer ${token}` } },
          ).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => ({} as Record<string, unknown>));
          const displayPhone = phoneInfo.display_phone_number as string | undefined;
          if (displayPhone) phoneNumber = displayPhone;
        } else {
          liveStatus = "FAILED";
        }
      } catch {
        liveStatus = "FAILED";
      }
    } else {
      liveStatus = "FAILED";
    }
  }

  const patch: Record<string, unknown> = { last_health_check_at: new Date().toISOString() };
  if (liveStatus !== session.status && isChannelStatus(liveStatus)) {
    patch.status = liveStatus;
    patch.last_status_change_at = new Date().toISOString();
  }
  if (phoneNumber && phoneNumber !== session.phone_number) patch.phone_number = phoneNumber;
  await supabase.from("channel_sessions").update(patch).eq("id", session.id);

  return ok({
    id: session.id,
    provider: session.provider,
    display_name: session.display_name,
    phone_number: phoneNumber,
    status: liveStatus,
    meta_phone_number_id: session.meta_phone_number_id,
    meta_waba_id: session.meta_waba_id,
    meta_configured: metaValid,
    last_health_check_at: patch.last_health_check_at,
  }, { requestId });
}

async function checkWahaSession(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: {
    id: string; provider: string; waha_session_name?: string; display_name?: string | null;
    phone_number?: string | null; status: string; meta_phone_number_id?: string | null; meta_waba_id?: string | null;
  },
  requestId: string,
): Promise<Response> {
  const waha = getWahaClient();
  if (!waha) {
    return ok({
      ...session,
      waha_configured: false,
    }, { requestId });
  }

  let liveStatus = session.status;
  let phoneNumber = session.phone_number as string | null;
  try {
    const remote = await waha.getSessionQr(session.waha_session_name!) as {
      status?: string;
      me?: { id?: string; pushName?: string };
    };
    if (remote.status) liveStatus = remote.status;
    const jid = remote.me?.id;
    if (jid && !phoneNumber) phoneNumber = jid.replace(/@.*/, "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("404")) liveStatus = "STOPPED";
  }

  const patch: Record<string, unknown> = { last_health_check_at: new Date().toISOString() };
  if (isChannelStatus(liveStatus) && liveStatus !== session.status) {
    patch.status = liveStatus;
    patch.last_status_change_at = new Date().toISOString();
  }
  if (phoneNumber && phoneNumber !== session.phone_number) patch.phone_number = phoneNumber;
  await supabase.from("channel_sessions").update(patch).eq("id", session.id);

  return ok({
    id: session.id,
    provider: session.provider,
    waha_session_name: session.waha_session_name,
    display_name: session.display_name,
    phone_number: phoneNumber,
    status: liveStatus,
    last_health_check_at: patch.last_health_check_at,
    waha_configured: true,
  }, { requestId });
}
