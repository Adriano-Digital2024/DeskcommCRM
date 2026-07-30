import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MetaWebhookPayload, MetaCloudClient } from "./client";

export interface MetaSession {
  id: string;
  organization_id: string;
  status: string;
  meta_phone_number_id: string | null;
  meta_waba_id: string | null;
}

export interface MetaInboundMessage {
  from: string;             // wa_id do remetente
  messageId: string;        // id da mensagem no Meta
  timestamp: string;        // ISO string do timestamp do Meta
  type: string;             // text, image, video, audio, document, location, etc.
  body?: string;            // texto
  mediaId?: string;         // media_id (image/video/audio/document)
  mediaMime?: string;
  mediaFilename?: string;
  location?: { latitude: number; longitude: number };
  profileName: string;
}

export interface MetaStatusUpdate {
  messageId: string;
  status: string;           // sent, delivered, read, failed
  timestamp: string;
  recipientId: string;
  pricing?: { model: string; category: string };
}

/**
 * Verifica assinatura X-Hub-Signature-256.
 * Meta calcula HMAC-SHA256 do body bruto com o app_secret.
 */
export function verifyHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;

  const expectedSig = signatureHeader.slice(prefix.length);
  const computed = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

/**
 * Processa webhook verification GET do Meta.
 * Retorna o challenge como texto se verify_token bater.
 */
export function handleVerification(
  params: URLSearchParams,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false; reason: string } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe") {
    return { ok: false, reason: `unexpected_mode: ${mode}` };
  }

  if (token !== verifyToken) {
    return { ok: false, reason: "verify_token_mismatch" };
  }

  if (!challenge) {
    return { ok: false, reason: "missing_challenge" };
  }

  return { ok: true, challenge };
}

/**
 * Extrai mensagens inbound do payload do webhook Meta.
 */
export function extractInboundMessages(payload: MetaWebhookPayload): MetaInboundMessage[] {
  const messages: MetaInboundMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value.messages) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      const profileName = value.contacts?.[0]?.profile?.name ?? "Unknown";

      for (const msg of value.messages) {
        const inbound: MetaInboundMessage = {
          from: msg.from,
          messageId: msg.id,
          timestamp: msg.timestamp,
          type: msg.type,
          profileName,
        };

        switch (msg.type) {
          case "text":
            inbound.body = msg.text?.body;
            break;
          case "image":
            inbound.mediaId = msg.image?.id;
            inbound.mediaMime = msg.image?.mime_type;
            break;
          case "video":
            inbound.mediaId = msg.video?.id;
            inbound.mediaMime = msg.video?.mime_type;
            break;
          case "audio":
            inbound.mediaId = msg.audio?.id;
            inbound.mediaMime = msg.audio?.mime_type;
            break;
          case "document":
            inbound.mediaId = msg.document?.id;
            inbound.mediaMime = msg.document?.mime_type;
            inbound.mediaFilename = msg.document?.filename;
            break;
          case "sticker":
            inbound.mediaId = msg.sticker?.id;
            inbound.mediaMime = msg.sticker?.mime_type;
            break;
          case "location":
            inbound.location = msg.location;
            break;
          case "button":
            inbound.body = msg.button?.text;
            break;
          case "interactive":
            if (msg.interactive?.button_reply) {
              inbound.body = msg.interactive.button_reply.title;
            }
            break;
        }

        messages.push(inbound);
      }
    }
  }

  return messages;
}

/**
 * Extrai status updates (sent, delivered, read, failed) do payload do webhook.
 */
export function extractStatusUpdates(payload: MetaWebhookPayload): MetaStatusUpdate[] {
  const updates: MetaStatusUpdate[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const statuses = change.value?.statuses;
      if (!statuses) continue;

      for (const st of statuses) {
        updates.push({
          messageId: st.id,
          status: st.status,
          timestamp: st.timestamp,
          recipientId: st.recipient_id,
          pricing: st.pricing ? { model: st.pricing.model, category: st.pricing.category } : undefined,
        });
      }
    }
  }

  return updates;
}

/**
 * Extrai o phone_number_id do payload do webhook Meta.
 */
export function extractPhoneNumberId(payload: MetaWebhookPayload): string | null {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      if (phoneNumberId) return phoneNumberId;
    }
  }
  return null;
}

/**
 * Resolve a channel_session pelo phone_number_id.
 */
export async function resolveSessionByPhoneNumber(
  admin: SupabaseClient,
  phoneNumberId: string,
): Promise<MetaSession | null> {
  const { data, error } = await admin
    .rpc("fn_channel_session_by_meta_phone", { p_phone_number_id: phoneNumberId })
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as MetaSession;
}

/**
 * Processa mensagem inbound do Meta Cloud API:
 * - Upsert contact
 * - Upsert conversation
 * - Insert message (idempotente)
 * - STOP detection
 */
export async function handleMetaInbound(
  admin: SupabaseClient,
  session: MetaSession,
  msg: MetaInboundMessage,
  requestId: string,
): Promise<void> {
  const orgId = session.organization_id;

  const waIdentity = `phone:${msg.from}`;

  const { data: contact, error: contactErr } = await admin.rpc("fn_upsert_wa_contact", {
    p_organization_id: orgId,
    p_wa_identity: waIdentity,
    p_name: msg.profileName,
    p_phone_number: msg.from,
  });

  if (contactErr || !contact) {
    return;
  }

  const contactId = typeof contact === "object" ? (contact as { id: string }).id : String(contact);

  const { data: conversation } = await admin.rpc("fn_upsert_wa_conversation", {
    p_organization_id: orgId,
    p_contact_id: contactId,
    p_channel_session_id: session.id,
    p_is_group: false,
    p_group_chat_id: null,
  });

  const conversationId = conversation
    ? (typeof conversation === "object" ? (conversation as { id: string }).id : String(conversation))
    : null;

  if (!conversationId) return;

  const messageType = msg.type === "text" ? "text" : msg.type;

  const { error: msgErr } = await admin.from("messages").insert({
    organization_id: orgId,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contactId,
    external_id: msg.messageId,
    type: messageType,
    direction: "inbound",
    status: "received",
    body: msg.body ?? null,
    ack: 1,
    sent_at: new Date(Number(msg.timestamp) * 1000).toISOString(),
    metadata: { provider: "meta_cloud", request_id: requestId },
  });

  if (msgErr && msgErr.code !== "23505") {
    return;
  }

  await admin.from("conversations").update({
    last_message_at: new Date().toISOString(),
    last_message_preview: msg.body ?? `[${messageType}]`,
    unread_count_for_assignee: 0,
  }).eq("id", conversationId);

  if (msg.body && /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i.test(msg.body)) {
    await admin.from("contacts").update({
      is_blocked: true,
      blocked_reason: "opt_out_via_meta",
      blocked_at: new Date().toISOString(),
    }).eq("id", contactId);
  }

  await admin.rpc("emit_event", {
    p_event_type: "ai_agent.dispatch_requested",
    p_entity_kind: "conversation",
    p_entity_id: conversationId,
    p_payload: { provider: "meta_cloud", message_id: msg.messageId },
    p_metadata: { request_id: requestId, channel_session_id: session.id },
    p_organization_id: orgId,
  }).then(({ error }) => {
    if (error) console.error("[meta.ingest] emit_event failed", error.message);
  });
}

/**
 * Processa status update do Meta Cloud API.
 */
export async function handleMetaStatus(
  admin: SupabaseClient,
  _session: MetaSession,
  status: MetaStatusUpdate,
  _requestId: string,
): Promise<void> {
  const updateFields: Record<string, unknown> = {};

  switch (status.status) {
    case "sent":
      updateFields.ack = 1;
      updateFields.status = "sent";
      break;
    case "delivered":
      updateFields.ack = 2;
      updateFields.status = "delivered";
      updateFields.delivered_at = new Date(Number(status.timestamp) * 1000).toISOString();
      break;
    case "read":
      updateFields.ack = 3;
      updateFields.status = "read";
      updateFields.read_at = new Date(Number(status.timestamp) * 1000).toISOString();
      break;
    case "failed":
      updateFields.status = "failed";
      break;
  }

  if (Object.keys(updateFields).length === 0) return;

  await admin
    .from("messages")
    .update(updateFields)
    .eq("external_id", status.messageId);
}

/**
 * Dispatch central do webhook Meta.
 */
export async function dispatchMetaEvent(
  admin: SupabaseClient,
  session: MetaSession,
  rawBody: string,
  requestId: string,
): Promise<void> {
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return;
  }

  const inboundMessages = extractInboundMessages(payload);
  for (const msg of inboundMessages) {
    await handleMetaInbound(admin, session, msg, requestId);
  }

  const statusUpdates = extractStatusUpdates(payload);
  for (const st of statusUpdates) {
    await handleMetaStatus(admin, session, st, requestId);
  }
}
