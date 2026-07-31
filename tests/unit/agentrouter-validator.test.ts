import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateAgentRouterKey } from "@/lib/ai/provider-validators";

const MODELS_URL = "https://agentrouter.org/v1/models";
const CHAT_URL = "https://agentrouter.org/v1/chat/completions";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("validateAgentRouterKey", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("valida pela rota de discovery quando ela aceita a chave (zero custo)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "gpt-5.5" },
          { id: "glm-5.2" },
          { id: "claude-opus-4-6" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-valid");

    expect(result).toEqual({
      ok: true,
      models: ["gpt-5.5", "glm-5.2", "claude-opus-4-6"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      MODELS_URL,
      expect.objectContaining({ headers: { Authorization: "Bearer ak-valid" } }),
    );
  });

  it("cai pro probe de chat (rota que o runtime usa) quando /models rejeita a chave", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ping" } }] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-valid");

    expect(result).toEqual({ ok: true, models: ["gpt-5.5", "glm-5.2"] });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      CHAT_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer ak-valid" }),
      }),
    );
    const [, init] = fetchMock.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });

  it("auth_failed_401 quando /models e o probe de chat rejeitam", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-invalida");

    expect(result).toEqual({ ok: false, error: "auth_failed_401" });
  });

  it("tenta modelos de probe em ordem quando o primeiro não existe", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-valid");

    expect(result).toEqual({ ok: false, error: "provider_status_404" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("propaga status de erro do gateway sem cair no probe de chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-valid");

    expect(result).toEqual({ ok: false, error: "provider_status_500" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marca erro de rede como network_error (não confunde com auth)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateAgentRouterKey("ak-valid");

    expect(result).toEqual({ ok: false, error: "TypeError" });
  });
});
