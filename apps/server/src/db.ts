import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

export const createDb = (url: string) => drizzle(url);
export type Db = ReturnType<typeof createDb>;
export const ping = async (db: Db) => {
  await db.execute(sql`select 1`);
};
