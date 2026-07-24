/**
 * Parser de pacote de skill instalável (.zip → objeto validado). Entrada é upload de
 * terceiro (não confiável): todo erro é um erro de ENSINO em pt-br ({ ok:false, error }),
 * nunca um throw. Frontmatter do SKILL.md é lido à mão (só as chaves conhecidas) em vez
 * de com uma lib de YAML genérica — superfície de ataque menor para input não confiável.
 */
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { skillMatcherSchema, validateSkillBody, type SkillMatcher } from '../../agent-engine/agent/skills';

export interface SkillManifestEntry {
  path: string;
  size: number;
  sha256: string;
  kind: 'reference' | 'asset';
}

export interface ParsedSkillPackage {
  name: string;
  description: string;
  matcher: SkillMatcher;
  body: string;
  files: Array<{ path: string; bytes: Uint8Array; entry: SkillManifestEntry }>;
}

export type ParseSkillResult =
  | { ok: true; pkg: ParsedSkillPackage }
  | { ok: false; error: { code: string; message: string } };

const MAX_FILES = 64;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'mp3', 'ogg', 'mp4']);

function fail(code: string, message: string): ParseSkillResult {
  return { ok: false, error: { code, message } };
}

/** Caminho seguro: relativo, sem `..`, sem raiz absoluta, sem separador de Windows. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  return segments.every((s) => s !== '..' && s !== '');
}

function extensionOf(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx === -1 ? '' : p.slice(idx + 1).toLowerCase();
}

/**
 * Lê só as 4 chaves conhecidas do frontmatter (name, description, matcher.any_keywords,
 * matcher.probe_keywords) — parser dedicado, não YAML genérico. Aceita a forma exata do
 * frontmatter de skill: `chave: valor` na raiz, `matcher:` seguido de `  any_keywords: [a, b]`
 * indentado por baixo.
 */
function parseFrontmatter(raw: string): { name?: string; description?: string; matcher: Record<string, unknown> } {
  const lines = raw.split('\n');
  let name: string | undefined;
  let description: string | undefined;
  const matcher: Record<string, unknown> = {};

  const parseInlineArray = (value: string): string[] => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => s.trim());
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^name:/.test(line)) {
      name = line.slice(line.indexOf(':') + 1).trim();
    } else if (/^description:/.test(line)) {
      description = line.slice(line.indexOf(':') + 1).trim();
    } else if (/^matcher:/.test(line)) {
      // varre as linhas indentadas abaixo de `matcher:` (matcher inline tipo `matcher: {}` não tem sub-linhas)
      let j = i + 1;
      while (j < lines.length) {
        const sub = lines[j] ?? '';
        if (sub === '' || !/^\s+\S/.test(sub)) break;
        const subTrimmed = sub.trim();
        const m = /^any_keywords:\s*(.*)$/.exec(subTrimmed);
        const p = /^probe_keywords:\s*(.*)$/.exec(subTrimmed);
        if (m) matcher.any_keywords = parseInlineArray(m[1] ?? '');
        else if (p) matcher.probe_keywords = parseInlineArray(p[1] ?? '');
        j += 1;
      }
      i = j - 1;
    }
  }

  return { name, description, matcher };
}

export function parseSkillPackage(zipBytes: Uint8Array): ParseSkillResult {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch {
    return fail('skill_zip_invalid', 'Não consegui abrir o arquivo .zip — verifique se o pacote não está corrompido.');
  }

  const entryNames = Object.keys(unzipped).filter((p) => !p.endsWith('/'));

  if (entryNames.length > MAX_FILES) {
    return fail('skill_too_many_files', `O pacote tem ${entryNames.length} arquivos — o limite é ${MAX_FILES}.`);
  }

  for (const p of entryNames) {
    if (!isSafePath(p)) {
      return fail('skill_unsafe_path', `Caminho não permitido no pacote: "${p}" (sem "..", sem caminho absoluto).`);
    }
  }

  let totalBytes = 0;
  for (const p of entryNames) {
    const bytes = unzipped[p];
    if (bytes === undefined) continue;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return fail('skill_file_too_large', `O arquivo "${p}" tem mais de ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return fail('skill_package_too_large', `O pacote descompactado passa de ${MAX_TOTAL_BYTES / 1024 / 1024}MB.`);
    }
  }

  const skillMdBytes = unzipped['SKILL.md'];
  if (skillMdBytes === undefined) {
    return fail('skill_md_missing', 'O pacote precisa de um arquivo SKILL.md na raiz.');
  }

  const skillMdRaw = new TextDecoder('utf-8').decode(skillMdBytes);
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(skillMdRaw);
  if (!fmMatch) {
    return fail('skill_frontmatter_invalid', 'SKILL.md precisa começar com um frontmatter delimitado por "---".');
  }
  const [, frontmatterRaw, bodyRaw] = fmMatch;
  const { name, description, matcher } = parseFrontmatter(frontmatterRaw ?? '');

  if (name === undefined || name === '') {
    return fail('skill_frontmatter_invalid', 'SKILL.md precisa de um campo "name" no frontmatter.');
  }
  if (description === undefined || description === '') {
    return fail('skill_frontmatter_invalid', 'SKILL.md precisa de um campo "description" no frontmatter.');
  }
  const matcherResult = skillMatcherSchema.safeParse(matcher);
  if (!matcherResult.success) {
    return fail(
      'skill_frontmatter_invalid',
      'O "matcher" do SKILL.md precisa de "any_keywords" (lista com pelo menos 1 palavra).',
    );
  }

  const body = (bodyRaw ?? '').trim();
  try {
    validateSkillBody(body);
  } catch (e) {
    return fail('skill_frontmatter_invalid', e instanceof Error ? e.message : 'corpo de skill inválido');
  }

  const files: Array<{ path: string; bytes: Uint8Array; entry: SkillManifestEntry }> = [];
  for (const p of entryNames) {
    if (p === 'SKILL.md') continue;
    const bytes = unzipped[p];
    if (bytes === undefined) continue;

    let kind: 'reference' | 'asset';
    if (p.startsWith('references/')) {
      kind = 'reference';
    } else if (p.startsWith('assets/')) {
      const ext = extensionOf(p);
      if (!ASSET_EXTENSIONS.has(ext)) {
        return fail('skill_asset_extension_invalid', `Extensão não permitida em "${p}" — use: ${[...ASSET_EXTENSIONS].join(', ')}.`);
      }
      kind = 'asset';
    } else {
      return fail(
        'skill_unexpected_path',
        `Arquivo fora do esperado: "${p}" — o pacote só aceita SKILL.md, references/ e assets/.`,
      );
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    files.push({ path: p, bytes, entry: { path: p, size: bytes.byteLength, sha256, kind } });
  }

  return {
    ok: true,
    pkg: { name, description, matcher: matcherResult.data, body, files },
  };
}
