"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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
  bets: Bet[];
  settlement?: Settlement[] | Record<string, Settlement> | null;
  settlements?: Settlement[] | null;
};

type GameSnapshot = {
  activeMatch: GameMatch | null;
  history: GameMatch[];
};

type Notice = { type: "success" | "error"; message: string } | null;

const EMPTY_SNAPSHOT: GameSnapshot = { activeMatch: null, history: [] };

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
  const [newMatch, setNewMatch] = useState({
    title: "好友台球对决",
    playerA: "侯良玉",
    playerB: "杜志豪",
    raceTo: "3",
    stakeLimit: "10",
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
    if (!showNewMatch && !showSettle) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [showNewMatch, showSettle]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!match) return;
    const timer = window.setTimeout(
      () => setAmount(String(Math.min(1000, match.stakeLimitCents) / 100)),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [match]);

  async function runAction(
    actionName: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setBusyAction(actionName);
    setNotice(null);
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "操作没有完成");
      await loadGame();
      setNotice({ type: "success", message: successMessage });
      return true;
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "操作没有完成",
      });
      return false;
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
        stakeLimit: String(match.stakeLimitCents / 100),
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
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setNotice({ type: "error", message: "请输入有效的下注金额" });
      return;
    }
    if (amountCents > match.stakeLimitCents) {
      setNotice({
        type: "error",
        message: `本局单注上限为 ${formatMoney(match.stakeLimitCents)}`,
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

  async function deleteBet(bet: Bet) {
    if (!window.confirm(`确认删除 ${bet.bettorName} 的这笔下注吗？`)) return;
    await runAction(
      "deleteBet",
      { action: "deleteBet", matchId: bet.matchId, betId: bet.id },
      "下注记录已删除",
    );
  }

  async function changeStatus(status: "open" | "closed") {
    if (!match) return;
    await runAction(
      "setStatus",
      { action: "setStatus", matchId: match.id, status },
      status === "closed" ? "本局已封盘" : "本局已重新开放",
    );
  }

  async function createMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raceTo = Number(newMatch.raceTo);
    const stakeLimitCents = Math.round(Number(newMatch.stakeLimit) * 100);
    const created = await runAction(
      "createMatch",
      {
        action: "createMatch",
        title: newMatch.title.trim(),
        playerA: newMatch.playerA.trim(),
        playerB: newMatch.playerB.trim(),
        raceTo,
        stakeLimitCents,
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
    if (!match || !settleScore) return;
    const [scoreA, scoreB] = settleScore.split(":").map(Number);
    const settled = await runAction(
      "settle",
      { action: "settle", matchId: match.id, scoreA, scoreB },
      "赛果和派奖结果已保存",
    );
    if (settled) {
      setShowSettle(false);
      setSettleScore("");
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

  const canCreateMatch = match.status === "settled" || match.bets.length === 0;
  const allPool = match.bets.reduce((sum, bet) => sum + bet.amountCents, 0);
  const champion =
    match.status === "settled" && match.resultScoreA !== null && match.resultScoreB !== null
      ? match.resultScoreA > match.resultScoreB
        ? match.playerA
        : match.playerB
      : null;
  const payoutsById = new Map(
    (modeSettlement?.payouts ?? []).map((payout) => [payout.betId, payout]),
  );

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
          <p className="modal-intro">两种玩法会在同一场比赛下分别记池。</p>
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
            <label className="field">
              <span>单注上限（元）</span>
              <input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                value={newMatch.stakeLimit}
                required
                onChange={(event) =>
                  setNewMatch((value) => ({
                    ...value,
                    stakeLimit: event.target.value,
                  }))
                }
              />
            </label>
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
          <span className="record-only">仅作记录 · 不涉及支付</span>
          <button
            className="outline-button compact-button"
            type="button"
            onClick={openNewMatchDialog}
            disabled={!canCreateMatch}
            title={canCreateMatch ? "新开一局" : "请先结算当前对局"}
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
            <div className="player player-a">
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
            <div className="player player-b">
              <span className="player-side">RED · B</span>
              <div className="player-avatar" aria-hidden="true">
                {match.playerB.slice(0, 1)}
              </div>
              <strong>{match.playerB}</strong>
            </div>
          </div>

          <div className="hero-footer">
            <div className="hero-meta">
              <span>单注上限 <strong>{formatMoney(match.stakeLimitCents)}</strong></span>
              <span>总记录 <strong>{match.bets.length}</strong> 笔</span>
              <span>总下注 <strong>{formatMoney(allPool)}</strong></span>
            </div>
            <div className="match-actions">
              {match.status === "open" && (
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => void changeStatus("closed")}
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
                    onClick={() => void changeStatus("open")}
                    disabled={busyAction === "setStatus"}
                  >
                    重新开放
                  </button>
                  <button
                    type="button"
                    className="primary-button small-button"
                    onClick={() => setShowSettle(true)}
                  >
                    录入赛果
                  </button>
                </>
              )}
              {match.status === "settled" && champion && (
                <span className="champion-chip">冠军 · {champion}</span>
              )}
            </div>
          </div>
        </section>

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
                        return (
                          <button
                            key={value}
                            type="button"
                            className={`score-option score-${winningSide.toLowerCase()} ${
                              selected ? "selected" : ""
                            }`}
                            aria-pressed={selected}
                            onClick={() => setScorePick(value)}
                          >
                            <strong>{choice.a}</strong>
                            <span>:</span>
                            <strong>{choice.b}</strong>
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
                        min="0.01"
                        max={match.stakeLimitCents / 100}
                        step="0.01"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </div>
                    <div className="amount-chips" aria-label="快捷金额">
                      {[100, 500, match.stakeLimitCents]
                        .filter(
                          (value, index, values) =>
                            value <= match.stakeLimitCents && values.indexOf(value) === index,
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
                  <small>单注不超过 {formatMoney(match.stakeLimitCents)}</small>
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

            <div className="stats-row">
              <div>
                <span>本玩法奖池</span>
                <strong>{formatMoney(poolTotal)}</strong>
              </div>
              <div>
                <span>下注人数</span>
                <strong>{uniqueBettors}<small> 人</small></strong>
              </div>
              <div className="popular-stat">
                <span>当前热门</span>
                <strong>{popularPick}</strong>
              </div>
            </div>

            <div className="pool-card">
              <div className="pool-bar" aria-label="20% 冠军奖金，80% 竞猜奖池">
                <span style={{ width: "20%" }}>20%</span>
                <span style={{ width: "80%" }}>80%</span>
              </div>
              <div className="pool-legend">
                <div>
                  <i className="legend-gold" />
                  <span>冠军奖金</span>
                  <strong>{formatMoney(Math.round(poolTotal * 0.2))}</strong>
                </div>
                <div>
                  <i className="legend-blue" />
                  <span>竞猜奖池</span>
                  <strong>{formatMoney(poolTotal - Math.round(poolTotal * 0.2))}</strong>
                </div>
              </div>
            </div>

            {match.status === "settled" && modeSettlement && (
              <div className="settlement-card">
                <div className="settlement-title">
                  <span>结算结果</span>
                  <strong>{match.resultScoreA} : {match.resultScoreB}</strong>
                </div>
                <div className="settlement-grid">
                  <div>
                    <span>冠军奖金</span>
                    <b>{formatMoney(modeSettlement.championPrizeCents)}</b>
                  </div>
                  <div>
                    <span>命中本金</span>
                    <b>{formatMoney(modeSettlement.totalCorrectStakeCents)}</b>
                  </div>
                  <div>
                    <span>{modeSettlement.rolloverCents > 0 ? "无人命中 · 待滚存" : "已派竞猜奖池"}</span>
                    <b>{formatMoney(
                      modeSettlement.rolloverCents > 0
                        ? modeSettlement.rolloverCents
                        : modeSettlement.guessPoolCents,
                    )}</b>
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
                        <span>{match.status === "settled" && isCorrect ? "应得" : "下注"}</span>
                        <strong>{formatMoney(
                          match.status === "settled" && isCorrect
                            ? payout?.payoutCents ?? 0
                            : bet.amountCents,
                        )}</strong>
                      </div>
                      {match.status === "open" && (
                        <div className="row-actions">
                          <button type="button" onClick={() => editBet(bet)}>编辑</button>
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => void deleteBet(bet)}
                          >
                            删除
                          </button>
                        </div>
                      )}
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
              <p><strong>公开下注</strong>每人每种玩法一注，同名保存会直接更新。</p>
            </div>
            <div className="rule-item">
              <span>02</span>
              <p><strong>20% 冠军奖金</strong>从各玩法奖池中，直接记给获胜选手。</p>
            </div>
            <div className="rule-item">
              <span>03</span>
              <p><strong>80% 竞猜奖池</strong>按命中者的下注金额比例进行分配。</p>
            </div>
            <div className="rule-item">
              <span>04</span>
              <p><strong>没人猜中</strong>系统标记待滚存，方便下一场继续核对。</p>
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
              <span>所有记录保存在站点数据库中</span>
            </div>
            <div className="history-list">
              {snapshot.history
                .filter((item) => item.id !== match.id)
                .map((item) => {
                  const total = item.bets.reduce((sum, bet) => sum + bet.amountCents, 0);
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
                        <p>{item.title} · 抢 {item.raceTo}</p>
                        <div>
                          <span>胜负局 {item.bets.filter((bet) => bet.mode === "winner").length} 注</span>
                          <span>猜比分 {item.bets.filter((bet) => bet.mode === "score").length} 注</span>
                          <span>合计 {item.bets.length} 笔</span>
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

      {showSettle && (
        <div className="modal-backdrop" onMouseDown={() => setShowSettle(false)}>
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
              onClick={() => setShowSettle(false)}
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
              <button
                className="primary-button full-width-button"
                type="submit"
                disabled={!settleScore || busyAction === "settle"}
              >
                {busyAction === "settle" ? "正在结算…" : "确认赛果并结算"}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
