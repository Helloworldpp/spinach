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
    uniqueIndex("matches_one_active_unique")
      .on(sql`(1)`)
      .where(sql`${table.status} != 'settled'`),
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

export type MatchStatus = (typeof matches.$inferSelect)["status"];
export type BetMode = (typeof bets.$inferSelect)["mode"];
