import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app";
import { mountSpa } from "./spa";

test("unknown /api/* paths get a JSON 404; other unknown GETs get the SPA page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pf-web-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>spa</title>");
  const app = createApp({ ping: async () => {} });
  mountSpa(app, relative(process.cwd(), dir));

  for (const [method, path] of [
    ["GET", "/api/v1/nope"],
    ["GET", "/api/v1/public/nope"],
    ["POST", "/api/v1/nope"],
    ["GET", "/api/nope"],
  ] as const) {
    const res = await app.request(path, { method });
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  }
  const page = await app.request("/s/abc");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>spa</title>");
  expect((await app.request("/api/docs")).status).toBe(200); // real routes still win
  expect((await app.request("/healthz")).status).toBe(200);
});
