# Context body and relation delivery

Memory recall and task context default to **16,000 Unicode code points**, not tokens
or UTF-16 code units. Explicit body budgets and item limits take precedence. Each
existing bounded context lane keeps its own budget; the entire task/tool response
also contains bounded protocol, policy and diagnostic fields. Increasing a body
budget does not override an item limit or change ranking.

The separate relation envelope defaults to **8,000 Unicode code points** and
**128 edges**. These are adjustable finite defaults, not experimentally established
optima. `KIOKUKO_RELATION_CHARACTER_BUDGET` accepts 1–100000 and
`KIOKUKO_RELATION_EDGE_CAP` accepts 1–1024. Invalid settings, or a budget unable to
fit the explicit status, fail visibly. Internal callers may pass
`relationCharacterBudget` and `relationEdgeCap`; explicit options take precedence.

```json
{"scope":"provided_items","status":"complete","edges":[{"from":{"workspace":"project:example","entryId":"a"},"to":{"workspace":"project:example","entryId":"b"},"type":"contradicts"}],"selectionOmissions":[]}
```

This object is returned as `relationDelivery`. The relation budget counts
`Array.from(JSON.stringify({relationDelivery})).length`: the complete compact JSON
envelope, including the outer `relationDelivery` property name and braces, status,
endpoints and selection reasons. The remaining tool/CLI response and MCP transport framing are excluded. Transport escaping
is decoded before the model sees the text; it is not charged twice. Model text uses
compact JSON, matching the structured representation.

Every delivered memory keeps its model-visible workspace and entry ID. Edges retain
`supports`, `contradicts`, `derived_from` or `related_to` and their stored direction.
Both endpoints must belong to the final provided item set. Relations never add an
undelivered item, change ranking, infer a new relationship or create a taxonomy store.

`complete` means only that all target stored links between those final items were
provided from the read/captured snapshot. It proves neither truth nor freshness,
and says nothing about links to items outside that set. A stored context is still
historical evidence. Item-limit, body-budget and final-filter exclusions appear as
`item_limit`, `body_budget` and `final_filter` in `selectionOmissions`; reaching an
item cap is reported conservatively even when additional matches are unknown.

The statuses `omitted_budget`, `omitted_edge_cap`, `omitted_unknown_type` and
`omitted_legacy` always have an empty edge array. Known support is never delivered
while a coexisting contradiction is silently dropped to fit. Old context without
reconstructable relation metadata is `omitted_legacy`, not a complete empty graph.
After final item removal, a complete superset can be restricted to the remaining
items with `final_filter` recorded. A previously omitted envelope cannot become
complete merely because items were removed; it requires a fresh stored-link read.

SQLite reads check endpoint identity/revision and links in one statement snapshot.
Endpoint-pair index seeks bound internal work to at most n² pairs (n ≤ 1000), rather
than scanning an unbounded adjacency list. cap+1 limits materialized edges and detects
overflow; SQL LIMIT alone is not treated as a bound on internal scan work. A concurrent
revision change detected at the final presentation boundary produces a conflict.

The reported cloud pilot used twelve synthetic tasks, one run per condition: 8k
6/12, 8k plus relations 9/12, and 16k/32k plus relations 12/12. The latter inputs
were identical because the tasks fit 16k. This is limited evidence for a default,
not a general optimum or a local reproduction. No model-effectiveness claim follows
from mocked model tests or structural retrieval tests.

When answering an existing task, omission reuses its saved body budget; an explicit
value must match. Reviewed replay previews distinguish `proposalId`/`proposalRevision`
from the stored `entryId`/`revision` used by relation endpoints. Approval does not
prove task verification.
