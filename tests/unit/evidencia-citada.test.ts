/**
 * Nenhum documento versionado aponta para imagem que o repositório não entrega.
 *
 * Regra: **imagem citada num documento é lastro de afirmação; imagem não citada é
 * artefato de build.** A primeira entra no repositório, a segunda fica fora — num
 * projeto aberto `git` não esquece, e todo clone pagaria para sempre o peso de
 * imagem que ninguém cita.
 *
 * É um check que **DECIDE**, não que relata. E ele já pegou, nesta ordem: seis
 * referências mortas do handoff; depois quatro documentos inteiros, quando parou
 * de casar só `evidence/*.png`; e depois os quatro buracos abaixo, achados pelo
 * `@MaestroConexoes` numa revisão pedida.
 *
 * > *"Todo guarda novo começa com a cobertura que o autor enxergava no momento, e
 * > o teste do dia seguinte é sempre 'o que EU não estava olhando quando escrevi
 * > isto'."*
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Tudo que o git ENTREGA — não o que o disco tem. */
function versionados(padrao: string): string[] {
  return execFileSync("git", ["ls-files", padrao], { cwd: RAIZ, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/**
 * Formatos que valem como prova. `.png` sozinho deixaria passar gravação de tela
 * (`gif`/`webm`), que o `§7` pede no cenário 23 — hoje ninguém cita, mas a vala
 * fica aberta para a wave 7 se o padrão não crescer junto.
 *
 * Duas constantes de propósito: a global serve para EXTRAIR (precisa de `g`), e a
 * simples serve para TESTAR — `RegExp` com `g` guarda `lastIndex` entre chamadas
 * e `.test()` passa a alternar resultado. Reaproveitar uma só aqui seria um bug
 * que só aparece a partir do segundo documento.
 */
const IMG_EXTRAI = /[\w./-]*[\w-]+\.(?:png|jpe?g|gif|webp|webm|svg)/gi;
const IMG_TESTA = /[\w./-]*[\w-]+\.(?:png|jpe?g|gif|webp|webm|svg)/i;

/**
 * Os documentos são DESCOBERTOS, não listados.
 *
 * A lista fixa anterior enunciava um princípio universal (*"citação morta é
 * citação morta em qualquer documento"*) e aplicava a sete arquivos escolhidos a
 * mão. Ficavam de fora `evidence/README.md` — dentro da própria pasta que o teste
 * protege — e `HANDOFF-wave1-devvivo.md`. Pior: a narrativa da wave seguinte
 * **nasceria descoberta**, e ninguém lembraria de editar a lista.
 */
const DOCS = versionados("*.md").filter((d) =>
  IMG_TESTA.test(fs.readFileSync(path.join(RAIZ, d), "utf8")),
);


/**
 * DÍVIDA PRÉ-EXISTENTE, enumerada — não escondida.
 *
 * Ao passar a descobrir os documentos em vez de listá-los, o check revelou que a
 * doença é do REPOSITÓRIO, não desta entrega: 15 documentos de outras épicas
 * citam evidência que nunca foi versionada. Nenhum deles é do CRM Vivo — o único
 * que era (`HANDOFF-wave1-devvivo.md`) citava três imagens pelos nomes errados,
 * sem o prefixo `devvivo-`, e foi corrigido.
 *
 * Publicar o portão duro contra todos quebraria a suíte de todo mundo por dívida
 * que não é de quem está entregando. Excluí-los em silêncio seria a lista
 * arbitrária que esta wave já reprovou. A saída é **quarentena enumerada**: o
 * portão fica duro para tudo o que nasce daqui em diante, e o passivo fica
 * VISÍVEL e CONTÁVEL.
 *
 * E ela NÃO APODRECE: o teste abaixo exige que documento em quarentena AINDA
 * tenha referência morta. Consertou? Sai da lista, ou o vermelho aparece. Lista
 * de exceção que ninguém revisa vira permissão permanente — esta se cobra
 * sozinha.
 */
const LEGADO = new Set([
  ".claude/agents/gov-implementer.md",
  "HANDOFF-harness-evolution.md",
  "HANDOFF-inbox-multimodal.md",
  "HANDOFF-operacao-visivel.md",
  "HANDOFF.md",
  "docs/stories/epics/EPIC-03-inbox-messaging.md",
  "docs/superpowers/handoffs/2026-07-17-webhooks.md",
  "docs/superpowers/plans/2026-07-21-onda0-fundacao-midia.md",
  "docs/superpowers/plans/2026-07-21-onda2-composer-whatsapp.md",
  "docs/superpowers/plans/2026-07-22-onda3-agente-multimodal.md",
  "docs/superpowers/plans/2026-07-24-harness-fase2-skills.md",
  "loop/checkpoints/G2-report.md",
  "loop/checkpoints/G4-report.md",
  "loop/checkpoints/G5-report.md",
  "plan/progress.md",
]);

/**
 * Referências normalizadas para o caminho do repositório.
 *
 * **Só normaliza quem NÃO tem diretório próprio.** A versão anterior jogava toda
 * referência sem prefixo para `evidence/<basename>` — inofensivo enquanto a lista
 * era curta, e uma máquina de falso positivo assim que ela crescesse: há
 * documentos citando imagens que vivem fora de `evidence/`, e o teste as
 * reescreveria, não as acharia, e reprovaria documentos corretos **por um caminho
 * que ele mesmo inventou**. Reprovar por motivo errado é tão ruim quanto passar
 * por motivo errado.
 */
function citadas(doc: string): string[] {
  const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");
  const dir = path.posix.dirname(doc);
  const refs = texto.match(IMG_EXTRAI) ?? [];
  return [
    ...new Set(
      refs.map((ref) => {
        const limpa = ref.replace(/^\.\//, "");
        // Tem diretório próprio? Respeita. Senão, resolve contra a pasta do doc.
        return limpa.includes("/") ? limpa : path.posix.join(dir === "." ? "evidence" : dir, limpa);
      }),
    ),
  ];
}

describe("evidência citada", () => {
  it("a descoberta de documentos não pode vir vazia", () => {
    // Sem esta guarda, um erro no `git ls-files` ou no filtro faria a suíte
    // inteira passar sem verificar nada — verde vácuo no nível do arquivo.
    expect(DOCS.length, "nenhum documento versionado citando imagem foi encontrado").toBeGreaterThan(
      0,
    );
  });

  for (const doc of DOCS) {
    it(`${doc} não cita imagem fora do versionamento`, () => {
      // Documento da lista que não existe é erro da LISTA, e alguém precisa
      // saber. A versão anterior fazia `return` em silêncio: renomear um handoff
      // evaporava a cobertura dele sem nada ficar vermelho.
      const caminho = path.join(RAIZ, doc);
      expect(fs.existsSync(caminho), `${doc} está em git ls-files e não existe no disco`).toBe(true);

      const entregues = new Set(versionados("."));
      const mortas = citadas(doc).filter((ref) => !entregues.has(ref));

      if (LEGADO.has(doc)) {
        // Quarentena auto-limpante: se este documento ficou limpo, ele PRECISA
        // sair da lista — senão a exceção sobrevive ao motivo que a criou.
        expect(
          mortas.length,
          `${doc} está em LEGADO e já não tem referência morta — REMOVA-O da lista`,
        ).toBeGreaterThan(0);
        return;
      }

      expect(
        mortas,
        `${doc} aponta para arquivo que não está em git ls-files — quem clonar acha o vazio:\n` +
          mortas.map((m) => `  ${m}`).join("\n"),
      ).toEqual([]);
    });
  }
});
