import { ensureGameDatabase, getD1 } from "@/db";

type MatchStatus = "open" | "closed" | "settled";
type BetMode = "winner" | "score";
type WinnerSide = "A" | "B";
type ArtifactKind = "bet" | "sealed" | "settled";
type ArtifactStatus = "active" | "superseded" | "cancelled";

const ADMIN_PASSWORD_SHA256 =
  "4739ee3bd29e4f415da8ba9298a087e0fdc9c61378420ba8fbbab298bd74c4df";
const MIN_BET_CENTS = 100;
const MAX_BET_CENTS = 1000;
const SNAPSHOT_NOTICE = "票据为生成时刻的本地账簿快照。";

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
  winner_prize_bps: number;
  winner_rollover_in_cents: number;
  winner_rollover_out_cents: number | null;
  winner_rollover_source_match_id: number | null;
  score_rollover_in_cents: number;
  score_rollover_out_cents: number | null;
  score_rollover_source_match_id: number | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface BetRow {
  id: number;
  match_id: number;
  bettor_name: string;
  bettor_key: string;
  note: string;
  mode: BetMode;
  amount_cents: number;
  winner_pick: WinnerSide | null;
  predicted_score_a: number | null;
  predicted_score_b: number | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: number;
  match_id: number;
  bet_id: number | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  code: string;
  revision: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface PublicArtifact {
  id: number;
  matchId: number;
  betId: number | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  code: string;
  revision: number;
  payload: JsonRecord;
  createdAt: string;
  updatedAt: string;
}

interface PublicBet {
  id: number;
  matchId: number;
  bettorName: string;
  note: string;
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
  newStakeCents: number;
  rolloverInCents: number;
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

    let artifact: PublicArtifact | undefined;
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
      case "deleteMatch":
        await deleteMatch(payload);
        break;
      case "setStatus":
        artifact = await setStatus(payload);
        break;
      case "settle":
        await settleMatch(payload);
        break;
      default:
        throw new ApiError(`不支持的操作：${action}。`);
    }

    return Response.json({
      ok: true,
      ...(await getSnapshot()),
      ...(artifact ? { artifact } : {}),
    });
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
  const stakeLimitCents = MAX_BET_CENTS;

  if (raceTo < 1 || raceTo > 99) {
    throw new ApiError("抢几局必须在 1 到 99 之间。");
  }
  const d1 = getD1();
  const current = await d1
    .prepare("SELECT * FROM matches WHERE status != 'settled' ORDER BY id DESC LIMIT 1")
    .first<MatchRow>();
  const now = new Date().toISOString();

  if (current) {
    const countRow = await d1
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM bets WHERE match_id = ?) AS bet_count,
          (SELECT COUNT(*) FROM receipt_snapshots WHERE match_id = ?) AS artifact_count
      `)
      .bind(current.id, current.id)
      .first<{ bet_count: number; artifact_count: number }>();

    if ((countRow?.bet_count ?? 0) > 0) {
      throw new ApiError("当前比赛已有下注，请先结算当前比赛后再创建新比赛。", 409);
    }
    if ((countRow?.artifact_count ?? 0) > 0) {
      throw new ApiError("当前比赛已有历史快照，请先删除当前比赛后再创建新比赛。", 409);
    }

    const result = await d1
      .prepare(`
        UPDATE matches
        SET title = ?, player_a = ?, player_b = ?, race_to = ?,
            stake_limit_cents = ?, status = 'open', result_score_a = NULL,
            result_score_b = NULL, settled_at = NULL, updated_at = ?
        WHERE id = ?
          AND status != 'settled'
          AND updated_at = ?
          AND NOT EXISTS (SELECT 1 FROM bets WHERE match_id = matches.id)
          AND NOT EXISTS (
            SELECT 1 FROM receipt_snapshots WHERE match_id = matches.id
          )
      `)
      .bind(
        title,
        playerA,
        playerB,
        raceTo,
        stakeLimitCents,
        nextTimestamp(current.updated_at),
        current.id,
        current.updated_at,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError("当前比赛已发生变化，请刷新后重试。", 409);
    }
    return;
  }

  const result = await d1
    .prepare(`
      INSERT OR IGNORE INTO matches (
        title, player_a, player_b, race_to, stake_limit_cents, status,
        winner_rollover_in_cents, winner_rollover_source_match_id,
        score_rollover_in_cents, score_rollover_source_match_id,
        created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, 'open',
             COALESCE(previous.winner_rollover_out_cents, 0), previous.id,
             COALESCE(previous.score_rollover_out_cents, 0), previous.id,
             ?, ?
      FROM (SELECT 1) AS seed
      LEFT JOIN (
        SELECT id, winner_rollover_out_cents, score_rollover_out_cents
        FROM matches
        WHERE status = 'settled'
          AND winner_rollover_out_cents IS NOT NULL
          AND score_rollover_out_cents IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      ) AS previous ON 1 = 1
      WHERE NOT EXISTS (SELECT 1 FROM matches WHERE status != 'settled')
    `)
    .bind(title, playerA, playerB, raceTo, stakeLimitCents, now, now)
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError("新比赛未创建：当前已有一场未结算的比赛。", 409);
  }
}

async function addBet(payload: JsonRecord) {
  const match = await getTargetMatch(optionalId(payload.matchId, "比赛 ID 无效。"));
  if (match.status !== "open") {
    throw new ApiError("当前比赛已封盘，不能新增或修改下注。", 409);
  }

  const bettorName = requiredText(payload.bettorName, "请填写下注人姓名。", 40);
  const note = optionalText(payload.note, 80);
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
  if (amountCents < MIN_BET_CENTS) {
    throw new ApiError("单注不能低于 1 元。");
  }
  if (amountCents > MAX_BET_CENTS) {
    throw new ApiError("单注不能超过 10 元。");
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

  const d1 = getD1();
  const now = nextTimestamp(match.updated_at);

  const results = await d1.batch([
    d1
      .prepare(`
        INSERT INTO bets (
          match_id, bettor_name, bettor_key, note, mode, amount_cents, winner_pick,
          predicted_score_a, predicted_score_b, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM matches
        WHERE id = ?
          AND status = 'open'
          AND title = ?
          AND player_a = ?
          AND player_b = ?
          AND race_to = ?
          AND stake_limit_cents = ?
          AND updated_at = ?
        ON CONFLICT (match_id, bettor_key, mode) DO UPDATE SET
          bettor_name = excluded.bettor_name,
          note = excluded.note,
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
        note,
        mode,
        amountCents,
        winnerPick,
        predictedScoreA,
        predictedScoreB,
        now,
        now,
        match.id,
        match.title,
        match.player_a,
        match.player_b,
        match.race_to,
        match.stake_limit_cents,
        match.updated_at,
      ),
    d1
      .prepare(`
        UPDATE matches
        SET updated_at = ?
        WHERE id = ? AND status = 'open' AND updated_at = ?
          AND EXISTS (
            SELECT 1 FROM bets
            WHERE match_id = matches.id
              AND bettor_key = ? AND mode = ? AND updated_at = ?
              AND bettor_name = ? AND amount_cents = ?
              AND note = ?
              AND winner_pick IS ?
              AND predicted_score_a IS ?
              AND predicted_score_b IS ?
          )
      `)
      .bind(
        now,
        match.id,
        match.updated_at,
        bettorKey,
        mode,
        now,
        bettorName,
        amountCents,
        note,
        winnerPick,
        predictedScoreA,
        predictedScoreB,
      ),
  ]);

  if (
    (results[0].meta.changes ?? 0) !== 1 ||
    (results[1].meta.changes ?? 0) !== 1
  ) {
    throw new ApiError("比赛状态已变更，请刷新后重试。", 409);
  }
}

async function deleteBet(payload: JsonRecord) {
  await assertAdminPassword(payload.password);
  const betId = optionalId(payload.betId, "下注记录 ID 无效。");
  if (!betId) {
    throw new ApiError("请提供要删除的下注记录 ID。");
  }

  const bet = await getD1()
    .prepare(`
      SELECT b.*, m.status AS match_status, m.updated_at AS match_updated_at
      FROM bets b
      JOIN matches m ON m.id = b.match_id
      WHERE b.id = ?
    `)
    .bind(betId)
    .first<BetRow & { match_status: MatchStatus; match_updated_at: string }>();

  if (!bet) {
    throw new ApiError("找不到这条下注记录。", 404);
  }
  if (bet.match_status !== "open") {
    throw new ApiError("当前比赛已封盘，不能删除下注。", 409);
  }

  const d1 = getD1();
  const now = nextTimestamp(bet.match_updated_at);
  const results = await d1.batch([
    d1
      .prepare(`
        UPDATE matches
        SET updated_at = ?
        WHERE id = ? AND status = 'open' AND updated_at = ?
          AND EXISTS (SELECT 1 FROM bets WHERE id = ? AND match_id = matches.id)
      `)
      .bind(now, bet.match_id, bet.match_updated_at, betId),
    d1
      .prepare(`
        UPDATE receipt_snapshots
        SET status = 'cancelled', updated_at = ?
        WHERE kind = 'bet' AND status = 'active' AND bet_id = ?
          AND EXISTS (
            SELECT 1 FROM matches
            WHERE id = ? AND status = 'open' AND updated_at = ?
          )
      `)
      .bind(now, betId, bet.match_id, now),
    d1
      .prepare(`
        DELETE FROM bets
        WHERE id = ? AND match_id = ?
          AND EXISTS (
            SELECT 1 FROM matches
            WHERE matches.id = bets.match_id
              AND matches.status = 'open' AND matches.updated_at = ?
          )
      `)
      .bind(betId, bet.match_id, now),
  ]);

  if (
    (results[0].meta.changes ?? 0) !== 1 ||
    (results[2].meta.changes ?? 0) !== 1
  ) {
    throw new ApiError("比赛状态已变更，请刷新后重试。", 409);
  }
}

async function deleteMatch(payload: JsonRecord) {
  await assertAdminPassword(payload.password);
  const matchId = optionalId(payload.matchId, "比赛 ID 无效。");
  if (!matchId) {
    throw new ApiError("请提供要删除的比赛 ID。");
  }

  const d1 = getD1();
  const existing = await d1
    .prepare("SELECT id FROM matches WHERE id = ?")
    .bind(matchId)
    .first<{ id: number }>();
  if (!existing) {
    throw new ApiError("找不到要删除的比赛。", 404);
  }

  const result = await d1
    .prepare(`
      DELETE FROM matches
      WHERE id = ? AND id = (SELECT MAX(id) FROM matches)
    `)
    .bind(matchId)
    .run();
  // D1 may include cascaded bet/artifact deletions in meta.changes.
  if ((result.meta.changes ?? 0) < 1) {
    throw new ApiError("为保护滚存记录，请从最新一场开始删除。", 409);
  }
}

async function setStatus(
  payload: JsonRecord,
): Promise<PublicArtifact | undefined> {
  await assertAdminPassword(payload.password);
  const match = await getTargetMatch(optionalId(payload.matchId, "比赛 ID 无效。"));
  const requested = requiredText(payload.status, "请提供目标状态。", 20);
  const status = requested === "close" ? "closed" : requested === "reopen" ? "open" : requested;

  if (status !== "open" && status !== "closed") {
    throw new ApiError("状态只能设为 open/closed（或 reopen/close）。");
  }
  if (match.status === "settled") {
    throw new ApiError("已结算的比赛不能重新开盘或封盘。", 409);
  }

  const d1 = getD1();
  const expectedStatus: MatchStatus = status === "open" ? "closed" : "open";
  const now = nextTimestamp(match.updated_at);

  if (status === "open") {
    const results = await d1.batch([
      d1
        .prepare(`
          UPDATE matches
          SET status = 'open', updated_at = ?
          WHERE id = ? AND status = 'closed' AND updated_at = ?
        `)
        .bind(now, match.id, match.updated_at),
      d1
        .prepare(`
          UPDATE receipt_snapshots
          SET status = 'superseded', updated_at = ?
          WHERE match_id = ? AND kind = 'sealed' AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM matches
              WHERE id = ? AND status = 'open' AND updated_at = ?
            )
        `)
        .bind(now, match.id, match.id, now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new ApiError("比赛状态已变更，请刷新后重试。", 409);
    }
    return undefined;
  }

  const betResult = await d1
    .prepare("SELECT * FROM bets WHERE match_id = ? ORDER BY id ASC")
    .bind(match.id)
    .all<BetRow>();
  const rows = (betResult.results ?? []) as BetRow[];
  const code = makeArtifactCode("LOCK", match.id);
  const artifactPayload = buildSealedArtifactPayload(match, rows, now);
  const results = await d1.batch([
    d1
      .prepare(`
        UPDATE matches
        SET status = 'closed', updated_at = ?
        WHERE id = ? AND status = ? AND updated_at = ?
      `)
      .bind(now, match.id, expectedStatus, match.updated_at),
    d1
      .prepare(`
        UPDATE receipt_snapshots
        SET status = 'superseded', updated_at = ?
        WHERE match_id = ? AND kind = 'sealed' AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM matches
            WHERE id = ? AND status = 'closed' AND updated_at = ?
          )
      `)
      .bind(now, match.id, match.id, now),
    d1
      .prepare(`
        INSERT INTO receipt_snapshots (
          match_id, bet_id, kind, status, code, revision, payload_json,
          created_at, updated_at
        )
        SELECT id, NULL, 'sealed', 'active', ?,
               COALESCE((
                 SELECT MAX(revision) FROM receipt_snapshots
                 WHERE match_id = ? AND kind = 'sealed' AND bet_id IS NULL
               ), 0) + 1,
               ?, ?, ?
        FROM matches
        WHERE id = ? AND status = 'closed' AND updated_at = ?
      `)
      .bind(
        code,
        match.id,
        JSON.stringify(artifactPayload),
        now,
        now,
        match.id,
        now,
      ),
  ]);

  if (
    (results[0].meta.changes ?? 0) !== 1 ||
    (results[2].meta.changes ?? 0) !== 1
  ) {
    throw new ApiError("比赛状态已变更，请刷新后重试。", 409);
  }

  return getArtifactByCode(code);
}

async function settleMatch(payload: JsonRecord) {
  await assertAdminPassword(payload.password);
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

  const d1 = getD1();
  const betResult = await d1
    .prepare("SELECT * FROM bets WHERE match_id = ? ORDER BY id ASC")
    .bind(match.id)
    .all<BetRow>();
  const rows = (betResult.results ?? []) as BetRow[];
  const now = nextTimestamp(match.updated_at);
  const { winnerRolloverOutCents, scoreRolloverOutCents } =
    calculateRolloverOutputs(rows, match, scoreA, scoreB);
  const sealedArtifactPayload = buildSealedArtifactPayload(
    match,
    rows,
    match.updated_at,
  );
  const results = await d1.batch([
    d1
      .prepare(`
        UPDATE matches
        SET status = 'settled', result_score_a = ?, result_score_b = ?,
            winner_rollover_out_cents = ?, score_rollover_out_cents = ?,
            settled_at = ?, updated_at = ?
        WHERE id = ? AND status = 'closed' AND updated_at = ?
          AND winner_rollover_out_cents IS NULL
          AND score_rollover_out_cents IS NULL
      `)
      .bind(
        scoreA,
        scoreB,
        winnerRolloverOutCents,
        scoreRolloverOutCents,
        now,
        now,
        match.id,
        match.updated_at,
      ),
    d1
      .prepare(`
        UPDATE receipt_snapshots
        SET payload_json = ?, updated_at = ?
        WHERE match_id = ? AND kind = 'sealed' AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM matches
            WHERE id = ? AND status = 'settled' AND updated_at = ?
          )
      `)
      .bind(
        JSON.stringify(sealedArtifactPayload),
        now,
        match.id,
        match.id,
        now,
      ),
  ]);

  if ((results[0].meta.changes ?? 0) !== 1) {
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
  const [matchResult, betResult, artifactResult] = await Promise.all([
    d1.prepare("SELECT * FROM matches ORDER BY id DESC").all<MatchRow>(),
    d1.prepare("SELECT * FROM bets ORDER BY id ASC").all<BetRow>(),
    d1
      .prepare("SELECT * FROM receipt_snapshots WHERE kind = 'sealed' ORDER BY created_at DESC, id DESC")
      .all<ArtifactRow>(),
  ]);
  const matchRows = (matchResult.results ?? []) as MatchRow[];
  const betRows = (betResult.results ?? []) as BetRow[];
  const artifactRows = (artifactResult.results ?? []) as ArtifactRow[];
  const betsByMatch = new Map<number, BetRow[]>();
  const artifactsByMatch = new Map<number, ArtifactRow[]>();

  for (const bet of betRows) {
    const group = betsByMatch.get(bet.match_id);
    if (group) group.push(bet);
    else betsByMatch.set(bet.match_id, [bet]);
  }

  for (const artifact of artifactRows) {
    const group = artifactsByMatch.get(artifact.match_id);
    if (group) group.push(artifact);
    else artifactsByMatch.set(artifact.match_id, [artifact]);
  }

  const publicMatches = matchRows.map((match) =>
    serializeMatch(
      match,
      betsByMatch.get(match.id) ?? [],
      artifactsByMatch.get(match.id) ?? [],
    ),
  );
  const activeIndex = publicMatches.findIndex((match) => match.status !== "settled");
  const selectedIndex = activeIndex >= 0 ? activeIndex : publicMatches.length ? 0 : -1;

  return {
    activeMatch: selectedIndex >= 0 ? publicMatches[selectedIndex] : null,
    history: publicMatches.filter((_, index) => index !== selectedIndex),
  };
}

function serializeMatch(
  match: MatchRow,
  rows: BetRow[],
  artifactRows: ArtifactRow[],
) {
  const bets: PublicBet[] = rows.map((bet) => ({
    id: bet.id,
    matchId: bet.match_id,
    bettorName: bet.bettor_name,
    note: bet.note,
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
    winnerPrizeBps: match.winner_prize_bps,
    winnerRolloverInCents: match.winner_rollover_in_cents,
    winnerRolloverOutCents: match.winner_rollover_out_cents,
    scoreRolloverInCents: match.score_rollover_in_cents,
    scoreRolloverOutCents: match.score_rollover_out_cents,
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
    artifacts: artifactRows.map((artifact) => {
      const serialized = serializeArtifact(artifact);
      if (
        match.status === "closed" &&
        artifact.kind === "sealed" &&
        artifact.status === "active"
      ) {
        return {
          ...serialized,
          payload: buildSealedArtifactPayload(match, rows, artifact.created_at),
        };
      }
      return serialized;
    }),
    ...(match.status === "settled" && hasResult
      ? {
          settlement: calculateSettlements(
            rows,
            match.result_score_a!,
            match.result_score_b!,
            match,
          ),
        }
      : {}),
  };
}

function calculateSettlements(
  bets: BetRow[],
  resultScoreA: number,
  resultScoreB: number,
  match: MatchRow,
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
    const newStake = sumAmounts(modeBets);
    const rolloverIn = BigInt(
      mode === "winner"
        ? match.winner_rollover_in_cents
        : match.score_rollover_in_cents,
    );
    const persistedRolloverOut =
      mode === "winner"
        ? match.winner_rollover_out_cents
        : match.score_rollover_out_cents;
    if (persistedRolloverOut === null) {
      throw new Error(`第 ${match.id} 场比赛缺少${mode === "winner" ? "胜负" : "比分"}滚存结算快照。`);
    }

    const championPrize =
      mode === "winner"
        ? roundedBasisPoints(newStake, match.winner_prize_bps)
        : BigInt(0);
    const guessPool = newStake - championPrize + rolloverIn;
    const totalCorrectStake = sumAmounts(correct);

    if (totalCorrectStake === BigInt(0)) {
      return {
        mode,
        newStakeCents: safeMoneyNumber(newStake),
        rolloverInCents: safeMoneyNumber(rolloverIn),
        totalPoolCents: safeMoneyNumber(guessPool),
        championPrizeCents: safeMoneyNumber(championPrize),
        guessPoolCents: safeMoneyNumber(guessPool),
        totalCorrectStakeCents: 0,
        rolloverCents: persistedRolloverOut,
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
      newStakeCents: safeMoneyNumber(newStake),
      rolloverInCents: safeMoneyNumber(rolloverIn),
      totalPoolCents: safeMoneyNumber(guessPool),
      championPrizeCents: safeMoneyNumber(championPrize),
      guessPoolCents: safeMoneyNumber(guessPool),
      totalCorrectStakeCents: safeMoneyNumber(totalCorrectStake),
      rolloverCents: persistedRolloverOut,
      payouts,
    };
  });
}

function calculateRolloverOutputs(
  rows: BetRow[],
  match: MatchRow,
  scoreA: number,
  scoreB: number,
) {
  const winnerSide: WinnerSide = scoreA > scoreB ? "A" : "B";
  const winnerBets = rows.filter((bet) => bet.mode === "winner");
  const scoreBets = rows.filter((bet) => bet.mode === "score");
  const winnerStake = sumAmounts(winnerBets);
  const scoreStake = sumAmounts(scoreBets);
  const championPrize = roundedBasisPoints(
    winnerStake,
    match.winner_prize_bps,
  );
  const winnerAvailable =
    winnerStake - championPrize + BigInt(match.winner_rollover_in_cents);
  const scoreAvailable = scoreStake + BigInt(match.score_rollover_in_cents);
  const winnerHit = winnerBets.some((bet) => bet.winner_pick === winnerSide);
  const scoreHit = scoreBets.some(
    (bet) =>
      bet.predicted_score_a === scoreA && bet.predicted_score_b === scoreB,
  );

  return {
    winnerRolloverOutCents: winnerHit ? 0 : safeMoneyNumber(winnerAvailable),
    scoreRolloverOutCents: scoreHit ? 0 : safeMoneyNumber(scoreAvailable),
  };
}

function buildSealedArtifactPayload(
  match: MatchRow,
  rows: BetRow[],
  generatedAt: string,
): JsonRecord {
  const winnerPool = calculatePoolSnapshot(rows, match, "winner");
  const scorePool = calculatePoolSnapshot(rows, match, "score");
  const winnerOptions = (["A", "B"] as const)
    .map((side) => ({
      key: side,
      label: side === "A" ? match.player_a : match.player_b,
      stakeCents: safeMoneyNumber(
        sumAmounts(
          rows.filter(
            (bet) => bet.mode === "winner" && bet.winner_pick === side,
          ),
        ),
      ),
    }))
    .filter((option) => option.stakeCents > 0);
  const scoreTotals = new Map<string, bigint>();
  for (const bet of rows) {
    if (
      bet.mode !== "score" ||
      bet.predicted_score_a === null ||
      bet.predicted_score_b === null
    ) {
      continue;
    }
    const key = `${bet.predicted_score_a}:${bet.predicted_score_b}`;
    scoreTotals.set(
      key,
      (scoreTotals.get(key) ?? BigInt(0)) + BigInt(bet.amount_cents),
    );
  }
  const scoreOptions = [...scoreTotals.entries()]
    .map(([key, stake]) => {
      const [scoreA, scoreB] = key.split(":").map(Number);
      return {
        key,
        label: key,
        scoreA,
        scoreB,
        stakeCents: safeMoneyNumber(stake),
      };
    })
    .sort((left, right) =>
      left.scoreA === right.scoreA
        ? left.scoreB - right.scoreB
        : right.scoreA - left.scoreA,
    );
  const betSummaries = rows.map((bet) => {
    const pool = bet.mode === "winner" ? winnerPool : scorePool;
    const selectionStake = sumAmounts(
      rows.filter((candidate) => sameSelection(candidate, bet)),
    );
    const estimatedPayout =
      selectionStake > BigInt(0)
        ? (BigInt(pool.distributablePoolCents) * BigInt(bet.amount_cents) +
            selectionStake / BigInt(2)) /
          selectionStake
        : BigInt(0);
    const estimatedPayoutCents = safeMoneyNumber(estimatedPayout);
    const selectionLabel =
      bet.mode === "winner"
        ? bet.winner_pick === "A"
          ? match.player_a
          : match.player_b
        : `${bet.predicted_score_a}:${bet.predicted_score_b}`;

    return {
      betId: bet.id,
      bettorName: bet.bettor_name,
      note: bet.note,
      mode: bet.mode,
      selectionLabel,
      amountCents: bet.amount_cents,
      estimatedPayoutCents,
      estimatedNetProfitCents: estimatedPayoutCents - bet.amount_cents,
      estimatedMultiplier: Number(
        (estimatedPayoutCents / bet.amount_cents).toFixed(2),
      ),
    };
  });

  return {
    schemaVersion: 1,
    kind: "sealed",
    generatedAt,
    notice: SNAPSHOT_NOTICE,
    betCount: rows.length,
    betSummaries,
    match: buildMatchArtifactSummary(match),
    pools: {
      winner: {
        mode: "winner",
        betCount: rows.filter((bet) => bet.mode === "winner").length,
        ...winnerPool,
        options: winnerOptions,
      },
      score: {
        mode: "score",
        betCount: rows.filter((bet) => bet.mode === "score").length,
        ...scorePool,
        options: scoreOptions,
      },
    },
  };
}

function calculatePoolSnapshot(
  rows: BetRow[],
  match: MatchRow,
  mode: BetMode,
) {
  const newStake = sumAmounts(rows.filter((bet) => bet.mode === mode));
  const rolloverIn = BigInt(
    mode === "winner"
      ? match.winner_rollover_in_cents
      : match.score_rollover_in_cents,
  );
  const grossPool = newStake + rolloverIn;
  const championPrize =
    mode === "winner"
      ? roundedBasisPoints(newStake, match.winner_prize_bps)
      : BigInt(0);
  const distributablePool = grossPool - championPrize;

  return {
    newStakeCents: safeMoneyNumber(newStake),
    rolloverInCents: safeMoneyNumber(rolloverIn),
    grossPoolCents: safeMoneyNumber(grossPool),
    championPrizeCents: safeMoneyNumber(championPrize),
    distributablePoolCents: safeMoneyNumber(distributablePool),
  };
}

function buildMatchArtifactSummary(match: MatchRow) {
  return {
    id: match.id,
    title: match.title,
    playerA: match.player_a,
    playerB: match.player_b,
    raceTo: match.race_to,
    stakeLimitCents: match.stake_limit_cents,
    winnerPrizeBps: match.winner_prize_bps,
  };
}

function roundedBasisPoints(amount: bigint, basisPoints: number) {
  return (
    amount * BigInt(basisPoints) + BigInt(5000)
  ) / BigInt(10000);
}

function sameSelection(left: BetRow, right: BetRow) {
  if (left.mode !== right.mode) return false;
  return left.mode === "winner"
    ? left.winner_pick === right.winner_pick
    : left.predicted_score_a === right.predicted_score_a &&
        left.predicted_score_b === right.predicted_score_b;
}

async function getArtifactByCode(code: string): Promise<PublicArtifact> {
  const row = await getD1()
    .prepare("SELECT * FROM receipt_snapshots WHERE code = ?")
    .bind(code)
    .first<ArtifactRow>();
  if (!row) {
    throw new Error("票据快照写入后无法读取。");
  }
  return serializeArtifact(row);
}

function serializeArtifact(row: ArtifactRow): PublicArtifact {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error(`票据 ${row.code} 的数据不是有效 JSON。`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`票据 ${row.code} 的数据结构无效。`);
  }

  return {
    id: row.id,
    matchId: row.match_id,
    betId: row.bet_id,
    kind: row.kind,
    status: row.status,
    code: row.code,
    revision: row.revision,
    payload: payload as JsonRecord,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeArtifactCode(prefix: "LOCK", matchId: number) {
  const datePart = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  return `${prefix}-${matchId}-${datePart}-${randomPart}`;
}

async function assertAdminPassword(value: unknown) {
  const candidate =
    typeof value === "string" && value.length <= 256 ? value : "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(candidate),
  );
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let mismatch = actual.length ^ ADMIN_PASSWORD_SHA256.length;
  for (let index = 0; index < ADMIN_PASSWORD_SHA256.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ ADMIN_PASSWORD_SHA256.charCodeAt(index);
  }
  if (mismatch !== 0) {
    throw new ApiError("管理密码不正确。", 403);
  }
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

function nextTimestamp(previous: string) {
  const normalized = previous.includes("T")
    ? previous
    : `${previous.replace(" ", "T")}Z`;
  const previousMs = Date.parse(normalized);
  const nextMs = Number.isFinite(previousMs)
    ? Math.max(Date.now(), previousMs + 1)
    : Date.now();
  return new Date(nextMs).toISOString();
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
