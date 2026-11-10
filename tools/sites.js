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
  youtube: {
    // ライブ配信で絞り込んだ検索結果（sp はライブ配信の絞り込み条件）
    list: 'https://www.youtube.com/results?search_query=live&sp=EgJAAQ%253D%253D',
    // 検索結果のリンクには &pp=... などが付くので、動画 ID だけを取り出して URL を組み立て直す
    links: (as) => as.map((a) => a.href.match(/^https:\/\/www\.youtube\.com\/watch\?v=([\w-]+)/)?.[1])
      .filter(Boolean).map((id) => `https://www.youtube.com/watch?v=${id}`),
  },
};

// 判定に使う video 要素。広告用などの見えない要素を避けて、表示サイズがいちばん大きいものを選ぶ
export const PICK_VIDEO = `[...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
