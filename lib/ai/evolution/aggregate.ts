/**
 * Agregador puro do Painel de Evolução (Fase 4 do épico do Harness).
 *
 * Recebe linhas cruas das seis fontes que as fases 0-3 depositaram e devolve o
 * payload que a tela consome. Sem efeito colateral, sem acesso a banco — a
 * rota busca, isto raciocina, e o teste não precisa de Postgres.
 *
 * A doutrina do sistema vivo pede que TODO número leve a uma ação. Por isso o
 * payload separa `activity` (o que aconteceu) de `gaps` (o que está travando):
 * o segundo bloco é o que o dono do negócio pode ir consertar hoje.
 */
import { daysBetween, toUtcDay } from '@/lib/ai/usage/aggregate';
import { LEAD_STAGES } from '@/lib/agent-engine/agent/lead-state';

export interface EvolutionInput {
  range: { from: Date; to: Date };
  memoryEntries: Array<{ created_at: string; title: string }>;
  proposalsApplied: Array<{ applied_at: string; type: string; content: string }>;
  /**
   * `skill_pointers` NÃO tem `created_at` — só `updated_at`, e ele é exatamente o
   * momento em que o ponteiro se moveu, isto é, quando a skill foi instalada ou
   * atualizada. É o que a spec chama de "skills instaladas/atualizadas".
   */
  skillInstalls: Array<{ updated_at: string; name: string }>;
  skillActivations: Array<{ created_at: string; skill_name: string }>;
  routerDecisions: Array<{ created_at: string; outcome: string; intent_name: string | null }>;
  knowledgeSearches: Array<{
    created_at: string;
    hits: number;
    top_score: number | null;
    threshold: number;
  }>;
  stageTransitions: Array<{ created_at: string; to_stage: string }>;
  costCents: number;
  inboundCount: number;
  handoffCount: number;
  pipelines: Array<{ name: string; hints: Array<string | null> }>;
}

export interface TimelineItem {
  day: string;
  kind: 'memory' | 'proposal' | 'skill';
  title: string;
}

export interface EvolutionPayload {
  range: { from: string; to: string };
  learned: {
    memory_entries: number;
    proposals_applied: number;
    skills_installed: number;
    timeline: TimelineItem[];
  };
  activity: {
    series: {
      skill_activations: Array<{ day: string; value: number }>;
      router_decisions: Array<{ day: string; value: number }>;
      knowledge_searches: Array<{ day: string; value: number }>;
    };
    by_skill: Record<string, number>;
    by_intent: Record<string, number>;
  };
  outcome: {
    stage_transitions: number;
    won: number;
    lost: number;
    handoff_rate: number;
    cost_cents: number;
  };
  gaps: {
    unmapped_agent_steps: Array<{ pipeline_name: string; steps: string[] }>;
    knowledge_near_misses: number;
    knowledge_empty: number;
    router_no_match: number;
    router_failed: number;
  };
}

/** Série diária densa: dia sem evento vale 0, nunca some do eixo. */
function serie(days: string[], rows: Array<{ created_at: string }>): Array<{ day: string; value: number }> {
  const contagem = new Map<string, number>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    contagem.set(d, (contagem.get(d) ?? 0) + 1);
  }
  return days.map((day) => ({ day, value: contagem.get(day) ?? 0 }));
}

function contaPor<T>(rows: T[], chave: (r: T) => string | null): Record<string, number> {
  // ⚠️ SEM PROTÓTIPO, de propósito. As chaves aqui são nome de skill e nome de
  // intenção — texto do cliente (skill vem de .zip enviado; intenção é digitada
  // na config do roteador), e `skill_pointers.name` só exige `length > 0`. Num
  // objeto literal, `out['__proto__'] = (out['__proto__'] ?? 0) + 1` NÃO cria
  // propriedade própria: o setter de `__proto__` descarta o não-objeto e a
  // contagem some sem erro nenhum. `Object.create(null)` faz a chave virar dado
  // comum. Medido em node, não deduzido.
  const out: Record<string, number> = Object.create(null);
  for (const r of rows) {
    const k = chave(r);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function aggregateEvolution(input: EvolutionInput): EvolutionPayload {
  const days = daysBetween(input.range.from, input.range.to);

  const timeline: TimelineItem[] = [
    ...input.memoryEntries.map((m) => ({
      day: m.created_at.slice(0, 10),
      kind: 'memory' as const,
      title: m.title,
    })),
    ...input.proposalsApplied.map((p) => ({
      day: p.applied_at.slice(0, 10),
      kind: 'proposal' as const,
      title: p.content.slice(0, 120),
    })),
    ...input.skillInstalls.map((s) => ({
      day: s.updated_at.slice(0, 10),
      kind: 'skill' as const,
      title: s.name,
    })),
  ].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  // "Quase acertou" é a busca que NÃO trouxe nada e cujo melhor candidato ficou
  // logo abaixo do limiar. É o sinal que separa "a base não tem isso" de "a base
  // tem e o corte está apertado demais" — dois problemas com consertos opostos.
  const PERTO = 0.1;
  let nearMisses = 0;
  let empty = 0;
  for (const k of input.knowledgeSearches) {
    if (k.hits > 0) continue;
    empty += 1;
    // ⚠️ COERÇÃO OBRIGATÓRIA. `top_score` e `threshold` são `numeric` no Postgres,
    // e `numeric` não tem parser default no node-postgres — chega como STRING
    // ('0.910667'). A comparação string×string não lança e não erra sempre:
    // `'0.144' >= '0.62'` dá false pelo motivo errado, e `'0.9' >= '0.72'` dá
    // true também pelo motivo errado. O tipo declarado aqui é `number`, então o
    // TypeScript não pega — é o pior formato de defeito, o que acerta por acaso.
    // Medido na prova real da Task 2, contra o banco.
    const nota = k.top_score === null ? null : Number(k.top_score);
    const limiar = Number(k.threshold);
    if (nota !== null && Number.isFinite(nota) && nota >= limiar - PERTO) nearMisses += 1;
  }

  const unmapped = input.pipelines
    .map((p) => {
      const declarados = new Set(p.hints.filter((h): h is string => h !== null));
      return {
        pipeline_name: p.name,
        steps: LEAD_STAGES.filter((s) => !declarados.has(s)),
      };
    })
    .filter((p) => p.steps.length > 0);

  return {
    range: { from: toUtcDay(input.range.from), to: toUtcDay(input.range.to) },
    learned: {
      memory_entries: input.memoryEntries.length,
      proposals_applied: input.proposalsApplied.length,
      skills_installed: input.skillInstalls.length,
      timeline,
    },
    activity: {
      series: {
        skill_activations: serie(days, input.skillActivations),
        router_decisions: serie(days, input.routerDecisions),
        knowledge_searches: serie(days, input.knowledgeSearches),
      },
      by_skill: contaPor(input.skillActivations, (r) => r.skill_name),
      by_intent: contaPor(
        // Só estes três outcomes carregam `intent_name` não-nulo (ver
        // `resolve-turn-agent.ts`); os demais já cairiam no filtro de null.
        // Nomear a lista deixa a regra explícita em vez de acidental.
        input.routerDecisions.filter((r) => r.outcome === 'classified' || r.outcome === 'sticky' || r.outcome === 'reclassified'),
        (r) => r.intent_name,
      ),
    },
    outcome: {
      stage_transitions: input.stageTransitions.length,
      won: input.stageTransitions.filter((t) => t.to_stage === 'won').length,
      lost: input.stageTransitions.filter((t) => t.to_stage === 'lost').length,
      handoff_rate: input.inboundCount > 0 ? input.handoffCount / input.inboundCount : 0,
      cost_cents: input.costCents,
    },
    gaps: {
      unmapped_agent_steps: unmapped,
      knowledge_near_misses: nearMisses,
      knowledge_empty: empty,
      router_no_match: input.routerDecisions.filter((r) => r.outcome === 'no_match').length,
      router_failed: input.routerDecisions.filter((r) => r.outcome === 'classifier_failed').length,
    },
  };
}
