/**
 * A lista de colunas de `ai_agent_versions` está copiada em 7 arquivos (as rotas
 * REST, a server action e a página do agente). Adicionar uma coluna nova em
 * apenas alguns deles não quebra typecheck nem teste nenhum — o sintoma aparece
 * só na tela, como um campo que "se desmarca sozinho" depois do refresh, e o
 * save seguinte grava o valor errado por cima.
 *
 * Foi exatamente o que aconteceu com `cases_enabled` (spec 15, Wave 5): entrou
 * em 2 dos 7 arquivos. Este teste trava a divergência de qualquer coluna futura,
 * não só dessa — enquanto as cópias existirem, elas têm que ser idênticas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Todo arquivo que carrega uma cópia da lista de colunas de versão. */
const FILES_WITH_VERSION_COLUMNS = [
  "app/app/ai/agents/[id]/_actions.ts",
  "app/app/ai/agents/[id]/page.tsx",
  "app/api/v1/ai/agents/route.ts",
  "app/api/v1/ai/agents/[id]/versions/route.ts",
  "app/api/v1/ai/agents/[id]/versions/[vid]/route.ts",
  "app/api/v1/ai/agents/[id]/duplicate/route.ts",
];

/** Extrai o conteúdo da string atribuída a VERSION_COLUMNS. */
function versionColumnsOf(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const match = /VERSION_COLUMNS\s*(?::\s*string)?\s*=\s*\n?\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error(`VERSION_COLUMNS não encontrado em ${relPath}`);
  }
  return (match[1] ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

describe("VERSION_COLUMNS de ai_agent_versions", () => {
  it("é idêntico em todos os arquivos que o copiam", () => {
    const [firstFile, ...restFiles] = FILES_WITH_VERSION_COLUMNS;
    if (firstFile === undefined) throw new Error("lista de arquivos vazia");
    const expected = versionColumnsOf(firstFile);
    expect(expected.length).toBeGreaterThan(10);

    for (const file of restFiles) {
      const columns = versionColumnsOf(file);
      // Compara como conjunto ordenado: ordem no SELECT não importa, presença sim.
      expect({ file, columns: [...columns].sort() }).toEqual({
        file,
        columns: [...expected].sort(),
      });
    }
  });

  it("inclui as flags por-agente que a tela edita", () => {
    // Regressão direta do bug do cases_enabled: uma flag que a tela grava mas o
    // SELECT não devolve volta como `false` no próximo render.
    for (const file of FILES_WITH_VERSION_COLUMNS) {
      const columns = versionColumnsOf(file);
      expect(columns).toContain("handoff_tool_enabled");
      expect(columns).toContain("cases_enabled");
    }
  });
});
