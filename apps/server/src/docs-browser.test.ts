// Loads /api/docs in headless Chromium under the real staff CSP and checks the "no third-party
// requests" invariant at runtime: the Scalar bundle contains scalar.com URLs that only stay
// unused because of the config in openapi.ts. Locally skipped without a Playwright Chromium
// (`pnpm -C apps/server exec playwright-core install chromium-headless-shell`); required in CI.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import { expect, test } from "vitest";
import { specApp } from "./openapi-gen";

// Scalar behaves differently on local hosts (no request proxy, "Ask AI" on by default), so check
// a loopback origin and a production-like one.
const HOSTS = ["127.0.0.1", "docs.plainfeedback.internal"];

test("docs page renders with no cross-origin requests and no CSP violations", async ({ skip }) => {
  const browser = await chromium
    .launch({ args: [`--host-resolver-rules=MAP ${HOSTS[1]} 127.0.0.1`] })
    .catch((e) => {
      if (process.env.CI) throw e;
      skip("no Playwright Chromium installed");
    });
  if (!browser) return;
  const server = serve({ fetch: specApp().fetch, port: 0, hostname: "127.0.0.1" });
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    for (const host of HOSTS) {
      const origin = `http://${host}:${port}`;
      const page = await browser.newPage();
      const foreign: string[] = [];
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        foreign.push(url);
        return route.abort();
      });
      // A string, not a function: the server tsconfig has no DOM types.
      await page.addInitScript(`window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__csp.push(e.violatedDirective + " " + e.blockedURI));`);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));

      await page.goto(`${origin}/api/docs`);
      await page.getByText("Submit answers").first().waitFor({ timeout: 20_000 });
      // "Ask AI" would talk to api.scalar.com once clicked.
      expect(await page.getByText(/ask ai/i).count(), host).toBe(0);

      // "Test request" (first operation: GET /api/v1/public/surveys/{publicId}) must go straight
      // to this origin, not through proxy.scalar.com.
      await page
        .getByRole("button", { name: /test request/i })
        .first()
        .click();
      await page.getByRole("combobox", { name: "Value" }).first().fill("abc");
      const sent = page.waitForResponse((r) => r.url().includes("/api/v1/public/surveys/abc"), {
        timeout: 10_000,
      });
      await page.getByRole("button", { name: /^send/i }).first().click();
      expect(new URL((await sent).url()).origin, host).toBe(origin);

      expect(foreign, host).toEqual([]);
      expect(await page.evaluate("window.__csp"), host).toEqual([]);
      expect(errors, host).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
