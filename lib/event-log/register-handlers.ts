/**
 * Centralised handler registration for the event_log dispatcher.
 *
 * Imported by the cron drain route (and the workers entry point) so a single
 * call wires every consumer. Keep it lightweight — no DB calls at import time.
 */

// NOTA: o ai-response-worker (Fase 0, legacy) foi DESREGISTRADO em 2026-08-02.
// Ele respondia a `message.received` enquanto o runtime canônico (daemon
// agent-worker, consumindo `ai_agent.dispatch_requested` → inbound_turn)
// responde o MESMO inbound → DUPLA resposta + duplo custo de LLM. O daemon
// cobre todos os fluxos do Fase 0 (agente publicado, router, fallback default).
// Os arquivos workers/ai-response-worker*.ts ficam como referência/QA.
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { ragIndexerHandler } from "@/workers/rag-indexer.handler";
import { lgpdExportHandler } from "@/workers/lgpd-export-worker.handler";
import { lgpdRedactHandler } from "@/workers/lgpd-redact-worker.handler";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { followupReactivityHandler } from "@/lib/followup/reactivity.handler";
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
import { mediaDeriveHandler } from "@/workers/media-derive-worker.handler";
import { registerHandler } from "@/lib/event-log/dispatcher";

let _registered = false;

export function ensureHandlersRegistered(): void {
  if (_registered) return;
  registerHandler(aiSentimentHandler);
  registerHandler(aiHandoffFromSentimentHandler);
  registerHandler(ragIndexerHandler);
  registerHandler(lgpdExportHandler);
  registerHandler(lgpdRedactHandler);
  registerHandler(automationRulesHandler);
  registerHandler(followupReactivityHandler);
  registerHandler(mediaPersistHandler);
  registerHandler(mediaDeriveHandler);
  _registered = true;
}
