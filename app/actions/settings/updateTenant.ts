"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { tenantSchema, type TenantInput } from "@/lib/schemas/settings";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

export type UpdateTenantResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

export async function updateTenant(input: TenantInput): Promise<UpdateTenantResult> {
  const parsed = tenantSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }

  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Read current settings jsonb to merge `lost_reasons_extra` non-destructively.
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings, status")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (orgRow?.status === "suspended") {
    return { ok: false, error: "forbidden_tenant" };
  }

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const nextSettings = {
    ...currentSettings,
    lost_reasons_extra: parsed.data.lost_reasons_extra,
  };

  // organizations só tem policy de escrita para platform-admin; o tenant admin
  // grava via admin client com filtro de org vindo do JWT (fonte confiável) —
  // mesmo padrão do finishOnboarding. RLS continua blindando os demais caminhos.
  const admin = createAdminClient();
  const { error } = await admin
    .from("organizations")
    .update({
      display_name: parsed.data.display_name,
      legal_name: parsed.data.legal_name,
      cnpj: parsed.data.cnpj ?? null,
      timezone: parsed.data.timezone,
      locale: parsed.data.locale,
      media_retention_days: parsed.data.media_retention_days,
      dpo_email: parsed.data.dpo_email ?? null,
      privacy_policy_url: parsed.data.privacy_policy_url ?? null,
      settings: nextSettings,
    })
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: error.message };

  await audit({
    action: "org.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: {
      fields_changed: Object.keys(parsed.data),
    },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "org.updated",
      p_entity_kind: "organization",
      p_entity_id: activeOrg.orgId,
      p_payload: { organization_id: activeOrg.orgId },
      p_metadata: { request_id: requestId },
      p_organization_id: activeOrg.orgId,
    })
    .then(({ error: e }) => {
      if (e) console.error("[updateTenant] emit_event failed", e.message);
    });

  revalidatePath("/app/settings/tenant");
  return { ok: true };
}
