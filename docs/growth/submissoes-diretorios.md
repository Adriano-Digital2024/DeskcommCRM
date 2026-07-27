# Submissões a diretórios

Diretórios de software open source são a alavanca de **GEO** mais subestimada do plano: a pesquisa mediu que **85,7% das citações que um LLM faz sobre uma marca apontam para domínios que ela não controla**, e esses diretórios estão entre os mais citados quando alguém pergunta "qual a melhor alternativa open source a X".

Não espere tráfego direto — não existe estudo público que quantifique visitas vindas de awesome-lists. O retorno é ser citável por terceiros.

---

## 1. awesome-selfhosted ⏳ bloqueado até ~28/08/2026

**308,6 mil estrelas.** É o diretório de maior peso da categoria.

⚠️ **Não submeta ainda.** O template de PR exige literalmente:

> *"Any software project you are adding was first released more than 4 months ago."*

O repositório foi criado em **28/04/2026**. A v1.0.0 saiu em **27/07/2026**. Pela leitura de idade do repositório, a janela abre por volta de **28/08/2026**; pela leitura mais rígida (4 meses após o primeiro release), **27/11/2026**. Submeter antes queima o PR e o histórico fica na thread.

**Como funciona:** a submissão **não** vai no README. Vai como um arquivo YAML em [`awesome-selfhosted-data`](https://github.com/awesome-selfhosted/awesome-selfhosted-data), em `software/deskcommcrm.yml`, um item por PR, nome de arquivo em kebab-case.

**Entrada pronta** (confira `website_url` quando o domínio estiver no ar):

```yaml
name: DeskcommCRM
website_url: https://deskcomm.com.br
source_code_url: https://github.com/melgarafael/DeskcommCRM
description: "CRM with native AI agents that answer, qualify and move deals over WhatsApp, with multi-tenant row-level security and an audited guardrail chain before every outbound message."
licenses:
  - MIT
platforms:
  - Nodejs
  - Docker
tags:
  - Customer Relationship Management (CRM)
depends_3rdparty: true
```

> `depends_3rdparty: true` está correto e é deliberado: o agente depende de um provedor de LLM externo. Declarar isso é exigência do diretório e, no nosso caso, é também coerente com a postura do projeto — omitir seria o tipo de meia-verdade que a doutrina do repo não admite.

**Checklist do PR deles** (todos precisam ser verdade no dia): um item por PR · projeto ativamente mantido · instruções de instalação funcionando · sem duplicata em issues/PRs abertos ou fechados · campos opcionais e comentários removidos.

---

## 2. opensourcealternative.to 🟡 decisão de custo

**Formulário web.** Campos: e-mail, site da alternativa, nome, repositório, site do software proprietário, nome do proprietário.

Critérios: ser open source · ser alternativa a um software proprietário · ativamente mantido · self-hosted. **Cumprimos os quatro.**

**A decisão é de custo:**

| | |
|---|---|
| **US$ 29** | revisão em 48 horas |
| **Grátis** | fila de 6+ meses |

**Recomendo pagar.** Seis meses de fila é longo demais para uma campanha, e este é um dos domínios que aparecem na primeira página quando se busca "best open source CRM" — ou seja, é material de citação para LLM, que é exatamente o que estamos comprando. US$ 29 é o item mais barato do plano inteiro.

**Como preencher** — submeter uma vez por concorrente, começando pelo de maior volume de busca:

| Software proprietário | Site |
|---|---|
| Kommo | kommo.com |
| Intercom | intercom.com |
| Octadesk | octadesk.com |

Nome da alternativa: `DeskcommCRM` · Repositório: `https://github.com/melgarafael/DeskcommCRM`

---

## 3. AlternativeTo 🟢 pode ir agora

Exige conta no site. Sem custo, sem trava de idade.

- **Nome:** DeskcommCRM
- **Categoria:** CRM / Customer Support
- **Licença:** Open Source (MIT)
- **Plataformas:** Self-Hosted, Web, Docker
- **Alternativa a:** Kommo, Intercom, Octadesk, HubSpot, Zendesk
- **Descrição:** *Open-source AI sales OS for WhatsApp. AI agents answer, qualify and move deals inside a CRM you host yourself. Multi-tenant with row-level security, LGPD by design, MIT-licensed with no paid tier.*

---

## 4. LibHunt 🟢 pode ir agora

Indexa automaticamente a partir do GitHub, mas aceita submissão e curadoria de categoria. Sem custo.

Categoria alvo: **CRM** / **Node.js**. Os topics do repositório já estão bem cobertos (20 de 20 usados), que é a fonte que eles leem.

---

## O que NÃO fazer

- **Não pagar por estrelas nem incentivar star com brinde.** Viola a Acceptable Use Policy do GitHub, e a medição é brutal: **90,42% dos repositórios com campanha de estrelas falsas foram deletados** pelo GitHub, contra 5,03% de baseline. O efeito positivo dura menos de dois meses e depois vira passivo.
- **Não fazer seeding coordenado no Reddit.** A moderação por IA detecta o padrão, a FTC trata endosso não divulgado como prática enganosa, e — o pior — threads denunciando astroturfing ranqueiam para a busca da marca e **persistem nas respostas de IA**. O tiro pela culatra também vira citação, permanente.
- **Não perseguir o GitHub Trending como meta.** Os critérios nunca foram publicados. O limiar de "30 a 40 estrelas em 1-2 horas" que o meio repete vem de **um post de blog de 2017 sobre um único repositório**.

---

*Última atualização: 27 de julho de 2026.*
