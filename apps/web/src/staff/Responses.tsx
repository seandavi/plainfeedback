// Responses page (#50), viewer or higher: count, CSV/JSONL download links to the export endpoint,
// and the responses in submission order, a page at a time (seq cursor). Answers are respondent
// input: they are only ever React text nodes, never markdown or HTML. Owners can delete one
// response here. No aggregates: any per-option counts must suppress cells < 5 first (#46).
import { useRef, useState } from "react";
import { api, type Group, isOwner, type Me, type ResponseRow } from "./api";
import { ConfirmButton } from "./Manage";
import { usePageTitle } from "./router";
import { ErrorNote, useLoad } from "./StaffApp";

export const PAGE = 50;

/** Plain-text rendering of one answer: lists joined with "; ", Likert as "1: 4, 2: 5". */
export const answerText = (v: unknown): string =>
  Array.isArray(v)
    ? v.map(String).join("; ")
    : v !== null && typeof v === "object"
      ? Object.entries(v)
          .map(([k, x]) => `${k}: ${String(x)}`)
          .join(", ")
      : String(v);

export function Responses({
  me,
  group,
  eventId,
  slug,
}: {
  me: Me;
  group: Group;
  eventId: string;
  slug: string;
}) {
  const [rows, setRows] = useState<ResponseRow[]>([]);
  const [more, setMore] = useState(false);
  const [deleted, setDeleted] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>();
  const table = useRef<HTMLElement>(null);
  const data = useLoad(async () => {
    const [list, first] = await Promise.all([
      api.surveys(eventId),
      api.responses(eventId, slug, PAGE),
    ]);
    setRows(first);
    setMore(first.length === PAGE);
    return list.find((x) => x.slug === slug)?.responseCount ?? 0;
  }, `${eventId}/${slug}`);
  usePageTitle(data.data === undefined ? undefined : `Responses: ${slug}`);

  const next = async () => {
    setError(undefined);
    try {
      const page = await api.responses(eventId, slug, PAGE, rows.at(-1)?.seq);
      setRows((r) => [...r, ...page]);
      setMore(page.length === PAGE);
    } catch (x) {
      setError(x);
    }
  };
  const remove = async (id: string) => {
    setError(undefined);
    setNote("");
    try {
      await api.deleteResponse(eventId, slug, id);
      setRows((r) => r.filter((x) => x.responseId !== id));
      setDeleted((n) => n + 1);
      setNote("Deleted 1 response.");
      table.current?.focus(); // the row and its button are gone
    } catch (x) {
      setError(x);
    }
  };

  if (data.error) return <ErrorNote error={data.error} />;
  if (data.data === undefined) return <p aria-busy="true">Loading…</p>;
  const count = data.data - deleted;
  const owner = isOwner(me, group);
  return (
    <>
      <h1>Responses: {slug}</h1>
      <p>
        <strong>{count === 1 ? "1 response" : `${count} responses`}</strong>, all published
        versions.
      </p>
      <p className="warning">
        Free-text answers can contain names or other details that identify people, even though the
        survey does not ask for them. Handle what you see and download as confidential.
      </p>
      <p className="actions">
        <a className="button" href={api.exportUrl(eventId, slug, "csv")} download={`${slug}.csv`}>
          Download CSV
        </a>
        <a
          className="button"
          href={api.exportUrl(eventId, slug, "jsonl")}
          download={`${slug}.jsonl`}
        >
          Download JSON lines
        </a>
      </p>
      <p className="meta">
        JSON lines keeps every answer exactly as submitted; use it for analysis. CSV is for
        spreadsheets: one column per question, multiple choices joined with ";". Submission times
        are to the hour.
      </p>
      <p role="status" className="status">
        {note}
      </p>
      {error !== undefined && <ErrorNote error={error} />}
      {rows.length === 0 ? (
        <p>No responses yet.</p>
      ) : (
        <section
          ref={table}
          className="table-wrap"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-focusable
          tabIndex={0}
          aria-label="Responses"
        >
          <table>
            <caption className="sr-only">Responses, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Submitted (hour)</th>
                <th scope="col">Version</th>
                <th scope="col">Answers</th>
                {owner && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.responseId}>
                  <th scope="row">{r.seq}</th>
                  <td>{new Date(r.submittedAt).toLocaleString()}</td>
                  <td>{r.surveyVersion}</td>
                  <td>
                    <dl className="answers">
                      {Object.entries(r.answers).map(([id, v]) => (
                        <div key={id}>
                          <dt>{id}</dt>
                          <dd>{answerText(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                  {owner && (
                    <td>
                      <ConfirmButton
                        label="Delete"
                        name={`response ${r.seq}`}
                        title="Delete response"
                        onConfirm={() => remove(r.responseId)}
                      >
                        Permanently delete response {r.seq}? This cannot be undone. Backups keep a
                        copy until they expire.
                      </ConfirmButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {more && (
        <button type="button" onClick={next}>
          Show {PAGE} more
        </button>
      )}
    </>
  );
}
