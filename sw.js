/**
 * sw.js — 舊版 Service Worker（已廢棄）
 *
 * 舊版用此 SW 注入 COOP/COEP header 以解封 SharedArrayBuffer（給 ffmpeg.wasm 用）。
 * 現已改用 @ffmpeg/core-st（single-threaded），不再需要 SharedArrayBuffer 也不需要此 SW。
 * 此檔保留是為了讓已安裝舊 SW 的使用者自動完成清除。
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => self.clients.claim())
  );
});
