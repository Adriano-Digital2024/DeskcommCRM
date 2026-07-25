/**
 * Helpers de prova visual do CRM Vivo — compartilhados pelos capturadores de wave.
 *
 * REGRA DE EVIDÊNCIA (§7): aqui não existe fallback silencioso. Se o alvo não
 * resolve, o script FALHA ALTO dizendo qual locator quebrou. Um `catch` que
 * degrada para um recorte pior produz artefato que existe e não prova nada.
 */

import type { Locator, Page } from "@playwright/test";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const PORT = process.env.E2E_PORT ?? "3020";
export const BASE = `http://localhost:${PORT}`;
export const EVIDENCE = path.join(process.cwd(), "evidence");
export const CREDS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
);

/**
 * Atributo do container arrastável do card. `@hello-pangea/dnd` usa o prefixo
 * `rfd` (não `rbd`, do `react-beautiful-dnd` original) — confirmado no DOM.
 */
export const CARD_ATTR = process.env.CARD_ATTR ?? "data-rfd-draggable-id";

/** TOTP RFC-6238 — só o admin tem MFA forçado; manager e viewer entram direto. */
function totp(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx >= 0) bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 1000 / 30), 4);
  const hmac = crypto.createHmac("sha1", bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** Login pela tela, como um usuário: digita, clica, e resolve MFA quando pedida. */
export async function login(page: Page, role: string): Promise<void> {
  await loginAs(page, {
    email: CREDS.users[role].email,
    password: CREDS.password,
    totpSecret: CREDS.admin_totp?.secret,
    rotulo: role,
  });
}

/**
 * Login com credenciais explícitas — serve qualquer tenant, não só a org de
 * teste. O segredo TOTP é por USUÁRIO: o produto exige 2FA de todo admin, e
 * usar o segredo do admin errado falha de um jeito que parece senha inválida.
 */
export async function loginAs(
  page: Page,
  cred: { email: string; password: string; totpSecret?: string; rotulo?: string },
): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(cred.email);
  await page.locator("#password").fill(cred.password);
  await page.getByRole("button", { name: /entrar/i }).click();

  // Espera por URL, não por visibilidade: correr `waitForURL` contra
  // `isVisible()` avalia o campo de OTP enquanto a página de MFA ainda monta, e
  // o login "passa" sem digitar o código — falha por corrida, não por senha.
  await page.waitForURL(/\/app\/|\/login\/mfa/, { timeout: 30_000 });
  const otp = page.locator('input[inputmode="numeric"], #code, input[name="code"]').first();
  if (/\/login\/mfa/.test(page.url())) {
    if (!cred.totpSecret) {
      throw new Error(`[login] ${cred.email} caiu na tela de MFA e não recebi segredo TOTP`);
    }
    await otp.waitFor({ state: "visible", timeout: 20_000 });
    // Campo de OTP por slots: digitar tecla a tecla; `fill` não dispara os
    // handlers e o botão fica desabilitado. O form auto-submete no 6º dígito.
    await otp.click();
    await page.keyboard.type(totp(cred.totpSecret), { delay: 80 });
    const verify = page.getByRole("button", { name: /verificar|confirmar|entrar/i }).first();
    if (
      (await verify.isVisible().catch(() => false)) &&
      (await verify.isEnabled().catch(() => false))
    ) {
      await verify.click().catch(() => null);
    }
    await page.waitForURL(/\/app\//, { timeout: 20_000 });
  }
  console.info(`[login] entrou como ${cred.email}${cred.rotulo ? ` (${cred.rotulo})` : ""} → ${page.url()}`);
}

/** Navega até o board de demonstração — só por clique, como um usuário. */
export async function gotoBoard(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Kanban", exact: true }).click();
  await page.waitForURL(/\/app\/kanban/, { timeout: 20_000 });
  await page.getByText(/CRM Vivo — Clínica/i).first().click();
  await page.waitForURL(/\/app\/pipelines\//, { timeout: 20_000 });
  if (!page.url().includes(CREDS.crm_vivo.pipeline_id)) {
    throw new Error(`clique levou a ${page.url()}, não ao pipeline do seed`);
  }
  await page.waitForLoadState("networkidle").catch(() => null);
  // `networkidle` não basta: o board hidrata e monta os cards depois. Esperar o
  // primeiro card é determinístico — sleep fixo aqui vira teste intermitente.
  await page
    .locator(`[${CARD_ATTR}]`)
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  const n = await page.locator(`[${CARD_ATTR}]`).count();
  console.info(`[nav] board por clique → ${page.url()} (${n} cards)`);
}

/** O card do board: o container arrastável, ancestral do título. */
export async function cardLocator(
  page: Page,
  title: string | RegExp,
): Promise<{ card: Locator; box: { width: number; height: number } }> {
  // NÃO usar getByRole("heading"): o card é role="button" (drag handle do dnd) e,
  // pela regra ARIA de "children presentational", o <h3> de dentro PERDE o papel
  // de heading assim que o dnd hidrata. O locator passava por corrida de timing —
  // resolvia antes da hidratação e sumia depois. Ancorar no container é estável.
  const card = page.locator(`[${CARD_ATTR}]`).filter({ hasText: title }).first();
  if ((await card.count()) === 0) {
    // A falha se autodiagnostica: lista os cards que existem de fato.
    const presentes = await page.locator(`[${CARD_ATTR}]`).allTextContents();
    throw new Error(
      `[evidencia] nenhum card [${CARD_ATTR}] casa com "${String(title)}".\n` +
        `Cards presentes (${presentes.length}):\n` +
        presentes.map((t) => `  - ${t.replace(/\s+/g, " ").slice(0, 70)}`).join("\n"),
    );
  }
  const box = await card.boundingBox();
  if (!box) throw new Error(`[evidencia] card "${String(title)}" sem boundingBox (invisível?)`);
  if (box.width < 200 || box.height < 80) {
    throw new Error(
      `[evidencia] recorte de ${Math.round(box.width)}x${Math.round(box.height)}px ` +
        `para "${String(title)}" — card não tem esse tamanho; o locator pegou um nó interno`,
    );
  }
  return { card, box };
}

/**
 * EVIDÊNCIA HISTÓRICA — artefatos que **não dá para regenerar**, porque o código
 * que produziu aquele estado não existe mais (o "antes" de uma wave passa a ser
 * histórico no instante em que a wave é commitada).
 *
 * A distinção que importa:
 *   REPRODUZÍVEL — basta rodar o script de novo. Sobrescrever é inofensivo.
 *   HISTÓRICA    — não regenera. Sobrescrever DESTRÓI a única cópia, e sem rastro
 *                  do que havia ali. É imutável por natureza; tratá-la como saída
 *                  de script é erro de categoria.
 */
const EVIDENCIA_HISTORICA = new Set([
  "wave-0-board-antes.png",
  "wave-0-board-antes-full.png",
  "wave-0-card-antes.png",
  "wave-0-card-titulo-longo-antes.png",
  "wave-0-navegacao.png",
]);

/**
 * Recusa sobrescrever evidência histórica — e diz QUAL arquivo e POR QUÊ.
 * Recusar em silêncio seria a mesma falha silenciosa que este projeto caça.
 */
function guardaEvidencia(file: string): void {
  if (!EVIDENCIA_HISTORICA.has(file)) return;
  const alvo = path.join(EVIDENCE, file);
  if (!fs.existsSync(alvo)) return;
  if (process.env.FORCE === "1") {
    console.info(`[evidencia] FORCE=1 — sobrescrevendo evidência histórica ${file}`);
    return;
  }
  throw new Error(
    `[evidencia] RECUSADO sobrescrever "${file}": é evidência HISTÓRICA — o código que ` +
      `produziu aquele estado não existe mais, então este PNG é a única cópia e não ` +
      `pode ser regenerado.\n` +
      `Se você realmente quer perder o "antes", rode com FORCE=1.`,
  );
}

/** Screenshot do card inteiro, com o retângulo validado antes de gravar. */
export async function shotCard(
  page: Page,
  title: string | RegExp,
  file: string,
): Promise<void> {
  guardaEvidencia(file);
  const { card, box } = await cardLocator(page, title);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(EVIDENCE, file) });
  console.info(
    `[evidencia] evidence/${file} — ${Math.round(box.width)}x${Math.round(box.height)}px (card inteiro)`,
  );
}

export async function shotPage(page: Page, file: string, fullPage = true): Promise<void> {
  guardaEvidencia(file);
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage });
  console.info(`[evidencia] evidence/${file}`);
}

/**
 * CARIMBO DE PROCEDÊNCIA — mecaniza a lei do §7.3/§7.11 em vez de confiar nela.
 *
 * Proposta do `@Arquiteto`, e o argumento dele é o que decide: o regente caiu na
 * própria regra com o time assistindo. Isso não é falta de rigor, é limite de
 * memória sob pressão — e a resposta para limite de memória é **artefato**, não
 * promessa. Custou duas linhas por sonda.
 *
 * Duas coisas acontecem aqui, e a segunda vale mais que a primeira:
 *
 * 1. Imprime o commit e o estado das dependências. Verde contra árvore suja
 *    deixa de ser possível de emitir sem aparecer.
 * 2. **Obriga a declarar de que arquivos a prova depende** — o que força a
 *    escrever a cadeia causal ANTES de medir. Foi exatamente isso que faltou nas
 *    duas vezes em que uma medição desta wave valeu para a versão errada.
 *
 * Devolve o sufixo que deve ir no NOME da evidência: com árvore suja, o print
 * nasce marcado como `-ARVORE-SUJA`. A evidência acusa a si mesma, em vez de
 * depender de alguém lembrar de ler o log.
 */
export function carimbar(dependencias: string[]): string {
  const head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  const sujos = execSync(`git status --porcelain -- ${dependencias.join(" ")}`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  console.info(`[carimbo] HEAD=${head}`);
  console.info(`[carimbo] dependências declaradas: ${dependencias.join(", ")}`);
  if (sujos.length === 0) {
    console.info("[carimbo] todas limpas — o veredito vale para este commit");
    return "";
  }
  // Grita. Não bloqueia: iterar com a árvore suja é legítimo enquanto se
  // desenvolve; o que não pode é o resultado sair parecendo veredito.
  console.info("[carimbo] ⚠ ÁRVORE SUJA nas dependências — este resultado NÃO é veredito:");
  for (const l of sujos) console.info(`[carimbo]   ${l}`);
  return "-ARVORE-SUJA";
}
