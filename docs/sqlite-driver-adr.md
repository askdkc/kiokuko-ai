# SQLite driver ADR

Kiokuko keeps JavaScript exact-cosine search as the portable fallback and uses
the package-owned sqlite-vec extension only when the configured backend is
`auto` or `sqlite-vec` and the extension loads successfully. The setup model
and embedding profile are independent of that backend choice. Extension
loading is disabled immediately after a successful load, and user-provided
native extension paths are not accepted.
