// GitHub GraphQL API からプロフィール統計を取得し、SVG カードを生成する。
// 必要な環境変数:
//   GITHUB_TOKEN  - GitHub API トークン (read:user 相当のスコープ)
//   GITHUB_LOGIN  - 対象ユーザーのログイン名
//   OUT_PATH      - 出力先 SVG パス (省略時: assets/stats.svg)
// 出力にタイムスタンプを含めないため、統計が変わらない日はファイルも変化しない。
//
// カードは表示時に一度だけ再生されるアニメーションを持つ (全体で約 1.8 秒)。
// すべての要素は完成状態を CSS の既定値として持ち、アニメーション側が開始状態を
// 作る。そのため CSS アニメーションを解釈しないレンダラでは完成状態がそのまま
// 出る。ただしアニメーションを解釈するレンダラが t=0 で静止画にした場合は途中
// 状態が写る。prefers-reduced-motion: reduce では全アニメーションを止める。
// 進行のタイミングはすべて下の定数から CSS に埋め込むので、定数を変えれば
// カード全体がそろって追従する。

import {
  cardShell,
  ease,
  esc,
  fmt,
  graphql,
  readEnv,
  sec,
  writeSvg,
} from "./lib/card.mjs";

const { token, login, outPath } = readEnv("assets/stats.svg");

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

const { user } = await graphql(token, login, query);
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

// カードの外枠と共通キーフレーム。セレクタとキーフレーム名の接頭辞もここで決まる。
const rootClass = "gh-stats";
const prefix = "gh-st";
const cardW = 420;
const cardH = 250;
const shell = cardShell({ rootClass, prefix, width: cardW, height: cardH });

// 言語バーの位置とサイズ。セグメント・クリップ・下地で共有する。
const barX = 24;
const barY = 212;
const barWidth = 372;
const barHeight = 8;
const barRadius = barHeight / 2;

// インライン展開されたときに他の SVG とぶつからないよう ID に接頭辞を付ける。
const clipBar = "gh-stats-bar";
const clipReveal = "gh-stats-reveal";

// カウントアップで通過する途中値の割合。最終値は value から直接描くので
// 1 は含めない。増減しても CSS 側の変更は要らない。
const STEPS = [0, 0.35, 0.62, 0.81, 0.93];

const rows = [
  ["Total Stars", stars],
  ["Commits (past year)", commits],
  ["Pull Requests", user.pullRequests.totalCount],
  ["Issues", user.issues.totalCount],
  ["Followers", user.followers.totalCount],
];

// アニメーションのタイミング (秒)。後続の要素は前の要素の完了時刻から導く。
const frameDur = 0.7; // 枠線を一周描く時間
const titleDelay = 0.15;
const titleDur = 0.4;
const rowBase = 0.3; // 1 行目がスライドインを始める時刻
const rowGap = 0.07; // 行ごとの遅延差
const rowDur = 0.35;
const countLag = 0.1; // スライドイン開始からカウントアップ開始までの間
const countDur = 0.5; // カウントアップにかける時間 (行によらず一定)
const lastRowDelay = rowBase + (rows.length - 1) * rowGap;
const sectionDelay = lastRowDelay; // 見出しは最終行と同時に出す
const sectionDur = 0.4;
const barDelay = sectionDelay + 0.15;
const barDur = 0.55;
const legendBase = barDelay + barDur; // 凡例はバーが埋まってから出す
const legendGap = 0.08;
const legendDur = 0.35;

// 各行は左からスライドインし、数値は途中値のテキストを重ねて順に切り替える
// ことでカウントアップに見せる。表示区間は CSS 変数で要素ごとに渡すので、
// STEPS を増減してもスタイルシート側の変更は要らない。
const rowsSvg = rows
  .map(([label, value], i) => {
    const y = 76 + i * 26;
    const rowDelay = rowBase + i * rowGap;
    const countStart = rowDelay + countLag;
    const finalText = fmt(value);

    // 最終値と同じになる途中値や、表示が変わらない途中値は出さない。
    // 値が 0 の行は途中値がなくなり、最終値だけを最初から見せる。
    const mid = [];
    for (const t of STEPS) {
      const text = fmt(Math.round(value * t));
      if (text !== finalText && mid.at(-1) !== text) mid.push(text);
    }

    // 区切りを先に 1/100 秒へ丸め、長さはその差から取る。それぞれを個別に
    // 丸めると継ぎ目に隙間ができたり、2 つの数字が重なって描かれたりする。
    const bound = (k) => +(countStart + (k * countDur) / mid.length).toFixed(2);
    const tick = (text, cls, dur, delay, decorative) =>
      `<text x="396" y="${y}" text-anchor="end" class="${cls}" ` +
      `style="--dur:${sec(dur)};--dly:${sec(delay)}"` +
      // ルートの role="img" により子孫は本来読み上げられないが、それを
      // 尊重しないテキスト抽出への保険として途中値には aria-hidden を付ける。
      `${decorative ? ' aria-hidden="true"' : ""}>${esc(text)}</text>`;

    // 途中値は自分の区間だけ見せ、最終値は出番が来るまで伏せておく。
    const ticks = mid.map((text, k) =>
      tick(text, "value tick", bound(k + 1) - bound(k), bound(k), true),
    );
    const finalStart = mid.length ? bound(mid.length) : +countStart.toFixed(2);
    ticks.push(tick(finalText, "value tick tick-last", finalStart, 0, false));

    return (
      `<g class="row" style="--d:${sec(rowDelay)}">` +
      `<text x="24" y="${y}" class="label">${esc(label)}</text>${ticks.join("")}` +
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
    const delay = sec(legendBase + i * legendGap);
    const item =
      `<g class="legend-item" style="--d:${delay}">` +
      `<circle cx="${legendX + 5}" cy="232" r="5" fill="${color}"/>` +
      `<text x="${legendX + 16}" y="236" class="legend">${esc(name)} ${pct}%</text>` +
      `</g>`;
    legendX += 16 + (`${name} ${pct}%`.length + 2) * 7;
    return item;
  })
  .join("");

const title = `${user.name ?? login}'s GitHub Stats`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}" class="${rootClass}" role="img" aria-label="GitHub stats for ${esc(login)}">
  <style>
    .${rootClass} .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #0969da; }
    .${rootClass} .label { font: 400 14px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .${rootClass} .value { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }
    .${rootClass} .section { font: 600 12px 'Segoe UI', Ubuntu, sans-serif; fill: #57606a; }
    .${rootClass} .legend { font: 400 12px 'Segoe UI', Ubuntu, sans-serif; fill: #24292f; }

${shell.css}
    .${rootClass} .title { animation: ${prefix}-fadeUp ${sec(titleDur)} ${ease} both ${sec(titleDelay)}; }
    .${rootClass} .row { animation: ${prefix}-rowIn ${sec(rowDur)} ${ease} both var(--d, 0s); }
    .${rootClass} .section, .${rootClass} .track { animation: ${prefix}-fadeUp ${sec(sectionDur)} ${ease} both ${sec(sectionDelay)}; }
    .${rootClass} .reveal {
      transform-box: view-box;
      transform-origin: ${barX}px ${barY + barRadius}px;
      animation: ${prefix}-grow ${sec(barDur)} ${ease} both ${sec(barDelay)};
    }
    .${rootClass} .legend-item { animation: ${prefix}-fadeUp ${sec(legendDur)} ${ease} both var(--d, 0s); }

    /* 途中値は既定で隠して自分の区間だけ見せ、最終値は既定で表示して出番まで
       伏せる。どちらも fill-mode を既定の none のままにするのが前提で、both を
       足すと最終値が消えたまま固定される。アニメーションが効かない環境では
       どちらも既定値のまま、つまり完成状態が残る。 */
    .${rootClass} .tick {
      opacity: 0;
      animation-name: ${prefix}-show;
      animation-timing-function: linear;
      animation-duration: var(--dur, 0s);
      animation-delay: var(--dly, 0s);
    }
    .${rootClass} .tick-last { opacity: 1; animation-name: ${prefix}-hide; }

${shell.keyframes}
    @keyframes ${prefix}-rowIn {
      from { opacity: 0; transform: translateX(-10px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes ${prefix}-grow {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    @keyframes ${prefix}-show { from, to { opacity: 1; } }
    @keyframes ${prefix}-hide { from, to { opacity: 0; } }

${shell.reducedMotion}
  </style>
  ${shell.rect}
  <text x="24" y="42" class="title">${esc(title)}</text>
  ${rowsSvg}
  <text x="24" y="202" class="section">Top Languages</text>
  <clipPath id="${clipBar}"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barRadius}"/></clipPath>
  <clipPath id="${clipReveal}"><rect class="reveal" x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}"/></clipPath>
  <rect class="track" x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barRadius}" fill="#eaeef2"/>
  <g clip-path="url(#${clipBar})"><g clip-path="url(#${clipReveal})">${segments}</g></g>
  ${legend}
</svg>
`;

await writeSvg(outPath, svg);
