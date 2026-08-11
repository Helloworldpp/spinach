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
