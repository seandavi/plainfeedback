# 0003. Markdown is the source; a JSON model is derived

- Status: accepted
- Date: 2026-10-14

## Context
Creators are not developers; a chat layer and a live-preview editor must edit something readable and diffable.

## Decision
Surveys are authored in markdown (pandoc fenced divs). A parser compiles them to a JSON model that is stored per immutable published version and consumed by the renderer, validator and exporter. Chat edits markdown, never JSON.

## Consequences
The parser and grammar spec are core. Pages and conditionals have reserved slots in the model (`pages`, `visibleIf`) for a later phase.
