# TRPG 團錄轉寫器：音訊處理方式完整演進歷程

> 最後更新：2026-03-24（更新：ffmpeg.wasm 升級至 0.12.x，移除 Service Worker 方案）
> 本文件盤點所有嘗試過的音訊上傳與處理策略、失敗原因，以及每次的調整方向。

---

## 一、總覽時間軸

```
Phase 1：初版 base64（小檔可用）
    ↓
Phase 2：PCM decode → WAV 切段（中型檔可用，大型 OOM）
    ↓
Phase 3a：Files API + Gemini 自我續接（Regression 失敗）
    ↓
Phase 3b：Files API + 時間分段 prompt（Gemini 無視時間範圍）
    ↓
Phase 3c：Files API + 整檔單次請求（無限迴圈/超 token）
    ↓
Phase 4a：PCM 切段（≤2hr）+ ffmpeg.wasm 0.11.6（>2hr）→ SharedArrayBuffer 問題
    ↓
Phase 5：PCM 切段（≤2hr）+ Service Worker COOP/COEP + ffmpeg.wasm（>2hr）
    ↓
Phase 6：加入時間戳的全局偏移計算（HH:MM:SS）並完美對齊，修復分割去重防線
    ↓
Phase 7（最新）：ffmpeg.wasm 升級至 0.12.x + Blob URL 載入，移除 Service Worker
```

---

## 二、各方案詳細記錄

### 方案 1：base64 inline_data 直接上傳（小型檔）

| 項目 | 說明 |
|------|------|
| **對應 commit** | `d6c7030`（first commit） |
| **適用檔案** | ≤ 20MB |
| **核心做法** | `FileReader` 將整個音訊檔案轉為 base64，直接放入 `inline_data` 欄位送 Gemini |
| **狀態** | ✅ 仍為現行「路徑 0」，保留不動 |
| **失敗原因** | Gemini inline_data 上限約 20MB；大型 M4A（TRPG 錄音常達數百 MB）完全無法處理 |
| **調整方向** | 超過 20MB 的大型檔案需要其他方案 |

---

### 方案 2：PCM decode → 16kHz WAV → 7 分鐘切段

| 項目 | 說明 |
|------|------|
| **對應 commit** | `236dfa5`（穩定基準） |
| **適用檔案** | > 20MB，估計時長 ≤ 2 小時 |
| **核心做法** | `AudioContext.decodeAudioData()` 整檔解碼 → `OfflineAudioContext` 重採樣至 16kHz mono → 每 7 分鐘切一段 WAV → 各自 base64 → inline_data 送 Gemini |
| **狀態** | ✅ 仍為現行「路徑 1」，恢復使用 |
| **失敗原因** | M4A 整檔 PCM 解碼後佔用記憶體極大（2 小時約 230MB，9 小時約 2GB+），瀏覽器 OOM crash |
| **調整方向** | 對超過 2 小時的錄音，需要完全不解碼的切段方案 |

---

### 方案 3a：Files API + Gemini 自我續接

| 項目 | 說明 |
|------|------|
| **對應 commit** | `032967c`（已刪除） |
| **適用檔案** | 大型（任意長度） |
| **核心做法** | Resumable Upload 上傳整檔至 Gemini Files API → 取得 fileUri → 叫 Gemini 辨識 → 遇到 `finishReason=STOP/MAX_TOKENS` 再叫它「接著說」 |
| **狀態** | ❌ 已在 commit `032967c` 刪除放棄 |
| **失敗原因** | Gemini 的「續接」完全不可靠：有時從頭重來（regression）、有時重複前段內容、有時跳過段落，行為不可預測 |
| **調整方向** | 改為讓每段完全獨立，不依賴 Gemini 自我接續 |

---

### 方案 3b：Files API + 時間分段 prompt（每段 10 分鐘）

| 項目 | 說明 |
|------|------|
| **對應計畫** | `_PM/archived/PLAN_files_api.md` |
| **適用檔案** | 大型（任意長度） |
| **核心做法** | Resumable Upload 上傳整檔 → 取得 fileUri → 每段 prompt 明確指定時間範圍「只辨識第 N 到第 M 分鐘」→ 各段分別送 generateContent |
| **狀態** | ❌ 實作後測試失敗，已封存 |
| **失敗原因** | Gemini **無視時間範圍指令**：每次均從 `00:00` 開始辨識，造成 N 份內容幾乎相同的重複逐字稿，而非各段獨立 |
| **調整方向** | Gemini 無法透過 prompt 限制辨識範圍；需要在送出前就真正把音訊切成獨立片段 |

---

### 方案 3c：Files API + 整檔單次請求

| 項目 | 說明 |
|------|------|
| **對應計畫** | `_PM/archived/PLAN_files_api.md`（風險評估段落） |
| **適用檔案** | 大型（任意長度） |
| **核心做法** | 上傳整檔 → 單次 generateContent 請求，讓 Gemini 一口氣辨識整段錄音 |
| **狀態** | ❌ 測試失敗 |
| **失敗原因** | ① Gemini 在重複性高的段落（如大量短促喊話）進入**無限輸出迴圈**，約 35 分鐘後超時掛掉；② 5 小時以上錄音超出 **65,536 token 輸出上限**，強制截斷 |
| **調整方向** | Files API 在任何形式下對長錄音均不可靠，放棄所有 Files API 路線 |

---

### 方案 4a（失敗）：PCM 切段（≤2hr）+ ffmpeg.wasm 0.11.6（>2hr）雙路策略

| 項目 | 說明 |
|------|------|
| **對應計畫** | `_PM/PLAN_abd_transcribe.md` |
| **對應 commit** | `236dfa5` 恢復路徑 1 + 新增路徑 2 |
| **狀態** | ❌ 路徑 2 執行時拋出 `SharedArrayBuffer is not defined` |

#### 三條路徑（4a 版）

| 路徑 | 觸發條件 | 方法 | 記憶體消耗 | 備註 |
|------|----------|------|------------|------|
| **路徑 0** | 檔案 ≤ 20MB | base64 inline_data 直接送 | 極低 | 最原始路線，完全可靠 |
| **路徑 1** | 20MB < 檔案，時長 ≤ 2hr | PCM decode → 16kHz WAV → 7 分鐘切段 | ~230MB | `236dfa5` 穩定邏輯，已驗證 |
| **路徑 2** | 時長 > 2hr，或路徑 1 OOM | ffmpeg.wasm `-c copy` → 10 分鐘 M4A 切段 | 極低（不解碼）| ❌ 失敗：`SharedArrayBuffer is not defined` |

**失敗原因**：ffmpeg.wasm `0.11.6` 的 `ffmpeg-core.js` 由 Emscripten 編譯，內部仍需 `SharedArrayBuffer`（多執行緒記憶體共享）。瀏覽器在缺少 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp` 這兩個 HTTP Header 時，一律將 `SharedArrayBuffer` 停用。

以 `file://` 本地開啟 HTML 或透過未設定上述 Header 的伺服器服務，均會觸發此錯誤。

---

## 三、反覆學到的技術教訓

| 問題 | 關鍵發現 |
|------|----------|
| **Gemini 時間範圍 prompt 無效** | `file_data` 模式下，Gemini 會辨識整個音訊檔，無法透過 text prompt 限制範圍 |
| **Gemini 長檔無限輸出迴圈** | 超過 1.5 小時的重複性音訊（大量對話）容易觸發，5 小時以上必然截斷 |
| **Gemini 續接不可靠** | `finishReason=STOP` 後要求繼續，Gemini 有時重頭來，有時跳過段落 |
| **PCM 解碼記憶體** | M4A 解碼後 PCM 約為 `時長(s) × 32KB/s`；9 小時 ≈ 2GB+，必定 OOM |
| **ffmpeg.wasm 版本選擇** | `@ffmpeg/ffmpeg@0.11.6` 不論搭配 `core` 還是 `core-st`，都會嘗試載入 `ffmpeg-core.worker.js`；`core-st` 套件根本不含此檔，導致 404 + CORS 報錯。**正確做法**：升級至 `0.12.x`，預設 single-threaded，用 Blob URL 載入，無 SAB、無 CORS 問題 |
| **SharedArrayBuffer 封鎖** | 現代瀏覽器（Spectre 防護）預設停用 `SharedArrayBuffer`，需伺服器回傳 `COOP: same-origin` + `COEP: require-corp` Header 才能啟用。**不要依賴 Service Worker 注入這些 Header**——SW 在 GitHub Pages 上時序不可靠，舊版快取難以清除，且 COEP 還可能阻擋 Google Fonts 等第三方資源 |
| **Service Worker COOP/COEP 注入** | 理論上可行，實際上在 GitHub Pages 環境中不穩定：首次開啟無 SAB → SW 安裝 → 需要 reload → 若 SW 未正確 claim 頁面仍無效；更新 SW 後舊版快取可能繼續攔截。**結論：能不用 SW 就不用** |
| **唯一可靠原則** | 音訊必須在送 Gemini 前就切成完全獨立的短小片段；Gemini 端的任何切分/續接指令均不可信賴 |

---

### 方案 5（已淘汰）：Service Worker COOP/COEP + ffmpeg.wasm 0.11.6

| 項目 | 說明 |
|------|------|
| **狀態** | ❌ 已被方案 7 取代 |
| **核心做法** | 在頁面啟動時註冊 `sw.js` Service Worker；SW 攔截所有 fetch 回應並注入 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`，使瀏覽器解封 `SharedArrayBuffer`；路徑 0/1/2 邏輯完全不變 |
| **前置條件** | 需以 `http://localhost` 或 `https://` 方式開啟頁面（`file://` 無法使用 Service Worker）；初次開啟會自動重整一次以激活 SW |
| **淘汰原因** | GitHub Pages 環境中 SW 注入 COOP/COEP 不可靠：SW 首次激活需重整、舊版 SW 快取後即使部署新版也可能繼續攔截請求。實測在 GitHub Pages 上長錄音功能仍然失效。 |

---

### 方案 6（已穩定）：加入絕對時間偏移 (Offset) 強化重疊去重演算法

| 項目 | 說明 |
|------|------|
| **狀態** | ✅ 已修復並部署 |
| **失敗與痛點** | 方案 5 雖解決了大檔切段與記憶體崩潰，但在合倂時發生嚴重的「鬼打牆」(重複拼接)。原因在於 Gemini 辨識切段時，每一個切段的時間戳都從 `00:00` 重新開始，導致防重複合併邏輯 (`mergeTranscriptsByTimestamp`) 的嚴格時間遞增判斷全盤失效。如果錄音長度超過1小時，單純使用 MM:SS 也很容易導致進位混亂。 |
| **核心解法** | **不依賴 Gemini 做時間位移算數。**我們在取得各片段前保留「絕對起始偏移秒數」(例如第二段起於 570秒)。待 Gemini 吐出該片段原始文字後，前端呼叫 `shiftTranscriptTimestamps` 對逐字稿中所有 `語者N MM:SS` 進行字串解析與秒數疊加，最終強制格式化為 **`HH:MM:SS`** (`00:09:30`)。 |
| **實際效果** | 將每一段逐字稿回歸「絕對時間」座標！有了 HH:MM:SS 墊底之後，合併系統再次能完美識別出前段結尾與後段開頭的重疊點 (overlap)。大幅度根絕了長語音轉換中的「無限重複拼接(鬼打牆)」噩夢，也補齊了時間的「小時」區塊。 |

---

### 方案 7（當前）：ffmpeg.wasm 0.12.x + Blob URL 載入，移除 Service Worker

| 項目 | 說明 |
|------|------|
| **狀態** | ✅ 當前版本 |
| **對應日期** | 2026-03-24 |
| **觸發原因** | 方案 5 的 Service Worker 在 GitHub Pages 上不可靠（見方案 5 淘汰原因）；嘗試改用 `@ffmpeg/core-st@0.11.0`（單執行緒版），發現 `@ffmpeg/ffmpeg@0.11.6` 仍會嘗試載入 `ffmpeg-core.worker.js`，而 `core-st` 套件根本不含此檔 → 404 無 CORS header → 報錯 |
| **核心做法** | ① 升級至 `@ffmpeg/ffmpeg@0.12.6` + `@ffmpeg/core@0.12.6`（預設 single-threaded，不需 `SharedArrayBuffer`）② 以自製 `_toBlobURL()` 先將 CDN 上的 `ffmpeg-core.js` 與 `ffmpeg-core.wasm` fetch 下來，轉為 `blob://` URL 再傳給 `ff.load()`；Worker 從 `blob://` 載入，完全繞過 CORS 限制 ③ 移除 Service Worker，改為主動 unregister 舊版 SW，若舊 SW 仍在控制頁面則強制 reload 確保乾淨狀態 |
| **API 差異（0.11.x → 0.12.x）** | `createFFmpeg()` → `new FFmpeg()`；`ff.load()` → `ff.load({ coreURL, wasmURL })`；`ff.FS('writeFile')` → `ff.writeFile()`；`ff.FS('readFile')` → `ff.readFile()`；`ff.FS('unlink')` → `ff.deleteFile()`；`ff.run(...args)` → `ff.exec(args)` |
| **CDN** | jsdelivr（`cdn.jsdelivr.net/npm/`），CORS 保證比 unpkg 更穩定 |
| **三條路徑** | 同方案 4a，路徑 0/1 不變，路徑 2 改用 0.12.x API |

#### 方案 7 解決的核心問題

| 問題 | 舊方案（5/6）的處理 | 方案 7 的處理 |
|------|---------------------|---------------|
| `SharedArrayBuffer` 不可用 | SW 注入 COOP/COEP（不可靠） | 改用 single-threaded core，根本不需要 SAB |
| Worker 跨域 CORS | SW 注入 CORP header | Blob URL 讓 Worker 從同 origin 載入，無 CORS 問題 |
| GitHub Pages 限制 | 依賴 SW（SW 在 GH Pages 不穩定） | 純前端邏輯，無需任何伺服器 header 設定 |
| 舊版 SW 快取殘留 | 無對策 | 頁面啟動時主動 unregister 所有 SW；若 SW 當前仍控制頁面則強制 reload |

---

## 四、當前方案的潛在風險與對策

| 風險 | 對策 |
|------|------|
| 路徑 1 在 2 小時邊界 OOM | `try/catch` 捕捉 OOM → 自動 fallback 路徑 2 |
| ffmpeg.wasm CDN 載入失敗 | 顯示錯誤訊息，提示使用者確認網路連線 |
| `_toBlobURL` fetch 失敗（網路問題） | 拋出明確錯誤訊息，提示重試 |
| `-c copy` 在某些 M4A 切點不準 | 前後 30 秒 overlap + 時間戳去重合併吸收誤差 |
| overlap 去重失效（Gemini 未輸出時間戳） | fallback 直接 join，寧可少量重複，不漏內容 |
| ffmpeg.wasm 在特定瀏覽器不支援 | 偵測後顯示提示，建議使用 Chrome |

---

*相關文件：[PLAN_abd_transcribe.md](./PLAN_abd_transcribe.md)、[archived/PLAN_files_api.md](./archived/PLAN_files_api.md)*
