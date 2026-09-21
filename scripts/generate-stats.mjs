// GitHub GraphQL API からプロフィール統計を取得し、SVG カードを生成する。
// 必要な環境変数:
//   GITHUB_TOKEN  - GitHub API トークン (read:user 相当のスコープ)
//   GITHUB_LOGIN  - 対象ユーザーのログイン名
//   OUT_PATH      - 出力先 SVG パス (省略時: assets/stats.svg)
// 出力にタイムスタンプを含めないため、統計が変わらない日はファイルも変化しない。
//
// カードは表示時に一度だけ再生されるアニメーションを持つ。CSS アニメーションが
// 効かない環境 (静的レンダラなど) でも最終状態がそのまま見えるよう、初期値では
// なく animation の fill-mode でアニメーション開始状態を作っている。
// prefers-reduced-motion: reduce の環境では全アニメーションを無効化する。

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

// カウントアップ演出の途中値を取る割合。末尾に向かって減速する。
const STEPS = [0, 0.35, 0.62, 0.81, 0.93, 1];

const rows = [
  ["Total Stars", stars],
  ["Commits (past year)", commits],
  ["Pull Requests", user.pullRequests.totalCount],
  ["Issues", user.issues.totalCount],
  ["Followers", user.followers.totalCount],
];

// 各行は左からスライドインし、数値は STEPS 分のテキストを重ねて順に切り替える
// ことでカウントアップに見せる。--d は行ごとの遅延で、子孫の .tick にも継承される。
const rowsSvg = rows
  .map(([label, value], i) => {
    const y = 76 + i * 26;
    const delay = (0.45 + i * 0.1).toFixed(2);
    const ticks = STEPS.map((t, k) => {
      // 最終値以外は演出用の途中値なので、支援技術からは隠す
      const hidden = k === STEPS.length - 1 ? "" : ' aria-hidden="true"';
      return `<text x="396" y="${y}" text-anchor="end" class="value tick t${k}"${hidden}>${fmt(Math.round(value * t))}</text>`;
    }).join("");
    return (
      `<g class="row" style="--d:${delay}s">` +
      `<text x="24" y="${y}" class="label">${esc(label)}</text>${ticks}` +
      `</g>`
    );
  })
  .join("\n  ");

const barX = 24;
const barWidth = 372;
let offset = 0;
const segments = topLangs
  .map(([, { count, color }], i) => {
    const width =
      i === topLangs.length - 1
        ? barWidth - offset
        : Math.round((count / langTotal) * barWidth);
    const rect = `<rect x="${barX + offset}" y="212" width="${width}" height="8" fill="${color}"/>`;
    offset += width;
    return rect;
  })
  .join("");

let legendX = 24;
const legend = topLangs
  .map(([name, { count, color }], i) => {
    const pct = Math.round((count / langTotal) * 100);
    const delay = (1.6 + i * 0.12).toFixed(2);
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

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="250" viewBox="0 0 420 250" role="img" aria-label="GitHub stats for ${esc(login)}">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #0969da; }
    .label { font: 400 14px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .value { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }
    .section { font: 600 12px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .legend { font: 400 12px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }

    .frame { animation: draw 1.1s ease-out both; }
    .title { animation: fadeUp .5s cubic-bezier(.2,.7,.3,1) both .25s; }
    .row { animation: rowIn .45s cubic-bezier(.2,.7,.3,1) both var(--d); }
    .section { animation: fadeUp .5s cubic-bezier(.2,.7,.3,1) both 1s; }
    .reveal { transform-origin: 24px 216px; animation: grow .8s cubic-bezier(.2,.7,.3,1) both 1.1s; }
    .legend-item { animation: fadeUp .45s cubic-bezier(.2,.7,.3,1) both var(--d); }

    .tick {
      opacity: 0;
      animation-duration: .66s;
      animation-timing-function: linear;
      animation-fill-mode: both;
      animation-delay: calc(var(--d) + .12s);
    }
    .t0 { animation-name: tk0; }
    .t1 { animation-name: tk1; }
    .t2 { animation-name: tk2; }
    .t3 { animation-name: tk3; }
    .t4 { animation-name: tk4; }
    .t5 { opacity: 1; animation-name: tk5; }

    @keyframes draw {
      from { stroke-dasharray: 1320; stroke-dashoffset: 1320; }
      to { stroke-dasharray: 1320; stroke-dashoffset: 0; }
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
    @keyframes tk0 { 0%, 16.6% { opacity: 1; } 16.7%, 100% { opacity: 0; } }
    @keyframes tk1 { 0%, 16.6% { opacity: 0; } 16.7%, 33.2% { opacity: 1; } 33.3%, 100% { opacity: 0; } }
    @keyframes tk2 { 0%, 33.2% { opacity: 0; } 33.3%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
    @keyframes tk3 { 0%, 49.9% { opacity: 0; } 50%, 66.5% { opacity: 1; } 66.6%, 100% { opacity: 0; } }
    @keyframes tk4 { 0%, 66.5% { opacity: 0; } 66.6%, 83.2% { opacity: 1; } 83.3%, 100% { opacity: 0; } }
    @keyframes tk5 { 0%, 83.2% { opacity: 0; } 83.3%, 100% { opacity: 1; } }

    @media (prefers-reduced-motion: reduce) {
      .frame, .title, .row, .section, .reveal, .legend-item, .tick { animation: none; }
    }
  </style>
  <rect class="frame" x="0.5" y="0.5" width="419" height="249" rx="12" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="42" class="title">${esc(title)}</text>
  ${rowsSvg}
  <text x="24" y="202" class="section">Top Languages</text>
  <clipPath id="bar"><rect x="24" y="212" width="372" height="8" rx="4"/></clipPath>
  <clipPath id="reveal"><rect class="reveal" x="24" y="212" width="372" height="8"/></clipPath>
  <rect x="24" y="212" width="372" height="8" rx="4" fill="#eaeef2"/>
  <g clip-path="url(#bar)"><g clip-path="url(#reveal)">${segments}</g></g>
  ${legend}
</svg>
`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, svg);
console.log(`Wrote ${outPath}`);
