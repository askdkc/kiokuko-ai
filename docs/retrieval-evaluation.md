# Retrieval evaluation

The existing evaluation keeps lexical and exact-signal lanes as baselines and
preserves weighted reciprocal-rank fusion. Local semantic evaluation covers
Japanese, English, Simplified Chinese, Korean, technical identifiers, stale
vectors, scope boundaries, and query-cache privacy.

Run the deterministic suite with `npm run test:evaluation`. Run the installed
model probe with `node scripts/run-local-embedding-smoke.mjs --offline` when a
verified local model directory is available.
