# 0013. Per-client submission limit on a transient, keyed hash of the IP

- Status: accepted; amended by [ADR 0014](0014-single-use-tickets-and-crowd-sized-limit.md) (single-use tickets, per-client default 300, `Retry-After`)
- Date: 2026-10-14

## Context
The participant API had one token bucket per survey and never looked at the client ([ADR 0004](0004-anonymous-link-only-v1.md), [ADR 0011](0011-participant-page.md)). One script could keep that bucket empty, stuff the survey and lock out real participants for the whole event ([#34](https://github.com/seandavi/plainfeedback/issues/34)). Proxy-level per-IP limits help but depend on every deployer configuring them.

Conference attendees often share one NAT or Wi-Fi address, so a per-client limit must be generous or it becomes the lock-out it is meant to prevent.

## Decision
- Keep the per-survey bucket, raised to burst 1000 then 10/s, and add a per-client bucket per survey: 30 submissions per 10 minutes by default. All four numbers are configurable (`RATE_LIMIT_*`).
- The client key is HMAC-SHA256(address, key), where the key is random, generated in the process, held only in memory and replaced every 24 hours (the buckets are cleared with it). IPv6 addresses are cut to their /64. The address and the key are never stored or logged.
- The address is the TCP peer. `X-Forwarded-For` (rightmost entry) or `CF-Connecting-IP` is read only when `TRUST_PROXY` names it. A loopback or private peer without `TRUST_PROXY` (the app behind a local proxy) gets no per-client limit, because every participant would share that address.
- Two identity-free bot deterrents: a hidden honeypot field, and a minimum of 3 s between loading the survey and submitting. The page load gets a ticket (the time, HMAC-signed with a per-process key). Submissions that fill the honeypot or come too early get `201` and are not stored. A bad or missing signature is `409` (reload), so a restart costs a reload, not answers. The page waits out the 3 s itself, so people are never dropped.
- Checks run in this order: per-client limit, bot checks, then the per-survey bucket, so neither a noisy client nor a dropped bot spends the survey's shared budget.

## Consequences
- IP addresses are now processed, transiently and in memory. The default privacy statement and the template say so.
- All limits are per process and reset on restart. Several instances would need shared state (Postgres or Redis).
- A determined abuser with many addresses (botnet, IPv6 /48s) still reaches the per-survey ceiling. Owners deleting spam by time ([#36](https://github.com/seandavi/plainfeedback/issues/36)) is the backstop; there is no per-survey response cap.
- Wrong `TRUST_PROXY` settings either make everyone one client (too strict) or let clients pick their own key (no limit). [deploy.md](../deploy.md) explains how to choose.
