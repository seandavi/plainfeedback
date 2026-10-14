import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateSpec, SNAPSHOT, specApp } from "./openapi-gen";

// biome-ignore lint/suspicious/noExplicitAny: test-only view of the JSON spec
const getSpec = async () => (await (await specApp().request("/openapi.json")).json()) as any;

test("docs/openapi.json is up to date", async () => {
  const committed = (() => {
    try {
      return readFileSync(SNAPSHOT, "utf8");
    } catch {
      return "";
    }
  })();
  expect(
    committed === (await generateSpec()),
    "OpenAPI spec changed: run `just openapi` and commit docs/openapi.json",
  ).toBe(true);
});

test("spec is 3.1 with relative servers and both auth schemes", async () => {
  const spec = await getSpec();
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(spec.servers).toEqual([{ url: "/" }]);
  expect(Object.keys(spec.components.securitySchemes).sort()).toEqual([
    "bearerToken",
    "sessionCookie",
  ]);
});

test("every operation has summary, tags and documented error responses", async () => {
  const spec = await getSpec();
  const missing: string[] = [];
  for (const [path, item] of Object.entries<
    Record<string, { summary?: string; tags?: string[]; responses?: object }>
  >(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const where = `${method.toUpperCase()} ${path}`;
      if (!op.summary) missing.push(`${where}: summary`);
      if (!op.tags?.length) missing.push(`${where}: tags`);
      if (!Object.keys(op.responses ?? {}).some((s) => /^[45]/.test(s)))
        missing.push(`${where}: error responses`);
    }
  }
  expect(missing).toEqual([]);
});

test("docs page loads only same-origin assets, all of which are served", async () => {
  const app = specApp();
  const html = await (await app.request("/api/docs")).text();
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) {
    expect(u).toMatch(/^\/(?!\/)/); // path-absolute, not protocol-relative or http(s)
    const res = await app.request(u);
    expect(res.status, u).toBe(200);
  }
  const init = await (await app.request("/api/docs/init.js")).text();
  expect(init).not.toMatch(/https?:\/\/|\/\/[a-z]/);
  expect(init).toContain("validatorUrl: null");
});

test("docs page has no inline script, so it works under script-src self", async () => {
  const html = await (await specApp().request("/api/docs")).text();
  for (const m of html.matchAll(/<script([^>]*)>/g)) expect(m[1]).toContain("src=");
  expect(html).not.toMatch(/\son[a-z]+=/);
});
