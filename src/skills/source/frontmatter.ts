import { isMap, isPair, isScalar, parseDocument, Scalar, type ParsedNode } from 'yaml';
import { skillSourceFailure } from './errors.js';

export interface SkillFrontmatter {
  name: string;
  description: string | null;
  disableModelInvocation: boolean;
}

export const MAX_FRONTMATTER_BYTES = 8_192;

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:@+/-]{0,200}$/u;
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;
const INVALID_DESCRIPTION_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const FRONTMATTER_FIELDS = new Set(['name', 'description', 'disable-model-invocation']);

export function validSkillFrontmatterName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && !INVALID_UNICODE.test(value);
}

function validationFailure(): never {
  return skillSourceFailure('skill_validation_failed');
}

function containsPhysicalLineBreak(source: string, node: ParsedNode): boolean {
  if (node.range === undefined || node.range === null) validationFailure();
  return /[\r\n]/u.test(source.slice(node.range[0], node.range[1]));
}

function validScalarNode(source: string, node: unknown): node is Scalar<unknown> & ParsedNode {
  return isScalar(node)
    && node.tag === undefined
    && node.anchor === undefined
    && node.type !== Scalar.BLOCK_FOLDED
    && node.type !== Scalar.BLOCK_LITERAL
    && !containsPhysicalLineBreak(source, node as ParsedNode);
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  if (typeof content !== 'string'
    || INVALID_UNICODE.test(content)
    || Buffer.byteLength(content, 'utf8') > 150_000) validationFailure();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) validationFailure();
  const source = match[1]!;
  if (Buffer.byteLength(source, 'utf8') > MAX_FRONTMATTER_BYTES) validationFailure();

  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    resolveKnownTags: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0
    || !isMap(document.contents)
    || document.contents.flow === true
    || document.contents.tag !== undefined
    || document.contents.anchor !== undefined) validationFailure();

  const fields = new Map<string, unknown>();
  for (const pair of document.contents.items) {
    if (!isPair(pair)
      || !validScalarNode(source, pair.key)
      || pair.key.type !== Scalar.PLAIN
      || typeof pair.key.value !== 'string'
      || !FRONTMATTER_FIELDS.has(pair.key.value)
      || fields.has(pair.key.value)
      || !validScalarNode(source, pair.value)) validationFailure();
    fields.set(pair.key.value, pair.value.value);
  }

  const name = fields.get('name');
  if (!validSkillFrontmatterName(name)) validationFailure();
  const description = fields.get('description');
  if (description !== undefined && (typeof description !== 'string'
    || description.length > 2_000
    || INVALID_DESCRIPTION_CHARACTERS.test(description))) validationFailure();
  const disabled = fields.get('disable-model-invocation');
  if (disabled !== undefined && typeof disabled !== 'boolean') validationFailure();
  return { name, description: description ?? null, disableModelInvocation: disabled ?? false };
}
