# Ledger

The semantic ledger stores AMCA-accepted event history. It is not absolute
external-world truth.

## Local Ledger

`@amca/ledger-local` stores accepted run events in local artifacts and validates
ordering and hashes through the ledger contract.

## Postgres Ledger

`@amca/ledger-postgres` implements the semantic ledger contract against a
Postgres query-client boundary. Live integration tests require an explicitly
configured test database URL:

```bash
AMCA_LEDGER_POSTGRES_TEST_URL=<postgres-url>
```

Production durability certification depends on environment-specific operations,
backup/restore strategy, migration policy, and monitoring.
