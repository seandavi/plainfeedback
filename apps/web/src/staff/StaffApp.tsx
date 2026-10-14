// Staff app under /app: sign-in state, header, and the groups -> events -> surveys -> editor pages.
// Routes: /app, /app/g/{groupId}, /app/g/{groupId}/e/{eventSlug}, .../s/{surveySlug}.
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
import { AdminPage } from "./Admin";
import { ApiError, api, canEdit, isOwner, type Me } from "./api";
import { Dashboard, surveyStatus } from "./Dashboard";
import { Editor } from "./Editor";
import { ConfirmButton, DeleteResponses, Members, Tokens, useAction } from "./Manage";
import { Link, navigate, usePath } from "./router";

export const LOGIN_URL = "/api/v1/auth/login";
const enc = encodeURIComponent;
export const paths = {
  groups: "/app",
  admin: "/app/admin",
  group: (g: string) => `/app/g/${enc(g)}`,
  event: (g: string, e: string) => `/app/g/${enc(g)}/e/${enc(e)}`,
  survey: (g: string, e: string, s: string) => `/app/g/${enc(g)}/e/${enc(e)}/s/${enc(s)}`,
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
    <p role="alert" className="form-message">
      {text} {e?.kind === "unauthenticated" && <a href={LOGIN_URL}>Sign in</a>}
    </p>
  );
}

const Loading = () => <p aria-busy="true">Loading…</p>;

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
  if (signedOut || err?.kind === "unauthenticated")
    body = (
      <section className="signin">
        <h1>Staff sign-in</h1>
        <p>Sign in to create and edit surveys for your groups.</p>
        <a className="button" href={LOGIN_URL}>
          Sign in
        </a>
      </section>
    );
  else if (err?.kind === "notFound")
    body = <p role="alert">Staff sign-in is not configured on this server.</p>;
  else if (me.error) body = <ErrorNote error={me.error} />;
  else if (!me.data) body = <Loading />;
  else body = route(path, me.data);

  return (
    <div className="staff">
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
      <main id="main">{body}</main>
    </div>
  );
}

function route(path: string, me: Me): ReactNode {
  const [g, e, s] = [
    /^\/app\/g\/([^/]+)/,
    /^\/app\/g\/[^/]+\/e\/([^/]+)/,
    /^\/app\/g\/[^/]+\/e\/[^/]+\/s\/([^/]+)\/?$/,
  ].map((re) => {
    const m = re.exec(path)?.[1];
    return m === undefined ? undefined : decodeURIComponent(m);
  });
  if (/^\/app\/admin\/?$/.test(path)) return <AdminPage me={me} />;
  if (g && e && s) return <EditorPage key={path} me={me} g={g} e={e} s={s} />;
  if (g && e) return <EventPage key={path} me={me} g={g} e={e} />;
  if (g) return <GroupPage key={path} me={me} g={g} />;
  if (/^\/app\/?$/.test(path)) return <Dashboard />;
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

/** Slug + title form used to create events and surveys. */
function CreateForm({
  legend,
  slugLabel,
  slugHint,
  onCreate,
}: {
  legend: string;
  slugLabel: string;
  slugHint: string;
  onCreate: (slug: string, title: string) => Promise<void>;
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
      await onCreate(String(f.get("slug")), String(f.get("title")).trim());
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
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const [group, events] = data.data;
  const create = async (slug: string, title: string) => {
    // PUT is an upsert; refuse to silently rename an existing event.
    if (events.some((x) => x.slug === slug))
      throw new Error(`An event with the short name "${slug}" already exists.`);
    await api.putEvent(g, slug, title);
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
              <span className="meta">{x.slug}</span>{" "}
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
        />
      )}
      <Members me={me} group={group} g={g} />
      <Tokens me={me} group={group} g={g} />
    </>
  );
}

const starter = (title: string) =>
  `# ${title}\n\nThank you for taking part. This survey takes about two minutes.\n\n::: {.text #comments multiline}\nAny comments?\n:::\n`;

function EventPage({ me, g, e }: { me: Me; g: string; e: string }) {
  const data = useLoad(async () => {
    const [group, event] = await Promise.all([api.group(g), api.event(g, e)]);
    return { group, event, surveys: await api.surveys(event.id) };
  }, `${g}/${e}`);
  const act = useAction(data.reload);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const { group, event, surveys } = data.data;
  const create = async (slug: string, title: string) => {
    try {
      await api.saveDraft(event.id, slug, starter(title)); // no If-Match: create only
    } catch (x) {
      if (x instanceof ApiError && x.status === 428)
        throw new Error(`A survey with the short name "${slug}" already exists.`);
      throw x;
    }
    navigate(paths.survey(g, e, slug));
  };
  return (
    <>
      <Crumbs items={[["Groups", paths.groups], [group.name, paths.group(g)], [event.title]]} />
      <h1>{event.title}</h1>
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
                {x.waveLabel && `, ${x.waveLabel}`}
              </span>{" "}
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
        />
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
      <Editor eventId={event.id} slug={s} readOnly={!canEdit(me, group)} />
    </>
  );
}
