// GitHub GraphQL API からプロフィール統計を取得し、SVG カードを生成する。
// 必要な環境変数:
//   GITHUB_TOKEN  - GitHub API トークン (read:user 相当のスコープ)
//   GITHUB_LOGIN  - 対象ユーザーのログイン名
//   OUT_PATH      - 出力先 SVG パス (省略時: assets/stats.svg)
// 出力にタイムスタンプを含めないため、統計が変わらない日はファイルも変化しない。
//
// カードは表示時に一度だけ再生されるアニメーションを持つ (全体で約 1.7 秒)。
// すべての要素は完成状態を CSS の既定値として持ち、アニメーション側が開始状態を
// 作る。そのため CSS アニメーションを解釈しないレンダラでは完成状態がそのまま
// 出る。ただしアニメーションを解釈するレンダラが t=0 で静止画にした場合は途中
// 状態が写る。prefers-reduced-motion: reduce では全アニメーションを止める。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const token = process.env.GITHUB_TOKEN;
const login = process.env.GITHUB_LOGIN;
const outPath = process.env.OUT_PATH || "assets/stats.svg";

if (!token) {
  console.error("GITHUB_TOKEN is not set");
  process.exit(1);
}
if (!login) {
  console.error("GITHUB_LOGIN is not set");
  process.exit(1);
}

const query = /* GraphQL */ `
  query ($login: String!) {
    user(login: $login) {
      name
      followers {
        totalCount
      }
      pullRequests {
        totalCount
      }
      issues {
        totalCount
      }
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
      }
      repositories(
        first: 100
        ownerAffiliations: OWNER
        isFork: false
        orderBy: { field: STARGAZERS, direction: DESC }
      ) {
        nodes {
          stargazerCount
          primaryLanguage {
            name
            color
          }
        }
      }
    }
  }
`;

const res = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `bearer ${token}`,
    "content-type": "application/json",
    "user-agent": `${login}-profile-stats`,
  },
  body: JSON.stringify({ query, variables: { login } }),
});

if (!res.ok) {
  console.error(`GitHub API error: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const body = await res.json();
if (body.errors?.length) {
  console.error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  process.exit(1);
}

const user = body.data.user;
const repos = user.repositories.nodes;

const stars = repos.reduce((sum, repo) => sum + repo.stargazerCount, 0);
const commits =
  user.contributionsCollection.totalCommitContributions +
  user.contributionsCollection.restrictedContributionsCount;

const langCounts = new Map();
for (const repo of repos) {
  const lang = repo.primaryLanguage;
  if (!lang) continue;
  const entry = langCounts.get(lang.name) ?? {
    count: 0,
    color: lang.color ?? "#8b949e",
  };
  entry.count += 1;
  langCounts.set(lang.name, entry);
}
const topLangs = [...langCounts.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 3);
const langTotal = topLangs.reduce((sum, [, v]) => sum + v.count, 0);

const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// カード寸法。枠線の rect は 0.5 ずらして描くので幅・高さは 1 小さい。
const cardW = 420;
const cardH = 250;
const cardR = 12;
// 枠線を一周描くためのダッシュ長。角丸を含む外周を切り上げて使う。
// 実際の外周より短いと、アニメーション後も破線の隙間が残ってしまう。
const framePerimeter = Math.ceil(
  2 * (cardW - 1 - 2 * cardR) +
    2 * (cardH - 1 - 2 * cardR) +
    2 * Math.PI * cardR,
);

// 言語バーの位置とサイズ。セグメント・クリップ・下地で共有する。
const barX = 24;
const barY = 212;
const barWidth = 372;
const barHeight = 8;

// アニメーションのタイミング (秒)。
const rowBase = 0.3; // 1 行目がスライドインを始める時刻
const rowGap = 0.07; // 行ごとの遅延差
const countLag = 0.1; // スライドイン開始からカウントアップ開始までの間
const countDur = 0.5; // カウントアップ全体の長さ
const legendBase = 1.2; // 凡例 1 件目が現れる時刻
const legendGap = 0.08;

// カウントアップ演出で通過する値の割合。末尾に向かって減速する。
const STEPS = [0, 0.35, 0.62, 0.81, 0.93, 1];

const rows = [
  ["Total Stars", stars],
  ["Commits (past year)", commits],
  ["Pull Requests", user.pullRequests.totalCount],
  ["Issues", user.issues.totalCount],
  ["Followers", user.followers.totalCount],
];

// 各行は左からスライドインし、数値は途中値のテキストを重ねて順に切り替える
// ことでカウントアップに見せる。表示区間は CSS 変数で要素ごとに渡すので、
// STEPS を増減してもスタイルシート側の変更は要らない。
const rowsSvg = rows
  .map(([label, value], i) => {
    const y = 76 + i * 26;
    const rowDelay = rowBase + i * rowGap;
    const countStart = rowDelay + countLag;

    // 表示が変わらない途中値は出さない。値が 0 の行なら最終値の 1 つだけになる。
    const frames = [];
    for (const t of STEPS) {
      const text = fmt(Math.round(value * t));
      if (frames.at(-1) !== text) frames.push(text);
    }
    const segment = countDur / frames.length;

    const ticks = frames
      .map((text, k) => {
        const isLast = k === frames.length - 1;
        const start = countStart + k * segment;
        // 最終値は既定で表示しておき、出番が来るまでを hide で伏せる。
        // 途中値は既定で非表示にし、自分の区間だけ show で見せる。
        const dur = isLast ? start : segment;
        const delay = isLast ? 0 : start;
        const cls = isLast ? "value tick tick-last" : "value tick";
        // ルートの role="img" により子孫は本来読み上げられないが、それを
        // 尊重しないテキスト抽出への保険として途中値には aria-hidden を付ける。
        const hidden = isLast ? "" : ' aria-hidden="true"';
        return (
          `<text x="396" y="${y}" text-anchor="end" class="${cls}" ` +
          `style="--dur:${dur.toFixed(2)}s;--dly:${delay.toFixed(2)}s"${hidden}>${text}</text>`
        );
      })
      .join("");

    return (
      `<g class="row" style="--d:${rowDelay.toFixed(2)}s">` +
      `<text x="24" y="${y}" class="label">${esc(label)}</text>${ticks}` +
      `</g>`
    );
  })
  .join("\n  ");

let offset = 0;
const segments = topLangs
  .map(([, { count, color }], i) => {
    const width =
      i === topLangs.length - 1
        ? barWidth - offset
        : Math.round((count / langTotal) * barWidth);
    const rect = `<rect x="${barX + offset}" y="${barY}" width="${width}" height="${barHeight}" fill="${color}"/>`;
    offset += width;
    return rect;
  })
  .join("");

let legendX = 24;
const legend = topLangs
  .map(([name, { count, color }], i) => {
    const pct = Math.round((count / langTotal) * 100);
    const delay = (legendBase + i * legendGap).toFixed(2);
    const item =
      `<g class="legend-item" style="--d:${delay}s">` +
      `<circle cx="${legendX + 5}" cy="232" r="5" fill="${color}"/>` +
      `<text x="${legendX + 16}" y="236" class="legend">${esc(name)} ${pct}%</text>` +
      `</g>`;
    legendX += 16 + (`${name} ${pct}%`.length + 2) * 7;
    return item;
  })
  .join("");

const title = `${user.name ?? login}'s GitHub Stats`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}" role="img" aria-label="GitHub stats for ${esc(login)}">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #0969da; }
    .label { font: 400 14px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .value { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }
    .section { font: 600 12px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .legend { font: 400 12px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }

    .frame { animation: draw .7s ease-out both; }
    .title { animation: fadeUp .4s cubic-bezier(.2,.7,.3,1) both .15s; }
    .row { animation: rowIn .35s cubic-bezier(.2,.7,.3,1) both var(--d, 0s); }
    .section, .track { animation: fadeUp .4s cubic-bezier(.2,.7,.3,1) both .75s; }
    .reveal {
      transform-box: view-box;
      transform-origin: ${barX}px ${barY + barHeight / 2}px;
      animation: grow .6s cubic-bezier(.2,.7,.3,1) both .85s;
    }
    .legend-item { animation: fadeUp .35s cubic-bezier(.2,.7,.3,1) both var(--d, 0s); }

    /* 途中値は既定で隠し自分の区間だけ見せる。最終値はその逆で、
       どちらもアニメーションが効かなければ完成状態のまま残る。 */
    .tick {
      opacity: 0;
      animation-name: show;
      animation-timing-function: linear;
      animation-duration: var(--dur, 0s);
      animation-delay: var(--dly, 0s);
    }
    .tick-last { opacity: 1; animation-name: hide; }

    @keyframes draw {
      from { stroke-dasharray: ${framePerimeter}; stroke-dashoffset: ${framePerimeter}; }
      to { stroke-dasharray: ${framePerimeter}; stroke-dashoffset: 0; }
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes rowIn {
      from { opacity: 0; transform: translateX(-10px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes grow {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    @keyframes show { from, to { opacity: 1; } }
    @keyframes hide { from, to { opacity: 0; } }

    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; }
    }
  </style>
  <rect class="frame" x="0.5" y="0.5" width="${cardW - 1}" height="${cardH - 1}" rx="${cardR}" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="42" class="title">${esc(title)}</text>
  ${rowsSvg}
  <text x="24" y="202" class="section">Top Languages</text>
  <clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barHeight / 2}"/></clipPath>
  <clipPath id="reveal"><rect class="reveal" x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}"/></clipPath>
  <rect class="track" x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="#eaeef2"/>
  <g clip-path="url(#bar)"><g clip-path="url(#reveal)">${segments}</g></g>
  ${legend}
</svg>
`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, svg);
console.log(`Wrote ${outPath}`);
