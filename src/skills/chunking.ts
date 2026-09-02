import { canonicalContentHash } from '../serialization/validate.js';
import { skillSourceFailure } from './source/errors.js';
import type { PreparedSkillDocument } from './types.js';

export const MAX_SKILL_CHUNK_CHARS = 8_000;
export const MAX_SKILL_CHUNKS = 64;
const MAX_HEADING_COMPONENT_CHARS = 200;
const HEADING_SEPARATOR = ' › ';
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;

interface Section { hierarchy: string[]; body: string; startsWithHeading: boolean; }
interface Fence { character: '`' | '~'; length: number; }
interface Heading { level: number; text: string; }
interface SourceLine { content: string; ending: string; raw: string; }

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validateInputText(value: unknown, identity = false): asserts value is string {
  if (typeof value !== 'string'
    || INVALID_UNICODE.test(value)
    || identity && (value.length === 0 || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value))) {
    skillSourceFailure('skill_validation_failed');
  }
}

function withoutSkillFrontmatter(markdown: string, stripFrontmatter: boolean): string {
  if (!stripFrontmatter) return markdown;
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match?.groups?.frontmatter || !/^\s*name\s*:/mu.test(match.groups.frontmatter)) skillSourceFailure('skill_validation_failed');
  return markdown.slice(match[0].length);
}

function sourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\n' && character !== '\r') continue;
    const ending = character === '\r' && value[index + 1] === '\n' ? '\r\n' : character;
    const content = value.slice(start, index);
    lines.push({ content, ending, raw: `${content}${ending}` });
    if (ending.length === 2) index += 1;
    start = index + 1;
  }
  if (start < value.length) {
    const content = value.slice(start);
    lines.push({ content, ending: '', raw: content });
  }
  return lines;
}

function openingFence(line: string): Fence | null {
  // CommonMark allows at most three literal spaces before a fence marker.
  const match = /^ {0,3}(?<marker>`{3,}|~{3,})(?<info>.*)$/u.exec(line);
  const marker = match?.groups?.marker;
  if (!marker) return null;
  const character = marker[0] as Fence['character'];
  if (character === '`' && (match.groups?.info ?? '').includes('`')) return null;
  return { character, length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(?<marker>`+|~+)[ \t]*$/u.exec(line);
  const marker = match?.groups?.marker;
  return marker !== undefined && marker[0] === fence.character && marker.length >= fence.length;
}

function hasUnsupportedContainerFence(line: string): boolean {
  let remaining = line;
  let container = false;
  while (true) {
    const quote = /^ {0,3}>[ \t]?/u.exec(remaining);
    if (quote !== null) {
      remaining = remaining.slice(quote[0].length);
      container = true;
      continue;
    }
    const list = /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/u.exec(remaining);
    if (list !== null) {
      remaining = remaining.slice(list[0].length);
      container = true;
      continue;
    }
    break;
  }
  return container && /^[ \t]*(?:`{3,}|~{3,})/u.test(remaining);
}

function startsListItem(line: string): boolean {
  return /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/u.test(line);
}

function hasAmbiguousListFence(line: string): boolean {
  let column = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === ' ') column += 1;
    else if (line[index] === '\t') column += 4 - (column % 4);
    else break;
    index += 1;
  }
  if (column < 4) return false;
  const content = line.slice(index);
  return /^(?:`{3,}|~{3,})/u.test(content) || hasUnsupportedContainerFence(content);
}

function heading(line: string): Heading | null {
  const match = /^ {0,3}(?<marker>#{1,6})(?:[ \t]+(?<text>.*)|[ \t]*)$/u.exec(line);
  const marker = match?.groups?.marker;
  if (!marker) return null;
  const text = (match.groups?.text ?? '')
    .replace(/[ \t]+#+[ \t]*$/u, '')
    .trim();
  if (text.length === 0) skillSourceFailure('skill_validation_failed');
  if (codePointLength(text) > MAX_HEADING_COMPONENT_CHARS) skillSourceFailure('skill_too_large');
  return { level: marker.length, text };
}

function hierarchyTitle(hierarchy: string[]): string {
  return hierarchy.length === 0 ? 'Overview' : hierarchy.join(HEADING_SEPARATOR);
}

function sections(markdown: string): Section[] {
  if (markdown.trim().length === 0) skillSourceFailure('skill_validation_failed');
  const output: Section[] = [];
  const headingStack: Array<string | undefined> = [];
  let hierarchy: string[] = [];
  let body: string[] = [];
  let startsWithHeading = false;
  let fence: Fence | null = null;
  let possibleListContext = false;
  const flush = () => {
    if (body.length > 0) output.push({ hierarchy: [...hierarchy], body: body.join(''), startsWithHeading });
    body = [];
    startsWithHeading = false;
  };

  for (const line of sourceLines(markdown)) {
    // A container-aware parser is required to prove that these blocks stay
    // indivisible. Reject them instead of treating their markers as prose.
    if (fence === null && hasUnsupportedContainerFence(line.content)) {
      skillSourceFailure('skill_validation_failed');
    }
    // Four-or-more spaces are root-level indented code, but can be a fenced
    // block relative to an earlier list marker. Without a full list parser the
    // construct stays ambiguous after list syntax appears, so reject it.
    if (fence === null && possibleListContext && hasAmbiguousListFence(line.content)) {
      skillSourceFailure('skill_validation_failed');
    }
    const nextHeading = fence === null ? heading(line.content) : null;
    if (nextHeading !== null) {
      flush();
      headingStack.length = nextHeading.level;
      headingStack[nextHeading.level - 1] = nextHeading.text;
      hierarchy = headingStack.filter((value): value is string => value !== undefined);
      body.push(line.raw);
      startsWithHeading = true;
      continue;
    }

    body.push(line.raw);
    if (fence === null) {
      if (startsListItem(line.content)) possibleListContext = true;
      fence = openingFence(line.content);
    } else if (closesFence(line.content, fence)) {
      fence = null;
    }
  }

  if (fence !== null) skillSourceFailure('skill_validation_failed');
  flush();
  if (output.map((section) => section.body).join('') !== markdown) skillSourceFailure('skill_validation_failed');
  return output;
}

function preferredBoundary(value: string[], limit: number): number {
  const whitespace = value.slice(0, limit).lastIndexOf(' ');
  return whitespace >= Math.floor(limit / 2) ? whitespace + 1 : limit;
}

function splitPlainLine(line: SourceLine, limit: number): string[] {
  const content = Array.from(line.content);
  const ending = Array.from(line.ending);
  if (ending.length > limit) skillSourceFailure('skill_too_large');
  const parts: string[] = [];
  let remaining = content;

  while (remaining.length + ending.length > limit) {
    let boundary: number;
    if (remaining.length > limit) {
      boundary = preferredBoundary(remaining, limit);
    } else {
      boundary = remaining.length;
    }
    if (boundary < 1 || boundary > limit) skillSourceFailure('skill_too_large');
    parts.push(remaining.slice(0, boundary).join(''));
    remaining = remaining.slice(boundary);
  }

  const finalPart = `${remaining.join('')}${line.ending}`;
  if (finalPart.length > 0) parts.push(finalPart);
  if (parts.join('') !== line.raw || parts.some((part) => codePointLength(part) > limit)) {
    skillSourceFailure('skill_validation_failed');
  }
  return parts;
}

function splitSection(section: Section, limit: number): string[] {
  if (limit < 1) skillSourceFailure('skill_too_large');
  if (codePointLength(section.body) <= limit) return [section.body];
  const parts: string[] = [];
  const lines = sourceLines(section.body);
  let current = '';
  const flush = () => {
    if (current.length > 0) parts.push(current);
    current = '';
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = openingFence(line.content);
    if (fence !== null) {
      flush();
      let block = line.raw;
      let closed = false;
      while (++index < lines.length) {
        const next = lines[index]!;
        block += next.raw;
        if (closesFence(next.content, fence)) {
          closed = true;
          break;
        }
      }
      if (!closed) skillSourceFailure('skill_validation_failed');
      if (codePointLength(block) > limit) skillSourceFailure('skill_too_large');
      parts.push(block);
      continue;
    }

    if (section.startsWithHeading && index === 0 && codePointLength(line.raw) > limit) {
      skillSourceFailure('skill_too_large');
    }
    if (codePointLength(current) + codePointLength(line.raw) <= limit) {
      current += line.raw;
      continue;
    }
    flush();
    if (codePointLength(line.raw) <= limit) {
      current = line.raw;
      continue;
    }
    const lineParts = splitPlainLine(line, limit);
    parts.push(...lineParts.slice(0, -1));
    current = lineParts.at(-1) ?? '';
  }

  flush();
  if (parts.join('') !== section.body || parts.some((part) => codePointLength(part) > limit)) {
    skillSourceFailure('skill_validation_failed');
  }
  return parts;
}

export function chunkSkillMarkdown(input: { skillName: string; sourcePath: string; markdown: string; summary?: string | null; stripFrontmatter: boolean }): PreparedSkillDocument[] {
  validateInputText(input.skillName, true);
  validateInputText(input.sourcePath, true);
  validateInputText(input.markdown);
  if (input.summary !== undefined && input.summary !== null) validateInputText(input.summary);
  if (typeof input.stripFrontmatter !== 'boolean') skillSourceFailure('skill_validation_failed');

  const markdown = withoutSkillFrontmatter(input.markdown, input.stripFrontmatter);
  const result: PreparedSkillDocument[] = [];
  for (const section of sections(markdown)) {
    const title = `${input.skillName} — ${hierarchyTitle(section.hierarchy)}`;
    const bodyLimit = MAX_SKILL_CHUNK_CHARS - codePointLength(title) - 2;
    for (const body of splitSection(section, bodyLimit)) {
      const content = `${title}\n\n${body}`;
      if (codePointLength(content) > MAX_SKILL_CHUNK_CHARS) skillSourceFailure('skill_too_large');
      result.push({ sourcePath: input.sourcePath, chunkIndex: result.length, title, body: content, summary: input.summary ?? null, contentHash: canonicalContentHash({ title, body: content, sourcePath: input.sourcePath }), primary: result.length === 0 });
    }
  }
  // Removing each exact `${title}\n\n` prefix and joining by chunkIndex must
  // reproduce the post-frontmatter Markdown byte-for-byte.
  if (result.length === 0) skillSourceFailure('skill_validation_failed');
  if (result.length > MAX_SKILL_CHUNKS) skillSourceFailure('skill_too_large');
  return result.map((item, index) => ({ ...item, chunkIndex: index, primary: index === 0 }));
}
