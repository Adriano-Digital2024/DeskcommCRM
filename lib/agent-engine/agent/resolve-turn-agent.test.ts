import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from './resolve-turn-agent';
import type { PublishedAgentConfig } from './agent-config';
import type { LoadedRouter } from './router-config';

/** Config mínima válida — só o agentId importa pros testes (identidade). */
function fakeConfig(agentId: string): PublishedAgentConfig {
  return {
    agentId,
    versionId: `v-${agentId}`,
    agentName: agentId,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    toolIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    versionCreatedBy: null,
    agentCreatedBy: null,
  };
}

const members = [
  { agentId: 'agent-vendas', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
  { agentId: 'agent-suporte', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
];

function router(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members,
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
};

function makeDeps(overrides: {
  loadActiveRouter?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfigById?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfig?: ReturnType<typeof vi.fn>;
  classifyIntent?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: overrides.loadActiveRouter ?? vi.fn(),
    loadPublishedAgentConfigById: overrides.loadPublishedAgentConfigById ?? vi.fn(),
    loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),
    classifyIntent: overrides.classifyIntent ?? vi.fn(),
  } as never;
}

describe('resolveTurnAgent', () => {
  it('1. canal sem router → no_router, usa loadPublishedAgentConfig por sessão', async () => {
    const loadActiveRouter = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const classifyIntent = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig, classifyIntent }));
    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-sessao');
    expect(out.routerId).toBeNull();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('2. router + classificação alta confiança → classified, config do agente da intenção', async () => {
    const r = router({ sticky: false });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-vendas'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(out.intentName).toBe('vendas');
    expect(out.confidence).toBe(0.9);
  });

  it('3. sticky + mesma intenção → sticky, NÃO troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-vendas'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'mais uma pergunta sobre preço', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(loadPublishedAgentConfigById).toHaveBeenCalledWith({}, 'org-1', 'agent-vendas');
  });

  it('4. sticky + intenção diferente com confiança >= min → reclassified, troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-suporte'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'na verdade tenho um problema técnico', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
  });

  it('5. sticky + intenção diferente com confiança ABAIXO do min → sticky (não troca)', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.4 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-vendas'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'hmm será que...', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('6. classificador falhou (null) + fallback configurado → classifier_failed, config do fallback', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-fallback'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'algo incompreensível', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('7. sem match + SEM fallback → no_match e config null (genérico)', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfigById = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('no_match');
    expect(out.config).toBeNull();
    expect(loadPublishedAgentConfigById).not.toHaveBeenCalled();
  });

  it('8. signal null (follow-up) → nunca chama classifyIntent; usa sticky se houver', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(fakeConfig('agent-vendas'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('9. erro inesperado no router (ex.: DB fora do ar) nunca derruba o turno — cai no loadPublishedAgentConfig atual', async () => {
    const loadActiveRouter = vi.fn().mockRejectedValue(new Error('db timeout'));
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-sessao');
  });
});
