/**
 * sw.js — Service Worker
 * 用途：為所有回應注入 COOP + COEP Header，以解封 SharedArrayBuffer
 * （ffmpeg.wasm 0.11.6 的 WebAssembly 核心需要 SharedArrayBuffer）
 *
 * 參考：https://developer.chrome.com/blog/enabling-shared-array-buffer/
 */

const CACHE_NAME = 'trpg-sw-v1';

self.addEventListener('install', (event) => {
  // 立即接管，不等待舊的 SW 終止
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 立即控制所有 client，不等待下次導覽
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只處理 GET / HEAD，跳過 POST 等，避免影響 Gemini API 呼叫的 body
  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // 若非成功回應（如 CDN 錯誤），直接轉發，不加 Header
        if (!response || !response.ok) return response;

        // 複製 response（原始 response 只能被消費一次）
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
        newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
        newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

        return new Response(response.body, {
          status:     response.status,
          statusText: response.statusText,
          headers:    newHeaders,
        });
      })
      .catch(() => {
        // 網路失敗時直接透傳（不要因 SW 而讓使用者看到額外錯誤）
        return fetch(request);
      })
  );
});
