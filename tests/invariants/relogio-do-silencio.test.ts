import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O relógio do silêncio (`crm_leads.last_activity_at`) só anda com INTERAÇÃO.
 *
 * Este arquivo mede COMPORTAMENTO, não a lista: insere uma atividade de cada
 * tipo e olha se o relógio andou. Conferir a lista contra si mesma seria medir
 * o mecanismo contra a própria definição — passaria mesmo se o `if` estivesse
 * invertido.
 *
 * O DEFEITO QUE ELE GUARDA: `fn_update_last_activity_at` carimbava para
 * QUALQUER tipo, e `last_activity_at` é o relógio que decide o esfriamento. O
 * produtor do estado apagava o próprio estado ao registrá-lo — e 24h depois
 * repetia, virando uma máquina de ruído perpétua.
 *
 * ⚠️ TIPO NOVO DE ATIVIDADE → uma linha aqui, declarando o lado. Se você não
 * souber de que lado ele fica, a pergunta é: *uma linha desse tipo é instância
 * do que a métrica conta?* Constatar o silêncio não é quebrar o silêncio.
 */

/** `true` = quebra o silêncio; `false` = é observação e o relógio segue correndo. */
const TIPOS: Array<[tipo: string, quebraOSilencio: boolean, porque: string]> = [
  ["ai_turn", true, "a IA falou com o cliente"],
  ["note", true, "alguém registrou trabalho no negócio"],
  ["lead_edited", true, "humano mexeu nos dados"],
  ["stage_changed", true, "humano moveu o negócio"],
  ["next_action_approved", true, "humano decidiu agir"],
  ["send_vetoed", false, "o envio não chegou ao cliente"],
  ["handoff_triggered", false, "passar para humano é promessa, não atendimento"],
  ["next_action_dismissed", false, "decidiu NÃO agir: fica sem próximo passo"],
  ["lead_cooled", false, "É A OBSERVAÇÃO DO SILÊNCIO — o caso que motivou tudo"],
  ["lead_reactivated", false, "observação de sistema, ninguém falou com ninguém"],
];

/** Org isolada deste arquivo — ver `negocioFrio`. */
const ORG = "ee000000-0079-4000-8000-000000000001";
const PIPE = "ee000000-0079-4000-8000-000000000002";
const STAGE = "ee000000-0079-4000-8000-000000000003";

/**
 * Um negócio com o relógio parado 30 dias atrás, em org PRÓPRIA.
 *
 * ⚠️ ORG PRÓPRIA E NÃO A DO SEED, e não é preferência de estilo: a primeira
 * versão usava `GOV_ORG` e quebrou `gov-8-metrics`, que roda EXPLAIN e exige um
 * índice específico no plano. Onze leads a mais mudaram a estatística e o
 * planner trocou de caminho. Teste que enche uma tabela compartilhada altera o
 * veredito de quem mede plano de consulta — e a falha aparece no OUTRO arquivo,
 * o que torna a causa quase invisível.
 *
 * CADA CASO GANHA A SUA PRÓPRIA LINHA pelo mesmo motivo, um nível abaixo: com
 * um lead compartilhado, o resultado de um tipo viraria a condição inicial do
 * seguinte e a ordem dos testes decidiria o veredito.
 */
function negocioFrio(marca: string): string {
  // A PRIMEIRA linha é o `returning`; a última é o "INSERT 0 1" que o psql
  // imprime. Pegar a saída inteira mandaria as duas juntas para dentro de uma
  // aspa de UUID no próximo comando.
  return sql(`
    insert into public.crm_leads
      (organization_id, pipeline_id, stage_id, title, last_activity_at, position_in_stage)
    values ('${ORG}', '${PIPE}', '${STAGE}',
            'relogio ${marca}', now() - interval '30 days', 1000)
    returning id
  `).split("\n")[0]!.trim();
}

describe("0079 · o relógio do silêncio", () => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'relogio-0079', 'Relogio 0079', 'Relogio 0079')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE}', '${ORG}', 'Relogio', 'relogio')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
  `);

  for (const [tipo, quebraOSilencio, porque] of TIPOS) {
    it(`${tipo}: ${quebraOSilencio ? "ANDA" : "não anda"} — ${porque}`, () => {
      const lead = negocioFrio(tipo.replace(/_/g, "-"));
      const antes = sql(`select last_activity_at from public.crm_leads where id = '${lead}'`);

      sql(`
        insert into public.crm_lead_activities
          (organization_id, lead_id, type, source_module, source_id, performed_at, actor_kind)
        select organization_id, id, '${tipo}', 'crm', id, now(), 'system'
          from public.crm_leads where id = '${lead}'
      `);

      const depois = sql(`select last_activity_at from public.crm_leads where id = '${lead}'`);
      if (quebraOSilencio) {
        expect(depois).not.toBe(antes);
      } else {
        expect(depois).toBe(antes);
      }
    });
  }

  it("o ciclo completo NÃO se autodestrói: esfriar não rejuvenesce o negócio", () => {
    // A composição, que é o que nenhum caso isolado prova: um negócio com 30
    // dias de silêncio continua com 30 dias de silêncio DEPOIS de o sistema
    // registrar que ele esfriou. Era aqui que o produtor se aniquilava.
    const lead = negocioFrio("ciclo");
    const horasAntes = Number(
      sql(`select round(extract(epoch from (now() - last_activity_at)) / 3600)
             from public.crm_leads where id = '${lead}'`),
    );
    sql(`
      insert into public.crm_lead_activities
        (organization_id, lead_id, type, source_module, source_id, performed_at, actor_kind, reason)
      select organization_id, id, 'lead_cooled', 'crm', id, now(), 'system', 'sem resposta há 30 dias'
        from public.crm_leads where id = '${lead}'
    `);
    const horasDepois = Number(
      sql(`select round(extract(epoch from (now() - last_activity_at)) / 3600)
             from public.crm_leads where id = '${lead}'`),
    );
    expect(horasAntes).toBeGreaterThan(700); // ~30 dias
    expect(horasDepois).toBe(horasAntes);
  });
});
