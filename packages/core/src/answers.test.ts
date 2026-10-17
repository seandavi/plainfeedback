import { describe, expect, test } from "vitest";
import { normalizeAnswers, validateAnswers } from "./answers";
import { compile } from "./compile";
import type { Survey } from "./model";

const { model } = compile(`# T

::: {.choice #aff required other="Other"}
Affiliation?
- Center
- DCC
:::

::: {.multi #langs other}
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
- **Two**
- [Three](https://example.org)
- Four
- Five
:::

::: {.text #why maxlength=5}
Why?
:::

::: {.number #years min=0 max=60}
Years?
:::
`) as { model: Survey };

const valid = { aff: "Center", must: { 1: 0, 2: 2, 3: 1, 4: 1, 5: 1 } };
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

  test("required: missing", () => {
    for (const aff of [undefined, null])
      expect(check({ ...valid, aff })).toEqual({ aff: "This question is required." });
  });

  test("Other picked but left blank names the Other box, required or not (#67)", () => {
    const msg = 'Please describe "Other", or pick another option.';
    for (const aff of ["", "   "]) expect(check({ ...valid, aff })).toEqual({ aff: msg });
    expect(check({ ...valid, langs: ["R", " "] })).toEqual({ langs: msg });
  });

  test("choice membership and Other", () => {
    expect(check({ ...valid, aff: "My own lab" })).toEqual({}); // Other text
    expect(check({ ...valid, aff: "x".repeat(501) }).aff).toMatch(/at most 500/);
    expect(check({ ...valid, aff: 3 }).aff).toMatch(/Choose one/);
    expect(check({ ...valid, langs: ["Fortran", "Cobol"] }).langs).toMatch(/Choose/); // one Other
    expect(check({ ...valid, langs: "R" }).langs).toMatch(/Choose/);
    expect(check({ ...valid, langs: ["R", "R"] }).langs).toMatch(/twice/);
  });

  test("likert: keys, range, required means every statement", () => {
    expect(check({ ...valid, rate: { 3: 1 } }).rate).toMatch(/listed statements/);
    expect(check({ ...valid, rate: { 1: 6 } }).rate).toMatch(/1 to 5/);
    expect(check({ ...valid, rate: { 1: 2.5 } }).rate).toMatch(/whole numbers/);
    expect(check({ ...valid, rate: [3] }).rate).toMatch(/Rate the statements/);
    expect(check({ ...valid, rate: {} })).toEqual({}); // optional grid, nothing rated
    expect(check({ ...valid, must: { 1: 1, 3: 1, 4: 1, 5: 1 } }).must).toBe(
      "Please rate every statement (1 not rated: Two).",
    );
    expect(check({ ...valid, must: { 1: 1, 2: null, 4: 1, 5: 1 } }).must).toBe(
      "Please rate every statement (2 not rated: Two; Three).",
    );
    expect(check({ ...valid, must: undefined }).must).toBe(
      "Please rate every statement (5 not rated: One; Two; Three and 2 more).",
    );
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

  test("prototype keys are treated as data", () => {
    const sent = JSON.parse(
      '{"__proto__": "x", "aff": "Center", "must": {"1": 0, "2": 2, "3": 1, "4": 1, "5": 1}}',
    );
    expect(Object.keys(check(sent))).toEqual(["__proto__"]);
    const { model: m } = compile("# T\n::: {.text #constructor}\nQ\n:::\n") as { model: Survey };
    expect(validateAnswers(m, {})).toEqual({});
  });

  test("rejects answers to questions that don't exist", () => {
    expect(check({ ...valid, nope: "x" })).toEqual({
      nope: "This is not a question in this survey.",
    });
  });
});

describe("normalizeAnswers (#75)", () => {
  test("trims, drops empties and unrated statements, keeps real answers", () => {
    expect(
      normalizeAnswers({
        aff: "  Center ",
        langs: ["R", " ", "Python "],
        rate: { 1: null, 2: 4 },
        must: { 1: null },
        why: "   ",
        years: 0,
        a: null,
        b: "",
        c: [],
        d: {},
      }),
    ).toEqual({ aff: "Center", langs: ["R", "Python"], rate: { 2: 4 }, years: 0 });
  });

  test("validating the normalised form catches an Other text that duplicates an option", () => {
    const m = compile(`# T\n\n::: {.multi #x other="Other"}\nQ\n- A\n- B\n:::\n`).model as Survey;
    expect(validateAnswers(m, normalizeAnswers({ x: ["A", " A "] }))).toEqual({
      x: "An option is chosen twice.",
    });
  });

  test("a __proto__ key stays an own key", () => {
    const n = normalizeAnswers(JSON.parse('{"__proto__": "x"}'));
    expect(Object.keys(n)).toEqual(["__proto__"]);
  });
});

describe("option values (#122)", () => {
  const valued = (other: string) =>
    compile(`# T

::: {.choice #c ${other}}
Q
- Very satisfied {value=5}
- Meh {value=3}
:::

::: {.multi #m ${other}}
Q
- A {value=a}
- B {value=b}
:::
`).model as Survey;

  test("values are accepted, labels are not", () => {
    const m = valued("");
    expect(validateAnswers(m, { c: "5", m: ["a", "b"] })).toEqual({});
    expect(validateAnswers(m, { c: "Very satisfied" })).toEqual({
      c: "Choose one of the options.",
    });
    expect(validateAnswers(m, { m: ["A"] })).toEqual({ m: "Choose one of the options." });
  });

  test("with Other, a label is Other text", () => {
    const m = valued("other");
    expect(validateAnswers(m, { c: "Very satisfied", m: ["a", "A"] })).toEqual({});
  });
});

describe("dropdown (#123)", () => {
  const src = (flags: string) =>
    `# T\n\n::: {.choice #c ${flags}}\nQ\n- Very satisfied {value=5}\n- Meh {value=3}\n:::\n`;
  test("validates exactly like the radio version", () => {
    for (const flags of ["", "other", "required other"]) {
      const radios = compile(src(flags)).model as Survey;
      const dropdown = compile(src(`${flags} dropdown`)).model as Survey;
      for (const a of [{ c: "5" }, { c: "Very satisfied" }, { c: "Visitor" }, { c: " " }, {}])
        expect(validateAnswers(dropdown, a)).toEqual(validateAnswers(radios, a));
    }
    const plain = compile(src("dropdown")).model as Survey;
    expect(validateAnswers(plain, { c: "5" })).toEqual({});
    expect(validateAnswers(plain, { c: "Very satisfied" })).toEqual({
      c: "Choose one of the options.",
    });
  });
});
