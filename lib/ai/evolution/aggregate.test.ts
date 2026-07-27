import { describe, expect, it } from 'vitest';

import { aggregateEvolution, type EvolutionInput } from './aggregate';

const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-03T00:00:00Z') };

function base(): EvolutionInput {
  return {
    range,
    memoryEntries: [],
    proposalsApplied: [],
    skillInstalls: [],
    skillActivations: [],
    routerDecisions: [],
    knowledgeSearches: [],
    stageTransitions: [],
    costCents: 0,
    inboundCount: 0,
    handoffCount: 0,
    pipelines: [],
  };
}

describe('aggregateEvolution', () => {
  it('monta a linha do tempo de aprendizado ordenada do mais recente para o mais antigo', () => {
    const p = aggregateEvolution({
      ...base(),
      memoryEntries: [{ created_at: '2026-07-01T10:00:00Z', title: 'Nunca prometer prazo' }],
      proposalsApplied: [{ applied_at: '2026-07-03T09:00:00Z', type: 'playbook_bullet', content: 'Confirmar por escrito' }],
      skillInstalls: [{ updated_at: '2026-07-02T08:00:00Z', name: 'objecao-preco' }],
    });

    expect(p.learned.memory_entries).toBe(1);
    expect(p.learned.proposals_applied).toBe(1);
    expect(p.learned.skills_installed).toBe(1);
    expect(p.learned.timeline.map((t) => t.kind)).toEqual(['proposal', 'skill', 'memory']);
    expect(p.learned.timeline[0]!.day).toBe('2026-07-03');
  });

  it('série diária cobre TODOS os dias do intervalo, inclusive os vazios', () => {
    const p = aggregateEvolution({
      ...base(),
      skillActivations: [{ created_at: '2026-07-02T12:00:00Z', skill_name: 'agendamento' }],
    });

    // Dia sem atividade tem que valer 0, não sumir: buraco no gráfico vira
    // "acabou o dado", zero vira "não aconteceu".
    expect(p.activity.series.skill_activations).toEqual([
      { day: '2026-07-01', value: 0 },
      { day: '2026-07-02', value: 1 },
      { day: '2026-07-03', value: 0 },
    ]);
    expect(p.activity.by_skill).toEqual({ agendamento: 1 });
  });

  it('conta como "quase acertou" só a busca sem hit cujo melhor candidato ficou ABAIXO do limiar', () => {
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: 0.703, threshold: 0.72 }, // quase
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: 0.12, threshold: 0.72 },  // a base não tem
        { created_at: '2026-07-01T12:00:00Z', hits: 3, top_score: 0.91, threshold: 0.72 },  // achou
        { created_at: '2026-07-01T13:00:00Z', hits: 0, top_score: null, threshold: 0.72 },  // base vazia
      ],
    });

    expect(p.gaps.knowledge_near_misses).toBe(1);
    expect(p.gaps.knowledge_empty).toBe(3);
  });

  it('conta certo mesmo quando o driver entrega numeric como STRING', () => {
    // Este teste não é paranoia: a prova real da Task 2 mediu `top_score` voltando
    // como '0.910667' — `numeric` não tem parser default no node-postgres. Sem
    // coerção, a comparação vira string×string, não lança, e acerta metade dos
    // casos por acidente. Os tipos declarados são `number`, então o TypeScript
    // não protege: é o defeito que passa no verde.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        // '0.703' está a 0.017 do limiar => quase acertou.
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: '0.703' as never, threshold: '0.72' as never },
        // '0.12' está longe => a base não tem.
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: '0.12' as never, threshold: '0.72' as never },
      ],
    });

    expect(p.gaps.knowledge_near_misses).toBe(1);
    expect(p.gaps.knowledge_empty).toBe(2);
  });

  it('aponta os passos do agente que nenhum estágio do pipeline recebe', () => {
    const p = aggregateEvolution({
      ...base(),
      pipelines: [
        { name: 'Vendas', hints: ['new', 'contacted', 'won', 'lost'] },
        { name: 'Pós-venda', hints: ['new', 'contacted', 'qualifying', 'qualified', 'negotiating', 'won', 'lost'] },
      ],
    });

    // Vendas não recebe qualifying/qualified/negotiating — o agente vai querer
    // avançar e o card vai ficar parado sem ninguém saber por quê.
    expect(p.gaps.unmapped_agent_steps).toEqual([
      { pipeline_name: 'Vendas', steps: ['qualifying', 'qualified', 'negotiating'] },
    ]);
  });

  it('taxa de handoff é sobre conversas recebidas, e 0 recebidas não vira divisão por zero', () => {
    const cheio = aggregateEvolution({ ...base(), inboundCount: 200, handoffCount: 20 });
    expect(cheio.outcome.handoff_rate).toBeCloseTo(0.1);

    const vazio = aggregateEvolution({ ...base(), inboundCount: 0, handoffCount: 0 });
    expect(vazio.outcome.handoff_rate).toBe(0);
  });

  it('conta ganhos e perdas pelas transições terminais do funil do agente', () => {
    const p = aggregateEvolution({
      ...base(),
      stageTransitions: [
        { created_at: '2026-07-01T10:00:00Z', to_stage: 'won' },
        { created_at: '2026-07-02T10:00:00Z', to_stage: 'won' },
        { created_at: '2026-07-02T11:00:00Z', to_stage: 'lost' },
        { created_at: '2026-07-02T12:00:00Z', to_stage: 'qualifying' },
      ],
    });

    expect(p.outcome.won).toBe(2);
    expect(p.outcome.lost).toBe(1);
    expect(p.outcome.stage_transitions).toBe(4);
  });

  it('roteamento sem match entra nas lacunas, não na atividade normal', () => {
    const p = aggregateEvolution({
      ...base(),
      routerDecisions: [
        { created_at: '2026-07-01T10:00:00Z', outcome: 'classified', intent_name: 'agendamento' },
        { created_at: '2026-07-01T11:00:00Z', outcome: 'no_match', intent_name: null },
        { created_at: '2026-07-01T12:00:00Z', outcome: 'classifier_failed', intent_name: null },
      ],
    });

    expect(p.activity.by_intent).toEqual({ agendamento: 1 });
    expect(p.gaps.router_no_match).toBe(1);
    expect(p.gaps.router_failed).toBe(1);
  });

  it('não perde a contagem de um nome que colide com chave herdada de Object', () => {
    // Medido em node: `out['__proto__'] = (out['__proto__'] ?? 0) + 1` num objeto
    // literal NÃO cria propriedade própria — o setter de __proto__ ignora
    // não-objeto e a contagem some sem erro. `skill_pointers.name` só exige
    // length > 0, e nome de skill vem de .zip enviado pelo cliente: nada impede
    // 'constructor' ou '__proto__'. O mapa some da tela e ninguém sabe por quê.
    const p = aggregateEvolution({
      ...base(),
      skillActivations: [
        { created_at: '2026-07-02T12:00:00Z', skill_name: '__proto__' },
        { created_at: '2026-07-02T13:00:00Z', skill_name: 'constructor' },
        { created_at: '2026-07-02T14:00:00Z', skill_name: 'agendamento' },
      ],
    });

    expect(p.activity.by_skill['__proto__']).toBe(1);
    expect(p.activity.by_skill['constructor']).toBe(1);
    expect(p.activity.by_skill['agendamento']).toBe(1);
  });
});
