// Shared answer validation: the browser shows these errors, the server enforces them.
// Answer shapes are specified in docs/grammar.md ("Answers").
import { OTHER_MAXLENGTH, optionValues, type Question, type Survey } from "./model";

export type Answers = Record<string, unknown>;
/** Question id -> human-readable error. Empty when the answers are valid. */
export type AnswerErrors = Record<string, string>;

export function validateAnswers(model: Survey, answers: Answers): AnswerErrors {
  // Null prototype: a respondent-sent "__proto__" key must land as a normal error entry.
  const errors: AnswerErrors = Object.create(null);
  const questions = model.pages.flatMap((p) => p.questions);
  const ids = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(answers))
    if (!ids.has(key)) errors[key] = "This is not a question in this survey.";
  for (const q of questions) {
    const value = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    const message = otherBlank(q, value)
      ? `Please describe "${(q as { other: string }).other}", or pick another option.`
      : isEmpty(value)
        ? q.required
          ? q.type === "likert"
            ? unrated(q, {})
            : "This question is required."
          : undefined
        : check(q, value);
    if (message) errors[q.id] = message;
  }
  return errors;
}

/** Stored form of a submission (#75), applied before validateAnswers so the validator sees what is
 * stored: strings trimmed, unrated Likert statements and blank multi entries removed, and empty
 * answers (`null`, `""`, `[]`, `{}`) dropped, so "answered" means the same in JSONL and CSV. */
export function normalizeAnswers(answers: Answers): Answers {
  // fromEntries, not assignment: a "__proto__" key stays an own key (and is then a validation error).
  return Object.fromEntries(
    Object.entries(answers).flatMap(([k, v]) => {
      const n = normalize(v);
      return isEmpty(n) ? [] : [[k, n]];
    }),
  );
}

function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(normalize).filter((x) => !isEmpty(x));
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).filter(([, r]) => r !== null));
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

// With an Other box, a blank string means "Other" was picked and left empty (SurveyForm sends it so).
function otherBlank(q: Question, v: unknown): boolean {
  if ((q.type !== "choice" && q.type !== "multi") || q.other === undefined) return false;
  const blank = (x: unknown) => typeof x === "string" && x.trim() === "";
  return q.type === "choice" ? blank(v) : Array.isArray(v) && v.some(blank);
}

/** Names the unrated statements of a required grid: count, then up to three, plain text. */
function unrated(q: Extract<Question, { type: "likert" }>, v: object): string {
  const names = q.statements
    .filter((_, i) => typeof Object.getOwnPropertyDescriptor(v, i + 1)?.value !== "number")
    .map((s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, ""));
  const shown = names.slice(0, 3).join("; ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `Please rate every statement (${names.length} not rated: ${shown}${more}).`;
}

function checkOption(
  q: { options: string[]; values?: string[]; other?: string },
  v: unknown,
): string | undefined {
  if (typeof v !== "string") return "Choose one of the options.";
  if (optionValues(q).includes(v)) return;
  if (q.other === undefined) return "Choose one of the options.";
  if (v.length > OTHER_MAXLENGTH)
    return `Please use at most ${OTHER_MAXLENGTH} characters for "${q.other}".`;
}

function check(q: Question, v: unknown): string | undefined {
  // Postgres jsonb cannot store U+0000; reject it here instead of failing the insert.
  if (JSON.stringify(v).includes("\\u0000")) return "Remove the unsupported character.";
  switch (q.type) {
    case "choice":
      return checkOption(q, v);
    case "multi": {
      if (!Array.isArray(v)) return "Choose from the options.";
      if (new Set(v).size !== v.length) return "An option is chosen twice.";
      if (v.filter((x) => !optionValues(q).includes(x)).length > 1)
        return "Choose from the options.";
      for (const x of v) {
        const m = checkOption(q, x);
        if (m) return m;
      }
      return;
    }
    case "likert": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return "Rate the statements.";
      const { min, max } = q.scale;
      for (const [k, r] of Object.entries(v)) {
        const i = Number(k);
        if (!Number.isInteger(i) || i < 1 || i > q.statements.length || String(i) !== k)
          return "Rate only the listed statements.";
        if (r === null) continue;
        if (!Number.isInteger(r) || (r as number) < min || (r as number) > max)
          return `Ratings must be whole numbers from ${min} to ${max}.`;
      }
      if (
        q.required &&
        q.statements.some(
          (_, i) => typeof Object.getOwnPropertyDescriptor(v, i + 1)?.value !== "number",
        )
      )
        return unrated(q, v);
      return;
    }
    case "text":
      if (typeof v !== "string") return "Enter text.";
      if (v.length > q.maxlength) return `Please use at most ${q.maxlength} characters.`;
      return;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "Enter a number.";
      if (q.min !== undefined && v < q.min) return `Enter a number of at least ${q.min}.`;
      if (q.max !== undefined && v > q.max) return `Enter a number of at most ${q.max}.`;
      return;
  }
}
