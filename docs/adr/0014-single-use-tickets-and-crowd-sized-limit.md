# 0014. Single-use submission tickets and a crowd-sized per-client limit

- Status: accepted (amends [ADR 0013](0013-transient-client-rate-limit.md))
- Date: 2026-10-14

## Context
The phase-1 review ([docs/reviews/2026-10-14-phase-1.md](../reviews/2026-10-14-phase-1.md)) found two problems with ADR 0013's design that pull against each other:

- The ticket (load time signed with a per-process key) never expired and could be reused, so one page load could submit until the per-client limit stopped it ([#60](https://github.com/seandavi/plainfeedback/issues/60)).
- The per-client default, 30 submissions per 10 minutes, rejected most of a conference crowd that shared one Wi-Fi address, and the 429 carried no `Retry-After` ([#55](https://github.com/seandavi/plainfeedback/issues/55)).

Raising the limit alone would make ballot stuffing with one ticket cheaper, so the two changes go together.

## Decision
- A ticket is `time.nonce.signature`: the GET's time and 12 random bytes, HMAC-signed with the per-process key over `publicId.time.nonce`. The nonce keeps two page loads in the same millisecond apart.
- A ticket stores at most one response and expires 24 hours after it was issued. A reused, expired, forged or foreign ticket gets `409` with a participant-facing message. The page then fetches the survey again, which gives it a fresh ticket, shows the message and keeps the answers; the participant submits again.
- A ticket is claimed only when its response is inserted. A `422` or `429` leaves it usable, and a failed insert releases it. The used-ticket check and the claim run with no `await` between them, so two concurrent requests with one ticket store one response.
- Used tickets are kept in memory, keyed by signature, until 24 hours after use, then swept. This is per process, like the rate limits. A restart clears the set but also replaces the signing key, so no old ticket becomes valid again. Several instances would need a `used_tickets` table.
- The per-client default rises to 300 submissions per survey and address per 10 minutes (`RATE_LIMIT_CLIENT_MAX`, still configurable). The per-survey bucket is unchanged.
- Both 429s send `Retry-After` (seconds until the next slot). The page waits it out and resends by itself, up to three times, when the wait is 30 s or less.
- The first participant POST from a loopback or private peer without `TRUST_PROXY` logs one warning (no address), because the per-client limit is then off.

## Consequences
- One page load stores one response. A careless double submit or a replayed request no longer adds rows.
- This is friction, not a cap. A script can GET a fresh ticket for every POST (the GET is not rate limited) and wait the 3 s minimum, so one address can still store up to 300 responses per survey per 10 minutes, and many addresses can reach the per-survey ceiling. Only per-participant codes ([ADR 0004](0004-anonymous-link-only-v1.md), deferred) close that. Owners deleting spam by time ([#36](https://github.com/seandavi/plainfeedback/issues/36)) stays the backstop.
- A participant who keeps a page open for more than 24 hours, or across a server restart, is asked to submit again; the answers stay on the page.
- Memory for used tickets is bounded by accepted responses in 24 hours (at most the per-survey rate times 24 hours per survey).
