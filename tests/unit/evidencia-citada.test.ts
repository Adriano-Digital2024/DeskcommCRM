/**
 * O handoff não aponta para o vazio.
 *
 * Regra enunciada nesta wave: **imagem citada num documento é lastro de
 * afirmação; imagem não citada é artefato de build.** A primeira entra no
 * repositório, a segunda fica fora (o `evidence/` inteiro são 6,7 MB, e num
 * projeto aberto `git` não esquece — todo mundo que clonar paga esse peso para
 * sempre, por imagem que ninguém cita).
 *
 * O achado do `@MaestroConexoes` é que a regra **vazou minutos depois de ser
 * enunciada**, na mesma leva em que foi aplicada: seis referências continuaram
 * apontando para arquivos fora do versionamento.
 *
 * Daí este teste, e não uma promessa. Nas palavras dele: *"enquanto a regra
 * viver só no critério de alguém, ela decai exatamente como decaiu agora, e
 * ninguém percebe até alguém clicar num caminho morto daqui a semanas."*
 *
 * É um check que **DECIDE** — não que relata. Foi essa a diferença que ele
 * mesmo apontou na sonda do veto uma hora antes: valor calculado que só é
 * impresso é enfeite que passa por cobertura.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const DOCS = ["HANDOFF-crm-vivo.md", "BRIEFING-crm-vivo.md", "HANDOFF-lgpd.md"];

/** Tudo que o git ENTREGA — não o que o disco tem. */
function versionados(): Set<string> {
  const saida = execFileSync("git", ["ls-files", "evidence/"], { cwd: RAIZ, encoding: "utf8" });
  return new Set(saida.split("\n").filter(Boolean));
}

/** Referências a imagens de evidência dentro dos documentos da entrega. */
function citadas(doc: string): string[] {
  const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");
  const achados = texto.match(/evidence\/[\w./-]+\.png/g) ?? [];
  return [...new Set(achados)];
}

describe("evidência citada", () => {
  for (const doc of DOCS) {
    it(`${doc} não cita imagem fora do versionamento`, () => {
      if (!fs.existsSync(path.join(RAIZ, doc))) return;
      const noGit = versionados();
      const mortas = citadas(doc).filter((ref) => !noGit.has(ref));
      expect(
        mortas,
        `${doc} aponta para imagem que não está em git ls-files — quem clonar acha o vazio:\n` +
          mortas.map((m) => `  ${m}`).join("\n"),
      ).toEqual([]);
    });
  }
});
