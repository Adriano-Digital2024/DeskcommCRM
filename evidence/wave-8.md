# Wave 8 — o funil do agente e o funil do tenant · 2026-07-25

## Cenários 25 e 26 — o agente move o card, em qualquer vocabulário

![o card antes, em Primeiro contato](wave8-agente-move-antes.png)
![o card depois, em Proposta enviada](wave8-agente-move-depois.png)

O agente pensa em sete passos fixos; o tenant nomeia os dele. A ponte é
`crm_stages.agent_stage_hint` (migration 0084).

```
ANTES    o card está em "Primeiro contato"
AGENTE   avança o funil dele para "negotiating"  ·  ninguém toca na tela
~8s      o card está em "Proposta enviada"
```

E o mesmo passo cai em lugares diferentes conforme o nicho — que é o cenário 26:

| nicho | agente pede | o card vai para |
|---|---|---|
| clínica | `negotiating` | **Proposta enviada** |
| e-commerce | `negotiating` | **Aguardando pagamento** |
| e-commerce | `qualifying` | **não move** — o pipeline não declarou |

### O que o resolvedor recusa fazer

- **Sem mapeamento não move, e não há fallback por proximidade.** Mandar o
  negócio para "o estágio mais próximo" inventaria semântica que o tenant não
  declarou, e o usuário veria um card se mexendo sozinho para um lugar que
  ninguém escolheu. Pipeline sem hint nenhum — o estado de **todo clone novo** —
  nunca move.
- **Estágio arquivado não é destino**: sumir do board é pior que não se mover.
- **Contato com dois negócios abertos**: reusa `resolveActiveLeadForContact`, a
  decisão da wave 4. Ambíguo não move nenhum.
- **Ambiguidade de hint não é tratada**, deliberadamente: a 0084 a tornou
  impossível no banco. Tratar no código protegeria contra um estado que não pode
  existir — e faria o próximo leitor acreditar que pode.

### A trava que não foi pedida

A escrita é condicional ao **estágio de origem**. Se um humano arrastou o card
entre a leitura e a escrita, o agente não atropela: o resultado vira
`ja_esta_la`. Sem isso, uma decisão humana seria desfeita em silêncio, e a
pessoa veria o próprio gesto revertido sem explicação.

### Uma gramática só

A atividade usa o **mesmo** `stageChangeReason` do arrasto humano — "Movido de
Primeiro contato para Proposta enviada" — com `actor_kind = system`. Quem moveu
é **campo**, não texto: duas frases para o mesmo acontecimento fariam cada
leitor, cada filtro e cada tradução carregarem as duas para sempre.
