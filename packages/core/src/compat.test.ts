import { expect, test } from "vitest";
import { exportChanges } from "./compat";
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
