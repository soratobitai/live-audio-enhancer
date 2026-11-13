// 自動検証で使う、対応サイトごとの配信の探し方（Chrome と Firefox の検証で共通）。
// list のページを開き、links で配信ページの URL を集める
export const SITES = {
  nico: {
    list: 'https://live.nicovideo.jp/',
    links: (as) => as.map((a) => a.href.split('?')[0]).filter((u) => /\/watch\/lv\d+$/.test(u)),
  },
  kick: {
    list: 'https://kick.com/',
    // チャンネルページは /<チャンネル名>。カテゴリなど1階層のページを除く
    links: (as) => as.map((a) => a.href.split('?')[0])
      .filter((u) => /^https:\/\/kick\.com\/[\w-]+$/.test(u))
      .filter((u) => !/\/(browse|following|categories|category|events|leaderboards|kickbounties|search)$/.test(u)),
  },
  twitch: {
    list: 'https://www.twitch.tv/directory/all',
    // チャンネルページは /<チャンネル名>。一覧や設定など1階層のページを除く
    links: (as) => as.map((a) => a.href.split('?')[0])
      .filter((u) => /^https:\/\/www\.twitch\.tv\/\w+$/.test(u))
      .filter((u) => !/\/(directory|search|settings|downloads|jobs|turbo|p|store|subscriptions|drops|wallet|inventory|friends|messages|login|signup|prime)$/.test(u)),
  },
  tver: {
    // 見逃し配信のエピソードページ（/episodes/<ID>）
    list: 'https://tver.jp/',
    links: (as) => as.map((a) => a.href.split('?')[0]).filter((u) => /^https:\/\/tver\.jp\/episodes\/\w+$/.test(u)),
    // 初めて再生するときにアンケート（誕生年・性別・郵便番号）が出て、回答するまで再生されない。
    // 検証では回答せずに閉じ、スクリプトから再生する（閉じたあとに再生ボタンを押すと、またアンケートが出る）
    dismiss: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '閉じる')?.click()`,
  },
  abema: {
    // 放送中のチャンネルのページ（/now-on-air/<チャンネル>）
    list: 'https://abema.tv/',
    links: (as) => as.map((a) => a.href.split('?')[0]).filter((u) => /^https:\/\/abema\.tv\/now-on-air\/[\w-]+$/.test(u)),
  },
  youtube: {
    // ライブ配信で絞り込んだ検索結果（sp はライブ配信の絞り込み条件）
    list: 'https://www.youtube.com/results?search_query=live&sp=EgJAAQ%253D%253D',
    // 検索結果のリンクには &pp=... などが付くので、動画 ID だけを取り出して URL を組み立て直す
    links: (as) => as.map((a) => a.href.match(/^https:\/\/www\.youtube\.com\/watch\?v=([\w-]+)/)?.[1])
      .filter(Boolean).map((id) => `https://www.youtube.com/watch?v=${id}`),
  },
};

// URL のサイト。URL を指定して検証するときも、サイトごとの手順（dismiss）を使うため
export const siteOf = (url) => Object.values(SITES).find((s) => new URL(s.list).host === new URL(url).host);

// URL のサイトの名前（nico など）。拡張の設定はサイトごとなので、ポップアップの画面を開くときに ?site= で渡す
export const siteKeyOf = (url) => Object.keys(SITES).find((k) => SITES[k] === siteOf(url));

// 判定に使う video 要素。広告用などの見えない要素を避けて、表示サイズがいちばん大きいものを選ぶ
export const PICK_VIDEO = `[...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 動画が実際に再生されているか（1秒のあいだに再生位置が進んだか）。
// 中身のない video（放送前のニコ生など）に play() を呼ぶと、再生されていなくても paused が false になるので、paused だけでは判定しない
export async function isPlaying(page) {
  const position = () => page.evaluate(`(() => { const v = ${PICK_VIDEO}; return v && !v.paused ? v.currentTime : null; })()`);
  const before = await position();
  await sleep(1000);
  const after = await position();
  return before !== null && after !== null && after > before;
}

// 動画の再生が始まるまで、最長 timeout ミリ秒待つ。再生が始まったら true を返す。
// TVer は、トップページを開いたあとだと、play() から数秒止まったままになることがある（広告の準備と考えている）
export async function waitPlaying(page, timeout) {
  for (let t = 0; t < timeout; t += 1000) {
    if (await isPlaying(page)) return true;
  }
  return false;
}

export async function findBroadcasts(browser, site) {
  const page = await browser.newPage();
  try {
    await page.goto(site.list, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.href })));
    return [...new Set(site.links(hrefs))];
  } finally {
    await page.close();
  }
}
