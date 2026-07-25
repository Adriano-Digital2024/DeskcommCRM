# Mapas de arquitetura

## Regra única deste diretório: o JSON é a FONTE; o HTML é DERIVADO

Cada mapa tem um `*.json` (fonte) e pode ter um `*.html` (render).

> **Se os dois divergirem, o HTML é que está errado.** Nunca edite o HTML à mão: regenere-o a partir do
> JSON.

O motivo está aqui e não num handoff porque é aqui que a decisão errada seria tomada. O HTML é o
formato mais fácil de abrir e editar — e **o formato mais fácil de editar é o que envelhece mentindo**:
uma correção feita nele parece funcionar, some na próxima geração, e nesse intervalo a fonte deixou de
ser fonte sem ninguém decidir isso.

## Mapas

| arquivo | escopo |
|---|---|
| `agent-turn.workflow.json` | o turno do agente (runtime da IA) |
| `crm-vivo.architecture.json` | subsistema **CRM Vivo** — 24 peças, 44 arestas, 6 faixas |

### `crm-vivo.architecture.json` é PLANTA, não fotografia

Ele descreve o desenho **contratado** das oito waves do épico. As waves 6, 7 e 8 **ainda não existem em
código** — quem procurar essas peças no repositório não vai achar, e **o mapa não está errado: está
adiantado**.

Invariantes que a forma não mostra vivem nos `cards` do próprio JSON — inclusive as **não-ligações
deliberadas** (ex.: o score fica **fora** da publicação de realtime, de propósito). *Ausência de aresta
é indistinguível de aresta esquecida; por isso a não-ligação se **declara**, não se desenha.*
