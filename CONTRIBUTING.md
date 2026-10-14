# Contributing

1. Find or open an issue first. Larger changes that alter architecture need an ADR (`docs/adr/`, copy `0000-template.md`).
2. Branch from `main`, keep PRs small and focused, link the issue (`Closes #N`).
3. Tests are required. Permission and privacy behavior (cross-group access, anonymity, no cookies, no IP logging) must have tests.
4. CI must be green. PRs merge when green and approved by a maintainer.
5. Participant-facing code must never set cookies or log IPs/user agents. See `docs/design.md#privacy`.

Be kind: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). By contributing you agree your work is MIT-licensed.
