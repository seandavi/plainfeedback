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
      { line: 2, column: 15, message: expect.stringMatching(/Can't read the attributes/) },
    ]);
  });

  test("collects several errors in line order", () => {
    const lines = errorsOf("# T\n::: {.radio #a}\nQ\n:::\n::: {.text}\nQ\n:::\n").map(
      (e) => e.line,
    );
    expect(lines).toEqual([2, 5]);
  });
});
