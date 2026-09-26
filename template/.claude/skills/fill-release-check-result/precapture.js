// 撮る前にページを「無地」にして、その状態を検証する。
// mcp__claude-in-chrome__javascript_tool で流し、返った JSON の ok が true になるまで撮らない。
//
// ■ なぜ必要か
// エビデンスに写る「カーソル」はポインタの矢印ではない。screencapture は -C を
// 付けない限り矢印を写さない (実測: 同一矩形を -C 有/無で撮って差分 0)。
// 写るのは次の 2 つ:
//   (1) `:hover` の行ハイライト — 表の行が rgb(247,247,247) の帯になる
//   (2) テキストキャレット — フォーカスされた入力欄で点滅する縦線
//
// ■ OS のカーソルを動かしても (1) は消えない
// Chrome は **レンダラに最後に届いたマウスイベントの座標**で `:hover` を決める。
// CGWarpMouseCursorPosition は mousemove を発生させないので、カーソルを画面の
// 隅へ飛ばしても hover は貼り付いたまま残る (実測: 退避前後のスクショが画素単位で一致)。
// 剥がすには **実際にマウスイベントを送る**しかない。つまり撮影の直前に
//   mcp__claude-in-chrome__computer { action: "hover", coordinate: [<無反応な座標>] }
// を打つ。このスクリプトはその後の状態を検証する側。
//
// ■ 無反応な座標の選び方
// ページ内の何も反応しない余白。表より下の白地か、コンテナ左右の余白。
// ヘッダーやナビの上は :hover が付くので避ける。
(() => {
  // キャレットを消す。フォーカスが body 以外にあると入力欄に縦線が残る
  const ae = document.activeElement;
  if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
  if (window.getSelection) window.getSelection().removeAllRanges();

  // :hover の鎖。容器より下 (対話要素) が残っていたらハイライトが写る
  const chain = [...document.querySelectorAll(':hover')];
  const BAD = new Set(['TR', 'TD', 'TH', 'BUTTON', 'A', 'INPUT', 'SELECT',
                       'TEXTAREA', 'LABEL', 'OPTION', 'LI']);
  const hoverBad = chain.filter((e) => BAD.has(e.tagName)).map((e) => e.tagName);

  // 表の行に地色が付いていないか (hover の実測色は rgb(247,247,247))
  const tinted = [...document.querySelectorAll('tbody tr')]
    .map((tr, i) => {
      const c = tr.cells[0] ? getComputedStyle(tr.cells[0]).backgroundColor : '';
      return { i, c };
    })
    .filter(({ c }) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'rgb(255, 255, 255)');

  const focused = document.activeElement ? document.activeElement.tagName : null;
  return JSON.stringify({
    ok: hoverBad.length === 0 && tinted.length === 0 && (focused === 'BODY' || focused === null),
    hoverBad,                      // 空でなければ hover を無反応な座標へ移して撮り直す
    tintedRows: tinted,            // 空でなければ行ハイライトが残っている
    focused,                       // BODY 以外ならキャレットが残っている
    hoverChain: chain.map((e) => e.tagName),
    scrollY: window.scrollY,
    viewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    docHeight: document.documentElement.scrollHeight,
  });
})();
