"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ReceiptArtifact,
  RenderedReceipt,
  renderReceipt,
} from "./receipt-canvas";

type BetMode = "winner" | "score";
type MatchStatus = "open" | "closed" | "settled";
type Side = "A" | "B";

type Bet = {
  id: number;
  matchId: number;
  bettorName: string;
  mode: BetMode;
  amountCents: number;
  winnerPick: Side | null;
  predictedScoreA: number | null;
  predictedScoreB: number | null;
  createdAt: string;
  updatedAt?: string | null;
};

type Payout = {
  betId: number;
  bettorName: string;
  amountCents: number;
  payoutCents: number;
};

type Settlement = {
  mode: BetMode;
  newStakeCents: number;
  rolloverInCents: number;
  totalPoolCents: number;
  championPrizeCents: number;
  guessPoolCents: number;
  totalCorrectStakeCents: number;
  rolloverCents: number;
  payouts: Payout[];
};

type GameMatch = {
  id: number;
  title: string;
  playerA: string;
  playerB: string;
  raceTo: number;
  stakeLimitCents: number;
  status: MatchStatus;
  resultScoreA: number | null;
  resultScoreB: number | null;
  createdAt: string;
  settledAt?: string | null;
  winnerRolloverInCents: number;
  winnerRolloverOutCents: number | null;
  scoreRolloverInCents: number;
  scoreRolloverOutCents: number | null;
  bets: Bet[];
  artifacts: ReceiptArtifact[];
  settlement?: Settlement[] | Record<string, Settlement> | null;
  settlements?: Settlement[] | null;
};

type GameSnapshot = {
  activeMatch: GameMatch | null;
  history: GameMatch[];
};

type Notice = { type: "success" | "error"; message: string } | null;

type DeleteTarget =
  | { kind: "bet"; match: GameMatch; bet: Bet }
  | { kind: "match"; match: GameMatch };

type ActionResponse = GameSnapshot & {
  ok?: boolean;
  artifact?: ReceiptArtifact;
  error?: string;
};

const EMPTY_SNAPSHOT: GameSnapshot = { activeMatch: null, history: [] };
const MIN_BET_CENTS = 100;
const MAX_BET_CENTS = 1000;

const MODE_COPY: Record<
  BetMode,
  { title: string; subtitle: string; short: string }
> = {
  winner: {
    title: "胜负局",
    subtitle: "猜谁先拿下赛点",
    short: "胜负",
  },
  score: {
    title: "猜比分",
    subtitle: "命中最终精确比分",
    short: "比分",
  },
};

const STATUS_COPY: Record<MatchStatus, string> = {
  open: "开放下注",
  closed: "已封盘",
  settled: "已结算",
};

const ARTIFACT_KIND_COPY: Record<ReceiptArtifact["kind"], string> = {
  bet: "下注票据",
  sealed: "封盘快照",
  settled: "结算票据",
};

const ARTIFACT_STATUS_COPY: Record<ReceiptArtifact["status"], string> = {
  active: "有效",
  superseded: "已更新",
  cancelled: "已取消",
};

function formatMoney(cents: number) {
  const amount = Number.isFinite(cents) ? cents / 100 : 0;
  return `¥${amount.toLocaleString("zh-CN", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTime(value: string) {
  if (!value) return "刚刚";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreOptions(raceTo: number) {
  const target = Math.max(1, Math.min(9, raceTo || 3));
  return [
    ...Array.from({ length: target }, (_, score) => ({ a: target, b: score })),
    ...Array.from({ length: target }, (_, score) => ({ a: score, b: target })),
  ];
}

function settlementFor(match: GameMatch, mode: BetMode) {
  const candidates = match.settlements ?? match.settlement;
  if (!candidates) return null;
  if (Array.isArray(candidates)) {
    return candidates.find((item) => item.mode === mode) ?? null;
  }
  return candidates[mode] ?? null;
}

function rolloverInFor(match: GameMatch, mode: BetMode) {
  return mode === "winner"
    ? match.winnerRolloverInCents ?? 0
    : match.scoreRolloverInCents ?? 0;
}

function rolloverOutFor(match: GameMatch, mode: BetMode) {
  const recorded =
    mode === "winner" ? match.winnerRolloverOutCents : match.scoreRolloverOutCents;
  return recorded ?? settlementFor(match, mode)?.rolloverCents ?? null;
}

function normalizeBettorName(value: string) {
  return value
    .replace(/\s+/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
}

function totalForMode(match: GameMatch, mode: BetMode) {
  return match.bets
    .filter((bet) => bet.mode === mode)
    .reduce((sum, bet) => sum + bet.amountCents, 0);
}

function betPrediction(bet: Bet, match: GameMatch) {
  if (bet.mode === "winner") {
    return bet.winnerPick === "A" ? match.playerA : match.playerB;
  }
  return `${bet.predictedScoreA ?? "–"} : ${bet.predictedScoreB ?? "–"}`;
}

function sameBetSelection(left: Bet, right: Bet) {
  if (left.mode !== right.mode) return false;
  if (left.mode === "winner") return left.winnerPick === right.winnerPick;
  return (
    left.predictedScoreA === right.predictedScoreA &&
    left.predictedScoreB === right.predictedScoreB
  );
}

function estimateSealedPayout(match: GameMatch, bet: Bet) {
  const modeBets = match.bets.filter((candidate) => candidate.mode === bet.mode);
  const newStakeCents = modeBets.reduce(
    (sum, candidate) => sum + candidate.amountCents,
    0,
  );
  const championPrizeCents =
    bet.mode === "winner" ? Math.round(newStakeCents * 0.2) : 0;
  const distributableCents =
    newStakeCents + rolloverInFor(match, bet.mode) - championPrizeCents;
  const selectionStakeCents = modeBets
    .filter((candidate) => sameBetSelection(candidate, bet))
    .reduce((sum, candidate) => sum + candidate.amountCents, 0);

  if (selectionStakeCents <= 0) return 0;
  return Math.round(
    (distributableCents * bet.amountCents) / selectionStakeCents,
  );
}

function EmptyMatch({ onCreate }: { onCreate: () => void }) {
  return (
    <main className="empty-page">
      <div className="empty-ball" aria-hidden="true">
        <span>8</span>
      </div>
      <p className="eyebrow">好友对决 · 即刻开局</p>
      <h1>还没有正在记录的比赛</h1>
      <p>创建第一场对局，就可以登记胜负预测和精确比分。</p>
      <button className="primary-button" type="button" onClick={onCreate}>
        新开一局
      </button>
    </main>
  );
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<BetMode>("winner");
  const [bettorName, setBettorName] = useState("");
  const [amount, setAmount] = useState("10");
  const [winnerPick, setWinnerPick] = useState<Side | null>(null);
  const [scorePick, setScorePick] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [showNewMatch, setShowNewMatch] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [settleScore, setSettleScore] = useState("");
  const [settlePassword, setSettlePassword] = useState("");
  const [statusTarget, setStatusTarget] = useState<"open" | "closed" | null>(null);
  const [statusPassword, setStatusPassword] = useState("");
  const [receiptArtifact, setReceiptArtifact] = useState<ReceiptArtifact | null>(null);
  const [renderedReceipt, setRenderedReceipt] = useState<RenderedReceipt | null>(null);
  const [receiptError, setReceiptError] = useState("");
  const [archiveMatchId, setArchiveMatchId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [newMatch, setNewMatch] = useState({
    title: "好友台球对决",
    playerA: "侯良玉",
    playerB: "杜志豪",
    raceTo: "3",
  });

  const match = snapshot.activeMatch;

  const loadGame = useCallback(async () => {
    try {
      const response = await fetch("/api/game", { cache: "no-store" });
      const data = (await response.json()) as GameSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error || "读取记录失败");
      setSnapshot({
        activeMatch: data.activeMatch ?? null,
        history: Array.isArray(data.history) ? data.history : [],
      });
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadGame(), 0);
    return () => window.clearTimeout(timer);
  }, [loadGame]);

  useEffect(() => {
    if (
      !showNewMatch &&
      !showSettle &&
      !statusTarget &&
      !receiptArtifact &&
      archiveMatchId === null &&
      !deleteTarget
    ) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [showNewMatch, showSettle, statusTarget, receiptArtifact, archiveMatchId, deleteTarget]);

  useEffect(() => {
    if (!receiptArtifact) return;
    let disposed = false;
    let generated: RenderedReceipt | null = null;
    void renderReceipt(receiptArtifact)
      .then((result) => {
        if (disposed) {
          URL.revokeObjectURL(result.url);
          return;
        }
        generated = result;
        setRenderedReceipt(result);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setReceiptError(error instanceof Error ? error.message : "票据图片生成失败");
        }
      });
    return () => {
      disposed = true;
      if (generated) URL.revokeObjectURL(generated.url);
    };
  }, [receiptArtifact]);

  function openReceipt(artifact: ReceiptArtifact) {
    setRenderedReceipt(null);
    setReceiptError("");
    setReceiptArtifact(artifact);
  }

  function closeReceipt() {
    setReceiptArtifact(null);
    setRenderedReceipt(null);
    setReceiptError("");
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!match) return;
    const timer = window.setTimeout(() => setAmount("10"), 0);
    return () => window.clearTimeout(timer);
  }, [match]);

  async function runAction(
    actionName: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ): Promise<ActionResponse | null> {
    setBusyAction(actionName);
    setNotice(null);
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as ActionResponse;
      if (!response.ok) throw new Error(data.error || "操作没有完成");
      await loadGame();
      setNotice({ type: "success", message: successMessage });
      if (data.artifact) openReceipt(data.artifact);
      return data;
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "操作没有完成",
      });
      return null;
    } finally {
      setBusyAction("");
    }
  }

  const currentBets = useMemo(
    () => match?.bets.filter((bet) => bet.mode === mode) ?? [],
    [match, mode],
  );

  const poolTotal = useMemo(
    () => (match ? totalForMode(match, mode) : 0),
    [match, mode],
  );

  const uniqueBettors = useMemo(
    () => new Set(currentBets.map((bet) => bet.bettorName)).size,
    [currentBets],
  );

  const popularPick = useMemo(() => {
    if (!match || currentBets.length === 0) return "等待第一注";
    const totals = new Map<string, number>();
    currentBets.forEach((bet) => {
      const label = betPrediction(bet, match);
      totals.set(label, (totals.get(label) ?? 0) + bet.amountCents);
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [currentBets, match]);

  const scoreChoices = useMemo(
    () => scoreOptions(match?.raceTo ?? 3),
    [match?.raceTo],
  );

  const modeSettlement = match ? settlementFor(match, mode) : null;

  function openNewMatchDialog() {
    if (match) {
      setNewMatch({
        title: match.status === "settled" ? "下一场好友对决" : match.title,
        playerA: match.playerA,
        playerB: match.playerB,
        raceTo: String(match.raceTo),
      });
    }
    setShowNewMatch(true);
  }

  async function submitBet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!match) return;
    const amountCents = Math.round(Number(amount) * 100);
    if (!bettorName.trim()) {
      setNotice({ type: "error", message: "先填写下注人姓名" });
      return;
    }
    if (!Number.isFinite(amountCents) || amountCents < MIN_BET_CENTS) {
      setNotice({ type: "error", message: "单注最低为 ¥1" });
      return;
    }
    if (amountCents > MAX_BET_CENTS) {
      setNotice({
        type: "error",
        message: "单注最高为 ¥10",
      });
      return;
    }
    if (mode === "winner" && !winnerPick) {
      setNotice({ type: "error", message: "请选择看好的选手" });
      return;
    }
    if (mode === "score" && !scorePick) {
      setNotice({ type: "error", message: "请选择预测比分" });
      return;
    }

    const [predictedScoreA, predictedScoreB] = scorePick
      ? scorePick.split(":").map(Number)
      : [null, null];
    const saved = await runAction(
      "addBet",
      {
        action: "addBet",
        matchId: match.id,
        bettorName: bettorName.trim(),
        mode,
        amountCents,
        winnerPick: mode === "winner" ? winnerPick : null,
        predictedScoreA: mode === "score" ? predictedScoreA : null,
        predictedScoreB: mode === "score" ? predictedScoreB : null,
      },
      "这笔下注已经记好了",
    );
    if (saved) {
      setBettorName("");
      setWinnerPick(null);
      setScorePick("");
    }
  }

  function editBet(bet: Bet) {
    setBettorName(bet.bettorName);
    setAmount(String(bet.amountCents / 100));
    if (bet.mode === "winner") setWinnerPick(bet.winnerPick);
    if (bet.mode === "score") {
      setScorePick(`${bet.predictedScoreA}:${bet.predictedScoreB}`);
    }
    document.getElementById("bet-form")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    setNotice({ type: "success", message: "已带入这条记录，保存后会直接更新" });
  }

  function askDeleteBet(targetMatch: GameMatch, bet: Bet) {
    setDeletePassword("");
    setDeleteTarget({ kind: "bet", match: targetMatch, bet });
  }

  function askDeleteMatch(targetMatch: GameMatch) {
    setDeletePassword("");
    setDeleteTarget({ kind: "match", match: targetMatch });
  }

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setDeletePassword("");
  }

  async function confirmDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteTarget || !deletePassword) return;
    const deletingBet = deleteTarget.kind === "bet";
    const result = await runAction(
      deletingBet ? "deleteBet" : "deleteMatch",
      deletingBet
        ? { action: "deleteBet", betId: deleteTarget.bet.id, password: deletePassword }
        : { action: "deleteMatch", matchId: deleteTarget.match.id, password: deletePassword },
      deletingBet ? "下注记录已永久删除" : "该场比赛及关联记录已永久删除",
    );
    if (result) {
      closeDeleteDialog();
      setArchiveMatchId(null);
    }
  }

  function downloadReceipt() {
    if (!renderedReceipt) return;
    const link = document.createElement("a");
    link.href = renderedReceipt.url;
    link.download = renderedReceipt.filename;
    link.click();
  }

  async function copyReceipt() {
    if (!renderedReceipt) return;
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      setNotice({
        type: "error",
        message: "当前浏览器或局域网环境不支持复制图片，请使用“下载图片”。",
      });
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": renderedReceipt.blob }),
      ]);
      setNotice({ type: "success", message: "票据图片已复制" });
    } catch {
      setNotice({
        type: "error",
        message: "浏览器未允许复制图片，请使用“下载图片”。",
      });
    }
  }

  function askChangeStatus(status: "open" | "closed") {
    setStatusPassword("");
    setStatusTarget(status);
  }

  function closeStatusDialog() {
    setStatusTarget(null);
    setStatusPassword("");
  }

  async function changeStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!match || !statusTarget || !statusPassword) return;
    const changed = await runAction(
      "setStatus",
      {
        action: "setStatus",
        matchId: match.id,
        status: statusTarget,
        password: statusPassword,
      },
      statusTarget === "closed" ? "本局已封盘" : "本局已重新开放",
    );
    if (changed) closeStatusDialog();
  }

  async function createMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raceTo = Number(newMatch.raceTo);
    const created = await runAction(
      "createMatch",
      {
        action: "createMatch",
        title: newMatch.title.trim(),
        playerA: newMatch.playerA.trim(),
        playerB: newMatch.playerB.trim(),
        raceTo,
      },
      "新对局已经开好",
    );
    if (created) {
      setShowNewMatch(false);
      setMode("winner");
    }
  }

  async function settleMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!match || !settleScore || !settlePassword) return;
    const [scoreA, scoreB] = settleScore.split(":").map(Number);
    const settled = await runAction(
      "settle",
      { action: "settle", matchId: match.id, scoreA, scoreB, password: settlePassword },
      "赛果和派奖结果已保存",
    );
    if (settled) {
      setShowSettle(false);
      setSettleScore("");
      setSettlePassword("");
    }
  }

  if (loading) {
    return (
      <main className="loading-page" aria-live="polite">
        <div className="loading-mark">8</div>
        <p>正在摆好球台…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="error-page">
        <span className="error-code">!</span>
        <h1>记录暂时没有加载出来</h1>
        <p>{loadError}</p>
        <button className="primary-button" type="button" onClick={() => void loadGame()}>
          再试一次
        </button>
      </main>
    );
  }

  if (!match) {
    return (
      <>
        <EmptyMatch onCreate={openNewMatchDialog} />
        {showNewMatch && renderNewMatchDialog()}
      </>
    );
  }

  const canCreateMatch =
    match.status === "settled" ||
    (match.bets.length === 0 && (match.artifacts?.length ?? 0) === 0);
  const archiveMatch =
    archiveMatchId === match.id
      ? match
      : snapshot.history.find((item) => item.id === archiveMatchId) ?? null;
  const latestMatchId = Math.max(match.id, ...snapshot.history.map((item) => item.id));
  const allPool = match.bets.reduce((sum, bet) => sum + bet.amountCents, 0);
  const championSide: Side | null =
    match.status === "settled" && match.resultScoreA !== null && match.resultScoreB !== null
      ? match.resultScoreA > match.resultScoreB
        ? "A"
        : "B"
      : null;
  const champion =
    championSide === "A"
      ? match.playerA
      : championSide === "B"
        ? match.playerB
        : null;
  const payoutsById = new Map(
    (modeSettlement?.payouts ?? []).map((payout) => [payout.betId, payout]),
  );
  const modeNewStakeCents = modeSettlement?.newStakeCents ?? poolTotal;
  const modeRolloverInCents =
    modeSettlement?.rolloverInCents ?? rolloverInFor(match, mode);
  const modeCurrentTotalCents = modeNewStakeCents + modeRolloverInCents;
  const modeChampionPrizeCents =
    mode === "winner"
      ? modeSettlement?.championPrizeCents ?? Math.round(modeNewStakeCents * 0.2)
      : 0;
  const modeDistributableCents =
    mode === "winner"
      ? modeSettlement?.totalPoolCents ??
        modeCurrentTotalCents - modeChampionPrizeCents
      : modeSettlement?.totalPoolCents ?? modeCurrentTotalCents;
  const normalizedProspectiveName = normalizeBettorName(bettorName);
  const existingScoreBet = normalizedProspectiveName
    ? match.bets.find(
        (bet) =>
          bet.mode === "score" &&
          normalizeBettorName(bet.bettorName) === normalizedProspectiveName,
      )
    : undefined;
  const prospectiveAmountCents = Math.round(Number(amount) * 100);
  const hasValidProspectiveAmount =
    Number.isFinite(prospectiveAmountCents) &&
    prospectiveAmountCents >= MIN_BET_CENTS &&
    prospectiveAmountCents <= MAX_BET_CENTS;
  const scoreNewStakeWithoutExisting =
    totalForMode(match, "score") - (existingScoreBet?.amountCents ?? 0);
  const scorePreviewMatch = match;

  function projectedScoreReturn(scoreA: number, scoreB: number) {
    if (!hasValidProspectiveAmount) return null;
    const currentStakeForScore = scorePreviewMatch.bets
      .filter(
        (bet) =>
          bet.mode === "score" &&
          bet.predictedScoreA === scoreA &&
          bet.predictedScoreB === scoreB,
      )
      .reduce((sum, bet) => sum + bet.amountCents, 0);
    const replacedStakeForScore =
      existingScoreBet?.predictedScoreA === scoreA &&
      existingScoreBet.predictedScoreB === scoreB
        ? existingScoreBet.amountCents
        : 0;
    const adjustedStakeForScore =
      currentStakeForScore - replacedStakeForScore + prospectiveAmountCents;
    const adjustedNewStakeCents = scoreNewStakeWithoutExisting + prospectiveAmountCents;
    const availablePoolCents =
      rolloverInFor(scorePreviewMatch, "score") + adjustedNewStakeCents;
    const payoutCents = Math.round(
      (availablePoolCents * prospectiveAmountCents) / adjustedStakeForScore,
    );
    return {
      payoutCents,
      multiple: availablePoolCents / adjustedStakeForScore,
    };
  }

  function renderNewMatchDialog() {
    return (
      <div className="modal-backdrop" onMouseDown={() => setShowNewMatch(false)}>
        <section
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-match-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="modal-close"
            type="button"
            aria-label="关闭"
            onClick={() => setShowNewMatch(false)}
          >
            ×
          </button>
          <p className="eyebrow">NEW MATCH</p>
          <h2 id="new-match-title">新开一局</h2>
          <p className="modal-intro">
            两种玩法分别记池；上一场未派出的金额会自动进入同玩法的新一局。
          </p>
          <form className="modal-form" onSubmit={createMatch}>
            <label className="field full-field">
              <span>对局名称</span>
              <input
                value={newMatch.title}
                maxLength={40}
                required
                onChange={(event) =>
                  setNewMatch((value) => ({ ...value, title: event.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>蓝方选手</span>
              <input
                value={newMatch.playerA}
                maxLength={20}
                required
                onChange={(event) =>
                  setNewMatch((value) => ({ ...value, playerA: event.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>红方选手</span>
              <input
                value={newMatch.playerB}
                maxLength={20}
                required
                onChange={(event) =>
                  setNewMatch((value) => ({ ...value, playerB: event.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>赛制（抢几）</span>
              <input
                type="number"
                min="1"
                max="9"
                inputMode="numeric"
                value={newMatch.raceTo}
                required
                onChange={(event) =>
                  setNewMatch((value) => ({ ...value, raceTo: event.target.value }))
                }
              />
            </label>
            <div className="field">
              <span>单注金额</span>
              <strong>¥1 — ¥10</strong>
            </div>
            <button
              className="primary-button full-field"
              type="submit"
              disabled={busyAction === "createMatch"}
            >
              {busyAction === "createMatch" ? "正在开局…" : "确认开局"}
            </button>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="site-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="一杆定胜负首页">
          <span className="brand-ball">8</span>
          <span>
            <strong>一杆定胜负</strong>
            <small>好友台球下注簿</small>
          </span>
        </a>
        <div className="topbar-actions">
          <button
            className="outline-button compact-button"
            type="button"
            onClick={openNewMatchDialog}
            disabled={!canCreateMatch}
            title={
              canCreateMatch
                ? "新开一局"
                : match.bets.length === 0
                  ? "当前空局已有历史票据，请先删除本场"
                  : "请先结算当前对局"
            }
          >
            ＋ 新开一局
          </button>
        </div>
      </header>

      <main id="top">
        <section className="match-hero" aria-labelledby="match-title">
          <div className="hero-kicker-row">
            <div>
              <p className="eyebrow">好球对决 · 等你来猜</p>
              <h1 id="match-title">{match.title}</h1>
            </div>
            <span className={`status-pill status-${match.status}`}>
              <i aria-hidden="true" />
              {STATUS_COPY[match.status]}
            </span>
          </div>

          <div className="versus-stage">
            <div
              className={`player player-a ${
                championSide === "A"
                  ? "match-winner"
                  : championSide === "B"
                    ? "match-runner-up"
                    : ""
              }`}
            >
              <span className="player-side">BLUE · A</span>
              <div className="player-avatar" aria-hidden="true">
                {match.playerA.slice(0, 1)}
              </div>
              <strong>{match.playerA}</strong>
            </div>
            <div className="versus-center" aria-label={`抢 ${match.raceTo} 局`}>
              {match.status === "settled" ? (
                <div className="final-score">
                  <b>{match.resultScoreA}</b>
                  <span>:</span>
                  <b>{match.resultScoreB}</b>
                </div>
              ) : (
                <span className="vs-mark">VS</span>
              )}
              <small>抢 {match.raceTo} · 先胜者赢</small>
            </div>
            <div
              className={`player player-b ${
                championSide === "B"
                  ? "match-winner"
                  : championSide === "A"
                    ? "match-runner-up"
                    : ""
              }`}
            >
              <span className="player-side">RED · B</span>
              <div className="player-avatar" aria-hidden="true">
                {match.playerB.slice(0, 1)}
              </div>
              <strong>{match.playerB}</strong>
            </div>
          </div>

          {match.status === "settled" && champion && (
            <div
              className="champion-reveal"
              role="status"
              aria-label={`冠军揭晓：${champion}`}
            >
              <span className="champion-trophy" aria-hidden="true">🏆</span>
              <div className="champion-copy">
                <small>CHAMPION · 冠军揭晓</small>
                <strong>{champion}</strong>
              </div>
              <div className="champion-result">
                <span>最终比分</span>
                <b>{match.resultScoreA} : {match.resultScoreB}</b>
              </div>
            </div>
          )}

          <div className="hero-footer">
            <div className="hero-meta">
              <span>单注范围 <strong>¥1 — ¥10</strong></span>
              <span>总记录 <strong>{match.bets.length}</strong> 笔</span>
              <span>总下注 <strong>{formatMoney(allPool)}</strong></span>
            </div>
            <div className="match-actions">
              <button
                type="button"
                className="outline-button receipt-archive-button"
                onClick={() => setArchiveMatchId(match.id)}
              >
                票据档案 <span>{match.artifacts?.length ?? 0}</span>
              </button>
              {match.status === "open" && (
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => askChangeStatus("closed")}
                  disabled={busyAction === "setStatus"}
                >
                  封盘
                </button>
              )}
              {match.status === "closed" && (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => askChangeStatus("open")}
                    disabled={busyAction === "setStatus"}
                  >
                    重新开放
                  </button>
                  <button
                    type="button"
                    className="primary-button small-button"
                    onClick={() => {
                      setSettlePassword("");
                      setShowSettle(true);
                    }}
                  >
                    录入赛果
                  </button>
                </>
              )}
              <button
                type="button"
                className="ghost-button danger-button"
                onClick={() => askDeleteMatch(match)}
                disabled={match.id !== latestMatchId}
                title={
                  match.id === latestMatchId ? "永久删除这场比赛" : "需先删除更新的比赛"
                }
              >
                删除本场
              </button>
            </div>
          </div>
        </section>

        {match.status !== "open" && (
          <section className="sealed-summary" aria-labelledby="sealed-summary-title">
            <div className="sealed-summary-heading">
              <div>
                <p className="eyebrow">SEALED BET SUMMARY</p>
                <h2 id="sealed-summary-title">封盘下注汇总</h2>
              </div>
              <div className="sealed-summary-note">
                <strong>{match.bets.length} 笔下注 · {formatMoney(allPool)}</strong>
                <span>预估奖金按封盘奖池计算，最终以赛果结算为准</span>
              </div>
            </div>

            <div className="sealed-summary-grid">
              {(["winner", "score"] as BetMode[]).map((summaryMode) => {
                const summaryBets = match.bets.filter((bet) => bet.mode === summaryMode);
                const summaryStake = summaryBets.reduce(
                  (sum, bet) => sum + bet.amountCents,
                  0,
                );
                const summaryRollover = rolloverInFor(match, summaryMode);
                const summaryChampionPrize =
                  summaryMode === "winner" ? Math.round(summaryStake * 0.2) : 0;
                const summaryPool =
                  summaryStake + summaryRollover - summaryChampionPrize;

                return (
                  <article
                    className={`sealed-summary-card sealed-summary-${summaryMode}`}
                    key={summaryMode}
                  >
                    <header>
                      <div>
                        <span>{summaryMode === "winner" ? "01" : "02"}</span>
                        <h3>{MODE_COPY[summaryMode].title}下注汇总</h3>
                      </div>
                      <p>
                        <strong>{summaryBets.length} 笔</strong>
                        <span>可分奖池 {formatMoney(summaryPool)}</span>
                      </p>
                    </header>

                    <div className="sealed-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>下注人</th>
                            <th>选择</th>
                            <th>下注金额</th>
                            <th>预估奖金</th>
                            <th>预估净赢</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summaryBets.length === 0 ? (
                            <tr className="sealed-empty-row">
                              <td colSpan={5}>本玩法没有下注</td>
                            </tr>
                          ) : (
                            summaryBets.map((bet) => {
                              const estimatedPayout = estimateSealedPayout(match, bet);
                              return (
                                <tr key={bet.id}>
                                  <td><strong>{bet.bettorName}</strong></td>
                                  <td>{betPrediction(bet, match)}</td>
                                  <td>{formatMoney(bet.amountCents)}</td>
                                  <td className="estimated-payout">
                                    {formatMoney(estimatedPayout)}
                                  </td>
                                  <td className={estimatedPayout >= bet.amountCents ? "estimated-profit" : ""}>
                                    {formatMoney(estimatedPayout - bet.amountCents)}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={2}>合计</td>
                            <td>{formatMoney(summaryStake)}</td>
                            <td colSpan={2}>
                              滚存 {formatMoney(summaryRollover)}
                              {summaryMode === "winner" && (
                                <> · 冠军奖金 {formatMoney(summaryChampionPrize)}</>
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <nav className="mode-switch" aria-label="下注模式">
          {(Object.keys(MODE_COPY) as BetMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={mode === item ? "active" : ""}
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
            >
              <span className="mode-number">{item === "winner" ? "01" : "02"}</span>
              <span>
                <strong>{MODE_COPY[item].title}</strong>
                <small>{MODE_COPY[item].subtitle}</small>
              </span>
              <em>{match.bets.filter((bet) => bet.mode === item).length} 注</em>
            </button>
          ))}
        </nav>

        <section className="workspace-grid">
          <article className="panel bet-panel" id="bet-form">
            <div className="panel-heading">
              <div>
                <p className="panel-index">PLACE A BET</p>
                <h2>记下一注</h2>
              </div>
              <span className="mode-badge">{MODE_COPY[mode].title}</span>
            </div>

            {match.status !== "open" ? (
              <div className="locked-state">
                <span className="lock-icon" aria-hidden="true">◎</span>
                <h3>{match.status === "closed" ? "本局已经封盘" : "本局已经结算"}</h3>
                <p>
                  {match.status === "closed"
                    ? "记录已锁定，录入最终比分即可完成结算。"
                    : `最终比分 ${match.resultScoreA} : ${match.resultScoreB}，可在下方查看派奖明细。`}
                </p>
              </div>
            ) : (
              <form className="bet-form" onSubmit={submitBet}>
                <label className="field full-field">
                  <span>下注人</span>
                  <input
                    autoComplete="off"
                    value={bettorName}
                    maxLength={20}
                    placeholder="输入朋友的名字"
                    onChange={(event) => setBettorName(event.target.value)}
                  />
                  <small>同名再次保存，会更新该玩法下的原记录</small>
                </label>

                <fieldset className="choice-fieldset">
                  <legend>{mode === "winner" ? "看好谁获胜" : "预测最终比分"}</legend>
                  {mode === "winner" ? (
                    <div className="winner-options">
                      {(["A", "B"] as Side[]).map((side) => {
                        const playerName = side === "A" ? match.playerA : match.playerB;
                        return (
                          <button
                            key={side}
                            type="button"
                            className={`winner-option side-${side.toLowerCase()} ${
                              winnerPick === side ? "selected" : ""
                            }`}
                            aria-pressed={winnerPick === side}
                            onClick={() => setWinnerPick(side)}
                          >
                            <span>{side} 方</span>
                            <strong>{playerName}</strong>
                            <i>{winnerPick === side ? "已选择" : "选择"}</i>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="score-options">
                      {scoreChoices.map((choice) => {
                        const value = `${choice.a}:${choice.b}`;
                        const selected = scorePick === value;
                        const winningSide = choice.a > choice.b ? "A" : "B";
                        const projection = projectedScoreReturn(choice.a, choice.b);
                        const projectionCopy = projection
                          ? `预计 ${projection.multiple.toFixed(2)}× · ${formatMoney(
                              projection.payoutCents,
                            )}`
                          : "输入有效金额查看预计";
                        return (
                          <button
                            key={value}
                            type="button"
                            className={`score-option score-${winningSide.toLowerCase()} ${
                              selected ? "selected" : ""
                            }`}
                            aria-pressed={selected}
                            aria-label={`预测比分 ${choice.a} 比 ${choice.b}，${projectionCopy}`}
                            onClick={() => setScorePick(value)}
                          >
                            <span className="score-value">
                              <strong>{choice.a}</strong>
                              <i>:</i>
                              <strong>{choice.b}</strong>
                            </span>
                            <small>{projectionCopy}</small>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </fieldset>

                <fieldset className="amount-fieldset">
                  <legend>下注金额</legend>
                  <div className="amount-row">
                    <div className="amount-input-wrap">
                      <span>¥</span>
                      <input
                        aria-label="下注金额（元）"
                        type="number"
                        min="1"
                        max="10"
                        step="0.01"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </div>
                    <div className="amount-chips" aria-label="快捷金额">
                      {[100, 500, 1000]
                        .filter(
                          (value, index, values) =>
                            values.indexOf(value) === index,
                        )
                        .map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={Math.round(Number(amount) * 100) === value ? "active" : ""}
                            onClick={() => setAmount(String(value / 100))}
                          >
                            {formatMoney(value)}
                          </button>
                        ))}
                    </div>
                  </div>
                </fieldset>

                <button
                  className="primary-button submit-bet"
                  type="submit"
                  disabled={busyAction === "addBet"}
                >
                  <span>{busyAction === "addBet" ? "正在保存…" : "记下这注"}</span>
                  <small>单注 ¥1 — ¥10</small>
                </button>
              </form>
            )}

            <div className="friendly-note">
              <span aria-hidden="true">i</span>
              <p><strong>友情提示</strong>：选手本人不能下注，理性娱乐，量力而行。</p>
            </div>
          </article>

          <article className="panel ledger-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-index">LIVE LEDGER</p>
                <h2>本局账簿</h2>
              </div>
              <span className="live-dot"><i /> 实时汇总</span>
            </div>

            <div
              className="stats-row"
              role="group"
              aria-label={`${MODE_COPY[mode].title}奖池汇总`}
            >
              <div>
                <span>本局新增</span>
                <strong>{formatMoney(modeNewStakeCents)}</strong>
              </div>
              <div>
                <span>上局滚存</span>
                <strong>{formatMoney(modeRolloverInCents)}</strong>
              </div>
              <div className="current-pool-stat">
                <span>当前总池</span>
                <strong>{formatMoney(modeCurrentTotalCents)}</strong>
              </div>
            </div>

            <div className={`pool-card pool-card-${mode}`}>
              <div className="pool-card-heading">
                <span>{mode === "winner" ? "胜负池分配" : "比分池分配"}</span>
                <strong>
                  {mode === "winner" ? "新注 20 / 80 · 滚存全入竞猜" : "100% 归精确命中者"}
                </strong>
              </div>
              <div
                className="pool-flow"
                role="group"
                aria-label="本局新增加上上局滚存等于当前总池"
              >
                <div>
                  <span>本局新增</span>
                  <strong>{formatMoney(modeNewStakeCents)}</strong>
                </div>
                <b aria-hidden="true">＋</b>
                <div className="rollover-flow-item">
                  <span>上局滚存</span>
                  <strong>{formatMoney(modeRolloverInCents)}</strong>
                </div>
                <b aria-hidden="true">＝</b>
                <div className="total-flow-item">
                  <span>当前总池</span>
                  <strong>{formatMoney(modeCurrentTotalCents)}</strong>
                </div>
              </div>
              {mode === "winner" ? (
                <div className="pool-allocation">
                  <div>
                    <span>冠军奖金</span>
                    <strong>{formatMoney(modeChampionPrizeCents)}</strong>
                    <small>只取本局新增的 20%</small>
                  </div>
                  <div className="featured-allocation">
                    <span>当前可分奖池</span>
                    <strong>{formatMoney(modeDistributableCents)}</strong>
                    <small>本局新增的 80% ＋ 全部胜负滚存</small>
                  </div>
                </div>
              ) : (
                <div className="score-allocation">
                  <div>
                    <span>当前可分奖池</span>
                    <strong>{formatMoney(modeDistributableCents)}</strong>
                  </div>
                  <p>
                    本局比分下注与比分滚存全部参与分配，不抽取冠军奖金；若只有一人下注且没有滚存，
                    命中时为 1.00×，即返还本人下注。
                  </p>
                </div>
              )}
            </div>

            <div className="ledger-insights" role="group" aria-label="本玩法下注概况">
              <span>下注人数 <strong>{uniqueBettors} 人</strong></span>
              <span>当前热门 <strong>{popularPick}</strong></span>
            </div>

            {match.status === "settled" && modeSettlement && (
              <div className="settlement-card">
                <div className="settlement-title">
                  <span>结算结果</span>
                  <strong>{match.resultScoreA} : {match.resultScoreB}</strong>
                </div>
                <div className="settlement-grid">
                  <div>
                    <span>本局新增</span>
                    <b>{formatMoney(modeSettlement.newStakeCents)}</b>
                  </div>
                  <div>
                    <span>上局滚存 · 带入</span>
                    <b>{formatMoney(modeSettlement.rolloverInCents)}</b>
                  </div>
                  <div>
                    <span>可分奖池</span>
                    <b>{formatMoney(modeSettlement.totalPoolCents)}</b>
                  </div>
                  <div>
                    <span>{mode === "winner" ? "冠军奖金 · 新注20%" : "精确命中本金"}</span>
                    <b>
                      {formatMoney(
                        mode === "winner"
                          ? modeSettlement.championPrizeCents
                          : modeSettlement.totalCorrectStakeCents,
                      )}
                    </b>
                  </div>
                  <div>
                    <span>{mode === "winner" ? "已派胜负奖池" : "已派比分奖池"}</span>
                    <b>
                      {formatMoney(
                        modeSettlement.totalCorrectStakeCents > 0
                          ? modeSettlement.guessPoolCents
                          : 0,
                      )}
                    </b>
                  </div>
                  <div className={modeSettlement.rolloverCents > 0 ? "rollover-out" : ""}>
                    <span>滚入下局</span>
                    <b>{formatMoney(modeSettlement.rolloverCents)}</b>
                  </div>
                </div>
              </div>
            )}

            <div className="ledger-header">
              <span>{MODE_COPY[mode].title}记录</span>
              <small>共 {currentBets.length} 笔</small>
            </div>

            <div className="bet-list">
              {currentBets.length === 0 ? (
                <div className="empty-ledger">
                  <div className="mini-eight" aria-hidden="true">8</div>
                  <strong>还没有下注记录</strong>
                  <span>第一笔会显示在这里</span>
                </div>
              ) : (
                currentBets.map((bet) => {
                  const payout = payoutsById.get(bet.id);
                  const isCorrect = Boolean(payout);
                  const showFinalScoreReturn =
                    match.status === "settled" && bet.mode === "score";
                  const finalScorePayoutCents = payout?.payoutCents ?? 0;
                  const finalScoreMultiple =
                    bet.amountCents > 0 ? finalScorePayoutCents / bet.amountCents : 0;
                  return (
                    <div
                      className={`bet-row bet-${bet.mode} ${
                        bet.mode === "winner" ? `pick-${bet.winnerPick?.toLowerCase()}` : ""
                      }`}
                      key={bet.id}
                    >
                      <div className="bettor-avatar" aria-hidden="true">
                        {bet.bettorName.slice(0, 1)}
                      </div>
                      <div className="bet-main">
                        <div>
                          <strong>{bet.bettorName}</strong>
                          <span className="tiny-mode">{MODE_COPY[bet.mode].short}</span>
                          {match.status === "settled" && (
                            <span className={isCorrect ? "hit-badge" : "miss-badge"}>
                              {isCorrect ? "命中" : "未中"}
                            </span>
                          )}
                        </div>
                        <small>{formatTime(bet.updatedAt ?? bet.createdAt)}</small>
                      </div>
                      <div className="prediction">
                        <span>预测</span>
                        <strong>{betPrediction(bet, match)}</strong>
                      </div>
                      <div className="bet-money">
                        <span>
                          {showFinalScoreReturn
                            ? "最终应得"
                            : match.status === "settled" && isCorrect
                              ? "应得"
                              : "下注"}
                        </span>
                        <strong>{formatMoney(
                          showFinalScoreReturn
                            ? finalScorePayoutCents
                            : match.status === "settled" && isCorrect
                            ? payout?.payoutCents ?? 0
                            : bet.amountCents,
                        )}</strong>
                        {showFinalScoreReturn && (
                          <small className="final-return-multiple">
                            最终 {finalScoreMultiple.toFixed(2)}×
                          </small>
                        )}
                      </div>
                      <div className="row-actions">
                        {match.status === "open" && (
                          <button type="button" onClick={() => editBet(bet)}>编辑</button>
                        )}
                        {match.artifacts?.some((artifact) => artifact.betId === bet.id) && (
                          <button
                            type="button"
                            onClick={() => {
                              const artifact = match.artifacts.find(
                                (entry) => entry.betId === bet.id,
                              );
                              if (artifact) openReceipt(artifact);
                            }}
                          >
                            票据
                          </button>
                        )}
                        {match.status === "open" && (
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => askDeleteBet(match, bet)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </article>
        </section>

        <section className="rules-panel" aria-labelledby="rules-title">
          <div className="rules-heading">
            <p className="eyebrow">POOL RULES</p>
            <h2 id="rules-title">简单透明，赛后即结</h2>
          </div>
          <div className="rule-grid">
            <div className="rule-item">
              <span>01</span>
              <p><strong>两个独立奖池</strong>胜负与比分分别记账、分别派奖，资金不会互相补充。</p>
            </div>
            <div className="rule-item">
              <span>02</span>
              <p><strong>胜负滚存链</strong>本局胜负新注的 20% 给冠军；其余 80% 加上胜负滚存，由猜中胜者的人分配。</p>
            </div>
            <div className="rule-item">
              <span>03</span>
              <p><strong>比分滚存链</strong>本局比分下注加上比分滚存，100% 由精确命中最终比分的人分配，不抽冠军奖。</p>
            </div>
            <div className="rule-item">
              <span>04</span>
              <p><strong>自动滚入下局</strong>某玩法无人命中时，其可分奖池只进入下一场的同玩法，直到有人命中。</p>
            </div>
          </div>
        </section>

        {snapshot.history.filter((item) => item.id !== match.id).length > 0 && (
          <section className="history-section" aria-labelledby="history-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MATCH ARCHIVE</p>
                <h2 id="history-title">往期对局</h2>
              </div>
              <span>所有比赛保存在本机数据库中</span>
            </div>
            <div className="history-list">
              {snapshot.history
                .filter((item) => item.id !== match.id)
                .map((item) => {
                  const total = item.bets.reduce((sum, bet) => sum + bet.amountCents, 0);
                  const winnerRolloverOut = rolloverOutFor(item, "winner");
                  const scoreRolloverOut = rolloverOutFor(item, "score");
                  return (
                    <details className="history-card" key={item.id}>
                      <summary>
                        <div className="history-date">
                          <span>{formatTime(item.createdAt)}</span>
                          <small>{STATUS_COPY[item.status]}</small>
                        </div>
                        <strong>{item.playerA} <i>VS</i> {item.playerB}</strong>
                        <div className="history-score">
                          <span>{item.status === "settled" ? `${item.resultScoreA} : ${item.resultScoreB}` : "未结算"}</span>
                          <small>{formatMoney(total)}</small>
                        </div>
                      </summary>
                      <div className="history-detail">
                        <div className="history-detail-top">
                          <p>{item.title} · 抢 {item.raceTo}</p>
                          <div className="history-tools">
                            <div className="history-counts">
                              <span>胜负局 {item.bets.filter((bet) => bet.mode === "winner").length} 注</span>
                              <span>猜比分 {item.bets.filter((bet) => bet.mode === "score").length} 注</span>
                              <span>合计 {item.bets.length} 笔</span>
                            </div>
                            <button
                              type="button"
                              className="archive-inline-button"
                              onClick={() => setArchiveMatchId(item.id)}
                            >
                              票据档案 {item.artifacts?.length ?? 0}
                            </button>
                            <button
                              type="button"
                              className="archive-delete-button"
                              onClick={() => askDeleteMatch(item)}
                              disabled={item.id !== latestMatchId}
                              title={
                                item.id === latestMatchId
                                  ? "永久删除这场比赛"
                                  : "需先删除更新的比赛"
                              }
                            >
                              {item.id === latestMatchId ? "删除本场" : "需先删除更新比赛"}
                            </button>
                          </div>
                        </div>
                        <div
                          className="history-rollovers"
                          role="group"
                          aria-label="本场两种玩法滚存记录"
                        >
                          <div>
                            <strong>胜负滚存链</strong>
                            <span>带入 {formatMoney(rolloverInFor(item, "winner"))}</span>
                            <i aria-hidden="true">→</i>
                            <span>
                              滚出 {winnerRolloverOut === null ? "待结算" : formatMoney(winnerRolloverOut)}
                            </span>
                          </div>
                          <div>
                            <strong>比分滚存链</strong>
                            <span>带入 {formatMoney(rolloverInFor(item, "score"))}</span>
                            <i aria-hidden="true">→</i>
                            <span>
                              滚出 {scoreRolloverOut === null ? "待结算" : formatMoney(scoreRolloverOut)}
                            </span>
                          </div>
                        </div>
                        <div className="history-bets">
                          <div className="history-bet-head">
                            <span>下注人</span>
                            <span>玩法 / 预测</span>
                            <span>金额</span>
                            <span>结果</span>
                            <span>最终返还</span>
                            <span>操作</span>
                          </div>
                          {item.bets.length === 0 ? (
                            <div className="history-bet-empty">本场没有下注记录</div>
                          ) : (
                            item.bets.map((bet) => {
                              const settlement = settlementFor(item, bet.mode);
                              const payout = settlement?.payouts.find(
                                (entry) => entry.betId === bet.id,
                              );
                              const artifact = item.artifacts?.find(
                                (entry) => entry.betId === bet.id,
                              );
                              return (
                                <div className="history-bet-row" key={bet.id}>
                                  <strong>{bet.bettorName}</strong>
                                  <div>
                                    <span className="tiny-mode">{MODE_COPY[bet.mode].short}</span>
                                    <b>{betPrediction(bet, item)}</b>
                                  </div>
                                  <strong>{formatMoney(bet.amountCents)}</strong>
                                  <span
                                    className={
                                      item.status !== "settled"
                                        ? "history-pending"
                                        : payout
                                          ? "history-hit"
                                          : "history-miss"
                                    }
                                  >
                                    {item.status !== "settled"
                                      ? "待结算"
                                      : payout
                                        ? "命中"
                                        : "未中"}
                                  </span>
                                  <strong className={payout ? "history-payout" : ""}>
                                    {item.status === "settled"
                                      ? formatMoney(payout?.payoutCents ?? 0)
                                      : "—"}
                                  </strong>
                                  <div className="history-bet-actions">
                                    {artifact && (
                                      <button
                                        type="button"
                                        onClick={() => openReceipt(artifact)}
                                      >
                                        票据
                                      </button>
                                    )}
                                    {item.status === "open" && (
                                      <button
                                        type="button"
                                        className="danger-link"
                                        onClick={() => askDeleteBet(item, bet)}
                                      >
                                        删除
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </details>
                  );
                })}
            </div>
          </section>
        )}
      </main>

      <footer>
        <span className="footer-mark">8</span>
        <p><strong>友谊第一，比赛第二。</strong> 理性娱乐，量力而行。</p>
      </footer>

      {notice && (
        <div className={`toast toast-${notice.type}`} role="status">
          <span>{notice.type === "success" ? "✓" : "!"}</span>
          {notice.message}
        </div>
      )}

      {showNewMatch && renderNewMatchDialog()}

      {statusTarget && (
        <div className="modal-backdrop" onMouseDown={closeStatusDialog}>
          <section
            className="modal-card admin-action-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="关闭"
              onClick={closeStatusDialog}
            >
              ×
            </button>
            <p className="eyebrow">ADMIN CONFIRM</p>
            <h2 id="status-confirm-title">
              {statusTarget === "closed" ? "确认封盘" : "确认重新开放"}
            </h2>
            <p className="modal-intro">
              {statusTarget === "closed"
                ? "封盘后将停止新增和修改下注，并生成封盘快照。"
                : "重新开放后可以继续新增或修改下注，原封盘快照会保留为历史版本。"}
            </p>
            <form className="delete-form" onSubmit={changeStatus}>
              <label className="field">
                <span>输入管理密码确认</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={statusPassword}
                  placeholder="请输入密码"
                  onChange={(event) => setStatusPassword(event.target.value)}
                />
              </label>
              <div className="delete-actions">
                <button type="button" className="ghost-button" onClick={closeStatusDialog}>
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button small-button"
                  disabled={!statusPassword || busyAction === "setStatus"}
                >
                  {busyAction === "setStatus"
                    ? "正在确认…"
                    : statusTarget === "closed"
                      ? "确认封盘"
                      : "确认重新开放"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showSettle && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setShowSettle(false);
            setSettlePassword("");
          }}
        >
          <section
            className="modal-card settle-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settle-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="关闭"
              onClick={() => {
                setShowSettle(false);
                setSettlePassword("");
              }}
            >
              ×
            </button>
            <p className="eyebrow">FINAL SCORE</p>
            <h2 id="settle-title">录入最终比分</h2>
            <p className="modal-intro">确认后将锁定赛果，并计算两种玩法的奖金分配。</p>
            <form onSubmit={settleMatch}>
              <div className="settle-players">
                <strong>{match.playerA}</strong>
                <span>抢 {match.raceTo}</span>
                <strong>{match.playerB}</strong>
              </div>
              <div className="settle-scores">
                {scoreChoices.map((choice) => {
                  const value = `${choice.a}:${choice.b}`;
                  return (
                    <button
                      key={value}
                      className={settleScore === value ? "selected" : ""}
                      type="button"
                      aria-pressed={settleScore === value}
                      onClick={() => setSettleScore(value)}
                    >
                      {choice.a} <span>:</span> {choice.b}
                    </button>
                  );
                })}
              </div>
              <label className="field settle-password-field">
                <span>输入管理密码确认</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={settlePassword}
                  placeholder="请输入密码"
                  onChange={(event) => setSettlePassword(event.target.value)}
                />
              </label>
              <button
                className="primary-button full-width-button"
                type="submit"
                disabled={!settleScore || !settlePassword || busyAction === "settle"}
              >
                {busyAction === "settle" ? "正在结算…" : "确认赛果并结算"}
              </button>
            </form>
          </section>
        </div>
      )}

      {archiveMatch && (
        <div className="modal-backdrop" onMouseDown={() => setArchiveMatchId(null)}>
          <section
            className="modal-card artifact-archive-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="artifact-archive-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="关闭"
              onClick={() => setArchiveMatchId(null)}
            >
              ×
            </button>
            <p className="eyebrow">RECEIPT ARCHIVE</p>
            <h2 id="artifact-archive-title">票据档案</h2>
            <p className="modal-intro">
              {archiveMatch.playerA} VS {archiveMatch.playerB} · 已保存 {archiveMatch.artifacts?.length ?? 0} 张
            </p>
            <div className="artifact-list">
              {(archiveMatch.artifacts ?? []).length === 0 ? (
                <div className="artifact-empty">
                  <strong>还没有票据</strong>
                  <span>新下注、封盘和结算后会自动保存快照。</span>
                </div>
              ) : (
                archiveMatch.artifacts.map((artifact) => (
                  <button
                    className="artifact-list-item"
                    type="button"
                    key={artifact.id}
                    onClick={() => {
                      setArchiveMatchId(null);
                      openReceipt(artifact);
                    }}
                  >
                    <span className={`artifact-icon artifact-${artifact.kind}`} aria-hidden="true">
                      {artifact.kind === "bet" ? "票" : artifact.kind === "sealed" ? "锁" : "结"}
                    </span>
                    <span className="artifact-copy">
                      <strong>{ARTIFACT_KIND_COPY[artifact.kind]}</strong>
                      <small>{artifact.code} · {formatTime(artifact.createdAt)}</small>
                    </span>
                    <span className={`artifact-status artifact-status-${artifact.status}`}>
                      {ARTIFACT_STATUS_COPY[artifact.status]}
                    </span>
                    <b>查看图片</b>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {receiptArtifact && (
        <div className="modal-backdrop receipt-backdrop" onMouseDown={closeReceipt}>
          <section
            className="receipt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-preview-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="关闭"
              onClick={closeReceipt}
            >
              ×
            </button>
            <div className="receipt-preview-stage">
              {renderedReceipt ? (
                // Canvas 在浏览器内动态生成 Blob URL，不适用 Next Image 优化。
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={renderedReceipt.url}
                  alt={`${ARTIFACT_KIND_COPY[receiptArtifact.kind]} ${receiptArtifact.code}`}
                />
              ) : receiptError ? (
                <div className="receipt-render-error">
                  <strong>图片暂未生成</strong>
                  <span>{receiptError}</span>
                </div>
              ) : (
                    <div className="receipt-rendering">
                      <span className="loading-mark">8</span>
                      <p>正在生成高清票据…</p>
                    </div>
              )}
            </div>
            <aside className="receipt-sidebar">
              <p className="eyebrow">SNAPSHOT READY</p>
              <h2 id="receipt-preview-title">{ARTIFACT_KIND_COPY[receiptArtifact.kind]}</h2>
              <div className="receipt-meta-card">
                <span>票据号</span>
                <strong>{receiptArtifact.code}</strong>
                <span>生成时间</span>
                <strong>{formatTime(receiptArtifact.createdAt)}</strong>
                <span>状态</span>
                <strong className={`receipt-status-${receiptArtifact.status}`}>
                  {ARTIFACT_STATUS_COPY[receiptArtifact.status]}
                </strong>
              </div>
              {receiptArtifact.status !== "active" && (
                <div className="receipt-invalid-note">
                  这是历史版本，仅作追溯；当前有效记录请以最新票据为准。
                </div>
              )}
              <div className="receipt-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={downloadReceipt}
                  disabled={!renderedReceipt}
                >
                  下载图片
                </button>
                <button
                  className="outline-button"
                  type="button"
                  onClick={() => void copyReceipt()}
                  disabled={!renderedReceipt}
                >
                  复制图片
                </button>
                <button className="ghost-button" type="button" onClick={closeReceipt}>
                  关闭
                </button>
              </div>
              <p className="receipt-copy-tip">
                局域网 IP 访问时，部分浏览器会限制剪贴板；下载图片始终可用。
              </p>
            </aside>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onMouseDown={closeDeleteDialog}>
          <section
            className="modal-card delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="关闭"
              onClick={closeDeleteDialog}
            >
              ×
            </button>
            <p className="eyebrow danger-eyebrow">PERMANENT DELETE</p>
            <h2 id="delete-title">
              {deleteTarget.kind === "bet" ? "删除这笔下注" : "删除整场比赛"}
            </h2>
            <div className="delete-warning">
              <strong>此操作无法撤销</strong>
              <p>
                {deleteTarget.kind === "bet"
                  ? `${deleteTarget.bet.bettorName} 的 ${MODE_COPY[deleteTarget.bet.mode].title}记录将被永久删除，已生成票据会标记为“已取消”以供追溯。`
                  : `${deleteTarget.match.playerA} VS ${deleteTarget.match.playerB} 的比赛、下注、结算和所有票据将全部永久删除，不可恢复；后续滚存将按剩余比赛重新衔接。`}
              </p>
            </div>
            <form className="delete-form" onSubmit={confirmDelete}>
              <label className="field">
                <span>输入管理密码确认</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={deletePassword}
                  placeholder="请输入密码"
                  onChange={(event) => setDeletePassword(event.target.value)}
                />
              </label>
              <div className="delete-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={closeDeleteDialog}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="destructive-button"
                  disabled={!deletePassword || busyAction.startsWith("delete")}
                >
                  {busyAction.startsWith("delete")
                    ? "正在删除…"
                    : "确认永久删除"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
