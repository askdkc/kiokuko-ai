import { DEFAULT_WEB_LOCALE, WEB_LOCALE_LABELS, WEB_LOCALES, WEB_MESSAGES } from './i18n.js';

const WEB_I18N_CONFIG = JSON.stringify({
  defaultLocale: DEFAULT_WEB_LOCALE,
  localeLabels: WEB_LOCALE_LABELS,
  locales: WEB_LOCALES,
  messages: WEB_MESSAGES,
})
  .replaceAll('&', '\\u0026')
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');

/** Strict client-boundary decoder for the bounded external-skill list shape. */
export function externalSkillListItemIsValid(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  const fields = new Set([
    'skillId', 'provider', 'sourceType', 'sourceLocator', 'slug', 'name', 'installUrl',
    'officialStatus', 'duplicate', 'installs', 'state', 'sourceWorkspace', 'sourceCommit',
    'snapshotHash', 'metadata', 'auditStatus', 'generation', 'firstSeenAt', 'lastSeenAt',
    'lastCheckedAt', 'disabledAt',
  ]);
  const text = (item: unknown, maximum: number): item is string => typeof item === 'string'
    && item.length >= 1 && item.length <= maximum && item === item.trim() && !/[\u0000-\u001f\u007f]/u.test(item);
  const timestamp = (item: unknown): item is string => {
    if (typeof item !== 'string') return false;
    const parsed = Date.parse(item);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === item;
  };
  const metadata = skill.metadata;
  const sourceLocator = skill.sourceLocator;
  const slug = skill.slug;
  const sourceCommit = skill.sourceCommit;
  const snapshotHash = skill.snapshotHash;
  const disabledAt = skill.disabledAt;
  const officialStatus = skill.officialStatus;
  const state = skill.state;
  const auditStatus = skill.auditStatus;
  if (Object.keys(skill).length !== fields.size || Object.keys(skill).some((field) => !fields.has(field))
    || !text(skill.skillId, 500) || !text(skill.provider, 50) || !/^[A-Za-z0-9_.-]+$/u.test(skill.provider)
    || skill.sourceType !== 'github'
    || typeof sourceLocator !== 'string' || !/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/u.test(sourceLocator)
    || typeof slug !== 'string' || !/^[A-Za-z0-9_.\-/]{1,240}$/u.test(slug)
    || slug.split('/').some((part) => part === '' || part === '.' || part === '..')
    || skill.skillId !== `github:${sourceLocator}:${slug}`
    || !text(skill.name, 500)
    || skill.installUrl !== null && skill.installUrl !== `https://github.com/${sourceLocator}`
    || typeof officialStatus !== 'string'
    || !['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown'].includes(officialStatus)
    || typeof skill.duplicate !== 'boolean'
    || typeof skill.installs !== 'number' || !Number.isSafeInteger(skill.installs) || skill.installs < 0
    || typeof state !== 'string'
    || !['discovered', 'imported', 'blocked', 'stale', 'disabled'].includes(state)
    || !text(skill.sourceWorkspace, 240)
    || sourceCommit !== null && (typeof sourceCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit))
    || snapshotHash !== null && (typeof snapshotHash !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshotHash))
    || (sourceCommit === null) !== (snapshotHash === null)
    || typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
    || Object.keys(metadata).length !== 2 || !Object.hasOwn(metadata, 'documents') || !Object.hasOwn(metadata, 'technology')
    || typeof (metadata as Record<string, unknown>).documents !== 'number'
    || !Number.isSafeInteger((metadata as Record<string, unknown>).documents)
    || ((metadata as Record<string, unknown>).documents as number) < 0
    || ((metadata as Record<string, unknown>).documents as number) > 64
    || (metadata as Record<string, unknown>).technology !== null && !text((metadata as Record<string, unknown>).technology, 500)
    || typeof auditStatus !== 'string'
    || !['not-required', 'passed', 'failed', 'unavailable'].includes(auditStatus)
    || typeof skill.generation !== 'number' || !Number.isSafeInteger(skill.generation) || skill.generation < 1
    || !timestamp(skill.firstSeenAt) || !timestamp(skill.lastSeenAt) || !timestamp(skill.lastCheckedAt)
    || disabledAt !== null && !timestamp(disabledAt)
    || (skill.firstSeenAt as string) > (skill.lastSeenAt as string)
    || (skill.firstSeenAt as string) > (skill.lastCheckedAt as string)
    || disabledAt !== null && disabledAt < (skill.firstSeenAt as string)
    || sourceCommit === null && (['imported', 'disabled'].includes(state) || disabledAt !== null)
    || sourceCommit !== null && !['imported', 'disabled', 'stale', 'blocked'].includes(state)
    || state === 'imported' && disabledAt !== null
    || state === 'disabled' && disabledAt === null
    || sourceCommit === null && ((metadata as Record<string, unknown>).documents !== 0 || (metadata as Record<string, unknown>).technology !== null)
    || sourceCommit !== null && ((metadata as Record<string, unknown>).documents === 0 || !text((metadata as Record<string, unknown>).technology, 500))) return false;
  return true;
}

/** Strict client-boundary decoder for one external-skill mapping summary. */
export function externalSkillEntrySummaryIsValid(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const fields = new Set(['entryId', 'revision', 'sourcePath', 'chunkIndex', 'primary', 'active']);
  return Object.keys(entry).length === fields.size
    && Object.keys(entry).every((field) => fields.has(field))
    && typeof entry.entryId === 'string' && entry.entryId.length >= 1 && entry.entryId.length <= 500 && entry.entryId === entry.entryId.trim()
    && typeof entry.revision === 'number' && Number.isSafeInteger(entry.revision) && entry.revision >= 1
    && typeof entry.sourcePath === 'string' && entry.sourcePath.length >= 1 && entry.sourcePath.length <= 2_000
    && /^[A-Za-z0-9_.\-/]+$/u.test(entry.sourcePath) && !entry.sourcePath.startsWith('/')
    && !entry.sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    && typeof entry.chunkIndex === 'number' && Number.isSafeInteger(entry.chunkIndex) && entry.chunkIndex >= 0
    && typeof entry.primary === 'boolean' && typeof entry.active === 'boolean';
}

export const WEB_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kiokuko Web</title>
  <style>
    :root { color-scheme: light; --ink:#1e293b; --muted:#64748b; --line:#e2e8f0; --panel:#ffffff; --surface:#f8fafc; --accent:#2563eb; --accent-soft:#eff6ff; --warn:#b45309; --danger:#b91c1c; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; background:linear-gradient(135deg,#f8fafc,#eef2ff); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    button { cursor:pointer; }
    .shell { max-width:1440px; margin:0 auto; padding:28px; }
    .topbar { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(420px,.9fr); gap:24px; align-items:start; margin-bottom:22px; }
    .brand,.topbar-side { min-width:0; }
    .topbar-side { display:flex; flex-direction:column; gap:10px; align-self:stretch; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:clamp(28px,4vw,44px); letter-spacing:-.04em; }
    .subtitle { margin:8px 0 0; color:var(--muted); }
    .language-picker { position:relative; align-self:flex-end; z-index:10; }
    .language-toggle { display:grid; place-items:center; width:44px; height:44px; border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); box-shadow:0 6px 18px rgba(15,23,42,.06); }
    .language-toggle:hover,.language-toggle[aria-expanded="true"] { border-color:#93c5fd; background:var(--accent-soft); color:var(--accent); }
    .language-toggle:focus-visible,.language-option:focus-visible { outline:3px solid rgba(37,99,235,.25); outline-offset:2px; }
    .language-toggle svg { width:22px; height:22px; }
    .language-menu { position:absolute; top:calc(100% + 8px); right:0; display:grid; gap:2px; width:max-content; min-width:168px; padding:6px; border:1px solid var(--line); border-radius:14px; background:var(--panel); box-shadow:0 18px 48px rgba(15,23,42,.16); }
    .language-option { display:flex; align-items:center; justify-content:space-between; gap:18px; width:100%; border:0; border-radius:9px; padding:9px 11px; background:transparent; color:var(--ink); text-align:left; }
    .language-option:hover,.language-option:focus-visible,.language-option[aria-checked="true"] { background:var(--accent-soft); color:var(--accent); }
    .language-option[aria-checked="true"]::after { content:"✓"; font-weight:800; }
    .toolbar { display:flex; gap:10px; align-items:center; justify-content:flex-end; flex-wrap:wrap; margin-top:auto; }
    .topbar-side .control { flex:1 1 210px; width:auto; min-width:0; }
    .topbar-side .search { flex:1.4 1 240px; width:auto; min-width:0; }
    .control, .search { border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); padding:10px 12px; }
    .search { min-width:260px; }
    .button { border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); padding:10px 14px; font-weight:700; }
    .button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    .button:disabled { cursor:not-allowed; opacity:.45; }
    .button:focus-visible,.curator-close:focus-visible { outline:3px solid rgba(37,99,235,.25); outline-offset:2px; }
    .layout { display:grid; grid-template-columns:220px minmax(300px,1fr) minmax(360px,1.15fr); gap:16px; align-items:start; }
    .panel { background:rgba(255,255,255,.88); border:1px solid rgba(226,232,240,.9); border-radius:20px; box-shadow:0 14px 44px rgba(15,23,42,.08); overflow:hidden; }
    .panel-head { padding:18px 20px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .panel-head h2 { margin:0; font-size:16px; }
    .panel-body { padding:16px; }
    .genres { padding:10px; }
    .filter-group + .filter-group { border-top:1px solid var(--line); margin-top:8px; padding-top:8px; }
    .filter-group-title { color:var(--muted); font-size:11px; font-weight:800; letter-spacing:.08em; padding:8px 12px 4px; text-transform:uppercase; }
    .genre { display:flex; justify-content:space-between; align-items:center; width:100%; border:0; background:transparent; color:var(--muted); border-radius:12px; padding:11px 12px; text-align:left; }
    .genre:hover,.genre.active { background:var(--accent-soft); color:var(--accent); }
    .count { min-width:26px; padding:2px 7px; border-radius:999px; background:#e2e8f0; color:var(--muted); font-size:12px; text-align:center; }
    .genre.active .count { background:#dbeafe; color:var(--accent); }
    .entry-list { display:flex; flex-direction:column; gap:10px; max-height:calc(100vh - 220px); overflow:auto; }
    .entry-card { border:1px solid var(--line); border-radius:14px; padding:14px; background:var(--panel); transition:.16s ease; }
    .entry-card:hover,.entry-card.selected { border-color:#93c5fd; box-shadow:0 8px 20px rgba(37,99,235,.10); }
    .entry-meta { display:flex; gap:7px; align-items:center; flex-wrap:wrap; color:var(--muted); font-size:12px; }
    .badge { border-radius:999px; padding:3px 8px; background:#f1f5f9; color:#475569; font-weight:700; }
    .badge.origin-project { background:#dbeafe; color:#1d4ed8; }
    .badge.origin-ecosystem { background:#dcfce7; color:#166534; }
    .badge.origin-global { background:#fef3c7; color:#92400e; }
    .badge.verified { background:#dcfce7; color:#166534; }
    .badge.candidate { background:#fef3c7; color:#92400e; }
    .badge.superseded { background:#fee2e2; color:#991b1b; }
    .entry-card h3 { margin:9px 0 6px; font-size:16px; }
    .snippet { margin:0; color:var(--muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }
    .federated-card { border-left:4px solid #22c55e; }
    .federated-card.global { border-left-color:#f59e0b; }
    .federated-source,.selection-reasons { margin-top:8px; color:var(--muted); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .federated-detail { display:grid; gap:12px; }
    .tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
    .tag { border:0; background:transparent; color:var(--accent); font-size:12px; padding:0; }
    .tag:hover { text-decoration:underline; }
    .form { display:grid; gap:12px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.04em; }
    textarea,input,select { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px 11px; background:#fff; color:var(--ink); }
    textarea { min-height:120px; resize:vertical; line-height:1.55; }
    textarea.body { min-height:260px; }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .editor-empty { color:var(--muted); padding:30px 10px; text-align:center; }
    .notice { border-radius:12px; padding:11px 12px; background:#fffbeb; color:var(--warn); font-size:13px; }
    .notice.error { background:#fef2f2; color:var(--danger); }
    .status { color:var(--muted); font-size:12px; min-height:18px; }
    .conflict-guide { display:grid; gap:10px; padding:16px; border:1px solid #fecaca; border-radius:14px; background:#fef2f2; color:#7f1d1d; font-size:14px; }
    .conflict-guide h2,.conflict-guide p,.conflict-guide ol { margin:0; }
    .conflict-guide h2 { font-size:16px; }
    .conflict-guide ol { display:grid; gap:6px; padding-left:22px; line-height:1.5; }
    .conflict-guide-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .conflict-guide-feedback { min-height:18px; font-size:13px; font-weight:700; }
    .conflict-guide-feedback.error { color:var(--danger); }
    .operator-panel { grid-column:1 / -1; margin-top:16px; }
    .operator-grid { display:grid; grid-template-columns:minmax(240px,.7fr) minmax(420px,1.3fr); gap:16px; }
    .run-list { display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; }
    .run-card { border:1px solid var(--line); border-radius:12px; padding:11px; background:var(--panel); text-align:left; }
    .run-card.selected { border-color:#93c5fd; background:var(--accent-soft); }
    .detail-block { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
    .detail-block h3 { margin:0 0 8px; font-size:14px; }
    .detail-text { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); font-size:13px; }
    .curator-modal { position:fixed; inset:0; z-index:100; display:grid; place-items:center; padding:24px; background:rgba(15,23,42,.42); backdrop-filter:blur(6px); animation:curator-backdrop-in .18s ease-out both; }
    .curator-modal.is-closing { animation:curator-backdrop-out .18s ease-in both; }
    .curator-dialog { width:min(880px,calc(100vw - 32px)); max-height:min(860px,calc(100vh - 48px)); display:flex; flex-direction:column; min-height:0; background:rgba(255,255,255,.96); box-shadow:0 28px 90px rgba(15,23,42,.28); animation:curator-dialog-in .22s cubic-bezier(.2,.8,.2,1) both; }
    .curator-modal.is-closing .curator-dialog { animation:curator-dialog-out .18s ease-in both; }
    .curator-dialog .panel-body { min-height:0; overflow-y:auto; }
    .curator-dialog-head { align-items:flex-start; }
    .curator-heading { display:flex; align-items:center; gap:10px; min-width:0; flex-wrap:wrap; }
    .curator-header-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; min-width:0; margin-left:auto; }
    .curator-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .curator-actions .button { padding:8px 10px; border-radius:10px; font-size:13px; white-space:nowrap; }
    .curator-selection-count { color:var(--muted); font-size:12px; font-weight:700; white-space:nowrap; }
    .curator-selection-summary { display:block; margin:0 0 10px; }
    .curator-close { display:grid; place-items:center; flex:0 0 auto; width:44px; height:44px; border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--muted); font-size:26px; line-height:1; }
    .curator-close:hover { border-color:#93c5fd; background:var(--accent-soft); color:var(--accent); }
    .curator-status { margin:0 0 12px; }
    .curator-filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:0 0 14px; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
    .curator-filter { display:grid; gap:4px; color:var(--muted); font-size:11px; font-weight:800; }
    .curator-filter-check { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; font-weight:700; }
    .curator-filter-check input { width:16px; height:16px; }
    .curator-filter-tags { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:7px; padding-top:4px; }
    .curator-filter-tags .tag.active { font-weight:800; text-decoration:underline; }
    .curator-list { display:grid; gap:12px; }
    .curator-card { border:1px solid var(--line); border-radius:14px; padding:16px; background:var(--panel); }
    .curator-workspace { overflow-wrap:anywhere; }
    .curator-card h3 { margin:8px 0; font-size:17px; }
    .curator-overview { margin:8px 0 12px; color:var(--muted); white-space:pre-wrap; line-height:1.55; }
    .curator-card-actions { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 0; }
    .curator-review-details { margin-top:12px; }
    .curator-draft { margin:12px 0; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
    .curator-draft h4 { margin:0 0 10px; font-size:14px; }
    .curator-draft-label { margin:10px 0 4px; color:var(--muted); font-size:12px; font-weight:700; }
    .curator-draft-value { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:13px; line-height:1.5; }
    .curator-reasons { color:var(--muted); font-size:12px; white-space:pre-wrap; }
    .curator-confirm-modal { position:absolute; inset:0; z-index:2; display:grid; place-items:center; padding:24px; background:rgba(15,23,42,.58); }
    .curator-confirm-dialog { width:min(680px,calc(100vw - 32px)); max-height:min(760px,calc(100vh - 48px)); display:flex; flex-direction:column; min-height:0; background:var(--panel); box-shadow:0 28px 90px rgba(15,23,42,.34); }
    .curator-confirm-dialog .panel-body { min-height:0; overflow-y:auto; }
    .curator-confirm-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:0 0 14px; }
    .curator-confirm-field { min-width:0; padding:11px 12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
    .curator-confirm-field dt { margin:0 0 5px; color:var(--muted); font-size:12px; font-weight:800; }
    .curator-confirm-field dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; }
    .curator-confirm-draft { max-height:280px; overflow:auto; margin:0; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:13px; line-height:1.5; }
    .curator-confirm-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
    .skill-dialog { width:min(1040px,calc(100vw - 32px)); max-height:min(860px,calc(100vh - 48px)); display:flex; flex-direction:column; min-height:0; background:rgba(255,255,255,.96); box-shadow:0 28px 90px rgba(15,23,42,.28); }
    .skill-dialog .panel-body { min-height:0; overflow-y:auto; }
    .skill-list { display:grid; gap:12px; }
    .skill-card { border:1px solid var(--line); border-radius:14px; padding:16px; background:var(--panel); }
    .skill-card h3 { margin:8px 0; font-size:17px; overflow-wrap:anywhere; }
    .skill-card-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-top:12px; }
    .skill-field { min-width:0; padding:10px 11px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
    .skill-field dt { margin:0 0 4px; color:var(--muted); font-size:11px; font-weight:800; }
    .skill-field dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; font-size:13px; }
    .skill-card-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .skill-source-link { color:var(--accent); overflow-wrap:anywhere; }
    @keyframes curator-backdrop-in { from { opacity:0; } to { opacity:1; } }
    @keyframes curator-backdrop-out { from { opacity:1; } to { opacity:0; } }
    @keyframes curator-dialog-in { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
    @keyframes curator-dialog-out { from { opacity:1; transform:translateY(0) scale(1); } to { opacity:0; transform:translateY(6px) scale(.985); } }
    @media (prefers-reduced-motion: reduce) {
      .curator-modal,.curator-modal .curator-dialog,.curator-modal.is-closing,.curator-modal.is-closing .curator-dialog { animation-duration:.01ms; }
    }
    @media (max-width:680px) { .operator-grid { grid-template-columns:1fr; } }
    @media (max-width:1050px) { .layout { grid-template-columns:180px minmax(280px,1fr); } .editor-panel { grid-column:1 / -1; } }
    @media (max-width:680px) { .shell { padding:16px; } .topbar { display:block; position:relative; } .brand { padding-right:56px; } .topbar-side { margin-top:16px; align-self:auto; } .language-picker { position:absolute; top:0; right:0; } .toolbar { justify-content:stretch; margin-top:0; } .topbar-side .control,.topbar-side .search { flex:1 1 100%; width:100%; } .search { min-width:0; } .layout { grid-template-columns:1fr; } .genres-panel { order:0; } .list-panel { order:1; } .editor-panel { order:2; } .entry-list { max-height:none; } .curator-dialog-head { flex-wrap:wrap; } .curator-header-actions { flex:1 1 100%; width:100%; margin-left:0; } .curator-actions { justify-content:flex-end; } .curator-confirm-grid { grid-template-columns:1fr; } .curator-confirm-actions { flex-direction:column-reverse; } .curator-confirm-actions .button { width:100%; } }
  </style>
</head>
<body>
  <main id="app-main" class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="eyebrow" data-i18n="eyebrow">Local memory console</div>
        <h1>Kiokuko Web</h1>
        <p class="subtitle" data-i18n="subtitle">Browse SQLite memory by role and purpose, memory type, and cross-cutting tags, and safely edit candidate entries.</p>
      </div>
      <div class="topbar-side">
        <div id="language-picker" class="language-picker">
          <button id="language-toggle" class="language-toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="language-menu" aria-label="Language" data-i18n-aria-label="languageLabel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path></svg>
          </button>
          <div id="language-menu" class="language-menu" role="menu" aria-label="Language" data-i18n-aria-label="languageLabel" hidden></div>
        </div>
        <div class="toolbar">
          <select id="workspace" class="control" aria-label="Workspace" data-i18n-aria-label="workspaceLabel"></select>
          <input id="search" class="search" type="search" placeholder="Search memory…" aria-label="Search memory…" data-i18n-placeholder="searchPlaceholder" data-i18n-aria-label="searchPlaceholder">
          <button id="curator-button" class="button" type="button" data-i18n="curator">Curator</button>
          <button id="external-skills-button" class="button" type="button" data-i18n="openExternalSkills">External Skills</button>
          <button id="refresh" class="button" type="button" data-i18n="refresh">Refresh</button>
        </div>
      </div>
    </header>
    <div id="status" class="status" role="status"></div>
    <section class="layout">
      <aside class="panel genres-panel">
        <div class="panel-head"><h2 data-i18n="filtersPanelTitle">Role and purpose / tags</h2></div>
        <nav id="genres" class="genres" aria-label="Filter by role and purpose, memory type, or tag" data-i18n-aria-label="filtersNavLabel"></nav>
      </aside>
      <section class="panel list-panel">
        <div class="panel-head"><h2 id="list-title">Memory</h2><span id="result-count" class="badge">0 items</span></div>
        <div class="panel-body"><div id="entry-list" class="entry-list"></div></div>
      </section>
      <section class="panel editor-panel">
        <div class="panel-head"><h2 data-i18n="editorTitle">Details</h2><span id="editor-state" class="badge" data-i18n="unselected">Not selected</span></div>
        <div class="panel-body"><div id="editor"></div></div>
      </section>
    </section>
    <section class="panel operator-panel">
      <div class="panel-head"><h2 data-i18n="operatorTitle">Agent run operator view</h2><span class="badge" data-i18n="trustBadge">stored data is untrusted / non-actionable</span></div>
      <div class="panel-body operator-grid">
        <div><div id="run-list" class="run-list"></div><div id="run-page" class="status"></div></div>
        <div id="run-detail"><div class="editor-empty" data-i18n="runSelectFull">Select a run to view its intake, profile, timeline, delivery, feedback, and coverage.</div></div>
      </div>
    </section>
  </main>
  <div id="curator-modal" class="curator-modal" hidden>
    <section id="curator-panel" class="panel curator-dialog" role="dialog" aria-modal="true" aria-labelledby="curator-title" aria-describedby="curator-description">
      <div class="panel-head curator-dialog-head">
        <div class="curator-heading"><h2 id="curator-title" data-i18n="curatorTitle">Curator</h2><span class="badge" data-i18n="curatorBadge">user confirmation required</span></div>
        <div class="curator-header-actions">
          <div id="curator-actions" class="curator-actions"></div>
          <button id="curator-close" class="curator-close" type="button" aria-label="Close Curator" data-i18n-aria-label="curatorClose"><span aria-hidden="true">×</span></button>
        </div>
      </div>
      <div class="panel-body">
        <p id="curator-description" class="subtitle" data-i18n="curatorDescription">Review reusable knowledge candidates and add them to global memory.</p>
        <div id="curator-filters" class="curator-filters" aria-label="Curator filters"></div>
        <div class="curator-selection-summary"><span id="curator-result-count" class="curator-selection-count">0 candidates</span></div>
        <div id="curator-status" class="status" role="status" aria-live="polite"></div>
        <div id="curator-list" class="curator-list"></div>
      </div>
    </section>
    <div id="curator-confirm-modal" class="curator-confirm-modal" hidden>
      <section id="curator-confirm-panel" class="panel curator-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="curator-confirm-title" aria-describedby="curator-confirm-description">
        <div class="panel-head">
          <h2 id="curator-confirm-title" data-i18n="curatorConfirmTitle">Confirm Global memory addition</h2>
        </div>
        <div class="panel-body">
          <p id="curator-confirm-description" class="subtitle" data-i18n="curatorConfirmDescription">Verify the source, applicability, and complete regenerated draft.</p>
          <dl class="curator-confirm-grid">
            <div class="curator-confirm-field"><dt data-i18n="curatorConfirmSource">Source project</dt><dd id="curator-confirm-source"></dd></div>
            <div class="curator-confirm-field"><dt data-i18n="curatorConfirmSkill">Skill</dt><dd id="curator-confirm-skill"></dd></div>
            <div class="curator-confirm-field"><dt data-i18n="curatorConfirmApplicability">Applicability</dt><dd id="curator-confirm-applicability"></dd></div>
          </dl>
          <h3 data-i18n="curatorConfirmDraft">Draft to add</h3>
          <pre id="curator-confirm-draft" class="curator-confirm-draft"></pre>
          <div id="curator-confirm-status" class="status curator-status" role="status" aria-live="polite"></div>
          <div class="curator-confirm-actions">
            <button id="curator-confirm-cancel" class="button" type="button" data-i18n="curatorCancel">Cancel</button>
            <button id="curator-confirm-submit" class="button primary" type="button" data-i18n="curatorConfirmAction">Add this draft to Global</button>
          </div>
        </div>
      </section>
    </div>
  </div>
  <div id="external-skills-modal" class="curator-modal" hidden>
    <section id="external-skills-panel" class="panel skill-dialog" role="dialog" aria-modal="true" aria-labelledby="external-skills-title" aria-describedby="external-skills-description">
      <div class="panel-head curator-dialog-head">
        <div class="curator-heading"><h2 id="external-skills-title" data-i18n="externalSkills">External Skills</h2><span class="badge" data-i18n="trustBadge">stored data is untrusted / non-actionable</span></div>
        <div class="curator-header-actions"><button id="external-skills-refresh" class="button" type="button" data-i18n="externalSkillsRefresh">Refresh</button><button id="external-skills-close" class="curator-close" type="button" aria-label="Close External Skills" data-i18n-aria-label="externalSkillsClose"><span aria-hidden="true">×</span></button></div>
      </div>
      <div class="panel-body">
        <p id="external-skills-description" class="subtitle" data-i18n="externalSkillsDescription">Review fetched skills as untrusted reference data. Nothing here installs software or runs scripts.</p>
        <div id="external-skills-status" class="status" role="status" aria-live="polite"></div>
        <div id="external-skills-list" class="skill-list"></div>
      </div>
    </section>
  </div>
  <script>
    const i18n = ${WEB_I18N_CONFIG};
    const validExternalSkillListItem = (${externalSkillListItemIsValid.toString()});
    const validExternalSkillEntrySummary = (${externalSkillEntrySummaryIsValid.toString()});
    const localeStorageKey = 'kiokuko.web.locale';
    const normalizeLocale = (value) => {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().replaceAll('_', '-').toLowerCase();
      if (!normalized) return null;
      const parts = normalized.split('-');
      const language = parts[0];
      if (language === 'en' || language === 'ja' || language === 'ko') return language;
      if (language === 'zh' && (parts.length === 1 || parts.includes('hans') || parts.includes('cn') || parts.includes('sg'))) return 'zh-CN';
      return null;
    };
    const isStorageAccessError = (error) => typeof DOMException !== 'undefined' && error instanceof DOMException;
    const readStoredLocale = () => {
      try { return localStorage.getItem(localeStorageKey); }
      catch (error) {
        if (!isStorageAccessError(error)) throw error;
        return null;
      }
    };
    const browserLocales = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    const localeCandidates = [new URLSearchParams(location.search).get('lang'), readStoredLocale(), ...browserLocales];
    const initialLocale = localeCandidates.map(normalizeLocale).find(Boolean) || i18n.defaultLocale;
    const kinds = [
      ['all', 'kind.all'], ['fact', 'kind.fact'], ['decision', 'kind.decision'], ['lesson', 'kind.lesson'], ['preference', 'kind.preference'], ['reference', 'kind.reference']
    ];
    const botModes = [
      ['bot:common', 'bot.common'], ['bot:researcher', 'bot.researcher'], ['bot:builder', 'bot.builder'], ['bot:reviewer', 'bot.reviewer'], ['bot:devops', 'bot.devops'], ['bot:writer', 'bot.writer'], ['bot:analyst', 'bot.analyst']
    ];
    const curatorUrl = new URLSearchParams(location.search);
    const state = { locale: initialLocale, workspace: '', kind: 'all', tag: '', query: '', entries: [], recallItems: [], tags: [], selected: null, selectedRecall: null, runs: [], selectedRun: null, curatorCandidates: [], curatorGlobalized: new Set(), curatorNextCursor: null, curatorTotalApproximate: 0, curatorOpen: false, curatorPreviousFocus: null, curatorPendingCandidate: null, curatorConfirmationTrigger: null, curatorGlobalizeBusy: false, externalSkills: [], externalSkillsOpen: false, externalSkillsPreviousFocus: null, externalSkillsBusy: false, externalSkillsPendingDisable: null, localizedStatus: null, curatorSearch: curatorUrl.get('search') || '', curatorProject: curatorUrl.get('project') || '', curatorTags: new Set(curatorUrl.getAll('tag')), curatorFramework: curatorUrl.get('framework') || '', curatorLanguage: curatorUrl.get('language') || '', curatorMemoryClass: curatorUrl.get('memoryClass') || '', curatorTier: curatorUrl.get('tier') || '', curatorReady: curatorUrl.get('ready') === 'true', curatorIncludeGlobalized: curatorUrl.get('includeGlobalized') === 'true', curatorFacets: null };
    const $ = (id) => document.getElementById(id);
    const t = (key, parameters = {}) => {
      const template = i18n.messages[state.locale]?.[key] ?? i18n.messages[i18n.defaultLocale]?.[key] ?? key;
      return template.replace(/\{([^}]+)\}/g, (_match, name) => Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : '');
    };
    const tp = (key, count) => {
      const category = new Intl.PluralRules(state.locale).select(count) === 'one' ? 'one' : 'other';
      return t(key + '.' + category, { count });
    };
    const setI18nText = (element, key) => { element.dataset.i18n = key; element.textContent = t(key); return element; };
    const labelForKind = (kind) => { const item = kinds.find(([value]) => value === kind); return item ? t(item[1]) : kind; };
    const labelForStatus = (status) => i18n.messages[state.locale]?.['status.' + status] ?? status;
    const labelForOrigin = (origin) => t(origin === 'ecosystem' ? 'originEcosystem' : origin === 'global' ? 'originGlobal' : 'originProject');
    const updateEditorState = () => {
      const element = $('editor-state');
      if (state.selected) { delete element.dataset.i18n; element.dataset.i18nStatus = state.selected.status; element.textContent = labelForStatus(state.selected.status); }
      else { delete element.dataset.i18nStatus; setI18nText(element, 'unselected'); }
    };
    const showStatus = (message, error = false) => { const element = $('status'); element.textContent = message; element.className = error ? 'status notice error' : 'status'; element.setAttribute('role', error ? 'alert' : 'status'); element.setAttribute('aria-live', error ? 'assertive' : 'polite'); };
    const setStatus = (message, error = false) => { state.localizedStatus = null; showStatus(message, error); };
    const setLocalizedStatus = (key, parameters = {}, error = false) => { state.localizedStatus = { key, parameters, error }; showStatus(t(key, parameters), error); };
    const setLocalizedCountStatus = (key, count, error = false) => { state.localizedStatus = { key, count, error, plural: true }; showStatus(tp(key, count), error); };
    const renderLanguageMenu = () => {
      const menu = $('language-menu');
      menu.replaceChildren(...i18n.locales.map((locale) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'language-option';
        option.lang = locale;
        option.dataset.locale = locale;
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String(locale === state.locale));
        option.textContent = i18n.localeLabels[locale];
        option.addEventListener('click', () => selectLocale(locale));
        return option;
      }));
    };
    const setLanguageMenuOpen = (open, restoreFocus = false) => {
      const menu = $('language-menu');
      const toggle = $('language-toggle');
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) requestAnimationFrame(() => menu.querySelector('[aria-checked="true"]')?.focus());
      else if (restoreFocus) toggle.focus();
    };
    const selectLocale = (value) => {
      state.locale = normalizeLocale(value) || i18n.defaultLocale;
      try { localStorage.setItem(localeStorageKey, state.locale); }
      catch (error) { if (!isStorageAccessError(error)) throw error; }
      setLanguageMenuOpen(false, true);
      applyTranslations(); renderFilters(); renderEntries(); renderRuns(); renderRunDetail(); renderCurator(); renderExternalSkills(); updateEditorState();
    };
    const applyTranslations = () => {
      document.documentElement.lang = state.locale;
      document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
      document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel)); });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder)); });
      document.querySelectorAll('[data-i18n-status]').forEach((element) => {
        const value = labelForStatus(element.dataset.i18nStatus);
        if ('value' in element) element.value = value; else element.textContent = value;
      });
      renderLanguageMenu();
      if (state.localizedStatus) showStatus(state.localizedStatus.plural ? tp(state.localizedStatus.key, state.localizedStatus.count) : t(state.localizedStatus.key, state.localizedStatus.parameters), state.localizedStatus.error);
    };
    const apiError = (value) => {
      const rawCode = value?.error?.code;
      const rawMessage = value?.error?.message;
      const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'REQUEST_FAILED';
      const normalizedMessage = typeof rawMessage === 'string' ? rawMessage.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '';
      const error = new Error(normalizedMessage || t('requestFailed'));
      error.code = code;
      return error;
    };
    const apiErrorText = (error) => {
      const code = error instanceof Error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'REQUEST_FAILED';
      const normalizedMessage = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '';
      return '[' + code + '] ' + (normalizedMessage || t('requestFailed'));
    };
    const api = async (path, options) => {
      const response = await fetch(path, options);
      const value = await response.json();
      if (!response.ok) throw apiError(value);
      return value;
    };
    async function loadEntrySelection(id) {
      const result = await api('/api/entries/' + encodeURIComponent(id) + '?workspace=' + encodeURIComponent(state.workspace));
      state.selectedRecall = null; state.selected = result.entry; renderEntries(); renderEditor();
    }
    async function copyTextToClipboard(text) {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
    }
    function showEntryConflictGuide(entryId, draftText) {
      state.localizedStatus = null;
      const root = $('status'); root.className = 'status conflict-guide'; root.setAttribute('role', 'alert'); root.setAttribute('aria-live', 'assertive');
      const heading = document.createElement('h2'); setI18nText(heading, 'entryConflictTitle');
      const explanation = document.createElement('p'); setI18nText(explanation, 'entryConflictExplanation');
      const steps = document.createElement('ol');
      for (const key of ['entryConflictStepCopy', 'entryConflictStepReload', 'entryConflictStepCompare']) { const item = document.createElement('li'); setI18nText(item, key); steps.append(item); }
      const applyHint = document.createElement('p'); applyHint.id = 'entry-conflict-apply-hint'; setI18nText(applyHint, 'entryConflictApplyHint');
      const actions = document.createElement('div'); actions.className = 'conflict-guide-actions';
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'button primary'; apply.setAttribute('aria-describedby', applyHint.id); setI18nText(apply, 'entryConflictApply');
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button'; setI18nText(copy, 'entryConflictCopy');
      const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'button'; setI18nText(reload, 'entryConflictReload');
      const feedback = document.createElement('div'); feedback.className = 'conflict-guide-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
      const actionsDisabled = (disabled) => { for (const action of [apply, copy, reload]) action.disabled = disabled; };
      apply.addEventListener('click', async () => {
        actionsDisabled(true); setI18nText(apply, 'entryConflictApplying');
        try {
          await copyTextToClipboard(draftText());
        } catch {
          actionsDisabled(false); setI18nText(apply, 'entryConflictApply');
          feedback.className = 'conflict-guide-feedback error'; setI18nText(feedback, 'entryConflictApplyCopyFailed');
          return;
        }
        try {
          await loadEntrySelection(entryId);
          setLocalizedStatus('entryConflictApplied');
        } catch (error) {
          actionsDisabled(false); setI18nText(apply, 'entryConflictApply');
          feedback.className = 'conflict-guide-feedback error'; feedback.textContent = t('entryConflictApplyReloadFailed') + ' ' + apiErrorText(error);
        }
      });
      copy.addEventListener('click', async () => {
        actionsDisabled(true); setI18nText(copy, 'entryConflictCopying');
        try {
          await copyTextToClipboard(draftText());
          feedback.className = 'conflict-guide-feedback'; setI18nText(feedback, 'entryConflictCopied');
        } catch {
          feedback.className = 'conflict-guide-feedback error'; setI18nText(feedback, 'entryConflictCopyFailed');
        } finally {
          actionsDisabled(false); setI18nText(copy, 'entryConflictCopy');
        }
      });
      reload.addEventListener('click', async () => {
        actionsDisabled(true); setI18nText(reload, 'entryConflictReloading');
        try {
          await loadEntrySelection(entryId);
          setLocalizedStatus('entryConflictReloaded');
        } catch (error) {
          actionsDisabled(false); setI18nText(reload, 'entryConflictReload');
          feedback.className = 'conflict-guide-feedback error'; feedback.textContent = apiErrorText(error);
        }
      });
      actions.append(apply, copy, reload); root.replaceChildren(heading, explanation, steps, applyHint, actions, feedback);
      requestAnimationFrame(() => root.scrollIntoView({ block: 'nearest' }));
    }
    const escapeTags = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
    const setCuratorStatus = (message, error = false) => {
      const element = $('curator-status');
      element.textContent = message;
      element.className = error ? 'status notice error curator-status' : 'status curator-status';
    };
    const setCuratorBackgroundBlocked = (blocked) => {
      const appMain = $('app-main');
      appMain.inert = blocked;
      if (blocked) appMain.setAttribute('aria-hidden', 'true');
      else appMain.removeAttribute('aria-hidden');
    };
    function restoreCuratorUrl() {
      const params = new URLSearchParams(location.search);
      state.curatorSearch = params.get('search') || '';
      state.curatorProject = params.get('project') || '';
      state.curatorTags = new Set(params.getAll('tag'));
      state.curatorFramework = params.get('framework') || '';
      state.curatorLanguage = params.get('language') || '';
      state.curatorMemoryClass = params.get('memoryClass') || '';
      state.curatorTier = params.get('tier') || '';
      state.curatorReady = params.get('ready') === 'true';
      state.curatorIncludeGlobalized = params.get('includeGlobalized') === 'true';
    }
    function syncCuratorUrl(push = false) {
      const params = new URLSearchParams(location.search);
      for (const key of ['search', 'project', 'framework', 'language', 'memoryClass', 'tier', 'ready', 'includeGlobalized', 'tag']) params.delete(key);
      if (state.curatorSearch) params.set('search', state.curatorSearch);
      if (state.curatorProject) params.set('project', state.curatorProject);
      if (state.curatorFramework) params.set('framework', state.curatorFramework);
      if (state.curatorLanguage) params.set('language', state.curatorLanguage);
      if (state.curatorMemoryClass) params.set('memoryClass', state.curatorMemoryClass);
      if (state.curatorTier) params.set('tier', state.curatorTier);
      if (state.curatorReady) params.set('ready', 'true');
      if (state.curatorIncludeGlobalized) params.set('includeGlobalized', 'true');
      for (const tag of state.curatorTags) params.append('tag', tag);
      const nextUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
      if (push) history.pushState(null, '', nextUrl); else history.replaceState(null, '', nextUrl);
    }
    function curatorFilterSelect(label, values, value, onChange) {
      const wrapper = document.createElement('label'); wrapper.className = 'curator-filter';
      const text = document.createElement('span'); text.textContent = label;
      const select = document.createElement('select');
      const all = document.createElement('option'); all.value = ''; all.textContent = 'All'; select.append(all);
      for (const item of values || []) { const option = document.createElement('option'); option.value = item.value || item.workspace; option.textContent = item.name || item.value || item.workspace; select.append(option); }
      select.value = value || ''; select.addEventListener('change', () => onChange(select.value)); wrapper.append(text, select); return wrapper;
    }
    function renderCuratorFilters() {
      const root = $('curator-filters'); if (!root) return;
      const facets = state.curatorFacets || {};
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search candidates'; search.value = state.curatorSearch; search.addEventListener('input', () => { state.curatorSearch = search.value.trim(); clearTimeout(state.curatorSearchTimer); state.curatorSearchTimer = setTimeout(() => { syncCuratorUrl(true); loadCurator(); }, 180); });
      const project = curatorFilterSelect('Project', facets.projects, state.curatorProject, (value) => { state.curatorProject = value; syncCuratorUrl(true); loadCurator(); });
      const framework = curatorFilterSelect('Framework', facets.frameworks, state.curatorFramework, (value) => { state.curatorFramework = value; syncCuratorUrl(true); loadCurator(); });
      const language = curatorFilterSelect('Language', facets.languages, state.curatorLanguage, (value) => { state.curatorLanguage = value; syncCuratorUrl(true); loadCurator(); });
      const memoryClass = curatorFilterSelect('Memory class', facets.memoryClasses, state.curatorMemoryClass, (value) => { state.curatorMemoryClass = value; syncCuratorUrl(true); loadCurator(); });
      const readiness = curatorFilterSelect('Readiness', [{ value: 'portable', name: 'Portable' }, { value: 'repeated', name: 'Repeated' }, { value: 'observed', name: 'Observed' }], state.curatorTier, (value) => { state.curatorTier = value; syncCuratorUrl(true); loadCurator(); });
      const ready = document.createElement('label'); ready.className = 'curator-filter-check'; const readyInput = document.createElement('input'); readyInput.type = 'checkbox'; readyInput.checked = state.curatorReady; readyInput.addEventListener('change', () => { state.curatorReady = readyInput.checked; syncCuratorUrl(true); loadCurator(); }); ready.append(readyInput, document.createTextNode('Skill-ready'));
      const globalized = document.createElement('label'); globalized.className = 'curator-filter-check'; const globalizedInput = document.createElement('input'); globalizedInput.type = 'checkbox'; globalizedInput.checked = state.curatorIncludeGlobalized; globalizedInput.addEventListener('change', () => { state.curatorIncludeGlobalized = globalizedInput.checked; syncCuratorUrl(true); loadCurator(); }); globalized.append(globalizedInput, document.createTextNode('Show already globalized'));
      const tags = document.createElement('div'); tags.className = 'curator-filter-tags'; for (const facet of facets.tags || []) { const button = document.createElement('button'); button.type = 'button'; button.className = 'tag' + (state.curatorTags.has(facet.value) ? ' active' : ''); button.textContent = '#' + facet.value + ' (' + facet.count + ')'; button.addEventListener('click', () => { if (state.curatorTags.has(facet.value)) state.curatorTags.delete(facet.value); else state.curatorTags.add(facet.value); syncCuratorUrl(true); loadCurator(); }); tags.append(button); }
      root.replaceChildren(search, project, framework, language, memoryClass, readiness, ready, globalized, tags);
    }
    function openCurator() {
      if (state.curatorOpen) { $('curator-close')?.focus(); return; }
      state.curatorPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      state.curatorOpen = true;
      const modal = $('curator-modal');
      modal.classList.remove('is-closing');
      setCuratorBackgroundBlocked(true);
      renderCurator();
      requestAnimationFrame(() => $('curator-close')?.focus());
    }
    function closeCurator() {
      if (state.curatorGlobalizeBusy) return;
      if (state.curatorPendingCandidate) closeCuratorConfirmation(false);
      const modal = $('curator-modal');
      if (modal.hidden) return;
      state.curatorOpen = false;
      modal.classList.add('is-closing');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        modal.hidden = true;
        modal.classList.remove('is-closing');
        setCuratorBackgroundBlocked(false);
        const previousFocus = state.curatorPreviousFocus;
        state.curatorPreviousFocus = null;
        if (previousFocus?.isConnected) previousFocus.focus();
        else $('curator-button')?.focus();
      };
      modal.addEventListener('animationend', (event) => { if (event.target === modal) finish(); }, { once: true });
      window.setTimeout(finish, 220);
    }
    function handleCuratorKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeCurator(); return; }
      if (event.key !== 'Tab') return;
      const modal = $('curator-modal');
      const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    const setExternalSkillsStatus = (message, error = false) => {
      const element = $('external-skills-status');
      element.textContent = message;
      element.className = error ? 'status notice error curator-status' : 'status curator-status';
    };
    function openExternalSkills() {
      if (state.externalSkillsOpen) { $('external-skills-close')?.focus(); return; }
      state.externalSkillsPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      state.externalSkillsOpen = true;
      const modal = $('external-skills-modal');
      modal.classList.remove('is-closing');
      setCuratorBackgroundBlocked(true);
      modal.hidden = false;
      requestAnimationFrame(() => $('external-skills-close')?.focus());
    }
    function closeExternalSkills() {
      if (state.externalSkillsBusy) return;
      const modal = $('external-skills-modal');
      if (modal.hidden) return;
      state.externalSkillsOpen = false;
      state.externalSkillsPendingDisable = null;
      modal.classList.add('is-closing');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        modal.hidden = true;
        modal.classList.remove('is-closing');
        setCuratorBackgroundBlocked(false);
        const previousFocus = state.externalSkillsPreviousFocus;
        state.externalSkillsPreviousFocus = null;
        if (previousFocus?.isConnected) previousFocus.focus(); else $('external-skills-button')?.focus();
      };
      modal.addEventListener('animationend', (event) => { if (event.target === modal) finish(); }, { once: true });
      window.setTimeout(finish, 220);
    }
    function handleExternalSkillsKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeExternalSkills(); return; }
      if (event.key !== 'Tab') return;
      const modal = $('external-skills-modal');
      const focusable = [...modal.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    function skillField(labelKey, value) {
      const field = document.createElement('div'); field.className = 'skill-field';
      const label = document.createElement('dt'); setI18nText(label, labelKey);
      const content = document.createElement('dd'); content.textContent = value || t('unknown');
      field.append(label, content); return field;
    }
    function externalSkillButton(attribute, skillId) {
      return [...document.querySelectorAll('[' + attribute + ']')].find((element) => element.getAttribute(attribute) === skillId);
    }
    function externalSkillSourceUrl(skill) {
      return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(skill.sourceLocator) ? 'https://github.com/' + skill.sourceLocator : null;
    }
    function renderExternalSkills() {
      if (!state.externalSkillsOpen) return;
      const root = $('external-skills-list');
      if (!state.externalSkills.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'externalSkillsEmpty'); root.replaceChildren(empty); return; }
      root.replaceChildren(...state.externalSkills.map((skill) => {
        const card = document.createElement('article'); card.className = 'skill-card';
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const stateBadge = document.createElement('span'); stateBadge.className = 'badge ' + (skill.state === 'disabled' ? 'superseded' : skill.state === 'imported' ? 'verified' : 'candidate'); stateBadge.textContent = skill.state;
        const official = document.createElement('span'); official.className = 'badge'; official.textContent = skill.officialStatus;
        meta.append(stateBadge, official);
        const heading = document.createElement('h3'); heading.textContent = skill.name;
        const fields = document.createElement('dl'); fields.className = 'skill-card-grid';
        fields.append(
          skillField('externalSkillsSource', skill.sourceLocator + '/' + skill.slug),
          skillField('externalSkillsCommit', skill.sourceCommit ? skill.sourceCommit.slice(0, 12) : null),
          skillField('externalSkillsSnapshot', skill.snapshotHash ? skill.snapshotHash.slice(0, 12) : null),
          skillField('externalSkillsDocuments', String(skill.metadata?.documents ?? 0)),
          skillField('externalSkillsFirstSeen', skill.firstSeenAt),
          skillField('externalSkillsLastChecked', skill.lastCheckedAt),
          skillField('externalSkillsTechnology', skill.metadata?.technology ?? skill.name),
          skillField('externalSkillsAudit', skill.auditStatus),
          skillField('externalSkillsState', skill.state),
        );
        const notice = document.createElement('div'); notice.className = 'notice'; setI18nText(notice, 'externalSkillsUntrusted');
        const actions = document.createElement('div'); actions.className = 'skill-card-actions';
        const sourceUrl = externalSkillSourceUrl(skill);
        if (sourceUrl) { const source = document.createElement('a'); source.className = 'button'; source.href = sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; setI18nText(source, 'externalSkillsSourceUrl'); actions.append(source); }
        const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'button'; refresh.setAttribute('data-external-skill-refresh', skill.skillId); setI18nText(refresh, 'externalSkillsRefresh'); refresh.disabled = state.externalSkillsBusy; refresh.addEventListener('click', () => externalSkillAction(skill.skillId, 'refresh')); actions.append(refresh);
        const action = skill.state === 'disabled' ? 'enable' : skill.state === 'imported' ? 'disable' : null;
        if (action === 'disable' && state.externalSkillsPendingDisable === skill.skillId) {
          const confirmation = document.createElement('div'); confirmation.className = 'notice'; confirmation.textContent = t('externalSkillsDisableConfirm');
          const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button primary'; confirm.setAttribute('data-external-skill-confirm', skill.skillId); setI18nText(confirm, 'externalSkillsDisable'); confirm.disabled = state.externalSkillsBusy; confirm.addEventListener('click', () => externalSkillAction(skill.skillId, action, true));
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button'; setI18nText(cancel, 'curatorCancel'); cancel.disabled = state.externalSkillsBusy; cancel.addEventListener('click', () => { state.externalSkillsPendingDisable = null; renderExternalSkills(); requestAnimationFrame(() => externalSkillButton('data-external-skill-toggle', skill.skillId)?.focus()); });
          actions.append(confirmation, confirm, cancel);
        } else if (action !== null) {
          const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button primary'; toggle.setAttribute('data-external-skill-toggle', skill.skillId); setI18nText(toggle, action === 'enable' ? 'externalSkillsEnable' : 'externalSkillsDisable'); toggle.disabled = state.externalSkillsBusy; toggle.addEventListener('click', () => externalSkillAction(skill.skillId, action)); actions.append(toggle);
        }
        const mapping = document.createElement('div'); mapping.className = 'detail-text'; mapping.hidden = true;
        const viewEntries = document.createElement('button'); viewEntries.type = 'button'; viewEntries.className = 'button'; viewEntries.setAttribute('aria-expanded', 'false'); setI18nText(viewEntries, 'externalSkillsViewEntries'); viewEntries.disabled = state.externalSkillsBusy; viewEntries.addEventListener('click', async () => {
          viewEntries.disabled = true;
          try {
            const detail = externalSkillDetail(await api('/api/skills/' + encodeURIComponent(skill.skillId)), skill.skillId);
            if (detail === null) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
            const entries = detail.entries;
            mapping.textContent = entries.length ? entries.map((entry) => entry.sourcePath + '#' + entry.chunkIndex + ' → ' + entry.entryId + '@' + entry.revision + (entry.active ? '' : ' (inactive)')).join('\n') : t('externalSkillsNoEntries');
            mapping.hidden = false;
            viewEntries.setAttribute('aria-expanded', 'true');
          } catch {
            mapping.textContent = '';
            mapping.hidden = true;
            viewEntries.setAttribute('aria-expanded', 'false');
            setExternalSkillsStatus(t('externalSkillsFailure'), true);
          }
          finally { viewEntries.disabled = state.externalSkillsBusy; }
        });
        actions.append(viewEntries);
        card.append(meta, heading, fields, notice, actions, mapping); return card;
      }));
    }
    async function reloadExternalSkills() {
      const skills = [];
      const skillIds = new Set();
      const cursors = new Set();
      let cursor = null;
      for (let page = 0; page < 100; page += 1) {
        const result = await api('/api/skills?limit=200' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || Object.keys(result).length !== 5
          || result.untrusted !== true
          || !Array.isArray(result.skills) || result.skills.length > 200
          || !Number.isSafeInteger(result.count) || result.count !== result.skills.length
          || typeof result.truncated !== 'boolean'
          || result.nextCursor !== null && typeof result.nextCursor !== 'string') throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
        if (skills.length + result.skills.length > 20_000) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
        for (const skill of result.skills) {
          if (!validExternalSkillListItem(skill) || skillIds.has(skill.skillId)) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
          skillIds.add(skill.skillId); skills.push(skill);
        }
        if (!result.truncated) {
          if (result.nextCursor !== null) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
          state.externalSkills = skills;
          renderExternalSkills();
          return;
        }
        if (result.skills.length === 0 || typeof result.nextCursor !== 'string' || result.nextCursor.length === 0 || cursors.has(result.nextCursor)) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
    }
    function externalSkillDetail(result, expectedSkillId) {
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 4 || result.untrusted !== true
        || !validExternalSkillListItem(result.skill) || result.skill.skillId !== expectedSkillId
        || !Array.isArray(result.entries) || result.entries.length > 200
        || typeof result.entriesTruncated !== 'boolean'
        || result.entriesTruncated && result.entries.length !== 200
        || result.skill.sourceCommit === null && result.entries.length !== 0) return null;
      const entryIds = new Set(); const mappingIds = new Set();
      for (const entry of result.entries) {
        const mappingId = validExternalSkillEntrySummary(entry) ? entry.sourcePath + '\u0000' + entry.chunkIndex : null;
        if (mappingId === null || entryIds.has(entry.entryId) || mappingIds.has(mappingId)) return null;
        entryIds.add(entry.entryId); mappingIds.add(mappingId);
      }
      return { skill: result.skill, entries: result.entries, entriesTruncated: result.entriesTruncated };
    }
    async function reloadExternalSkill(skillId) {
      const detail = externalSkillDetail(await api('/api/skills/' + encodeURIComponent(skillId)), skillId);
      if (detail === null) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
      const index = state.externalSkills.findIndex((skill) => skill.skillId === skillId);
      if (index < 0) throw apiError({ error: { code: 'INVALID_RESPONSE', message: t('requestFailed') } });
      state.externalSkills[index] = detail.skill;
      renderExternalSkills();
    }
    async function externalSkillAction(skillId, action, confirmed = false) {
      if (state.externalSkillsBusy) return;
      if (action === 'disable' && !confirmed) { state.externalSkillsPendingDisable = skillId; renderExternalSkills(); requestAnimationFrame(() => externalSkillButton('data-external-skill-confirm', skillId)?.focus()); return; }
      state.externalSkillsPendingDisable = null;
      state.externalSkillsBusy = true;
      $('external-skills-refresh').disabled = true;
      $('external-skills-panel').setAttribute('aria-busy', 'true');
      setExternalSkillsStatus(action === 'refresh' ? t('externalSkillsRefreshing') : t('externalSkillsLoading'));
      renderExternalSkills();
      try {
        let actionError = null;
        try {
          await api('/api/skills/' + encodeURIComponent(skillId) + '/' + action, { method: 'POST' });
        } catch (error) {
          actionError = error;
        }
        let reloadError = null;
        try {
          await reloadExternalSkill(skillId);
        } catch (error) {
          reloadError = error;
        }
        if (reloadError) {
          state.externalSkills = [];
          state.externalSkillsPendingDisable = null;
        }
        if (actionError) {
          const reloadFailure = reloadError ? ' / ' + apiErrorText(reloadError) : '';
          setExternalSkillsStatus(apiErrorText(actionError) + reloadFailure, true);
        } else if (reloadError) {
          setExternalSkillsStatus(apiErrorText(reloadError), true);
        } else {
          setExternalSkillsStatus(t(action === 'disable' ? 'externalSkillsDisabled' : action === 'enable' ? 'externalSkillsEnabled' : 'externalSkillsRefreshed'));
        }
      } finally {
        state.externalSkillsBusy = false;
        $('external-skills-refresh').disabled = false;
        $('external-skills-panel').removeAttribute('aria-busy');
        renderExternalSkills();
        requestAnimationFrame(() => externalSkillButton(action === 'refresh' ? 'data-external-skill-refresh' : 'data-external-skill-toggle', skillId)?.focus());
      }
    }
    async function loadExternalSkills(open = true) {
      if (state.externalSkillsBusy) return;
      if (open) openExternalSkills();
      state.externalSkills = [];
      state.externalSkillsPendingDisable = null;
      state.externalSkillsBusy = true;
      $('external-skills-refresh').disabled = true;
      renderExternalSkills();
      setExternalSkillsStatus(t('externalSkillsLoading'));
      $('external-skills-panel').setAttribute('aria-busy', 'true');
      try {
        await reloadExternalSkills();
        setExternalSkillsStatus('');
      } catch (error) {
        setExternalSkillsStatus(t('externalSkillsOffline') + ' ' + apiErrorText(error), true);
      } finally {
        $('external-skills-panel').removeAttribute('aria-busy');
        state.externalSkillsBusy = false;
        $('external-skills-refresh').disabled = false;
        renderExternalSkills();
      }
    }

    function filterButton(key, label, count, active, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'genre ' + (active ? 'active' : '');
        const text = document.createElement('span'); text.textContent = label;
        const countBadge = document.createElement('span'); countBadge.className = 'count'; countBadge.textContent = String(count || 0);
        button.append(text, countBadge);
        button.dataset.filter = key;
        button.addEventListener('click', onClick);
        return button;
    }

    function filterGroup(title, buttons) {
      const group = document.createElement('section'); group.className = 'filter-group';
      const heading = document.createElement('div'); heading.className = 'filter-group-title'; heading.textContent = title; group.append(heading, ...buttons); return group;
    }

    function renderFilters() {
      const kindCounts = Object.fromEntries(kinds.map(([kind]) => [kind, kind === 'all' ? state.entries.length : state.entries.filter((entry) => entry.kind === kind).length]));
      const tagCounts = Object.fromEntries(state.tags.map((item) => [item.tag, item.count]));
      const botButtons = botModes.map(([tag, label]) => filterButton(tag, t(label), tagCounts[tag], state.tag === tag, () => { state.tag = tag; renderFilters(); loadEntries(); }));
      const kindButtons = kinds.map(([kind, label]) => filterButton(kind, t(label), kindCounts[kind], state.kind === kind, () => { state.kind = kind; renderFilters(); loadEntries(); }));
      const tagButtons = state.tags
        .filter((item) => !botModes.some(([tag]) => tag === item.tag))
        .map((item) => filterButton(item.tag, '#' + item.tag, item.count, state.tag === item.tag, () => { state.tag = item.tag; renderFilters(); loadEntries(); }));
      const root = $('genres'); root.replaceChildren(filterGroup(t('botFilterTitle'), botButtons), filterGroup(t('memoryTypeFilterTitle'), kindButtons));
      if (tagButtons.length > 0) root.append(filterGroup(t('crossTagFilterTitle'), tagButtons));
    }

    function renderFederatedItems() {
      const list = $('entry-list');
      list.replaceChildren(...state.recallItems.map((item) => {
        const card = document.createElement('article'); card.className = 'entry-card federated-card ' + (item.origin === 'global' ? 'global' : '');
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const origin = document.createElement('span'); origin.className = 'badge origin-' + item.origin; origin.textContent = labelForOrigin(item.origin);
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(item.kind);
        const status = document.createElement('span'); status.className = 'badge ' + item.status; status.textContent = labelForStatus(item.status);
        meta.append(origin, kind, status);
        const title = document.createElement('h3'); title.textContent = item.title;
        const snippet = document.createElement('p'); snippet.className = 'snippet'; snippet.textContent = item.snippet;
        const source = document.createElement('div'); source.className = 'federated-source';
        const sourceLines = [];
        if (item.sourceWorkspace) sourceLines.push(t('sourceWorkspace', { workspace: item.sourceWorkspace }));
        if (item.sourceProject) sourceLines.push(t('sourceProject', { project: item.sourceProject }));
        source.textContent = sourceLines.join('\n');
        const tags = document.createElement('div'); tags.className = 'tags'; item.tags.forEach((tag) => { const tagItem = document.createElement('span'); tagItem.className = 'tag'; tagItem.textContent = '#' + tag; tags.append(tagItem); });
        const reasons = document.createElement('div'); reasons.className = 'selection-reasons'; reasons.textContent = [t('selectionReasons'), ...item.selectionReasons.map((reason) => '• ' + reason)].join('\n');
        card.append(meta, title, snippet, source, tags, reasons); card.addEventListener('click', () => { state.selected = null; state.selectedRecall = item; renderEntries(); renderEditor(); }); return card;
      }));
    }

    function renderEntries() {
      const displayed = state.recallItems.length > 0 ? state.recallItems.length : state.entries.length;
      $('result-count').textContent = tp('entryCount', displayed);
      $('list-title').textContent = state.recallItems.length > 0 ? t('entriesTitle') : (state.tag ? '#' + state.tag : (state.kind === 'all' ? t('entriesTitle') : labelForKind(state.kind)));
      const list = $('entry-list');
      if (state.recallItems.length > 0) { renderFederatedItems(); return; }
      if (!state.entries.length) {
        const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noEntries'); list.replaceChildren(empty); return;
      }
      list.replaceChildren(...state.entries.map((entry) => {
        const card = document.createElement('article'); card.className = 'entry-card ' + (state.selected?.id === entry.id ? 'selected' : '');
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(entry.kind);
        const status = document.createElement('span'); status.className = 'badge ' + entry.status; status.textContent = labelForStatus(entry.status);
        const revision = document.createElement('span'); revision.textContent = t('revision') + ' ' + entry.revision; meta.append(kind, status, revision);
        const title = document.createElement('h3'); title.textContent = entry.title;
        const snippet = document.createElement('p'); snippet.className = 'snippet'; snippet.textContent = entry.summary || entry.body;
        const tags = document.createElement('div'); tags.className = 'tags'; entry.tags.forEach((tag) => { const item = document.createElement('button'); item.type = 'button'; item.className = 'tag'; item.textContent = '#' + tag; item.addEventListener('click', (event) => { event.stopPropagation(); state.tag = tag; renderFilters(); loadEntries(); }); tags.append(item); });
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button'; setI18nText(edit, 'edit'); edit.style.marginTop = '12px'; edit.addEventListener('click', (event) => { event.stopPropagation(); selectEntry(entry.id); });
        card.append(meta, title, snippet, tags, edit); card.addEventListener('click', () => selectEntry(entry.id)); return card;
      }));
    }

    function renderFederatedDetail() {
      const editor = $('editor'); const item = state.selectedRecall;
      if (!item) return;
      const origin = document.createElement('span'); origin.className = 'badge origin-' + item.origin; origin.textContent = labelForOrigin(item.origin);
      const heading = document.createElement('h3'); heading.textContent = item.title;
      const meta = document.createElement('div'); meta.className = 'entry-meta'; meta.append(origin);
      if (item.sourceWorkspace) { const source = document.createElement('span'); source.className = 'badge'; source.textContent = t('sourceWorkspace', { workspace: item.sourceWorkspace }); meta.append(source); }
      if (item.sourceProject) { const source = document.createElement('span'); source.className = 'badge'; source.textContent = t('sourceProject', { project: item.sourceProject }); meta.append(source); }
      const notice = document.createElement('div'); notice.className = 'notice'; notice.textContent = t('federatedReadOnly');
      const detail = document.createElement('div'); detail.className = 'federated-detail';
      const snippet = document.createElement('div'); snippet.className = 'detail-text'; snippet.textContent = item.snippet;
      const reasons = detailBlock('selectionReasons', item.selectionReasons.join('\n'));
      const tags = detailBlock('commaSeparatedTags', item.tags.map((tag) => '#' + tag).join(' '));
      detail.append(snippet, reasons, tags);
      const stateBadge = $('editor-state'); delete stateBadge.dataset.i18n; delete stateBadge.dataset.i18nStatus; stateBadge.textContent = labelForOrigin(item.origin);
      editor.replaceChildren(meta, heading, notice, detail);
    }

    function renderEditor() {
      if (state.selectedRecall) { renderFederatedDetail(); return; }
      const editor = $('editor');
      const entry = state.selected;
      updateEditorState();
      if (!entry) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'selectMemory'); editor.replaceChildren(empty); return; }
      const form = document.createElement('form'); form.className = 'form';
      const row = document.createElement('div'); row.className = 'form-row';
      const kindLabel = document.createElement('label'); const kindLabelText = document.createElement('span'); setI18nText(kindLabelText, 'memoryType'); const kind = document.createElement('select'); kinds.filter(([value]) => value !== 'all').forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; setI18nText(option, label); kind.append(option); }); kind.value = entry.kind; kindLabel.append(kindLabelText, kind);
      const statusLabel = document.createElement('label'); const statusLabelText = document.createElement('span'); setI18nText(statusLabelText, 'status'); const status = document.createElement('input'); status.value = labelForStatus(entry.status); status.dataset.i18nStatus = entry.status; status.disabled = true; statusLabel.append(statusLabelText, status); row.append(kindLabel, statusLabel);
      const titleLabel = document.createElement('label'); const titleLabelText = document.createElement('span'); setI18nText(titleLabelText, 'title'); const title = document.createElement('input'); title.value = entry.title; titleLabel.append(titleLabelText, title);
      const bodyLabel = document.createElement('label'); const bodyLabelText = document.createElement('span'); setI18nText(bodyLabelText, 'body'); const body = document.createElement('textarea'); body.className = 'body'; body.value = entry.body; bodyLabel.append(bodyLabelText, body);
      const summaryLabel = document.createElement('label'); const summaryLabelText = document.createElement('span'); setI18nText(summaryLabelText, 'summary'); const summary = document.createElement('textarea'); summary.value = entry.summary || ''; summaryLabel.append(summaryLabelText, summary);
      const tagsLabel = document.createElement('label'); const tagsLabelText = document.createElement('span'); setI18nText(tagsLabelText, 'commaSeparatedTags'); const tags = document.createElement('input'); tags.value = entry.tags.join(', '); tagsLabel.append(tagsLabelText, tags);
      const jsonRow = document.createElement('div'); jsonRow.className = 'form-row';
      const scopeLabel = document.createElement('label'); const scopeLabelText = document.createElement('span'); setI18nText(scopeLabelText, 'scopeJson'); const scope = document.createElement('textarea'); scope.value = JSON.stringify(entry.scope, null, 2); scopeLabel.append(scopeLabelText, scope);
      const provenanceLabel = document.createElement('label'); const provenanceLabelText = document.createElement('span'); setI18nText(provenanceLabelText, 'provenanceJson'); const provenance = document.createElement('textarea'); provenance.value = JSON.stringify(entry.provenance, null, 2); provenanceLabel.append(provenanceLabelText, provenance); jsonRow.append(scopeLabel, provenanceLabel);
      const actions = document.createElement('div'); actions.className = 'toolbar';
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; setI18nText(save, 'save');
      const note = document.createElement('div'); note.className = entry.status === 'candidate' ? 'notice' : 'notice error'; setI18nText(note, entry.status === 'candidate' ? 'candidateNotice' : 'immutableNotice');
      if (entry.status !== 'candidate') { save.disabled = true; [kind, title, body, summary, tags, scope, provenance].forEach((control) => { control.disabled = true; }); }
      const draftText = () => JSON.stringify({ memoryType: kind.value, title: title.value, body: body.value, summary: summary.value, tags: tags.value, scopeJson: scope.value, provenanceJson: provenance.value }, null, 2);
      actions.append(save); form.append(row, titleLabel, bodyLabel, summaryLabel, tagsLabel, jsonRow, note, actions); form.addEventListener('submit', async (event) => { event.preventDefault(); if (save.disabled) return; save.disabled = true; setI18nText(save, 'saving'); try {
        const payload = { expectedRevision: entry.revision, kind: kind.value, title: title.value, body: body.value, summary: summary.value || null, scope: JSON.parse(scope.value || '{}'), provenance: JSON.parse(provenance.value || '{}'), tags: escapeTags(tags.value) };
        await api('/api/entries/' + encodeURIComponent(entry.id) + '?workspace=' + encodeURIComponent(state.workspace), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setLocalizedStatus('saved'); await loadEntries(); await selectEntry(entry.id);
      } catch (error) { if (error instanceof Error && error.code === 'CONFLICT') showEntryConflictGuide(entry.id, draftText); else setStatus(error instanceof Error ? error.message : t('requestFailed'), true); }
      finally { if (save.isConnected) { save.disabled = false; setI18nText(save, 'save'); } }
      }); editor.replaceChildren(form);
    }

    async function selectEntry(id) { try { await loadEntrySelection(id); } catch (error) { setStatus(error instanceof Error ? error.message : t('requestFailed'), true); } }

    const curatorCandidateKey = (candidate) => candidate.workspace + '\u0000' + candidate.entryId;

    function setCuratorConfirmationStatus(message, error = false) {
      const element = $('curator-confirm-status');
      element.textContent = message;
      element.className = error ? 'status notice error curator-status' : 'status curator-status';
    }

    function openCuratorConfirmation(candidate, trigger) {
      if (state.curatorGlobalizeBusy || state.curatorGlobalized.has(curatorCandidateKey(candidate))) return;
      state.curatorPendingCandidate = candidate;
      state.curatorConfirmationTrigger = trigger instanceof HTMLElement ? trigger : null;
      $('curator-confirm-source').textContent = candidate.projectName || candidate.workspace;
      $('curator-confirm-skill').textContent = candidate.skillName;
      $('curator-confirm-applicability').textContent = candidate.applicability ? JSON.stringify(candidate.applicability, null, 2) : t('curatorApplicabilityNone');
      $('curator-confirm-draft').textContent = [
        t('curatorDraftTitle') + '\n' + candidate.draft.title,
        t('curatorDraftSummary') + '\n' + candidate.draft.summary,
        t('curatorDraftBody') + '\n' + candidate.draft.body,
        t('curatorDraftVersion') + '\n' + candidate.draft.version,
      ].join('\n\n');
      setCuratorConfirmationStatus('');
      const panel = $('curator-panel');
      panel.inert = true;
      panel.setAttribute('aria-hidden', 'true');
      const submit = $('curator-confirm-submit');
      submit.disabled = false;
      setI18nText(submit, 'curatorConfirmAction');
      $('curator-confirm-cancel').disabled = false;
      $('curator-confirm-modal').hidden = false;
      requestAnimationFrame(() => submit.focus());
    }

    function closeCuratorConfirmation(restoreFocus = true) {
      if (state.curatorGlobalizeBusy) return;
      $('curator-confirm-modal').hidden = true;
      const panel = $('curator-panel');
      panel.inert = false;
      panel.removeAttribute('aria-hidden');
      const trigger = state.curatorConfirmationTrigger;
      state.curatorPendingCandidate = null;
      state.curatorConfirmationTrigger = null;
      setCuratorConfirmationStatus('');
      if (restoreFocus) requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
        else $('curator-close')?.focus();
      });
    }

    function handleCuratorConfirmationKeydown(event) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeCuratorConfirmation(); return; }
      if (event.key !== 'Tab') return;
      const panel = $('curator-confirm-panel');
      const focusable = [...panel.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    async function globalizePendingCurator() {
      const candidate = state.curatorPendingCandidate;
      if (!candidate || state.curatorGlobalizeBusy) return;
      state.curatorGlobalizeBusy = true;
      const panel = $('curator-confirm-panel');
      const cancel = $('curator-confirm-cancel');
      const submit = $('curator-confirm-submit');
      panel.setAttribute('aria-busy', 'true');
      cancel.disabled = true;
      submit.disabled = true;
      setI18nText(submit, 'curatorGlobalizing');
      setCuratorConfirmationStatus(t('curatorGlobalizing'));
      try {
        await api('/api/curator/globalize?workspace=' + encodeURIComponent(candidate.workspace), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: candidate.workspace, entryId: candidate.entryId, expectedRevision: candidate.revision }),
        });
        state.curatorGlobalized.add(curatorCandidateKey(candidate));
        state.curatorGlobalizeBusy = false;
        closeCuratorConfirmation(false);
        await loadCurator();
        await loadEntries();
        setLocalizedStatus('curatorAdded');
        setCuratorStatus(t('curatorAdded'));
        requestAnimationFrame(() => $('curator-close')?.focus());
      } catch (error) {
        const message = error instanceof Error ? error.message : t('curatorGlobalizeFailed');
        setCuratorConfirmationStatus(t('curatorGlobalizeFailed') + ' ' + message, true);
      } finally {
        state.curatorGlobalizeBusy = false;
        panel.removeAttribute('aria-busy');
        cancel.disabled = false;
        submit.disabled = false;
        setI18nText(submit, 'curatorConfirmAction');
      }
    }

    function renderCurator() {
      if (!state.curatorOpen) return;
      const modal = $('curator-modal');
      modal.hidden = false;
      const root = $('curator-list');
      $('curator-result-count').textContent = t('curatorResultCount', { count: state.curatorTotalApproximate || state.curatorCandidates.length });
      const actionRoot = $('curator-actions'); actionRoot.replaceChildren();
      if (state.curatorNextCursor) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'button'; setI18nText(more, 'curatorLoadMore'); more.addEventListener('click', () => loadCurator(true)); actionRoot.append(more);
      }
      if (!state.curatorCandidates.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noCuratorCandidates'); root.replaceChildren(empty); return; }
      const cards = state.curatorCandidates.map((candidate, index) => {
        const card = document.createElement('article'); card.className = 'curator-card';
        const candidateKey = curatorCandidateKey(candidate);
        const done = state.curatorGlobalized.has(candidateKey);
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(candidate.kind);
        const score = document.createElement('span'); score.className = 'badge'; score.textContent = t('curatorScore', { score: candidate.score });
        const workspace = document.createElement('span'); workspace.className = 'badge curator-workspace'; workspace.textContent = t('curatorWorkspace', { workspace: candidate.workspace });
        meta.append(kind, score, workspace);
        if (candidate.knowledge && candidate.knowledge.skillReady) { const ready = document.createElement('span'); ready.className = 'badge'; setI18nText(ready, 'curatorSkillReady'); meta.append(ready); }
        const heading = document.createElement('h3'); heading.textContent = candidate.skillName;
        const overview = document.createElement('div'); overview.className = 'curator-overview'; overview.textContent = candidate.overview.join('\n');
        const tags = document.createElement('div'); tags.className = 'tags'; (candidate.tags || []).forEach((tag) => { const tagItem = document.createElement('span'); tagItem.className = 'tag'; tagItem.textContent = '#' + tag; tags.append(tagItem); });
        const knowledge = document.createElement('div'); knowledge.className = 'curator-reasons'; knowledge.textContent = candidate.knowledge ? [
          t('curatorEvidence', { hits: candidate.knowledge.qualifiedHits, runs: candidate.knowledge.independentRuns, workspaces: candidate.knowledge.independentWorkspaces }),
          t('curatorSilo', { value: candidate.knowledge.averageCompleteness }),
          ...(candidate.knowledge.readinessReasons || []),
        ].join('\n') : '';
        const draft = document.createElement('section'); draft.className = 'curator-draft';
        const draftHeading = document.createElement('h4'); setI18nText(draftHeading, 'curatorDraft');
        draft.append(draftHeading);
        const draftFields = [
          ['curatorDraftTitle', candidate.draft.title],
          ['curatorDraftSummary', candidate.draft.summary],
          ['curatorDraftBody', candidate.draft.body],
          ['curatorDraftVersion', candidate.draft.version],
          ['curatorDraftChanges', (candidate.draft.changes || []).map((change) => t({
            'portable-sections-generated': 'curatorChangePortableSections',
            'project-references-normalized': 'curatorChangeProjectReferences',
            'paths-generalized': 'curatorChangePaths',
            'applicability-retained': 'curatorChangeApplicability',
          }[change] || 'curatorChangeUnknown')).join('\n')],
        ];
        for (const [labelKey, value] of draftFields) {
          const label = document.createElement('div'); label.className = 'curator-draft-label'; setI18nText(label, labelKey);
          const content = document.createElement('pre'); content.className = 'curator-draft-value'; content.textContent = value;
          draft.append(label, content);
        }
        const reasons = document.createElement('div'); reasons.className = 'curator-reasons'; reasons.textContent = [...(candidate.reasons || []), ...(candidate.warnings || []).map((warning) => t('curatorWarning', { warning }))].join('\n');
        const details = document.createElement('div'); details.id = 'curator-review-' + index; details.className = 'curator-review-details'; details.hidden = true; details.append(knowledge, draft, reasons);
        const actions = document.createElement('div'); actions.className = 'curator-card-actions';
        const review = document.createElement('button'); review.type = 'button'; review.className = 'button'; review.setAttribute('aria-controls', details.id); review.setAttribute('aria-expanded', 'false'); setI18nText(review, 'curatorReview');
        review.addEventListener('click', () => { details.hidden = !details.hidden; review.setAttribute('aria-expanded', String(!details.hidden)); setI18nText(review, details.hidden ? 'curatorReview' : 'curatorHideReview'); });
        const globalize = document.createElement('button'); globalize.type = 'button'; globalize.className = 'button primary'; globalize.disabled = done; setI18nText(globalize, done ? 'globalized' : 'curatorGlobalizeCandidate');
        globalize.addEventListener('click', () => openCuratorConfirmation(candidate, globalize));
        actions.append(review, globalize);
        card.append(meta, heading, overview, tags, actions, details); return card;
      });
      root.replaceChildren(...cards);
    }

    async function loadCurator(append = false) {
      // Keep the documented URL shape recognizable for clients: /api/curator/candidates?limit=50
      if (!append) {
        openCurator();
        state.curatorCandidates = [];
        state.curatorNextCursor = null;
        state.curatorTotalApproximate = 0;
      } else if (!state.curatorNextCursor) return;
      const panel = $('curator-panel');
      panel.setAttribute('aria-busy', 'true');
      setCuratorStatus(t('curatorLoading'));
      try {
        if (!append) {
          const facetParams = new URLSearchParams({ workspace: 'all' });
          if (state.curatorIncludeGlobalized) facetParams.set('includeGlobalized', 'true');
          const facetResult = await api('/api/curator/facets?' + facetParams);
          state.curatorFacets = facetResult.facets || {};
          renderCuratorFilters();
        }
        const params = new URLSearchParams({ workspace: 'all', limit: '50' });
        if (state.curatorProject) params.set('project', state.curatorProject);
        if (state.curatorSearch) params.set('search', state.curatorSearch);
        if (state.curatorFramework) params.set('framework', state.curatorFramework);
        if (state.curatorLanguage) params.set('language', state.curatorLanguage);
        if (state.curatorMemoryClass) params.set('memoryClass', state.curatorMemoryClass);
        if (state.curatorTier) params.set('tier', state.curatorTier);
        if (state.curatorReady) params.set('skillReadyOnly', 'true');
        if (state.curatorIncludeGlobalized) params.set('includeGlobalized', 'true');
        for (const tag of state.curatorTags) params.append('tag', tag);
        if (append && state.curatorNextCursor) params.set('cursor', state.curatorNextCursor);
        const result = await api('/api/curator/candidates?' + params);
        state.curatorCandidates = append ? [...state.curatorCandidates, ...(result.candidates || [])] : (result.candidates || []);
        state.curatorNextCursor = result.nextCursor || null;
        state.curatorTotalApproximate = Number(result.totalApproximate || state.curatorCandidates.length);
        setCuratorStatus('');
        renderCurator();
      }
      catch (error) { setCuratorStatus(error.message, true); }
      finally { panel.removeAttribute('aria-busy'); }
    }

    async function loadRunDetail(runId) {
      try {
        const result = await api('/api/operator/runs/' + encodeURIComponent(runId));
        state.selectedRun = result;
        renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    function detailBlock(titleKey, value) {
      const block = document.createElement('section'); block.className = 'detail-block';
      const heading = document.createElement('h3'); setI18nText(heading, titleKey);
      const text = document.createElement('div'); text.className = 'detail-text'; text.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      block.append(heading, text); return block;
    }

    function renderRunDetail() {
      const root = $('run-detail'); const detail = state.selectedRun;
      if (!detail) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'runSelect'); root.replaceChildren(empty); return; }
      const heading = document.createElement('h3'); setI18nText(heading, 'contextWarning');
      const blocks = [
        detailBlock('detailRunIntake', { run: detail.run, intake: detail.intake }),
        detailBlock('detailInitialProfile', detail.profile.initial),
        detailBlock('detailProjectedProfile', detail.profile.projected),
        detailBlock('detailPolicySource', { policyVersion: detail.profile.policyVersion, source: detail.profile.source, initialProfileHash: detail.profile.initialProfileHash }),
        detailBlock('detailCoverageWarnings', { coverage: detail.coverage, evidenceState: detail.evidenceState, warnings: detail.warnings }),
        detailBlock('detailTimelineEvidence', { timeline: detail.timeline, evidence: detail.evidence }),
        detailBlock('detailDeliveriesReasons', detail.deliveries),
        detailBlock('detailFeedback', detail.feedback),
        detailBlock('detailProposalLinks', { proposals: detail.proposals, links: detail.memoryLinks }),
      ];
      root.replaceChildren(heading, ...blocks);
    }

    function renderRuns() {
      const root = $('run-list');
      if (!state.runs.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noRuns'); root.replaceChildren(empty); return; }
      root.replaceChildren(...state.runs.map((run) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'run-card' + (state.selectedRun?.run?.runId === run.runId ? ' selected' : '');
        button.textContent = run.runId + ' / ' + (run.status || t('unknown')) + ' / ' + (run.title || t('untitled'));
        button.addEventListener('click', () => loadRunDetail(run.runId)); return button;
      }));
    }

    async function loadRuns() {
      if (!state.workspace) return;
      try {
        const result = await api('/api/operator/runs?workspace=' + encodeURIComponent(state.workspace) + '&limit=50');
        state.runs = result.items || []; renderRuns(); setI18nText($('run-page'), result.nextCursor ? 'nextPage' : 'end');
        if (!state.selectedRun && state.runs[0]) await loadRunDetail(state.runs[0].runId);
        else renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    async function loadEntries() {
      if (!state.workspace) return;
      try {
        const params = new URLSearchParams({ workspace: state.workspace });
        if (state.kind !== 'all') params.set('kind', state.kind);
        if (state.tag) params.set('tag', state.tag);
        if (state.query) params.set('q', state.query);
        const result = await api('/api/entries?' + params);
        state.entries = result.entries;
        state.recallItems = [];
        state.selectedRecall = null;
        if (state.query && state.kind === 'all' && !state.tag) {
          const recallParams = new URLSearchParams({ workspace: state.workspace, q: state.query, limit: '100' });
          const recalled = await api('/api/memory/recall?' + recallParams);
          state.recallItems = recalled.combined?.items || [];
          state.selected = null;
        } else if (state.selected && !state.entries.some((entry) => entry.id === state.selected.id)) state.selected = null;
        renderEntries(); renderFilters();
        if (!state.recallItems.length && !state.selected && state.entries[0]) await selectEntry(state.entries[0].id);
        else renderEditor();
        setLocalizedCountStatus('displayedCount', state.recallItems.length || result.entries.length);
      } catch (error) { setStatus(error.message, true); }
    }
    async function loadTags() { if (!state.workspace) return; try { const result = await api('/api/tags?workspace=' + encodeURIComponent(state.workspace)); state.tags = result.tags; renderFilters(); } catch (error) { setStatus(error.message, true); } }
    async function loadWorkspaces() { try { const result = await api('/api/workspaces'); const select = $('workspace'); select.replaceChildren(...result.workspaces.map((item) => { const option = document.createElement('option'); option.value = item.workspace; option.textContent = (item.displayName || item.workspace) + ' (' + item.count + ')'; return option; })); if (!state.workspace && result.workspaces[0]) state.workspace = result.workspaces[0].workspace; select.value = state.workspace; if (state.workspace) { await loadTags(); await loadEntries(); await loadRuns(); } if (state.curatorOpen) await loadCurator(); else if (!state.workspace) setLocalizedStatus('noWorkspace', {}, true); } catch (error) { setStatus(error.message, true); } }
    $('language-toggle').addEventListener('click', () => {
      setLanguageMenuOpen($('language-toggle').getAttribute('aria-expanded') !== 'true');
    });
    $('language-toggle').addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      setLanguageMenuOpen(true);
    });
    $('language-menu').addEventListener('keydown', (event) => {
      const options = [...$('language-menu').querySelectorAll('.language-option')];
      const current = options.indexOf(document.activeElement);
      let next = null;
      if (event.key === 'ArrowDown') next = options[(current + 1) % options.length];
      if (event.key === 'ArrowUp') next = options[(current - 1 + options.length) % options.length];
      if (event.key === 'Home') next = options[0];
      if (event.key === 'End') next = options.at(-1);
      if (event.key === 'Escape') { event.preventDefault(); setLanguageMenuOpen(false, true); return; }
      if (next) { event.preventDefault(); next.focus(); }
    });
    document.addEventListener('click', (event) => { if (!$('language-picker')?.contains(event.target)) setLanguageMenuOpen(false); });
    document.addEventListener('focusin', (event) => { if (!$('language-picker')?.contains(event.target)) setLanguageMenuOpen(false); });
    $('workspace').addEventListener('change', (event) => { if (state.curatorOpen) closeCurator(); if (state.externalSkillsOpen) closeExternalSkills(); state.workspace = event.target.value; state.selected = null; state.selectedRecall = null; state.selectedRun = null; state.runs = []; state.tag = ''; state.curatorCandidates = []; state.curatorGlobalized = new Set(); state.curatorNextCursor = null; state.curatorTotalApproximate = 0; state.curatorOpen = false; loadTags().then(loadEntries).then(loadRuns); });
    $('curator-button').addEventListener('click', () => loadCurator());
    $('curator-close').addEventListener('click', () => closeCurator());
    $('external-skills-button').addEventListener('click', () => loadExternalSkills());
    $('external-skills-close').addEventListener('click', () => closeExternalSkills());
    $('external-skills-refresh').addEventListener('click', () => loadExternalSkills(false));
    $('curator-confirm-cancel').addEventListener('click', () => closeCuratorConfirmation());
    $('curator-confirm-submit').addEventListener('click', () => globalizePendingCurator());
    $('curator-confirm-modal').addEventListener('keydown', handleCuratorConfirmationKeydown);
    $('curator-modal').addEventListener('keydown', handleCuratorKeydown);
    $('external-skills-modal').addEventListener('keydown', handleExternalSkillsKeydown);
    window.addEventListener('popstate', () => { restoreCuratorUrl(); if (state.curatorOpen) loadCurator(); });
    $('refresh').addEventListener('click', () => loadWorkspaces());
    let searchTimer; $('search').addEventListener('input', (event) => { clearTimeout(searchTimer); state.query = event.target.value.trim(); searchTimer = setTimeout(() => loadEntries(), 180); });
    applyTranslations();
    loadWorkspaces();
  </script>
</body>
</html>`;
