// Dashboard (#19): my groups with my role; per group its events and surveys with status and counts.
import { api, type Group, type SurveySummary } from "./api";
import { Link } from "./router";
import { ErrorNote, paths, useLoad } from "./StaffApp";

/** draft / published (no open window) / open (inside the window) / not yet open / closed. */
export function surveyStatus(s: SurveySummary, now = new Date()) {
  if (s.latestVersion === null) return "draft";
  if (s.closed) return "closed";
  const { opensAt, closesAt } = s;
  if (opensAt && new Date(opensAt) > now) return "not yet open";
  if (closesAt && new Date(closesAt) <= now) return "closed";
  return opensAt || closesAt ? "open" : "published";
}

type Row = { slug: string; event: string; eventTitle: string; survey: SurveySummary };

async function load(groups: Group[]) {
  // ponytail: one call per event; admins who are not members get the group link only.
  return Promise.all(
    groups.map(async (g): Promise<[Group, Row[]]> => {
      if (!g.role) return [g, []];
      const events = await api.events(g.id);
      const per = await Promise.all(
        events.map(async (e) =>
          (await api.surveys(e.id)).map((survey) => ({
            slug: e.slug,
            event: e.id,
            eventTitle: e.title,
            survey,
          })),
        ),
      );
      return [g, per.flat()];
    }),
  );
}

export function Dashboard() {
  const data = useLoad(async () => load(await api.groups()), "dashboard");
  return (
    <>
      <h1>Your groups</h1>
      {data.error ? (
        <ErrorNote error={data.error} />
      ) : !data.data ? (
        <p aria-busy="true">Loading…</p>
      ) : data.data.length === 0 ? (
        <p>You are not in any group yet. Ask a group owner or an admin to add you.</p>
      ) : (
        data.data.map(([g, rows]) => (
          <section key={g.id} aria-labelledby={`g-${g.id}`}>
            <h2 id={`g-${g.id}`}>
              <Link href={paths.group(g.id)}>{g.name}</Link>{" "}
              <span className="meta">
                {g.role ?? "admin"}
                {g.archived && ", archived"}
              </span>
            </h2>
            {!g.role ? (
              <p className="meta">Open the group to see its events.</p>
            ) : rows.length === 0 ? (
              <p>No surveys yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Surveys in {g.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Survey</th>
                      <th scope="col">Status</th>
                      <th scope="col">Responses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.event}/${r.survey.slug}`}>
                        <td>
                          <Link href={paths.event(g.id, r.slug)}>{r.eventTitle}</Link>
                        </td>
                        <th scope="row">
                          <Link href={paths.survey(g.id, r.slug, r.survey.slug)}>
                            {r.survey.slug}
                          </Link>
                        </th>
                        <td>{surveyStatus(r.survey)}</td>
                        <td>{r.survey.responseCount ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))
      )}
    </>
  );
}
