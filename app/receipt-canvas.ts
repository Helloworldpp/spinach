export type ReceiptKind = "sealed";

export type ReceiptArtifact = {
  id: number;
  matchId: number;
  betId?: number | null;
  kind: ReceiptKind;
  status: "active" | "superseded" | "cancelled";
  code: string;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RenderedReceipt = {
  blob: Blob;
  url: string;
  filename: string;
};

type DisplayRow = { label: string; value: string; accent?: boolean };
type SealedBetSummary = {
  bettorName: string;
  note: string;
  mode: "winner" | "score";
  selectionLabel: string;
  amountCents: number;
  estimatedPayoutCents: number;
  estimatedNetProfitCents: number;
};

const KIND_COPY: Record<ReceiptKind, { eyebrow: string; title: string }> = {
  sealed: { eyebrow: "SEALED SNAPSHOT", title: "封盘快照" },
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function at(payload: Record<string, unknown>, ...paths: string[]) {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((current, key) => {
      return objectValue(current)[key];
    }, payload);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function textValue(payload: Record<string, unknown>, paths: string[], fallback = "—") {
  const value = at(payload, ...paths);
  return value === undefined ? fallback : String(value);
}

function numberValue(payload: Record<string, unknown>, paths: string[]) {
  const value = at(payload, ...paths);
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function money(cents: number | undefined) {
  if (cents === undefined) return "—";
  const amount = cents / 100;
  const absolute = Math.abs(amount);
  return `${amount < 0 ? "-" : ""}¥${absolute.toLocaleString("zh-CN", {
    minimumFractionDigits: absolute % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function receiptTime(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fitText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  fontSize: number,
  weight = 700,
) {
  let output = value;
  context.font = `${weight} ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  while (output.length > 1 && context.measureText(output).width > maxWidth) {
    output = `${output.slice(0, -2)}…`;
  }
  return output;
}

function matchCopy(payload: Record<string, unknown>) {
  const playerA = textValue(payload, ["playerA", "match.playerA"]);
  const playerB = textValue(payload, ["playerB", "match.playerB"]);
  const raceTo = textValue(payload, ["raceTo", "match.raceTo"], "");
  return {
    title: textValue(payload, ["matchTitle", "title", "match.title"], "好友台球对决"),
    players: `${playerA}  VS  ${playerB}`,
    raceTo: raceTo ? `抢 ${raceTo}` : "",
  };
}

function poolRows(
  payload: Record<string, unknown>,
  mode: "winner" | "score",
) {
  const prefix = mode === "winner" ? "winner" : "score";
  const pool = objectValue(at(payload, prefix, `pools.${prefix}`));
  const combined = { ...payload, pool };
  const rows: DisplayRow[] = [
    {
      label: mode === "winner" ? "胜负池·本局新注" : "比分池·本局新注",
      value: money(numberValue(combined, ["pool.newStakeCents", `${prefix}NewStakeCents`])),
    },
    {
      label: "带入滚存",
      value: money(numberValue(combined, ["pool.rolloverInCents", `${prefix}RolloverInCents`])),
    },
    {
      label: "封盘当前总池",
      value: money(
        numberValue(combined, [
          "pool.grossPoolCents",
          `${prefix}DistributablePoolCents`,
        ]),
      ),
      accent: true,
    },
    {
      label: "封盘可分奖池",
      value: money(
        numberValue(
          combined,
          ["pool.distributablePoolCents", "pool.availablePoolCents"],
        ),
      ),
    },
  ];
  const championPrize = numberValue(combined, ["pool.championPrizeCents"]);
  if (mode === "winner" && championPrize !== undefined && championPrize > 0) {
    rows.splice(3, 0, {
      label: "旧规则冠军奖金",
      value: money(championPrize),
    });
  }
  return rows;
}

function sealedOptionRows(payload: Record<string, unknown>): DisplayRow[] {
  return (["winner", "score"] as const).flatMap((mode) => {
    const options = at(payload, `pools.${mode}.options`);
    if (!Array.isArray(options)) return [];
    return options
      .map((entry) => objectValue(entry))
      .filter((entry) => (numberValue(entry, ["stakeCents"]) ?? 0) > 0)
      .map((entry) => ({
        label: `${mode === "winner" ? "胜负" : "比分"}选项·${textValue(entry, ["label", "key"])}`,
        value: money(numberValue(entry, ["stakeCents"])),
      }));
  });
}

function sealedBetSummaries(payload: Record<string, unknown>): SealedBetSummary[] {
  const summaries = at(payload, "betSummaries");
  if (!Array.isArray(summaries)) return [];
  return summaries.flatMap((item) => {
    const summary = objectValue(item);
    const mode = textValue(summary, ["mode"], "");
    if (mode !== "winner" && mode !== "score") return [];
    return [{
      bettorName: textValue(summary, ["bettorName"]),
      note: textValue(summary, ["note"], ""),
      mode,
      selectionLabel: textValue(summary, ["selectionLabel"]),
      amountCents: numberValue(summary, ["amountCents"]) ?? 0,
      estimatedPayoutCents: numberValue(summary, ["estimatedPayoutCents"]) ?? 0,
      estimatedNetProfitCents: numberValue(summary, ["estimatedNetProfitCents"]) ?? 0,
    }];
  });
}

function drawSealedTable(
  context: CanvasRenderingContext2D,
  title: string,
  bets: SealedBetSummary[],
  y: number,
) {
  const rowHeight = 62;
  const headerHeight = 104;
  const bodyRows = Math.max(1, bets.length);
  const height = headerHeight + bodyRows * rowHeight + 52;
  const x = 78;
  const width = 924;

  context.fillStyle = "rgba(255,255,255,0.035)";
  roundedRect(context, x, y, width, height, 18);
  context.fill();
  context.strokeStyle = "rgba(232,189,88,0.28)";
  context.lineWidth = 2;
  context.stroke();

  const totalStake = bets.reduce((sum, bet) => sum + bet.amountCents, 0);
  context.fillStyle = "#f4efe2";
  context.font = '900 29px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "left";
  context.fillText(title, x + 24, y + 39);
  context.fillStyle = "#e8bd58";
  context.font = '800 21px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "right";
  context.fillText(`${bets.length} 笔 · 下注 ${money(totalStake)}`, x + width - 24, y + 39);

  const columns = [
    { label: "下注人", x: x + 24, align: "left" as const },
    { label: "选择", x: x + 275, align: "left" as const },
    { label: "下注金额", x: x + 580, align: "right" as const },
    { label: "预估奖金", x: x + 760, align: "right" as const },
    { label: "预估净赢", x: x + width - 24, align: "right" as const },
  ];
  context.fillStyle = "rgba(255,255,255,0.035)";
  context.fillRect(x + 1, y + 57, width - 2, 47);
  context.fillStyle = "#858880";
  context.font = '700 18px "PingFang SC", "Microsoft YaHei", sans-serif';
  columns.forEach((column) => {
    context.textAlign = column.align;
    context.fillText(column.label, column.x, y + 88);
  });

  if (bets.length === 0) {
    context.fillStyle = "#7d8079";
    context.font = '650 21px "PingFang SC", "Microsoft YaHei", sans-serif';
    context.textAlign = "center";
    context.fillText("本玩法没有下注", 540, y + 139);
  } else {
    bets.forEach((bet, index) => {
      const rowY = y + headerHeight + index * rowHeight;
      if (index > 0) {
        context.strokeStyle = "rgba(255,255,255,0.07)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x + 20, rowY);
        context.lineTo(x + width - 20, rowY);
        context.stroke();
      }
      const baseline = rowY + 32;
      context.fillStyle = "#f4efe2";
      context.font = '750 20px "PingFang SC", "Microsoft YaHei", sans-serif';
      context.textAlign = "left";
      context.fillText(fitText(context, bet.bettorName, 220, 20, 750), columns[0].x, baseline);
      if (bet.note) {
        context.fillStyle = "#9d9f98";
        context.font = '600 15px "PingFang SC", "Microsoft YaHei", sans-serif';
        context.fillText(
          fitText(context, `“${bet.note}”`, 220, 15, 600),
          columns[0].x,
          baseline + 20,
        );
      }
      context.fillStyle = "#f4efe2";
      context.font = '750 20px "PingFang SC", "Microsoft YaHei", sans-serif';
      context.fillText(fitText(context, bet.selectionLabel, 250, 20, 750), columns[1].x, baseline);
      context.textAlign = "right";
      context.fillText(money(bet.amountCents), columns[2].x, baseline);
      context.fillStyle = "#f4cd6a";
      context.font = '900 21px "PingFang SC", "Microsoft YaHei", sans-serif';
      context.fillText(money(bet.estimatedPayoutCents), columns[3].x, baseline);
      context.fillStyle = bet.estimatedNetProfitCents >= 0 ? "#79d9a6" : "#ef7a72";
      context.fillText(money(bet.estimatedNetProfitCents), columns[4].x, baseline);
    });
  }
  context.textAlign = "left";
  return y + height;
}

function snapshotRows(artifact: ReceiptArtifact): DisplayRow[] {
  const payload = artifact.payload;
  const rows: DisplayRow[] = [{
    label: "封盘时间",
    value: textValue(payload, ["sealedAt"], receiptTime(artifact.createdAt)),
  }];
  const betCount = numberValue(payload, ["betCount", "totalBetCount"]);
  rows.push({ label: "票据笔数", value: betCount === undefined ? "—" : `${betCount} 笔` });

  rows.push(
    ...poolRows(payload, "winner"),
    ...poolRows(payload, "score"),
  );
  rows.push(...sealedOptionRows(payload));
  return rows;
}

function drawStamp(context: CanvasRenderingContext2D, artifact: ReceiptArtifact) {
  const copy =
    artifact.status === "active"
      ? "有效"
      : artifact.status === "superseded"
        ? "已更新"
        : "已取消";
  const color = artifact.status === "active" ? "#e8bd58" : "#ef6f66";
  context.save();
  context.translate(876, 225);
  context.rotate(-0.1);
  context.strokeStyle = color;
  context.lineWidth = 7;
  context.globalAlpha = 0.9;
  roundedRect(context, -112, -45, 224, 90, 18);
  context.stroke();
  context.fillStyle = color;
  context.font = '900 35px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(copy, 0, 1);
  context.restore();
}

async function renderSealedSummaryReceipt(
  artifact: ReceiptArtifact,
  summaries: SealedBetSummary[],
): Promise<RenderedReceipt> {
  const winnerBets = summaries.filter((bet) => bet.mode === "winner");
  const scoreBets = summaries.filter((bet) => bet.mode === "score");
  const tableHeight = (count: number) => 104 + Math.max(1, count) * 62 + 52;
  const canvasHeight = Math.max(
    1440,
    614 + tableHeight(winnerBets.length) + tableHeight(scoreBets.length) + 250,
  );
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成封盘快照");

  const background = context.createLinearGradient(0, 0, 1080, canvasHeight);
  background.addColorStop(0, "#171915");
  background.addColorStop(0.42, "#070a09");
  background.addColorStop(1, "#10120f");
  context.fillStyle = background;
  context.fillRect(0, 0, 1080, canvasHeight);

  const glow = context.createRadialGradient(180, 50, 0, 180, 50, 590);
  glow.addColorStop(0, "rgba(232,189,88,0.22)");
  glow.addColorStop(1, "rgba(232,189,88,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 1080, 700);

  context.strokeStyle = "rgba(232,189,88,0.42)";
  context.lineWidth = 3;
  roundedRect(context, 42, 42, 996, canvasHeight - 84, 28);
  context.stroke();
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 1;
  roundedRect(context, 55, 55, 970, canvasHeight - 110, 22);
  context.stroke();

  context.fillStyle = "#e8bd58";
  context.font = '900 25px Arial, "PingFang SC", sans-serif';
  context.letterSpacing = "7px";
  context.fillText("SEALED BET SUMMARY", 90, 126);
  context.letterSpacing = "0px";
  context.fillStyle = "#fff6d5";
  context.font = '900 68px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText("封盘下注汇总", 86, 218);
  context.fillStyle = "#a6a79f";
  context.font = '500 25px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(`票据号 ${artifact.code}`, 90, 272);
  context.fillText(`封盘 ${receiptTime(artifact.createdAt)}`, 90, 311);
  context.fillText(`共 ${summaries.length} 笔下注`, 90, 350);
  drawStamp(context, artifact);

  const match = matchCopy(artifact.payload);
  context.fillStyle = "rgba(255,255,255,0.035)";
  roundedRect(context, 78, 392, 924, 178, 22);
  context.fill();
  context.strokeStyle = "rgba(232,189,88,0.23)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#e8bd58";
  context.font = '800 21px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(match.raceTo ? `本场对决  ·  ${match.raceTo}` : "本场对决", 111, 438);
  context.fillStyle = "#f4efe2";
  context.font = '800 34px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(fitText(context, match.title, 850, 34, 800), 111, 489);
  context.fillStyle = "#bfc0b8";
  context.font = '700 27px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(fitText(context, match.players, 850, 27, 700), 111, 536);

  let nextY = drawSealedTable(context, "胜负下注汇总", winnerBets, 610);
  nextY = drawSealedTable(context, "比分下注汇总", scoreBets, nextY + 18);

  context.fillStyle = "rgba(232,189,88,0.09)";
  roundedRect(context, 78, nextY + 28, 924, 92, 18);
  context.fill();
  context.strokeStyle = "rgba(232,189,88,0.35)";
  context.stroke();
  context.fillStyle = "#f1cf77";
  context.font = '800 23px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "center";
  context.fillText("预估奖金按封盘奖池计算，最终以赛果结算为准", 540, nextY + 83);
  context.fillStyle = "#777a73";
  context.font = '600 20px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "right";
  context.fillText("一杆定胜负", 1004, canvasHeight - 76);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("封盘快照生成失败"))),
      "image/png",
      1,
    );
  });
  const safeCode = artifact.code.replace(/[^\w-]+/gu, "-");
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename: `封盘下注汇总-${safeCode}.png`,
  };
}

export async function renderReceipt(artifact: ReceiptArtifact): Promise<RenderedReceipt> {
  const sealedSummaries =
    artifact.kind === "sealed" ? sealedBetSummaries(artifact.payload) : [];
  if (artifact.kind === "sealed" && sealedSummaries.length > 0) {
    return renderSealedSummaryReceipt(artifact, sealedSummaries);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1440;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成票据图片");

  const background = context.createLinearGradient(0, 0, 1080, 1440);
  background.addColorStop(0, "#171915");
  background.addColorStop(0.45, "#070a09");
  background.addColorStop(1, "#10120f");
  context.fillStyle = background;
  context.fillRect(0, 0, 1080, 1440);

  const glow = context.createRadialGradient(180, 50, 0, 180, 50, 590);
  glow.addColorStop(0, "rgba(232,189,88,0.22)");
  glow.addColorStop(1, "rgba(232,189,88,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 1080, 700);

  context.strokeStyle = "rgba(232,189,88,0.42)";
  context.lineWidth = 3;
  roundedRect(context, 42, 42, 996, 1356, 28);
  context.stroke();
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 1;
  roundedRect(context, 55, 55, 970, 1330, 22);
  context.stroke();

  context.fillStyle = "#e8bd58";
  context.font = '900 25px Arial, "PingFang SC", sans-serif';
  context.letterSpacing = "7px";
  context.fillText(KIND_COPY[artifact.kind].eyebrow, 90, 126);
  context.letterSpacing = "0px";
  context.fillStyle = "#fff6d5";
  context.font = '900 68px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(KIND_COPY[artifact.kind].title, 86, 218);

  context.fillStyle = "#a6a79f";
  context.font = '500 25px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(`票据号 ${artifact.code}`, 90, 272);
  context.fillText(`生成 ${receiptTime(artifact.createdAt)}`, 90, 311);
  context.fillText(`版本 V${artifact.revision}`, 90, 350);
  drawStamp(context, artifact);

  const match = matchCopy(artifact.payload);
  context.fillStyle = "rgba(255,255,255,0.035)";
  roundedRect(context, 78, 392, 924, 178, 22);
  context.fill();
  context.strokeStyle = "rgba(232,189,88,0.23)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#e8bd58";
  context.font = '800 21px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(match.raceTo ? `本场对决  ·  ${match.raceTo}` : "本场对决", 111, 438);
  context.fillStyle = "#f4efe2";
  context.font = '800 34px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(fitText(context, match.title, 850, 34, 800), 111, 489);
  context.fillStyle = "#bfc0b8";
  context.font = '700 27px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(fitText(context, match.players, 850, 27, 700), 111, 536);

  const rows = snapshotRows(artifact);
  const startY = 613;
  const maxRows = 19;
  const shownRows = rows.length > maxRows
    ? [
        ...rows.slice(0, maxRows - 1),
        { label: "其余明细", value: `另 ${rows.length - maxRows + 1} 项请在账簿查看` },
      ]
    : rows;
  const rowHeight = Math.min(58, Math.floor(585 / Math.max(1, shownRows.length)));
  const labelFontSize = Math.max(17, Math.min(22, rowHeight - 10));
  const valueFontSize = Math.max(19, Math.min(27, rowHeight - 7));
  shownRows.forEach((row, index) => {
    const y = startY + index * rowHeight;
    if (index > 0) {
      context.strokeStyle = "rgba(255,255,255,0.075)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(94, y - rowHeight / 2);
      context.lineTo(986, y - rowHeight / 2);
      context.stroke();
    }
    context.fillStyle = "#8f918a";
    context.font = `600 ${labelFontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    context.textAlign = "left";
    context.fillText(row.label, 101, y);
    context.fillStyle = row.accent ? "#f4cd6a" : "#f4efe2";
    context.font = `${row.accent ? 900 : 750} ${valueFontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    context.textAlign = "right";
    context.fillText(
      fitText(context, row.value, 540, valueFontSize, row.accent ? 900 : 750),
      979,
      y,
    );
  });
  context.textAlign = "left";

  const noteY = 1264;
  context.fillStyle = "rgba(232,189,88,0.09)";
  roundedRect(context, 78, noteY - 47, 924, 92, 18);
  context.fill();
  context.strokeStyle = "rgba(232,189,88,0.35)";
  context.stroke();
  context.fillStyle = "#f1cf77";
  context.font = '800 24px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "center";
  context.fillText(
    "封盘后下注已锁定，最终以比赛结果为准",
    540,
    noteY + 8,
  );

  context.fillStyle = "#777a73";
  context.font = '500 20px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.textAlign = "left";
  context.textAlign = "right";
  context.fillText("一杆定胜负", 1004, 1361);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("票据图片生成失败"))),
      "image/png",
      1,
    );
  });
  const safeCode = artifact.code.replace(/[^\w-]+/gu, "-");
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename: `${KIND_COPY[artifact.kind].title}-${safeCode}.png`,
  };
}
