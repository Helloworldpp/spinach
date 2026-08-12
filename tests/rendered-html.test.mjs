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

test("persists versioned receipt images and protects permanent deletion", async () => {
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
  assert.match(page, /下注票据/);
  assert.match(page, /封盘快照/);
  assert.match(page, /结算票据/);
  assert.match(page, /action: "deleteMatch"/);
  assert.match(route, /ADMIN_PASSWORD_SHA256/);
  assert.match(route, /async function setStatus[\s\S]*assertAdminPassword\(payload\.password\)/);
  assert.match(route, /async function settleMatch[\s\S]*assertAdminPassword\(payload\.password\)/);
  assert.match(page, /statusPassword/);
  assert.match(page, /settlePassword/);
  assert.match(route, /SELECT MAX\(id\) FROM matches/);
  assert.match(route, /betResults/);
  assert.match(schema, /receiptSnapshots/);
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? `receipt_snapshots`/);
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
  assert.match(route, /betSummaries/);
  assert.match(route, /estimatedPayoutCents/);
  assert.match(canvas, /renderSealedSummaryReceipt/);
  assert.match(canvas, /封盘下注汇总/);
  assert.match(canvas, /drawSealedTable/);
});
