// @vitest-environment jsdom
// Responses page (#50) and staff route titles/focus (#68).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerText, PAGE } from "./Responses";
import { StaffApp } from "./StaffApp";

const G = "11111111-1111-1111-1111-111111111111";
const ev = { id: "ev1", slug: "fall", title: "Fall", description: "" };
const row = (seq: number, answers: object = { role: "Staff" }) => ({
  responseId: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
  seq,
  surveyVersion: 1,
  submittedAt: "2026-10-01T14:00:00Z",
  answers,
});
const jsonl = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
const EXPORT = "/api/v1/events/ev1/surveys/post/responses";

let calls: { method: string; path: string }[];
let routes: Record<string, () => [number, unknown]>;
const setup = (role: string, rows: object[] = [row(1)]) => {
  routes = {
    "GET /api/v1/me": () => [200, { id: "me", email: "me@x.org", isAdmin: false }],
    [`GET /api/v1/groups/${G}`]: () => [200, { id: G, name: "Lab", archived: false, role }],
    [`GET /api/v1/groups/${G}/events`]: () => [200, [ev]],
    [`GET /api/v1/groups/${G}/events/fall`]: () => [200, ev],
    "GET /api/v1/events/ev1/surveys": () => [
      200,
      [{ slug: "post", closed: false, latestVersion: 1, responseCount: rows.length }],
    ],
    [`GET ${EXPORT}?format=jsonl`]: () => [200, jsonl(rows)],
  };
};
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, path });
      const [status, body] = routes[`${method} ${path}`]?.() ?? [404, { error: "not found" }];
      if (status === 204) return new Response(null, { status });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const open = (path: string) => {
  history.pushState(null, "", path);
  return render(<StaffApp />);
};
const RESPONSES = `/app/g/${G}/e/fall/s/post/responses`;

describe("responses page (#50)", () => {
  it("a viewer sees the count, download links, the free-text warning and plain-text answers", async () => {
    setup("viewer", [row(1, { comments: "<b>Bob</b> **here**", role: ["A", "B"] }), row(2)]);
    open(RESPONSES);
    expect(await screen.findByRole("heading", { name: "Responses: post" })).toBeTruthy();
    expect(screen.getByText("2 responses")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("href")).toBe(
      `${EXPORT}?format=csv`,
    );
    expect(screen.getByRole("link", { name: "Download JSON lines" }).getAttribute("href")).toBe(
      `${EXPORT}?format=jsonl`,
    );
    // Bare `download`: the server's Content-Disposition names the file (<event>-<survey>-responses).
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("download")).toBe("");
    expect(
      screen.getByText(/can contain names or other details that identify people/),
    ).toBeTruthy();
    const table = await screen.findByRole("table");
    // Respondent text is shown verbatim: no HTML and no markdown.
    expect(within(table).getByText("<b>Bob</b> **here**")).toBeTruthy();
    expect(table.querySelector("b, strong")).toBeNull();
    expect(within(table).getByText("A; B")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("pages with the seq cursor", async () => {
    const first = Array.from({ length: PAGE }, (_, i) => row(i + 1));
    setup("viewer", first);
    routes[`GET ${EXPORT}?format=jsonl&since=${PAGE}`] = () => [200, jsonl([row(PAGE + 7)])];
    open(RESPONSES);
    fireEvent.click(await screen.findByRole("button", { name: `Show ${PAGE} more` }));
    expect(await screen.findByRole("rowheader", { name: String(PAGE + 7) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("an owner deletes one response after confirming", async () => {
    setup("owner", [row(1), row(2)]);
    const id = row(2).responseId;
    routes[`DELETE ${EXPORT}/${id}`] = () => [204, undefined];
    open(RESPONSES);
    fireEvent.click(await screen.findByRole("button", { name: "Delete response 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete response" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted 1 response.")).toBeTruthy();
    expect(screen.getByText("1 response")).toBeTruthy();
    expect(screen.queryByRole("rowheader", { name: "2" })).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("the event page links each published survey's response count", async () => {
    setup("viewer", [row(1), row(2), row(3)]);
    open(`/app/g/${G}/e/fall`);
    const link = await screen.findByRole("link", { name: "3 responses" });
    expect(link.getAttribute("href")).toBe(RESPONSES);
    fireEvent.click(link);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Responses: post" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("renders answers as text", () => {
    expect(answerText({ 1: 4, 2: 5 })).toBe("1: 4, 2: 5");
    expect(answerText(3)).toBe("3");
  });
});

describe("route titles and focus (#68)", () => {
  it("sets the title per page, moves focus to the h1 after navigation, has a skip link", async () => {
    setup("viewer");
    open(`/app/g/${G}`);
    await screen.findByRole("heading", { level: 1, name: "Lab" });
    await waitFor(() => expect(document.title).toBe("Lab – plainfeedback"));
    expect(document.activeElement).toBe(document.body); // first load does not steal focus
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe(
      "#main",
    );
    fireEvent.click(screen.getByRole("link", { name: "Fall" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "Fall" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(document.title).toBe("Fall – plainfeedback");
  });
});
