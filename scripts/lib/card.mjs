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
export const framePerimeter = (w, h, r) =>
  Math.ceil(2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r);

// 必要な環境変数を読む。足りなければ理由を出して終了する。
export function readEnv(defaultOutPath) {
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_LOGIN;

  if (!token) {
    console.error("GITHUB_TOKEN is not set");
    process.exit(1);
  }
  if (!login) {
    console.error("GITHUB_LOGIN is not set");
    process.exit(1);
  }
  return { token, login, outPath: process.env.OUT_PATH || defaultOutPath };
}

const userAgent = (login) => `${login}-profile-stats`;

// GraphQL を 1 回叩いて data を返す。統計が取れなければカードを作る意味が
// ないので、失敗はすべて終了扱いにする。
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
    console.error(`GitHub API error: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const body = await res.json();
  if (body.errors?.length) {
    console.error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
    process.exit(1);
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

    const body = await res.json();
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
