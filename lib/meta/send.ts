/**
 * Helpers de envio para Meta Cloud API.
 * Análogo a lib/waha/send.ts para testes e usos ad-hoc.
 */
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { MetaCloudClient } from "./client";

export async function sendMetaMessage(
  phoneNumberId: string,
  to: string,
  text: string,
): ReturnType<MetaCloudClient["sendText"]> {
  const client = await getMetaClient(phoneNumberId);
  if (!client) throw new Error("meta_not_configured");
  return client.sendText(to, text);
}

export async function getMetaClient(phoneNumberId: string): Promise<MetaCloudClient | null> {
  const admin = createAdminClient();
  const { data: session } = await admin
    .from("channel_sessions")
    .select("meta_access_token_encrypted")
    .eq("meta_phone_number_id", phoneNumberId)
    .eq("provider", "meta_cloud")
    .maybeSingle();

  if (!session?.meta_access_token_encrypted) return null;

  const { data: token } = await admin.rpc("fn_decrypt_meta_token", {
    p_ciphertext: session.meta_access_token_encrypted,
    p_encryption_key: env.WAHA_BYO_ENCRYPTION_KEY,
  });

  if (!token) return null;
  return new MetaCloudClient(phoneNumberId, token as string);
}
