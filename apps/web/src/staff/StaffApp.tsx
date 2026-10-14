// Staff app under /app: sign-in state, header, and the groups -> events -> surveys -> editor pages.
// Routes: /app, /app/g/{groupId}, /app/g/{groupId}/e/{eventSlug}, .../s/{surveySlug}.
// Later staff screens (#19: admin, members) add a route to `route` and reuse useLoad/ErrorNote.
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, canEdit, type Me } from "./api";
import { Editor } from "./Editor";
import { Link, navigate, usePath } from "./router";

export const LOGIN_URL = "/api/v1/auth/login";
const enc = encodeURIComponent;
export const paths = {
  groups: "/app",
  group: (g: string) => `/app/g/${enc(g)}`,
  event: (g: string, e: string) => `/app/g/${enc(g)}/e/${enc(e)}`,
  survey: (g: string, e: string, s: string) => `/app/g/${enc(g)}/e/${enc(e)}/s/${enc(s)}`,
};
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*"; // same rule as the server's slug schema

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
          : e
            ? e.message
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
  if (g && e && s) return <EditorPage key={path} me={me} g={g} e={e} s={s} />;
  if (g && e) return <EventPage key={path} me={me} g={g} e={e} />;
  if (g) return <GroupPage key={path} me={me} g={g} />;
  if (/^\/app\/?$/.test(path)) return <GroupsPage />;
  return <p role="alert">Page not found.</p>;
}

function GroupsPage() {
  const groups = useLoad(api.groups, "groups");
  return (
    <>
      <h1>Your groups</h1>
      {groups.error ? (
        <ErrorNote error={groups.error} />
      ) : !groups.data ? (
        <Loading />
      ) : groups.data.length === 0 ? (
        <p>You are not in any group yet. Ask a group owner or an admin to add you.</p>
      ) : (
        <ul className="list">
          {groups.data.map((x) => (
            <li key={x.id}>
              <Link href={paths.group(x.id)}>{x.name}</Link>{" "}
              <span className="meta">
                {x.role ?? "admin"}
                {x.archived && ", archived"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
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
  onCreate,
}: {
  legend: string;
  onCreate: (slug: string, title: string) => Promise<void>;
}) {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
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
          Title <input name="title" required maxLength={200} />
        </label>
        <label>
          Short name for links <input name="slug" required pattern={SLUG} maxLength={64} />
          <span className="meta">lowercase letters, digits and single hyphens, e.g. fall-2026</span>
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
              <span className="meta">{x.slug}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit(me, group) && <CreateForm legend="New event" onCreate={create} />}
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
              <Link href={paths.survey(g, e, x.slug)}>{x.slug}</Link>{" "}
              <span className="meta">
                {x.latestVersion ? `published v${x.latestVersion}` : "draft"}
                {x.closed && ", closed"}
                {x.waveLabel && `, ${x.waveLabel}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit(me, group) && <CreateForm legend="New survey" onCreate={create} />}
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
