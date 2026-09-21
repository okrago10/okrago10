// GitHub の活動を SVG カードにする。コントリビューションカレンダー (草) と、
// コミット時刻から出した稼働の傾向を 1 枚にまとめる。
// 必要な環境変数:
//   GITHUB_TOKEN  - GitHub API トークン (read:user 相当のスコープ)
//   GITHUB_LOGIN  - 対象ユーザーのログイン名
//   OUT_PATH      - 出力先 SVG パス (省略時: assets/activity.svg)
// 出力にタイムスタンプを含めないため、活動が変わらない日はファイルも変化しない。
//
// アニメーションの作りは stats カードと同じ。完成状態を CSS の既定値として持ち、
// アニメーション側が開始状態を作るので、CSS アニメーションを解釈しないレンダラ
// でも完成状態がそのまま出る。prefers-reduced-motion: reduce では全部止める。

import {
  ease,
  esc,
  fmt,
  framePerimeter,
  graphql,
  readEnv,
  searchCommits,
  sec,
  writeSvg,
} from "./lib/card.mjs";

const { token, login, outPath } = readEnv("assets/activity.svg");

// コミット日時が UTC (末尾 Z) で記録されている場合に、どの地方時として
// 読むか。オフセット付きで記録されている場合はそちらを優先する。
const fallbackTzOffsetHours = 9;
// コミット検索は 1 ページ 100 件。多くても直近 500 件あれば分布は安定する。
const maxCommitPages = 5;

const query = /* GraphQL */ `
  query ($login: String!) {
    user(login: $login) {
      name
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            firstDay
            contributionDays {
              contributionCount
              date
              weekday
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

const { user } = await graphql(token, login, query);
const calendar = user.contributionsCollection.contributionCalendar;
const weeks = calendar.weeks;

const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);
const commits = await searchCommits(
  token,
  login,
  `author:${login} author-date:>${oneYearAgo}`,
  maxCommitPages,
);

// コミット日時から地方時の「時」と曜日を取り出す。オフセット付きなら
// 書かれている時刻がそのまま作業時刻なので、文字列から直接読む。UTC 表記の
// ものは既定のタイムゾーンへずらす。両者を混ぜて UTC のまま数えると、
// ローカルの夜のコミットが朝に化けてしまう。
const localParts = (iso) => {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(
      iso,
    );
  if (!m) return null;

  if (m[7] === "Z") {
    const shifted = new Date(
      Date.parse(iso) + fallbackTzOffsetHours * 3600 * 1000,
    );
    return { hour: shifted.getUTCHours(), weekday: shifted.getUTCDay() };
  }
  return {
    hour: Number(m[4]),
    weekday: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay(),
  };
};

const hourCounts = new Array(24).fill(0);
const weekdayCounts = new Array(7).fill(0);
let analyzed = 0;
for (const item of commits) {
  const parts = localParts(item.commit?.author?.date ?? "");
  if (!parts) continue;
  hourCounts[parts.hour] += 1;
  weekdayCounts[parts.weekday] += 1;
  analyzed += 1;
}

const indexOfMax = (xs) => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);

// 時間帯をまとめて、最も多い区分をその人の傾向として出す。
const rhythmBuckets = [
  ["Early bird", [5, 6, 7, 8, 9, 10, 11]],
  ["Daytime", [12, 13, 14, 15, 16, 17]],
  ["Evening", [18, 19, 20]],
  ["Night owl", [21, 22, 23, 0, 1, 2, 3, 4]],
];
const rhythmLabel = analyzed
  ? rhythmBuckets
      .map(([label, hours]) => [
        label,
        hours.reduce((sum, h) => sum + hourCounts[h], 0),
      ])
      .reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]
  : "No data";

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const peakHour = indexOfMax(hourCounts);
const peakDay = dayNames[indexOfMax(weekdayCounts)];
const summary = analyzed
  ? `Peak ${String(peakHour).padStart(2, "0")}:00 · Most active on ${peakDay} · ${fmt(analyzed)} commits analyzed`
  : "Commit timestamps are not available";

// カード寸法。枠線の rect は線幅の半分だけ内側に寄せて描く。
const cardW = 420;
const cardH = 300;
const cardR = 12;
const frameInset = 0.5;
const frameW = cardW - 2 * frameInset;
const frameH = cardH - 2 * frameInset;
const frameDash = framePerimeter(frameW, frameH, cardR);

// 草のグリッド。1 列が 1 週、縦が日曜から土曜。
const gridX = 24;
const gridY = 96;
const cell = 5;
const cellGap = 2;
const cellPitch = cell + cellGap;
const gridBottom = gridY + 7 * cellPitch - cellGap;
const monthY = 88;
const legendY = 158;

// 時間帯の棒グラフ。24 本を横幅いっぱいに並べる。
const chartX = 24;
const chartW = 372;
const chartTop = 198;
const chartH = 40;
const chartBase = chartTop + chartH;
const hourPitch = chartW / 24;
const hourBarW = 11;
const axisY = 252;
const summaryY = 274;

// GitHub のカレンダーと同じ 5 段階の緑。色はクラスで当てる。
const levels = [
  ["NONE", "#ebedf0"],
  ["FIRST_QUARTILE", "#9be9a8"],
  ["SECOND_QUARTILE", "#40c463"],
  ["THIRD_QUARTILE", "#30a14e"],
  ["FOURTH_QUARTILE", "#216e39"],
];
const levelClass = Object.fromEntries(levels.map(([name], i) => [name, `q${i}`]));

// セルは 1 年分で 370 個近くになる。同じ形を defs に 1 つ置いて <use> で
// 位置だけ与え、色はクラスに逃がすことで出力を半分近くに抑える。
const cellId = "gh-ac";

// アニメーションのタイミング (秒)。後続の要素は前の要素の完了時刻から導く。
const frameDur = 0.7;
const titleDelay = 0.15;
const titleDur = 0.4;
const headingDur = 0.4;
const calHeadingDelay = 0.3;
const monthDelay = 0.4;
const weekBase = 0.4; // 草の 1 列目
const weekGap = 0.01; // 列ごとの遅延差
const weekDur = 0.3;
const calEnd = weekBase + (weeks.length - 1) * weekGap + weekDur;
const legendDelay = calEnd - 0.15;
const rhythmHeadingDelay = calEnd - 0.1;
const hourBase = calEnd;
const hourGap = 0.012;
const hourDur = 0.3;
const axisDelay = hourBase + 0.1;
const summaryDelay = hourBase + 24 * hourGap;

// 列ごとに translate でずらすので、セル側は y だけを持てばよい。
const weeksSvg = weeks
  .map((week, i) => {
    const cells = week.contributionDays
      .map((day) => {
        const y = gridY + day.weekday * cellPitch;
        const cls = levelClass[day.contributionLevel] ?? "q0";
        return `<use href="#${cellId}" class="${cls}" y="${y}"/>`;
      })
      .join("");
    return (
      `<g class="week" style="--d:${sec(weekBase + i * weekGap)}" ` +
      `transform="translate(${gridX + i * cellPitch} 0)">${cells}</g>`
    );
  })
  .join("");

// 月が変わる週にだけラベルを置く。近すぎるものは間引く。
let previousMonth = -1;
let lastLabelWeek = -99;
const monthLabels = weeks
  .map((week, i) => {
    const month = Number(week.firstDay.slice(5, 7)) - 1;
    if (month === previousMonth || i - lastLabelWeek < 3) return "";
    previousMonth = month;
    lastLabelWeek = i;
    return `<text x="${gridX + i * cellPitch}" y="${monthY}" class="axis">${monthNames[month]}</text>`;
  })
  .join("");

const maxHour = Math.max(...hourCounts);
const hourBars = hourCounts
  .map((count, h) => {
    const height = count === 0 ? 0 : Math.max(2, Math.round((count / maxHour) * chartH));
    if (height === 0) return "";
    const x = +(chartX + h * hourPitch).toFixed(2);
    const fill = h === peakHour ? "#0969da" : "#a5d6ff";
    return (
      `<rect class="hour-bar" style="--d:${sec(hourBase + h * hourGap)}" ` +
      `x="${x}" y="${chartBase - height}" width="${hourBarW}" height="${height}" rx="2" fill="${fill}"/>`
    );
  })
  .join("");

const hourAxis = [0, 6, 12, 18]
  .map(
    (h) =>
      `<text x="${+(chartX + h * hourPitch + hourBarW / 2).toFixed(2)}" y="${axisY}" text-anchor="middle" class="axis">${String(h).padStart(2, "0")}</text>`,
  )
  .join("");

// 凡例は右端ぞろえ。Less → 5 段階 → More の順に並べる。
const legendCellsWidth = levels.length * cellPitch - cellGap;
const legendCellsX = 396 - 32 - legendCellsWidth;
const legendCells = levels
  .map(
    ([name], i) =>
      `<use href="#${cellId}" class="${levelClass[name]}" x="${legendCellsX + i * cellPitch}" y="${legendY - cell}"/>`,
  )
  .join("");

const title = `${user.name ?? login}'s GitHub Activity`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}" class="gh-activity" role="img" aria-label="GitHub activity for ${esc(login)}: ${fmt(calendar.totalContributions)} contributions in the past year">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #0969da; }
    .section { font: 600 12px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .value { font: 600 12px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }
    .axis { font: 400 9px 'Segoe UI', Ubuntu, sans-serif; fill: #8b949e; }
    .summary { font: 400 11px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
${levels.map(([name], i) => `    .gh-activity .q${i} { fill: ${levels[i][1]}; }`).join("\n")}

    .frame { animation: draw ${sec(frameDur)} ease-out both; }
    .title { animation: fadeUp ${sec(titleDur)} ${ease} both ${sec(titleDelay)}; }
    .cal-heading { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(calHeadingDelay)}; }
    .months { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(monthDelay)}; }
    .week { animation: fadeIn ${sec(weekDur)} ${ease} both var(--d, 0s); }
    .legend { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(legendDelay)}; }
    .rhythm-heading { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(rhythmHeadingDelay)}; }
    .hour-bar {
      transform-box: view-box;
      transform-origin: 0 ${chartBase}px;
      animation: growY ${sec(hourDur)} ${ease} both var(--d, 0s);
    }
    .baseline { animation: fadeIn ${sec(headingDur)} ${ease} both ${sec(rhythmHeadingDelay)}; }
    .hour-axis { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(axisDelay)}; }
    .summary { animation: fadeUp ${sec(headingDur)} ${ease} both ${sec(summaryDelay)}; }

    @keyframes draw {
      from { stroke-dasharray: ${frameDash}; stroke-dashoffset: ${frameDash}; }
      to { stroke-dasharray: ${frameDash}; stroke-dashoffset: 0; }
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes growY {
      from { transform: scaleY(0); }
      to { transform: scaleY(1); }
    }

    /* インライン展開されたときにホスト側のアニメーションまで止めないよう、
       打ち消しはカードの内側に限定する。 */
    @media (prefers-reduced-motion: reduce) {
      .gh-activity * { animation: none !important; }
    }
  </style>
  <defs><rect id="${cellId}" width="${cell}" height="${cell}" rx="1"/></defs>
  <rect class="frame" x="${frameInset}" y="${frameInset}" width="${frameW}" height="${frameH}" rx="${cardR}" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="42" class="title">${esc(title)}</text>

  <g class="cal-heading">
    <text x="24" y="72" class="section">Contributions (past year)</text>
    <text x="396" y="72" text-anchor="end" class="value">${fmt(calendar.totalContributions)}</text>
  </g>
  <g class="months">${monthLabels}</g>
  ${weeksSvg}
  <g class="legend">
    <text x="${legendCellsX - 6}" y="${legendY}" text-anchor="end" class="axis">Less</text>
    ${legendCells}
    <text x="${legendCellsX + legendCellsWidth + 6}" y="${legendY}" class="axis">More</text>
  </g>

  <g class="rhythm-heading">
    <text x="24" y="180" class="section">Daily rhythm</text>
    <text x="396" y="180" text-anchor="end" class="value">${esc(rhythmLabel)}</text>
  </g>
  <line class="baseline" x1="${chartX}" y1="${chartBase + 0.5}" x2="${chartX + chartW}" y2="${chartBase + 0.5}" stroke="#eaeef2"/>
  ${hourBars}
  <g class="hour-axis">${hourAxis}</g>
  <text x="24" y="${summaryY}" class="summary">${esc(summary)}</text>
</svg>
`;

await writeSvg(outPath, svg);
