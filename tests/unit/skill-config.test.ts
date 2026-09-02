import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { MAX_BEARER_TOKEN_CHARS, parseRetryAfterSeconds, readSkillDiscoveryConfig } from '../../src/skills/config.js';

test('defaults Akinator external Skill discovery to official mode', () => {
  assert.equal(readSkillDiscoveryConfig({}).mode, 'official');
});

test('preserves explicit off and community modes and fails closed on invalid values', () => {
  assert.equal(readSkillDiscoveryConfig({ KIOKUKO_SKILL_DISCOVERY: 'off' }).mode, 'off');
  assert.equal(readSkillDiscoveryConfig({ KIOKUKO_SKILL_DISCOVERY: 'official' }).mode, 'official');
  assert.equal(readSkillDiscoveryConfig({ KIOKUKO_SKILL_DISCOVERY: 'community' }).mode, 'community');
  for (const value of ['invalid', '', 'communty']) {
    assert.throws(
      () => readSkillDiscoveryConfig({ KIOKUKO_SKILL_DISCOVERY: value }),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && /must be off, official, or community/u.test(error.message),
    );
  }
  assert.throws(
    () => readSkillDiscoveryConfig({ KIOKUKO_SKILLS_API_URL: '   ' }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'VALIDATION_ERROR'
      && /must not be empty/u.test(error.message),
  );
  for (const apiUrl of [
    'not-a-url token=private-sentinel',
    ' https://skills.sh',
    'https://skills.sh ',
    'https://token@skills.sh',
    'ftp://skills.sh/',
    'https://skills.sh/private',
  ]) {
    assert.throws(
      () => readSkillDiscoveryConfig({ KIOKUKO_SKILLS_API_URL: apiUrl }),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && error.message === 'KIOKUKO_SKILLS_API_URL is invalid'
        && !error.message.includes(apiUrl),
    );
  }
  for (const name of ['KIOKUKO_SKILLS_V1_TOKEN', 'KIOKUKO_GITHUB_TOKEN'] as const) {
    assert.throws(
      () => readSkillDiscoveryConfig({ [name]: '' }),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && error.message === `${name} is invalid`,
    );
    for (const secret of [
      `private-token-${'x'.repeat(MAX_BEARER_TOKEN_CHARS)}`,
      ' leading-space',
      'trailing-space ',
      'colon:not-bearer-safe',
      'line\nbreak',
      'replacement\uFFFDcharacter',
      'lone\ud800surrogate',
    ]) {
      assert.throws(
        () => readSkillDiscoveryConfig({ [name]: secret }),
        (error: unknown) => error instanceof KiokukoError
          && error.code === 'VALIDATION_ERROR'
          && error.message === `${name} is invalid`
          && !error.message.includes(secret),
      );
    }
  }
});

test('binds an authenticated v1 token to an exact trusted skills.sh HTTPS origin', () => {
  const token = 'test-token-123456789';
  assert.equal(readSkillDiscoveryConfig({ KIOKUKO_SKILLS_V1_TOKEN: token }).v1Token, token);
  for (const apiUrl of ['http://127.0.0.1/', 'http://localhost/', 'https://www.skills.sh/', 'https://skills.sh:8443/', 'https://example.com/']) {
    assert.throws(
      () => readSkillDiscoveryConfig({ KIOKUKO_SKILLS_V1_TOKEN: token, KIOKUKO_SKILLS_API_URL: apiUrl }),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && error.message === 'KIOKUKO_SKILLS_API_URL is invalid for authenticated discovery'
        && !error.message.includes(token),
    );
  }
});

test('parses Retry-After without accepting permissive JavaScript numeric or date forms', () => {
  assert.equal(parseRetryAfterSeconds('120'), 120);
  assert.equal(parseRetryAfterSeconds('Sun, 06 Nov 1994 08:49:37 GMT', Date.parse('Sun, 06 Nov 1994 08:49:36 GMT')), 1);
  for (const value of ['0', '-1', '+30', '1e3', '0x10', '1.5', ' 30', '30 ', 'November 6, 1994', 'Mon, 06 Nov 1994 08:49:37 GMT']) {
    assert.equal(parseRetryAfterSeconds(value), null);
  }
});
