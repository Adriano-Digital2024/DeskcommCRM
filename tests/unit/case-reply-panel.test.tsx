import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => postMock(...args) },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

import { CaseReplyPanel } from "@/app/app/ai/cases/_components/CaseReplyPanel";

function renderWith(status: "awaiting_human" | "awaiting_lead" | "resolved" | "escalated" | "cancelled") {
  const qc = new QueryClient();
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <CaseReplyPanel caseId="case-1" status={status} />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

beforeEach(() => {
  postMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("CaseReplyPanel", () => {
  it("desabilitado fora de awaiting_human, com explicação visível", () => {
    renderWith("awaiting_lead");

    expect(screen.getByText(/aguardando o cliente responder/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /concluí/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/escreva sua resposta/i)).toBeDisabled();
  });

  it("botão Enviar desabilitado com texto vazio, mesmo em awaiting_human", () => {
    renderWith("awaiting_human");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("enviar com ação need_lead_info chama o POST com {action, body} e invalida as queries", async () => {
    postMock.mockResolvedValue({ data: { status: "awaiting_lead" } });
    const { invalidateSpy } = renderWith("awaiting_human");

    fireEvent.click(screen.getByRole("button", { name: /preciso de info do cliente/i }));
    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), {
      target: { value: "Qual seu CPF?" },
    });

    const sendBtn = screen.getByRole("button", { name: "Enviar" });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/ai/cases/case-1/reply", {
        action: "need_lead_info",
        body: "Qual seu CPF?",
      }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });

  it("erro na mutation chama showApiError", async () => {
    postMock.mockRejectedValue(new Error("conflito"));
    renderWith("awaiting_human");

    fireEvent.change(screen.getByPlaceholderText(/escreva sua resposta/i), {
      target: { value: "Concluído, avisei o cliente." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
  });
});
