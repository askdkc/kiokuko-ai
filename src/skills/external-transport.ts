const EXTERNAL_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

export function isExternalFetchFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof TypeError)) return false;
  const cause = (error as TypeError & { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && EXTERNAL_TRANSPORT_CODES.has(code);
}
