/* 撮ったスクショが「いまの画面」かを確かめる目印を置く/消す。
 *
 * 使い方 (javascript_tool でこのファイルの中身をそのまま実行する):
 *   __claudePaintProbe(true)   → 目印を置き {rgb, rect} を返す
 *   __claudePaintProbe(false)  → 目印を消す
 *
 * なぜ要るか (2026-01-15 に踏んだ事故):
 * Chrome のウィンドウのサーフェスが凍結し、**DOM は生きているのに画面だけが
 * CDP アタッチ前の 1 枚を出し続ける**ことがある。このとき
 *   * screencapture はエラーにならず、その古い 1 枚を返す
 *   * locate.py の固定ヘッダー照合は通ってしまう (中身が同じ画面なので)
 *   * タブ帯の文字も document.title を変えても変わらない
 *   * Page.captureScreenshot はタイムアウトし、document.visibilityState は hidden
 * 再読み込み・リサイズ・最小化→復元・タブ往復では復帰せず、Chrome の再起動が要る。
 * 気付かないまま撮り続けると、全フレームが同じ 1 枚になったエビデンスができる。
 *
 * 目印は毎回ランダムな色にする。**前回の色が写っていても新しい色でなければ
 * 凍結**と分かるようにするため。位置は viewport の左端中央 (固定ヘッダー帯の
 * 外側) にして、locate.py のヘッダー照合を壊さない。
 */
window.__claudePaintProbe = function (on) {
  const ID = 'claude-paint-probe';
  const old = document.getElementById(ID);
  if (old) old.remove();
  if (!on) return { removed: true };
  const rgb = [0, 1, 2].map(() => 20 + Math.floor(Math.random() * 216));
  const w = 64, h = 64;
  const x = 0, y = Math.max(0, Math.round(innerHeight / 2) - h / 2);
  const el = document.createElement('div');
  el.id = ID;
  el.style.cssText = [
    'position:fixed', `left:${x}px`, `top:${y}px`,
    `width:${w}px`, `height:${h}px`,
    `background:rgb(${rgb.join(',')})`,
    'z-index:2147483647', 'pointer-events:none', 'margin:0', 'border:0',
  ].join(';');
  document.documentElement.appendChild(el);
  return { rgb, rect: { x, y, w, h }, vp: [innerWidth, innerHeight] };
};
__claudePaintProbe(true);
