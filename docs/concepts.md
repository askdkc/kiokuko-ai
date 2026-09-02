# Concepts

## RAG and memory lifecycle

Kiokuko uses retrieval-augmented generation (RAG): before work, the MCP server
searches stored entries and delivers only relevant context; after work, useful
decisions, results, and lessons can be checkpointed. Retrieval is advisory, so the
current repository and execution evidence always win.

Entries move through a lifecycle of capture, validation, retrieval, review, and
optional promotion. Secret-shaped content is rejected. A checkpoint is not proof
that a memory is correct; it is a candidate for later reuse.

## Scopes

- **Project**: knowledge for one repository.
- **Ecosystem**: knowledge reusable for matching language, framework, database, or runtime constraints.
- **Global**: explicitly generalized knowledge that does not depend on one project.

Tags alone do not leak Project memory into another project. Curator reviews a
candidate before Project knowledge can be promoted to Global.

## Akinator

Akinator is the intake gate. When a request is underspecified, it asks the smallest
question needed to distinguish plausible goals. While intake needs an answer, the
agent must not plan, edit, verify, or checkpoint. Once intake is ready or exhausted,
the normal route can continue and discovered Skills remain reference-only.

## Semantic retrieval

Lexical retrieval is the baseline. Optional local embeddings add semantic signals
without sending memory to a remote provider. See [Semantic retrieval](semantic-retrieval.md).
