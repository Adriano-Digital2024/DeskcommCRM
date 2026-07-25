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
import { CREDS, EVIDENCE, cardLocator, carimbar, gotoBoard, login, shotPage } from "./qa-helpers";

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

type Estado = "PASS" | "FALHA" | "BLOQUEADO";
const resultados: { n: string; nome: string; estado: Estado; detalhe: string }[] = [];
function record(n: string, nome: string, ok: boolean, detalhe: string, estado?: Estado): void {
  const e: Estado = estado ?? (ok ? "PASS" : "FALHA");
  resultados.push({ n, nome, estado: e, detalhe });
  console.info(`${e.padEnd(9)} [${n}] ${nome} — ${detalhe}`);
}

/**
 * O cenário 20 é IMPOSSÍVEL pelo vocabulário, e isso se verifica sem tocar em
 * rota nenhuma: a lista de tipos é a fonte única de escrita e leitura.
 */
function vocabularioTemEdicaoHumana(): { tem: boolean; tipos: string[] } {
  const tipos = Object.keys(ACTIVITY_LABELS) as ActivityType[];
  const tem = tipos.some((t) => /field|campo|edit|updated|lead_updated/i.test(t));
  return { tem, tipos };
}

async function montarCaso(): Promise<{ leadId: string; titulo: string; agenteId: string | null }> {
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
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · anotação do humano`, ms: 90_000 },
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
  return { leadId, titulo, agenteId };
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
  return ids.length;
}

/** O painel do dossiê, seja qual for o invólucro que a implementação escolher. */
function dossie(page: Page): Locator {
  return page.locator('[role="dialog"], [data-dossie], aside[aria-label*="lead" i]').first();
}

/** Posição vertical de um trecho de texto dentro do dossiê — a ORDEM se mede. */
async function topoDe(painel: Locator, padrao: RegExp): Promise<number | null> {
  const alvo = painel.locator(`text=${padrao}`).first();
  if ((await alvo.count()) === 0) return null;
  const box = await alvo.boundingBox();
  return box?.y ?? null;
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const sufixo = carimbar([
    "components/kanban/KanbanCard.tsx",
    "components/kanban/EditLeadDialog.tsx",
    "components/contacts/TimelineView.tsx",
    "lib/leads/activity-vocabulary.ts",
  ]);

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
      ` | atenção ao plano de dar TRACEJADO ao contato: hoje tracejado significa "nem gente ` +
      `nem agente" e é onde system e rule já moram — mover o contato para lá troca a colisão ` +
      `com "user" (duas pessoas) por uma colisão com "system/rule" (uma pessoa e duas máquinas)`,
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
    await login(page, "manager");
    await gotoBoard(page);

    // ---- 18: clicar no card abre o dossiê, na ORDEM certa -------------------
    const { card } = await cardLocator(page, caso.titulo);
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
      for (const [n, nome] of [
        ["D19", "CENÁRIO 19: timeline colapsa eventos consecutivos do mesmo ator"],
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
    const yTimeline = await topoDe(painel, /a IA respondeu sobre prazo/i);
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
    const anunciaQuantos = /\b3\s+(ações|eventos|atividades)/i.test(texto);
    const vizinhoSeparado = /anotação do humano/i.test(texto);
    record(
      "D19",
      "CENÁRIO 19: colapsa os 3 do mesmo ator e NÃO engole o vizinho de outro ator",
      anunciaQuantos && vizinhoSeparado,
      `bloco anuncia a contagem=${anunciaQuantos} · a linha do humano continua visível=${vizinhoSeparado} ` +
        `· painel diz: "${texto.slice(0, 140)}"`,
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
      const { data: linha } = await admin.from("crm_leads").select("title").eq("id", caso.leadId).single();
      const persistiu = (linha as { title: string } | null)?.title === novo;
      const { data: ativs } = await admin
        .from("crm_lead_activities")
        .select("type,actor_kind")
        .eq("lead_id", caso.leadId);
      const humana = ((ativs ?? []) as { type: string; actor_kind: string }[]).find(
        (a) => a.actor_kind === "user" && a.type !== "note",
      );
      record(
        "D20",
        "CENÁRIO 20: editar campo salva E aparece na timeline com ator humano",
        persistiu && Boolean(humana),
        `persistiu=${persistiu} · atividade humana de edição=${humana ? humana.type : "NENHUMA"} — ` +
          `as duas metades falham separado: salvar pode funcionar e o registro não existir`,
      );
    }

    // ---- 23: o vazamento que teste curto NUNCA pega -------------------------
    //
    // Abrir e fechar UMA vez não revela assinatura que não é desfeita: o canal
    // órfão só incomoda quando se acumula. Então o instrumento faz o que o uso
    // real faz — abre e fecha várias vezes — e compara ENTRADAS com SAÍDAS.
    //
    // A contagem é de `phx_join` contra `phx_leave` no socket: se o Sheet
    // desassina, cada abertura tem a sua saída. Se não desassina, as entradas
    // crescem e as saídas não — e o número da diferença É o vazamento.
    let joins = 0;
    let leaves = 0;
    page.on("websocket", (ws) => {
      if (!ws.url().includes("supabase")) return;
      ws.on("framesent", (f) => {
        const t = String(f.payload);
        if (/phx_join/.test(t) && /timeline|lead|dossie/i.test(t)) joins++;
        if (/phx_leave/.test(t) && /timeline|lead|dossie/i.test(t)) leaves++;
      });
    });
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
  }

  const pass = resultados.filter((r) => r.estado === "PASS").length;
  const falha = resultados.filter((r) => r.estado === "FALHA").length;
  const bloq = resultados.filter((r) => r.estado === "BLOQUEADO").length;
  console.info(`\n=== WAVE 6: ${pass} verdes · ${falha} vermelhos · ${bloq} bloqueados ===`);
  for (const r of resultados.filter((x) => x.estado !== "PASS")) {
    console.info(`  ${r.estado} [${r.n}] ${r.nome}: ${r.detalhe}`);
  }
  if (falha > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("❌ Wave 6 falhou:", err);
  await limpar().catch(() => null);
  process.exit(1);
});
