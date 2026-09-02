import { createScanner, parseTree, SyntaxKind, type Node, type ParseError, type ParseOptions } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import { isWellFormedUnicode } from '../serialization/boundary-json.js';

export const MAX_STRICT_JSON_DEPTH = 128;

function invalidJson(message: string): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', message);
}

function assertBoundedTokens(source: string, message: string): void {
  if (source.charCodeAt(0) === 0xFEFF) throw invalidJson(message);

  const scanner = createScanner(source, false);
  let depth = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EOF) return;
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      depth += 1;
      if (depth > MAX_STRICT_JSON_DEPTH) throw invalidJson(message);
      continue;
    }
    if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token === SyntaxKind.NumericLiteral && !Number.isFinite(Number(scanner.getTokenValue()))) {
      throw invalidJson(message);
    }
  }
}

function assertUniqueFiniteTree(root: Node, message: string): void {
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) throw invalidJson(message);
    if (node.type === 'number' && !Number.isFinite(node.value)) throw invalidJson(message);
    if (node.type === 'string' && (typeof node.value !== 'string' || !isWellFormedUnicode(node.value))) {
      throw invalidJson(message);
    }
    if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push(child);
      continue;
    }
    if (node.type !== 'object') continue;

    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const children = property.type === 'property' ? property.children : undefined;
      const keyNode = children?.[0];
      const valueNode = children?.[1];
      if (children?.length !== 2
        || keyNode?.type !== 'string'
        || typeof keyNode.value !== 'string'
        || !isWellFormedUnicode(keyNode.value)
        || valueNode === undefined) {
        throw invalidJson(message);
      }
      if (seen.has(keyNode.value)) throw invalidJson(message);
      seen.add(keyNode.value);
      pending.push(valueNode);
    }
  }
}

/** Validate a bounded JSON/JSONC document without allowing duplicate keys or non-finite numbers. */
export function assertStrictJsonSyntax(source: string, options: ParseOptions, message: string): void {
  assertBoundedTokens(source, message);
  const errors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(source, errors, options);
  } catch (error) {
    if (error instanceof RangeError) throw invalidJson(message);
    throw error;
  }
  if (root === undefined || errors.length > 0) throw new KiokukoError('VALIDATION_ERROR', message);
  assertUniqueFiniteTree(root, message);
}

/** Parse standard JSON after applying the shared strict syntax and identity checks. */
export function parseStrictJson(source: string, options: ParseOptions, message: string): unknown {
  assertStrictJsonSyntax(source, options, message);
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidJson(message);
    throw error;
  }
}
