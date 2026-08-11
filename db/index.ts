import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 绑定 `DB` 不可用，请确认 .openai/hosting.json 已配置 D1。",
    );
  }

  return env.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

let initialization: Promise<void> | undefined;

/**
 * Keep first-run development and preview deployments usable even before the
 * generated migration has been applied. D1 batch calls are transactional, and
 * every statement is idempotent.
 */
export function ensureGameDatabase() {
  if (!initialization) {
    initialization = initializeGameDatabase().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }

  return initialization;
}

async function initializeGameDatabase() {
  const d1 = getD1();

  await d1.batch([
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        title TEXT NOT NULL,
        player_a TEXT NOT NULL,
        player_b TEXT NOT NULL,
        race_to INTEGER DEFAULT 3 NOT NULL,
        stake_limit_cents INTEGER DEFAULT 1000 NOT NULL,
        status TEXT DEFAULT 'open' NOT NULL,
        result_score_a INTEGER,
        result_score_b INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        settled_at TEXT,
        CONSTRAINT matches_status_check CHECK (status IN ('open', 'closed', 'settled')),
        CONSTRAINT matches_race_to_check CHECK (race_to > 0),
        CONSTRAINT matches_stake_limit_check CHECK (stake_limit_cents > 0)
      )
    `),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        match_id INTEGER NOT NULL,
        bettor_name TEXT NOT NULL,
        bettor_key TEXT NOT NULL,
        mode TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        winner_pick TEXT,
        predicted_score_a INTEGER,
        predicted_score_b INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON UPDATE NO ACTION ON DELETE CASCADE,
        CONSTRAINT bets_mode_check CHECK (mode IN ('winner', 'score')),
        CONSTRAINT bets_amount_check CHECK (amount_cents > 0),
        CONSTRAINT bets_selection_check CHECK (
          (
            mode = 'winner'
            AND winner_pick IN ('A', 'B')
            AND predicted_score_a IS NULL
            AND predicted_score_b IS NULL
          ) OR (
            mode = 'score'
            AND winner_pick IS NULL
            AND predicted_score_a IS NOT NULL
            AND predicted_score_b IS NOT NULL
            AND predicted_score_a >= 0
            AND predicted_score_b >= 0
          )
        )
      )
    `),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS matches_status_created_idx ON matches (status, created_at)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS matches_one_active_unique ON matches ((1)) WHERE status != 'settled'",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS bets_match_bettor_mode_unique ON bets (match_id, bettor_key, mode)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS bets_match_created_idx ON bets (match_id, created_at)",
    ),
  ]);

  await d1.prepare("PRAGMA optimize").run();

  await d1.prepare(`
    INSERT INTO matches (
      title,
      player_a,
      player_b,
      race_to,
      stake_limit_cents,
      status
    )
    SELECT '抢3竞猜赛', '侯良玉', '杜志豪', 3, 1000, 'open'
    WHERE NOT EXISTS (SELECT 1 FROM matches)
  `).run();
}
