// @vitest-environment jsdom
import { Text } from "@codemirror/state";
import { compile } from "@plainfeedback/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertSnippet, toDiagnostics } from "./CodeEditor";
import { Editor, SNIPPETS } from "./Editor";
import { StaffApp } from "./StaffApp";

// CodeMirror needs layout APIs jsdom lacks; the editor flows only need a controlled text field.
vi.mock("./CodeEditor", async (orig) => ({
  ...(await orig<typeof import("./CodeEditor")>()),
  CodeEditor: (p: import("./CodeEditor").CodeEditorProps) => {
    useImperativeHandle(p.ref, () => ({
      insert: (t: string) => p.onChange(`${p.value}\n${t}\n`),
      goToLine: () => {},
    }));
    return (
      <>
        <textarea
          aria-label={p.label}
          value={p.value}
          readOnly={p.readOnly}
          onChange={(e) => p.onChange(e.target.value)}
        />
        <output data-testid="diagnostics">{p.diagnostics.map((d) => d.line).join(",")}</output>
      </>
    );
  },
}));

const MD = "# Fall feedback\n\n::: {.text #comments}\nAny comments?\n:::\n";
const survey = (over: object = {}) => ({
  slug: "fb",
  waveLabel: null,
  closed: false,
  updatedAt: "2026-10-01T00:00:00Z",
  latestVersion: null,
  publicId: "abc",
  markdown: MD,
  etag: '"e1"',
  latest: null,
  ...over,
});

type Call = { method: string; path: string; headers: Record<string, string>; body?: string };
let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  calls = [];
  routes = {
    "GET /api/v1/events/ev/surveys/fb": () => [200, survey()],
    "GET /api/v1/events/ev/surveys/fb/versions": () => [200, []],
    "GET /api/v1/events/ev/surveys/fb/link": () => [
      200,
      { url: "http://x/s/abc", published: false },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = {
        method: init.method ?? "GET",
        path: url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body as string | undefined,
      };
      calls.push(c);
      const h = routes[`${c.method} ${url}`];
      return h ? json(...h(c)) : json(404, { error: "not found" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = async (readOnly = false) => {
  render(<Editor eventId="ev" slug="fb" readOnly={readOnly} />);
  const box = await screen.findByLabelText(/Survey markdown/);
  await screen.findByRole("heading", { level: 1, name: "Fall feedback" });
  return box as HTMLTextAreaElement;
};
const preview = () => within(screen.getByRole("region", { name: "Preview" }));
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });

describe("Editor", () => {
  it("previews the compiled survey and updates it as the markdown changes", async () => {
    const box = await setup();
    expect(preview().getByLabelText("Any comments?")).toBeTruthy();
    type(box, MD.replace("Any comments?", "What did you learn?"));
    await waitFor(() => expect(preview().getByLabelText("What did you learn?")).toBeTruthy());
    expect(screen.getByText(/unsaved changes/)).toBeTruthy();
  });

  it("shows compile errors with line numbers and keeps the last good preview", async () => {
    const box = await setup();
    type(box, MD.replace(".text", ".radio"));
    await screen.findByText(/1 problem to fix/);
    expect(screen.getByRole("button", { name: "Line 3" })).toBeTruthy();
    expect(screen.getByTestId("diagnostics").textContent).toBe("3");
    expect(screen.getByText(/last version without problems/)).toBeTruthy();
    expect(preview().getByLabelText("Any comments?")).toBeTruthy();
  });

  it("saves the draft with If-Match set to the loaded ETag", async () => {
    routes["PUT /api/v1/events/ev/surveys/fb"] = () => [200, survey({ etag: '"e2"' })];
    const box = await setup();
    type(box, `${MD}\n`);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"e1"');
    expect(JSON.parse(put?.body ?? "")).toEqual({ markdown: `${MD}\n` });
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("on 412 offers overwrite (with their ETag) or reload; the safe choice has focus (#70)", async () => {
    routes["PUT /api/v1/events/ev/surveys/fb"] = (c) =>
      c.headers["if-match"] === '"e9"' ? [200, survey({ etag: '"e10"' })] : [412, { error: "x" }];
    const box = await setup();
    const mine = `${MD}\n<!-- mine -->`;
    type(box, mine);
    routes["GET /api/v1/events/ev/surveys/fb"] = () => [200, survey({ etag: '"e9"' })];
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const dialog = await screen.findByRole("dialog", { name: "This draft changed elsewhere" });
    expect(document.activeElement?.textContent).toBe("Keep editing");
    // Both versions are shown, with my changed line marked.
    expect(within(dialog).getByText("<!-- mine -->").tagName).toBe("MARK");
    expect(within(dialog).getByRole("heading", { name: "Their version" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Overwrite with mine" }));
    await screen.findByText("Draft saved.");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers["if-match"])).toEqual(['"e1"', '"e9"']);
    expect(JSON.parse(puts[1]?.body ?? "").markdown).toBe(mine);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Copy, then the reload path: their markdown replaces mine.
    routes["PUT /api/v1/events/ev/surveys/fb"] = () => [412, { error: "x" }];
    routes["GET /api/v1/events/ev/surveys/fb"] = () => [200, survey({ markdown: "# Theirs\n" })];
    type(box, `${mine}!`);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const again = await screen.findByRole("dialog");
    const writeText = vi.fn(async (_t: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(again).getByRole("button", { name: "Copy my version" }));
    await within(again).findByText(/on the clipboard/);
    expect(writeText).toHaveBeenCalledWith(`${mine}!`);
    fireEvent.click(within(again).getByRole("button", { name: "Discard mine and load theirs" }));
    await waitFor(() => expect(box.value).toBe("# Theirs\n"));
  });

  it("shows the server's compile errors when publish answers 422", async () => {
    routes["POST /api/v1/events/ev/surveys/fb/publish"] = () => [
      422,
      { errors: [{ line: 7, message: "Unknown question type '.radio'." }] },
    ];
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish this survey" });
    expect(within(dialog).getByLabelText(/Privacy statement/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await within(dialog).findByText(/Line 7: Unknown question type/);
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({ opensAt: null, closesAt: null });
  });

  it("on 409 with changes, lists them and publishes anyway with force (#52)", async () => {
    const v = { version: 1, publishedAt: "2026-10-02T10:00:00Z", opensAt: null, closesAt: null };
    routes["POST /api/v1/events/ev/surveys/fb/publish"] = (c) =>
      JSON.parse(c.body ?? "{}").force
        ? [201, v]
        : [409, { error: "This survey already has responses.", changes: ["Statement 1 moved."] }];
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await within(dialog).findByText("Statement 1 moved.");
    expect(within(dialog).getByText("This survey already has responses.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish anyway" }));
    await screen.findByText("Published version 1.");
  });

  it("publishes and lists the new version", async () => {
    const v = { version: 1, publishedAt: "2026-10-02T10:00:00Z", opensAt: null, closesAt: null };
    routes["POST /api/v1/events/ev/surveys/fb/publish"] = () => [201, v];
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Privacy statement/), {
      target: { value: "We keep nothing." },
    });
    routes["GET /api/v1/events/ev/surveys/fb/versions"] = () => [200, [v]];
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    routes["GET /api/v1/events/ev/surveys/fb/link"] = () => [
      200,
      { url: "http://x/s/abc", published: true },
    ];
    await screen.findByText(/Published version 1\./);
    expect(screen.getByText(/Version 1, published/)).toBeTruthy();
    // #69: the share panel comes first after publishing and takes focus.
    const link = await screen.findByLabelText("Survey link");
    await waitFor(() => expect(document.activeElement).toBe(link));
    const share = screen.getByRole("region", { name: "Share this survey" });
    expect(
      share.compareDocumentPosition(screen.getByRole("region", { name: "Markdown" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "").privacyStatement).toBe("We keep nothing.");
  });

  it("insert is a menu button: arrows only move focus, an item inserts (#51)", async () => {
    const box = await setup();
    const button = screen.getByRole("button", { name: "Insert question" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Insert question" });
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items.at(-1)); // wraps
    expect(box.value).toBe(MD); // browsing changed nothing
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Number" }));
    expect(box.value).toContain("::: {.number #number-1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks unpublished changes, shows the close date, and confirms closing (#69)", async () => {
    const v = {
      version: 1,
      publishedAt: "2026-10-02T10:00:00Z",
      opensAt: null,
      closesAt: "2026-11-01T10:00:00Z",
    };
    routes["GET /api/v1/events/ev/surveys/fb/versions"] = () => [200, [v]];
    routes["GET /api/v1/events/ev/surveys/fb/versions/1"] = () => [
      200,
      { ...v, markdown: "# Fall feedback\n", model: {}, privacyStatement: "" },
    ];
    routes["PATCH /api/v1/events/ev/surveys/fb"] = () => [200, survey({ closed: true })];
    await setup();
    expect(await screen.findByText(/unpublished changes: participants still see v1/)).toBeTruthy();
    expect(screen.getByText(/^Published v1/).textContent).toMatch(/ · closes /);
    expect(screen.getByRole("button", { name: "Publish…" }).className).toBe("primary");

    fireEvent.click(screen.getByRole("button", { name: "Close survey…" }));
    const dialog = await screen.findByRole("dialog", { name: "Close this survey?" });
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close survey" }));
    await screen.findByText("Survey closed for responses.");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reopen survey" })).toBeTruthy();
  });

  it("hides Close for never-published drafts and the QR before publishing (#69)", async () => {
    await setup();
    await screen.findByText(/Not published yet: the link/);
    expect(screen.queryByRole("button", { name: /Close survey/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByText(/unpublished changes/)).toBeNull();
  });

  it("is read-only for viewers but still previews", async () => {
    const box = await setup(true);
    expect(box.readOnly).toBe(true);
    for (const name of ["Save draft", "Publish…", "Close survey"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(preview().getByLabelText("Any comments?")).toBeTruthy();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });
});

describe("insertSnippet (#51)", () => {
  const snippet = SNIPPETS.choice.replace("ID", "choice-1");
  const insert = (doc: string, cursor: number) => {
    const { at, insert } = insertSnippet(doc, cursor, snippet);
    return doc.slice(0, at) + insert + doc.slice(at);
  };
  const doc = "# T\n\nIntro.\n\n::: {.text #a}\nQ\n:::\n\n::: {.text #b}\nQ\n:::\n";

  it("never-focused (cursor 0) or in the intro: appends, title stays on line 1, compiles", () => {
    for (const cursor of [0, doc.indexOf("Intro")]) {
      const out = insert(doc, cursor);
      expect(out.startsWith("# T\n")).toBe(true);
      expect(out.endsWith(`${snippet}\n`)).toBe(true);
      expect(compile(out).errors).toBeUndefined();
    }
    expect(compile(insert("# T", 0)).errors).toBeUndefined();
  });

  it("inside a block: after its closing line; between blocks: after the cursor's line", () => {
    const inFirst = insert(doc, doc.indexOf("Q"));
    expect(inFirst.indexOf("#choice-1")).toBeLessThan(inFirst.indexOf("#b"));
    expect(inFirst.indexOf("#choice-1")).toBeGreaterThan(inFirst.indexOf("#a"));
    expect(compile(inFirst).errors).toBeUndefined();
    const onOpening = insert(doc, doc.indexOf("::: {.text #b}") + 2);
    expect(onOpening.trimEnd().endsWith(snippet)).toBe(true);
    expect(compile(onOpening).errors).toBeUndefined();
    const between = insert(doc, doc.indexOf("\n\n::: {.text #b}") + 1);
    expect(compile(between).errors).toBeUndefined();
  });
});

describe("toDiagnostics", () => {
  it("maps 1-based lines and columns, clamping past the end", () => {
    const doc = Text.of(["# T", "", "::: {.radio #x}", "Q"]);
    const [a, b] = toDiagnostics(doc, [
      { line: 3, column: 6, message: "bad type" },
      { line: 9, message: "never closed" },
    ]);
    expect(doc.sliceString(a?.from ?? 0, a?.to)).toBe(".radio #x}");
    expect(doc.sliceString(b?.from ?? 0, b?.to)).toBe("Q");
  });
});

describe("StaffApp", () => {
  it("offers sign-in when signed out", async () => {
    routes["GET /api/v1/me"] = () => [401, { error: "unauthenticated" }];
    history.replaceState(null, "", "/app");
    render(<StaffApp />);
    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/api/v1/auth/login");
  });

  it("shows the user and their groups when signed in", async () => {
    routes["GET /api/v1/me"] = () => [200, { id: "u", email: "a@b.org", isAdmin: false }];
    routes["GET /api/v1/groups"] = () => [
      200,
      [{ id: "g1", name: "CFDE", archived: false, role: "viewer" }],
    ];
    routes["GET /api/v1/groups/g1/events"] = () => [200, []];
    history.replaceState(null, "", "/app");
    render(<StaffApp />);
    expect((await screen.findByRole("link", { name: "CFDE" })).getAttribute("href")).toBe(
      "/app/g/g1",
    );
    expect(screen.getByText("a@b.org")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
