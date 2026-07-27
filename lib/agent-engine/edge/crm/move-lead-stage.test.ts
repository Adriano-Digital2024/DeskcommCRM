import { describe, expect, it, vi } from 'vitest';

import { mirrorLeadStageToCrm } from './move-lead-stage';

const cfg = { supabase: {} as never };
const db = {} as never;

describe('mirrorLeadStageToCrm', () => {
  it('move o card quando o pipeline declara destino para o passo', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: true, motivo: 'movido', leadId: 'lead-1', stageName: 'Negociação',
    });

    const r = await mirrorLeadStageToCrm(
      db, cfg as never,
      { tenantId: 'org-1', leadId: 'contato-1', toStage: 'negotiating' },
      { sync },
    );

    expect(r).toEqual({ ok: true });
    // O `leadId` do engine É o contact_id do CRM — trocar isso move o card errado.
    expect(sync).toHaveBeenCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'negotiating',
    });
  });

  it('estágio já ocupado é sucesso, não falha', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'ja_esta_la' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toEqual({ ok: true });
  });

  it.each(['sem_mapeamento', 'sem_negocio', 'ambiguo'])(
    'motivo %s vira not_configured (warn-only, sem item de inbox)',
    async (motivo) => {
      const sync = vi.fn().mockResolvedValue({ moveu: false, motivo });
      const r = await mirrorLeadStageToCrm(
        db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'qualified' }, { sync },
      );
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ reason: 'not_configured' });
    },
  );

  it('erro da sincronização vira crm_error e NUNCA lança', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('supabase fora'));
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
  });
});
