// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";

// #40: the SPA is served under script-src 'self' with no 'unsafe-inline'/'unsafe-eval'.
test("built index.html has no inline script and the bundle never probes eval", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "pf-web-"));
  try {
    await build({ root: join(__dirname, ".."), logLevel: "silent", build: { outDir } });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toContain("src=");
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/\son[a-z]+=/);
    // zod's JIT (Function("")) is what tripped the CSP; main.tsx must configure jitless first.
    const entry = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] as string;
    expect(readFileSync(join(outDir, "assets", entry), "utf8")).toContain("jitless:!0");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 60_000);

// #39: respondent text (free text, Other) is plain text; Markdown is for author-written content.
test("respondent text is never rendered via Markdown or raw HTML", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");
  const files = [
    ...readdirSync(__dirname),
    ...readdirSync(join(__dirname, "staff")).map((f) => `staff/${f}`),
  ].filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  for (const f of files) expect(src(f), f).not.toContain("dangerouslySetInnerHTML");
  // Markdown is imported only by author-content views (prompts, intro, privacy, editor preview).
  const users = files.filter((f) => /from "\.{1,2}\/markdown"/.test(src(f))).sort();
  expect(users).toEqual(["ParticipantPage.tsx", "SurveyForm.tsx", "staff/Editor.tsx"]);
  // SurveyForm may only render author text (prompt, option labels) through it.
  const uses = [...src("SurveyForm.tsx").matchAll(/<MarkdownInline text=\{([^}]+)\}/g)].map(
    (m) => m[1],
  );
  expect(uses).toEqual(["q.prompt", "s"]);
});
