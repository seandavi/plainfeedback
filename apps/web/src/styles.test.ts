import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// WCAG relative-luminance contrast between two #rrggbb colours.
const lum = (h: string) => {
  const hex = h.length === 4 ? h.replace(/\w/g, "$&$&") : h; // #fff -> #ffffff
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

it("control borders reach 3:1 against the background in both themes (#71)", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)") as [string, string];
  for (const block of [light, dark.slice(0, dark.indexOf("}\n}"))]) {
    const token = (n: string) => new RegExp(`--${n}: (#[0-9a-f]{3,6})`).exec(block)?.[1] as string;
    expect(contrast(token("control-border"), token("bg"))).toBeGreaterThanOrEqual(3);
  }
  // Inputs and buttons use it, not the decorative --line.
  expect(css).not.toMatch(
    /(input|textarea|select|button)[^{}]*\{[^}]*border: 1px solid var\(--line\)/,
  );
});
