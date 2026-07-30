/**
 * GET  /api/v1/webhooks/meta — verificação do webhook (Meta envia no setup)
 * POST /api/v1/webhooks/meta — recebimento de mensagens/status do Meta Cloud API
 *
 * Meta Cloud API webhooks são centralizados (um único URL por app). A resolução
 * da channel_session é feita pelo phone_number_id presente no payload.
 *
 * Verification: GET com params hub.mode, hub.verify_token, hub.challenge
 * Payload: POST com X-Hub-Signature-256 HMAC SHA256 do body com META_APP_SECRET
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import {
  dispatchMetaEvent,
  extractPhoneNumberId,
  handleVerification,
  resolveSessionByPhoneNumber,
  verifyHubSignature,
} from "@/lib/meta/ingest";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const params = new URL(req.url).searchParams;
  const verifyToken = env.META_WEBHOOK_VERIFY_TOKEN;

  if (!verifyToken) {
    return new Response("Meta webhook verify token not configured", { status: 503 });
  }

  const result = handleVerification(params, verifyToken);

  if (!result.ok) {
    return new Response(result.reason, { status: 403 });
  }

  return new Response(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const rawBody = await req.text();

  const appSecret = env.META_APP_SECRET;
  const sigHeader = req.headers.get("X-Hub-Signature-256");

  if (appSecret && sigHeader) {
    const valid = verifyHubSignature(rawBody, sigHeader, appSecret);
    if (!valid) {
      return fail("unauthenticated", "invalid X-Hub-Signature-256", 401, { requestId });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const phoneNumberId = extractPhoneNumberId(payload as unknown as Parameters<typeof extractPhoneNumberId>[0]);
  if (!phoneNumberId) {
    return ok({ accepted: true, reason: "no_phone_number_id" }, { requestId });
  }

  const admin = createAdminClient();
  const session = await resolveSessionByPhoneNumber(admin, phoneNumberId);

  if (!session) {
    return ok({ accepted: true, reason: "unknown_phone" }, { requestId });
  }

  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "meta_cloud",
    http_method: "POST",
    raw_body: rawBody,
    payload_parsed: payload as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    event_type: "meta_webhook",
    status: "received",
    valid_signature: !appSecret || !!sigHeader,
    attempts: 0,
  });

  try {
    await dispatchMetaEvent(admin, session, rawBody, requestId);
  } catch (err) {
    console.error("[meta.webhook] dispatch failed", err);
  }

  return ok({ accepted: true }, { requestId });
}
