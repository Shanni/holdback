// Persistence for the market: products, buyers and holds as JSON rows in SQLite (node:sqlite).
// Holds reference live card authorizations, so they must survive a restart.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const TABLES = ["products", "buyers", "holds"] as const;
export type Table = (typeof TABLES)[number];

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "holdback.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    for (const t of TABLES) this.db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  }

  all<T>(table: Table): T[] {
    return (this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  /** Writes every row in one transaction (the market is small; this keeps the code simple). */
  save(rows: Partial<Record<Table, { id: string }[]>>) {
    this.db.exec("BEGIN");
    try {
      for (const [table, list] of Object.entries(rows) as [Table, { id: string }[]][]) {
        const put = this.db.prepare(`INSERT INTO ${table} (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`);
        for (const r of list) put.run(r.id, JSON.stringify(r));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
