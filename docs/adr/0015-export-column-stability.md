# 0015. Export columns keep their meaning across versions: checked at publish

- Status: accepted
- Date: 2026-10-14

## Context

The default export (no `version=`) is one CSV whose header is the union of column names across all published versions (#52). Likert columns are `<id>_<statement number>` and answers are keyed by statement number (docs/grammar.md). If a statement is inserted, removed or reordered, or an id is reused for a different type, one column silently holds different items for different versions, and any aggregate over it is wrong. Stored answers are fine; only their meaning across versions breaks.

Options considered:

1. **Stable statement identity in the model** (an author key per statement, or keying columns by statement text). Exact, but it changes the answer shape or the grammar, every existing version would need a migration or a fallback, and text-keyed column names are unreadable.
2. **Suffix columns in the exporter** when a name means different things in different versions (`ratings_1__v2`). No author impact, but the column set of an export changes whenever anyone edits, which breaks downstream pipelines without warning.
3. **Refuse at publish** once the survey has responses, with an explicit override.

## Decision

Option 3. `exportChanges(earlier, next)` in `packages/core` lists, in plain language, every change in the new model that would change what an existing column means, compared with **every** earlier version (not just the latest, so dropping statement 3 and later adding a different one is caught):

- a Likert statement at a position that exists in an earlier version has different text (reordered, inserted, removed in the middle, or reworded);
- a reused question id has a different type;
- an option of an earlier version is missing (removed or renamed);
- the Other label of a reused choice/multi question changed: the label is the category written in the main column for Other answers, so renaming it splits that category like an option rename (#95; adding or removing Other stays free);
- a column name of an earlier version is now produced by a different question (v1 has grid `#r`, so `r_1`; v2 has a question `#r_1`) (#95).

Within one version the compiler refuses such collisions outright (an id equal to another question's `<id>_<n>` or `<id>_other`, or `seq`).

Appending statements, adding options and adding or removing questions are free. Changes the latest version already has are not reported again, since they were accepted (forced) when it was published.

`POST .../publish` returns 409 `{error, changes}` when the list is non-empty and the survey has any response; `{"force": true}` publishes anyway. The editor's publish dialog shows the list and offers "Publish anyway". The check is skipped while a survey has no responses, so authors iterate freely before collection.

## Consequences

- A typo fix in a Likert statement after responses exist needs one extra click. That is deliberate: the server cannot tell a typo from a different question.
- After a forced change the CSV still merges by name; docs/api.md tells analysts to check per-version codebooks or export one version at a time. Since #53 every row names its event, survey, wave and version, and the codebook carries the same fields.
- Statement keys (option 1) stay possible as an additive `statementIds?` if authors need to reorder freely; the check would then compare keys instead of positions.
- The phase-2 chat editor (#13) gets the same guard for free, since it publishes through the same route.
