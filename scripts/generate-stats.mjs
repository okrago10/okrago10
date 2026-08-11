// GitHub GraphQL API からプロフィール統計を取得し、SVG カードを生成する。
// 必要な環境変数:
//   GITHUB_TOKEN  - GitHub API トークン (read:user 相当のスコープ)
//   GITHUB_LOGIN  - 対象ユーザーのログイン名
//   OUT_PATH      - 出力先 SVG パス (省略時: assets/stats.svg)
// 出力にタイムスタンプを含めないため、統計が変わらない日はファイルも変化しない。

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

const rows = [
  ["Total Stars", fmt(stars)],
  ["Commits (past year)", fmt(commits)],
  ["Pull Requests", fmt(user.pullRequests.totalCount)],
  ["Issues", fmt(user.issues.totalCount)],
  ["Followers", fmt(user.followers.totalCount)],
];

const rowsSvg = rows
  .map(
    ([label, value], i) =>
      `<text x="24" y="${76 + i * 26}" class="label">${esc(label)}</text>` +
      `<text x="396" y="${76 + i * 26}" text-anchor="end" class="value">${esc(value)}</text>`,
  )
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
  .map(([name, { count, color }]) => {
    const pct = Math.round((count / langTotal) * 100);
    const item =
      `<circle cx="${legendX + 5}" cy="232" r="5" fill="${color}"/>` +
      `<text x="${legendX + 16}" y="236" class="legend">${esc(name)} ${pct}%</text>`;
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
  </style>
  <rect x="0.5" y="0.5" width="419" height="249" rx="12" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="42" class="title">${esc(title)}</text>
  ${rowsSvg}
  <text x="24" y="202" class="section">Top Languages</text>
  <clipPath id="bar"><rect x="24" y="212" width="372" height="8" rx="4"/></clipPath>
  <rect x="24" y="212" width="372" height="8" rx="4" fill="#eaeef2"/>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}
</svg>
`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, svg);
console.log(`Wrote ${outPath}`);
