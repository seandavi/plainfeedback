import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { expect, test, vi } from "vitest";
import { createApp, participantGuard } from "./app";
import { loadConfig } from "./config";

const leaky = () => {
  const lines: string[] = [];
  const app = createApp({ ping: async () => {}, log: (l) => lines.push(l) });
  app.get("/s/ev/survey", (c) => {
    setCookie(c, "sid", "leak");
    return c.text("hi");
  });
  app.get("/api/v1/public/x", (c) => {
    c.header("Set-Cookie", "sid=leak");
    return c.json({});
  });
  app.get("/api/v1/private", (c) => {
    setCookie(c, "sid", "ok");
    return c.json({});
  });
  return { app, lines };
};

test("healthz ok and 503 when db is down", async () => {
  const { app } = leaky();
  expect((await app.request("/healthz")).status).toBe(200);
  const down = createApp({
    ping: async () => {
      throw new Error("x");
    },
  });
  expect((await down.request("/healthz")).status).toBe(503);
});

test("participant routes never carry Set-Cookie and are no-store", async () => {
  const { app } = leaky();
  for (const path of ["/s/ev/survey", "/api/v1/public/x"]) {
    const res = await app.request(path);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  // guard is scoped: other routes keep their cookies and only get nosniff
  const staff = await app.request("/api/v1/private");
  expect(staff.headers.get("set-cookie")).toContain("sid=ok");
  expect(staff.headers.get("referrer-policy")).toBeNull();
  expect(staff.headers.get("x-content-type-options")).toBe("nosniff");
});

test("guard also covers handlers that throw", async () => {
  const app = new Hono();
  app.use(participantGuard);
  app.get("/s/boom", () => {
    throw new Error("boom");
  });
  const res = await app.request("/s/boom");
  expect(res.status).toBe(500);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("access log has method/path/status only, no IP or user-agent", async () => {
  const { app, lines } = leaky();
  await app.request("/s/ev/survey?token=secret", {
    headers: { "user-agent": "UA-SENTINEL", "x-forwarded-for": "203.0.113.9", cookie: "a=b" },
  });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] as string)).toEqual({
    method: "GET",
    path: "/s/ev/survey",
    status: 200,
  });
  expect(lines[0]).not.toMatch(/UA-SENTINEL|203\.0\.113\.9|secret/);
});

test("unhandled errors are logged without their message (query params can hold answers)", async () => {
  const lines: string[] = [];
  const app = createApp({ ping: async () => {}, log: (l) => lines.push(l) });
  // Mounted like the real routers (app.route), so the parent's onError must reach sub-apps.
  const sub = new Hono().post("/boom", () => {
    const e = new Error('Failed query: insert into "responses" params: ANSWER-SENTINEL');
    e.cause = Object.assign(new Error("ANSWER-SENTINEL"), { code: "22P05" });
    throw e;
  });
  app.route("/api/v1/public", sub);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await app.request("/api/v1/public/boom", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
  expect(lines.join("\n")).not.toContain("SENTINEL");
  expect(lines).toContain(JSON.stringify({ error: "Error", code: "22P05" }));
});

test("config requires a postgres DATABASE_URL", () => {
  expect(() => loadConfig({})).toThrow();
  const base = { DATABASE_URL: "postgresql://u:p@h/d", PUBLIC_BASE_URL: "https://pf.example.org/" };
  expect(loadConfig(base).PORT).toBe(3000);
  expect(loadConfig(base).PUBLIC_BASE_URL).toBe("https://pf.example.org");
  expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: undefined })).toThrow();
  expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "ftp://x.org" })).toThrow();
});
