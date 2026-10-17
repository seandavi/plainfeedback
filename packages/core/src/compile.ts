// Markdown survey source -> JSON model. Grammar: docs/grammar.md. Parser choice: ADR 0008.
// Line-based on purpose: every construct is line-oriented, so errors carry exact lines.
import { columnsFor } from "./compat";
import {
  ID_PATTERN,
  LIKERT_MAX_POINTS,
  type Question,
  type QuestionType,
  type Survey,
  surveySchema,
  TEXT_DEFAULT_MAXLENGTH,
} from "./model";

export type CompileError = { line: number; column?: number; message: string };
export type CompileResult =
  | { model: Survey; errors?: never }
  | { model?: never; errors: CompileError[] };

const TYPES: QuestionType[] = ["choice", "multi", "likert", "text", "number"];
const ATTRS: Record<QuestionType, string[]> = {
  choice: ["other", "dropdown"],
  multi: ["other"],
  likert: ["scale", "low", "mid", "high"],
  text: ["maxlength", "multiline"],
  number: ["min", "max"],
};
const FLAGS = new Set(["required", "multiline", "other", "dropdown"]);

const RESERVED_SEQ = "The id '#seq' is reserved for the export's row number. Choose another id.";
const TITLE_MESSAGE = "A survey starts with its title on a line like: # Fall Meeting Feedback";
const FENCE_OPEN = /^:{3,}\s*(.*?)\s*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
const CURLY = /[‘’“”]/;
const CURLY_MESSAGE =
  'Curly quotes (“ ” ‘ ’) can\'t be used around settings; they often come from pasting out of Word or Google Docs. Use straight quotes, like low="Not at all".';
const PASTED_BULLET = /^\s*[•◦▪]\s+/; // not dashes: "— optional" is fine prompt text
const ATTR =
  /\s*(?:\.([\w-]+)|#(\S*?)(?=\s|$)|([\w-]+)(?![\w-])(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+))|(?!=)))\s*/y;

type Block = {
  line: number;
  broken: boolean; // the opening line already got an error: swallow the block, check nothing
  stray?: number; // first unindented, non-list line after the options
  attrText: string;
  attrColumn: number;
  prompt: string[];
  items: { text: string; line: number }[];
  inItem: boolean;
};

export function compile(markdown: string): CompileResult {
  const lines = markdown.split(/\r?\n/);
  const errors: CompileError[] = [];
  const err = (line: number, message: string, column?: number) =>
    errors.push(column === undefined ? { line, message } : { line, column, message });

  let title: string | undefined;
  const intro: string[] = [];
  const questions: Question[] = [];
  const idLines = new Map<string, number>();
  let block: Block | undefined;
  let started = false; // a question block has been opened
  let firstLine: number | undefined; // first non-blank line, when it came before the title

  lines.forEach((raw, i) => {
    const n = i + 1;
    const fence = raw.match(FENCE_OPEN)?.[1];
    if (block) {
      if (fence === "") {
        const q = block.broken ? undefined : finish(block, err, idLines);
        if (q) questions.push(q);
        block = undefined;
      } else if (fence !== undefined) {
        err(
          n,
          "A question block can't contain another ':::' block. Close the first one with ':::'.",
        );
      } else {
        const pasted = !block.broken && PASTED_BULLET.test(raw);
        if (pasted)
          err(
            n,
            "Start each option with '- ' (a hyphen and a space). Pasted bullets like '•' aren't recognised.",
          );
        const item = pasted ? ["", raw.replace(PASTED_BULLET, "")] : raw.match(LIST_ITEM);
        const last = block.items.at(-1);
        const wrapped = !item && last && block.inItem && /^\s+\S/.test(raw);
        if (item) block.items.push({ text: (item[1] ?? "").trim(), line: n });
        else if (wrapped && last) last.text += ` ${raw.trim()}`;
        else {
          if (last && raw.trim()) block.stray ??= n;
          block.prompt.push(raw);
        }
        block.inItem = Boolean(item || wrapped);
      }
      return;
    }
    if (fence !== undefined) {
      if (fence === "") {
        err(n, "This ':::' doesn't close any question block.");
        return;
      }
      // A malformed opening line still opens a block, so the lines inside it and its closing
      // ':::' don't produce follow-on errors.
      let broken = true;
      if (/^\{[^}]*$/.test(fence))
        err(
          n,
          "The settings braces are not closed. End the line with '}', like ::: {.text #comments}",
        );
      else if (!/^\{.*\}$/.test(fence))
        err(n, "Put the question's settings in braces, like ::: {.text #comments}");
      else broken = false;
      if (title === undefined) firstLine ??= n;
      started = true;
      block = {
        line: n,
        broken,
        attrText: fence.slice(1, -1),
        attrColumn: raw.indexOf("{") + 2,
        prompt: [],
        items: [],
        inItem: false,
      };
      return;
    }
    if (raw.trim() === "") {
      if (title !== undefined && !started) intro.push(raw);
      return;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (title === undefined) {
      if (heading?.[1] !== "#") {
        firstLine ??= n; // reported once at the end if no title follows
        return;
      }
      title = heading[2];
      if (firstLine !== undefined) {
        err(
          n,
          `The title must be the first line (found on line ${n}). Move it above line ${firstLine}.`,
        );
        started = false; // the intro after it is fine; don't also report it as stray text
      }
      return;
    }
    if (heading?.[1] === "#") err(n, "Only one title (# heading) is allowed per survey.");
    else if (heading?.[1] === "##" || /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(raw))
      err(n, "Multiple pages (## headings or --- lines) are not supported yet.");
    else if (started)
      err(
        n,
        "Text between or after questions isn't supported. Move it into a question's prompt or the intro.",
      );
    else intro.push(raw);
  });

  if (block)
    err(block.line, "This question block is never closed. Add a line with just ':::' after it.");
  if (!title)
    err(
      firstLine ?? 1,
      markdown.trim() ? TITLE_MESSAGE : "The survey is empty. Start with a title line.",
    );
  // #95: an id must not equal a CSV column another question generates (#r -> r_1, #c -> c_other),
  // or the export header repeats and one value overwrites the other. `seq` is a fixed column.
  if (idLines.has("seq")) err(idLines.get("seq") as number, RESERVED_SEQ);
  for (const c of columnsFor({ title: "", pages: [{ questions }] }))
    if (c.name !== c.questionId && idLines.has(c.name))
      err(
        idLines.get(c.name) as number,
        `The id '#${c.name}' is also an export column of '#${c.questionId}' (line ${idLines.get(c.questionId)}). Choose another id.`,
      );
  if (errors.length > 0) return { errors: errors.sort((a, b) => a.line - b.line) };

  const introText = intro.join("\n").trim();
  const model: Survey = {
    title: title as string,
    ...(introText ? { intro: introText } : {}),
    pages: [{ questions }],
  };
  return { model: surveySchema.parse(model) };
}

function finish(
  b: Block,
  err: (line: number, message: string, column?: number) => void,
  idLines: Map<string, number>,
): Question | undefined {
  // ponytail: on any error the caller discards the question, so we return it anyway.
  const e = (message: string, column?: number) => err(b.line, message, column);

  // Tokenize {.type #id key=value flag}
  const classes: string[] = [];
  let id: string | undefined;
  const attrs = new Map<string, string | true>();
  ATTR.lastIndex = 0;
  while (ATTR.lastIndex < b.attrText.length) {
    const at = ATTR.lastIndex;
    const m = ATTR.exec(b.attrText);
    const [, cls, hash, key = "", dq, sq, bare] = m ?? [];
    if (!m || m[0] === "" || (bare && CURLY.test(bare))) {
      const rest = b.attrText.slice(at);
      e(
        CURLY.test(rest) ? CURLY_MESSAGE : `Can't read the settings from here: "${rest}"`,
        b.attrColumn + at,
      );
      return;
    }
    if (cls) classes.push(cls);
    else if (hash !== undefined) {
      if (id !== undefined) e("A question can only have one #id.");
      id = hash;
    } else if (attrs.has(key)) e(`The attribute '${key}' is given twice.`);
    else attrs.set(key, dq ?? sq ?? bare ?? true);
  }

  const types = classes.filter((c) => (TYPES as string[]).includes(c));
  for (const c of classes)
    if (!types.includes(c))
      e(`Unknown question type '.${c}'. Use one of: ${TYPES.map((t) => `.${t}`).join(", ")}.`);
  if (types.length !== 1) {
    if (types.length === 0 && classes.length === 0)
      e(`Give the question a type, one of: ${TYPES.map((t) => `.${t}`).join(", ")}.`);
    else if (types.length > 1) e("A question can only have one type.");
    return;
  }
  const type = types[0] as QuestionType;

  if (id === undefined)
    e("Give the question an id, like #affiliation. Answers are stored under it.");
  else if (!ID_PATTERN.test(id))
    e(
      `The id '#${id}' isn't valid. Use lowercase letters, digits, '-' or '_', starting with a letter (at most 64 characters).`,
    );
  else if (idLines.has(id)) e(`The id '#${id}' is already used on line ${idLines.get(id)}.`);
  else idLines.set(id, b.line);

  for (const [key, value] of attrs) {
    if (key === "show-if") e("Conditional questions (show-if) are not supported yet.");
    else if (key !== "required" && !ATTRS[type].includes(key))
      e(`'${key}' doesn't apply to .${type} questions.`);
    else if (value === true && !FLAGS.has(key)) e(`'${key}' needs a value, like ${key}="..."`);
    else if (value !== true && (key === "required" || key === "multiline" || key === "dropdown"))
      e(`Write '${key}' on its own, without a value.`);
  }

  const prompt = b.prompt.join("\n").trim();
  if (!prompt) e("The question has no prompt. Write the question text inside the block.");

  const str = (k: string) => {
    const v = attrs.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const num = (k: string) => {
    const v = str(k);
    if (v === undefined) return undefined;
    const x = Number(v);
    if (v.trim() === "" || !Number.isFinite(x)) e(`'${k}' must be a number, not "${v}".`);
    return x;
  };

  const common = { id: id ?? "", prompt, required: attrs.has("required") };
  const items = b.items.map((it) => it.text);
  if ((type === "text" || type === "number") && items.length > 0)
    err(
      b.items[0]?.line ?? b.line,
      `A .${type} question doesn't take a list. Remove the '- ' items.`,
    );

  let q: Question;
  switch (type) {
    case "choice":
    case "multi": {
      if (b.stray) strayError(b, err);
      else if (items.length < 2)
        e(`A .${type} question needs at least two options, written as '- ' list items.`);
      // #122: `- Label {value=5}` stores "5"; options without one store their label.
      const explicit = b.items.map((it) => {
        const v = itemValue(it, err);
        if (v) it.text = v.label;
        return v?.value;
      });
      const labels = b.items.map((it) => it.text);
      const values = explicit.some((v) => v !== undefined)
        ? explicit.map((v, i) => v ?? (labels[i] as string))
        : undefined;
      checkDuplicates(b, err, "option");
      const otherAttr = attrs.get("other");
      const other = otherAttr === true ? "Other" : otherAttr;
      if (other === "") e("'other' needs a label, like other=\"Other\", or write just 'other'.");
      else if (other !== undefined && labels.includes(other))
        e(`The 'other' label "${other}" is also a listed option. Remove one of them.`);
      if (values) {
        const seen = new Map<string, number>();
        b.items.forEach((it, i) => {
          const v = values[i] as string;
          const first = seen.get(v);
          if (first !== undefined)
            err(it.line, `This option's value "${v}" repeats the one on line ${first}.`);
          else seen.set(v, it.line);
          // The main CSV column holds the value or the Other label, so they must differ.
          if (v === other && labels[i] !== other)
            err(
              it.line,
              `This option's value "${v}" is also the 'other' label. Change one of them.`,
            );
          if (type === "multi" && explicit[i]?.includes(";"))
            err(it.line, `A .multi option's value can't contain ';'.`);
        });
      }
      // The CSV export joins multi answers with ';' (#64), so a label containing one can't be split.
      if (type === "multi") {
        for (const it of b.items)
          if (it.text.includes(";"))
            err(it.line, `A .multi option can't contain ';'. Use a comma or 'and' instead.`);
        if (typeof other === "string" && other.includes(";"))
          e(`The 'other' label "${other}" can't contain ';' in a .multi question.`);
      }
      q = {
        ...common,
        type,
        options: labels,
        ...(values ? { values } : {}),
        ...(other !== undefined ? { other } : {}),
        ...(type === "choice" && attrs.has("dropdown") ? { dropdown: true as const } : {}),
      };
      break;
    }
    case "likert": {
      if (b.stray) strayError(b, err);
      else if (items.length < 1)
        e("A .likert question needs at least one statement, written as '- ' list items.");
      for (const it of b.items)
        if (/\bvalue\s*=/.test(trailingBraces(it.text)?.inner ?? ""))
          err(it.line, "Stored values apply to .choice and .multi options only.");
      checkDuplicates(b, err, "statement");
      const scale = str("scale") ?? "1-5";
      const m = scale.match(/^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/);
      const min = m ? Number(m[1]) : 1;
      const max = m ? Number(m[2]) : 5;
      if (!m)
        e(`The scale "${scale}" isn't valid. Write it as two whole numbers, like scale="1-5".`);
      else if (min >= max) e(`The scale "${scale}" must go from low to high, like scale="1-5".`);
      else if (max - min + 1 > LIKERT_MAX_POINTS)
        e(`The scale "${scale}" has too many points (at most ${LIKERT_MAX_POINTS}).`);
      else if (attrs.has("mid") && (max - min) % 2 !== 0)
        e(`The scale "${scale}" has no middle point, so 'mid' can't be used.`);
      const anchors = Object.fromEntries(
        (["low", "mid", "high"] as const).flatMap((k) => (str(k) ? [[k, str(k)]] : [])),
      );
      q = { ...common, type, statements: items, scale: { min, max }, anchors };
      break;
    }
    case "text": {
      const maxlength = num("maxlength") ?? TEXT_DEFAULT_MAXLENGTH;
      if (!Number.isInteger(maxlength) || maxlength < 1)
        e(`'maxlength' must be a whole number of at least 1.`);
      q = { ...common, type, maxlength, multiline: attrs.has("multiline") };
      break;
    }
    case "number": {
      const min = num("min");
      const max = num("max");
      if (min !== undefined && max !== undefined && min > max)
        e("'min' must not be larger than 'max'.");
      q = {
        ...common,
        type,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      };
      break;
    }
  }
  return q;
}

/** The trailing `{...=...}` block of a list item, if any. No backtracking regex: item text is
 * author input up to the body limit, and the compile route is open to viewers. */
function trailingBraces(text: string): { label: string; inner: string } | undefined {
  if (!text.endsWith("}")) return;
  const open = text.lastIndexOf("{");
  const inner = text.slice(open + 1, -1);
  if (open < 0 || inner.includes("}") || !inner.includes("=")) return;
  return { label: text.slice(0, open).trimEnd(), inner };
}
const ITEM_ATTR = /\s*([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]*)(?=\s|$))\s*/y;

/** Splits a trailing `{value=...}` off an option. Braces without '=' stay label text (`Python {3}`).
 * Undefined when there is no attribute block; errors are reported on the item's line. */
function itemValue(
  it: { text: string; line: number },
  err: (line: number, message: string) => void,
): { label: string; value?: string } | undefined {
  const m = trailingBraces(it.text);
  if (!m) return;
  const { label, inner } = m;
  if (trailingBraces(label))
    err(it.line, "An option can have only one {value=...}. Remove the extra braces.");
  let value: string | undefined;
  ITEM_ATTR.lastIndex = 0;
  while (ITEM_ATTR.lastIndex < inner.length) {
    const at = ITEM_ATTR.lastIndex;
    const a = ITEM_ATTR.exec(inner);
    const [, key, dq, sq, bare] = a ?? [];
    if (!a || a[0] === "" || CURLY.test(inner)) {
      const rest = inner.slice(at);
      err(
        it.line,
        CURLY.test(inner) ? CURLY_MESSAGE : `Can't read the option's settings from here: "${rest}"`,
      );
      return { label };
    }
    if (key !== "value")
      err(it.line, `'${key}' doesn't apply to options. Only {value=...} is allowed.`);
    else if (value !== undefined) err(it.line, "The attribute 'value' is given twice.");
    else {
      value = dq ?? sq ?? bare ?? "";
      if (value === "") err(it.line, "This option's value is empty. Write it like {value=5}.");
    }
  }
  return { label, ...(value ? { value } : {}) };
}

const strayError = (b: Block, err: (line: number, message: string) => void) =>
  err(
    b.stray as number,
    "This line comes after the options but isn't indented, so it isn't part of an option. Indent it to continue the option above, start it with '- ' for a new option, or move it above the list.",
  );

function checkDuplicates(b: Block, err: (line: number, message: string) => void, what: string) {
  const seen = new Map<string, number>();
  for (const it of b.items) {
    const first = seen.get(it.text);
    if (first !== undefined) err(it.line, `This ${what} repeats the one on line ${first}.`);
    else seen.set(it.text, it.line);
    if (!it.text) err(it.line, `This ${what} is empty.`);
  }
}
