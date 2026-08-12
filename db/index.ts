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
        winner_rollover_in_cents INTEGER DEFAULT 0 NOT NULL,
        winner_rollover_out_cents INTEGER,
        winner_rollover_source_match_id INTEGER,
        score_rollover_in_cents INTEGER DEFAULT 0 NOT NULL,
        score_rollover_out_cents INTEGER,
        score_rollover_source_match_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        settled_at TEXT,
        CONSTRAINT matches_status_check CHECK (status IN ('open', 'closed', 'settled')),
        CONSTRAINT matches_race_to_check CHECK (race_to > 0),
        CONSTRAINT matches_stake_limit_check CHECK (stake_limit_cents > 0),
        CONSTRAINT matches_rollover_in_check CHECK (
          winner_rollover_in_cents >= 0 AND score_rollover_in_cents >= 0
        ),
        CONSTRAINT matches_rollover_out_check CHECK (
          (winner_rollover_out_cents IS NULL OR winner_rollover_out_cents >= 0)
          AND (score_rollover_out_cents IS NULL OR score_rollover_out_cents >= 0)
        )
      )
    `),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        match_id INTEGER NOT NULL,
        bettor_name TEXT NOT NULL,
        bettor_key TEXT NOT NULL,
        note TEXT DEFAULT '' NOT NULL,
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
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS receipt_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        match_id INTEGER NOT NULL,
        bet_id INTEGER,
        kind TEXT NOT NULL,
        status TEXT DEFAULT 'active' NOT NULL,
        code TEXT NOT NULL,
        revision INTEGER DEFAULT 1 NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON UPDATE NO ACTION ON DELETE CASCADE,
        CONSTRAINT receipt_snapshots_kind_check CHECK (kind IN ('bet', 'sealed', 'settled')),
        CONSTRAINT receipt_snapshots_status_check CHECK (status IN ('active', 'superseded', 'cancelled')),
        CONSTRAINT receipt_snapshots_target_check CHECK (
          (kind = 'bet' AND bet_id IS NOT NULL)
          OR (kind IN ('sealed', 'settled') AND bet_id IS NULL)
        ),
        CONSTRAINT receipt_snapshots_revision_check CHECK (revision > 0),
        CONSTRAINT receipt_snapshots_code_check CHECK (length(code) > 0),
        CONSTRAINT receipt_snapshots_payload_check CHECK (json_valid(payload_json))
      )
    `),
  ]);

  // CREATE TABLE IF NOT EXISTS cannot add columns to an existing local D1.
  // Inspect the live schema first so upgrades are repeatable and preserve all
  // existing matches and bets.
  const columns = await d1
    .prepare("PRAGMA table_info(matches)")
    .all<{ name: string }>();
  const columnNames = new Set(
    (columns.results ?? []).map((column: { name: string }) => column.name),
  );
  const rolloverColumns = [
    {
      name: "winner_rollover_in_cents",
      definition: "INTEGER DEFAULT 0 NOT NULL",
    },
    { name: "winner_rollover_out_cents", definition: "INTEGER" },
    { name: "winner_rollover_source_match_id", definition: "INTEGER" },
    {
      name: "score_rollover_in_cents",
      definition: "INTEGER DEFAULT 0 NOT NULL",
    },
    { name: "score_rollover_out_cents", definition: "INTEGER" },
    { name: "score_rollover_source_match_id", definition: "INTEGER" },
  ];

  for (const column of rolloverColumns) {
    if (!columnNames.has(column.name)) {
      await d1
        .prepare(`ALTER TABLE matches ADD COLUMN ${column.name} ${column.definition}`)
        .run();
    }
  }

  const betColumns = await d1
    .prepare("PRAGMA table_info(bets)")
    .all<{ name: string }>();
  const betColumnNames = new Set(
    (betColumns.results ?? []).map((column: { name: string }) => column.name),
  );
  if (!betColumnNames.has("note")) {
    await d1
      .prepare("ALTER TABLE bets ADD COLUMN note TEXT DEFAULT '' NOT NULL")
      .run();
  }

  await backfillRolloverSnapshots(d1);

  await d1.batch([
    d1.prepare(`
      CREATE TRIGGER IF NOT EXISTS matches_rollover_nonnegative_insert
      BEFORE INSERT ON matches
      WHEN NEW.winner_rollover_in_cents < 0
        OR NEW.winner_rollover_out_cents < 0
        OR NEW.score_rollover_in_cents < 0
        OR NEW.score_rollover_out_cents < 0
      BEGIN
        SELECT RAISE(ABORT, 'rollover amounts must be nonnegative');
      END
    `),
    d1.prepare(`
      CREATE TRIGGER IF NOT EXISTS matches_rollover_nonnegative_update
      BEFORE UPDATE OF
        winner_rollover_in_cents,
        winner_rollover_out_cents,
        score_rollover_in_cents,
        score_rollover_out_cents
      ON matches
      WHEN NEW.winner_rollover_in_cents < 0
        OR NEW.winner_rollover_out_cents < 0
        OR NEW.score_rollover_in_cents < 0
        OR NEW.score_rollover_out_cents < 0
      BEGIN
        SELECT RAISE(ABORT, 'rollover amounts must be nonnegative');
      END
    `),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS matches_status_created_idx ON matches (status, created_at)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS matches_one_active_unique ON matches ((1)) WHERE status != 'settled'",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS matches_winner_rollover_source_unique ON matches (winner_rollover_source_match_id) WHERE winner_rollover_source_match_id IS NOT NULL",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS matches_score_rollover_source_unique ON matches (score_rollover_source_match_id) WHERE score_rollover_source_match_id IS NOT NULL",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS bets_match_bettor_mode_unique ON bets (match_id, bettor_key, mode)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS bets_match_created_idx ON bets (match_id, created_at)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS receipt_snapshots_code_unique ON receipt_snapshots (code)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS receipt_snapshots_active_bet_unique ON receipt_snapshots (bet_id) WHERE kind = 'bet' AND status = 'active'",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS receipt_snapshots_active_match_kind_unique ON receipt_snapshots (match_id, kind) WHERE bet_id IS NULL AND status = 'active'",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS receipt_snapshots_bet_revision_unique ON receipt_snapshots (bet_id, revision) WHERE kind = 'bet'",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS receipt_snapshots_match_revision_unique ON receipt_snapshots (match_id, kind, revision) WHERE bet_id IS NULL",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS receipt_snapshots_match_created_idx ON receipt_snapshots (match_id, created_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS receipt_snapshots_bet_created_idx ON receipt_snapshots (bet_id, created_at)",
    ),
  ]);

  // Keep this after every index creation so SQLite can immediately choose the
  // rollover-source and active-match indexes.
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

interface RolloverMatchRow {
  id: number;
  status: "open" | "closed" | "settled";
  result_score_a: number | null;
  result_score_b: number | null;
  winner_rollover_in_cents: number;
  winner_rollover_out_cents: number | null;
  winner_rollover_source_match_id: number | null;
  score_rollover_in_cents: number;
  score_rollover_out_cents: number | null;
  score_rollover_source_match_id: number | null;
}

interface RolloverTotalsRow {
  winner_stake_cents: number;
  score_stake_cents: number;
  winner_hit: number;
  score_hit: number;
}

/**
 * Older databases did not persist rollover snapshots. Walk settled matches in
 * creation order once, materialising the same deterministic chain used for new
 * matches. Rows that already have outputs are treated as immutable snapshots.
 */
async function backfillRolloverSnapshots(d1: ReturnType<typeof getD1>) {
  const result = await d1
    .prepare("SELECT * FROM matches ORDER BY id ASC")
    .all<RolloverMatchRow>();
  const rows = (result.results ?? []) as RolloverMatchRow[];
  let preceding: RolloverMatchRow | undefined;

  for (const row of rows) {
    if (row.status !== "settled") continue;

    if (
      (row.winner_rollover_out_cents === null ||
        row.score_rollover_out_cents === null) &&
      row.result_score_a !== null &&
      row.result_score_b !== null
    ) {
      const winnerCanInherit =
        row.winner_rollover_out_cents === null &&
        row.winner_rollover_source_match_id === null &&
        row.winner_rollover_in_cents === 0 &&
        preceding?.winner_rollover_out_cents !== null &&
        preceding?.winner_rollover_out_cents !== undefined;
      const scoreCanInherit =
        row.score_rollover_out_cents === null &&
        row.score_rollover_source_match_id === null &&
        row.score_rollover_in_cents === 0 &&
        preceding?.score_rollover_out_cents !== null &&
        preceding?.score_rollover_out_cents !== undefined;
      const winnerRolloverIn = winnerCanInherit
        ? preceding!.winner_rollover_out_cents!
        : row.winner_rollover_in_cents;
      const scoreRolloverIn = scoreCanInherit
        ? preceding!.score_rollover_out_cents!
        : row.score_rollover_in_cents;
      const winnerSource = winnerCanInherit
        ? preceding!.id
        : row.winner_rollover_source_match_id;
      const scoreSource = scoreCanInherit
        ? preceding!.id
        : row.score_rollover_source_match_id;
      const winnerSide =
        row.result_score_a > row.result_score_b ? "A" : "B";
      const totals = await d1
        .prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN mode = 'winner' THEN amount_cents ELSE 0 END), 0) AS winner_stake_cents,
            COALESCE(SUM(CASE WHEN mode = 'score' THEN amount_cents ELSE 0 END), 0) AS score_stake_cents,
            COALESCE(MAX(CASE WHEN mode = 'winner' AND winner_pick = ? THEN 1 ELSE 0 END), 0) AS winner_hit,
            COALESCE(MAX(CASE WHEN mode = 'score' AND predicted_score_a = ? AND predicted_score_b = ? THEN 1 ELSE 0 END), 0) AS score_hit
          FROM bets
          WHERE match_id = ?
        `)
        .bind(
          winnerSide,
          row.result_score_a,
          row.result_score_b,
          row.id,
        )
        .first<RolloverTotalsRow>();

      if (!totals) {
        throw new Error(`无法回填第 ${row.id} 场比赛的滚存快照。`);
      }
      assertSafeCents(totals.winner_stake_cents);
      assertSafeCents(totals.score_stake_cents);
      assertSafeCents(winnerRolloverIn);
      assertSafeCents(scoreRolloverIn);

      const championPrize = Math.floor((totals.winner_stake_cents + 2) / 5);
      const winnerAvailable =
        totals.winner_stake_cents - championPrize + winnerRolloverIn;
      const scoreAvailable = totals.score_stake_cents + scoreRolloverIn;
      assertSafeCents(winnerAvailable);
      assertSafeCents(scoreAvailable);
      const winnerRolloverOut = totals.winner_hit ? 0 : winnerAvailable;
      const scoreRolloverOut = totals.score_hit ? 0 : scoreAvailable;

      await d1
        .prepare(`
          UPDATE matches
          SET winner_rollover_in_cents = ?,
              winner_rollover_out_cents = COALESCE(winner_rollover_out_cents, ?),
              winner_rollover_source_match_id = ?,
              score_rollover_in_cents = ?,
              score_rollover_out_cents = COALESCE(score_rollover_out_cents, ?),
              score_rollover_source_match_id = ?
          WHERE id = ?
        `)
        .bind(
          winnerRolloverIn,
          winnerRolloverOut,
          winnerSource,
          scoreRolloverIn,
          scoreRolloverOut,
          scoreSource,
          row.id,
        )
        .run();

      row.winner_rollover_in_cents = winnerRolloverIn;
      row.winner_rollover_out_cents ??= winnerRolloverOut;
      row.winner_rollover_source_match_id = winnerSource;
      row.score_rollover_in_cents = scoreRolloverIn;
      row.score_rollover_out_cents ??= scoreRolloverOut;
      row.score_rollover_source_match_id = scoreSource;
    }

    if (
      row.winner_rollover_out_cents !== null &&
      row.score_rollover_out_cents !== null
    ) {
      preceding = row;
    }
  }

  const active = rows.find((row) => row.status !== "settled");
  if (!active || !preceding || active.id < preceding.id) return;

  const winnerCanInherit =
    active.winner_rollover_source_match_id === null &&
    active.winner_rollover_in_cents === 0 &&
    preceding.winner_rollover_out_cents !== null;
  const scoreCanInherit =
    active.score_rollover_source_match_id === null &&
    active.score_rollover_in_cents === 0 &&
    preceding.score_rollover_out_cents !== null;
  if (!winnerCanInherit && !scoreCanInherit) return;

  await d1
    .prepare(`
      UPDATE matches
      SET winner_rollover_in_cents = ?,
          winner_rollover_source_match_id = ?,
          score_rollover_in_cents = ?,
          score_rollover_source_match_id = ?
      WHERE id = ?
    `)
    .bind(
      winnerCanInherit
        ? preceding.winner_rollover_out_cents
        : active.winner_rollover_in_cents,
      winnerCanInherit
        ? preceding.id
        : active.winner_rollover_source_match_id,
      scoreCanInherit
        ? preceding.score_rollover_out_cents
        : active.score_rollover_in_cents,
      scoreCanInherit ? preceding.id : active.score_rollover_source_match_id,
      active.id,
    )
    .run();
}

function assertSafeCents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("数据库中的金额超出了可安全结算的范围。");
  }
}
