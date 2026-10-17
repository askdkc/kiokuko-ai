/** The isolated `config get allow-scripts --json` response, not an npm release label. */
export function supportsNpmScriptPolicy(output: string): boolean {
  if (output.length > 16_384) return false;
  // npm config get prints its recognized empty-string default as a blank line,
  // including with --json. An unknown key instead prints the literal undefined.
  if (output.trim().length === 0) return true;
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
  } catch { return false; }
}
