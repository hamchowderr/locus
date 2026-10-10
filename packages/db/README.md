# @locus/db

Drizzle schema and migrations for the two kinds of database: the shared **control** database (agencies, staff, the client registry, billing, connections — nothing about any single client beyond its registry row) and one Turso database **per client**. Includes the tenant migration runner, which verifies by hash set because Drizzle's migrator never backfills a skipped migration. Design: vault notes `Locus Data Model` and `Locus Phase 0`.
