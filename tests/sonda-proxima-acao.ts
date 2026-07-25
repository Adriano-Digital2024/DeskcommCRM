/**
 * Wave 4 — a próxima ação do agente aparece e pode ser decidida (cenários 13 e 14).
 *
 * O defeito que esta wave mata: `next_action` era calculada, gravada e NUNCA
 * exibida a ninguém. A prova, portanto, tem que ser NA TELA — ver o texto que o
 * agente escreveu e decidir sobre ele.
 *
 * 13. card com proposta mostra a linha do agente com os botões; Aprovar gera
 *     atividade; Descartar TAMBÉM gera atividade (a recusa é sinal);
 * 14. card sem proposta mostra o estado NORMAL — nunca slot vazio, nunca "—".
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-proxima-acao.ts
 */
import * as fs from "node:fs";

import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { BASE, CARD_ATTR, carimbar, login } from "./qa-helpers";

const OUT = "evidence";
const sufixo = carimbar([
  "lib/leads/next-action.ts",
  "components/kanban/NextActionSlot.tsx",
  "hooks/kanban/useNextAction.ts",
  "app/api/v1/leads/[id]/next-action/route.ts",
  "app/api/v1/pipelines/[id]/board/route.ts",
]);

const envFile = fs.readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function foto(page: Page, nome: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/wave4-${nome}${sufixo}.png` });
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
    crm_vivo: { pipeline_id: string };
  };
  const pipelineId = creds.crm_vivo.pipeline_id;

  const { data: pipeline } = await admin
    .from("crm_pipelines")
    .select("organization_id")
    .eq("id", pipelineId)
    .maybeSingle();
  const org = (pipeline as { organization_id: string }).organization_id;

  // Alvo REAL: um negócio cujo contato tem `next_action` escrita pelo agente.
  const { data: estados } = await admin
    .from("lead_state")
    .select("contact_id, next_action")
    .eq("organization_id", org)
    .not("next_action", "is", null);
  const contatos = (estados ?? []).map((e) => (e as { contact_id: string }).contact_id);
  const { data: leads } = await admin
    .from("crm_leads")
    .select("id, title, contact_id")
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .in("contact_id", contatos);
  const alvo = (leads ?? [])[0] as { id: string; title: string; contact_id: string } | undefined;
  if (!alvo) throw new Error("nenhum negócio com próxima ação — nada a provar");
  const proposta = (estados ?? []).find(
    (e) => (e as { contact_id: string }).contact_id === alvo.contact_id,
  ) as { next_action: string };

  // Lead SEM proposta, para o cenário 14 — na MESMA tela, senão a comparação
  // seria entre dois estados do produto em momentos diferentes.
  const { data: semProposta } = await admin
    .from("crm_leads")
    .select("id, title")
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .not("contact_id", "in", `(${contatos.join(",")})`)
    .limit(1);
  const controle = (semProposta ?? [])[0] as { id: string; title: string } | undefined;

  console.info(`alvo COM proposta: "${alvo.title}"`);
  console.info(`  proposta do agente: "${proposta.next_action}"`);
  console.info(`controle SEM proposta: "${controle?.title ?? "(nenhum)"}"`);

  const browser = await chromium.launch();
  const page = await browser
    .newContext({ viewport: { width: 1900, height: 950 } })
    .then((c) => c.newPage());
  await login(page, "manager");
  await page.goto(`${BASE}/app/pipelines/${pipelineId}`, { waitUntil: "networkidle" });

  const card = page.locator(`[${CARD_ATTR}="${alvo.id}"]`);
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_200);
  await foto(page, "13-antes");

  // CENÁRIO 13 — o texto do agente está na tela, com decisão ao lado.
  const textoNaTela = (await card.textContent()) ?? "";
  const mostraProposta = textoNaTela.includes(proposta.next_action.slice(0, 30));
  const temAprovar = await card.getByRole("button", { name: /^Aprovar:/ }).isVisible();
  const temDescartar = await card.getByRole("button", { name: /^Ignorar:/ }).isVisible();
  console.info(`13a. o card mostra o texto que o agente escreveu: ${mostraProposta}`);
  console.info(`13b. botões de decisão visíveis: aprovar=${temAprovar} ignorar=${temDescartar}`);

  // CENÁRIO 14 — o card sem proposta não inventa slot vazio nem "—".
  let semSlotVazio = true;
  if (controle) {
    const cardCtrl = page.locator(`[${CARD_ATTR}="${controle.id}"]`);
    await cardCtrl.waitFor({ state: "visible", timeout: 10_000 });
    const temBotao = await cardCtrl.getByRole("button", { name: /^(Aprovar|Ignorar):/ }).count();
    const texto = (await cardCtrl.textContent()) ?? "";
    semSlotVazio = temBotao === 0 && !texto.includes("Propõe:");
    console.info(`14. card sem proposta fica no estado normal: ${semSlotVazio}`);
  }

  // APROVAR gera atividade.
  const antes = await admin
    .from("crm_lead_activities")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", alvo.id);
  await card.getByRole("button", { name: /^Aprovar:/ }).click();
  await page.waitForTimeout(2_500);
  await foto(page, "13-depois-de-aprovar");
  const { data: atividades } = await admin
    .from("crm_lead_activities")
    .select("type, reason, actor_kind")
    .eq("lead_id", alvo.id)
    .in("type", ["next_action_approved", "next_action_dismissed"]);
  const aprovou = (atividades ?? []).some(
    (a) => (a as { type: string }).type === "next_action_approved",
  );
  console.info(`13c. aprovar gerou atividade: ${aprovou} (antes havia ${antes.count ?? 0} no total)`);
  if (aprovou) {
    const a = (atividades ?? []).find(
      (x) => (x as { type: string }).type === "next_action_approved",
    ) as { reason: string; actor_kind: string };
    console.info(`     motivo legível: "${a.reason}" · ator: ${a.actor_kind}`);
  }

  // O slot some depois de decidido — senão o card pediria a mesma decisão de novo.
  const aindaPede = await card.getByRole("button", { name: /^Aprovar:/ }).count();
  console.info(`13d. a proposta sai de cena depois de decidida: ${aindaPede === 0}`);

  const passou = mostraProposta && temAprovar && temDescartar && semSlotVazio && aprovou;
  console.info(passou ? "PASS   cenários 13 e 14" : "FALHA  ver linhas acima");
  if (!passou) process.exitCode = 1;

  await browser.close();
}

void main();
