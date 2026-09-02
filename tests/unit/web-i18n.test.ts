import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WEB_LOCALE,
  WEB_LOCALE_LABELS,
  WEB_LOCALES,
  WEB_MESSAGES,
  normalizeWebLocale,
  resolveWebLocale,
} from '../../src/web/i18n.js';
import { WEB_HTML } from '../../src/web/ui.js';

test('Web UI exposes the four documented locales with English as the fallback', () => {
  assert.deepEqual(WEB_LOCALES, ['en', 'ja', 'zh-CN', 'ko']);
  assert.equal(DEFAULT_WEB_LOCALE, 'en');
  assert.deepEqual(WEB_LOCALE_LABELS, {
    en: 'English',
    ja: '日本語',
    'zh-CN': '简体中文',
    ko: '한국어',
  });
});

test('every Web UI locale has the complete non-empty message catalog and matching placeholders', () => {
  const englishKeys = Object.keys(WEB_MESSAGES.en).sort();
  assert.ok(englishKeys.length >= 50);

  const placeholders = (message: string) => [...message.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
  for (const locale of WEB_LOCALES) {
    assert.deepEqual(Object.keys(WEB_MESSAGES[locale]).sort(), englishKeys, `${locale} message keys`);
    for (const key of englishKeys) {
      const message = WEB_MESSAGES[locale][key as keyof typeof WEB_MESSAGES.en];
      assert.equal(message.trim(), message, `${locale}.${key} surrounding whitespace`);
      assert.notEqual(message, '', `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(message), placeholders(WEB_MESSAGES.en[key as keyof typeof WEB_MESSAGES.en]), `${locale}.${key} placeholders`);
    }
  }
});

test('visible role filters avoid bot terminology in every locale', () => {
  const visibleKeys = ['subtitle', 'filtersPanelTitle', 'filtersNavLabel', 'botFilterTitle'] as const;
  const botTerminology = /\bbot\b|机器人|봇/iu;
  for (const locale of WEB_LOCALES) {
    for (const key of visibleKeys) assert.doesNotMatch(WEB_MESSAGES[locale][key], botTerminology, `${locale}.${key}`);
  }
});

test('Web locale normalization accepts supported regional variants without mislabeling Traditional Chinese', () => {
  assert.equal(normalizeWebLocale('en-GB'), 'en');
  assert.equal(normalizeWebLocale('ja-JP'), 'ja');
  assert.equal(normalizeWebLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(normalizeWebLocale('ko-KR'), 'ko');
  assert.equal(normalizeWebLocale('zh-TW'), null);
  assert.equal(normalizeWebLocale('fr-FR'), null);
  assert.equal(normalizeWebLocale(null), null);
});

test('Web locale resolution uses the first supported candidate and falls back deterministically', () => {
  assert.equal(resolveWebLocale(['fr-FR', 'ko-KR', 'en-US']), 'ko');
  assert.equal(resolveWebLocale(['zh-TW', 'ja-JP']), 'ja');
  assert.equal(resolveWebLocale(['fr-FR']), DEFAULT_WEB_LOCALE);
  assert.equal(resolveWebLocale([]), DEFAULT_WEB_LOCALE);
});

test('generated Web UI exposes locale detection, persistence, selection, and translated accessibility hooks', () => {
  assert.match(WEB_HTML, /<html lang="en">/);
  assert.match(WEB_HTML, /<button id="language-toggle"[^>]+aria-haspopup="menu"[^>]+data-i18n-aria-label="languageLabel"/);
  assert.match(WEB_HTML, /<div id="language-menu"[^>]+role="menu"[^>]+hidden/);
  assert.doesNotMatch(WEB_HTML, /<select id="locale"/);
  assert.match(WEB_HTML, /navigator\.languages/);
  assert.match(WEB_HTML, /localStorage\.getItem\(localeStorageKey\)/);
  assert.match(WEB_HTML, /localStorage\.setItem\(localeStorageKey, state\.locale\)/);
  assert.match(WEB_HTML, /error instanceof DOMException/);
  assert.match(WEB_HTML, /if \(!isStorageAccessError\(error\)\) throw error/);
  assert.match(WEB_HTML, /document\.documentElement\.lang = state\.locale/);
  assert.match(WEB_HTML, /data-i18n-placeholder="searchPlaceholder"/);
  assert.match(WEB_HTML, /<button id="curator-button"[^>]+data-i18n="curator"/);
  assert.match(WEB_HTML, /<div id="curator-modal" class="curator-modal" hidden>/);
  assert.match(WEB_HTML, /<section id="curator-panel"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(WEB_HTML, /<div id="curator-actions" class="curator-actions"><\/div>/);
  assert.match(WEB_HTML, /<span id="curator-result-count" class="curator-selection-count">/);
  assert.match(WEB_HTML, /<button id="curator-close"[^>]+data-i18n-aria-label="curatorClose"/);
  assert.match(WEB_HTML, /<div id="curator-confirm-modal" class="curator-confirm-modal" hidden>/);
  assert.match(WEB_HTML, /<section id="curator-confirm-panel"[^>]+role="alertdialog"[^>]+aria-modal="true"/);
  assert.match(WEB_HTML, /id="curator-confirm-source"/);
  assert.match(WEB_HTML, /id="curator-confirm-applicability"/);
  assert.match(WEB_HTML, /id="curator-confirm-draft"/);
  assert.match(WEB_HTML, /prefers-reduced-motion/);
  assert.match(WEB_HTML, /curator-actions \.button/);
  assert.match(WEB_HTML, /curator-dialog/);
  assert.match(WEB_HTML, /openCuratorConfirmation/);
  assert.match(WEB_HTML, /globalizePendingCurator/);
  assert.match(WEB_HTML, /curatorGlobalizeBusy/);
  assert.match(WEB_HTML, /curatorGlobalizing/);
  assert.match(WEB_HTML, /curatorGlobalizeFailed/);
  assert.match(WEB_HTML, /curatorReview/);
  assert.match(WEB_HTML, /curatorGlobalizeCandidate/);
  assert.doesNotMatch(WEB_HTML, /window\.confirm/);
  assert.doesNotMatch(WEB_HTML, /curatorSelected/);
  assert.doesNotMatch(WEB_HTML, /curatorSelectAll/);
  assert.match(WEB_HTML, /\/api\/curator\/candidates\?limit=50/);
  assert.match(WEB_HTML, /candidate\.draft\.body/);
  assert.match(WEB_HTML, /curatorDraftChanges/);
  assert.match(WEB_HTML, /candidate\.knowledge\.qualifiedHits/);
  assert.match(WEB_HTML, /candidate\.tags/);
  assert.match(WEB_HTML, /function showEntryConflictGuide\(entryId, draftText\)/);
  assert.match(WEB_HTML, /className = 'status conflict-guide'/);
  assert.match(WEB_HTML, /async function copyTextToClipboard\(text\)/);
  assert.match(WEB_HTML, /entryConflictApplyHint/);
  assert.match(WEB_HTML, /entryConflictApplying/);
  assert.match(WEB_HTML, /await copyTextToClipboard\(draftText\(\)\);[\s\S]{0,500}await loadEntrySelection\(entryId\)/);
  assert.match(WEB_HTML, /entryConflictApplyCopyFailed'\);\s+return;/);
  assert.match(WEB_HTML, /entryConflictReloading/);
  assert.match(WEB_HTML, /await loadEntrySelection\(entryId\)/);
  assert.match(WEB_HTML, /error\.code === 'CONFLICT'/);
  assert.match(WEB_HTML, /save\.disabled = true; setI18nText\(save, 'saving'\)/);
  assert.match(WEB_HTML, /history\.pushState/);
  assert.match(WEB_HTML, /window\.addEventListener\('popstate'/);
  assert.match(WEB_HTML, /\/api\/memory\/recall\?/);
  assert.match(WEB_HTML, /originEcosystem/);
  assert.match(WEB_HTML, /curatorLoadMore/);
  assert.match(WEB_HTML, /\/api\/curator\/globalize/);
  for (const label of Object.values(WEB_LOCALE_LABELS)) assert.match(WEB_HTML, new RegExp(label));
});

test('every Web UI locale explains safe recovery from a stale editor revision', () => {
  const required = [
    'entryConflictTitle',
    'entryConflictExplanation',
    'entryConflictStepCopy',
    'entryConflictStepReload',
    'entryConflictStepCompare',
    'entryConflictApplyHint',
    'entryConflictApply',
    'entryConflictApplying',
    'entryConflictApplied',
    'entryConflictApplyCopyFailed',
    'entryConflictApplyReloadFailed',
    'entryConflictCopy',
    'entryConflictCopyFailed',
    'entryConflictReload',
    'entryConflictReloaded',
  ] as const;
  for (const locale of WEB_LOCALES) {
    for (const key of required) assert.notEqual(WEB_MESSAGES[locale][key], '', `${locale}.${key}`);
  }
  assert.match(WEB_MESSAGES.ja.entryConflictExplanation, /編集内容はフォームに残っています/);
  assert.equal(WEB_MESSAGES.ja.entryConflictApply, '修正更新適用');
  assert.match(WEB_MESSAGES.ja.entryConflictApplyHint, /編集内容をコピーした後、最新リビジョン/);
  assert.match(WEB_MESSAGES.ja.entryConflictApplyCopyFailed, /フォームは置き換えていません/);
  assert.match(WEB_MESSAGES.ja.entryConflictReload, /フォームを置換/);
});

test('generated Web UI top-aligns the title and places the language picker at the upper right', () => {
  assert.match(WEB_HTML, /\.topbar \{[^}]*align-items:start/);
  assert.match(WEB_HTML, /\.language-picker \{[^}]*align-self:flex-end/);
  assert.match(WEB_HTML, /<div class="brand">[\s\S]*<div class="topbar-side">[\s\S]*<div id="language-picker" class="language-picker"/);
});
