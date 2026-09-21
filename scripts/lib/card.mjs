// stats / activity どちらのカード生成でも使う共通部品。
// SVG のレイアウトはカードごとに違うので、ここには素材だけを置く。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const fmt = (n) => n.toLocaleString("en-US");

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// アニメーションの秒数表記。0.30000000000000004 のような誤差を落とす。
export const sec = (n) => `${+n.toFixed(2)}s`;

export const ease = "cubic-bezier(.2,.7,.3,1)";

// 枠線を一周描くためのダッシュ長。角丸を含む外周を切り上げて返す。
// 実際の外周より短いと、アニメーション後も破線の隙間が残ってしまう。
const framePerimeter = (w, h, r) =>
  Math.ceil(2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r);

// カードの外枠と、どのカードも使うキーフレームを組み立てる。
// セレクタとキーフレーム名にカードごとの接頭辞を付けるのは、2 枚を同じ文書に
// インライン展開したときに互いを上書きしないため。
export function cardShell({
  rootClass,
  prefix,
  width,
  height,
  radius = 12,
  frameDur = 0.7,
}) {
  const inset = 0.5;
  const frameW = width - 2 * inset;
  const frameH = height - 2 * inset;
  const dash = framePerimeter(frameW, frameH, radius);

  return {
    frameW,
    frameH,
    css: `    .${rootClass} .frame { animation: ${prefix}-draw ${sec(frameDur)} ease-out both; }`,
    keyframes: `    @keyframes ${prefix}-draw {
      from { stroke-dasharray: ${dash}; stroke-dashoffset: ${dash}; }
      to { stroke-dasharray: ${dash}; stroke-dashoffset: 0; }
    }
    @keyframes ${prefix}-fadeUp {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }`,
    // ホスト側のアニメーションまで止めないよう、打ち消しはカードの内側に限る。
    reducedMotion: `    @media (prefers-reduced-motion: reduce) {
      .${rootClass} * { animation: none !important; }
    }`,
    rect: `<rect class="frame" x="${inset}" y="${inset}" width="${frameW}" height="${frameH}" rx="${radius}" fill="#ffffff" stroke="#d0d7de"/>`,
  };
}

// 失敗はすべて throw で返す。process.exit で落とすと、stderr がパイプの
// ときに直前の console.error が流れきらず、ログに何も残らないことがある。

// 必要な環境変数を読む。足りなければ理由を添えて投げる。
export function readEnv(defaultOutPath) {
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_LOGIN;

  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!login) throw new Error("GITHUB_LOGIN is not set");

  return { token, login, outPath: process.env.OUT_PATH || defaultOutPath };
}

// 環境変数から数値を読む。未設定・空・数値でない場合は既定値に落とす。
export function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

const userAgent = (login) => `${login}-profile-stats`;

// GraphQL を 1 回叩いて data を返す。統計が取れなければカードを作る意味が
// ないので、失敗はすべて投げる。
export async function graphql(token, login, query, variables = { login }) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": userAgent(login),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

const searchPageSize = 100;

// コミット検索を叩いて items を集める。GraphQL と違い、こちらは欠けても
// 分布の精度が落ちるだけなので、失敗したらそこまでの分を返して続行する。
export async function searchCommits(token, login, q, maxPages) {
  const items = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL("https://api.github.com/search/commits");
    url.searchParams.set("q", q);
    url.searchParams.set("sort", "author-date");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(searchPageSize));
    url.searchParams.set("page", String(page));

    let body;
    try {
      const res = await fetch(url, {
        headers: {
          authorization: `bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": userAgent(login),
        },
      });
      if (!res.ok) {
        console.warn(`commit search stopped at page ${page}: ${res.status}`);
        break;
      }
      body = await res.json();
    } catch (error) {
      // 通信そのものの失敗や壊れた本文。ここで投げるとカード全体が出せなく
      // なるので、集まった分で打ち切る。
      console.warn(`commit search failed at page ${page}: ${error.message}`);
      break;
    }

    // 200 でも items を持たない応答 (レート制限の警告など) が返ることがある。
    if (!Array.isArray(body.items)) {
      console.warn(`commit search returned no items at page ${page}`);
      break;
    }
    items.push(...body.items);
    if (body.items.length < searchPageSize) break;
  }

  return items;
}

export async function writeSvg(outPath, svg) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, svg);
  console.log(`Wrote ${outPath}`);
}
