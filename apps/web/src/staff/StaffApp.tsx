// Staff app under /app: sign-in state, header, and the groups -> events -> surveys -> editor pages.
// Routes: /app, /app/g/{groupId}, /app/g/{groupId}/e/{eventSlug}, .../s/{surveySlug}[/responses].
// Later staff screens (#19: admin, members) add a route to `route` and reuse useLoad/ErrorNote.
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import cfdeExample from "../../../../packages/core/src/fixtures/cfde-fall-2026.md?raw";
import { AdminPage } from "./Admin";
import { ApiError, api, canEdit, type Event, isOwner, type Me, type Wave } from "./api";
import { Dashboard, surveyStatus } from "./Dashboard";
import { Dialog, Editor } from "./Editor";
import { ConfirmButton, DeleteResponses, Members, Tokens, useAction } from "./Manage";
import { Responses } from "./Responses";
import { Link, navigate, usePageTitle, usePath } from "./router";

export const LOGIN_URL = "/api/v1/auth/login";
const enc = encodeURIComponent;
export const paths = {
  groups: "/app",
  admin: "/app/admin",
  group: (g: string) => `/app/g/${enc(g)}`,
  event: (g: string, e: string) => `/app/g/${enc(g)}/e/${enc(e)}`,
  survey: (g: string, e: string, s: string) => `/app/g/${enc(g)}/e/${enc(e)}/s/${enc(s)}`,
  responses: (g: string, e: string, s: string) =>
    `/app/g/${enc(g)}/e/${enc(e)}/s/${enc(s)}/responses`,
};
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // same rule as the server's slug schema
/** "Fall Meeting 2026!" -> "fall-meeting-2026" (accents dropped, at most 64 characters). */
export const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");

/** Loads data for a page; `reload` re-runs it. Errors are ApiErrors (or anything thrown). */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data?: T; error?: unknown }>({});
  const fn = useRef(load);
  fn.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads when the caller's key changes
  const reload = useCallback(() => {
    let live = true;
    fn.current().then(
      (data) => live && setState({ data }),
      (error) => live && setState({ error }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

/** User-facing text for an API error; 401 links to sign in again. */
export function ErrorNote({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : undefined;
  const text =
    e?.kind === "unauthenticated"
      ? "Your session has ended."
      : e?.kind === "notFound"
        ? "Not found, or you do not have access."
        : e?.kind === "forbidden"
          ? "Your role does not allow this."
          : error instanceof Error
            ? error.message
            : "Something went wrong.";
  return (
    <p role="alert" className="empty error-note">
      {text} {e?.kind === "unauthenticated" && <a href={LOGIN_URL}>Sign in</a>}
    </p>
  );
}

const Loading = () => <p aria-busy="true">Loading…</p>;

const SignIn = () => {
  usePageTitle("Sign in");
  return (
    <section className="signin">
      <h1>Staff sign-in</h1>
      <p>Sign in to create and edit surveys for your groups.</p>
      <a className="button" href={LOGIN_URL}>
        Sign in
      </a>
    </section>
  );
};

export function StaffApp() {
  const path = usePath();
  const me = useLoad(api.me, "me");
  const [signedOut, setSignedOut] = useState(false);

  const logout = async () => {
    if (!navigate(paths.groups)) return;
    await api.logout().catch(() => undefined);
    setSignedOut(true);
  };

  let body: ReactNode;
  const err = me.error instanceof ApiError ? me.error : undefined;
  if (signedOut || err?.kind === "unauthenticated") body = <SignIn />;
  else if (err?.kind === "notFound")
    body = <p role="alert">Staff sign-in is not configured on this server.</p>;
  else if (me.error) body = <ErrorNote error={me.error} />;
  else if (!me.data) body = <Loading />;
  else body = route(path, me.data);

  return (
    <div className="staff">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link href={paths.groups} className="brand">
          plainfeedback
        </Link>
        {me.data && !signedOut && (
          <span className="who">
            {me.data.isAdmin && <Link href={paths.admin}>Admin</Link>}
            <span>{me.data.email}</span>
            <button type="button" onClick={logout}>
              Sign out
            </button>
          </span>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        {body}
      </main>
    </div>
  );
}

function route(path: string, me: Me): ReactNode {
  const [g, e, s, rs] = [
    /^\/app\/g\/([^/]+)/,
    /^\/app\/g\/[^/]+\/e\/([^/]+)/,
    /^\/app\/g\/[^/]+\/e\/[^/]+\/s\/([^/]+)\/?$/,
    /^\/app\/g\/[^/]+\/e\/[^/]+\/s\/([^/]+)\/responses\/?$/,
  ].map((re) => {
    const m = re.exec(path)?.[1];
    return m === undefined ? undefined : decodeURIComponent(m);
  });
  if (/^\/app\/admin\/?$/.test(path)) return <AdminPage me={me} />;
  if (g && e && rs) return <ResponsesPage key={path} me={me} g={g} e={e} s={rs} />;
  if (g && e && s) return <EditorPage key={path} me={me} g={g} e={e} s={s} />;
  if (g && e) return <EventPage key={path} me={me} g={g} e={e} />;
  if (g) return <GroupPage key={path} me={me} g={g} />;
  if (/^\/app\/?$/.test(path)) return <Dashboard me={me} />;
  return <p role="alert">Page not found.</p>;
}

const Crumbs = ({ items }: { items: [string, string?][] }) => (
  <nav aria-label="Breadcrumb" className="crumbs">
    <ol>
      {items.map(([label, href]) => (
        <li key={label}>
          {href ? <Link href={href}>{label}</Link> : <span aria-current="page">{label}</span>}
        </li>
      ))}
    </ol>
  </nav>
);

const WAVES = ["pre", "post", "followup", "other"] as const;
const waveOf = (v: unknown): Wave | null => (WAVES.includes(v as Wave) ? (v as Wave) : null);
const WaveOptions = () => (
  <>
    <option value="">not a wave</option>
    {WAVES.map((w) => (
      <option key={w} value={w}>
        {w}
      </option>
    ))}
  </>
);
const eventDates = (e: { startsOn: string | null; endsOn: string | null }) =>
  e.endsOn && e.endsOn !== e.startsOn ? `${e.startsOn} to ${e.endsOn}` : e.startsOn;

/** Slug + title form used to create events and surveys. */
function CreateForm({
  legend,
  slugLabel,
  slugHint,
  onCreate,
  children,
}: {
  legend: string;
  slugLabel: string;
  slugHint: string;
  onCreate: (slug: string, title: string, f: FormData) => Promise<void>;
  children?: ReactNode; // extra fields, read by onCreate from the FormData
}) {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  // The short name follows the title until the user edits it (#72).
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [slugError, setSlugError] = useState("");
  const slugInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const check = (v: string) =>
    v === "" || SLUG.test(v)
      ? ""
      : "Use only lowercase letters, digits and single hyphens between them, like fall-2026.";
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const problem = slug ? check(slug) : "Enter a short name.";
    setSlugError(problem);
    if (problem) return slugInput.current?.focus();
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(String(f.get("slug")), String(f.get("title")).trim(), f);
    } catch (x) {
      setError(x);
      setBusy(false);
    }
  };
  return (
    <form className="create" onSubmit={submit}>
      <fieldset>
        <legend>{legend}</legend>
        <label>
          Title{" "}
          <input
            name="title"
            required
            maxLength={200}
            onChange={(e) => !touched && setSlug(slugify(e.target.value))}
          />
        </label>
        <label>
          {slugLabel}{" "}
          <input
            ref={slugInput}
            name="slug"
            maxLength={64}
            value={slug}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={hintId}
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value);
              if (slugError) setSlugError(check(e.target.value));
            }}
            onBlur={() => setSlugError(check(slug))}
          />
          <span className="meta" id={hintId}>
            {slugError ? <strong>{slugError}</strong> : slugHint}
          </span>
        </label>
        {children}
        <button type="submit" disabled={busy}>
          Create
        </button>
        {error !== undefined && <ErrorNote error={error} />}
      </fieldset>
    </form>
  );
}

function GroupPage({ me, g }: { me: Me; g: string }) {
  const data = useLoad(() => Promise.all([api.group(g), api.events(g)]), g);
  const act = useAction(data.reload);
  usePageTitle(data.data?.[0].name);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const [group, events] = data.data;
  const create = async (slug: string, title: string, f: FormData) => {
    // PUT is an upsert; refuse to silently rename an existing event.
    if (events.some((x) => x.slug === slug))
      throw new Error(`An event with the short name "${slug}" already exists.`);
    await api.putEvent(g, slug, title, {
      startsOn: String(f.get("startsOn")) || null,
      endsOn: String(f.get("endsOn")) || null,
    });
    navigate(paths.event(g, slug));
  };
  return (
    <>
      <Crumbs items={[["Groups", paths.groups], [group.name]]} />
      <h1>{group.name}</h1>
      <h2>Events</h2>
      {events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul className="list">
          {events.map((x) => (
            <li key={x.id}>
              <Link href={paths.event(g, x.slug)}>{x.title}</Link>{" "}
              <span className="meta">
                {x.slug}
                {x.startsOn && `, ${eventDates(x)}`}
              </span>{" "}
              {isOwner(me, group) && (
                <ConfirmButton
                  label="Delete"
                  name={x.title}
                  title="Delete event"
                  onConfirm={() => act.run(() => api.deleteEvent(g, x.slug))}
                >
                  Permanently delete {x.title} with all its surveys and responses? This cannot be
                  undone. Backups keep a copy until they expire.
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {act.error !== undefined && <ErrorNote error={act.error} />}
      {canEdit(me, group) && (
        <CreateForm
          legend="New event"
          slugLabel="Short name (used in staff links and exports)"
          slugHint="Filled in from the title. Lowercase letters, digits and hyphens, e.g. fall-2026."
          onCreate={create}
        >
          <label>
            Starts on <input type="date" name="startsOn" />
          </label>
          <label>
            Ends on <input type="date" name="endsOn" />
          </label>
        </CreateForm>
      )}
      <Members me={me} group={group} g={g} />
      <Tokens me={me} group={group} g={g} />
    </>
  );
}

const starter = (title: string) =>
  `# ${title}\n\nThank you for taking part. This survey takes about two minutes.\n\n::: {.text #comments multiline}\nAny comments?\n:::\n`;
// Templates (#74): a template is just markdown to start from; its question ids are kept on purpose
// so answers stay comparable across events (docs/grammar.md, "The id").
const TEMPLATES: Record<string, { label: string; markdown: (title: string) => string }> & {
  blank: { label: string; markdown: (title: string) => string };
} = {
  blank: { label: "Blank (one comment question)", markdown: starter },
  cfde: {
    label: "CFDE event feedback (example)",
    markdown: (title) => cfdeExample.replace(/^# .*/, `# ${title}`),
  },
};

/** Creates a new draft; never overwrites (no If-Match means create only). */
async function createDraft(eventId: string, slug: string, markdown: string, wave?: Wave | null) {
  try {
    await api.saveDraft(eventId, slug, markdown, undefined, wave);
  } catch (x) {
    if (x instanceof ApiError && x.status === 428)
      throw new Error(`A survey with the short name "${slug}" already exists there.`);
    throw x;
  }
}

/** Duplicate (#74): copies a survey's draft markdown into a new survey in this or another event of
 * the same group. Creator or higher; the server checks both events. */
function Duplicate({
  g,
  event,
  events,
  slug,
}: {
  g: string;
  event: Event;
  events: Event[];
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const to = events.find((x) => x.id === f.get("event")) ?? event;
    const newSlug = String(f.get("slug"));
    setError(undefined);
    try {
      const src = await api.survey(event.id, slug);
      await createDraft(to.id, newSlug, src.markdown);
      navigate(paths.survey(g, to.slug, newSlug));
    } catch (x) {
      setError(x);
    }
  };
  return (
    <>
      <button type="button" aria-label={`Duplicate ${slug}`} onClick={() => setOpen(true)}>
        Duplicate
      </button>
      {open && (
        <Dialog title={`Duplicate ${slug}`} onClose={() => setOpen(false)}>
          <form className="publish" onSubmit={submit}>
            <p>
              Copies the current draft, with the same question ids so answers can be compared.
              Responses are not copied.
            </p>
            <label>
              Into event
              <select name="event" defaultValue={event.id}>
                {events.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Short name of the copy
              <input
                name="slug"
                required
                pattern={SLUG.source}
                maxLength={64}
                defaultValue={slug}
              />
            </label>
            {error !== undefined && <ErrorNote error={error} />}
            <div className="actions">
              <button type="submit">Duplicate</button>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function EventPage({ me, g, e }: { me: Me; g: string; e: string }) {
  const data = useLoad(async () => {
    const [group, event, events] = await Promise.all([
      api.group(g),
      api.event(g, e),
      api.events(g),
    ]);
    return { group, event, events, surveys: await api.surveys(event.id) };
  }, `${g}/${e}`);
  const act = useAction(data.reload);
  usePageTitle(data.data?.event.title);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const { group, event, events, surveys } = data.data;
  const create = async (slug: string, title: string, f: FormData) => {
    const t = TEMPLATES[String(f.get("template"))] ?? TEMPLATES.blank;
    await createDraft(event.id, slug, t.markdown(title), waveOf(f.get("waveLabel")));
    navigate(paths.survey(g, e, slug));
  };
  return (
    <>
      <Crumbs items={[["Groups", paths.groups], [group.name, paths.group(g)], [event.title]]} />
      <h1>{event.title}</h1>
      {event.startsOn && <p className="meta">{eventDates(event)}</p>}
      <h2>Surveys</h2>
      {surveys.length === 0 ? (
        <p>No surveys yet.</p>
      ) : (
        <ul className="list">
          {surveys.map((x) => (
            <li key={x.slug}>
              <Link href={paths.survey(g, e, x.slug)}>{x.title || x.slug}</Link>{" "}
              <span className="meta">
                {x.title && `${x.slug}, `}
                {x.latestVersion ? `published v${x.latestVersion}, ${surveyStatus(x)}` : "draft"}
              </span>{" "}
              {x.latestVersion !== null && (
                <Link href={paths.responses(g, e, x.slug)}>
                  {x.responseCount === 1 ? "1 response" : `${x.responseCount ?? 0} responses`}
                </Link>
              )}{" "}
              {canEdit(me, group) ? (
                <label className="meta">
                  Wave{" "}
                  <select
                    value={x.waveLabel ?? ""}
                    onChange={(ev) =>
                      act.run(() => api.setWave(event.id, x.slug, waveOf(ev.target.value)))
                    }
                  >
                    <WaveOptions />
                  </select>
                </label>
              ) : (
                x.waveLabel && <span className="meta">{x.waveLabel}</span>
              )}{" "}
              {canEdit(me, group) && (
                <Duplicate g={g} event={event} events={events} slug={x.slug} />
              )}{" "}
              {(isOwner(me, group) || (canEdit(me, group) && !x.latestVersion)) && (
                <ConfirmButton
                  label="Delete"
                  name={x.slug}
                  title="Delete survey"
                  onConfirm={() => act.run(() => api.deleteSurvey(event.id, x.slug))}
                >
                  Permanently delete {x.slug} with all its versions and responses? This cannot be
                  undone. Backups keep a copy until they expire.
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {act.error !== undefined && <ErrorNote error={act.error} />}
      {canEdit(me, group) && (
        <CreateForm
          legend="New survey"
          slugLabel="Short name (used in exports and staff links)"
          slugHint="Filled in from the title. Participants never see it. E.g. pre, post, followup."
          onCreate={create}
        >
          <label>
            Wave{" "}
            <select name="waveLabel">
              <WaveOptions />
            </select>
          </label>
          <label>
            Start from{" "}
            <select name="template" defaultValue="blank">
              {Object.entries(TEMPLATES).map(([k, t]) => (
                <option key={k} value={k}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="meta">
              To reuse another survey, use Duplicate next to it (it keeps the question ids).
            </span>
          </label>
        </CreateForm>
      )}
      {isOwner(me, group) && (
        <DeleteResponses
          eventId={event.id}
          surveys={surveys.filter((x) => x.latestVersion).map((x) => x.slug)}
          onDone={data.reload}
        />
      )}
    </>
  );
}

function EditorPage({ me, g, e, s }: { me: Me; g: string; e: string; s: string }) {
  const data = useLoad(async () => {
    const [group, event] = await Promise.all([api.group(g), api.event(g, e)]);
    return { group, event };
  }, `${g}/${e}`);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const { group, event } = data.data;
  return (
    <>
      <Crumbs
        items={[
          ["Groups", paths.groups],
          [group.name, paths.group(g)],
          [event.title, paths.event(g, e)],
          [s],
        ]}
      />
      <p>
        <Link href={paths.responses(g, e, s)}>Responses and downloads</Link>
      </p>
      <Editor eventId={event.id} slug={s} readOnly={!canEdit(me, group)} />
    </>
  );
}

function ResponsesPage({ me, g, e, s }: { me: Me; g: string; e: string; s: string }) {
  const data = useLoad(async () => {
    const [group, event] = await Promise.all([api.group(g), api.event(g, e)]);
    return { group, event };
  }, `${g}/${e}`);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const { group, event } = data.data;
  return (
    <>
      <Crumbs
        items={[
          ["Groups", paths.groups],
          [group.name, paths.group(g)],
          [event.title, paths.event(g, e)],
          [s, paths.survey(g, e, s)],
          ["Responses"],
        ]}
      />
      <Responses me={me} group={group} eventId={event.id} slug={s} />
    </>
  );
}
