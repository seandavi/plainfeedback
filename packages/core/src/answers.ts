// Shared answer validation: the browser shows these errors, the server enforces them.
// Answer shapes are specified in docs/grammar.md ("Answers").
import { OTHER_MAXLENGTH, type Question, type Survey } from "./model";

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
    const message = isEmpty(value)
      ? q.required
        ? "This question is required."
        : undefined
      : check(q, value);
    if (message) errors[q.id] = message;
  }
  return errors;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function checkOption(q: { options: string[]; other?: string }, v: unknown): string | undefined {
  if (typeof v !== "string") return "Choose one of the options.";
  if (q.options.includes(v)) return;
  if (q.other === undefined) return "Choose one of the options.";
  if (v.length > OTHER_MAXLENGTH)
    return `Please use at most ${OTHER_MAXLENGTH} characters for "${q.other}".`;
}

function check(q: Question, v: unknown): string | undefined {
  switch (q.type) {
    case "choice":
      return checkOption(q, v);
    case "multi": {
      if (!Array.isArray(v)) return "Choose from the options.";
      if (new Set(v).size !== v.length) return "An option is chosen twice.";
      if (v.filter((x) => !q.options.includes(x)).length > 1) return "Choose from the options.";
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
        return "Please rate every statement.";
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
