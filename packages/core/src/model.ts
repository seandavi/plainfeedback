// The compiled survey model (ADR 0003). Stored per published version; consumed by the
// renderer, the answer validator and the exporter. Spec: docs/grammar.md.
import { z } from "zod";

export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Longest accepted "Other" free-text answer on choice and multi questions. */
export const OTHER_MAXLENGTH = 500;
export const TEXT_DEFAULT_MAXLENGTH = 2000;
/** Bot deterrent (#34): the server drops submissions sent sooner than this after the page loaded;
 * the participant page waits out the remainder, so a fast human is never dropped. */
export const MIN_SUBMIT_MS = 3000;
export const LIKERT_MAX_POINTS = 11;
// zod's ISO date regex is anchored and fixed-length (no backtracking) and checks leap years.
const ISO_DATE = z.iso.date();
/** A real calendar date written `YYYY-MM-DD` (#124). Within such strings `<` is date order. */
export const isIsoDate = (s: string) => ISO_DATE.safeParse(s).success;

const base = {
  id: z.string().regex(ID_PATTERN),
  /** Markdown source; the web app renders and sanitizes it. */
  prompt: z.string().min(1),
  required: z.boolean(),
  /** Reserved for phase 3 conditionals; the phase 1 compiler never sets it. */
  visibleIf: z.string().optional(),
};

const options = {
  options: z.array(z.string().min(1)).min(2),
  /** Stored value per option (`- Label {value=5}`, #122), parallel to `options`. Absent: the
   * option text is stored. Answers, the publish check and the export use `optionValues`. */
  values: z.array(z.string().min(1)).optional(),
  /** Label of the free-text "Other" option, if offered. */
  other: z.string().min(1).optional(),
};

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("choice"),
    ...options,
    /** Show as a native `<select>` (#123). Presentation only; answers and export identical to radios. */
    dropdown: z.literal(true).optional(),
  }),
  z.object({ ...base, type: z.literal("multi"), ...options }),
  z.object({
    ...base,
    type: z.literal("likert"),
    statements: z.array(z.string().min(1)).min(1),
    scale: z.object({ min: z.number().int(), max: z.number().int() }),
    anchors: z.object({
      low: z.string().optional(),
      mid: z.string().optional(),
      high: z.string().optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("text"),
    maxlength: z.number().int().positive(),
    multiline: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("date"),
    min: z.string().refine(isIsoDate).optional(),
    max: z.string().refine(isIsoDate).optional(),
  }),
]);

export const surveySchema = z
  .object({
    title: z.string().min(1),
    /** Markdown source. */
    intro: z.string().optional(),
    pages: z.array(z.object({ questions: z.array(questionSchema) })).min(1),
  })
  .refine(
    (s) => {
      const ids = s.pages.flatMap((p) => p.questions.map((q) => q.id));
      return new Set(ids).size === ids.length;
    },
    { message: "Question ids must be unique" },
  )
  .refine(
    (s) =>
      s.pages.every((p) =>
        p.questions.every(
          (q) =>
            !("values" in q) ||
            q.values === undefined ||
            (q.values.length === q.options.length && new Set(q.values).size === q.values.length),
        ),
      ),
    { message: "Option values must be unique and one per option" },
  );

export type Question = z.infer<typeof questionSchema>;
export type QuestionType = Question["type"];
export type Survey = z.infer<typeof surveySchema>;

/** What an answer stores for each option: its `{value=...}`, else the option text. */
export const optionValues = (q: { options: string[]; values?: string[] }): string[] =>
  q.values ?? q.options;
