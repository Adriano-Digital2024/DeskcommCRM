/**
 * Core handlers para messages (list + send).
 *
 * Reusados por:
 *  - POST /api/v1/messages (sendMessageHandler)
 *  - GET  /api/v1/conversations/[id]/messages (listMessagesHandler)
 *  - MCP tools (S-13.04)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { MetaCloudClient } from "@/lib/meta/client";
import type { ListMessagesQuery, SendMessageInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";
import { getWahaClient } from "@/lib/waha/client";
import { isMediaPathOwnedBy, wahaSendPlanFor } from "@/lib/waha/media-send";
import { parseWahaMessageId } from "@/lib/waha/message-id";
import { resolveWahaChatId } from "@/lib/waha/send";

type SB = SupabaseClient;

const MSG_COLS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, created_at";

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface MsgCursorPayload {
  sent_at: string;
  id: string;
}

function encodeMsgCursor(p: MsgCursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeMsgCursor(raw: string): MsgCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MsgCursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.sent_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ListMessagesResult {
  messages: Message[];
  cursor: string | null;
  has_more: boolean;
}

export async function listMessagesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
  q: ListMessagesQuery,
): Promise<ListMessagesResult> {
  let query = supabase
    .from("messages")
    .select(MSG_COLS)
    .eq("conversation_id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .order("sent_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(q.limit + 1);

  if (q.cursor) {
    const c = decodeMsgCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    query = query.or(`sent_at.gt.${c.sent_at},and(sent_at.eq.${c.sent_at},id.gt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = (data ?? []) as unknown as Message[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last ? encodeMsgCursor({ sent_at: last.sent_at, id: last.id }) : null;

  return { messages: page, cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

interface SendMessageConvJoined {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  is_group: boolean;
  group_chat_id: string | null;
  contacts: { phone_number: string | null; wa_identity: string | null; is_blocked: boolean } | null;
  channel_sessions: { waha_session_name: string | null; status: string; provider: string; meta_phone_number_id: string | null; meta_waba_id: string | null } | null;
}

function previewFrom(input: {
  body?: string;
  media_url?: string;
  media_storage_path?: string;
  type?: string;
}): string {
  if (input.body) return input.body.slice(0, 280);
  if (input.media_url || input.media_storage_path) return `[${input.type ?? "media"}]`;
  return "";
}

export async function sendMessageHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: SendMessageInput,
): Promise<Message> {
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, contacts:contact_id(phone_number, wa_identity, is_blocked), channel_sessions:channel_session_id(waha_session_name, status, provider, meta_phone_number_id, meta_waba_id)",
    )
    .eq("id", input.conversation_id)
    .maybeSingle();

  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr.message);
  }
  if (!conv) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }

  const c = conv as unknown as SendMessageConvJoined;

  if (c.contacts?.is_blocked) {
    throw new ApiError(
      403,
      "forbidden",
      undefined,
      ctx.requestId,
      "Contato bloqueou o atendimento.",
    );
  }

  if (input.media_storage_path && !isMediaPathOwnedBy(input.media_storage_path, c.organization_id, c.id)) {
    throw new ApiError(
      422,
      "invalid_media_path",
      undefined,
      ctx.requestId,
      "media_storage_path fora da conversa.",
    );
  }

  const now = new Date().toISOString();
  const insertRow = {
    organization_id: c.organization_id,
    conversation_id: c.id,
    channel_session_id: c.channel_session_id,
    contact_id: c.contact_id,
    type: input.type,
    direction: "outbound" as const,
    status: "queued",
    body: input.body ?? null,
    media_url: input.media_url ?? null,
    media_mime: input.media_mime ?? null,
    media_storage_path: input.media_storage_path ?? null,
    media_size_bytes: input.media_size_bytes ?? null,
    sent_via: ctx.actor.type !== "user" ? ("ai" as const) : ("user" as const),
    sent_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    sent_at: now,
    metadata: {
      ...(input.metadata ?? {}),
      ...(ctx.actor.type === "ai_agent" ? { ai_actor_id: ctx.actor.id } : {}),
    },
  };

  const { data: created, error: insErr } = await supabase
    .from("messages")
    .insert(insertRow)
    .select(MSG_COLS)
    .single();

  if (insErr || !created) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? "insert_failed",
    );
  }
  let message = created as unknown as Message;

  const provider = c.channel_sessions?.provider ?? "waha";

  if (provider === "meta_cloud") {
    await sendViaMeta(supabase, c, message, input, ctx.requestId);
  } else {
    await sendViaWaha(supabase, c, message, input);
  }

  // Atualiza `message` com o estado pós-envio
  const { data: refreshed } = await supabase
    .from("messages")
    .select(MSG_COLS)
    .eq("id", message.id)
    .maybeSingle();
  if (refreshed) message = refreshed as unknown as Message;

  await supabase
    .from("conversations")
    .update({
      last_outbound_at: now,
      last_message_at: now,
      last_message_preview: previewFrom({
        body: input.body,
        media_url: input.media_url,
        media_storage_path: input.media_storage_path,
        type: input.type,
      }),
    })
    .eq("id", c.id);

  const a = actorAuditPayload(ctx.actor);
  await audit({
    action: "message.sent",
    actorUserId: a.actorUserId,
    organizationId: c.organization_id,
    resourceType: "message",
    resourceId: message.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, status: message.status, type: message.type },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "message.sent",
      p_entity_kind: "message",
      p_entity_id: message.id,
      p_payload: { status: message.status, conversation_id: c.id },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: c.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[messages.send] emit_event failed", error.message);
    });

  return message;
}

async function sendViaMeta(
  supabase: SB,
  c: SendMessageConvJoined,
  message: Message,
  input: SendMessageInput,
  _requestId: string,
): Promise<void> {
  if (!c.channel_sessions?.meta_phone_number_id) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "meta_not_configured",
        error_message: "Meta Cloud API não configurado para esta sessão.",
      })
      .eq("id", message.id);
    return;
  }

  if (c.channel_sessions.status !== "WORKING") {
    await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: "channel_session_not_working" },
      })
      .eq("id", message.id);
    return;
  }

  const phoneNumber = c.contacts?.phone_number;
  if (!phoneNumber) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "missing_phone_number",
        error_message: "Contato sem telefone para envio WhatsApp.",
      })
      .eq("id", message.id);
    return;
  }

  const to = phoneNumber.replace(/\D/g, "");

  const admin = createAdminClient();
  const { data: session } = await admin
    .from("channel_sessions")
    .select("meta_access_token_encrypted")
    .eq("id", c.channel_session_id)
    .maybeSingle();

  const encryptedToken = session?.meta_access_token_encrypted;
  if (!encryptedToken) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "meta_token_missing",
        error_message: "Token de acesso Meta não encontrado. Reconecte a integração.",
      })
      .eq("id", message.id);
    return;
  }

  const { data: token } = await admin.rpc("fn_decrypt_meta_token", {
    p_ciphertext: encryptedToken,
    p_encryption_key: env.WAHA_BYO_ENCRYPTION_KEY,
  });

  if (!token) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "meta_token_decrypt_failed",
        error_message: "Token de acesso Meta inválido ou corrompido.",
      })
      .eq("id", message.id);
    return;
  }

  const client = new MetaCloudClient(c.channel_sessions.meta_phone_number_id, token as string);

  try {
    let metaRes: { message_id: string };
    if (input.media_storage_path) {
      const signedRes = await admin.storage
        .from("whatsapp-media")
        .createSignedUrl(input.media_storage_path, 600);
      if (!signedRes.data?.signedUrl) {
        throw new Error("storage_sign_failed");
      }
      const uploadRes = await client.uploadMedia(
        signedRes.data.signedUrl,
        input.media_mime ?? "application/octet-stream",
      );
      metaRes = await client.sendMedia(to, uploadRes.id, input.type, input.body ?? undefined);
    } else {
      metaRes = await client.sendText(to, input.body ?? "");
    }

    await supabase
      .from("messages")
      .update({ status: "sent", external_id: metaRes.message_id, ack: 1 })
      .eq("id", message.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "meta_unknown";
    const code = msg.startsWith("storage_sign_failed") ? "storage_sign_failed" : "meta_error";
    await supabase
      .from("messages")
      .update({ status: "failed", error_code: code, error_message: msg.slice(0, 300) })
      .eq("id", message.id);
  }
}

async function sendViaWaha(
  supabase: SB,
  c: SendMessageConvJoined,
  message: Message,
  input: SendMessageInput,
): Promise<void> {
  const waha = getWahaClient();
  const chatId = resolveWahaChatId({
    isGroup: c.is_group,
    groupChatId: c.group_chat_id,
    phoneNumber: c.contacts?.phone_number,
    waIdentity: c.contacts?.wa_identity,
  });

  if (!waha) {
    await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: "waha_not_configured" },
      })
      .eq("id", message.id);
  } else if (!chatId) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "missing_phone_number",
        error_message: "Contato sem telefone para envio WhatsApp.",
      })
      .eq("id", message.id);
  } else if (!c.channel_sessions || c.channel_sessions.status !== "WORKING") {
    await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: "channel_session_not_working" },
      })
      .eq("id", message.id);
  } else {
    try {
      let wahaRes: unknown;
      if (input.media_storage_path) {
        const admin = createAdminClient();
        const { data: signed, error: signErr } = await admin.storage
          .from("whatsapp-media")
          .createSignedUrl(input.media_storage_path, 600);
        if (signErr || !signed?.signedUrl) {
          throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
        }
        const filename = input.media_storage_path.split("/").pop() ?? undefined;
        wahaRes = await waha.sendMedia(
          c.channel_sessions.waha_session_name!,
          chatId,
          wahaSendPlanFor(input.type, {
            url: signed.signedUrl,
            mime: input.media_mime ?? "application/octet-stream",
            filename,
            caption: input.body ?? null,
          }),
        );
      } else {
        wahaRes = await waha.sendMessage(
          c.channel_sessions.waha_session_name!,
          chatId,
          input.body ?? "",
        );
      }
      const externalId = parseWahaMessageId(wahaRes);
      await supabase
        .from("messages")
        .update({ status: "sent", external_id: externalId, ack: 0 })
        .eq("id", message.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "waha_unknown";
      const code = msg.startsWith("storage_sign_failed") ? "storage_sign_failed" : "waha_error";
      await supabase
        .from("messages")
        .update({ status: "failed", error_code: code, error_message: msg.slice(0, 300) })
        .eq("id", message.id);
    }
  }
}
