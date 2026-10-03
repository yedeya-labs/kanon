# Test database

The fixture's test-database declaration (`K-LAYOUT-16`): its project-setup hook starts its database, as the reference adopter's does.

**Test database:** `hook`

When a lane passes the hook `database: 'true'`, the hook starts Postgres, waits until it is ready, and writes `DATABASE_URL`.
