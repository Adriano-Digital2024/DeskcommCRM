/**
 * Sonda do orquestrador — a aba que AGE pulsa? (critério 12.c)
 *
 * O `@QAVivo` mediu 1 início de animação na própria aba que moveu o card. Isso
 * é defeito **se** a ação passou pelo caminho da interface — que é o único que
 * marca o eco local. Se a ação foi por outro caminho (API, update direto), o
 * produto nunca prometeu suprimir nada, e o vermelho seria artefato do teste.
 *
 * Aqui a ação é a da INTERFACE, pelo teclado: `Space` levanta, `ArrowRight`
 * move, `Space` solta — o mesmo `onDragEnd` do arrasto com mouse, e portanto o
 * mesmo `useMoveCard` que chama `marcarEcoLocal`. Arrasto por teclado é caminho
 * de usuário de verdade, não atalho de teste.
 *
 * DUAS PERNAS, senão o verde é vácuo: contar zero pulsos num arrasto que não
 * aconteceu provaria nada. Exige-se que o card TENHA MUDADO de coluna.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-pulso-local.ts
 */
import * as fs from "node:fs";

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { BASE, CARD_ATTR, login } from "./qa-helpers";

const envFile = fs.readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main(): Promise<void> {
  // Lead do PRIMEIRO estágio: `ArrowRight` precisa ter para onde ir. Pegar o
  // "mais recente" pegaria um card que já pode estar na última coluna, e o
  // arrasto não aconteceria — a sonda diria "0 pulsos" sobre uma ação que nunca
  // ocorreu, que é o verde vácuo de novo.
  const { data: stages } = await admin
    .from("crm_stages")
    .select("id, pipeline_id, position")
    .order("position", { ascending: true });
  const primeiro = stages?.[0];
  if (!primeiro) throw new Error("sem estágio");
  const { data: leads } = await admin
    .from("crm_leads")
    .select("id, title, stage_id, pipeline_id")
    .eq("stage_id", primeiro.id)
    .limit(1);
  const lead = leads?.[0];
  if (!lead) throw new Error("sem lead no primeiro estágio");
  console.info(`alvo: "${lead.title}" no primeiro estágio`);

  const browser = await chromium.launch();
  const page = await browser
    .newContext({ viewport: { width: 1440, height: 900 } })
    .then((c) => c.newPage());
  await login(page, "admin");
  await page.goto(`${BASE}/app/pipelines/${lead.pipeline_id}`, { waitUntil: "networkidle" });

  const card = page.locator(`[${CARD_ATTR}="${lead.id}"]`).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });

  // Conta o EVENTO NATIVO, não amostragem — a lei que o @QAVivo derivou hoje:
  // amostrar uma animação de 320ms com régua mais lenta inventa o resultado.
  await page.evaluate(() => {
    (window as unknown as { __pulsos: number }).__pulsos = 0;
    document.addEventListener(
      "animationstart",
      (e) => {
        if ((e.target as HTMLElement)?.hasAttribute?.("data-pulse")) {
          (window as unknown as { __pulsos: number }).__pulsos += 1;
        }
      },
      true,
    );
  });

  // AÇÃO DA INTERFACE, pelo teclado — mesmo onDragEnd do mouse.
  await card.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");

  // Perna 1: o movimento ACONTECEU? Sem isto, "zero pulsos" não prova nada.
  await page.waitForResponse((r) => r.url().includes("/move") && r.request().method() === "POST", {
    timeout: 20_000,
  });
  const { data: depois } = await admin
    .from("crm_leads")
    .select("stage_id")
    .eq("id", lead.id)
    .maybeSingle();
  const mudou = depois?.stage_id !== lead.stage_id;

  // Janela generosa: o evento volta pelo realtime e o pulso duraria 1,2s.
  await page.waitForTimeout(4_000);
  const pulsos = await page.evaluate(
    () => (window as unknown as { __pulsos: number }).__pulsos,
  );

  console.info(`card mudou de coluna: ${mudou ? "SIM" : "NÃO"}`);
  console.info(`inícios de animação na PRÓPRIA aba: ${pulsos}`);
  if (!mudou) {
    console.info("INCONCLUSIVO — o arrasto não moveu o card; contagem não significa nada");
    process.exitCode = 1;
  } else {
    console.info(
      pulsos === 0
        ? "PASS   a aba que agiu NÃO pulsou — o eco local suprimiu, como prometido"
        : `FALHA  a aba que agiu pulsou (${pulsos}) — ruído com cara de novidade`,
    );
    if (pulsos > 0) process.exitCode = 1;
  }

  await browser.close();
}

void main();
