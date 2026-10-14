// Participant page /s/{publicId} (issue #7). Talks only to same-origin /api/v1/public, sends no
// credentials and keeps state in memory: no cookies, no storage, no third-party requests.
import { type AnswerErrors, type Answers, MIN_SUBMIT_MS, type Survey } from "@plainfeedback/core";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "./markdown";
import { SurveyForm } from "./SurveyForm";

type Loaded = {
  versionId: string;
  title: string;
  intro: string | null;
  model: Survey;
  privacyStatement: string;
  status: "open" | "closed" | "not_yet_open";
  ticket: string; // signed load time, sent back with the answers (#34)
  loadedAt: number; // local clock, for waiting out MIN_SUBMIT_MS
};
type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; survey: Loaded }
  | { kind: "done"; title: string };

export function ParticipantPage({ publicId }: { publicId: string }) {
  const url = `/api/v1/public/surveys/${encodeURIComponent(publicId)}`;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (): Promise<Loaded | undefined> => {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (res.status === 404) return void setState({ kind: "missing" });
      if (!res.ok) return void setState({ kind: "failed" });
      const survey = { ...(await res.json()), loadedAt: Date.now() } as Loaded;
      document.title = survey.title;
      setState({ kind: "ready", survey });
      return survey;
    } catch {
      setState({ kind: "failed" });
    }
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);

  if (state.kind === "loading") return <main aria-busy="true">Loading…</main>;
  if (state.kind === "missing")
    return (
      <main>
        <h1>Survey not found</h1>
        <p>Check the link. The survey may not be published yet.</p>
      </main>
    );
  if (state.kind === "failed")
    return (
      <main>
        <h1>Something went wrong</h1>
        <p>The survey could not be loaded. Please reload the page.</p>
      </main>
    );
  if (state.kind === "done")
    return (
      <main>
        <h1>{state.title}</h1>
        <p role="status">Thank you. Your answers have been recorded.</p>
      </main>
    );

  const s = state.survey;
  const submit = async (answers: Answers, hp: string): Promise<AnswerErrors | undefined> => {
    setNotice(undefined);
    // The server silently drops answers sent sooner than MIN_SUBMIT_MS after it issued the ticket.
    // Our interval is never longer than the server's, so waiting it out here is enough.
    const wait = s.loadedAt + MIN_SUBMIT_MS + 100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      res = await fetch(`${url}/responses`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId: s.versionId,
          answers,
          ticket: s.ticket,
          ...(hp && { hp }),
        }),
      });
    } catch {
      throw new Error("Could not reach the server. Your answers are still here; try again.");
    }
    if (res.status === 201) {
      setState({ kind: "done", title: s.title });
      return;
    }
    if (res.status === 422) return ((await res.json()) as { errors: AnswerErrors }).errors;
    if (res.status === 409 || res.status === 410 || res.status === 403) {
      const now = await load(); // newer version, or the survey closed: show what is live now
      // 409 with the same version means our ticket expired (#77); the reload issued a fresh one.
      if (res.status === 409)
        setNotice(
          now?.versionId === s.versionId
            ? "This page had expired, so we refreshed it. Your answers are still here; please submit again."
            : "This survey was just updated. Please check your answers and submit again.",
        );
      return;
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        body.error ?? "Many people are answering right now. Please wait a minute and try again.",
      );
    }
    throw new Error("Something went wrong. Your answers are still here; please try again.");
  };

  return (
    <main>
      <h1>{s.title}</h1>
      {/* Status first and privacy collapsed, so the notice or the first question is in view (#65). */}
      {s.status === "closed" && <p role="status">This survey is closed.</p>}
      {s.status === "not_yet_open" && <p role="status">This survey is not open yet.</p>}
      {s.intro && <Markdown text={s.intro} />}
      <details className="privacy">
        <summary>Privacy: what is stored and who can read your answers</summary>
        <Markdown text={s.privacyStatement} />
      </details>
      {s.status === "open" && (
        <>
          {notice && (
            <p role="alert" className="form-message">
              {notice}
            </p>
          )}
          <SurveyForm model={s.model} onSubmit={submit} />
        </>
      )}
    </main>
  );
}
