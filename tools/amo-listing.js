// Firefox のストア（AMO）のページを、docs/amo/listing.md と画像に合わせて更新する。
// 名前・要約・説明（日本語と英語）、アイコン、スクリーンショットと説明を、AMO の API で書き換える。
//
// 使い方:
//   npm run listing:firefox             今のページと、書き換える内容を表示するだけ（AMO は変えない）
//   npm run listing:firefox -- apply    AMO のページを書き換える
//   npm run listing:firefox -- apply screenshots   スクリーンショットだけを合わせる（途中で止まったときなど）
//   npm run listing:firefox -- apply replace       スクリーンショットを、すべて消して載せ直す（画像を作り直したとき）
//   AMO の API キーが要る。環境変数 WEB_EXT_API_KEY（JWT issuer）と WEB_EXT_API_SECRET（JWT secret）に入れておく
//
// スクリーンショットは、日本語の説明が同じものを「載っている」とみなして残し、足りないものだけを載せ、余分なもの（重複など）は消す。
// AMO は書き換えの回数に 1 日の上限があり、上限に当たると約 23 時間待たされた（2026-11-16）。載せ直しは最小限にする。
// API の説明：https://mozilla.github.io/addons-server/topics/api/addons.html
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://addons.mozilla.org/api/v5';
const ADDON = encodeURIComponent('live-audio-enhancer@mynicotools');
const NAME = 'Live Audio Enhancer';
const ICON = path.join(ROOT, 'extension/icons/icon-128.png');
const SCREENSHOTS = path.join(ROOT, 'docs/amo/screenshots');

// docs/amo/listing.md から、要約・説明（日本語・英語）と、スクリーンショットの説明を読む
function readListing() {
  const text = fs.readFileSync(path.join(ROOT, 'docs/amo/listing.md'), 'utf8');
  // コードブロックは、要約の日本語・英語、説明の日本語・英語の順
  const blocks = [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  if (blocks.length !== 4) throw new Error(`listing.md のコードブロックが 4 つではない（${blocks.length}）`);
  const [summaryJa, summaryEn, descriptionJa, descriptionEn] = blocks;
  // スクリーンショットの表：| `ファイル` | 日本語 | English |
  const screenshots = [...text.matchAll(/^\| `([^`]+\.png)` \| (.+?) \| (.+?) \|$/gm)]
    .map(([, file, ja, en]) => ({ file, caption: { ja, 'en-US': en } }));
  if (screenshots.length === 0) throw new Error('listing.md にスクリーンショットの表がない');
  return {
    fields: {
      name: { ja: NAME, 'en-US': NAME },
      summary: { ja: summaryJa, 'en-US': summaryEn },
      description: { ja: descriptionJa, 'en-US': descriptionEn },
    },
    screenshots,
  };
}

// AMO の API の認証（JWT。1 回ごとに作る）
function authorization() {
  const key = process.env.WEB_EXT_API_KEY;
  const secret = process.env.WEB_EXT_API_SECRET;
  if (!key || !secret) throw new Error('AMO の API キーがありません。環境変数 WEB_EXT_API_KEY と WEB_EXT_API_SECRET を設定してください');
  const b64url = (b) => Buffer.from(b).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: key, jti: crypto.randomUUID(), iat: now, exp: now + 60 }));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `JWT ${head}.${body}.${sig}`;
}

// AMO は、短いあいだに書き換えを続けると 429（混んでいる）を返し、「あと何秒で使えるか」を知らせる。そのぶん待ってやり直す。
// 待ち時間が長いとき（1 日の上限に当たったときなど）は、待たずに止めて、いつ実行し直せばよいかを知らせる
const MAX_WAIT_SECONDS = 600;
async function call(method, url, body) {
  for (let attempt = 1; ; attempt++) {
    const headers = { Authorization: authorization() };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API}/${url}`, { method, headers, body: payload });
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const seconds = Number(res.headers.get('retry-after') ?? text.match(/(\d+) seconds?/)?.[1] ?? 60);
      if (seconds > MAX_WAIT_SECONDS) {
        const at = new Date(Date.now() + seconds * 1000).toLocaleString();
        throw new Error(`AMO の書き換えの上限に当たりました。${at} ごろ以降に、もう一度実行してください（${method} ${url}）`);
      }
      console.log(`  （${new Date().toLocaleTimeString()} AMO が混んでいるので ${seconds} 秒待ちます）`);
      await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${url} が失敗しました（${res.status}）: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }
}

const pngFile = (file) => new Blob([fs.readFileSync(file)], { type: 'image/png' });
const short = (s) => (s ? `${[...s].length} 文字「${s.replace(/\n/g, ' ').slice(0, 40)}…」` : '（なし）');

async function show(addon, listing) {
  console.log('■ 今のページ');
  for (const field of ['summary', 'description']) {
    for (const lang of ['ja', 'en-US']) console.log(`  ${field}（${lang}）: ${short(addon[field]?.[lang])}`);
  }
  console.log(`  アイコン: ${addon.icon_url ?? '（なし）'}`);
  console.log(`  スクリーンショット: ${addon.previews.length} 枚`);
  for (const p of addon.previews) console.log(`    - ${p.caption?.ja ?? p.caption?.['en-US'] ?? '（説明なし）'}`);
  console.log('\n■ 書き換える内容');
  for (const field of ['summary', 'description']) {
    for (const lang of ['ja', 'en-US']) console.log(`  ${field}（${lang}）: ${short(listing.fields[field][lang])}`);
  }
  console.log(`  アイコン: ${path.relative(ROOT, ICON)}`);
  const { keep, remove } = matchPreviews(addon.previews, listing.screenshots, process.argv[3] === 'replace');
  console.log(`  スクリーンショット: ${listing.screenshots.length} 枚（載っている ${keep.size} 枚は残し、${remove.length} 枚を消す）`);
  for (const s of listing.screenshots) console.log(`    - ${s.file}：${keep.has(s.file) ? 'そのまま' : '載せる'}（${s.caption.ja}）`);
}

async function apply(addon, listing, { onlyScreenshots, replace }) {
  if (!onlyScreenshots) {
    console.log('\n■ 名前・要約・説明を書き換える');
    await call('PATCH', `addons/addon/${ADDON}/`, listing.fields);
    console.log('■ アイコンを載せる');
    const icon = new FormData();
    icon.append('icon', pngFile(ICON), 'icon-128.png');
    await call('PATCH', `addons/addon/${ADDON}/`, icon);
  }
  console.log('■ スクリーンショットを合わせる');
  const { keep, remove } = matchPreviews(addon.previews, listing.screenshots, replace);
  for (const p of remove) {
    await call('DELETE', `addons/addon/${ADDON}/previews/${p.id}/`);
    console.log(`  消した：${p.caption?.ja ?? '（説明なし）'}`);
  }
  for (const [i, s] of listing.screenshots.entries()) {
    const kept = keep.get(s.file);
    if (kept) {
      // 載っているものは、並び順と英語の説明だけ合わせる（変わっていなければ何もしない）
      if (kept.position !== i || kept.caption?.['en-US'] !== s.caption['en-US']) {
        await call('PATCH', `addons/addon/${ADDON}/previews/${kept.id}/`, { caption: s.caption, position: i });
      }
      console.log(`  そのまま：${s.file}`);
      continue;
    }
    const form = new FormData();
    form.append('image', pngFile(path.join(SCREENSHOTS, s.file)), s.file);
    const created = await call('POST', `addons/addon/${ADDON}/previews/`, form);
    // 説明は翻訳つきの項目なので、画像を載せたあとに JSON で入れる
    await call('PATCH', `addons/addon/${ADDON}/previews/${created.id}/`, { caption: s.caption, position: i });
    console.log(`  載せた：${s.file}（${new Date().toLocaleTimeString()}）`);
  }
}

// 載っているスクリーンショットと listing.md の表を、日本語の説明で対応づける。
// 対応するものは残し（同じ説明が 2 枚以上あれば 1 枚だけ）、それ以外は消す。replace なら、すべて消して載せ直す
function matchPreviews(previews, screenshots, replace) {
  const keep = new Map();
  const remove = [];
  for (const p of previews) {
    const s = !replace && screenshots.find((x) => x.caption.ja === p.caption?.ja && !keep.has(x.file));
    if (s) keep.set(s.file, p);
    else remove.push(p);
  }
  return { keep, remove };
}

const listing = readListing();
for (const s of listing.screenshots) {
  if (!fs.existsSync(path.join(SCREENSHOTS, s.file))) throw new Error(`スクリーンショットがない: ${s.file}（npm run amo:screenshots で作る）`);
}
const addon = await call('GET', `addons/addon/${ADDON}/`);
await show(addon, listing);
if (process.argv[2] === 'apply') {
  await apply(addon, listing, { onlyScreenshots: process.argv[3] === 'screenshots', replace: process.argv[3] === 'replace' });
  const after = await call('GET', `addons/addon/${ADDON}/`);
  console.log(`\n書き換えました。スクリーンショット ${after.previews.length} 枚。ページ：${after.url}`);
} else {
  console.log('\n（表示だけです。書き換えるときは npm run listing:firefox -- apply）');
}
