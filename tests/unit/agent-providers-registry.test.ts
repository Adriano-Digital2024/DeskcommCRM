import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os providers do lançamento (BYOK + fallback de plataforma)", () => {
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual([
      "agentrouter",
      "anthropic",
      "google",
      "openai",
      "openrouter",
    ]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    expect(() => reg.openrouter!("k", "gpt-5")).not.toThrow();
    expect(() => reg.agentrouter!("k", "claude-opus-4-6")).not.toThrow();
  });
});
