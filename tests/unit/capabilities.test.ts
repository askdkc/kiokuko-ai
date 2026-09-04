import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CAPABILITY_ITEMS,
  MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS,
  MAX_RAW_CAPABILITY_DESCRIPTION_CHARS,
  MEMORY_REASONING_SKILL_NAME,
  compactCapabilityDescription,
  deriveMemoryPolicy,
  deriveMemoryUseSignal,
  hasBlockingRequiredCapability,
  memoryReasoningCapabilityAvailability,
  normalizeCapabilityCatalog,
  resolveCapabilities as resolveCapabilitiesCore,
} from '../../src/akinator/capabilities.js';
import { STANDARD_SOUL_SKILL_NAME } from '../../src/setup/standard-skills.js';

const buildProfile = {
  taskType: 'build' as const,
  target: 'src/beacon.ts',
  expected: 'The test suite passes',
  constraints: null,
};

type CapabilityTestInput = Omit<Parameters<typeof resolveCapabilitiesCore>[0], 'memoryUse'> & {
  memoryUse?: 'none' | 'actionable';
};

function resolveCapabilities(input: CapabilityTestInput) {
  const { memoryUse = 'none', ...resolutionInput } = input;
  return resolveCapabilitiesCore({
    ...resolutionInput,
    memoryUse,
  });
}

test('classifies only strongly matched delivered context as actionable memory', () => {
  assert.equal(deriveMemoryUseSignal(null), 'none');
  assert.equal(deriveMemoryUseSignal({ deliveryId: null, items: [{ selectionReasons: ['word_match'] }] }), 'none');
  assert.equal(deriveMemoryUseSignal({ deliveryId: 'context-1', items: [{ selectionReasons: ['literal_fallback_match'] }] }), 'none');
  for (const reason of [
    'exact_signal_match',
    'word_match',
    'lexical_match',
    'cjk_window_match',
    'applicability_match',
    'tag_match',
    'changed_path_match',
    'error_signature_match',
    'helpful_feedback',
  ]) {
    assert.equal(
      deriveMemoryUseSignal({ deliveryId: 'context-1', items: [{ selectionReasons: [reason] }] }),
      'actionable',
      `${reason} must make delivered memory actionable`,
    );
  }
});

test('compacts capability descriptions deterministically without splitting Unicode code points', () => {
  const below = compactCapabilityDescription('a'.repeat(1_999));
  const unchanged = compactCapabilityDescription('a'.repeat(2_000));
  const shortened = compactCapabilityDescription('a'.repeat(2_001));
  const whitespace = compactCapabilityDescription('  first\n\tsecond\u0000 third  ');
  const emoji = compactCapabilityDescription('😀'.repeat(2_001));
  const normalized = compactCapabilityDescription('Ａ\n\tＢ  C');
  const controlsOnly = compactCapabilityDescription('\u0000\u0001\u200B');

  assert.deepEqual(below, { description: 'a'.repeat(1_999), truncated: false });
  assert.deepEqual(unchanged, { description: 'a'.repeat(2_000), truncated: false });
  assert.equal(Array.from(shortened.description).length, 2_000);
  assert.equal(shortened.description.endsWith('…'), true);
  assert.equal(whitespace.description, 'first second third');
  assert.equal(whitespace.truncated, false);
  assert.equal(Array.from(emoji.description).length, 2_000);
  assert.equal(emoji.description.endsWith('…'), true);
  assert.equal(emoji.description.includes('\uFFFD'), false);
  assert.deepEqual(normalized, { description: 'A B C', truncated: false });
  assert.deepEqual(controlsOnly, { description: '', truncated: false });
  assert.deepEqual(compactCapabilityDescription('a'.repeat(2_001)), shortened);
});

test('keeps raw description boundaries and degrades oversized values to name-only', () => {
  for (const length of [MAX_RAW_CAPABILITY_DESCRIPTION_CHARS - 1, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS]) {
    const normalized = normalizeCapabilityCatalog([{ kind: 'skill', name: `raw-${length}`, description: 'x'.repeat(length) }]);
    assert.equal(normalized.skills[0]?.description?.length, 2_000);
    assert.equal(normalized.diagnostics.accepted, 1);
  }
  const raw = [{ kind: 'skill', name: 'raw-over', description: 'secret-private-path '.repeat(4_000) }];
  const normalized = normalizeCapabilityCatalog(raw);
  assert.deepEqual(normalized.skills, [{ kind: 'skill', name: 'raw-over' }]);
  assert.deepEqual(normalized.diagnostics, { received: 1, accepted: 1, truncated: 1, dropped: 0 });
  assert.equal(JSON.stringify(normalized).includes('secret-private-path'), false);
  assert.equal(raw[0]!.description.startsWith('secret-private-path'), true);
});

test('normalizes catalog entries individually and preserves catalog availability', () => {
  const raw = [
    { kind: 'skill', name: 'keep-this-name', description: 'x'.repeat(64_001) },
    { kind: 'unknown', name: 'drop-invalid-kind' },
    { kind: 'skill', name: '' },
    { kind: 'mcp_tool', name: 'keep-tool', description: 42 },
  ];
  const normalized = normalizeCapabilityCatalog(raw);

  assert.equal(normalized.availability, 'unknown');
  assert.deepEqual(normalized.skills.map((item) => item.name), ['keep-this-name']);
  assert.deepEqual(normalized.tools, []);
  assert.equal(normalized.skills[0]?.description, undefined);
  assert.deepEqual(normalized.diagnostics, { received: 4, accepted: 1, truncated: 1, dropped: 3 });
  assert.deepEqual(raw[0], { kind: 'skill', name: 'keep-this-name', description: 'x'.repeat(64_001) });
});

test('keeps a valid recommendation when malformed catalog items are adjacent', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [
      { kind: 'invalid', name: 'before' },
      { kind: 'skill', name: 'tdd', description: 'Use a test-first implementation workflow.' },
      { kind: 'skill', name: '' },
    ],
  });

  assert.deepEqual(result.diagnostics, { received: 3, accepted: 1, truncated: 0, dropped: 2 });
  assert.ok(result.recommendations.some((item) => item.name === 'tdd'
    && item.availability === 'available'
    && item.source === 'akinator_policy'));
});

test('fails closed when catalog items are invalid or omitted at processing boundaries', () => {
  const twoHundred = Array.from({ length: MAX_CAPABILITY_ITEMS }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` }));
  const below = normalizeCapabilityCatalog(twoHundred.slice(0, 199));
  const exact = normalizeCapabilityCatalog(twoHundred);
  const over = normalizeCapabilityCatalog([...twoHundred, { kind: 'mcp_tool', name: 'tool-200' }]);
  const invalid = normalizeCapabilityCatalog([{ kind: 'invalid', name: 'invalid' }]);
  assert.deepEqual(below.diagnostics, { received: 199, accepted: 199, truncated: 0, dropped: 0 });
  assert.deepEqual(exact.diagnostics, { received: 200, accepted: 200, truncated: 0, dropped: 0 });
  assert.deepEqual(over.diagnostics, { received: 201, accepted: 200, truncated: 0, dropped: 1 });
  assert.equal(over.availability, 'unknown');
  assert.equal(invalid.availability, 'unknown');
  assert.deepEqual(invalid.diagnostics, { received: 1, accepted: 0, truncated: 0, dropped: 1 });
});

function aggregateCatalog(lastDescriptionLength: number, withUnreadSuffix = false): Array<unknown> {
  const catalog: Array<unknown> = [
    ...Array.from({ length: 7 }, () => ({ kind: 'mcp_tool', name: 'x', description: 'a'.repeat(MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) })),
    { kind: 'skill', name: 'y', description: 'b'.repeat(lastDescriptionLength) },
  ];
  if (withUnreadSuffix) {
    Object.defineProperty(catalog, 8, {
      enumerable: true,
      get() { throw new Error('aggregate budget suffix was scanned'); },
    });
    catalog.length = 9;
  }
  return catalog;
}

test('enforces aggregate capability budget at minus-one, exact, and plus-one boundaries', () => {
  const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
    - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
    - 8;
  const below = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription - 1));
  const exact = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription));
  const over = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription + 1, true));
  assert.equal(below.budgetExceeded, false);
  assert.equal(exact.budgetExceeded, false);
  assert.deepEqual(exact.diagnostics, { received: 8, accepted: 8, truncated: 8, dropped: 0 });
  assert.equal(over.availability, 'unknown');
  assert.equal(over.budgetExceeded, true);
  assert.deepEqual(over.skills, [{ kind: 'skill', name: 'y' }]);
  assert.deepEqual(over.diagnostics, { received: 9, accepted: 8, truncated: 8, dropped: 1 });
  assert.deepEqual(normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription + 1)).diagnostics, {
    received: 8, accepted: 8, truncated: 8, dropped: 0,
  });
});

test('reports a fixed budget warning without echoing omitted catalog content', () => {
  const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
    - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
    - 8;
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: aggregateCatalog(finalExactDescription + 1),
  });
  assert.ok(result.warnings.some((warning) => warning.code === 'CAPABILITY_CATALOG_BUDGET_EXCEEDED'
    && warning.message === 'Some capability catalog data was omitted because the catalog exceeded its processing budget.'));
  assert.equal(JSON.stringify(result).includes('b'.repeat(2_001)), false);
});

test('reports Akinator skill recommendations as unknown without a client catalog', () => {
  const result = resolveCapabilities({
    task: 'Implement a beacon',
    profile: buildProfile,
    recommendedTags: ['bot:builder', 'skill:tdd'],
  });

  assert.equal(result.catalogProvided, false);
  assert.equal(result.availableSkillCount, null);
  assert.deepEqual(result.recommendations.map(({ kind, name, availability, source }) => ({ kind, name, availability, source })), [{
    kind: 'skill',
    name: STANDARD_SOUL_SKILL_NAME,
    availability: 'unknown',
    source: 'akinator_policy',
  }, {
    kind: 'skill',
    name: 'tdd',
    availability: 'unknown',
    source: 'akinator_policy',
  }, {
    kind: 'skill',
    name: 'kiokuko-single-purpose-functions',
    availability: 'unknown',
    source: 'akinator_policy',
  }]);
});

test('matches available skills and relevant MCP tools without treating missing skills as installed', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [
      { kind: 'skill', name: 'catalog:tdd', description: 'Test-first implementation' },
      { kind: 'skill', name: 'repository-explorer', description: 'Inspect repository code and tests' },
      { kind: 'mcp_tool', name: 'github_search_code', description: 'Search repository code and tests' },
      { kind: 'mcp_tool', name: 'calendar_list_events', description: 'List calendar events' },
    ],
  });

  assert.equal(result.availableSkillCount, 2);
  assert.ok(result.recommendations.some((item) => item.name === 'catalog:tdd' && item.availability === 'available' && item.source === 'akinator_policy'));
  assert.ok(result.recommendations.some((item) => item.name === 'repository-explorer' && item.availability === 'available' && item.source === 'catalog_similarity'));
  assert.ok(result.recommendations.some((item) => item.name === 'github_search_code' && item.kind === 'mcp_tool'));
  assert.ok(!result.recommendations.some((item) => item.name === 'calendar_list_events'));
  assert.equal(result.recommendations.filter((item) => item.name.endsWith('tdd')).length, 1);
});

test('classifies a non-empty catalog without any installed Skills', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [{ kind: 'mcp_tool', name: 'github_search_code' }],
  });

  assert.equal(result.catalogProvided, true);
  assert.equal(result.availableSkillCount, 0);
});

test('classifies an explicitly empty catalog', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [],
  });

  assert.equal(result.availability, 'known-empty');
});

test('classifies an unclassifiable catalog as unknown', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: { skills: [] },
  });

  assert.equal(result.availability, 'unknown');
  assert.equal(result.warnings[0]?.code, 'CAPABILITY_CATALOG_UNAVAILABLE');
});

test('does not echo long or secret-like descriptions in capability warnings', () => {
  const secret = 'sk-live-secret-value';
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{ kind: 'mcp_tool', name: 'safe-tool', description: `${secret} ${'x'.repeat(64_001)}` }],
  });

  assert.equal(result.availability, 'known-nonempty');
  assert.equal(result.diagnostics.truncated, 1);
  assert.equal(result.warnings.some((warning) => warning.message.includes(secret)), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('recommends the standard UI skill for explicit English and Japanese UI work', () => {
  const capabilities = [{
    kind: 'skill' as const,
    name: 'kiokuko-ui-design-soul',
    description: 'Apply HIG principles to app and web UI design, implementation, and review.',
  }];
  for (const task of [
    'Review the SwiftUI screen and its asynchronous save button states',
    '画面の保存ボタンについて処理中・成功・失敗とアクセシビリティを実装する',
  ]) {
    const result = resolveCapabilities({
      task,
      profile: { ...buildProfile, target: 'app interface' },
      recommendedTags: ['bot:builder'],
      capabilities,
    });
    assert.ok(result.recommendations.some((item) => item.name === 'kiokuko-ui-design-soul'
      && item.availability === 'available'
      && item.source === 'akinator_policy'));
  }
});

test('does not recommend the UI skill for generic design, backend-only, or image-only tasks', () => {
  const capabilities = [{ kind: 'skill' as const, name: 'kiokuko-ui-design-soul' }];
  for (const task of [
    'Design the service architecture and database boundaries',
    'Implement a backend-only API for account records',
    'Create a landscape image; image generation only',
  ]) {
    const result = resolveCapabilities({
      task,
      profile: { ...buildProfile, target: 'service architecture' },
      recommendedTags: [],
      capabilities,
    });
    assert.ok(!result.recommendations.some((item) => item.name === 'kiokuko-ui-design-soul'));
  }
});

test('recommends the standard function skill for explicit coding work across languages', () => {
  const capabilities = [{
    kind: 'skill' as const,
    name: 'kiokuko-single-purpose-functions',
    description: 'Apply cohesive function contracts while writing or reviewing code in any language.',
  }];
  for (const input of [
    { task: 'Refactor the PHP service method and add unit tests', profile: buildProfile },
    { task: 'Pythonの関数をリファクタして型チェックと単体テストを追加する', profile: buildProfile },
    { task: 'Review this Rust pull request for unsafe state transitions', profile: { ...buildProfile, taskType: 'review' as const } },
  ]) {
    const result = resolveCapabilities({
      task: input.task,
      profile: input.profile,
      recommendedTags: [],
      capabilities,
    });
    assert.ok(result.recommendations.some((item) => item.name === 'kiokuko-single-purpose-functions'
      && item.availability === 'available'
      && item.source === 'akinator_policy'));
  }
});

test('does not recommend the standard function skill for explicitly non-coding work', () => {
  const capabilities = [{ kind: 'skill' as const, name: 'kiokuko-single-purpose-functions' }];
  for (const task of [
    'Write release notes without changing code',
    'Create a product illustration; image generation only',
    'Draft the conference program and speaker schedule',
    'コードを変更しないでアーキテクチャ文書だけをレビューする',
  ]) {
    const result = resolveCapabilities({
      task,
      profile: { ...buildProfile, taskType: 'writing', target: 'release notes' },
      recommendedTags: [],
      capabilities,
    });
    assert.ok(!result.recommendations.some((item) => item.name === 'kiokuko-single-purpose-functions'));
  }
});

test('requires the exact master SOUL first for every task type', () => {
  for (const taskType of ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const) {
    const missing = resolveCapabilities({
      task: 'Handle the requested work',
      profile: { ...buildProfile, taskType },
      recommendedTags: [],
      capabilities: [],
    });
    const recommendation = missing.recommendations[0];
    assert.deepEqual(recommendation && {
      name: recommendation.name,
      availability: recommendation.availability,
      required: recommendation.required,
    }, {
      name: STANDARD_SOUL_SKILL_NAME,
      availability: 'missing',
      required: true,
    });
    assert.equal(hasBlockingRequiredCapability(missing), true);
  }

  const unclassified = resolveCapabilities({
    task: 'Handle the requested work',
    profile: { ...buildProfile, taskType: null },
    recommendedTags: [],
    capabilities: [],
  });
  assert.equal(unclassified.recommendations[0]?.name, STANDARD_SOUL_SKILL_NAME);
  assert.equal(unclassified.recommendations[0]?.required, true);
  assert.equal(hasBlockingRequiredCapability(unclassified), true);
});

test('does not satisfy the required master SOUL with an alias or similarly named capability', () => {
  for (const capability of [
    { kind: 'skill' as const, name: `external:${STANDARD_SOUL_SKILL_NAME}` },
    { kind: 'skill' as const, name: 'kiokuko_soul' },
    { kind: 'mcp_tool' as const, name: STANDARD_SOUL_SKILL_NAME },
  ]) {
    const result = resolveCapabilities({
      task: 'Build the requested change',
      profile: buildProfile,
      recommendedTags: [],
      capabilities: [capability],
    });
    const recommendation = result.recommendations[0];
    assert.equal(recommendation?.name, STANDARD_SOUL_SKILL_NAME);
    assert.equal(recommendation?.availability, 'missing');
    assert.equal(recommendation?.required, true);
  }

  const available = resolveCapabilities({
    task: 'Build the requested change',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{ kind: 'skill', name: STANDARD_SOUL_SKILL_NAME }],
  });
  assert.equal(available.recommendations[0]?.availability, 'available');
  assert.equal(hasBlockingRequiredCapability(available), false);
});

test('recommends memory-reasoning for actionable build memory without withholding context', () => {
  const missing = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [],
    memoryUse: 'actionable',
  });
  const recommendation = missing.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
  assert.deepEqual(recommendation && {
    name: recommendation.name,
    availability: recommendation.availability,
    source: recommendation.source,
    required: recommendation.required,
  }, {
    name: MEMORY_REASONING_SKILL_NAME,
    availability: 'missing',
    source: 'akinator_policy',
    required: true,
  });

  const available = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{ kind: 'skill', name: MEMORY_REASONING_SKILL_NAME }],
    memoryUse: 'actionable',
  });
  assert.ok(available.recommendations.some((item) => item.name === MEMORY_REASONING_SKILL_NAME
    && item.availability === 'available'
    && item.required === true));
});

test('derives an explicit non-withholding memory policy for available, missing, unknown, and irrelevant contexts', () => {
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'actionable', [
    { kind: 'skill', name: MEMORY_REASONING_SKILL_NAME },
  ]), {
    memoryReasoningRequired: true,
    contextWithheld: false,
    withheldReason: null,
  });
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'actionable', []), {
    memoryReasoningRequired: true,
    contextWithheld: false,
    withheldReason: null,
  });
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'actionable', undefined), {
    memoryReasoningRequired: true,
    contextWithheld: false,
    withheldReason: null,
  });
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'none', []), {
    memoryReasoningRequired: false,
    contextWithheld: false,
    withheldReason: null,
  });

  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'none', [], {
    contextItemCount: 0,
    storedEntryCount: 3,
  }), {
    memoryReasoningRequired: false,
    contextWithheld: false,
    withheldReason: null,
    deliveryEmpty: true,
    storedEntryCount: 3,
  });
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'none', [], {
    contextItemCount: null,
    storedEntryCount: 2,
  }), {
    memoryReasoningRequired: false,
    contextWithheld: false,
    withheldReason: null,
    deliveryEmpty: true,
    storedEntryCount: 2,
  });
  assert.deepEqual(deriveMemoryPolicy(buildProfile, 'none', [], {
    contextItemCount: 1,
    storedEntryCount: 3,
  }), {
    memoryReasoningRequired: false,
    contextWithheld: false,
    withheldReason: null,
  });
});

test('requires memory-reasoning for actionable debug memory', () => {
  const result = resolveCapabilities({
    task: 'Debug the failing beacon test',
    profile: { ...buildProfile, taskType: 'debug' },
    recommendedTags: [],
    capabilities: [],
    memoryUse: 'actionable',
  });
  const recommendation = result.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
  assert.equal(recommendation?.name, MEMORY_REASONING_SKILL_NAME);
  assert.equal(recommendation?.availability, 'missing');
});

test('reports required memory-reasoning as unknown for an absent or malformed catalog', () => {
  for (const capabilities of [undefined, { skills: [] }, [{ kind: 'invalid', name: 'memory-reasoning' }]]) {
    const result = resolveCapabilities({
      task: 'Implement repository tests for the beacon',
      profile: buildProfile,
      recommendedTags: [],
      ...(capabilities === undefined ? {} : { capabilities }),
      memoryUse: 'actionable',
    });
    const recommendation = result.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
    assert.equal(recommendation?.name, MEMORY_REASONING_SKILL_NAME);
    assert.equal(recommendation?.availability, 'unknown');
  }
});

test('does not request memory-reasoning for no memory or non-repair tasks', () => {
  const cases = [
    { memoryUse: 'none' as const, profile: buildProfile },
    { memoryUse: 'actionable' as const, profile: { ...buildProfile, taskType: 'research' as const } },
  ];
  for (const input of cases) {
    const result = resolveCapabilities({
      task: 'Review stored project context',
      profile: input.profile,
      recommendedTags: [],
      capabilities: [],
      memoryUse: input.memoryUse,
    });
    assert.equal(result.recommendations.some((item) => item.name === MEMORY_REASONING_SKILL_NAME), false);
  }
});

test('does not expose memory-reasoning through catalog similarity', () => {
  const result = resolveCapabilities({
    task: 'Explain memory reasoning for repository changes',
    profile: { ...buildProfile, taskType: 'analysis' },
    recommendedTags: [],
    capabilities: [{ kind: 'skill', name: MEMORY_REASONING_SKILL_NAME, description: 'Reason over memory' }],
    memoryUse: 'none',
  });
  assert.equal(result.recommendations.some((item) => item.name === MEMORY_REASONING_SKILL_NAME), false);
});

test('does not treat a same-named MCP tool as the required memory-reasoning Skill', () => {
  const result = resolveCapabilities({
    task: 'Implement repository memory reasoning changes',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{
      kind: 'mcp_tool',
      name: MEMORY_REASONING_SKILL_NAME,
      description: 'Reason over repository memory changes',
    }],
    memoryUse: 'actionable',
  });
  const matching = result.recommendations.filter((item) => item.name === MEMORY_REASONING_SKILL_NAME);
  assert.equal(matching.length, 1);
  assert.deepEqual(matching.map(({ kind, name, availability, source, required }) => ({
    kind, name, availability, source, required,
  })), [{
    kind: 'skill',
    name: MEMORY_REASONING_SKILL_NAME,
    availability: 'missing',
    source: 'akinator_policy',
    required: true,
  }]);
});

test('does not satisfy required memory-reasoning with a namespaced or fetched Skill alias', () => {
  for (const name of [
    'external-skills:memory-reasoning',
    'skills-sh/memory-reasoning',
    'other_memory_reasoning',
    'Memory-Reasoning',
    'ｍｅｍｏｒｙ－ｒｅａｓｏｎｉｎｇ',
  ]) {
    const result = resolveCapabilities({
      task: 'Implement repository tests for the beacon',
      profile: buildProfile,
      recommendedTags: [],
      capabilities: [{ kind: 'skill', name }],
      memoryUse: 'actionable',
    });
    const recommendation = result.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
    assert.equal(recommendation?.name, MEMORY_REASONING_SKILL_NAME);
    assert.equal(recommendation?.availability, 'missing');
  }
});

test('rejects capability names with surrounding whitespace instead of normalizing identity', () => {
  for (const name of [' memory-reasoning', 'memory-reasoning ', '\tmemory-reasoning']) {
    const normalized = normalizeCapabilityCatalog([{ kind: 'skill', name }]);
    assert.equal(normalized.availability, 'unknown');
    assert.deepEqual(normalized.skills, []);
    assert.equal(memoryReasoningCapabilityAvailability([{ kind: 'skill', name }]), 'unknown');
  }
});

test('does not accept a fetched memory-reasoning descriptor through an undocumented source field', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{ kind: 'skill', name: MEMORY_REASONING_SKILL_NAME, source: 'fetched' }],
    memoryUse: 'actionable',
  });
  const recommendation = result.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
  assert.equal(result.availability, 'unknown');
  assert.equal(recommendation?.name, MEMORY_REASONING_SKILL_NAME);
  assert.equal(recommendation?.availability, 'unknown');
});

test('does not accept memory-reasoning from a partially malformed catalog', () => {
  for (const malformed of [
    { kind: 'skill', name: 'malformed', source: 'fetched' },
    { kind: 'skill', name: 'malformed', description: { text: 'not a string' } },
  ]) {
    const capabilities = [
      { kind: 'skill', name: MEMORY_REASONING_SKILL_NAME },
      malformed,
    ];
    assert.equal(memoryReasoningCapabilityAvailability(capabilities), 'unknown');
    const result = resolveCapabilities({
      task: 'Implement repository tests for the beacon',
      profile: buildProfile,
      recommendedTags: [],
      capabilities,
      memoryUse: 'actionable',
    });
    const recommendation = result.recommendations.find((item) => item.name === MEMORY_REASONING_SKILL_NAME);
    assert.equal(result.availability, 'unknown');
    assert.equal(recommendation?.availability, 'unknown');
  }
});
