-- =============================================================================
-- Migration 0089 — seed do catálogo ai_models para OpenRouter e AgentRouter
-- =============================================================================
-- BUG
--   A 0088 abriu o vocabulário de providers em ai_models, mas o catálogo
--   curado (migration 0023 / baseline.sql) só tem os 8 modelos originais
--   (anthropic, openai, google). Sem linhas de openrouter/agentrouter, o
--   seletor "Modelo" do agente (/app/ai/agents/[id]) lista vazio nesses
--   providers: GET /api/v1/ai/providers/:p/models devolve lista vazia.
--
--   E mesmo que alguém cadastrasse um modelo à mão, o lookup de custo
--   (lib/ai/cost.ts, lookup exato por model em ai_pricing) devolveria 0.
--
-- FIX
--   Semeia o catálogo dos dois providers novos com os SLUGS REAIS do wire:
--     * OpenRouter é OpenAI-compatible e usa vendor-prefix com ponto nos
--       Claude (ex.: `anthropic/claude-sonnet-4.6` — NÃO o model_id interno
--       `claude-sonnet-4-6`, que não existe no gateway e daria 404 no chat).
--       Preços = pass-through do catálogo público de 2026-07-31 (USD/M * 100
--       = cents/M), conferidos em https://openrouter.ai/api/v1/models.
--     * AgentRouter (OpenAI-compatible em https://agentrouter.org/v1) usa
--       `gpt-5.5` e `glm-5.2` — os dois modelos que o validator sonda
--       (lib/ai/provider-validators.ts). Preços = mesmo patamar do gateway.
--
--   ai_pricing é derivado de ai_models no mesmo padrão da 0068 (NOT EXISTS),
--   pra computeCost() achar os modelos novos. Re-aplicar é no-op (on conflict
--   do nothing + NOT EXISTS); auto-curativo no update.sh de clones.
--
--   Nota de curadoria: optamos por um subconjunto enxuto (os mesmos 3
--   Claude/GPT + 2 Gemini + 2 de custo competitivo deepseek/glm), NÃO o
--   catálogo inteiro do gateway (~364 modelos) — o seletor é pra escolha
--   humana de agente, não pra espelhar marketplace.
-- =============================================================================

insert into public.ai_models (provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider)
values
  -- OpenRouter — slugs reais do gateway (dots nos Claude, prefix de vendor).
  ('openrouter', 'anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6', 'Default recomendado via OpenRouter — equilíbrio custo/qualidade', 1000000, 300, 1500, true, true),
  ('openrouter', 'anthropic/claude-opus-4.7',   'Claude Opus 4.7',   'Flagship via OpenRouter — raciocínio complexo',                   1000000, 500, 2500, true, false),
  ('openrouter', 'anthropic/claude-haiku-4.5',  'Claude Haiku 4.5',  'Cheap/fast via OpenRouter — atendimentos curtos e classificação',  200000, 100, 500,  true, false),
  ('openrouter', 'openai/gpt-5',                'GPT-5',             'Flagship OpenAI via OpenRouter',                                  400000, 125, 1000, true, false),
  ('openrouter', 'openai/gpt-5-mini',           'GPT-5 Mini',        'Cheap/fast OpenAI via OpenRouter',                                400000, 25,  200,  true, false),
  ('openrouter', 'google/gemini-2.5-pro',       'Gemini 2.5 Pro',    'Flagship Google via OpenRouter',                                 1000000, 125, 1000, true, false),
  ('openrouter', 'google/gemini-2.5-flash',     'Gemini 2.5 Flash',  'Cheap/fast Google via OpenRouter',                               1000000, 30,  250,  true, false),
  ('openrouter', 'deepseek/deepseek-chat',      'DeepSeek Chat',     'Custo competitivo — triagem e respostas simples',                  163840, 26,  103,  true, false),
  ('openrouter', 'z-ai/glm-5.2',                'GLM-5.2 (Z.ai)',    'Custo competitivo — bom equilíbrio geral',                       1000000, 119, 374,  true, false),
  -- AgentRouter — OpenAI-compatible; mesmos nomes sondados pelo validator.
  ('agentrouter', 'gpt-5.5', 'GPT-5.5', 'Flagship via AgentRouter', 1050000, 500, 3000, true, true),
  ('agentrouter', 'glm-5.2', 'GLM-5.2', 'Zhipu GLM via AgentRouter', 1000000, 119, 374, true, false)
on conflict (provider, model_id) do nothing;

-- ai_pricing derivado de ai_models (mesmo padrão da 0068) — cobre os modelos
-- novos do catálogo pro computeCost() não devolver 0. NOT EXISTS protege
-- preços já existentes (correção de preço = INSERT novo, nunca UPDATE).
insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
select
  m.model_id,
  m.input_price_per_million_cents,
  m.output_price_per_million_cents,
  'backfill 0089 a partir de ai_models (openrouter/agentrouter)'
from public.ai_models m
where m.provider in ('openrouter', 'agentrouter')
  and m.deprecated_at is null
  and m.input_price_per_million_cents is not null
  and m.output_price_per_million_cents is not null
  and not exists (
    select 1 from public.ai_pricing p
    where p.model = m.model_id and p.superseded_at is null
  );
