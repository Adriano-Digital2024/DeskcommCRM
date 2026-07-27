"use client";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { CheckCircle, Warning } from "@/lib/ui/icons";
import type { EvolutionPayload } from "@/lib/ai/evolution/aggregate";

/**
 * Cada lacuna vira UMA frase que diz o problema e o conserto — número sem ação é
 * o "dado que não muda decisão" que a doutrina do sistema vivo proíbe.
 *
 * Duas honestidades que o texto tem que carregar, porque o dado tem:
 *  1. "não encontrou nada" CONTÉM "quase encontrou" — o agregador conta o quase-
 *     acerto dentro do mesmo laço das buscas sem resultado. Somar os dois como se
 *     fossem problemas separados infla a lacuna; por isso o segundo item começa
 *     com "Destas".
 *  2. "nada travando" só é boa notícia se houve movimento. Sem atividade nenhuma,
 *     a lista vazia significa "não deu para saber", e é isso que ela diz.
 */

/** Os passos do atendimento em português de dono de negócio — o enum é interno. */
const PASSOS: Record<string, string> = {
  new: "contato novo",
  contacted: "primeira conversa",
  qualifying: "entendendo o que ele precisa",
  qualified: "necessidade entendida",
  negotiating: "em negociação",
  won: "fechado",
  lost: "perdido",
};

function nomeiaPassos(steps: string[]): string {
  return steps.map((s) => PASSOS[s] ?? s).join(", ");
}

function plural(n: number, um: string, muitos: string): string {
  return n === 1 ? um : muitos;
}

interface Lacuna {
  chave: string;
  texto: string;
  href?: string;
  cta?: string;
}

function montaLacunas(gaps: EvolutionPayload["gaps"]): Lacuna[] {
  const out: Lacuna[] = [];

  for (const p of gaps.unmapped_agent_steps) {
    out.push({
      chave: `unmapped-${p.pipeline_name}`,
      // ⚠️ Este item NÃO afirma defeito, e isso é deliberado. A migration 0084 diz
      // com todas as letras que um passo sem etapa é estado LEGÍTIMO ("Em separação"
      // e "Pós-venda" não correspondem a passo nenhum do agente, e forçar mapeamento
      // seria inventar semântica que o tenant não declarou). Escrever "conserte isto"
      // mandaria o dono da clínica arrumar um funil que já está certo. O texto conta
      // a CONSEQUÊNCIA e devolve a decisão para quem conhece o próprio negócio.
      texto:
        `No funil "${p.pipeline_name}", ${p.steps.length} ${plural(p.steps.length, "passo do atendimento não tem", "passos do atendimento não têm")} ` +
        `etapa correspondente: ${nomeiaPassos(p.steps)}. Quando o agente chega em um desses passos, o cartão do cliente ` +
        `não se move — ele fica onde está. Às vezes isso é proposital: nem todo funil precisa de uma etapa para cada passo. ` +
        `Mas se você esperava ver esses clientes andarem sozinhos no quadro, é aqui que falta o vínculo — ele é feito na ` +
        `configuração do funil, por quem instalou o sistema.`,
      href: "/app/kanban",
      cta: "Ver as etapas do funil",
    });
  }

  if (gaps.knowledge_empty > 0) {
    out.push({
      chave: "knowledge-empty",
      texto:
        `${gaps.knowledge_empty} ${plural(gaps.knowledge_empty, "pergunta de cliente não encontrou", "perguntas de clientes não encontraram")} ` +
        `resposta nos seus materiais. São os assuntos que ainda faltam escrever — cada um deles é uma conversa em que o ` +
        `agente teve que improvisar ou passar adiante.`,
      href: "/app/ai/knowledge/sources",
      cta: "Abrir a base de conhecimento",
    });
  }

  if (gaps.knowledge_near_misses > 0) {
    out.push({
      chave: "knowledge-near",
      texto:
        `Destas, ${gaps.knowledge_near_misses} ${plural(gaps.knowledge_near_misses, "chegou perto", "chegaram perto")}: ` +
        `havia material parecido, mas não parecido o bastante para o agente arriscar usar. Aqui o conteúdo provavelmente ` +
        `já existe — só está escrito com palavras diferentes das que o cliente usa. Vale reescrever esses materiais com as ` +
        `perguntas do jeito que chegam.`,
      href: "/app/ai/knowledge/sources",
      cta: "Abrir a base de conhecimento",
    });
  }

  if (gaps.router_no_match > 0) {
    out.push({
      chave: "router-no-match",
      texto:
        `Em ${gaps.router_no_match} ${plural(gaps.router_no_match, "conversa", "conversas")} o agente não soube para qual ` +
        `atendimento encaminhar e usou o atendimento padrão. Se isso se repete, falta cadastrar esse assunto no roteador ` +
        `do seu número.`,
      href: "/app/ai/routers",
      cta: "Abrir os roteadores",
    });
  }

  if (gaps.router_failed > 0) {
    out.push({
      chave: "router-failed",
      texto:
        `Em ${gaps.router_failed} ${plural(gaps.router_failed, "conversa a leitura falhou", "conversas a leitura falhou")} ` +
        `por problema técnico, e ela caiu no atendimento padrão. Isso não é configuração: é a IA que não respondeu na hora. ` +
        `Se o número for alto, vale conferir a conexão com o provedor de IA.`,
      href: "/app/ai/credentials",
      cta: "Conferir a conexão de IA",
    });
  }

  return out;
}

/**
 * A boa notícia é feita de TRÊS afirmações independentes, e cada uma precisa da
 * sua própria evidência:
 *   • "toda pergunta encontrou resposta"  ← só vale se houve busca na base;
 *   • "toda conversa achou para onde ir"  ← só vale se houve decisão de rota;
 *   • "todo passo tem etapa que o recebe" ← sempre vale: é o estado ATUAL do
 *     funil, não um evento do período, então independe de ter havido movimento.
 *
 * Um booleano "houveAtividade" para as três autorizaria todas com a evidência de
 * uma: um tenant com roteador configurado e base VAZIA tem decisões > 0 e a tela
 * afirmaria "toda pergunta encontrou resposta nos seus materiais" tendo havido
 * ZERO perguntas. O guarda tem que ter o tamanho da afirmação.
 */
export function boaNoticia(buscas: number, decisoes: number): string {
  const partes: string[] = [];
  if (buscas > 0) partes.push("toda pergunta encontrou resposta nos seus materiais");
  if (decisoes > 0) partes.push("toda conversa achou para onde ir");
  partes.push("todo passo do atendimento tem uma etapa do funil que o recebe");

  const frase = `Nada travando neste período: ${partes.join(", ")}.`;
  if (buscas > 0 && decisoes > 0) return frase;
  return `${frase} Vale a ressalva de que ${
    buscas === 0 && decisoes === 0
      ? "não houve consulta à sua base nem encaminhamento de conversa"
      : buscas === 0
        ? "ninguém consultou sua base de conhecimento"
        : "nenhuma conversa foi encaminhada"
  } no período — sobre isso a lista está calada, não elogiosa.`;
}

export function EvolutionGaps({
  gaps,
  buscas,
  decisoes,
}: {
  gaps: EvolutionPayload["gaps"];
  /** Consultas à base no período — evidência da 1ª afirmação de `boaNoticia`. */
  buscas: number;
  /** Decisões de encaminhamento no período — evidência da 2ª afirmação. */
  decisoes: number;
}) {
  const lacunas = montaLacunas(gaps);

  if (lacunas.length === 0) {
    return (
      <Card className="flex items-start gap-3 p-5" data-testid="gaps-vazio">
        <CheckCircle size={20} className="mt-0.5 shrink-0 text-success-fg" aria-hidden />
        <p className="text-sm leading-relaxed">{boaNoticia(buscas, decisoes)}</p>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="gaps-lista">
      {lacunas.map((l) => (
        <li key={l.chave}>
          <Card className="flex items-start gap-3 p-5">
            <Warning size={20} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-relaxed">{l.texto}</p>
              {l.href && (
                <Link
                  href={l.href}
                  className="mt-2 inline-block text-sm font-medium text-accent underline underline-offset-4"
                >
                  {l.cta}
                </Link>
              )}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
