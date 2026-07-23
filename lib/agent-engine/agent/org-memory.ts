/**
 * Memória Geral da Org (Fase 1 do épico harness — spec 2026-07-23).
 *
 * Doc-mãe versionado+ponteiro (mesmo padrão do playbook 0004) + entradas de
 * aprendizado (manual | flywheel aprovado). Resolvida no início de CADA run —
 * sem cache de processo, de propósito: publicar ⇒ próximo turno já vê.
 * O bloco renderizado entra no PREFIXO ESTÁVEL: determinístico byte-a-byte
 * para a mesma versão+entries (ordem estável por created_at, id).
 */
import type pg from 'pg';

export interface OrgMemoryEntry {
  id: string;
  title: string;
  body: string;
}

export interface LoadedOrgMemory {
  content: string | null;
  entries: OrgMemoryEntry[];
}

export async function insertOrgMemoryVersion(
  db: pg.Pool,
  input: { tenantId: string; content: string; createdBy?: string | null },
): Promise<{ id: string; versionNumber: number }> {
  const { rows } = await db.query<{ id: string; version_number: number }>(
    `insert into org_memory_versions (organization_id, version_number, content, created_by)
     values ($1,
             coalesce((select max(version_number) from org_memory_versions where organization_id = $1), 0) + 1,
             $2, $3)
     returning id, version_number`,
    [input.tenantId, input.content, input.createdBy ?? null],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('insertOrgMemoryVersion: insert não retornou linha');
  return { id: r.id, versionNumber: r.version_number };
}

export async function setOrgMemoryPointer(
  db: pg.Pool,
  input: { tenantId: string; versionId: string },
): Promise<void> {
  // Escopo vem DA VERSÃO no SQL (padrão do playbook): ponteiro nunca aponta
  // para versão de outra org.
  const { rowCount } = await db.query(
    `insert into org_memory_pointers (organization_id, version_id, updated_at)
     select v.organization_id, v.id, now()
     from org_memory_versions v
     where v.id = $2 and v.organization_id = $1
     on conflict (organization_id) do update set version_id = excluded.version_id, updated_at = now()`,
    [input.tenantId, input.versionId],
  );
  if (rowCount === 0) throw new Error('setOrgMemoryPointer: versão não encontrada para esta org');
}

export async function loadOrgMemory(db: pg.Pool, tenantId: string): Promise<LoadedOrgMemory> {
  const { rows: docRows } = await db.query<{ content: string }>(
    `select v.content
     from org_memory_pointers p join org_memory_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const { rows: entryRows } = await db.query<OrgMemoryEntry>(
    `select id, title, body
     from org_memory_entries
     where organization_id = $1 and status = 'active'
     order by created_at asc, id asc`,
    [tenantId],
  );
  return { content: docRows[0]?.content ?? null, entries: entryRows };
}

/** Bloco do prefixo estável — '' quando a org não tem memória (zero custo). */
export function renderOrgMemory(mem: LoadedOrgMemory): string {
  if (mem.content === null && mem.entries.length === 0) return '';
  const parts: string[] = ['=== memória da organização (regras e aprendizados — valem para TODO atendimento) ==='];
  if (mem.content !== null) parts.push(mem.content.trim());
  if (mem.entries.length > 0) {
    parts.push('--- aprendizados ---');
    for (const e of mem.entries) parts.push(`- ${e.title}: ${e.body}`);
  }
  return parts.join('\n');
}

/** Ordem canônica do prefixo: playbook → memória da org → índice de skills. */
export function composeSystemPrompt(input: {
  playbookPrompt: string;
  orgMemoryBlock: string;
  skillIndex: string;
}): string {
  const blocks = [input.playbookPrompt];
  if (input.orgMemoryBlock !== '') blocks.push(input.orgMemoryBlock);
  if (input.skillIndex !== '') {
    blocks.push(
      `=== skills (índice — o corpo carrega no turno quando a situação dispara) ===\n${input.skillIndex}`,
    );
  }
  return blocks.join('\n\n');
}
