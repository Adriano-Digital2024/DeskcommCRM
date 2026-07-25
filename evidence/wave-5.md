# Wave 5 — CORE 3 · score com evidência, e a faixa que não pode piscar · 2026-07-25

**Placar: 15 verdes · 0 vermelhos · 0 bloqueados.**

| | |
|---|---|
| Carimbo | `HEAD=c8156e3`, quatro dependências declaradas, **todas limpas** |
| Aparato | `tests/capture-wave-5-cenarios.ts` (modo normal e `SELFCHECK=1`) |

> **Escopo, e ele é estreito de propósito.** Este placar vale para o estado em que
> as colunas do score ainda moravam em `crm_leads`. O commit que as move para
> `crm_lead_scores` veio **depois** desta leitura e **não está coberto** — muda
> onde as colunas vivem, onde os CHECKs vivem e o caminho de leitura do board.
> Alvo que se move depois da medição não invalida a medição; invalida o alcance
> dela.

## Esta wave não tem imagem, e isso é um dado

Não há captura porque **não há tela**: a faixa (`frio`/`morno`/`quente`) ainda não
chega ao card — o slot mostra o medidor e o número, não o rótulo. Fabricar um
print aqui seria fabricar prova. Fica **nomeado como lacuna**: no minuto em que a
faixa subir para o card, a Wave 5 passa a precisar de prova visual que hoje não
existe, e o sintoma que essa prova procuraria é o card dizendo "Frio" ao lado de
72%.

## A) A lei mora no banco — então se cobra do banco

Ler a migration prova que **alguém escreveu** a constraint. Não prova que ela foi
aplicada, nem que pega o caso do array vazio que a própria migration nomeia como
armadilha. Tabela-verdade de oito linhas contra Postgres real, dentro de
transação desfeita no fim:

| caso | veredito do banco |
|---|---|
| score com razão e lastro | **aceito** |
| score sem razão | recusado `23514` |
| razão só com espaços | recusado |
| razão sem lastro nenhum | recusado |
| `activity_ids: []` | recusado |
| ausência de score | **aceito** |
| score 101 | recusado |
| faixa `morninho` | recusado |

As duas linhas em negrito são o que faz "recusou" significar alguma coisa: se
tudo fosse recusado, a asserção não distinguiria uma constraint correta de uma
que recusa qualquer escrita.

### A borda foi descoberta, não afirmada

O briefing escrevia `score ≤ 45` num parágrafo e `< 45` no outro. Reprovar por
essa diferença seria reprovar o produto por defeito do **texto** — e, mais
honestamente: eu tinha dois números defensáveis e nenhum critério para escolher.
**Asserção que não se justifica sem chutar não é asserção, é preferência.**

Então varri 0..100 por faixa e li de volta o que o banco aceita. O intervalo
virou **saída**, não disputa:

```
frio 0..45 · morno 35..75 · quente 65..100   (bordas inclusivas)
```

### A inclusão deixou de ser declarada

O briefing afirmava que o conjunto **aceito** pelo CHECK é superconjunto do
conjunto **produzido** pela caminhada — e que precisa ser, senão rejeitaria
escrita legítima na fronteira. O critério 15.j percorre os 303 estados, pergunta
à função de produção que faixa ela devolve e manda o par ao Postgres pelo mesmo
caminho do worker: **303 gravaram**. Não há par produzível fora do aceito.

E ele não é verde por ausência: sem constraint, tudo gravaria. Quem impede a
vacuidade é o critério vizinho, que prova a **mesma** trava recusando a zona
incoerente. Uma é a perna positiva da outra.

## B) A histerese, com o valor dançando

"Não pisca" é propriedade **fraca**: uma faixa que nunca muda também não pisca.
São três, e as duas últimas foram o que achou o defeito.

| propriedade | o que afirma |
|---|---|
| ANTI-PISCA | série oscilando em volta de **cada** limiar muda a faixa no máximo uma vez |
| NÃO-MENTIRA | a faixa nunca fica a **duas** faixas da régua crua |
| FIDELIDADE | a função concorda com a régua escrita no próprio módulo |

### Varredura, não exemplos

Exemplo escolhido a mão acha o que quem escreveu já suspeitava. Meus quatro
exemplos acharam quatro casos; a varredura do domínio inteiro — 101 scores × 3
faixas anteriores — achou **nove**, e deu a forma:

```
vindo de "frio",   score 70-74 exibe "frio"    (a régua crua diz "quente")
vindo de "quente", score 36-39 exibe "quente"  (a régua crua diz "frio")
```

Contíguas, e só na zona do meio: fora dela a função acertava. **Defeito com forma
precisa, não instrumento quebrado** — e a saída comprime as violações em faixas
justamente porque nove linhas soltas mostram nove casos e deixam a forma para
quem lê adivinhar.

### O episódio da divergência

A meio caminho do conserto, os instrumentos **discordaram**: não-mentira 5/303,
escrita real 5/303, fidelidade 9/303. Instrumentos independentes que divergem
significam mais de um defeito ou um instrumento errado — hora de parar de
consertar e voltar a medir.

Tinha conteúdo: a descida havia trocado um defeito por outro. Era **rótulo velho**
(parava duas faixas atrás), virou **degrau perdido** (pulava `morno` e ia direto a
`frio`). Só a fidelidade via — a não-mentira não, porque `frio` *é* a régua crua
ali; a escrita não, porque o banco aceita os dois em 38.

No fim os três voltaram a 0/303, e concordarem é a evidência de que era **um**
defeito, não dois sobrepostos.

## A cerca de regressão, e a prova de que ela morde

Zerar as violações quebrando os acertos é **troca de defeito, não correção**. Daí
14 âncoras escritas **à mão** a partir da régua declarada — derivá-las de qualquer
uma das fórmulas faria a cerca concordar com o instrumento que deveria vigiar.
São as bordas: o primeiro valor que confirma cada transição e o último que não.

E a cerca não fica só afirmada. `SELFCHECK=1` a submete ao conserto **errado** mais
plausível — devolver sempre a régua crua:

| | |
|---|---|
| a régua crua zera a varredura | **0 violações** — pareceria consertado |
| o anti-pisca a reprova | 6 trocas na série oscilante (limite 1) |
| as âncoras a reprovam | 4 de 14 quebradas |

O atalho passa na invariante nova e é barrado pelas outras duas. **Cerca que nunca
reprovou é decoração**; e cerca que só morde antes do conserto caduca junto com o
bug — esta continua mordendo depois.

> Nota de higiene: o auto-teste **não** muta `lib/kanban/score-band.ts`. O caminho
> óbvio era mutar a função real, como nos outros casos desta entrega — e foi
> recusado porque o arquivo estava sendo escrito por outra sessão naquele minuto.
> Mutação vale contra código commitado ou próprio, nunca contra arquivo que outra
> sessão tem aberto: o dano não apareceria como erro, apareceria como resultado
> que ninguém consegue reproduzir.
