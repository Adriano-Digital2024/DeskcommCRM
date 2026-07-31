/**
 * Adapter that exposes `ai-response-worker` to the event_log dispatcher.
 *
 * ⚠️ DESATIVADO em 2026-08-02: este handler NÃO está mais registrado em
 * `lib/event-log/register-handlers.ts`. A Fase 0 respondia a `message.received`
 * enquanto o runtime canônico (daemon agent-worker → `ai_agent.dispatch_requested`
 * → inbound_turn) responde o MESMO inbound, gerando DUPLA resposta e duplo custo
 * de LLM. O arquivo permanece como referência (pipeline + testes que o importam
 * diretamente, ex.: tests/unit/ai-response-bot-veto.test.ts).
 *
 * Kept separate from the worker pipeline file so unit tests can import the
 * pipeline (`processMessageReceived`) without pulling in the dispatcher
 * registry, and so the handler key (the source-of-truth string written into
 * `event_log.consumed_by[]`) lives in one obvious place.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { processMessageReceived } from "@/workers/ai-response-worker";

export const AI_RESPONSE_HANDLER_KEY = "ai-response-worker.v1";

export const aiResponseHandler: EventHandler = {
  key: AI_RESPONSE_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const result = await processMessageReceived(row);
    if (result.status === "sent_to_dispatch") {
      return { consumer_key: AI_RESPONSE_HANDLER_KEY, status: "ok", detail: result.outbound_message_id };
    }
    if (result.status === "skipped") {
      return {
        consumer_key: AI_RESPONSE_HANDLER_KEY,
        status: "skipped",
        detail: result.reason,
      };
    }
    return { consumer_key: AI_RESPONSE_HANDLER_KEY, status: "error", detail: result.detail };
  },
};
