// Dashboard (#19): my groups with my role; per group its events and surveys with status and counts.
import { surveyStatus as coreStatus } from "@plainfeedback/core";
import { api, type Group, type SurveySummary } from "./api";
import { Link, usePageTitle } from "./router";
import { ErrorNote, paths, useLoad } from "./StaffApp";

const LABEL = { draft: "draft", not_yet_open: "not yet open", open: "open", closed: "closed" };
export const surveyStatus = (s: SurveySummary, now = new Date()) =>
  LABEL[coreStatus({ published: s.latestVersion !== null, closedAt: s.closed, ...s }, now)];

type Row = {
  slug: string;
  event: string;
  eventTitle: string;
  startsOn: string | null;
  survey: SurveySummary;
};

async function load(groups: Group[]) {
  // ponytail: one request per event (N+1); fine up to a few dozen events per group, then add a
  // server-side per-group survey listing. Admins who are not members get the group link only.
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
            startsOn: e.startsOn,
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
  usePageTitle("Your groups");
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
              <section
                className="table-wrap"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-focusable
                tabIndex={0}
                aria-label={`Surveys in ${g.name}`}
              >
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
                          {r.startsOn && <span className="meta"> {r.startsOn}</span>}
                        </td>
                        <th scope="row">
                          <Link href={paths.survey(g.id, r.slug, r.survey.slug)}>
                            {r.survey.slug}
                          </Link>
                        </th>
                        <td>{surveyStatus(r.survey)}</td>
                        <td>
                          {r.survey.latestVersion === null ? (
                            0
                          ) : (
                            <Link
                              href={paths.responses(g.id, r.slug, r.survey.slug)}
                              aria-label={`${r.survey.responseCount ?? 0} responses to ${r.survey.slug}`}
                            >
                              {r.survey.responseCount ?? 0}
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </section>
        ))
      )}
    </>
  );
}
