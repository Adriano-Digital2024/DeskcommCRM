import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { drainTick } from './drain';

const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const event = {
  id: 'e1', organization_id: 'org1', attempts: 1,
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

it('org em ai_dispatch_mode=external: evento vira done SEM enfileirar job', async () => {
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [event] };            // claim
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: 'external' }] }; // guard
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    return { rows: [] };                                                      // reaper / done
  });
  await drainTick({ query } as unknown as pg.Pool, knobs, log);
  // o guard TEM que consultar o modo (garante FAIL antes da implementação)...
  expect(calls.some((s) => s.includes('ai_dispatch_mode'))).toBe(true);
  // ...e nenhum job pode ser enfileirado (enqueueJob nunca roda).
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});
