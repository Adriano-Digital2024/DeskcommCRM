/**
 * A REDE DE SEGURANÇA, provada matando a entrega.
 *
 * O cenário é o defeito do dia: o canal está vivo (SUBSCRIBED) e não entrega
 * nada. Hoje o board fica congelado num passado que parece presente — nem
 * voltar para a aba conserta.
 *
 * Como se mata a entrega SEM mexer no código sob teste: bloqueando o WebSocket
 * do lado do navegador. O canal nunca recebe evento, e o resto da página segue
 * igual — que é exatamente a condição real.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { BASE, CARD_ATTR, login } from "./qa-helpers";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const ORG = "6e567068-fd1c-4f94-ae1f-40e0334be190";
const PIPE = "35bf4ac9-c5e0-4f7d-846a-99b1bcc92d69";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "manager");

  const MATAR = process.env.ENTREGA !== "viva";
  console.info(MATAR ? "modo: ENTREGA MORTA" : "modo: ENTREGA VIVA (controle)");
  // MATA A ENTREGA com a ferramenta que existe para isso: `routeWebSocket`
  // intercepta o WS de verdade. As duas tentativas anteriores foram descartadas
  // e o motivo importa:
  //   `page.route`        → intercepta HTTP e NÃO WebSocket. O canal entregou
  //                         normalmente e o "curou" era o realtime funcionando.
  //   `throw` no construtor → derrubava a página com Runtime Error do Next, o
  //                         que é OUTRA condição: app quebrado, não canal mudo.
  //   stub artesanal      → o socket seguia `subscribed`, então nem estava
  //                         sendo usado — eu media um canal vivo achando que
  //                         estava morto.
  // O defeito real é um canal que CONECTA e não entrega; é isso que se simula.
  if (MATAR) {
    await page.routeWebSocket(/realtime/, (ws) => {
      // Não conecta ao servidor: o handshake do cliente completa e nada chega.
      void ws;
    });
  }
  console.info(MATAR ? "modo: ENTREGA MORTA" : "modo: ENTREGA VIVA (controle)");

  await page.goto(`${BASE}/app/pipelines/${PIPE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  const board = page.locator("[data-refetch-divergencias]").first();
  const antes = {
    divergencias: await board.getAttribute("data-refetch-divergencias"),
    cards: await page.locator(`[${CARD_ATTR}]`).count(),
  };
  console.info(`ANTES · cards=${antes.cards} · divergências=${antes.divergencias}`);

  // Um lead NOVO entra pelo banco. Com a entrega morta, o canal não avisa.
  const { data: st } = await admin
    .from("crm_stages").select("id").eq("pipeline_id", PIPE).order("position").limit(1).maybeSingle();
  const leadId = randomUUID();
  await admin.from("crm_leads").insert({
    id: leadId, organization_id: ORG, pipeline_id: PIPE,
    stage_id: (st as { id: string }).id,
    title: `rede de seguranca ${new Date().toISOString().slice(11, 19)}`,
    position_in_stage: 1,
  });
  console.info("· lead criado com a ENTREGA MORTA (websocket bloqueado)");

  // 8s: o canal teria entregue em ~2s se estivesse vivo.
  await page.waitForTimeout(8000);
  const semRede = await page.locator(`[${CARD_ATTR}="${leadId}"]`).count();
  console.info(`1. o canal trouxe? ${semRede ? "SIM" : "NÃO"} ${MATAR ? (semRede ? "← o bloqueio falhou" : "— morta, como planejado") : (semRede ? "— viva, como esperado" : "← o canal deveria ter trazido")}`);

  // A REDE roda a cada 45s; volto para a aba para exercitar o outro gatilho.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(6000);

  const depois = {
    divergencias: await board.getAttribute("data-refetch-divergencias"),
    apareceu: await page.locator(`[${CARD_ATTR}="${leadId}"]`).count(),
  };
  console.info(`2. a rede CUROU? ${depois.apareceu ? "SIM — o card apareceu sem reload" : "NÃO ← a tela segue congelada"}`);
  console.info(`3. a rede DENUNCIOU? divergências ${antes.divergencias} → ${depois.divergencias}`);
  await page.screenshot({ path: "evidence/wave7-rede-de-seguranca.png" });

  await admin.from("crm_leads").delete().eq("id", leadId);
  await browser.close();
}
void main();
