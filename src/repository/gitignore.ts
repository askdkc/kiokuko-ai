export const PROJECT_BINDING_IGNORE_ENTRY = '.kiokuko.json';

export interface RenderedProjectGitignore {
  content: string;
  action: 'created' | 'updated' | 'unchanged';
}

function containsProjectBindingEntry(content: string): boolean {
  return content
    .replaceAll('\r\n', '\n')
    .split('\n')
    .some((line) => line === PROJECT_BINDING_IGNORE_ENTRY || line === `/${PROJECT_BINDING_IGNORE_ENTRY}`);
}

/** Append the project binding ignore entry without rewriting user-owned bytes. */
export function renderProjectGitignore(existing: string | undefined): RenderedProjectGitignore {
  if (existing !== undefined && containsProjectBindingEntry(existing)) {
    return { content: existing, action: 'unchanged' };
  }
  const current = existing ?? '';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 || current.endsWith('\n') ? '' : newline;
  return {
    content: `${current}${separator}${PROJECT_BINDING_IGNORE_ENTRY}${newline}`,
    action: existing === undefined ? 'created' : 'updated',
  };
}
