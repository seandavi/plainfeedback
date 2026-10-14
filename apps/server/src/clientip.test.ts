// Own file: the warning flag is per module, and vitest isolates modules per file.
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { clientAddress } from "./clientip";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));

it("warns once, without the address, when a local peer is seen and TRUST_PROXY is unset (#55)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const app = new Hono().get("/", (c) => c.text(String(clientAddress("")(c))));
  expect(await (await app.request("/")).text()).toBe("undefined");
  await app.request("/");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toMatch(/TRUST_PROXY/);
  expect(String(warn.mock.calls[0]?.[0])).not.toContain("127.0.0.1");
});
