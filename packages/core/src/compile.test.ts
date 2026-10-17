import { describe, expect, test } from "vitest";
import grammarDoc from "../../../docs/grammar.md?raw";
import { compile } from "./compile";
import cfdeModel from "./fixtures/cfde-fall-2026.json?raw";
import cfdeSource from "./fixtures/cfde-fall-2026.md?raw";
import { surveySchema } from "./model";

describe("golden files", () => {
  const source = cfdeSource;

  test("CFDE Fall 2026 form compiles to the expected model", () => {
    const result = compile(source);
    expect(result.errors).toBeUndefined();
    expect(result.model).toEqual(JSON.parse(cfdeModel));
    expect(() => surveySchema.parse(result.model)).not.toThrow();
  });

  test("docs/grammar.md shows the same CFDE example", () => {
    expect(grammarDoc).toContain(source.trim());
  });

  test("CRLF line endings compile the same", () => {
    expect(compile(source.replace(/\n/g, "\r\n"))).toEqual(compile(source));
  });
});

const errorsOf = (md: string) => compile(md).errors ?? [];

describe("grammar", () => {
  test("choice, multi, number and defaults", () => {
    const { model } = compile(`# T

::: {.multi #langs other}
Which languages?
* R
* Python
:::

::: {.number #years min=0 max=60 required}
Years of experience?
:::

::: {.text #name}
Name
:::

::: {.likert #pace scale="0-10"}
How was the pace?
- Pace
:::
`);
    expect(model?.intro).toBeUndefined();
    expect(model?.pages[0]?.questions).toEqual([
      {
        id: "langs",
        prompt: "Which languages?",
        required: false,
        type: "multi",
        options: ["R", "Python"],
        other: "Other",
      },
      {
        id: "years",
        prompt: "Years of experience?",
        required: true,
        type: "number",
        min: 0,
        max: 60,
      },
      {
        id: "name",
        prompt: "Name",
        required: false,
        type: "text",
        maxlength: 2000,
        multiline: false,
      },
      {
        id: "pace",
        prompt: "How was the pace?",
        required: false,
        type: "likert",
        statements: ["Pace"],
        scale: { min: 0, max: 10 },
        anchors: {},
      },
    ]);
  });

  test("wrapped list items join; prompt keeps paragraphs", () => {
    const { model } = compile(`# T

::: {.choice #a}
First paragraph.

Second **paragraph**.

- A long option
  that wraps
- B
:::
`);
    const q = model?.pages[0]?.questions[0];
    expect(q?.prompt).toBe("First paragraph.\n\nSecond **paragraph**.");
    expect(q?.type === "choice" && q.options).toEqual(["A long option that wraps", "B"]);
  });
});

describe("errors carry line numbers", () => {
  const cases: [string, string, number, RegExp][] = [
    ["missing title", "Hello\n", 1, /starts with its title/],
    ["empty", "", 1, /empty/],
    ["questions without title", "::: {.text #a}\nQ\n:::\n", 1, /starts with its title/],
    [
      "unknown type",
      "# T\n\n::: {.radio #a}\nQ\n- x\n- y\n:::\n",
      3,
      /Unknown question type '\.radio'/,
    ],
    ["no type", "# T\n::: {#a}\nQ\n:::\n", 2, /Give the question a type/],
    ["two types", "# T\n::: {.text .number #a}\nQ\n:::\n", 2, /only have one type/],
    ["missing id", "# T\n::: {.text}\nQ\n:::\n", 2, /Give the question an id/],
    ["bad id", "# T\n::: {.text #Bad!}\nQ\n:::\n", 2, /isn't valid/],
    [
      "duplicate id",
      "# T\n::: {.text #a}\nQ\n:::\n::: {.text #a}\nQ\n:::\n",
      5,
      /already used on line 2/,
    ],
    [
      "id equals another question's likert column, defined first (#95)",
      "# T\n::: {.text #r_1}\nQ\n:::\n::: {.likert #r}\nQ\n- s\n:::\n",
      2,
      /'#r_1' is also an export column of '#r' \(line 5\)/,
    ],
    [
      "id equals another question's Other column (#95)",
      '# T\n::: {.choice #c other="O"}\nQ\n- x\n- y\n:::\n::: {.text #c_other}\nQ\n:::\n',
      7,
      /'#c_other' is also an export column of '#c'/,
    ],
    ["reserved seq id", "# T\n::: {.text #seq}\nQ\n:::\n", 2, /'#seq' is reserved/],
    ["empty other", '# T\n::: {.choice #a other=""}\nQ\n- x\n- y\n:::\n', 2, /needs a label/],
    ["missing options", "# T\n::: {.choice #a}\nQ\n- only\n:::\n", 2, /at least two options/],
    [
      "duplicate option",
      "# T\n::: {.choice #a}\nQ\n- x\n- x\n:::\n",
      5,
      /repeats the one on line 4/,
    ],
    ["';' in multi option", "# T\n::: {.multi #a}\nQ\n- x\n- a; b\n:::\n", 5, /can't contain ';'/],
    [
      "';' in multi other",
      '# T\n::: {.multi #a other="x; y"}\nQ\n- x\n- y\n:::\n',
      2,
      /can't contain ';'/,
    ],
    [
      "bad scale",
      '# T\n::: {.likert #a scale="five"}\nQ\n- s\n:::\n',
      2,
      /scale "five" isn't valid/,
    ],
    ["reversed scale", '# T\n::: {.likert #a scale="5-1"}\nQ\n- s\n:::\n', 2, /low to high/],
    ["huge scale", '# T\n::: {.likert #a scale="0-20"}\nQ\n- s\n:::\n', 2, /too many points/],
    [
      "mid on even scale",
      '# T\n::: {.likert #a scale="1-4" mid="m"}\nQ\n- s\n:::\n',
      2,
      /no middle/,
    ],
    ["no statements", "# T\n::: {.likert #a}\nQ\n:::\n", 2, /at least one statement/],
    ["no prompt", "# T\n::: {.text #a}\n:::\n", 2, /no prompt/],
    [
      "unknown attribute",
      "# T\n::: {.text #a maxlenght=5}\nQ\n:::\n",
      2,
      /'maxlenght' doesn't apply/,
    ],
    ["bad number", "# T\n::: {.number #a min=x}\nQ\n:::\n", 2, /'min' must be a number/],
    ["min > max", "# T\n::: {.number #a min=5 max=1}\nQ\n:::\n", 2, /'min' must not be larger/],
    ["bad maxlength", "# T\n::: {.text #a maxlength=0}\nQ\n:::\n", 2, /whole number/],
    ["required with value", "# T\n::: {.text #a required=yes}\nQ\n:::\n", 2, /on its own/],
    ["list in text", "# T\n::: {.text #a}\nQ\n- x\n:::\n", 4, /doesn't take a list/],
    ["show-if", '# T\n::: {.text #a show-if="b == 1"}\nQ\n:::\n', 2, /not supported yet/],
    ["unclosed", "# T\n\n::: {.text #a}\nQ\n", 3, /never closed/],
    ["nested", "# T\n::: {.text #a}\n::: {.text #b}\n:::\n", 3, /can't contain another/],
    ["stray close", "# T\n:::\n", 2, /doesn't close any/],
    ["no braces", "# T\n::: text\nQ\n:::\n", 2, /in braces/],
    ["second title", "# T\n# U\n", 2, /Only one title/],
    ["pages", "# T\n---\n", 2, /pages .* not supported yet/],
    ["h2", "# T\n## Part 2\n", 2, /pages .* not supported yet/],
    [
      "text after questions",
      "# T\n::: {.text #a}\nQ\n:::\nstray\n",
      5,
      /between or after questions/,
    ],
  ];
  test.each(cases)("%s", (_, md, line, message) => {
    const errors = errorsOf(md);
    expect(errors).toContainEqual(
      expect.objectContaining({ line, message: expect.stringMatching(message) }),
    );
  });

  test("unreadable attributes report a column", () => {
    expect(errorsOf('# T\n::: {.text #a key="open}\nQ\n:::\n')).toEqual([
      { line: 2, column: 15, message: expect.stringMatching(/Can't read the settings/) },
    ]);
  });

  // #73, #51: common paste and editing mistakes give one clear error each, with no follow-ons.
  const single: [string, string, number, RegExp][] = [
    [
      "curly quotes around a phrase",
      "# T\n::: {.likert #a low=“Not at all” high=“Very”}\nQ\n- s\n:::\n",
      2,
      /Curly quotes/,
    ],
    [
      "curly quotes around one word",
      "# T\n::: {.choice #a other=“Other”}\nQ\n- x\n- y\n:::\n",
      2,
      /Curly quotes/,
    ],
    ["missing closing brace", "# T\n::: {.text #elab\nQ\n:::\n", 2, /braces are not closed/],
    ["no braces swallows its block", "# T\n::: .text #a\nQ\n:::\n", 2, /in braces/],
    [
      "unindented option continuation",
      "# T\n::: {.choice #a}\nQ\n- one long\noption\n:::\n",
      5,
      /isn't indented/,
    ],
    [
      "unindented likert continuation",
      "# T\n::: {.likert #a}\nQ\n- one long\nstatement\n:::\n",
      5,
      /isn't indented/,
    ],
    ["pasted bullets", "# T\n::: {.choice #a}\nQ\n• x\n- y\n:::\n", 4, /Pasted bullets/],
    [
      "question inserted above the title",
      "::: {.text #a}\nQ\n:::\n# T\n\nIntro text.\n\n::: {.text #b}\nQ\n:::\n",
      4,
      /title must be the first line \(found on line 4\)/,
    ],
    ["text above the title", "Hello\n\n# T\n", 3, /title must be the first line/],
    ["no title at all", "Hello\n::: {.text #a}\nQ\n:::\n", 1, /starts with its title/],
  ];
  test.each(single)("%s: exactly one error", (_, md, line, message) => {
    expect(errorsOf(md)).toEqual([
      expect.objectContaining({ line, message: expect.stringMatching(message) }),
    ]);
  });

  test("a prompt line starting with a dash is still prompt text", () => {
    expect(errorsOf("# T\n::: {.text #a}\nComments?\n— optional\n:::\n")).toEqual([]);
  });

  test("curly quotes inside straight-quoted values and in prose are fine", () => {
    const { model } = compile(
      '# “T”\n\nIt’s short.\n\n::: {.likert #a low="He said “hi”"}\nHow’s it?\n- s\n:::\n',
    );
    expect(model?.title).toBe("“T”");
    expect(model?.pages[0]?.questions[0]).toMatchObject({ anchors: { low: "He said “hi”" } });
  });

  test("errors after a curly-quote block are still reported", () => {
    const md = "# T\n::: {.text #a low=“x”}\nQ\n:::\n::: {.choice #b}\nQ\n- only\n:::\n";
    expect(errorsOf(md).map((e) => e.line)).toEqual([2, 5]);
  });

  test("collects several errors in line order", () => {
    const lines = errorsOf("# T\n::: {.radio #a}\nQ\n:::\n::: {.text}\nQ\n:::\n").map(
      (e) => e.line,
    );
    expect(lines).toEqual([2, 5]);
  });
});

describe("option values (#122)", () => {
  test("valued and mixed lists; label is the default value", () => {
    const { model, errors } = compile(`# T

::: {.choice #sat}
How satisfied?
- Very satisfied {value=5}
- Neutral {value="3"}
- Not sure
:::
`);
    expect(errors).toBeUndefined();
    expect(model?.pages[0]?.questions[0]).toMatchObject({
      options: ["Very satisfied", "Neutral", "Not sure"],
      values: ["5", "3", "Not sure"],
    });
  });

  test("no values key without {value=}; literal braces stay label text", () => {
    const q = compile("# T\n\n::: {.multi #l}\nQ\n- Python {3}\n- R\n:::\n").model?.pages[0]
      ?.questions[0];
    expect(q).toMatchObject({ options: ["Python {3}", "R"] });
    expect(q).not.toHaveProperty("values");
  });

  test("a value on a wrapped continuation line", () => {
    const q = compile("# T\n\n::: {.choice #c}\nQ\n- A long\n  label {value='a'}\n- B\n:::\n").model
      ?.pages[0]?.questions[0];
    expect(q).toMatchObject({ options: ["A long label", "B"], values: ["a", "B"] });
  });

  test.each([
    ["- A {x=1}", "'x' doesn't apply to options. Only {value=...} is allowed."],
    ["- A {value=1 value=2}", "The attribute 'value' is given twice."],
    ["- A {value=}", "This option's value is empty. Write it like {value=5}."],
    ['- A {value=""}', "This option's value is empty. Write it like {value=5}."],
    ["- A {value=“1”}", "Curly quotes"],
    ['- A {value="1}', "Can't read the option's settings"],
    ["- A {value=B}", `This option's value "B" repeats the one on line 5.`, 6],
    ["- A {value=Other}", `This option's value "Other" is also the 'other' label.`],
  ])("%s", (item, message, line = 5) => {
    const errs = errorsOf(`# T\n\n::: {.choice #c other}\nQ\n${item}\n- B\n:::\n`);
    expect(errs).toEqual([expect.objectContaining({ line })]);
    expect(errs[0]?.message).toContain(message);
  });

  test("two brace blocks on one option are an error", () => {
    expect(errorsOf("# T\n\n::: {.choice #c}\nQ\n- A {value=1}{value=2}\n- B\n:::\n")).toEqual([
      { line: 5, message: "An option can have only one {value=...}. Remove the extra braces." },
    ]);
  });

  test("a long option compiles in linear time (no ReDoS)", () => {
    for (const item of [`a${" ".repeat(190_000)}b`, `x{${"=".repeat(190_000)}`]) {
      for (const type of ["choice", "likert"]) {
        const start = Date.now();
        compile(`# T\n\n::: {.${type} #c}\nQ\n- ${item}\n- B\n:::\n`);
        expect(Date.now() - start).toBeLessThan(500);
      }
    }
  });

  test("';' in a .multi value, and a value on a .likert statement", () => {
    expect(errorsOf("# T\n\n::: {.multi #c}\nQ\n- A {value='1;2'}\n- B\n:::\n")).toEqual([
      { line: 5, message: "A .multi option's value can't contain ';'." },
    ]);
    expect(errorsOf("# T\n\n::: {.likert #r}\nQ\n- A {value=1}\n:::\n")).toEqual([
      { line: 5, message: "Stored values apply to .choice and .multi options only." },
    ]);
  });

  test("an old model without values still parses (immutability)", () => {
    expect(() => surveySchema.parse(JSON.parse(cfdeModel))).not.toThrow();
    const bad = {
      title: "T",
      pages: [
        {
          questions: [
            {
              id: "c",
              prompt: "Q",
              required: false,
              type: "choice",
              options: ["a", "b"],
              values: ["1", "1"],
            },
          ],
        },
      ],
    };
    expect(() => surveySchema.parse(bad)).toThrow();
  });
});

describe("dropdown (#123)", () => {
  const first = (md: string) => compile(md).model?.pages[0]?.questions[0];

  test("compiles to dropdown: true; absent without the flag", () => {
    expect(first("# T\n\n::: {.choice #inst dropdown}\nQ\n- A\n- B\n:::\n")).toMatchObject({
      type: "choice",
      options: ["A", "B"],
      dropdown: true,
    });
    expect(first("# T\n\n::: {.choice #inst}\nQ\n- A\n- B\n:::\n")).not.toHaveProperty("dropdown");
    expect(JSON.stringify(compile(cfdeSource).model)).not.toContain("dropdown");
  });

  test("works with required, other and option values", () => {
    for (const other of ["other", 'other="Somewhere else"']) {
      const q = first(
        `# T\n\n::: {.choice #inst required dropdown ${other}}\nQ\n- Uni A {value=ua}\n- Uni B\n:::\n`,
      );
      expect(q).toMatchObject({
        required: true,
        dropdown: true,
        options: ["Uni A", "Uni B"],
        values: ["ua", "Uni B"],
        other: other === "other" ? "Other" : "Somewhere else",
      });
      expect(() =>
        surveySchema.parse(compile(`# T\n\n::: {.choice #x dropdown}\nQ\n- A\n- B\n:::\n`).model),
      ).not.toThrow();
    }
  });

  test.each(["multi", "likert", "text", "number"])("'dropdown' on .%s is an error", (type) => {
    const body = type === "likert" ? "\n- A" : type === "multi" ? "\n- A\n- B" : "";
    expect(errorsOf(`# T\n\n::: {.${type} #x dropdown}\nQ${body}\n:::\n`)).toContainEqual({
      line: 3,
      message: `'dropdown' doesn't apply to .${type} questions.`,
    });
  });

  test("dropdown=yes is an error", () => {
    expect(errorsOf("# T\n\n::: {.choice #x dropdown=yes}\nQ\n- A\n- B\n:::\n")).toEqual([
      { line: 3, message: "Write 'dropdown' on its own, without a value." },
    ]);
  });

  test("a hostile attribute line compiles in linear time", () => {
    for (const attrs of ["dropdown ".repeat(40_000), "{".repeat(190_000), "=".repeat(190_000)]) {
      const start = Date.now();
      compile(`# T\n\n::: {.choice #c ${attrs}}\nQ\n- A\n- B\n:::\n`);
      expect(Date.now() - start).toBeLessThan(500);
    }
  });

  test("dropdown on a .multi model is dropped by the schema", () => {
    const m = compile("# T\n\n::: {.multi #x}\nQ\n- A\n- B\n:::\n").model;
    const q = m?.pages[0]?.questions[0] as object;
    const bad = { ...m, pages: [{ questions: [{ ...q, dropdown: true }] }] };
    expect(surveySchema.safeParse(bad).success).toBe(true); // zod strips unknown keys
    expect(surveySchema.parse(bad).pages[0]?.questions[0]).not.toHaveProperty("dropdown");
  });
});

describe("date (#124)", () => {
  const first = (md: string) => compile(md).model?.pages[0]?.questions[0];
  const at3 = (message: string) => [{ line: 3, message }];

  test("compiles; min/max bare or quoted", () => {
    expect(first("# T\n\n::: {.date #d}\nWhen?\n:::\n")).toEqual({
      type: "date",
      id: "d",
      prompt: "When?",
      required: false,
    });
    expect(
      first('# T\n\n::: {.date #d required min=2026-01-01 max="2026-12-31"}\nWhen?\n:::\n'),
    ).toMatchObject({ type: "date", required: true, min: "2026-01-01", max: "2026-12-31" });
  });

  test.each([
    [
      "min=2026-02-30",
      `'min' must be a date written as YYYY-MM-DD, like min=2026-03-15, not "2026-02-30".`,
    ],
    [
      "max=2026/03/15",
      `'max' must be a date written as YYYY-MM-DD, like max=2026-03-15, not "2026/03/15".`,
    ],
    ["min", `'min' needs a value, like min="..."`],
    ["min=2026-03-02 max=2026-03-01", "'min' must not be later than 'max'."],
    ["maxlength=5", "'maxlength' doesn't apply to .date questions."],
    ["dropdown", "'dropdown' doesn't apply to .date questions."],
    ["multiline", "'multiline' doesn't apply to .date questions."],
  ])("%s is an error", (attrs, message) => {
    expect(errorsOf(`# T\n\n::: {.date #d ${attrs}}\nWhen?\n:::\n`)).toEqual(at3(message));
  });

  test("a list is an error", () => {
    expect(errorsOf("# T\n\n::: {.date #d}\nWhen?\n- A\n:::\n")).toEqual([
      { line: 5, message: "A .date question doesn't take a list. Remove the '- ' items." },
    ]);
  });

  test("listed among known types", () => {
    expect(errorsOf("# T\n\n::: {.calendar #d}\nWhen?\n:::\n")[0]?.message).toContain(".date");
  });

  test("a hostile min compiles quickly", () => {
    const start = Date.now();
    expect(
      errorsOf(`# T\n\n::: {.date #d min="${"2026-01-01".repeat(20_000)}"}\nQ\n:::\n`),
    ).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
