import { describe, expect, it } from 'vitest';

import { diffParaUpdates, validarMapeamento } from './agent-mapping';

const etapas = [
  { id: 'e1', name: 'Novo', is_won: false, is_lost: false, agent_stage_hint: null },
  { id: 'e2', name: 'Proposta', is_won: false, is_lost: false, agent_stage_hint: 'negotiating' },
  { id: 'e3', name: 'Fechado', is_won: true, is_lost: false, agent_stage_hint: null },
  { id: 'e4', name: 'Perdido', is_won: false, is_lost: true, agent_stage_hint: null },
];

describe('validarMapeamento', () => {
  it('aceita passo sem etapa — é decisão legítima, não pendência', () => {
    const r = validarMapeamento({ new: 'e1', contacted: null }, etapas);
    expect(r.ok).toBe(true);
  });

  it('recusa "ganho" apontando para etapa que não é de ganho, citando a etapa', () => {
    const r = validarMapeamento({ won: 'e2' }, etapas);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erros[0]).toMatch(/Proposta/);
  });

  it('recusa etapa de ganho recebendo passo que não é "ganho"', () => {
    // O CHECK do banco proíbe nos DOIS sentidos: etapa is_won só aceita hint 'won'.
    const r = validarMapeamento({ qualifying: 'e3' }, etapas);
    expect(r.ok).toBe(false);
  });

  it('recusa a mesma etapa recebendo dois passos (o índice único do banco)', () => {
    const r = validarMapeamento({ new: 'e1', contacted: 'e1' }, etapas);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erros[0]).toMatch(/Novo/);
  });

  it('recusa etapa que não é deste pipeline', () => {
    const r = validarMapeamento({ new: 'etapa-de-outro-funil' }, etapas);
    expect(r.ok).toBe(false);
  });

  /* ── casos além do brief ── */

  it('recusa passo fora dos sete — vocabulário fechado do CHECK', () => {
    // Entrada vem de request body: um passo inventado tem que morrer aqui, não no 23514.
    const r = validarMapeamento({ churned: 'e1' }, etapas);
    expect(r.ok).toBe(false);
  });

  it('aceita o mapeamento canônico de ganho e perda', () => {
    // Contraprova das duas regras de coerência: elas recusam o incoerente,
    // não tudo que toca is_won/is_lost.
    const r = validarMapeamento({ won: 'e3', lost: 'e4' }, etapas);
    expect(r.ok).toBe(true);
  });

  it('nenhuma mensagem de erro vaza id de etapa — elas vão direto para a tela', () => {
    const r = validarMapeamento({ won: 'e2', new: 'e1', contacted: 'e1' }, etapas);
    expect(r.ok).toBe(false);
    // 'e1'/'e2' como palavra inteira: o nome «Proposta» não contém isso.
    expect(r.ok === false && r.erros.join(' | ')).not.toMatch(/\be\d\b/);
  });
});

describe('diffParaUpdates', () => {
  it('só mexe no que mudou, e limpa o que saiu do mapa', () => {
    // 'negotiating' sai de e2 e vai para e1; nada mais muda.
    const ups = diffParaUpdates(etapas, { negotiating: 'e1' });
    expect(ups).toEqual(
      expect.arrayContaining([
        { stageId: 'e2', hint: null },
        { stageId: 'e1', hint: 'negotiating' },
      ]),
    );
    expect(ups).toHaveLength(2);
  });

  it('mapa idêntico não gera update nenhum', () => {
    expect(diffParaUpdates(etapas, { negotiating: 'e2' })).toEqual([]);
  });

  /* ── casos além do brief ── */

  it('limpa a etapa quando o passo é explicitamente esvaziado', () => {
    expect(diffParaUpdates(etapas, { negotiating: null })).toEqual([{ stageId: 'e2', hint: null }]);
  });

  it('não encosta em passo que a entrada nem mencionou', () => {
    // e5 declara 'won' e a entrada só fala de 'negotiating': mapa parcial não
    // pode apagar o que o tenant configurou noutra tela/sessão.
    const comGanho = [
      ...etapas.slice(0, 3),
      { id: 'e5', name: 'Ganhou', is_won: true, is_lost: false, agent_stage_hint: 'won' },
    ];
    expect(diffParaUpdates(comGanho, { negotiating: 'e1' })).toEqual(
      expect.not.arrayContaining([{ stageId: 'e5', hint: null }]),
    );
  });

  it('limpa ANTES de ocupar — senão o índice único recusa a troca no meio', () => {
    // 'negotiating' migra de e2 para e1. A ordem natural do array daria o SET
    // (e1) primeiro; exigir o UNSET (e2) na frente só passa se a função ordenar.
    const ups = diffParaUpdates(etapas, { negotiating: 'e1' });
    expect(ups[0]).toEqual({ stageId: 'e2', hint: null });
  });
});
