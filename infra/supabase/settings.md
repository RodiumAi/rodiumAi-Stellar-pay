# Supabase project settings checklist (context §7.4)

Tick per environment (dev / staging / prod) when the project is created, and re-check before every release.

| Setting                                                                                    | dev | staging | prod |
| ------------------------------------------------------------------------------------------ | --- | ------- | ---- |
| Postgres major matches local (`config.toml` `major_version = 17`)                          | ☐   | ☐       | ☐    |
| SSL enforcement on; clients use `sslmode=verify-full` with the Supabase CA pinned          | ☐   | ☐       | ☐    |
| Network restrictions: only API/worker egress IPs (+ CI for migrations)                     | ☐   | ☐       | ☐    |
| Data API: `pay` not exposed; Data API disabled if unused                                   | ☐   | ☐       | ☐    |
| Auth, Storage, Realtime, Edge Functions unused and unconfigured                            | ☐   | ☐       | ☐    |
| Org: SSO or MFA enforced; minimal members on prod; audit logs reviewed                     | ☐   | ☐       | ☐    |
| `pg_stat_statements` on; slow queries monitored                                            | ☐   | ☐       | ☐    |
| Compute size covers pools (§7.5: 10/API process, 5/worker process, 1 leader session)       | ☐   | ☐       | ☐    |
| Region = AWS region of the service                                                         | ☐   | ☐       | ☐    |
| Pro plan + PITR add-on (prod)                                                              | —   | —       | ☐    |
| `infra/supabase/bootstrap-roles.sql` applied with 32+ byte passwords from the secret store | ☐   | ☐       | ☐    |
| Migrations applied by `rp_owner` (direct or session-mode connection)                       | ☐   | ☐       | ☐    |

## Local development

- `pnpm db:start` runs only the Postgres container (Auth, Storage, etc. excluded) on port 54322.
- `pnpm test:int` creates a throwaway database per run, bootstraps roles and applies migrations.
- Known issue: `GRANT … TO current_user` segfaults the Supabase Postgres image 17.6.1.134; `bootstrap-roles.sql` uses `format()` instead.
