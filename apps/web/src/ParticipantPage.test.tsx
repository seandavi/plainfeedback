// @vitest-environment jsdom
import { compile } from "@plainfeedback/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticipantPage } from "./ParticipantPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MD = `# Fall feedback

See the [agenda](https://example.org/agenda).

::: {.choice #role required}
Role?
- Staff
- Student
:::
`;
const survey = (over: object = {}) => ({
  versionId: "v1",
  title: "Fall feedback",
  intro: "See the [agenda](https://example.org/agenda).",
  model: compile(MD).model,
  privacyStatement: "We keep **no** identifiers.",
  status: "open",
  ...over,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Replies in order; records every request.
const serve = (...replies: Response[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    return r;
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
};
const choose = () => fireEvent.click(screen.getByRole("radio", { name: "Staff" }));
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit" }));

describe("ParticipantPage", () => {
  it("shows privacy statement, submits, thanks; only same-origin public API, no storage", async () => {
    const calls = serve(json(200, survey()), json(201, { ok: true }));
    render(<ParticipantPage publicId="abc123def456" />);
    expect(await screen.findByRole("heading", { name: "Fall feedback" })).toBeTruthy();
    const privacy = screen.getByText("Privacy").closest("details");
    expect(privacy?.open).toBe(true);
    expect(privacy?.querySelector("strong")?.textContent).toBe("no");
    choose();
    submit();
    expect(await screen.findByText(/Thank you/)).toBeTruthy();
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url])).toEqual([
      ["GET", "/api/v1/public/surveys/abc123def456"],
      ["POST", "/api/v1/public/surveys/abc123def456/responses"],
    ]);
    for (const c of calls) {
      expect(c.url.startsWith("/api/v1/public/")).toBe(true);
      expect(c.init?.credentials).toBe("omit");
    }
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      versionId: "v1",
      answers: { role: "Staff" },
    });
    // Nothing that loads from elsewhere, and nothing stored on the device.
    expect(document.querySelectorAll("img, script, link, iframe")).toHaveLength(0);
    expect(document.cookie).toBe("");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("shows not found, closed and not-yet-open states", async () => {
    serve(json(404, { error: "not found" }));
    render(<ParticipantPage publicId="nope" />);
    expect(await screen.findByText("Survey not found")).toBeTruthy();
    cleanup();
    serve(json(200, survey({ status: "closed" })));
    render(<ParticipantPage publicId="x" />);
    expect(await screen.findByText("This survey is closed.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    serve(json(200, survey({ status: "not_yet_open" })));
    render(<ParticipantPage publicId="x" />);
    expect(await screen.findByText("This survey is not open yet.")).toBeTruthy();
  });

  it("reloads on 409 and resubmits with the new version, keeping answers", async () => {
    const calls = serve(
      json(200, survey()),
      json(409, { error: "changed" }),
      json(200, survey({ versionId: "v2" })),
      json(201, { ok: true }),
    );
    render(<ParticipantPage publicId="x" />);
    await screen.findByRole("heading", { name: "Fall feedback" });
    choose();
    submit();
    expect(await screen.findByText(/was just updated/)).toBeTruthy();
    submit();
    expect(await screen.findByText(/Thank you/)).toBeTruthy();
    expect(JSON.parse(calls[3]?.init?.body as string).versionId).toBe("v2");
  });

  it("maps server 422 errors back to questions and shows 410 as closed", async () => {
    serve(
      json(200, survey()),
      json(422, { error: "invalid answers", errors: { role: "Choose one of the options." } }),
      json(410, { error: "closed" }),
      json(200, survey({ status: "closed" })),
    );
    render(<ParticipantPage publicId="x" />);
    await screen.findByRole("heading", { name: "Fall feedback" });
    choose();
    submit();
    expect(await screen.findByText("Choose one of the options.")).toBeTruthy();
    submit();
    expect(await screen.findByText("This survey is closed.")).toBeTruthy();
  });
});
