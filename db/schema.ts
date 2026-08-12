import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    playerA: text("player_a").notNull(),
    playerB: text("player_b").notNull(),
    raceTo: integer("race_to").notNull().default(3),
    stakeLimitCents: integer("stake_limit_cents").notNull().default(1000),
    status: text("status", { enum: ["open", "closed", "settled"] })
      .notNull()
      .default("open"),
    resultScoreA: integer("result_score_a"),
    resultScoreB: integer("result_score_b"),
    winnerRolloverInCents: integer("winner_rollover_in_cents")
      .notNull()
      .default(0),
    winnerRolloverOutCents: integer("winner_rollover_out_cents"),
    winnerRolloverSourceMatchId: integer("winner_rollover_source_match_id"),
    scoreRolloverInCents: integer("score_rollover_in_cents")
      .notNull()
      .default(0),
    scoreRolloverOutCents: integer("score_rollover_out_cents"),
    scoreRolloverSourceMatchId: integer("score_rollover_source_match_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    settledAt: text("settled_at"),
  },
  (table) => [
    check(
      "matches_status_check",
      sql`${table.status} IN ('open', 'closed', 'settled')`,
    ),
    check("matches_race_to_check", sql`${table.raceTo} > 0`),
    check(
      "matches_stake_limit_check",
      sql`${table.stakeLimitCents} > 0`,
    ),
    check(
      "matches_rollover_in_check",
      sql`${table.winnerRolloverInCents} >= 0 AND ${table.scoreRolloverInCents} >= 0`,
    ),
    check(
      "matches_rollover_out_check",
      sql`(${table.winnerRolloverOutCents} IS NULL OR ${table.winnerRolloverOutCents} >= 0) AND (${table.scoreRolloverOutCents} IS NULL OR ${table.scoreRolloverOutCents} >= 0)`,
    ),
    uniqueIndex("matches_one_active_unique")
      .on(sql`(1)`)
      .where(sql`${table.status} != 'settled'`),
    uniqueIndex("matches_winner_rollover_source_unique")
      .on(table.winnerRolloverSourceMatchId)
      .where(sql`${table.winnerRolloverSourceMatchId} IS NOT NULL`),
    uniqueIndex("matches_score_rollover_source_unique")
      .on(table.scoreRolloverSourceMatchId)
      .where(sql`${table.scoreRolloverSourceMatchId} IS NOT NULL`),
    index("matches_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const bets = sqliteTable(
  "bets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    bettorName: text("bettor_name").notNull(),
    bettorKey: text("bettor_key").notNull(),
    note: text("note").notNull().default(""),
    mode: text("mode", { enum: ["winner", "score"] }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    winnerPick: text("winner_pick", { enum: ["A", "B"] }),
    predictedScoreA: integer("predicted_score_a"),
    predictedScoreB: integer("predicted_score_b"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("bets_mode_check", sql`${table.mode} IN ('winner', 'score')`),
    check("bets_amount_check", sql`${table.amountCents} > 0`),
    check(
      "bets_selection_check",
      sql`(
        ${table.mode} = 'winner'
        AND ${table.winnerPick} IN ('A', 'B')
        AND ${table.predictedScoreA} IS NULL
        AND ${table.predictedScoreB} IS NULL
      ) OR (
        ${table.mode} = 'score'
        AND ${table.winnerPick} IS NULL
        AND ${table.predictedScoreA} IS NOT NULL
        AND ${table.predictedScoreB} IS NOT NULL
        AND ${table.predictedScoreA} >= 0
        AND ${table.predictedScoreB} >= 0
      )`,
    ),
    uniqueIndex("bets_match_bettor_mode_unique").on(
      table.matchId,
      table.bettorKey,
      table.mode,
    ),
    index("bets_match_created_idx").on(table.matchId, table.createdAt),
  ],
);

export const receiptSnapshots = sqliteTable(
  "receipt_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    // Deliberately not a foreign key: cancelling/deleting a bet must not erase
    // its audit ticket. Deleting the whole match still cascades via match_id.
    betId: integer("bet_id"),
    kind: text("kind", { enum: ["bet", "sealed", "settled"] }).notNull(),
    status: text("status", {
      enum: ["active", "superseded", "cancelled"],
    })
      .notNull()
      .default("active"),
    code: text("code").notNull(),
    revision: integer("revision").notNull().default(1),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "receipt_snapshots_kind_check",
      sql`${table.kind} IN ('bet', 'sealed', 'settled')`,
    ),
    check(
      "receipt_snapshots_status_check",
      sql`${table.status} IN ('active', 'superseded', 'cancelled')`,
    ),
    check(
      "receipt_snapshots_target_check",
      sql`(${table.kind} = 'bet' AND ${table.betId} IS NOT NULL) OR (${table.kind} IN ('sealed', 'settled') AND ${table.betId} IS NULL)`,
    ),
    check(
      "receipt_snapshots_revision_check",
      sql`${table.revision} > 0`,
    ),
    check(
      "receipt_snapshots_code_check",
      sql`length(${table.code}) > 0`,
    ),
    check(
      "receipt_snapshots_payload_check",
      sql`json_valid(${table.payloadJson})`,
    ),
    uniqueIndex("receipt_snapshots_code_unique").on(table.code),
    uniqueIndex("receipt_snapshots_active_bet_unique")
      .on(table.betId)
      .where(sql`${table.kind} = 'bet' AND ${table.status} = 'active'`),
    uniqueIndex("receipt_snapshots_active_match_kind_unique")
      .on(table.matchId, table.kind)
      .where(
        sql`${table.betId} IS NULL AND ${table.status} = 'active'`,
      ),
    uniqueIndex("receipt_snapshots_bet_revision_unique")
      .on(table.betId, table.revision)
      .where(sql`${table.kind} = 'bet'`),
    uniqueIndex("receipt_snapshots_match_revision_unique")
      .on(table.matchId, table.kind, table.revision)
      .where(sql`${table.betId} IS NULL`),
    index("receipt_snapshots_match_created_idx").on(
      table.matchId,
      table.createdAt,
    ),
    index("receipt_snapshots_bet_created_idx").on(
      table.betId,
      table.createdAt,
    ),
  ],
);

export type MatchStatus = (typeof matches.$inferSelect)["status"];
export type BetMode = (typeof bets.$inferSelect)["mode"];
export type ReceiptKind = (typeof receiptSnapshots.$inferSelect)["kind"];
export type ReceiptStatus = (typeof receiptSnapshots.$inferSelect)["status"];
