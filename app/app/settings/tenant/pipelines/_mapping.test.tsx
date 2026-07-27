/**
 * A tela do funil do agente — o que ela OFERECE e o que ela ENVIA.
 *
 * Estes testes cobrem as três decisões que só existem aqui, na tela: transformar
 * a recusa do banco em ausência de opção, mandar sempre os sete passos (com
 * `null` explícito), e reler o servidor depois de qualquer erro em vez de deixar
 * o usuário reenviar sobre um funil que mudou embaixo dele.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import type { EstadoDoMapeamento } from "@/hooks/pipelines/useAgentMapping";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { AgentMappingSection, opcoesDoPasso, motivoDaListaVazia } from "./_mapping";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PIPE = "11111111-1111-4111-8111-111111111111";

const ETAPAS = [
  { id: "e1", name: "Carrinho abandonado", is_won: false, is_lost: false },
  { id: "e2", name: "Aguardando pagamento", is_won: false, is_lost: false },
  { id: "e3", name: "Pago", is_won: true, is_lost: false },
  { id: "e4", name: "Cancelado", is_won: false, is_lost: true },
];

const VAZIO = {
  new: null,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: null,
  lost: null,
};

function estado(over: Partial<EstadoDoMapeamento["mapeamento"]> = {}): EstadoDoMapeamento {
  return { etapas: ETAPAS, mapeamento: { ...VAZIO, ...over } };
}

function montar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentMappingSection pipelineId={PIPE} />
    </QueryClientProvider>,
  );
}

/** Abre o seletor de um passo e devolve os textos das opções oferecidas. */
async function opcoesNaTela(user: ReturnType<typeof userEvent.setup>, passo: string) {
  await user.click(screen.getByTestId(`etapa-${passo}`));
  const lista = await screen.findByRole("listbox");
  return within(lista)
    .getAllByRole("option")
    .map((o) => o.textContent);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: estado() });
});

describe("opcoesDoPasso — a recusa do banco vira ausência de opção", () => {
  it("etapa já escolhida por outro passo some das demais listas", () => {
    const mapa = { ...VAZIO, contacted: "e1" };
    expect(opcoesDoPasso("qualifying", ETAPAS, mapa).map((e) => e.id)).toEqual(["e2"]);
    // …e continua na lista do passo que a escolheu, senão o seletor ficaria sem
    // rótulo para o próprio valor.
    expect(opcoesDoPasso("contacted", ETAPAS, mapa).map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("desfazer a escolha devolve a etapa às outras listas", () => {
    expect(opcoesDoPasso("qualifying", ETAPAS, { ...VAZIO, contacted: "e1" }).map((e) => e.id))
      .toEqual(["e2"]);
    expect(opcoesDoPasso("qualifying", ETAPAS, VAZIO).map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("«Ganho» só oferece etapa de fechamento; «Perdido» só a de perda", () => {
    expect(opcoesDoPasso("won", ETAPAS, VAZIO).map((e) => e.id)).toEqual(["e3"]);
    expect(opcoesDoPasso("lost", ETAPAS, VAZIO).map((e) => e.id)).toEqual(["e4"]);
  });

  it("os outros cinco passos NUNCA oferecem a etapa de ganho nem a de perda", () => {
    // O CHECK da 0084 vale nos dois sentidos: etapa de ganho só representa
    // «Ganho». Oferecê-la aqui deixaria o usuário escolher para receber um 422.
    for (const passo of ["new", "contacted", "qualifying", "qualified", "negotiating"] as const) {
      expect(opcoesDoPasso(passo, ETAPAS, VAZIO).map((e) => e.id)).toEqual(["e1", "e2"]);
    }
  });

  it("mantém a ordem do funil que o servidor mandou, sem reordenar", () => {
    const embaralhado = [ETAPAS[2]!, ETAPAS[1]!, ETAPAS[0]!, ETAPAS[3]!];
    expect(opcoesDoPasso("new", embaralhado, VAZIO).map((e) => e.id)).toEqual(["e2", "e1"]);
  });
});

describe("motivoDaListaVazia — lista vazia sempre explica por quê", () => {
  it("funil sem etapa de fechamento explica o fato, sem prometer tela que não existe", () => {
    const t = motivoDaListaVazia("won", [ETAPAS[0]!, ETAPAS[3]!]);
    expect(t).toContain("nenhuma etapa marcada como fechamento");
    expect(t).not.toContain("já estão sendo usadas");
  });

  it("etapas todas em uso diz que dá para liberar uma", () => {
    const t = motivoDaListaVazia("qualifying", ETAPAS);
    expect(t).toContain("já estão sendo usadas");
  });
});

describe("AgentMappingSection — o que a tela oferece e envia", () => {
  it("«não mover» é a escolha inicial e não é apresentado como erro", async () => {
    montar();
    expect(await screen.findByTestId("etapa-new")).toHaveTextContent("Não mover o card");
    expect(screen.getByText(/Deixar em «não mover» é uma escolha válida/)).toBeInTheDocument();
    expect(screen.queryByTestId("mapeamento-erro")).not.toBeInTheDocument();
    // Nada a salvar enquanto o usuário não mexeu.
    expect(screen.getByTestId("salvar-mapeamento")).toBeDisabled();
  });

  it("etapa escolhida some das outras listas e volta quando desfeita", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("etapa-new");

    expect(await opcoesNaTela(user, "qualifying")).toEqual([
      "Não mover o card",
      "Carrinho abandonado",
      "Aguardando pagamento",
    ]);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("etapa-new"));
    await user.click(await screen.findByRole("option", { name: "Carrinho abandonado" }));

    expect(await opcoesNaTela(user, "qualifying")).toEqual([
      "Não mover o card",
      "Aguardando pagamento",
    ]);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("etapa-new"));
    await user.click(await screen.findByRole("option", { name: "Não mover o card" }));

    expect(await opcoesNaTela(user, "qualifying")).toEqual([
      "Não mover o card",
      "Carrinho abandonado",
      "Aguardando pagamento",
    ]);
  });

  it("«Ganho» não oferece etapa comum — só a de fechamento", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("etapa-won");
    expect(await opcoesNaTela(user, "won")).toEqual(["Não mover o card", "Pago"]);
  });

  it("salva os SETE passos, com null explícito no que ficou sem etapa", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.put).mockResolvedValue({ data: estado({ new: "e1" }) });
    montar();
    await screen.findByTestId("etapa-new");

    await user.click(screen.getByTestId("etapa-new"));
    await user.click(await screen.findByRole("option", { name: "Carrinho abandonado" }));
    await user.click(screen.getByTestId("salvar-mapeamento"));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalledTimes(1));
    const [rota, corpo] = vi.mocked(apiClient.put).mock.calls[0]!;
    expect(rota).toBe(`/api/v1/pipelines/${PIPE}/agent-mapping`);
    expect(corpo).toEqual({
      mapeamento: {
        new: "e1",
        contacted: null,
        qualifying: null,
        qualified: null,
        negotiating: null,
        won: null,
        lost: null,
      },
    });
  });

  it("depois de um erro, RELÊ o servidor e o rascunho vira o que está gravado", async () => {
    const user = userEvent.setup();
    // Enquanto o usuário editava, outra pessoa mapeou «Novo lead» para outra
    // etapa. Se a tela mantivesse o rascunho, o segundo envio gravaria por cima.
    vi.mocked(apiClient.put).mockRejectedValue(
      new ApiError(409, "state_conflict", undefined, "req-1", "A etapa «Pago» mudou de papel."),
    );
    montar();
    await screen.findByTestId("etapa-new");

    await user.click(screen.getByTestId("etapa-new"));
    await user.click(await screen.findByRole("option", { name: "Carrinho abandonado" }));
    expect(screen.getByTestId("etapa-new")).toHaveTextContent("Carrinho abandonado");

    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({ new: "e2" }) });
    await user.click(screen.getByTestId("salvar-mapeamento"));

    // A mensagem do servidor chega inteira ao usuário (é ela que ensina o quê fazer).
    expect(await screen.findByTestId("mapeamento-erro")).toHaveTextContent(
      "A etapa «Pago» mudou de papel.",
    );
    await waitFor(() =>
      expect(screen.getByTestId("etapa-new")).toHaveTextContent("Aguardando pagamento"),
    );
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    // E não dá para reenviar às cegas: o rascunho é igual ao servidor de novo.
    expect(screen.getByTestId("salvar-mapeamento")).toBeDisabled();
  });
});
