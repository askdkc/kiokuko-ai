import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkSkillMarkdown, MAX_SKILL_CHUNK_CHARS } from '../../src/skills/chunking.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import type { SkillSnapshot } from '../../src/skills/types.js';

function reconstructedMarkdown(chunks: ReturnType<typeof chunkSkillMarkdown>): string {
  return chunks.map((chunk) => {
    const prefix = `${chunk.title}\n\n`;
    assert.equal(chunk.body.startsWith(prefix), true);
    return chunk.body.slice(prefix.length);
  }).join('');
}

test('chunks by headings without splitting fenced code', () => {
  const code = '```ts\n' + 'const value = 1;\n'.repeat(250) + '```';
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: `---\nname: fixture\n---\n# Code\n\n${code}`, stripFrontmatter: true });
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) assert.equal((chunk.body.match(/```/gu) ?? []).length % 2, 0);
});

test('carries the complete current H1-H6 ancestry in each chunk title', () => {
  const markdown = [
    '# Root', 'Root body.',
    '## Child', 'Child body.',
    '### Grandchild', 'Grandchild body.',
    '#### Detail', 'Detail body.',
    '##### Variant', 'Variant body.',
    '###### Edge', 'Edge body.',
    '## Sibling', 'Sibling body.',
    '# Other root', 'Other body.',
  ].join('\n\n');
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });

  assert.deepEqual(chunks.map((chunk) => chunk.title), [
    'fixture — Root',
    'fixture — Root › Child',
    'fixture — Root › Child › Grandchild',
    'fixture — Root › Child › Grandchild › Detail',
    'fixture — Root › Child › Grandchild › Detail › Variant',
    'fixture — Root › Child › Grandchild › Detail › Variant › Edge',
    'fixture — Root › Sibling',
    'fixture — Other root',
  ]);
});

test('ignores heading-shaped lines inside fences when maintaining ancestry', () => {
  const markdown = [
    '# Root',
    '```md',
    '## Not a child',
    '### Not a grandchild',
    '```',
    '## Actual child',
    'Actual body.',
  ].join('\n');
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });

  assert.deepEqual(chunks.map((chunk) => chunk.title), [
    'fixture — Root',
    'fixture — Root › Actual child',
  ]);
  assert.match(chunks[0]!.body, /## Not a child/u);
  assert.match(chunks[0]!.body, /### Not a grandchild/u);
  assert.equal((chunks[0]!.body.match(/```/gu) ?? []).length, 2);
});

test('recognizes only CommonMark fence indentation and preserves indented code exactly', () => {
  const markdown = [
    '# Root',
    '   ```md',
    '## Inside the three-space fence',
    '   ````',
    '    ```md',
    '    ## Four-space indented code',
    '    ```',
    '\t```md',
    '\t## Tab-indented code',
    '\t```',
    '## Actual child',
    'Body.',
  ].join('\n');
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });

  assert.deepEqual(chunks.map((chunk) => chunk.title), [
    'fixture — Root',
    'fixture — Root › Actual child',
  ]);
  assert.equal(reconstructedMarkdown(chunks), markdown);
  assert.match(chunks[0]!.body, /^    ```md$/mu);
  assert.match(chunks[0]!.body, /^    ## Four-space indented code$/mu);
  assert.match(chunks[0]!.body, /^\t```md$/mu);
});

test('rejects an unclosed fence, including a would-be closing fence indented four spaces', () => {
  for (const markdown of [
    '# Code\n```ts\nconst value = 1;',
    '# Code\n  ~~~ts\nconst value = 1;\n    ~~~',
  ]) {
    assert.throws(
      () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false }),
      /skill_validation_failed/u,
    );
  }
});

test('fails closed on container-prefixed fences instead of splitting through them', () => {
  for (const markdown of [
    `> \`\`\`js\n> ${'x'.repeat(20_000)}\n> \`\`\`\n`,
    `- ~~~js\n  ${'x'.repeat(20_000)}\n  ~~~\n`,
    `> - \`\`\`js\n>   ${'x'.repeat(20_000)}\n>   \`\`\`\n`,
    `10. item\n\n    \`\`\`js\n    ${'x'.repeat(20_000)}\n    \`\`\`\n`,
    `> 10. item\n>\n>     \`\`\`js\n>     ${'x'.repeat(20_000)}\n>     \`\`\`\n`,
    `1. item\n\n   # nested heading\n\n    \`\`\`js\n    ${'x'.repeat(20_000)}\n    \`\`\`\n`,
    `1. item\n\n\t\`\`\`js\n\t${'x'.repeat(20_000)}\n\t\`\`\`\n`,
    `10. item\n\n    > \`\`\`js\n    > ${'x'.repeat(20_000)}\n    > \`\`\`\n`,
  ]) {
    assert.throws(
      () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false }),
      /skill_validation_failed/u,
    );
  }
});

test('accepts heading components at the exact bound and rejects content-loss truncation', () => {
  const component = (character: string) => character.repeat(200);
  const markdown = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} ${component(String(index + 1))}\n\nBody ${index + 1}.`).join('\n\n');
  const first = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });
  const second = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });
  const deepest = first.at(-1)!;

  assert.deepEqual(first.map((chunk) => chunk.title), second.map((chunk) => chunk.title));
  assert.equal(deepest.title, `fixture — ${Array.from({ length: 6 }, (_, index) => String(index + 1).repeat(200)).join(' › ')}`);
  assert.ok(first.every((chunk) => chunk.body.length <= MAX_SKILL_CHUNK_CHARS));
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: `# ${'x'.repeat(201)}\n\nBody.`, stripFrontmatter: false }),
    /skill_too_large/u,
  );
});

test('parses indented ATX headings and removes optional closing markers', () => {
  const chunks = chunkSkillMarkdown({
    skillName: 'fixture',
    sourcePath: 'skills/fixture/SKILL.md',
    markdown: ' # Parent ###\nParent body.\n   ## Child ##   \nChild body.',
    stripFrontmatter: false,
  });
  assert.deepEqual(chunks.map((chunk) => chunk.title), ['fixture — Parent', 'fixture — Parent › Child']);
});

test('rejects an indivisible fenced block larger than the chunk cap', () => {
  const code = '~~~ts\n' + 'const value = 1;\n'.repeat(500) + '~~~';
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: `# Code\n\n${code}`, stripFrontmatter: false }),
    /skill_too_large/u,
  );
});

test('splits a long plain-text line without emitting an oversized chunk', () => {
  const markdown = `# Text\n\nstart-${'x'.repeat(20_000)}-end`;
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk.body).length <= MAX_SKILL_CHUNK_CHARS));
  assert.ok(chunks.some((chunk) => chunk.body.includes('start-')));
  assert.ok(chunks.some((chunk) => chunk.body.includes('-end')));
  assert.equal(reconstructedMarkdown(chunks), markdown);
});

test('retains the selected long-line boundary space without changing any code point', () => {
  const line = `${'a'.repeat(7_000)} boundary-space ${'🧠'.repeat(10_000)}`;
  const markdown = `# Text\r\n${line}\r\n`;
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });

  assert.ok(chunks.length > 2);
  assert.equal(reconstructedMarkdown(chunks), markdown);
  assert.equal(reconstructedMarkdown(chunks).split(' boundary-space ').length, 2);
  assert.ok(chunks.every((chunk) => Array.from(chunk.body).length <= MAX_SKILL_CHUNK_CHARS));
  assert.equal(chunks.some((chunk) => chunk.body.endsWith('\r')), false);
});

test('preserves CRLF, trailing spaces, indentation, headings, and fences byte-for-byte', () => {
  const markdown = [
    '',
    '# Root  ',
    '  indented prose  ',
    '   ```md',
    '## Not a child',
    '   ```',
    '',
    '## Child',
    '\tindented content\t',
    '',
  ].join('\r\n');
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false });

  assert.equal(reconstructedMarkdown(chunks), markdown);
  assert.deepEqual(chunks.map((chunk) => chunk.title), [
    'fixture — Overview',
    'fixture — Root',
    'fixture — Root › Child',
  ]);
});

test('preserves bounded headings and splits long lines only at Unicode code-point boundaries', () => {
  const heading = '🧠'.repeat(200);
  const chunks = chunkSkillMarkdown({
    skillName: 'fixture',
    sourcePath: 'skills/fixture/SKILL.md',
    markdown: `# ${heading}\n\n${'🚀'.repeat(20_000)}`,
    stripFrontmatter: false,
  });
  assert.ok(chunks.length > 1);
  assert.equal(Array.from(chunks[0]!.title.replace('fixture — ', '')).length, 200);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk.body).length <= MAX_SKILL_CHUNK_CHARS);
    assert.equal(/[\p{Cs}\uFFFD]/u.test(chunk.title), false);
    assert.equal(/[\p{Cs}\uFFFD]/u.test(chunk.body), false);
  }
  assert.throws(
    () => chunkSkillMarkdown({
      skillName: 'fixture',
      sourcePath: 'skills/fixture/SKILL.md',
      markdown: `# ${'🧠'.repeat(201)}\n\nBody.`,
      stripFrontmatter: false,
    }),
    /skill_too_large/u,
  );
});

test('rejects malformed UTF-16 and replacement characters before chunking', () => {
  for (const malformed of ['\ud800', '\udfff', '\uFFFD']) {
    assert.throws(
      () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: `# Safe\n\n${malformed}`, stripFrontmatter: false }),
      /skill_validation_failed/u,
    );
  }
});

test('preserves heading-only sections and never invents an Overview for empty input', () => {
  const chunks = chunkSkillMarkdown({
    skillName: 'fixture',
    sourcePath: 'skills/fixture/SKILL.md',
    markdown: '# Parent\n## Child\nChild body.\n### Trailing',
    stripFrontmatter: false,
  });
  assert.deepEqual(chunks.map(({ title, body }) => ({ title, body })), [
    { title: 'fixture — Parent', body: 'fixture — Parent\n\n# Parent\n' },
    { title: 'fixture — Parent › Child', body: 'fixture — Parent › Child\n\n## Child\nChild body.\n' },
    { title: 'fixture — Parent › Child › Trailing', body: 'fixture — Parent › Child › Trailing\n\n### Trailing' },
  ]);
  assert.equal(reconstructedMarkdown(chunks), '# Parent\n## Child\nChild body.\n### Trailing');
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: '', stripFrontmatter: false }),
    /skill_validation_failed/u,
  );
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: '#   ', stripFrontmatter: false }),
    /skill_validation_failed/u,
  );
});

test('rejects an oversized raw heading instead of splitting it across chunks', () => {
  assert.throws(
    () => chunkSkillMarkdown({
      skillName: 'fixture',
      sourcePath: 'skills/fixture/SKILL.md',
      markdown: `# Heading ${'#'.repeat(MAX_SKILL_CHUNK_CHARS)}\nBody.`,
      stripFrontmatter: false,
    }),
    /skill_too_large/u,
  );
});

test('strips frontmatter only when the caller explicitly marks the primary document', () => {
  const markdown = '---\nname: retained-reference\n---\n# Reference\nReference body.';
  const reference = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/references/notes.md', markdown, stripFrontmatter: false });
  assert.match(reference[0]!.body, /name: retained-reference/u);

  const primary = chunkSkillMarkdown({
    skillName: 'fixture',
    sourcePath: 'skills/fixture/SKILL.md',
    markdown,
    stripFrontmatter: true,
  });
  assert.doesNotMatch(primary[0]!.body, /name: retained-reference/u);
  assert.equal(reconstructedMarkdown(primary), '# Reference\nReference body.');
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown: '# No frontmatter', stripFrontmatter: true }),
    /skill_validation_failed/u,
  );
});

test('strips CRLF frontmatter without normalizing the retained Markdown', () => {
  const markdown = '---\r\nname: fixture\r\n---\r\n# Primary\r\n  Body.  \r\n';
  const chunks = chunkSkillMarkdown({
    skillName: 'fixture',
    sourcePath: 'skills/fixture/SKILL.md',
    markdown,
    stripFrontmatter: true,
  });

  assert.equal(reconstructedMarkdown(chunks), '# Primary\r\n  Body.  \r\n');
});

test('does not mistake ordinary horizontal rules in a reference file for frontmatter', () => {
  const chunks = chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/references/rules.md', markdown: '---\nKeep this paragraph.\n---\nKeep this one too.', stripFrontmatter: false });
  assert.match(chunks[0]!.body, /Keep this paragraph/u);
  assert.match(chunks[0]!.body, /Keep this one too/u);
});

test('rejects a skill that exceeds the whole-document chunk limit', () => {
  const markdown = Array.from({ length: 70 }, (_, index) => `## Section ${index}\n\n${'x'.repeat(2_000)}`).join('\n\n');
  assert.throws(
    () => chunkSkillMarkdown({ skillName: 'fixture', sourcePath: 'skills/fixture/SKILL.md', markdown, stripFrontmatter: false }),
    /skill_too_large/u,
  );
});

test('applies the 64 chunk cap to the whole snapshot, not once per file', () => {
  const markdown = Array.from({ length: 23 }, (_, index) => `## Section ${index}\n\n${'x'.repeat(3_980)}`).join('\n\n');
  const snapshot: SkillSnapshot = {
    candidate: { id: 'fixture', provider: 'fixture', name: 'fixture', slug: 'fixture', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 0, duplicate: false, officialStatus: 'catalog-verified' },
    sourceCommit: 'dddddddddddddddddddddddddddddddddddddddd',
    snapshotHash: 'snapshot',
    frontmatter: { name: 'fixture', description: null, disableModelInvocation: false },
    files: [
      { path: 'skills/fixture/SKILL.md', content: `---\nname: fixture\n---\n${markdown}`, contentHash: 'one', primary: true },
      { path: 'skills/fixture/references/one.md', content: markdown, contentHash: 'two', primary: false },
      { path: 'skills/fixture/references/two.md', content: markdown, contentHash: 'three', primary: false },
    ],
  };
  assert.throws(() => documentsFromSkillSnapshot(snapshot), /skill_too_large/u);
});

test('snapshot preparation strips only the validated primary frontmatter', () => {
  const snapshot: SkillSnapshot = {
    candidate: { id: 'fixture', provider: 'fixture', name: 'fixture', slug: 'fixture', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 0, duplicate: false, officialStatus: 'catalog-verified' },
    sourceCommit: 'd'.repeat(40),
    snapshotHash: 'snapshot',
    frontmatter: { name: 'fixture', description: null, disableModelInvocation: false },
    files: [
      { path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Primary\nPrimary body.', contentHash: 'one', primary: true },
      { path: 'skills/fixture/references/notes.md', content: '---\nname: reference-content\n---\n# Notes\nReference body.', contentHash: 'two', primary: false },
    ],
  };
  const documents = documentsFromSkillSnapshot(snapshot);
  const primary = documents.find((document) => document.sourcePath.endsWith('/SKILL.md'))!;
  const reference = documents.find((document) => document.sourcePath.endsWith('/notes.md'))!;
  assert.doesNotMatch(primary.body, /name: fixture/u);
  assert.match(reference.body, /name: reference-content/u);
});
