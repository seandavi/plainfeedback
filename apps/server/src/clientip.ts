// Client address for the participant rate limiter only (#34, ADR 0013). The result is HMACed in
// public.ts and never stored or logged. Node-specific (socket address), so it is injected from index.ts.
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

export type TrustProxy = "" | "x-forwarded-for" | "cf-connecting-ip";

// A proxy on the same host or network. Without TRUST_PROXY every participant would share its
// address, turning the per-client limit into one global limit, so those peers are not limited per client.
const local = new BlockList();
for (const [net, bits] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
] as const)
  local.addSubnet(net, bits, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");
local.addSubnet("fe80::", 10, "ipv6");

// IPv4 as is; IPv6 cut to its /64, because one host usually holds a whole /64 and can rotate within it.
export const limiterAddress = (raw: string | undefined): string | undefined => {
  const ip = raw?.trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (!ip) return undefined;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return undefined;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

let warned = false;
export const clientAddress =
  (trust: TrustProxy) =>
  (c: Context): string | undefined => {
    if (trust === "cf-connecting-ip") return limiterAddress(c.req.header("cf-connecting-ip"));
    // Rightmost entry: the one our own proxy appended. Entries to its left are client-controlled.
    if (trust === "x-forwarded-for")
      return limiterAddress(c.req.header("x-forwarded-for")?.split(",").at(-1));
    let peer: string | undefined;
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      return undefined; // not a Node socket (tests)
    }
    const ip = limiterAddress(peer);
    if (!ip || !peer) return undefined;
    const isLocal = isIPv4(ip) ? local.check(ip, "ipv4") : local.check(peer, "ipv6");
    if (isLocal && !warned) {
      warned = true; // once per process; no address in the message
      console.warn(
        "participant request from a private or loopback peer and TRUST_PROXY is unset: the " +
          "per-client submission limit is off. Set TRUST_PROXY if a proxy sits in front (docs/deploy.md).",
      );
    }
    return isLocal ? undefined : ip;
  };
