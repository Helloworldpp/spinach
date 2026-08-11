import { ensureGameDatabase, getD1 } from "@/db";

type MatchStatus = "open" | "closed" | "settled";
type BetMode = "winner" | "score";
type WinnerSide = "A" | "B";

interface MatchRow {
  id: number;
  title: string;
  player_a: string;
  player_b: string;
  race_to: number;
  stake_limit_cents: number;
  status: MatchStatus;
  result_score_a: number | null;
  result_score_b: number | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface BetRow {
  id: number;
  match_id: number;
  bettor_name: string;
  bettor_key: string;
  mode: BetMode;
  amount_cents: number;
  winner_pick: WinnerSide | null;
  predicted_score_a: number | null;
  predicted_score_b: number | null;
  created_at: string;
  updated_at: string;
}

interface PublicBet {
  id: number;
  matchId: number;
  bettorName: string;
  mode: BetMode;
  amountCents: number;
  winnerPick: WinnerSide | null;
  winnerPickName: string | null;
  predictedScoreA: number | null;
  predictedScoreB: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SettlementPayout {
  betId: number;
  bettorName: string;
  amountCents: number;
  payoutCents: number;
}

interface ModeSettlement {
  mode: BetMode;
  totalPoolCents: number;
  championPrizeCents: number;
  guessPoolCents: number;
  totalCorrectStakeCents: number;
  rolloverCents: number;
  payouts: SettlementPayout[];
}

type JsonRecord = Record<string, unknown>;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function GET() {
  try {
    await ensureGameDatabase();
    return Response.json(await getSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureGameDatabase();
    const payload = await readPayload(request);
    const action = requiredText(payload.action, "缺少操作类型 action。", 30);

    switch (action) {
      case "createMatch":
        await createMatch(payload);
        break;
      case "addBet":
        await addBet(payload);
        break;
      case "deleteBet":
        await deleteBet(payload);
        break;
      case "setStatus":
        await setStatus(payload);
        break;
      case "settle":
        await settleMatch(payload);
        break;
      default:
        throw new ApiError(`不支持的操作：${action}。`);
    }

    return Response.json({ ok: true, ...(await getSnapshot()) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function readPayload(request: Request): Promise<JsonRecord> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError("请求内容必须是 JSON 对象。");
    }
    return value as JsonRecord;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("请求内容不是有效的 JSON。");
  }
}

async function createMatch(payload: JsonRecord) {
  const playerA = requiredText(payload.playerA, "请填写选手 A 的姓名。", 40);
  const playerB = requiredText(payload.playerB, "请填写选手 B 的姓名。", 40);

  if (normalizeName(playerA) === normalizeName(playerB)) {
    throw new ApiError("两位选手不能是同一人。");
  }

  const title = optionalText(payload.title, 80) || `${playerA} VS ${playerB}`;
  const raceTo = integerValue(payload.raceTo, "抢几局必须是整数。", 3);
  const stakeLimitCents = integerValue(
    payload.stakeLimitCents,
    "单注上限必须是整数分。",
    1000,
  );

  if (raceTo < 1 || raceTo > 99) {
    throw new ApiError("抢几局必须在 1 到 99 之间。");
  }
  if (stakeLimitCents < 1 || stakeLimitCents > 100_000_000) {
    throw new ApiError("单注上限必须在 1 分到 100 万元之间。");
  }

  const d1 = getD1();
  const current = await d1
    .prepare("SELECT * FROM matches WHERE status != 'settled' ORDER BY id DESC LIMIT 1")
    .first<MatchRow>();
  const now = new Date().toISOString();

  if (current) {
    const countRow = await d1
      .prepare("SELECT COUNT(*) AS count FROM bets WHERE match_id = ?")
      .bind(current.id)
      .first<{ count: number }>();

    if ((countRow?.count ?? 0) > 0) {
      throw new ApiError("当前比赛已有下注，请先结算当前比赛后再创建新比赛。", 409);
    }

    await d1
      .prepare(`
        UPDATE matches
        SET title = ?, player_a = ?, player_b = ?, race_to = ?,
            stake_limit_cents = ?, status = 'open', result_score_a = NULL,
            result_score_b = NULL, settled_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .bind(
        title,
        playerA,
        playerB,
        raceTo,
        stakeLimitCents,
        now,
        current.id,
      )
      .run();
    return;
  }

  await d1
    .prepare(`
      INSERT INTO matches (
        title, player_a, player_b, race_to, stake_limit_cents, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
    `)
    .bind(title, playerA, playerB, raceTo, stakeLimitCents, now, now)
    .run();
}

async function addBet(payload: JsonRecord) {
  const match = await getTargetMatch(optionalId(payload.matchId, "比赛 ID 无效。"));
  if (match.status !== "open") {
    throw new ApiError("当前比赛已封盘，不能新增或修改下注。", 409);
  }

  const bettorName = requiredText(payload.bettorName, "请填写下注人姓名。", 40);
  const bettorKey = normalizeName(bettorName);
  if (
    bettorKey === normalizeName(match.player_a) ||
    bettorKey === normalizeName(match.player_b)
  ) {
    throw new ApiError("参赛选手不能下注。");
  }

  const modeText = requiredText(payload.mode, "请选择下注模式。", 20);
  if (modeText !== "winner" && modeText !== "score") {
    throw new ApiError("下注模式只能是“胜负局”或“猜比分”。");
  }
  const mode: BetMode = modeText;
  const amountCents = integerValue(payload.amountCents, "下注金额必须是整数分。");
  if (amountCents < 1) {
    throw new ApiError("下注金额必须大于 0。");
  }
  if (amountCents > match.stake_limit_cents) {
    throw new ApiError(`单注不能超过 ${formatYuan(match.stake_limit_cents)} 元。`);
  }

  let winnerPick: WinnerSide | null = null;
  let predictedScoreA: number | null = null;
  let predictedScoreB: number | null = null;

  if (mode === "winner") {
    winnerPick = parseWinnerPick(
      payload.winnerPick ?? payload.pick,
      match,
    );
  } else {
    predictedScoreA = integerValue(
      payload.predictedScoreA ?? payload.scoreA,
      "请填写有效的 A 方预测比分。",
    );
    predictedScoreB = integerValue(
      payload.predictedScoreB ?? payload.scoreB,
      "请填写有效的 B 方预测比分。",
    );
    validateRaceToScore(predictedScoreA, predictedScoreB, match.race_to, "预测比分");
  }

  const now = new Date().toISOString();
  await getD1()
    .prepare(`
      INSERT INTO bets (
        match_id, bettor_name, bettor_key, mode, amount_cents, winner_pick,
        predicted_score_a, predicted_score_b, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (match_id, bettor_key, mode) DO UPDATE SET
        bettor_name = excluded.bettor_name,
        amount_cents = excluded.amount_cents,
        winner_pick = excluded.winner_pick,
        predicted_score_a = excluded.predicted_score_a,
        predicted_score_b = excluded.predicted_score_b,
        updated_at = excluded.updated_at
    `)
    .bind(
      match.id,
      bettorName,
      bettorKey,
      mode,
      amountCents,
      winnerPick,
      predictedScoreA,
      predictedScoreB,
      now,
      now,
    )
    .run();
}

async function deleteBet(payload: JsonRecord) {
  const betId = optionalId(payload.betId, "下注记录 ID 无效。");
  if (!betId) {
    throw new ApiError("请提供要删除的下注记录 ID。");
  }

  const bet = await getD1()
    .prepare(`
      SELECT b.*, m.status AS match_status
      FROM bets b
      JOIN matches m ON m.id = b.match_id
      WHERE b.id = ?
    `)
    .bind(betId)
    .first<BetRow & { match_status: MatchStatus }>();

  if (!bet) {
    throw new ApiError("找不到这条下注记录。", 404);
  }
  if (bet.match_status !== "open") {
    throw new ApiError("当前比赛已封盘，不能删除下注。", 409);
  }

  await getD1().prepare("DELETE FROM bets WHERE id = ?").bind(betId).run();
}

async function setStatus(payload: JsonRecord) {
  const match = await getTargetMatch(optionalId(payload.matchId, "比赛 ID 无效。"));
  const requested = requiredText(payload.status, "请提供目标状态。", 20);
  const status = requested === "close" ? "closed" : requested === "reopen" ? "open" : requested;

  if (status !== "open" && status !== "closed") {
    throw new ApiError("状态只能设为 open/closed（或 reopen/close）。");
  }
  if (match.status === "settled") {
    throw new ApiError("已结算的比赛不能重新开盘或封盘。", 409);
  }

  await getD1()
    .prepare("UPDATE matches SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, new Date().toISOString(), match.id)
    .run();
}

async function settleMatch(payload: JsonRecord) {
  const match = await getTargetMatch(optionalId(payload.matchId, "比赛 ID 无效。"));
  if (match.status === "open") {
    throw new ApiError("请先封盘，再结算比赛。", 409);
  }
  if (match.status === "settled") {
    throw new ApiError("这场比赛已经结算。", 409);
  }

  const scoreA = integerValue(payload.scoreA, "请填写有效的 A 方比分。");
  const scoreB = integerValue(payload.scoreB, "请填写有效的 B 方比分。");
  validateRaceToScore(scoreA, scoreB, match.race_to, "结算比分");

  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(`
      UPDATE matches
      SET status = 'settled', result_score_a = ?, result_score_b = ?,
          settled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'closed'
    `)
    .bind(scoreA, scoreB, now, now, match.id)
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError("比赛状态已变更，请刷新后重试。", 409);
  }
}

async function getTargetMatch(matchId?: number) {
  const d1 = getD1();
  const match = matchId
    ? await d1.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId).first<MatchRow>()
    : await d1
        .prepare(`
          SELECT * FROM matches
          ORDER BY CASE WHEN status = 'settled' THEN 1 ELSE 0 END, id DESC
          LIMIT 1
        `)
        .first<MatchRow>();

  if (!match) {
    throw new ApiError("找不到可操作的比赛。", 404);
  }
  return match;
}

async function getSnapshot() {
  const d1 = getD1();
  const [matchResult, betResult] = await Promise.all([
    d1.prepare("SELECT * FROM matches ORDER BY id DESC").all<MatchRow>(),
    d1.prepare("SELECT * FROM bets ORDER BY id ASC").all<BetRow>(),
  ]);
  const matchRows = (matchResult.results ?? []) as MatchRow[];
  const betRows = (betResult.results ?? []) as BetRow[];
  const betsByMatch = new Map<number, BetRow[]>();

  for (const bet of betRows) {
    const group = betsByMatch.get(bet.match_id);
    if (group) group.push(bet);
    else betsByMatch.set(bet.match_id, [bet]);
  }

  const publicMatches = matchRows.map((match) =>
    serializeMatch(match, betsByMatch.get(match.id) ?? []),
  );
  const activeIndex = publicMatches.findIndex((match) => match.status !== "settled");
  const selectedIndex = activeIndex >= 0 ? activeIndex : publicMatches.length ? 0 : -1;

  return {
    activeMatch: selectedIndex >= 0 ? publicMatches[selectedIndex] : null,
    history: publicMatches.filter((_, index) => index !== selectedIndex),
  };
}

function serializeMatch(match: MatchRow, rows: BetRow[]) {
  const bets: PublicBet[] = rows.map((bet) => ({
    id: bet.id,
    matchId: bet.match_id,
    bettorName: bet.bettor_name,
    mode: bet.mode,
    amountCents: bet.amount_cents,
    winnerPick: bet.winner_pick,
    winnerPickName:
      bet.winner_pick === "A"
        ? match.player_a
        : bet.winner_pick === "B"
          ? match.player_b
          : null,
    predictedScoreA: bet.predicted_score_a,
    predictedScoreB: bet.predicted_score_b,
    createdAt: bet.created_at,
    updatedAt: bet.updated_at,
  }));
  const hasResult =
    match.result_score_a !== null && match.result_score_b !== null;
  const winnerSide: WinnerSide | null = hasResult
    ? match.result_score_a! > match.result_score_b!
      ? "A"
      : "B"
    : null;

  return {
    id: match.id,
    title: match.title,
    playerA: match.player_a,
    playerB: match.player_b,
    raceTo: match.race_to,
    stakeLimitCents: match.stake_limit_cents,
    status: match.status,
    resultScoreA: match.result_score_a,
    resultScoreB: match.result_score_b,
    winnerSide,
    winnerName:
      winnerSide === "A"
        ? match.player_a
        : winnerSide === "B"
          ? match.player_b
          : null,
    createdAt: match.created_at,
    updatedAt: match.updated_at,
    settledAt: match.settled_at,
    bets,
    ...(match.status === "settled" && hasResult
      ? { settlement: calculateSettlements(rows, match.result_score_a!, match.result_score_b!) }
      : {}),
  };
}

function calculateSettlements(
  bets: BetRow[],
  resultScoreA: number,
  resultScoreB: number,
): ModeSettlement[] {
  const winner: WinnerSide = resultScoreA > resultScoreB ? "A" : "B";
  return (["winner", "score"] as const).map((mode) => {
    const modeBets = bets.filter((bet) => bet.mode === mode);
    const correct = modeBets.filter((bet) =>
      mode === "winner"
        ? bet.winner_pick === winner
        : bet.predicted_score_a === resultScoreA &&
          bet.predicted_score_b === resultScoreB,
    );
    const totalPool = sumAmounts(modeBets);
    // Round the champion's 20% share to the nearest cent, then give every
    // remaining cent to the guessing pool so the two shares always conserve
    // the full mode pool.
    const championPrize = (totalPool + BigInt(2)) / BigInt(5);
    const guessPool = totalPool - championPrize;
    const totalCorrectStake = sumAmounts(correct);

    if (totalCorrectStake === BigInt(0)) {
      return {
        mode,
        totalPoolCents: safeMoneyNumber(totalPool),
        championPrizeCents: safeMoneyNumber(championPrize),
        guessPoolCents: safeMoneyNumber(guessPool),
        totalCorrectStakeCents: 0,
        rolloverCents: safeMoneyNumber(guessPool),
        payouts: [],
      };
    }

    const shares = correct.map((bet) => {
      const numerator = guessPool * BigInt(bet.amount_cents);
      return {
        bet,
        payout: numerator / totalCorrectStake,
        remainder: numerator % totalCorrectStake,
      };
    });
    const allocated = shares.reduce(
      (sum, share) => sum + share.payout,
      BigInt(0),
    );
    let centsLeft = guessPool - allocated;
    const remainderOrder = [...shares].sort((left, right) => {
      if (left.remainder === right.remainder) return left.bet.id - right.bet.id;
      return left.remainder > right.remainder ? -1 : 1;
    });

    for (const share of remainderOrder) {
      if (centsLeft === BigInt(0)) break;
      share.payout += BigInt(1);
      centsLeft -= BigInt(1);
    }

    const payouts = shares
      .sort((left, right) => left.bet.id - right.bet.id)
      .map(({ bet, payout }) => ({
        betId: bet.id,
        bettorName: bet.bettor_name,
        amountCents: bet.amount_cents,
        payoutCents: safeMoneyNumber(payout),
      }));

    return {
      mode,
      totalPoolCents: safeMoneyNumber(totalPool),
      championPrizeCents: safeMoneyNumber(championPrize),
      guessPoolCents: safeMoneyNumber(guessPool),
      totalCorrectStakeCents: safeMoneyNumber(totalCorrectStake),
      rolloverCents: 0,
      payouts,
    };
  });
}

function sumAmounts(bets: BetRow[]) {
  return bets.reduce(
    (sum, bet) => sum + BigInt(bet.amount_cents),
    BigInt(0),
  );
}

function safeMoneyNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("金额超出可安全结算的范围。");
  }
  return Number(value);
}

function parseWinnerPick(value: unknown, match: MatchRow): WinnerSide {
  const pick = requiredText(value, "请选择支持的选手。", 40);
  const normalized = normalizeName(pick);
  if (normalized === "a" || normalized === normalizeName(match.player_a)) return "A";
  if (normalized === "b" || normalized === normalizeName(match.player_b)) return "B";
  throw new ApiError("胜负局的选择必须是选手 A 或选手 B。");
}

function validateRaceToScore(
  scoreA: number,
  scoreB: number,
  raceTo: number,
  label: string,
) {
  const valid =
    scoreA >= 0 &&
    scoreB >= 0 &&
    ((scoreA === raceTo && scoreB < raceTo) ||
      (scoreB === raceTo && scoreA < raceTo));
  if (!valid) {
    throw new ApiError(
      `${label}必须符合抢${raceTo}规则：胜方为 ${raceTo}，负方小于 ${raceTo}。`,
    );
  }
}

function requiredText(value: unknown, message: string, maxLength?: number) {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(message);
  const text = value.trim();
  if (maxLength && text.length > maxLength) {
    throw new ApiError(`内容不能超过 ${maxLength} 个字符。`);
  }
  return text;
}

function optionalText(value: unknown, maxLength: number) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim())
  ) {
    return "";
  }
  return requiredText(value, "文本内容无效。", maxLength);
}

function integerValue(value: unknown, message: string, fallback?: number) {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) {
    return fallback;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new ApiError(message);
  return parsed;
}

function optionalId(value: unknown, message: string) {
  if (value === undefined || value === null || value === "") return undefined;
  const id = integerValue(value, message);
  if (id < 1) throw new ApiError(message);
  return id;
}

function normalizeName(value: string) {
  return value.replace(/\s+/g, "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function formatYuan(cents: number) {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("/api/game failed", error);
  const detail = error instanceof Error ? error.message : "";
  const isDatabaseSetupError =
    detail.includes("D1") || detail.includes("no such table") || detail.includes("DB");
  return Response.json(
    {
      error: isDatabaseSetupError
        ? `数据库暂不可用：${detail || "请检查 D1 配置。"}`
        : "服务器处理失败，请稍后重试。",
    },
    { status: 500 },
  );
}
