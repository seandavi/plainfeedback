// Survey editor (issue #8): markdown on the left, live preview on the right (stacked on narrow
// screens). compile() from core runs in the browser on every pause in typing; the server runs the
// same compiler on save and publish. Viewers get the same page read-only.
import { type CompileResult, compile, type Survey as Model } from "@plainfeedback/core";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "../markdown";
import { ShareLink } from "../ShareLink";
import { SurveyForm } from "../SurveyForm";
import { ApiError, api, type Survey, type Version, type VersionSummary } from "./api";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { useLeaveGuard, usePageTitle } from "./router";
import { ErrorNote } from "./StaffApp";

const COMPILE_DELAY_MS = 300;
export const GRAMMAR_URL = "https://github.com/seandavi/plainfeedback/blob/main/docs/grammar.md";

// Examples from docs/grammar.md; ID is replaced with an id not yet used in the survey.
export const SNIPPETS = {
  choice: `::: {.choice #ID required other="Other"}\nWhat is your role?\n- Researcher\n- Student\n:::`,
  multi: `::: {.multi #ID}\nWhich topics interest you?\n- Data\n- Tools\n:::`,
  likert: `::: {.likert #ID scale="1-5" low="Poor" mid="Okay" high="Excellent"}\nRate each part of the event:\n- Content\n- Venue\n:::`,
  text: `::: {.text #ID multiline maxlength=2000}\nAny other comments?\n:::`,
  number: `::: {.number #ID min=0 max=60}\nHow many years have you worked in this field?\n:::`,
};
const SNIPPET_LABELS: Record<keyof typeof SNIPPETS, string> = {
  choice: "Single choice",
  multi: "Multiple choice",
  likert: "Rating grid (Likert)",
  text: "Free text",
  number: "Number",
};
const freshId = (type: string, text: string) => {
  let n = 1;
  while (new RegExp(`#${type}-${n}(?![\\w-])`).test(text)) n++;
  return `${type}-${n}`;
};

const when = (iso: string) => new Date(iso).toLocaleString();
// <input type="datetime-local"> works in local time without a zone.
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function Editor({
  eventId,
  slug,
  readOnly,
}: {
  eventId: string;
  slug: string;
  readOnly: boolean;
}) {
  const [survey, setSurvey] = useState<Survey>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loadError, setLoadError] = useState<unknown>();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(""); // markdown as last loaded or saved
  const [result, setResult] = useState<CompileResult>();
  const [good, setGood] = useState<Model>(); // last model without errors, kept while errors show
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>();
  const [dialog, setDialog] = useState<"conflict" | "publish">();
  const code = useRef<CodeEditorHandle>(null);
  const dirty = !readOnly && survey !== undefined && text !== saved;
  useLeaveGuard(dirty);

  const show = useCallback((s: Survey) => {
    setSurvey(s);
    setText(s.markdown);
    setSaved(s.markdown);
  }, []);
  const load = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([api.survey(eventId, slug), api.versions(eventId, slug)]);
      show(s);
      setVersions(v);
    } catch (x) {
      setLoadError(x);
    }
  }, [eventId, slug, show]);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (survey === undefined) return;
    const t = setTimeout(() => {
      const r = compile(text);
      setResult(r);
      if (r.model) setGood(r.model);
    }, COMPILE_DELAY_MS);
    return () => clearTimeout(t);
  }, [text, survey]);

  // Runs a toolbar action with one busy flag and one place for errors.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      await action();
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  };

  const save = (markdown: string, etag: string) =>
    run(async () => {
      try {
        const s = await api.saveDraft(eventId, slug, markdown, etag);
        setSurvey(s);
        setSaved(markdown);
        setDialog(undefined);
        setStatus("Draft saved.");
      } catch (x) {
        if (x instanceof ApiError && x.kind === "stale") return setDialog("conflict");
        throw x;
      }
    });
  const saveNow = () => survey && !readOnly && save(text, survey.etag);

  usePageTitle(survey && `Edit: ${good?.title ?? slug}`);

  if (loadError) return <ErrorNote error={loadError} />;
  if (!survey) return <p aria-busy="true">Loading…</p>;

  const errors = result?.errors ?? [];
  const title = good?.title ?? slug;
  const latest = versions[0];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl/Cmd+S shortcut for the whole editor
    <div
      className="editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          saveNow();
        }
      }}
    >
      <div className="editor-head">
        <h1>{title}</h1>
        <p className="meta">
          {latest ? `Published v${latest.version}` : "Not published"}
          {survey.closed && " · closed for responses"}
          {readOnly && " · read-only (viewer)"}
          {dirty && " · unsaved changes"}
        </p>
      </div>

      <div className="toolbar">
        {!readOnly && (
          <>
            <button type="button" onClick={saveNow} disabled={busy || !dirty}>
              Save draft
            </button>
            <button
              type="button"
              onClick={() => setDialog("publish")}
              disabled={busy || dirty}
              title={dirty ? "Save the draft before publishing" : undefined}
            >
              Publish…
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const s = await api.setClosed(eventId, slug, !survey.closed);
                  setSurvey(s);
                  setStatus(s.closed ? "Survey closed for responses." : "Survey reopened.");
                })
              }
            >
              {survey.closed ? "Reopen survey" : "Close survey"}
            </button>
            <select
              aria-label="Insert a question"
              value=""
              onChange={(e) => {
                const type = e.target.value as keyof typeof SNIPPETS;
                if (type in SNIPPETS)
                  code.current?.insert(SNIPPETS[type].replace("ID", freshId(type, text)));
              }}
            >
              <option value="">Insert question…</option>
              {Object.entries(SNIPPET_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </>
        )}
        <a href={GRAMMAR_URL} target="_blank" rel="noopener noreferrer">
          Survey markdown guide
        </a>
      </div>
      <p role="status" className="status">
        {status}
      </p>
      {error !== undefined && <ErrorNote error={error} />}
      {dirty && <p className="meta">Save the draft before publishing.</p>}

      <div className="split">
        <section aria-labelledby="source-h" className="pane">
          <h2 id="source-h">Markdown</h2>
          {errors.length > 0 && (
            <div className="problems" aria-live="polite">
              <p>
                <strong>
                  {errors.length === 1 ? "1 problem" : `${errors.length} problems`} to fix:
                </strong>
              </p>
              <ul>
                {errors.map((x) => (
                  <li key={`${x.line}:${x.column}:${x.message}`}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => code.current?.goToLine(x.line)}
                    >
                      Line {x.line}
                    </button>
                    : {x.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <CodeEditor
            ref={code}
            value={text}
            onChange={setText}
            diagnostics={errors}
            readOnly={readOnly}
            label={readOnly ? "Survey markdown (read-only)" : "Survey markdown"}
          />
        </section>
        <section aria-labelledby="preview-h" className="pane preview">
          <h2 id="preview-h">Preview</h2>
          {errors.length > 0 && good && (
            <p className="banner">The preview shows the last version without problems.</p>
          )}
          {good ? (
            <>
              <h3 className="preview-title">{good.title}</h3>
              {good.intro && <Markdown text={good.intro} />}
              <SurveyForm
                key={good.pages
                  .flatMap((p) => p.questions)
                  .map((q) => `${q.id}:${q.type}`)
                  .join()}
                model={good}
                mode="preview"
              />
            </>
          ) : (
            <p>Nothing to preview until the survey has no problems.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="versions-h" className="versions">
        <h2 id="versions-h">Published versions</h2>
        {/* Keyed on the version so it re-reads `published` after a publish. */}
        <ShareLink key={latest?.version ?? 0} eventId={eventId} survey={slug} />
        {versions.length === 0 ? (
          <p>Not published yet. Participants see only published versions.</p>
        ) : (
          <ol reversed>
            {versions.map((v) => (
              <li key={v.version}>
                Version {v.version}, published {when(v.publishedAt)}
                {v.opensAt && `, opens ${when(v.opensAt)}`}
                {v.closesAt && `, closes ${when(v.closesAt)}`}
              </li>
            ))}
          </ol>
        )}
      </section>

      {dialog === "conflict" && (
        <Dialog title="This draft changed elsewhere" onClose={() => setDialog(undefined)}>
          <p>
            Someone saved this draft after you opened it. Reload their version (your changes are
            lost), or overwrite it with yours.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  show(await api.survey(eventId, slug));
                  setDialog(undefined);
                  setStatus("Reloaded the latest draft.");
                })
              }
            >
              Reload theirs
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const fresh = await api.survey(eventId, slug).catch((x) => setError(x));
                if (fresh) save(text, fresh.etag);
              }}
            >
              Overwrite with mine
            </button>
            <button type="button" onClick={() => setDialog(undefined)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "publish" && (
        <PublishDialog
          eventId={eventId}
          slug={slug}
          latest={latest}
          onClose={() => setDialog(undefined)}
          onPublished={async (v, created) => {
            setDialog(undefined);
            setStatus(
              created
                ? `Published version ${v.version}.`
                : `Nothing changed since version ${v.version}; nothing new was published.`,
            );
            setVersions(await api.versions(eventId, slug).catch(() => versions));
          }}
        />
      )}
    </div>
  );
}

function PublishDialog({
  eventId,
  slug,
  latest,
  onClose,
  onPublished,
}: {
  eventId: string;
  slug: string;
  latest?: VersionSummary;
  onClose: () => void;
  onPublished: (v: Version, created: boolean) => void;
}) {
  const [prev, setPrev] = useState<Version | null>(latest ? null : ({} as Version));
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (latest) api.version(eventId, slug, latest.version).then(setPrev, setError);
  }, [eventId, slug, latest]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const privacy = String(f.get("privacy")).trim();
    setBusy(true);
    setError(undefined);
    try {
      const v = await api.publish(eventId, slug, {
        ...(privacy && { privacyStatement: privacy }),
        opensAt: fromLocalInput(String(f.get("opensAt"))),
        closesAt: fromLocalInput(String(f.get("closesAt"))),
      });
      onPublished(v, !latest || v.version > latest.version);
    } catch (x) {
      setError(x);
      setBusy(false);
    }
  };

  const compileErrors = error instanceof ApiError ? error.compileErrors : undefined;
  return (
    <Dialog title="Publish this survey" onClose={onClose}>
      {!prev && !error ? (
        <p aria-busy="true">Loading…</p>
      ) : (
        <form onSubmit={submit} className="publish">
          <p>
            Publishing makes the saved draft the version participants see. Published versions cannot
            be changed; publish again to update.
          </p>
          <label>
            Privacy statement (shown to participants)
            <textarea
              name="privacy"
              rows={6}
              autoFocus
              defaultValue={prev?.privacyStatement ?? ""}
            />
            <span className="meta">Leave empty to use the default statement.</span>
          </label>
          <label>
            Opens (optional)
            <input
              type="datetime-local"
              name="opensAt"
              defaultValue={toLocalInput(prev?.opensAt ?? null)}
            />
          </label>
          <label>
            Closes (optional)
            <input
              type="datetime-local"
              name="closesAt"
              defaultValue={toLocalInput(prev?.closesAt ?? null)}
            />
          </label>
          {compileErrors ? (
            <div role="alert" className="form-message">
              <p>The saved draft has problems, so it cannot be published:</p>
              <ul>
                {compileErrors.map((x) => (
                  <li key={`${x.line}:${x.message}`}>
                    Line {x.line}: {x.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            error !== undefined && <ErrorNote error={error} />
          )}
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "Publishing…" : "Publish"}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Modal dialog: focus moves in on open (first control) and back to the opener on close. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = `dialog-${title.replace(/\W+/g, "-").toLowerCase()}`;
  useEffect(() => {
    const d = ref.current as HTMLDialogElement;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", ""); // jsdom
    d.querySelector<HTMLElement>("textarea, input, button")?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault(); // Escape: let React unmount it
        onClose();
      }}
    >
      <h2 id={id}>{title}</h2>
      {children}
    </dialog>
  );
}
