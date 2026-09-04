# Kiokuko sample database

`kiokuko-ai.sqlite` is a deterministic, synthetic CI fixture. It contains:

- project-scoped memory entries, including Unicode and multiline text;
- global memory entries;
- one imported external-skill snapshot and its entry mappings.

The fixture is generated from the current `001_initial.sql` and
`002_non_blocking_orchestration.sql` migrations (`PRAGMA user_version = 2`). CI copies it into an isolated
application-data directory, verifies that setup applies no migration, then checks
the data through `kiokuko-ai doctor` and a real `kiokuko-ai web` process.

Regenerate it after intentionally changing the fixture or its baseline:

```sh
npm run sampledb:generate
```

Do not run `kiokuko-ai setup` or `kiokuko-ai web` directly against the committed
fixture. Use `npm run test:sampledb`, which works on a temporary copy.
