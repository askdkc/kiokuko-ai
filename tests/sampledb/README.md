# Kiokuko sample database

The fixture source is `tests/fixtures/sample-database.ts`. It generates a
deterministic SQLite database containing synthetic project memory (including
Unicode and multiline text), global memory, and an external-skill snapshot.
Generated databases are not committed.

Run the CLI and Web API checks against a freshly generated temporary database:

```sh
npm run test:sampledb
```

The test uses all current migrations, verifies that setup applies no additional
migration, checks doctor and a real Web process, and removes its temporary files.
The integration suite also compares two independent generations byte for byte.

To keep a database for manual inspection, supply an explicit destination:

```sh
npm run sampledb:generate -- /tmp/kiokuko-sample.sqlite
```

Remove that file when finished. There is no default repository output path.
