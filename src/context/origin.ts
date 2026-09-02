export const CONTEXT_ENTRY_ORIGINS = ['project', 'ecosystem', 'global'] as const;
export type ContextEntryOrigin = (typeof CONTEXT_ENTRY_ORIGINS)[number];

export function isContextEntryOrigin(value: unknown): value is ContextEntryOrigin {
  return typeof value === 'string' && CONTEXT_ENTRY_ORIGINS.includes(value as ContextEntryOrigin);
}

export function entryOriginMatchesWorkspace(input: {
  origin: ContextEntryOrigin;
  runWorkspace: string;
  entryWorkspace: string;
}): boolean {
  switch (input.origin) {
    case 'project':
      return input.entryWorkspace === input.runWorkspace;
    case 'global':
      return input.entryWorkspace === 'global';
    case 'ecosystem':
      return input.entryWorkspace !== 'global' && input.entryWorkspace !== input.runWorkspace;
  }
}
