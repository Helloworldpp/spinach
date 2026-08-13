import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("defines the finished Chinese betting ledger shell", async () => {
  const [page, layout, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /<html lang="zh-CN">/);
  assert.match(layout, /一杆定胜负｜好友台球下注簿/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /正在摆好球台/);
  assert.match(css, /--gold: #e3b64f/);
  assert.doesNotMatch(
    `${page}\n${layout}`,
    /codex-preview|Your site is taking shape|Starter Project/,
  );
});

test("ships both betting modes without starter preview assets", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /title: "胜负局"/);
  assert.match(page, /title: "猜比分"/);
  assert.match(page, /fetch\("\/api\/game"/);
  assert.match(page, /action: "settle"/);
  assert.match(layout, /一杆定胜负｜好友台球下注簿/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("documents two isolated rollover chains and score-pool projections", async () => {
  const [page, route, database] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /两个独立奖池/);
  assert.match(page, /胜负滚存链/);
  assert.match(page, /比分滚存链/);
  assert.match(page, /projectedScoreReturn/);
  assert.match(page, /1\.00×/);
  assert.match(route, /winner_rollover_out_cents/);
  assert.match(route, /score_rollover_out_cents/);
  assert.match(route, /newStakeCents/);
  assert.match(database, /backfillRolloverSnapshots/);
  assert.match(database, /matches_winner_rollover_source_unique/);
  assert.match(database, /matches_score_rollover_source_unique/);
  assert.match(database, /matches_rollover_nonnegative_insert/);
  assert.match(database, /matches_rollover_nonnegative_update/);
});

test("persists sealed snapshots and shows the settlement payment summary", async () => {
  const [page, canvas, route, schema, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/receipt-canvas.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_parched_nighthawk.sql", import.meta.url), "utf8"),
  ]);

  assert.match(canvas, /canvas\.width = 1080/);
  assert.match(canvas, /canvas\.height = 1440/);
  assert.match(canvas, /renderReceipt/);
  assert.match(page, /ClipboardItem/);
  assert.doesNotMatch(page, /下注票据/);
  assert.match(page, /封盘快照/);
  assert.doesNotMatch(page, /结算票据/);
  assert.match(page, /本场应付款汇总/);
  assert.match(page, /请按“应付金额”转账/);
  assert.match(page, /action: "deleteMatch"/);
  assert.match(route, /ADMIN_PASSWORD_SHA256/);
  assert.match(route, /async function setStatus[\s\S]*assertAdminPassword\(payload\.password\)/);
  assert.match(route, /async function settleMatch[\s\S]*assertAdminPassword\(payload\.password\)/);
  assert.match(page, /statusPassword/);
  assert.match(page, /settlePassword/);
  assert.match(route, /SELECT MAX\(id\) FROM matches/);
  assert.doesNotMatch(route, /buildSettledArtifactPayload/);
  assert.match(route, /WHERE kind = 'sealed'/);
  assert.match(schema, /receiptSnapshots/);
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? `receipt_snapshots`/);
});

test("uses the full winner pool and does not create per-bet receipts", async () => {
  const [page, route, schema, database, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_first_maximus.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /100% 归猜中胜者/);
  assert.match(page, /胜负下注与胜负滚存全部参与分配/);
  assert.match(page, /match\.winnerPrizeBps > 0/);
  assert.doesNotMatch(route, /makeArtifactCode\("BET"/);
  assert.doesNotMatch(route, /buildBetArtifactPayload/);
  assert.match(route, /WHERE kind = 'sealed'/);
  assert.match(schema, /winnerPrizeBps: integer\("winner_prize_bps"\).*default\(0\)/s);
  assert.match(database, /status = 'settled'/);
  assert.match(migration, /ADD `winner_prize_bps` integer DEFAULT 0 NOT NULL/);
  assert.match(migration, /SET `winner_prize_bps` = 2000 WHERE `status` = 'settled'/);
});

test("enforces the fixed one-to-ten-yuan bet range", async () => {
  const [page, route] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const MIN_BET_CENTS = 100/);
  assert.match(page, /const MAX_BET_CENTS = 1000/);
  assert.match(page, /min="1"/);
  assert.match(page, /max="10"/);
  assert.match(page, /单注 ¥1 — ¥10/);
  assert.match(route, /amountCents < MIN_BET_CENTS/);
  assert.match(route, /amountCents > MAX_BET_CENTS/);
  assert.match(route, /单注不能低于 1 元/);
  assert.match(route, /单注不能超过 10 元/);
});

test("renders detailed sealed summaries on page and downloadable snapshot", async () => {
  const [page, route, canvas] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/receipt-canvas.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /封盘下注汇总/);
  assert.match(page, /MODE_COPY\[summaryMode\]\.title}下注汇总/);
  assert.match(page, /预估奖金/);
  assert.match(page, /预估净赢/);
  assert.match(page, /实际返还/);
  assert.match(page, /实际净赢/);
  assert.match(page, /未命中返还为 ¥0/);
  assert.match(page, /estimated-loss/);
  assert.match(route, /betSummaries/);
  assert.match(route, /estimatedPayoutCents/);
  assert.match(canvas, /renderSealedSummaryReceipt/);
  assert.match(canvas, /封盘下注汇总/);
  assert.match(canvas, /drawSealedTable/);
});

test("persists bettor cheers across ledgers and receipt snapshots", async () => {
  const [page, route, schema, database, canvas, css, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/receipt-canvas.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_fast_slipstream.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /助威备注/);
  assert.match(page, /betNote\.trim\(\)/);
  assert.doesNotMatch(page, /alipay-payment-code\.png/);
  assert.match(route, /optionalText\(payload\.note, 80\)/);
  assert.match(route, /note: bet\.note/);
  assert.match(schema, /note: text\("note"\)/);
  assert.match(database, /ALTER TABLE bets ADD COLUMN note/);
  assert.match(canvas, /textValue\(summary, \["note"\]/);
  assert.match(canvas, /if \(bet\.note\)/);
  assert.doesNotMatch(css, /\.payment-code \{/);
  assert.match(migration, /ALTER TABLE `bets` ADD `note`/);
});
