/**
 * Pings síncronos para validar API keys BYO de provedores LLM.
 *
 * Uso:
 *   const result = await validateProviderKey("anthropic", apiKey);
 *   if (result.ok) → grava `validated_at = now()`, `models_available = result.models`
 *   else → grava `validation_error = result.error`
 *
 * Timeout 5s, sem retry. Erros 401 são distintos de erros de rede.
 */

export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "agentrouter";

export interface ValidationOk {
  ok: true;
  models: string[];
}

export interface ValidationFail {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

const TIMEOUT_MS = 5000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function validateAnthropicKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateGoogleKey(apiKey: string): Promise<ValidationResult> {
  // Google Generative Language API — listModels com api key em query string é o
  // único endpoint público de discovery. A key permanece server-side, nunca
  // chega ao browser, e este request não é logado pelo nosso edge.
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey,
    )}`;
    const res = await timedFetch(url, { method: "GET" });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { models?: { name?: string }[] };
    const models = (json.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

/**
 * AgentRouter é um gateway OpenAI-compatible voltado a ferramentas de coding
 * (Claude Code/Codex/Cline) que NUNCA chamam `/v1/models` antes de conversar. A
 * rota de discovery pode responder 401 mesmo com chave válida (ou nem existir
 * em certos deployments). Por isso a validação tem dois passos:
 *
 *   1. `GET /v1/models` (barato, zero custo) — devolve a lista real quando a
 *      rota existe e aceita a chave.
 *   2. Fallback `POST /v1/chat/completions` (max_tokens 1) — a MESMA rota que o
 *      runtime usa (`lib/agent-engine/edge/llm/providers.ts` → createOpenAI com
 *      baseURL `https://agentrouter.org/v1`). Prova que a chave realmente executa.
 *
 * Só 401/403 são `auth_failed_401`. Falha de rede/rota/modelo mantém códigos
 * específicos (provider_status_*, AbortError, etc.) — o UI distingue "chave
 * inválida" de "gateway indisponível".
 */
const AGENTROUTER_ENDPOINT = "https://agentrouter.org/v1";
/** Modelos OpenAI-compatible do AgentRouter (docs oficiais) — ordem de preferência. */
const AGENTROUTER_PROBE_MODELS = ["gpt-5.5", "glm-5.2"];

export async function validateAgentRouterKey(apiKey: string): Promise<ValidationResult> {
  const listed = await agentRouterListModels(apiKey);
  if (listed.ok) return listed;
  if (listed.error !== "auth_failed_401" && !listed.error.startsWith("provider_status_404")) {
    return listed;
  }
  return agentRouterProbeChat(apiKey);
}

async function agentRouterListModels(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch(`${AGENTROUTER_ENDPOINT}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    if (models.length === 0) {
      return { ok: false, error: "provider_status_200_empty" };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

async function agentRouterProbeChat(apiKey: string): Promise<ValidationResult> {
  for (const model of AGENTROUTER_PROBE_MODELS) {
    try {
      const res = await timedFetch(`${AGENTROUTER_ENDPOINT}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "auth_failed_401" };
      }
      if (res.ok) {
        const rest = AGENTROUTER_PROBE_MODELS.filter((m) => m !== model);
        return { ok: true, models: [model, ...rest] };
      }
      if (res.status === 404) continue;
      return { ok: false, error: `provider_status_${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.name : "network_error" };
    }
  }
  return { ok: false, error: "provider_status_404" };
}

export function validateProviderKey(
  provider: Provider,
  apiKey: string,
): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic":
      return validateAnthropicKey(apiKey);
    case "openai":
      return validateOpenAIKey(apiKey);
    case "google":
      return validateGoogleKey(apiKey);
    case "openrouter":
      return validateOpenRouterKey(apiKey);
    case "agentrouter":
      return validateAgentRouterKey(apiKey);
    default: {
      const exhaustive: never = provider;
      return Promise.resolve({ ok: false, error: `unknown_provider:${exhaustive}` });
    }
  }
}
