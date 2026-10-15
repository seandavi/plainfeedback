// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareLink } from "./ShareLink";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stub = (res: { ok: boolean; body?: unknown }) => {
  const f = vi.fn(async (_url: string) => ({
    ok: res.ok,
    status: res.ok ? 200 : 404,
    json: async () => res.body,
  }));
  vi.stubGlobal("fetch", f);
  return f;
};

describe("ShareLink", () => {
  it("shows the URL, copies it, previews the QR and links downloads", async () => {
    const url = "https://pf.example.org/s/abcdefghjkmn";
    const f = stub({ ok: true, body: { url, published: true } });
    const writeText = vi.fn(async (_t: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShareLink eventId="ev1" survey="post" />);
    const input = (await screen.findByLabelText("Survey link")) as HTMLInputElement;
    expect(input.value).toBe(url);
    const base = "/api/v1/events/ev1/surveys/post/link";
    expect(f.mock.calls[0]?.[0]).toBe(base);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("src")).toBe(`${base}/qr.svg`);
    expect(screen.getByText("Download SVG").getAttribute("href")).toBe(`${base}/qr.svg`);
    expect(screen.getByText("Download PNG").getAttribute("href")).toBe(`${base}/qr.png?size=1024`);
    expect(screen.queryByText(/Not published/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open link" }).getAttribute("href")).toBe(url);
  });

  it("warns when unpublished and reports load failures", async () => {
    stub({ ok: true, body: { url: "https://x.org/s/a", published: false } });
    render(<ShareLink eventId="e" survey="s" />);
    expect(await screen.findByText(/Not published yet/)).toBeTruthy();
    // #69: no QR, downloads or Open link until published.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Download PNG")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open link" })).toBeNull();
    cleanup();
    stub({ ok: false });
    render(<ShareLink eventId="e" survey="s" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
