# 0011. Participant page: random public id and a hand-rolled markdown renderer

- Status: accepted
- Date: 2026-10-14

## Context
Issue #7 adds the public survey page. design.md sketched `/s/{event}/{survey}`, but survey slugs are only unique per event, event slugs only per group, and slugs leak event names. Prompts and intros are markdown that the browser must render without allowing HTML or third-party requests.

## Decision
- Each survey gets `public_id`: 12 lowercase Crockford base32 characters (60 bits) from WebCrypto, unique, generated on insert by the app. The migration backfills existing rows with 12 random hex characters from `gen_random_uuid()`. The URL is `/s/{publicId}`; it stays the same across versions.
- The page always serves the latest published version. A submit names its `versionId`; a stale one gets 409 and the client reloads (answers are kept by question id).
- Not-yet-open submits are 403 (425 means TLS early data). Closed is 410.
- Rate limiting is a per-survey in-memory token bucket, keyed after lookup so unknown ids cannot grow it. It knows nothing about the client. Fine for one process; move it to Postgres or Redis if the app is scaled out.
- Participant responses carry `Content-Security-Policy: default-src 'self'` (plus no-store, no Set-Cookie), so the browser itself refuses third-party requests.
- Markdown: a ~60-line renderer in `apps/web/src/markdown.tsx` that builds React elements (paragraphs, flat lists, bold, italic, code, links). It never produces an HTML string, so raw HTML is shown as text and no sanitizer is needed. Links are `http(s):`/`mailto:` only, `target=_blank rel="noopener noreferrer nofollow"`. Images show their alt text. A library (markdown-it with `html: false`) would be the upgrade if authors need tables or nesting.
- `<SurveyForm model mode="live|preview" onSubmit>` is the reusable renderer; the editor (#8) uses `preview`.

## Consequences
- Old `/s/{event}/{survey}` links never existed, so nothing breaks. A leaked link can be revoked only by closing the survey (a "rotate public id" action can come later).
- The web bundle includes zod via `@plainfeedback/core` (~100 KB gzipped total). Acceptable for now.
