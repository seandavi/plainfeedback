# 0008. Hand-written line parser for the survey grammar

- Status: accepted
- Date: 2026-10-14

## Context
The survey grammar ([grammar.md](../grammar.md)) uses pandoc-style fenced divs: `::: {.choice #id required}`. The compiler must run in the browser and in Node, report friendly errors with exact line numbers, and stay small. remark-directive parses a different syntax (`:::name{#id .class}`), so it would need a custom micromark extension. A full markdown parser would also only give us the block structure; prompts and the intro are stored as markdown source and rendered by the web app anyway.

## Decision
`packages/core/src/compile.ts` is a hand-written, line-based parser with no dependencies beyond zod (for the model schema). It recognizes only what the grammar defines: the `#` title, intro text, `:::` blocks with a braced attribute list, list items, and prompt text. Prompts and the intro are kept as markdown source.

## Consequences
- Every error carries a line number (and a column for unreadable attributes), and all errors are reported at once.
- Markdown inside prompts is not interpreted by core. A `:::` line inside a code fence in the intro would be read as a block; acceptable for survey content.
- If the grammar grows beyond line-oriented constructs (phase 3 expressions are attribute values, so they do not), revisit this.
