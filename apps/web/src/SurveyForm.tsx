// Renders a compiled survey model as one accessible form (issue #7). Reused by the editor's live
// preview (#8) with mode="preview": it validates but never submits. Answer shapes: docs/grammar.md.
import {
  type AnswerErrors,
  type Answers,
  OTHER_MAXLENGTH,
  optionValues,
  type Question,
  type Survey,
  validateAnswers,
} from "@plainfeedback/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { MarkdownInline } from "./markdown";

type Choice = { pick?: string; other: string }; // pick is an option, or OTHER
type Multi = { picks: string[]; otherOn: boolean; other: string };
type Ui = Record<string, unknown>;
const OTHER = "\u0000other";
const HONEYPOT = "pf_hp_x7";

/** Turns form state into the answers object validateAnswers and the server expect. */
export function toAnswers(model: Survey, ui: Ui): Answers {
  const out: Answers = {};
  for (const q of model.pages.flatMap((p) => p.questions)) {
    const v = ui[q.id];
    if (v === undefined) continue;
    if (q.type === "choice") {
      const c = v as Choice;
      if (c.pick !== undefined) out[q.id] = c.pick === OTHER ? c.other : c.pick;
    } else if (q.type === "multi") {
      const m = v as Multi;
      out[q.id] = m.otherOn ? [...m.picks, m.other] : m.picks; // blank Other: core says so (#67)
    } else if (q.type === "number") {
      if ((v as string).trim() !== "") out[q.id] = Number(v);
    } else out[q.id] = v;
  }
  return out;
}

export type SurveyFormProps = {
  model: Survey;
  mode?: "live" | "preview";
  /** Resolve with per-question errors (e.g. a server 422) to show them; throw to show a message. */
  onSubmit?: (answers: Answers, honeypot: string) => Promise<AnswerErrors | undefined>;
};

export function SurveyForm({ model, mode = "live", onSubmit }: SurveyFormProps) {
  const [ui, setUi] = useState<Ui>({});
  const [errors, setErrors] = useState<AnswerErrors>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const prefix = useId();

  useEffect(() => {
    if (focusTick) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const questions = model.pages.flatMap((p) => p.questions);
  const ids = new Set(questions.map((q) => q.id));
  const showErrors = (errs: AnswerErrors) => {
    setErrors(errs);
    const n = Object.keys(errs).length;
    const stray = Object.entries(errs).filter(([k]) => !ids.has(k));
    setMessage(
      [`Please check ${n === 1 ? "1 answer" : `${n} answers`}.`, ...stray.map(([, m]) => m)].join(
        " ",
      ),
    );
    setFocusTick((t) => t + 1);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const answers = toAnswers(model, ui);
    const errs = validateAnswers(model, answers);
    if (Object.keys(errs).length) return showErrors(errs);
    setErrors({});
    if (mode === "preview" || !onSubmit) return setMessage("Preview: answers are valid, not sent.");
    setBusy(true);
    setMessage(undefined);
    try {
      const hp = form.current && new FormData(form.current).get(HONEYPOT);
      const server = await onSubmit(answers, typeof hp === "string" ? hp : "");
      if (server && Object.keys(server).length) showErrors(server);
    } catch (x) {
      setMessage(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={submit} noValidate className="survey">
      {questions.map((q) => (
        <QuestionField
          key={q.id}
          q={q}
          name={`${prefix}${q.id}`}
          value={ui[q.id]}
          error={errors[q.id]}
          onChange={(v) => {
            setUi((u) => ({ ...u, [q.id]: v }));
            if (errors[q.id]) setErrors(({ [q.id]: _, ...rest }) => rest);
          }}
        />
      ))}
      {mode === "live" && (
        // Bot deterrent (#34): hidden from people and assistive tech; bots that fill every field
        // fill it, and the server drops their submission. Unusual name so autofill leaves it alone.
        <div className="hp" aria-hidden="true">
          <label>
            Leave this empty <input name={HONEYPOT} tabIndex={-1} autoComplete="off" />
          </label>
        </div>
      )}
      {message && (
        <p role="alert" className="form-message">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "Sending…" : mode === "preview" ? "Check answers" : "Submit"}
      </button>
    </form>
  );
}

type FieldProps<V> = {
  q: Question;
  name: string;
  value: V | undefined;
  error?: string;
  onChange: (v: V) => void;
};

const Required = ({ q }: { q: Question }) =>
  q.required ? <span className="req"> (required)</span> : null;
const ErrorText = ({ id, error }: { id: string; error?: string }) =>
  error ? (
    <p id={id} className="error">
      {error}
    </p>
  ) : null;
// maxLength cuts pasted text silently; say so, in a live region mounted before it fills (#77).
const LimitNote = ({ length, max }: { length: number; max: number }) => (
  <span className="limit" aria-live="polite">
    {length >= max ? `Limit reached: only the first ${max} characters are kept.` : ""}
  </span>
);

// biome-ignore lint/suspicious/noExplicitAny: each branch narrows value by question type
function QuestionField(p: FieldProps<any>) {
  const errId = `${p.name}-error`;
  const invalid = p.error ? true : undefined;
  const describedBy = p.error ? errId : undefined;
  const q = p.q;
  const prompt = (
    <>
      <MarkdownInline text={q.prompt} />
      <Required q={q} />
    </>
  );

  if (q.type === "choice" || q.type === "multi") {
    const multi = q.type === "multi";
    const v: Choice & Multi = { picks: [], otherOn: false, other: "", ...p.value };
    const otherOn = multi ? v.otherOn : v.pick === OTHER;
    // Other picked but blank: the error is about the text box, so mark and focus that (#67).
    const otherBlank = otherOn && !v.other.trim();
    const toggle = (o: string, on: boolean) =>
      p.onChange(
        multi
          ? { ...v, picks: on ? [...v.picks, o] : v.picks.filter((x) => x !== o) }
          : { ...v, pick: o },
      );
    return (
      <fieldset className="question" aria-describedby={describedBy}>
        <legend>{prompt}</legend>
        {optionValues(q).map((o, i) => (
          <label key={o} className="option">
            <input
              type={multi ? "checkbox" : "radio"}
              name={p.name}
              value={o}
              checked={multi ? v.picks.includes(o) : v.pick === o}
              onChange={(e) => toggle(o, e.target.checked)}
              aria-invalid={otherBlank ? undefined : invalid}
            />
            {q.options[i]}
          </label>
        ))}
        {q.other && (
          <>
            <label className="option">
              <input
                type={multi ? "checkbox" : "radio"}
                name={p.name}
                checked={otherOn}
                onChange={(e) =>
                  p.onChange(multi ? { ...v, otherOn: e.target.checked } : { ...v, pick: OTHER })
                }
                aria-invalid={otherBlank ? undefined : invalid}
              />
              {q.other}
            </label>
            {otherOn && (
              <>
                <input
                  type="text"
                  className="other"
                  aria-label={`${q.other}: please specify`}
                  maxLength={OTHER_MAXLENGTH}
                  value={v.other}
                  onChange={(e) => p.onChange({ ...v, other: e.target.value })}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                />
                <LimitNote length={v.other.length} max={OTHER_MAXLENGTH} />
              </>
            )}
          </>
        )}
        <ErrorText id={errId} error={p.error} />
      </fieldset>
    );
  }

  if (q.type === "likert") {
    const v = (p.value ?? {}) as Record<string, number>;
    const { min, max } = q.scale;
    const points = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    const anchor = (n: number) =>
      n === min
        ? q.anchors.low
        : n === max
          ? q.anchors.high
          : n * 2 === min + max
            ? q.anchors.mid
            : undefined;
    const keyed = points.filter((n) => anchor(n));
    const ends = [min, max].filter((n) => anchor(n));
    return (
      <fieldset className="question likert" aria-describedby={describedBy}>
        <legend>{prompt}</legend>
        {/* Next to the legend, not 13 rows down (#56). */}
        <ErrorText id={errId} error={p.error} />
        {keyed.length > 0 && (
          <p className="anchors">
            {keyed.map((n) => (
              <span key={n}>
                {n} = {anchor(n)}
              </span>
            ))}
          </p>
        )}
        {q.statements.map((s, i) => {
          const key = String(i + 1);
          const rowName = `${p.name}-${key}`;
          const unrated = invalid && v[key] === undefined;
          // Radios are named "1".."5"; the end anchors show under every row (so they stay in view on
          // a phone) and are announced once per row as the group's description (#66).
          return (
            <fieldset
              key={key}
              className={unrated ? "statement unrated" : "statement"}
              aria-describedby={ends.length ? `${rowName}-ends` : undefined}
            >
              <legend>
                <MarkdownInline text={s} />
                {unrated && <span className="not-rated"> (not rated)</span>}
              </legend>
              <div className="rating">
                <div className="scale">
                  {points.map((n) => (
                    <label key={n}>
                      <input
                        type="radio"
                        name={rowName}
                        checked={v[key] === n}
                        onChange={() => p.onChange({ ...v, [key]: n })}
                        aria-invalid={unrated || undefined}
                        aria-describedby={unrated ? errId : undefined}
                      />
                      <span>{n}</span>
                    </label>
                  ))}
                </div>
                {ends.length > 0 && (
                  <p className="ends" id={`${rowName}-ends`} aria-hidden="true">
                    {ends.map((n) => (
                      <span key={n}>
                        {n} = {anchor(n)}{" "}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </fieldset>
          );
        })}
      </fieldset>
    );
  }

  const inputId = `${p.name}-input`;
  if (q.type === "text") {
    const v = (p.value ?? "") as string;
    const countId = `${p.name}-count`;
    const common = {
      id: inputId,
      value: v,
      maxLength: q.maxlength,
      "aria-invalid": invalid,
      "aria-describedby": [countId, describedBy].filter(Boolean).join(" "),
      onChange: (e: { target: { value: string } }) => p.onChange(e.target.value),
    };
    return (
      <div className="question">
        <label htmlFor={inputId}>{prompt}</label>
        {q.multiline ? <textarea rows={5} {...common} /> : <input type="text" {...common} />}
        <span id={countId} className="count">
          {v.length} / {q.maxlength} characters
        </span>
        <LimitNote length={v.length} max={q.maxlength} />
        <ErrorText id={errId} error={p.error} />
      </div>
    );
  }

  return (
    <div className="question">
      <label htmlFor={inputId}>{prompt}</label>
      <input
        id={inputId}
        type="number"
        inputMode="decimal"
        step="any"
        min={q.min}
        max={q.max}
        value={(p.value ?? "") as string}
        onChange={(e) => p.onChange(e.target.value)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      />
      <ErrorText id={errId} error={p.error} />
    </div>
  );
}
