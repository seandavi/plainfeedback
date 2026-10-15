// Survey editor (issue #8): markdown on the left, live preview on the right (stacked on narrow
// screens). compile() from core runs in the browser on every pause in typing; the server runs the
// same compiler on save and publish. Viewers get the same page read-only.
import { type CompileResult, compile, type Survey as Model } from "@plainfeedback/core";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Markdown } from "../markdown";
import { ShareLink } from "../ShareLink";
import { SurveyForm } from "../SurveyForm";
import { ApiError, api, type Survey, type Version, type VersionSummary } from "./api";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { useLeaveGuard } from "./router";
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
  const [dialog, setDialog] = useState<"conflict" | "publish" | "close">();
  const [theirs, setTheirs] = useState<Survey>(); // the draft someone else saved (412)
  const [published, setPublished] = useState<string>(); // markdown of the latest version
  const [justPublished, setJustPublished] = useState(false);
  const code = useRef<CodeEditorHandle>(null);
  const dirty = !readOnly && survey !== undefined && text !== saved;
  useLeaveGuard(dirty);
  const latest = versions[0];
  // Same comparison as the server's publish dedupe (the markdown; settings aside).
  const unpublished = latest !== undefined && published !== undefined && saved !== published;
  useEffect(() => {
    if (latest)
      api.version(eventId, slug, latest.version).then(
        (v) => setPublished(v.markdown),
        () => undefined, // ponytail: the cue is a hint; without it the page still works
      );
  }, [eventId, slug, latest]);

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

  const save = async (markdown: string, etag: string) => {
    try {
      const s = await api.saveDraft(eventId, slug, markdown, etag);
      setSurvey(s);
      setSaved(markdown);
      setDialog(undefined);
      setStatus("Draft saved.");
    } catch (x) {
      if (!(x instanceof ApiError && x.kind === "stale")) throw x;
      setTheirs(await api.survey(eventId, slug));
      setDialog("conflict");
    }
  };
  const saveNow = () => survey && !readOnly && run(() => save(text, survey.etag));
  const setClosed = (closed: boolean) =>
    run(async () => {
      const s = await api.setClosed(eventId, slug, closed);
      setSurvey(s);
      setDialog(undefined);
      setStatus(s.closed ? "Survey closed for responses." : "Survey reopened.");
    });

  if (loadError) return <ErrorNote error={loadError} />;
  if (!survey) return <p aria-busy="true">Loading…</p>;

  const errors = result?.errors ?? [];
  const title = good?.title ?? slug;
  const share = (
    // Keyed on the version so it re-reads `published` after a publish.
    <ShareLink key={latest?.version ?? 0} eventId={eventId} survey={slug} focus={justPublished} />
  );

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
          {unpublished && (
            <strong> · unpublished changes: participants still see v{latest.version}</strong>
          )}
          {latest?.closesAt && !survey.closed && ` · closes ${when(latest.closesAt)}`}
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
              className={!latest || unpublished ? "primary" : undefined}
              onClick={() => setDialog("publish")}
              disabled={busy || dirty}
              title={dirty ? "Save the draft before publishing" : undefined}
            >
              Publish…
            </button>
            <InsertMenu
              onPick={(type) =>
                code.current?.insert(SNIPPETS[type].replace("ID", freshId(type, text)))
              }
            />
            {survey.closed ? (
              <button type="button" disabled={busy} onClick={() => setClosed(false)}>
                Reopen survey
              </button>
            ) : (
              // Closing only matters once published; it always asks first.
              latest && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => setDialog("close")}
                >
                  Close survey…
                </button>
              )
            )}
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
      {latest && share}

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
        {!latest && share}
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

      {dialog === "conflict" && theirs && (
        <ConflictDialog
          mine={text}
          theirs={theirs}
          busy={busy}
          error={error}
          onClose={() => setDialog(undefined)}
          onOverwrite={() => run(() => save(text, theirs.etag))}
          onReload={() => {
            show(theirs);
            setDialog(undefined);
            setStatus("Loaded their version. Your changes were discarded.");
          }}
        />
      )}
      {dialog === "close" && (
        <Dialog title="Close this survey?" onClose={() => setDialog(undefined)}>
          <p>
            Participants can no longer respond, even if they have the link. Responses already
            submitted are kept. You can reopen it later.
          </p>
          <div className="actions">
            <button type="button" data-autofocus onClick={() => setDialog(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setClosed(true)}
            >
              Close survey
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
                ? `Published version ${v.version}. Share the link below.`
                : `Nothing changed since version ${v.version}; nothing new was published.`,
            );
            setPublished(v.markdown);
            setJustPublished(true);
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

  const changes = error instanceof ApiError ? error.changes : undefined;
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
        ...(changes && { force: true }), // the author has seen the changes below (#52)
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
            {prev?.closesAt && (
              <span className="meta">
                Kept from version {latest?.version}. Change it if this version should close at
                another time.
              </span>
            )}
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
          ) : changes ? (
            <div role="alert" className="form-message">
              <p>{(error as ApiError).message}</p>
              <ul>
                {changes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : (
            error !== undefined && <ErrorNote error={error} />
          )}
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "Publishing…" : changes ? "Publish anyway" : "Publish"}
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

/** Toolbar menu button (WAI-ARIA APG menu button): arrow keys only move focus; nothing is
 * inserted until an item is activated with Enter, Space or a click (#51). */
function InsertMenu({ onPick }: { onPick: (type: keyof typeof SNIPPETS) => void }) {
  const [open, setOpen] = useState<"first" | "last">();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const focusItem = (i: number) => {
    const all = items();
    all[(i + all.length) % all.length]?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the menu opens
  useEffect(() => {
    if (open) focusItem(open === "first" ? 0 : -1);
  }, [open]);
  const close = () => {
    setOpen(undefined);
    button.current?.focus();
  };
  return (
    <div className="menu">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open !== undefined}
        aria-controls={open && id}
        onClick={() => (open ? setOpen(undefined) : setOpen("first"))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(e.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        Insert question
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label="Insert question"
          onKeyDown={(e) => {
            const i = items().indexOf(document.activeElement as HTMLElement);
            const to = (
              { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 } as Record<string, number>
            )[e.key];
            if (to !== undefined) {
              e.preventDefault();
              focusItem(to);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") setOpen(undefined);
          }}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (!e.currentTarget.contains(next) && next !== button.current) setOpen(undefined);
          }}
        >
          {(Object.keys(SNIPPET_LABELS) as (keyof typeof SNIPPETS)[]).map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(undefined);
                onPick(k);
              }}
            >
              {SNIPPET_LABELS[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 412 on save: someone else saved first. The safe choice has focus; both versions are shown and
 * the user's text can be copied before anything is discarded (#70). */
function ConflictDialog({
  mine,
  theirs,
  busy,
  error,
  onClose,
  onOverwrite,
  onReload,
}: {
  mine: string;
  theirs: Survey;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onOverwrite: () => void;
  onReload: () => void;
}) {
  const [note, setNote] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const copy = () =>
    // Promise.resolve: no Clipboard API at all (plain http) also takes the fallback.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(mine))
      .then(
        () => setNote("Your version is on the clipboard."),
        () => {
          // Clipboard blocked: select the text so Ctrl+C works.
          const r = document.createRange();
          if (pre.current) r.selectNodeContents(pre.current);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(r);
          setNote("Copying was blocked. Your version is selected below; press Ctrl+C or Cmd+C.");
        },
      );
  // ponytail: lines missing from the other version are marked; a real diff if people need it.
  const side = (label: string, text: string, other: string, ref?: typeof pre) => {
    const others = new Set(other.split("\n"));
    return (
      <section className="pane">
        <h3>{label}</h3>
        <pre ref={ref} className="compare">
          {text.split("\n").map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            <span key={i}>
              {others.has(l) ? l : <mark>{l}</mark>}
              {"\n"}
            </span>
          ))}
        </pre>
      </section>
    );
  };
  return (
    <Dialog title="This draft changed elsewhere" onClose={onClose}>
      <p>
        Someone else saved this draft at {when(theirs.updatedAt)}, after you opened it. Your changes
        are not saved yet. Changed lines are highlighted.
      </p>
      <div className="split">
        {side("Your version", mine, theirs.markdown, pre)}
        {side("Their version", theirs.markdown, mine)}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <p role="status">{note}</p>
      <div className="actions">
        <button type="button" data-autofocus onClick={onClose}>
          Keep editing
        </button>
        <button type="button" onClick={copy}>
          Copy my version
        </button>
        <button type="button" disabled={busy} onClick={onOverwrite}>
          Overwrite with mine
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onReload}>
          Discard mine and load theirs
        </button>
      </div>
    </Dialog>
  );
}

/** Modal dialog: focus moves in on open (the [data-autofocus] control, else the first one) and
 * back to the opener on close. */
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
    (
      d.querySelector<HTMLElement>("[data-autofocus]") ??
      d.querySelector<HTMLElement>("textarea, input, button")
    )?.focus();
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
