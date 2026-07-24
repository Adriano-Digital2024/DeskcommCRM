/**
 * Radar de Risco (C1 — desilhamento da doutrina do sistema vivo). Prova, na
 * perspectiva do usuário real: o atendente entra no Radar e VÊ a demanda aberta
 * que esfriou (5 dias sem atividade, sem próximo passo) — o que antes morria
 * invisível no engine. Login como manager (sem MFA; vê todos os leads da org).
 *
 * Pré-requisito: seed de credenciais + seed do radar (rodados aqui se faltarem).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  radar?: { at_risk_title: string };
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsBase()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.radar?.at_risk_title) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-radar.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("o atendente vê no Radar a demanda aberta que esfriou sem próximo passo", async ({ page }) => {
  await login(page, creds.users.manager!.email);

  // Navega pelo menu lateral — como um usuário real, não por deep-link.
  await page.getByRole("link", { name: "Radar" }).click();
  await page.waitForURL(/\/app\/radar/);
  await expect(page.getByRole("heading", { name: "Radar de risco" })).toBeVisible();

  // A demanda em risco seedada aparece como um item do radar.
  const item = page.locator('[data-testid="radar-item"]', {
    hasText: creds.radar!.at_risk_title,
  });
  await expect(item).toBeVisible();

  // ...classificada como crítica e sinalizada como sem próximo passo agendado.
  await expect(item).toHaveAttribute("data-risk", "critico");
  await expect(item.getByText("Crítico")).toBeVisible();
  await expect(item.getByText(/Sem próximo passo/)).toBeVisible();
});
