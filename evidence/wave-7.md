# Wave 7 — o ciclo · 2026-07-25

"Esfriando" era adjetivo calculado dentro de rotas de leitura: não existia até
alguém abrir a tela. A wave o transforma em **estado do negócio**, com produtor,
registro e destino humano.

| | |
|---|---|
| Peças | 1 tabela · 2 relógio do silêncio · 4 acervo · 5 observador da travessia |
| Segurada | 3 (board assinando a tabela) — depende de entrega em tempo real |
| Aparato | `tests/sonda-worker-travessia.ts`, `scripts/seed-risk-states.ts` |

## O ciclo, ponta a ponta

Rodado pela sonda, com o gatilho honesto: o negócio esfria porque **o relógio
andou**, e o worker roda sem ninguém tocar a linha do lead.

| Passo | Estado | Timeline |
|---|---|---|
| negócio novo | `em_dia` | vazia |
| após 100h de silêncio | `em_risco` | "Negócio esfriou" |
| segunda passada do worker | `em_risco` | inalterada — 0 travessias |
| após interação real | `em_dia` | "Negócio voltou a andar" |

**O worker não tocou nenhum lead** — hash de `(id, updated_at)` de todos os leads
da org idêntico antes e depois. Ele não pode tocar nem pelo trigger: os tipos que
emite estão fora da lista positiva da 0079. A peça 2 foi decidida por outra razão
(tipo novo tem de falhar barulhento) e acabou garantindo isto de graça.

Pela rota real: `403` sem segredo; com segredo, 4 orgs e 10 travessias na
primeira passada, **0 na segunda**.

## O acervo entra sem mentir

36 críticos e 2 em risco de 56 abertos, todos gravados com `since` no passado —
eles esfriaram há dias, e "esfriou agora" seria falso na única superfície que
promete contar a vida do negócio.

| Promessa | Resultado |
|---|---|
| atividades de risco na timeline | 0 |
| estados com `since` no futuro | 0 |
| itens de caixa após 3 execuções | 1, o mesmo id nas três |
| o seed tocou algum lead? | não — hash idêntico |

O item diz o trabalho, não o número: **"Revise 38 negócios parados e decida quais
encerrar"**.

## O agrupamento por dia

![timeline longa agrupada por dia](wave7-agrupamento-por-dia.png)

O dossiê daquele lead tinha **25 linhas, 22 delas o bloco idêntico "E2E Manager ·
2 ações"**. O agrupamento estava correto (janela de 60s, episódios distintos) e o
resultado não informava nada.

Agora: **2 blocos de dia** representando as mesmas 50 ações — "sábado, 25 de jul.
· 34 ações" e "sexta-feira, 24 de jul. · 16 ações". Abrir um revela as 34 linhas.

O gatilho é o **tamanho da lista**, nunca o tempo. Calibrar por tempo exigiria
escolher uma janela olhando os dados disponíveis, e os dados disponíveis são
artefato das próprias sondas — medido, o intervalo mediano entre atividades é de
99s contra uma janela de 60s. Ajustar ali seria produzir um número sobre nós
mesmos com cara de resultado sobre o produto.

E o caso que decidiu o desenho não é o muro de blocos: é o lead com **26 itens e
26 blocos, zero colapsáveis** — ausência de estrutura acima da linha, que é a
forma mais comum. Por isso o agrupamento parte dos itens, não dos blocos finos.

## O card da proposta (cenário 23)

![o card com a proposta de retomada](wave7-card-reativacao.png)

A faixa ③ ganha um quarto estado. A precedência ficou
`awaiting > reactivation > cooling > medidor`, e ela separa **informar** de
**permitir agir**: `cooling` diz "este negócio parou", a proposta diz "parou e
aqui está o que fazer". Continua perdendo para a próxima ação do agente, por
coerência com o cenário 24 — duas decisões pendentes no mesmo card é a pilha que
o contrato de UI proíbe.

| Verificação | Resultado |
|---|---|
| a faixa mostra a proposta | sim |
| mostra o **prazo** | sim — "· 2d" |
| os dois botões decidem | Retomar / Encerrar |
| o card cresceu? | não — 144px com e sem proposta |
| decidir tira a oferta da tela | sim, **depois do conserto** |

O prazo aparece no card de propósito: proposta com prazo que **não mostra o
prazo** é a mesma simulação de atenção que o prazo existe para evitar — quem
olha precisa saber que a janela fecha, senão "decido depois" é indistinguível de
"decidi não".

![depois de decidir, a faixa não oferece mais](wave7-card-reativacao-decidido.png)

E o último item achou defeito real: o servidor respondia `accepted` e **o card
seguia oferecendo o botão**. O hook invalidava só `["board", pipelineId]`, e a
lista de propostas vive em `["reactivations"]` — um lado mudou, o outro não
acompanhou, e ninguém reclamou. Clicar de novo daria 409, e o usuário concluiria
que o sistema não obedeceu.
