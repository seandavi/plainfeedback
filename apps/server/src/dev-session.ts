// Local checks only (`just dev-session <email>`): upsert a staff user, give them an owner seat in a
// "Dev" group, and print a session id to use as the pf_session cookie (path /api/v1). This skips
// OIDC, so it refuses anything but a localhost database that has never had a real sign-in (a
// deployed instance's database can also be published on localhost).
import { and, eq, ne } from "drizzle-orm";
import { hashSessionId } from "./auth";
import { createDb } from "./db";
import { groups, memberships, sessions, users } from "./schema";

const url = process.env.DATABASE_URL;
const email = process.argv[2]?.toLowerCase();
if (!url || !email) throw new Error("usage: DATABASE_URL=... dev-session <email> [--admin]");
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url))
  throw new Error("dev-session only runs against a localhost database");
const isAdmin = process.argv.includes("--admin");

const db = createDb(url);
const DEV_ISSUER = "https://dev.invalid";
if ((await db.select().from(users).where(ne(users.oidcIssuer, DEV_ISSUER)).limit(1)).length)
  throw new Error("dev-session refuses a database with real (OIDC) users");
const [user] = await db
  .insert(users)
  .values({ email, oidcIssuer: DEV_ISSUER, oidcSubject: email, isAdmin })
  .onConflictDoUpdate({ target: [users.oidcIssuer, users.oidcSubject], set: { isAdmin } })
  .returning();
if (!user) throw new Error("user upsert failed");
const group =
  (await db.select().from(groups).where(eq(groups.name, "Dev")))[0] ??
  (await db.insert(groups).values({ name: "Dev" }).returning())[0];
if (!group) throw new Error("group create failed");
const seat = await db
  .select()
  .from(memberships)
  .where(and(eq(memberships.groupId, group.id), eq(memberships.userId, user.id)));
if (!seat.length)
  await db.insert(memberships).values({ groupId: group.id, userId: user.id, role: "owner" });
const sid = crypto.randomUUID();
await db.insert(sessions).values({
  idHash: await hashSessionId(sid),
  userId: user.id,
  expiresAt: new Date(Date.now() + 12 * 3600_000),
});
console.log(sid);
await db.$client.end();
