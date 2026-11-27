// 浏览器 ESM 垫片：vendor/clipper-6.4.2.js 以经典脚本加载后
// 会把 ClipperLib 挂到全局（UMD 的浏览器分支），这里转成默认导出。
// index.html 必须先通过 <script src="../vendor/clipper-6.4.2.js"> 加载它。
export default globalThis.ClipperLib;
