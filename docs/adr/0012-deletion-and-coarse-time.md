# 0012. Hard deletion through cascades; submission time to the hour

- Status: accepted
- Date: 2026-10-14

## Context

Nothing in the API deleted participant data (#36), so a retention promise could not be kept and spam could not be removed. Published survey versions are immutable (ADR 0003), enforced by a trigger that rejected every UPDATE, DELETE and TRUNCATE on `survey_versions`. Separately, `submitted_at` was stored and exported to the microsecond, which joins with proxy logs or sign-in sheets (#37), and the export cursor depended on that precision.

## Decision

- Deletion is real (no soft delete). Foreign keys from `responses`, `survey_versions`, `surveys`, `events`, `memberships` and `api_tokens` up to their parent use `ON DELETE CASCADE`.
- The immutability trigger allows a DELETE on `survey_versions` only when the parent `surveys` row no longer exists, which is true only inside the cascade from a survey delete. Ad-hoc DELETE, UPDATE and TRUNCATE still raise. No session flag is needed, so nothing can leak across pooled connections.
- Routes, with the usual 404/403 rules (ADR 0009) and 409 in an archived group:
  - owner: delete one response by id, or all of a survey's responses (optionally `before` a time), delete a survey, delete an event;
  - creator: delete a survey that was never published (row lock shared with publish, so no race);
  - admin: delete a group, only once archived.
- `submitted_at` is truncated to the hour by the column default, and a CHECK constraint refuses anything finer. Existing rows were truncated by the migration.
- A global identity column `responses.seq` orders the export and is its resume cursor (`since=<seq>`). An ISO `since` remains a coarse filter. The old `<submittedAt>_<responseId>` cursor is rejected.
- Automated retention is not built; it is an owner/operator responsibility (#47). Aggregate views must suppress small cells when they exist (#46).

## Consequences

- Backups keep deleted data until they rotate ([deploy.md](../deploy.md#backups)).
- `seq` reveals exact submission order within an hour, and because it is global, gaps hint at how many responses other surveys received in between. This is accepted: viewers already see their own survey's rows, and the volume signal is coarse.
- Analysts lose sub-hour timing (e.g. spotting bursts within an hour); `seq` still shows order.
- To purge data in an archived group an owner un-archives it first.
