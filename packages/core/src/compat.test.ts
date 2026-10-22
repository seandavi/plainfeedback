import { expect, test } from "vitest";
import { columnsFor, exportChanges } from "./compat";
import { compile } from "./compile";
import type { Survey } from "./model";

const m = (body: string) => compile(`# T\n\n${body}`).model as Survey;
const likert = (...s: string[]) =>
  m(`::: {.likert #r}\nRate\n${s.map((x) => `- ${x}`).join("\n")}\n:::\n`);
const choice = (type: string, ...o: string[]) =>
  m(`::: {.${type} #c}\nPick\n${o.map((x) => `- ${x}`).join("\n")}\n:::\n`);

test("free: appending statements or options, adding or removing questions, identical", () => {
  expect(exportChanges([likert("a", "b")], likert("a", "b", "c"))).toEqual([]);
  expect(exportChanges([likert("a", "b")], likert("a"))).toEqual([]);
  expect(exportChanges([choice("choice", "x", "y")], choice("choice", "x", "y", "z"))).toEqual([]);
  expect(exportChanges([likert("a")], m("::: {.text #other}\nQ\n:::\n"))).toEqual([]);
  expect(exportChanges([], likert("a"))).toEqual([]);
});

test("refused: reordered, inserted or reworded likert statements", () => {
  expect(exportChanges([likert("a", "b")], likert("b", "a"))).toHaveLength(2);
  expect(exportChanges([likert("a", "b")], likert("new", "a", "b"))).toEqual([
    `In 'r', statement 1 was "a" and is now "new".`,
    `In 'r', statement 2 was "b" and is now "a".`,
  ]);
});

test("compares with every earlier version, not only the latest", () => {
  // v2 dropped statement 2; v3 puts a different statement there.
  expect(exportChanges([likert("a", "b"), likert("a")], likert("a", "c"))).toEqual([
    `In 'r', statement 2 was "b" and is now "c".`,
  ]);
});

test("a change forced into the latest version is not reported again", () => {
  const v1 = likert("a", "b");
  const v2 = likert("b", "a"); // forced
  expect(exportChanges([v1, v2], likert("b", "a", "c"))).toEqual([]);
  expect(exportChanges([v1, v2], likert("a", "b"))).toHaveLength(2); // back again: new vs v2
});

test("refused: a reused id changes type; an option is removed or renamed", () => {
  expect(exportChanges([choice("choice", "x", "y")], choice("multi", "x", "y"))).toEqual([
    "'c' was a .choice question and is now a .multi question.",
  ]);
  expect(exportChanges([choice("choice", "x", "y")], choice("choice", "x", "Y"))).toEqual([
    `In 'c', the option "y" was removed or renamed.`,
  ]);
});

test("refused: the Other label renamed; adding or removing Other is free (#95)", () => {
  const other = (label?: string) =>
    m(`::: {.choice #c${label ? ` other="${label}"` : ""}}\nPick\n- x\n- y\n:::\n`);
  expect(exportChanges([other("Other")], other("Something else"))).toEqual([
    `In 'c', the Other label was "Other" and is now "Something else".`,
  ]);
  expect(exportChanges([other()], other("Other"))).toEqual([]);
  expect(exportChanges([other("Other")], other())).toEqual([]);
});

test("refused: a column name moves to a different question across versions (#95)", () => {
  expect(exportChanges([likert("a")], m("::: {.text #r_1}\nQ\n:::\n"))).toEqual([
    "The export column 'r_1' was part of 'r' and is now part of 'r_1'.",
  ]);
});

test("#122: option values; rewording a valued label is free", () => {
  const v1 = choice("choice", "Yes {value=1}", "No {value=0}");
  expect(exportChanges([v1], choice("choice", "Yes, sure {value=1}", "No {value=0}"))).toEqual([]);
  expect(exportChanges([v1], choice("choice", "Yes {value=2}", "No {value=0}"))).toEqual([
    `In 'c', the option value "1" ("Yes") was removed or changed.`,
  ]);
  expect(exportChanges([v1], choice("choice", "No {value=0}", "Maybe"))).toHaveLength(1);
  // One line per value, even when earlier versions labelled it differently (oldest label shown).
  const v2 = choice("choice", "Yes, sure {value=1}", "No {value=0}");
  expect(exportChanges([v1, v2], choice("choice", "Yes {value=2}", "No {value=0}"))).toEqual([
    `In 'c', the option value "1" ("Yes") was removed or changed.`,
  ]);
  expect(exportChanges([choice("choice", "x", "y")], choice("choice", "x {value=1}", "y"))).toEqual(
    [`In 'c', the option value "x" ("x") was removed or changed.`],
  );
});

test("free: switching a .choice between radios and dropdown (#123)", () => {
  const src = (f: string) => `::: {.choice #c other ${f}}\nPick\n- A {value=1}\n- B\n:::\n`;
  const radios = m(src(""));
  const dropdown = m(src("dropdown"));
  expect(columnsFor(dropdown)).toEqual(columnsFor(radios));
  expect(exportChanges([radios], dropdown)).toEqual([]);
  expect(exportChanges([dropdown], radios)).toEqual([]);
});

test("#124: a reused id changing to or from .date is reported; min/max changes are free", () => {
  const date = (attrs = "") => m(`::: {.date #d ${attrs}}\nWhen?\n:::\n`);
  expect(exportChanges([m("::: {.text #d}\nQ\n:::\n")], date())).toEqual([
    "'d' was a .text question and is now a .date question.",
  ]);
  expect(exportChanges([date()], m("::: {.number #d}\nQ\n:::\n"))).toEqual([
    "'d' was a .date question and is now a .number question.",
  ]);
  expect(exportChanges([date("min=2026-01-01")], date("max=2025-06-30"))).toEqual([]);
  expect(columnsFor(date())).toEqual([
    { name: "d", questionId: "d", type: "date", part: "value", freeText: false },
  ]);
});

test("free: switching a .number to or from slider, or changing min/max/step (#125)", () => {
  const num = (attrs: string) => m(`::: {.number #x ${attrs}}\nQ\n:::\n`);
  const plain = num("");
  const slider = num("slider min=0 max=10");
  expect(columnsFor(slider)).toEqual(columnsFor(plain));
  expect(exportChanges([plain], slider)).toEqual([]);
  expect(exportChanges([slider], plain)).toEqual([]);
  expect(exportChanges([slider], num("slider min=1 max=5 step=0.5"))).toEqual([]);
  expect(exportChanges([slider], m("::: {.date #x}\nQ\n:::\n"))).toEqual([
    "'x' was a .number question and is now a .date question.",
  ]);
});
