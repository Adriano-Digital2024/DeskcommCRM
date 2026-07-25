/**
 * WAVE 6 — o dossiê: cabeçalho vivo, timeline, campos por último.
 *
 * Armado antes da implementação. Cenários 18 a 21 do briefing.
 *
 * O ACHADO QUE JÁ NASCE COM O APARATO — e ele é do CONTRATO, não do código:
 *
 *   O cenário 20 diz "editar campo salva E APARECE NA TIMELINE com ator =
 *   humano". Hoje isso é impossível, e dá para provar sem abrir uma rota:
 *   `ActivityType` é exaustivo por construção (`Record<ActivityType, string>`,
 *   tipo novo sem rótulo não compila) e tem SETE valores — `stage_changed`,
 *   `note`, `ai_turn`, `send_vetoed`, `handoff_triggered`,
 *   `next_action_approved`, `next_action_dismissed`. Nenhum deles é "o humano
 *   mudou um campo".
 *
 *   A assimetria é ESTRUTURAL, não um esquecimento: o vocabulário foi crescendo
 *   pelo que a IA faz. A IA deixa rastro; o humano, não. E numa entrega cujo
 *   contrato é "continuidade IA↔humano", quem some do registro é justamente o
 *   lado que precisa ser auditável quando algo dá errado.
 *
 * AS ARMADILHAS QUE ESTE ARQUIVO EXISTE PARA NÃO CAIR:
 *
 *  (a) "O SHEET ABRIU" NÃO É O CENÁRIO 18. O cenário é a ORDEM: cabeçalho →
 *      timeline → campos. Ordem se mede por posição vertical, não por presença.
 *  (b) COLAPSO PRECISA DE CASO E DE VIZINHO. Três eventos do mesmo ator no mesmo
 *      minuto para colapsar, e um de OUTRO ator ao lado que NÃO pode ser
 *      colapsado junto — senão "colapsou" não distingue agrupar de esconder.
 *  (c) COLAPSO SE PROVA PELO NÚMERO. O bloco tem de dizer QUANTOS, e expandir
 *      tem de revelar exatamente esses. "Aparece menos linha" também é o que se
 *      vê quando a timeline perdeu eventos.
 *  (d) O 20 TEM DUAS METADES E ELAS FALHAM SEPARADO: salvar pode funcionar e o
 *      registro não existir. Asserto o valor PERSISTIDO e a linha na timeline.
 *  (e) O 21 É REALTIME, então carrega a pré-condição de capacidade: sem provar
 *      que a entrega funciona para quem devia receber, "entrou ao vivo" e "não
 *      entrou" são indistinguíveis de um canal morto.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-6-cenarios.ts
 */

import { chromium, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { ACTIVITY_LABELS, actorShape, type ActivityType } from "@/lib/leads/activity-vocabulary";
import {
  CREDS,
  EVIDENCE,
  cardLocator,
  carimbar,
  casoConstruido,
  criarPlacar,
  gotoBoard,
  login,
  shotPage,
} from "./qa-helpers";

const envFile = fs.readFileSync(".env.local", "utf8");
const envVars: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL!, envVars.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG = CREDS.org_id as string;
const PIPELINE = (CREDS.crm_vivo as { pipeline_id: string }).pipeline_id;
const STAGE = Object.values((CREDS.crm_vivo as { stage_ids: Record<string, string> }).stage_ids)[0]!;
const DONO = (CREDS.users as Record<string, { id: string }>).manager!.id;
const PREFIXO = "QA-W6";
const RUN = randomUUID().slice(0, 8);

/**
 * A LISTA É DECLARADA AQUI, e é o contrato do placar: critério que estiver nela
 * e não for avaliado sai como AUSENTE no fim. Foi assim que o D19.rotulo e o D25
 * sumiram — acrescentados no meio e esquecidos no caminho de retorno antecipado.
 */
const CRITERIOS = [
  "D20.contrato",
  "D22.formas",
  "D18",
  "D19",
  "D19.rotulo",
  "D20",
  "D21",
  "D23",
  "D24",
  "D25",
  "D26",
  "D20.pii",
];
const { record, fechar } = criarPlacar("WAVE 6", CRITERIOS);

/**
 * O cenário 20 é IMPOSSÍVEL pelo vocabulário, e isso se verifica sem tocar em
 * rota nenhuma: a lista de tipos é a fonte única de escrita e leitura.
 */
function vocabularioTemEdicaoHumana(): { tem: boolean; tipos: string[] } {
  const tipos = Object.keys(ACTIVITY_LABELS) as ActivityType[];
  const tem = tipos.some((t) => /field|campo|edit|updated|lead_updated/i.test(t));
  return { tem, tipos };
}

/**
 * DOIS LEADS, e a diferença entre eles é a variável do teste.
 *
 * Eu tinha UM, sem contato — porque o D26 é sobre o lead sem contato. Mas os
 * outros critérios precisam de uma timeline POPULADA, e sem contato ela nunca
 * carrega: eu estava medindo colapso, rótulo de ator e assinatura sobre uma tela
 * que não tinha como mostrar nada.
 *
 * Reusar o caso de um critério para todos é o mesmo erro do alvo sorteado numa
 * escala acima: o caso vira "o lead que eu tinha à mão" em vez de "o lead que
 * este critério exige".
 */
async function montarCaso(): Promise<{
  leadId: string;
  titulo: string;
  agenteId: string | null;
  leadComContato: string;
  tituloComContato: string;
}> {
  const titulo = `${PREFIXO} ${RUN} — dossiê`;
  const { data: lead, error } = await admin
    .from("crm_leads")
    .insert({
      organization_id: ORG,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      title: titulo,
      status: "open",
      source: "manual",
      value_cents: 300_000,
      currency: "BRL",
      owner_kind: "user",
      owner_user_id: DONO,
      owner_agent_id: null,
      position_in_stage: 6000,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !lead) throw new Error(`criar lead: ${error?.code} ${error?.message}`);
  const leadId = (lead as { id: string }).id;

  const { data: agentes } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", ORG)
    .limit(1);
  const agenteId = ((agentes ?? [])[0] as { id: string } | undefined)?.id ?? null;

  // TRÊS do mesmo ator no MESMO minuto (o caso do colapso) e UMA de outro ator
  // logo depois (o vizinho que NÃO pode ser colapsado junto). Sem o vizinho,
  // "colapsou" não distingue agrupar de esconder.
  const base = Date.now();
  const linhas = [
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA respondeu sobre prazo`, ms: 0 },
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA respondeu sobre preço`, ms: 5_000 },
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA confirmou o horário`, ms: 10_000 },
    // TRÊS DO TIME, consecutivas: sem um BLOCO do time não dá para comparar como
    // o bloco do CLIENTE se lê. Eu tinha uma nota solta, e uma linha única não é
    // bloco — o critério exigia um rótulo que o caso nunca produziria.
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · anotação do humano`, ms: 90_000 },
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · segunda anotação do time`, ms: 95_000 },
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · terceira anotação do time`, ms: 100_000 },
    // TRÊS DO CLIENTE, também consecutivas. Existem porque `filled` cobre
    // `user` E `contact`: um bloco colapsado de ações do CLIENTE tem de se ler
    // diferente de um do TIME, e a forma não consegue fazer essa distinção —
    // só o texto (`actorLabel` dá cinco rótulos onde a forma dá três).
    // De passagem: `contact` tem ZERO linhas no banco real, então este é o
    // primeiro caso do quinto ator, e ele é construído.
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente perguntou o prazo`, ms: 180_000 },
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente mandou o documento`, ms: 185_000 },
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente confirmou o endereço`, ms: 190_000 },
  ];
  for (const l of linhas) {
    const { error: e2 } = await admin.from("crm_lead_activities").insert({
      organization_id: ORG,
      lead_id: leadId,
      source_module: "qa",
      type: l.type,
      actor_kind: l.actor_kind,
      actor_agent_id: l.actor_agent_id,
      performed_by_user_id: l.actor_kind === "user" ? DONO : null,
      contact_id: null,
      reason: l.reason,
      // `crm_lead_activities_ai_needs_evidence`: atividade de IA sem run/trace/
      // llm_call NÃO grava. É a lei do porquê aplicada também ao registro — e a
      // minha primeira versão do seed foi barrada por ela, o que é a constraint
      // fazendo exatamente o trabalho dela contra um cliente descuidado (eu).
      evidence: l.actor_kind === "ai" ? { run_ids: [randomUUID()] } : {},
      performed_at: new Date(base - 600_000 + l.ms).toISOString(),
    } as never);
    if (e2) throw new Error(`criar atividade: ${e2.code} ${e2.message}`);
  }
  // O IRMÃO COM CONTATO — mesmo conteúdo, e a única diferença é o eixo.
  const { data: contato, error: eC } = await admin
    .from("contacts")
    .insert({
      organization_id: ORG,
      name: `${PREFIXO} ${RUN} contato`,
      display_name: `${PREFIXO} ${RUN} contato`,
      phone_number: `+5511${900_000_000 + (parseInt(RUN, 16) % 90_000_000)}`,
      source: "manual",
    } as never)
    .select("id")
    .single();
  if (eC || !contato) throw new Error(`criar contato: ${eC?.code} ${eC?.message}`);
  const contactId = (contato as { id: string }).id;

  const tituloComContato = `${PREFIXO} ${RUN} — dossiê COM contato`;
  const { data: lead2, error: e3 } = await admin
    .from("crm_leads")
    .insert({
      organization_id: ORG,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      contact_id: contactId,
      title: tituloComContato,
      status: "open",
      source: "manual",
      value_cents: 300_000,
      currency: "BRL",
      owner_kind: "user",
      owner_user_id: DONO,
      owner_agent_id: null,
      position_in_stage: 6001,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (e3 || !lead2) throw new Error(`criar lead com contato: ${e3?.code} ${e3?.message}`);
  const leadComContato = (lead2 as { id: string }).id;

  for (const l of linhas) {
    const { error: e4 } = await admin.from("crm_lead_activities").insert({
      organization_id: ORG,
      lead_id: leadComContato,
      contact_id: contactId,
      source_module: "qa",
      type: l.type,
      actor_kind: l.actor_kind,
      actor_agent_id: l.actor_agent_id,
      performed_by_user_id: l.actor_kind === "user" ? DONO : null,
      reason: l.reason,
      evidence: l.actor_kind === "ai" ? { run_ids: [randomUUID()] } : {},
      performed_at: new Date(base - 600_000 + l.ms).toISOString(),
    } as never);
    if (e4) throw new Error(`atividade do irmão: ${e4.code} ${e4.message}`);
  }

  return { leadId, titulo, agenteId, leadComContato, tituloComContato };
}

async function limpar(): Promise<number> {
  const { data } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", ORG)
    .like("title", `${PREFIXO} %`);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return 0;
  await admin.from("crm_lead_activities").delete().in("lead_id", ids);
  await admin.from("crm_leads").delete().in("id", ids);
  await admin.from("contacts").delete().eq("organization_id", ORG).like("name", `${PREFIXO} %`);
  return ids.length;
}

/** O painel do dossiê, seja qual for o invólucro que a implementação escolher. */
function dossie(page: Page): Locator {
  return page.locator('[role="dialog"], [data-dossie], aside[aria-label*="lead" i]').first();
}

/**
 * Posição vertical de um trecho dentro do dossiê — a ORDEM se mede.
 *
 * Procura no texto E no VALOR dos campos. O ensaio contra o diálogo de hoje
 * devolveu `null` para o título: ele não é texto, é `value` de um input — e o
 * meu localizador só olhava texto. Um critério de ORDEM que não acha a âncora do
 * cabeçalho falharia no dia da entrega por defeito meu.
 */
async function topoDe(painel: Locator, padrao: RegExp): Promise<number | null> {
  const porTexto = painel.locator(`text=${padrao}`).first();
  if ((await porTexto.count()) > 0) {
    const box = await porTexto.boundingBox();
    if (box) return box.y;
  }
  const campos = painel.locator("input, textarea");
  for (let i = 0; i < (await campos.count()); i++) {
    const v = await campos.nth(i).inputValue().catch(() => "");
    if (padrao.test(v)) {
      const box = await campos.nth(i).boundingBox();
      if (box) return box.y;
    }
  }
  return null;
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const sufixo = carimbar([
    // O APARATO ENTRA NA PRÓPRIA LISTA — ideia do @DevVivo, e ele está certo:
    // instrumento não commitado produz veredito irreprodutível do mesmo jeito que
    // produto não commitado. Declarar só as dependências do produto deixa o carimbo
    // dizer "todas limpas" enquanto a RÉGUA muda debaixo do resultado.
    "tests/capture-wave-6-cenarios.ts",
    "components/kanban/KanbanCard.tsx",
    // O dossiê nasceu, então a prova passou a DEPENDER dele. Carimbo que declara
    // uma cadeia incompleta diz "todas limpas" sobre um arquivo que nem está na
    // lista — é o mesmo furo do caminho inexistente, pelo lado da omissão.
    "components/kanban/LeadDossier.tsx",
    "hooks/leads/useLeadTimeline.ts",
    "components/kanban/EditLeadDialog.tsx",
    "components/contacts/TimelineView.tsx",
    "lib/leads/activity-vocabulary.ts",
  ]);
  casoConstruido(
    "lead sem contato e quatro atividades semeadas — o quinto ator não existe em dado",
  );

  // ---- 20.contrato: verificável sem abrir a tela ---------------------------
  const voc = vocabularioTemEdicaoHumana();
  record(
    "D20.contrato",
    "o vocabulário TEM um tipo para 'o humano editou um campo'",
    voc.tem,
    voc.tem
      ? `tipos: ${voc.tipos.join(", ")}`
      : `os ${voc.tipos.length} tipos existentes são ${voc.tipos.join(", ")} — nenhum registra ` +
        `edição humana de campo. A IA deixa rastro e o humano não, e a assimetria está no TIPO, ` +
        `não numa rota esquecida`,
    voc.tem ? undefined : "BLOQUEADO",
  );

  // ---- D22.formas: o marcador do ator, ANTES de existir pixel na tela --------
  //
  // O critério é "distinguir o CONTATO do AGENTE sem legenda, no tamanho
  // renderizado". Ele passa hoje — mas o mapa de formas conta uma história que
  // vale ler antes de mexer nele.
  const ATORES = ["user", "ai", "system", "rule", "contact"];
  const mapa = Object.fromEntries(ATORES.map((a) => [a, actorShape(a)]));
  const colisoes = ATORES.flatMap((a, i) =>
    ATORES.slice(i + 1)
      .filter((b) => mapa[a] === mapa[b])
      .map((b) => `${a}=${b} (${mapa[a]})`),
  );
  record(
    "D22.formas",
    "o marcador do CONTATO se distingue do marcador do AGENTE pela forma",
    mapa.contact !== mapa.ai,
    `mapa atual: ${ATORES.map((a) => `${a}→${mapa[a]}`).join(" · ")}` +
      (colisoes.length ? ` | pares que COMPARTILHAM forma: ${colisoes.join(", ")}` : "") +
      ` | as colisões são DELIBERADAS: o eixo da forma é gente/agente/máquina, e o cliente é ` +
      `gente. Quem é especificamente vem do TEXTO (actorLabel dá cinco nomes para cinco atores) ` +
      `— por isso o rótulo do bloco colapsado não pode sair da forma, e é o que o D19.rotulo mede`,
  );

  const sobras = await limpar();
  if (sobras > 0) console.info(`[limpeza inicial] ${sobras} lead(s) de rodada anterior`);
  const caso = await montarCaso();
  const browser = await chromium.launch();

  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(60_000);

    // O CONTADOR DE ASSINATURA É ARMADO AQUI, antes do login.
    // `page.on("websocket")` só enxerga sockets abertos DEPOIS de anexado — no
    // ensaio ele registrou 0 entradas e 0 saídas porque eu o anexava lá embaixo,
    // com o socket já aberto. Um contador cego reportaria "nenhum canal do
    // dossiê observado", que é um BLOQUEADO falso: o instrumento acusaria
    // ausência de recurso onde havia ausência de escuta.
    const assinatura = { joins: 0, leaves: 0 };
    page.on("websocket", (ws) => {
      if (!ws.url().includes("supabase")) return;
      ws.on("framesent", (f) => {
        const t = String(f.payload);
        if (/phx_join/.test(t)) assinatura.joins++;
        if (/phx_leave/.test(t)) assinatura.leaves++;
      });
    });

    await login(page, "manager");
    await gotoBoard(page);

    // ---- ENSAIO=1: exercita a maquinaria contra a superfície que JÁ EXISTE ---
    //
    // Sete critérios deste aparato nunca rodaram: eles destravam todos de uma vez
    // no dia em que o dossiê nascer, que é o dia em que não há tempo de descobrir
    // que o locator não resolve. Então antes disso a máquina é exercitada contra
    // o `EditLeadDialog`, que é o diálogo com campos que existe hoje.
    //
    // O resultado NÃO entra no placar da wave: o dossiê continua não existindo, e
    // misturar as duas coisas transformaria "o instrumento funciona" em "o
    // cenário passa". É ensaio de instrumento, não veredito de produto.
    if (process.env.ENSAIO === "1") {
      const { card: cardEnsaio } = await cardLocator(page, caso.titulo);
      await cardEnsaio.getByRole("button", { name: "Ações do lead" }).click();
      await page.getByRole("menuitem", { name: /editar/i }).click();
      await page.waitForTimeout(1200);
      const painelEnsaio = dossie(page);
      const abriuEnsaio = (await painelEnsaio.count()) > 0;
      console.info(`\n[ensaio] diálogo abriu: ${abriuEnsaio}`);
      if (abriuEnsaio) {
        const yTitulo = await topoDe(painelEnsaio, new RegExp(RUN));
        const yCampos = await topoDe(painelEnsaio, /valor|t[íi]tulo/i);
        console.info(`[ensaio] medição de ORDEM funciona: topo=${yTitulo} campos=${yCampos}`);
        const campo = painelEnsaio.locator('input[name="title"], #title').first();
        console.info(`[ensaio] localizador de campo editável resolve: ${(await campo.count()) > 0}`);
        const texto0 = ((await painelEnsaio.innerText()) ?? "").replace(/\s+/g, " ");
        console.info(`[ensaio] leitura de texto do painel: ${texto0.length} caracteres`);
      }
      // O contador de assinatura, exercitado com abre/fecha REAIS.
      const jEnsaio0 = assinatura.joins;
      const lEnsaio0 = assinatura.leaves;
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        const { card: c } = await cardLocator(page, caso.titulo);
        await c.getByRole("button", { name: "Ações do lead" }).click();
        await page.getByRole("menuitem", { name: /editar/i }).click();
        await page.waitForTimeout(700);
      }
      await page.keyboard.press("Escape");
      console.info(
        `[ensaio] contador de assinatura opera: ${assinatura.joins - jEnsaio0} entradas / ` +
          `${assinatura.leaves - lEnsaio0} saídas em 3 ciclos (total na página: ${assinatura.joins}/${assinatura.leaves})`,
      );
      console.info("[ensaio] — nada disto entra no placar: o dossiê continua não existindo\n");
    }

    // ---- 18: clicar no card abre o dossiê, na ORDEM certa -------------------
    // O lead COM contato: os critérios de timeline exigem uma timeline que
    // CARREGUE. Medir colapso e rótulo de ator no lead sem contato seria medir a
    // ausência de eixo e chamá-la de defeito de apresentação.
    const { card } = await cardLocator(page, caso.tituloComContato);
    await card.click();
    await page.waitForTimeout(1500);
    const painel = dossie(page);
    const abriu = (await painel.count()) > 0 && (await painel.first().isVisible().catch(() => false));

    if (!abriu) {
      record(
        "D18",
        "CENÁRIO 18: clicar no card abre o dossiê (cabeçalho → timeline → campos)",
        false,
        "nenhum painel abriu ao clicar no card — o dossiê não existe ainda " +
          "(EditLeadDialog segue como diálogo do menu de ações)",
        "BLOQUEADO",
      );
      // A LISTA TEM DE CONTER TODOS. Quando eu acrescentei o D19.rotulo e o D25
      // sem incluí-los aqui, eles sumiram do placar em silêncio pelo caminho do
      // retorno antecipado — o mesmo formato que eu transformei em lei hoje de
      // manhã: critério pulado sem vermelho para investigar e com o placar de pé.
      for (const [n, nome] of [
        ["D19", "CENÁRIO 19: timeline colapsa eventos consecutivos do mesmo ator"],
        ["D19.rotulo", "o bloco colapsado nomeia o ATOR pelo texto — CLIENTE não se lê como TIME"],
        ["D25", "âncora sem alvo vira TEXTO, não link nem exceção (LGPD, e não é defeito)"],
        ["D26", "lead SEM contato mostra as PRÓPRIAS atividades na timeline"],
        ["D20.pii", "o registro diz QUAL campo mudou e NÃO carrega o valor"],
        ["D20", "CENÁRIO 20: editar campo salva E aparece na timeline com ator humano"],
        ["D21", "CENÁRIO 21: ação do agente na outra aba entra na timeline ao vivo"],
        ["D23", "o Sheet DESASSINA ao fechar — abrir e fechar N vezes não acumula canal"],
        ["D24", "a fonte devolve EVENTOS; quem agrupa é a tela"],
      ] as [string, string][]) {
        record(n, nome, false, "sem dossiê aberto não há superfície para medir — preso ao D18", "BLOQUEADO");
      }
      await shotPage(page, `wave-6-sem-dossie${sufixo}.png`, false);
      return;
    }

    const yCabecalho = await topoDe(painel, new RegExp(RUN));
    // A ÂNCORA DA SEÇÃO, não o texto de um evento. Eu ancorava no motivo de uma
    // atividade — e ela está COLAPSADA dentro de um bloco, então o texto não
    // aparece. Quarto critério meu hoje a exigir uma forma específica em vez da
    // coisa: a seção existe, o evento individual é detalhe dela.
    const yTimeline = await topoDe(painel, /linha do tempo/i);
    const yCampos = await topoDe(painel, /valor|título|estágio/i);
    const ordemOk =
      yCabecalho !== null &&
      yTimeline !== null &&
      yCampos !== null &&
      yCabecalho < yTimeline &&
      yTimeline < yCampos;
    record(
      "D18",
      "CENÁRIO 18: clicar no card abre o dossiê (cabeçalho → timeline → campos)",
      ordemOk,
      `posições verticais — cabeçalho=${yCabecalho} timeline=${yTimeline} campos=${yCampos}` +
        (ordemOk ? "" : " — a ORDEM é o cenário, não a presença"),
    );
    await shotPage(page, `wave-6-d18-dossie${sufixo}.png`, false);

    // ---- 19: colapso com vizinho de outro ator ------------------------------
    const texto = ((await painel.innerText()) ?? "").replace(/\s+/g, " ");
    // DOIS blocos, um por ator. A primeira versão exigia que a linha individual
    // do humano CONTINUASSE VISÍVEL — e ela some, corretamente, porque as três
    // notas do time também colapsam. Eu estava exigindo que o produto NÃO
    // agrupasse o segundo ator, que é o oposto do cenário.
    const blocos = texto.match(/·\s*3\s+(ações|eventos|atividades)/gi) ?? [];
    const naoEngoliu = blocos.length >= 2;
    record(
      "D19",
      "CENÁRIO 19: colapsa por ATOR — dois blocos de 3, não um de 6",
      naoEngoliu,
      `blocos de 3 anunciados: ${blocos.length} (esperado 2 — cliente e time) · ` +
        `painel diz: "${texto.slice(0, 150)}"` +
        (blocos.length === 1 ? " — um bloco só significa que os dois atores foram engolidos juntos" : ""),
    );

    // ---- 19.rótulo: o bloco do CLIENTE não pode se ler como o do TIME -------
    //
    // `filled` cobre `user` E `contact` — de propósito, porque o eixo da forma é
    // gente/agente/máquina e o cliente É gente. A consequência é que o rótulo do
    // bloco colapsado NÃO pode sair da forma: tem de vir do texto, onde há cinco
    // nomes para cinco atores. Sem isso, três ações do CLIENTE se leem como três
    // do TIME, e o dossiê passa a mentir sobre quem fez o quê.
    // A INTENÇÃO, não a letra. A primeira versão exigia a string "Você/time" —
    // e o produto nomeia a PESSOA ("E2E Manager"), que é mais específico que o
    // rótulo genérico. Eu teria reprovado um acerto por não estar escrito com as
    // palavras que eu tinha na cabeça. O que o critério afirma é que os dois
    // blocos se LEEM DIFERENTE e que cada um nomeia o seu ator.
    const dizCliente = /cliente/i.test(texto);
    const dizTime = /você\/time|voce\/time|E2E Manager/i.test(texto);
    record(
      "D19.rotulo",
      "cada bloco nomeia o SEU ator pelo texto — CLIENTE não se lê como TIME",
      dizCliente && dizTime,
      `no painel: cliente nomeado=${dizCliente} · time nomeado=${dizTime} — a forma não ` +
        `distingue os dois (ambos preenchidos), então quem distingue é o texto`,
    );

    // ---- 20: as duas metades, medidas separado -----------------------------
    const campoValor = painel.locator('input[name="value_cents"], #value_cents, input[name="title"]').first();
    if ((await campoValor.count()) === 0) {
      record("D20", "CENÁRIO 20: editar campo salva E aparece na timeline", false, "sem campo editável no dossiê", "BLOQUEADO");
    } else {
      const novo = `${caso.titulo} (editado)`;
      await campoValor.fill(novo);
      await painel.getByRole("button", { name: /salvar|guardar/i }).first().click().catch(() => null);
      await page.waitForTimeout(2500);
      // O LEAD CERTO: depois de o dossiê principal passar a ser o do irmão COM
      // contato, esta verificação continuava lendo o outro — e reprovava o
      // produto porque eu conferia um lead que ninguém editou.
      const { data: linha } = await admin
        .from("crm_leads")
        .select("title")
        .eq("id", caso.leadComContato)
        .single();
      const persistiu = (linha as { title: string } | null)?.title === novo;
      const { data: ativs } = await admin
        .from("crm_lead_activities")
        .select("type,actor_kind,reason,payload")
        .eq("lead_id", caso.leadComContato);
      const humana = (
        (ativs ?? []) as {
          type: string;
          actor_kind: string;
          reason: string | null;
          payload: Record<string, unknown> | null;
        }[]
      ).find((a) => a.actor_kind === "user" && a.type === "lead_edited");

      // QUAIS campos mudaram — no `reason` OU no `payload`, e a diferença não é
      // detalhe: o TÍTULO DO LEAD É O NOME DO CLIENTE ("Carlos — Clínica Vida
      // Odonto"). Um critério que exigisse os campos no texto empurraria alguém a
      // escrever o VALOR ali, e o registro de auditoria viraria vazamento.
      //
      // Então a asserção aceita as duas formas e ganha a metade que faltava: os
      // NOMES têm de estar; os VALORES não podem estar. Critério que só cobra a
      // presença empurra para o excesso — foi o mesmo raciocínio da evidência
      // "até três, nunca cota".
      const registro = `${humana?.reason ?? ""} ${JSON.stringify(humana?.payload ?? {})}`;
      const dizOQueMudou = /t[íi]tulo|title|valor|value|est[áa]gio|stage|dono|owner|descri/i.test(registro);
      record(
        "D20",
        "CENÁRIO 20: editar campo salva, registra como lead_edited e DIZ o que mudou",
        persistiu && Boolean(humana) && dizOQueMudou,
        `persistiu=${persistiu} · atividade lead_edited=${humana ? "sim" : "NENHUMA"} · ` +
          `nomeia o campo alterado=${dizOQueMudou} · registro: ${registro.slice(0, 120)} — ` +
          `as três falham separado: salvar pode funcionar, o registro não existir, e o ` +
          `registro existir sem dizer o que mudou`,
      );

      // O REGISTRO NÃO PODE CARREGAR O VALOR. O título do lead é o nome do
      // cliente, então gravar "de X para Y" põe PII num log de auditoria que
      // sobrevive à anonimização do contato. Nome de campo é metadado; valor de
      // campo é dado pessoal.
      const vazouValor = registro.includes(caso.tituloComContato) || /\(editado\)/.test(registro);
      record(
        "D20.pii",
        "o registro diz QUAL campo mudou e NÃO carrega o valor — título é nome de cliente",
        Boolean(humana) && !vazouValor,
        vazouValor
          ? `o valor do campo aparece no registro: ${registro.slice(0, 140)}`
          : "só nomes de campo no registro — o valor fica fora do log de auditoria",
      );
    }

    // ---- 26: o lead SEM contato — 25% deles, e 66% das atividades ------------
    //
    // A timeline é indexada por CONTATO: o hook filtra `contact_id=eq.<id>` e a
    // rota busca as atividades diretas do contato mais as dos leads dele. Um
    // lead sem contato não tem porta de entrada nenhuma.
    //
    // Medido no banco de teste: 13 de 53 leads não têm contato, e 117 das 177
    // atividades pertencem a esses leads. Não é caso de canto — é a MAIORIA do
    // que está registrado hoje.
    //
    // E o que torna isto caro é a leitura na TELA: uma timeline vazia por falta
    // de EIXO se lê exatamente como uma timeline vazia por falta de ACONTECIMENTO.
    // O usuário vê "nada aconteceu neste negócio" sobre um negócio com histórico.
    // É a ausência com cara de aprovação, agora na frente do cliente.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const { card: cardSemContato } = await cardLocator(page, caso.titulo);
    await cardSemContato.click();
    await page.waitForTimeout(1500);
    const textoTimeline = ((await dossie(page).innerText()) ?? "").replace(/\s+/g, " ");
    const mostraAsAtividades = /a IA respondeu sobre prazo/i.test(textoTimeline);
    if (!mostraAsAtividades) {
      await shotPage(page, `wave-6-d26-timeline-vazia-por-eixo${sufixo}.png`, false);
    }
    record(
      "D26",
      "lead SEM contato mostra as PRÓPRIAS atividades na timeline",
      mostraAsAtividades,
      mostraAsAtividades
        ? "o lead sem contato exibe as atividades ligadas a ele"
        : "timeline VAZIA para um lead que TEM 4 atividades — e vazia por falta de eixo se lê " +
          "igual a vazia por falta de acontecimento",
    );

    // ---- 24: a FONTE devolve eventos; quem agrupa é a TELA -------------------
    //
    // Se o agrupamento descer para a consulta, a paginação passa a contar BLOCOS
    // e um INSERT chegando por realtime não sabe em que bloco entrar. Então a
    // pergunta não é estética: é se o colapso é apresentação ou modelagem.
    // Mede-se comparando o que a ROTA devolve com o que a TELA mostra.
    const respostaTimeline = await page.evaluate(async (id: string) => {
      const r = await fetch(`/api/v1/leads/${id}/timeline`, { credentials: "include" });
      if (!r.ok) return { status: r.status, itens: -1 };
      const b = (await r.json()) as { data?: unknown[] };
      return { status: r.status, itens: Array.isArray(b.data) ? b.data.length : -1 };
    }, caso.leadId);
    record(
      "D24",
      "a fonte devolve EVENTOS; quem agrupa é a tela",
      respostaTimeline.status === 200 && respostaTimeline.itens >= 4,
      respostaTimeline.status !== 200
        ? `GET /api/v1/leads/<id>/timeline devolveu ${respostaTimeline.status} — a rota por lead ainda não existe`
        : `a rota devolveu ${respostaTimeline.itens} item(ns) para as 4 atividades semeadas — ` +
          `menos que isso significa agrupamento na CONSULTA, e aí a paginação conta blocos`,
      respostaTimeline.status === 404 ? "BLOQUEADO" : undefined,
    );

    // ---- 25: âncora sem alvo NÃO vira link, e isso NÃO é defeito -------------
    //
    // Sob LGPD a mensagem referenciada pode ter sido removida. Lançar exceção ou
    // fabricar um link morto reintroduziria o vazamento que a anonimização
    // fechou. O critério afirma o comportamento BOM: texto simples, sem quebrar.
    const quebrou = await page.evaluate(() => document.body.innerText.includes("Application error"));
    record(
      "D25",
      "âncora sem alvo vira TEXTO, não link nem exceção (LGPD, e não é defeito)",
      !quebrou,
      quebrou
        ? "a tela caiu em error boundary com uma âncora sem alvo"
        : "o dossiê renderizou sem quebrar — evidência removida por anonimização é caso legítimo",
    );

    // ---- 23: o vazamento que teste curto NUNCA pega -------------------------
    //
    // Abrir e fechar UMA vez não revela assinatura que não é desfeita: o canal
    // órfão só incomoda quando se acumula. Então o instrumento faz o que o uso
    // real faz — abre e fecha várias vezes — e compara ENTRADAS com SAÍDAS.
    //
    // A contagem é de `phx_join` contra `phx_leave` no socket: se o Sheet
    // desassina, cada abertura tem a sua saída. Se não desassina, as entradas
    // crescem e as saídas não — e o número da diferença É o vazamento.
    const antesJ = assinatura.joins;
    const antesL = assinatura.leaves;
    const CICLOS = 4;
    for (let i = 0; i < CICLOS; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      const { card: c } = await cardLocator(page, caso.titulo);
      await c.click();
      await page.waitForTimeout(900);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    const joins = assinatura.joins - antesJ;
    const leaves = assinatura.leaves - antesL;
    record(
      "D23",
      "o Sheet DESASSINA ao fechar — abrir e fechar N vezes não acumula canal",
      joins > 0 && joins - leaves <= 1,
      joins === 0
        ? "nenhum canal do dossiê observado — ou ele não assina nada, ou o nome do canal mudou"
        : `${CICLOS + 1} aberturas → ${joins} entradas e ${leaves} saídas no socket ` +
          `(diferença ${joins - leaves}) — teste que abre e fecha UMA vez nunca veria isto`,
      joins === 0 ? "BLOQUEADO" : undefined,
    );

    // ---- 21: ao vivo, com pré-condição de capacidade -----------------------
    record(
      "D21",
      "CENÁRIO 21: ação do agente na outra aba entra na timeline ao vivo",
      false,
      "a montar quando o dossiê existir: exige segunda aba, ação remota e a pré-condição " +
        "de que a entrega funciona para quem DEVIA receber",
      "BLOQUEADO",
    );
  } finally {
    await browser.close();
    console.info(`[limpeza] ${await limpar()} lead(s) de teste removidos`);
    // O FECHAMENTO VIVE NO `finally`, e a razão é o próprio defeito que este
    // placar existe para pegar: o caminho "dossiê não existe" usa `return`, que
    // sai da função inteira — com o fechamento depois do `try`, ele seria
    // PULADO. O mecanismo contra critério pulado estava, ele mesmo, sendo pulado.
    if (fechar() > 0) process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error("❌ Wave 6 falhou:", err);
  await limpar().catch(() => null);
  process.exit(1);
});
