import { describe, expect, test } from "vitest";
import { validateAnswers } from "./answers";
import { compile } from "./compile";
import type { Survey } from "./model";

const { model } = compile(`# T

::: {.choice #aff required other="Other"}
Affiliation?
- Center
- DCC
:::

::: {.multi #langs}
Languages?
- R
- Python
- Julia
:::

::: {.likert #rate scale="1-5"}
Rate
- One
- Two
:::

::: {.likert #must scale="0-2" required}
Rate all
- One
- Two
:::

::: {.text #why maxlength=5}
Why?
:::

::: {.number #years min=0 max=60}
Years?
:::
`) as { model: Survey };

const valid = { aff: "Center", must: { 1: 0, 2: 2 } };
const check = (answers: Record<string, unknown>) => validateAnswers(model, answers);

describe("validateAnswers", () => {
  test("accepts a minimal valid response", () => {
    expect(check(valid)).toEqual({});
  });

  test("accepts every type with good values", () => {
    expect(
      check({ ...valid, langs: ["R", "Julia"], rate: { 2: 5 }, why: "short", years: 12.5 }),
    ).toEqual({});
  });

  test("required: missing, empty string, whitespace", () => {
    for (const aff of [undefined, null, "", "   "])
      expect(check({ ...valid, aff })).toEqual({ aff: "This question is required." });
  });

  test("choice membership and Other", () => {
    expect(check({ ...valid, aff: "My own lab" })).toEqual({}); // Other text
    expect(check({ ...valid, aff: "x".repeat(501) }).aff).toMatch(/at most 500/);
    expect(check({ ...valid, aff: 3 }).aff).toMatch(/Choose one/);
    expect(check({ ...valid, langs: ["Fortran"] }).langs).toMatch(/Choose/); // no Other on multi
    expect(check({ ...valid, langs: "R" }).langs).toMatch(/Choose/);
    expect(check({ ...valid, langs: ["R", "R"] }).langs).toMatch(/twice/);
  });

  test("likert: keys, range, required means every statement", () => {
    expect(check({ ...valid, rate: { 3: 1 } }).rate).toMatch(/listed statements/);
    expect(check({ ...valid, rate: { 1: 6 } }).rate).toMatch(/1 to 5/);
    expect(check({ ...valid, rate: { 1: 2.5 } }).rate).toMatch(/whole numbers/);
    expect(check({ ...valid, rate: [3] }).rate).toMatch(/Rate the statements/);
    expect(check({ ...valid, rate: {} })).toEqual({}); // optional grid, nothing rated
    expect(check({ ...valid, must: { 1: 1 } }).must).toMatch(/every statement/);
    expect(check({ ...valid, must: { 1: 1, 2: null } }).must).toMatch(/every statement/);
  });

  test("text maxlength and type", () => {
    expect(check({ ...valid, why: "toolong" }).why).toMatch(/at most 5/);
    expect(check({ ...valid, why: 5 }).why).toMatch(/Enter text/);
  });

  test("number bounds and type", () => {
    expect(check({ ...valid, years: -1 }).years).toMatch(/at least 0/);
    expect(check({ ...valid, years: 61 }).years).toMatch(/at most 60/);
    expect(check({ ...valid, years: "12" }).years).toMatch(/Enter a number/);
    expect(check({ ...valid, years: Number.NaN }).years).toMatch(/Enter a number/);
  });

  test("rejects answers to questions that don't exist", () => {
    expect(check({ ...valid, nope: "x" })).toEqual({
      nope: "This is not a question in this survey.",
    });
  });
});
