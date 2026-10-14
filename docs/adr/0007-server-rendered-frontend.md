# 0007. Server-rendered Jinja2 templates with small vanilla JS

- Status: accepted
- Date: 2026-10-14

## Context
The participant page and markdown editor are small. A node build step adds tooling, supply-chain surface and CI cost for little gain, and the participant page should work with minimal JS and no cookies.

## Decision
Render the participant page and editor with server-side Jinja2 templates plus small hand-written vanilla JS served as static files. No node, npm or bundler. If a rich component is later needed, vendor a single pinned file.

## Consequences
Single-language build and one Docker image. Live preview and the renderer are plain JS modules, tested separately if they grow. Revisit (new ADR) if the editor outgrows this.
