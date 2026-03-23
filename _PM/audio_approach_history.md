# TRPG 團錄轉寫器：音訊處理方式完整演進歷程

> 最後更新：2026-03-23（更新：SharedArrayBuffer 問題記錄 + Service Worker 方案）
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
Phase 5（當前）：PCM 切段（≤2hr）+ Service Worker COOP/COEP + ffmpeg.wasm（>2hr）
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
| **ffmpeg.wasm 版本選擇** | `@ffmpeg/ffmpeg@0.12.x` 內部啟動跨域 Worker，`unpkg.com` CDN CORS 限制導致失敗；`0.11.6` 雖無 Worker，但 Emscripten 核心仍需 `SharedArrayBuffer` |
| **SharedArrayBuffer 封鎖** | 現代瀏覽器（Spectre 防護）預設停用 `SharedArrayBuffer`，需伺服器回傳 `COOP: same-origin` + `COEP: require-corp` Header 才能啟用；`file://` 無法設定 Header，必須走 localhost/HTTPS |
| **唯一可靠原則** | 音訊必須在送 Gemini 前就切成完全獨立的短小片段；Gemini 端的任何切分/續接指令均不可信賴 |

---

### 方案 5（當前）：Service Worker COOP/COEP + ffmpeg.wasm 0.11.6

| 項目 | 說明 |
|------|------|
| **狀態** | 🔧 當前版本 |
| **核心做法** | 在頁面啟動時註冊 `sw.js` Service Worker；SW 攔截所有 fetch 回應並注入 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`，使瀏覽器解封 `SharedArrayBuffer`；路徑 0/1/2 邏輯完全不變 |
| **前提條件** | 需以 `http://localhost` 或 `https://` 方式開啟頁面（`file://` 無法使用 Service Worker）；初次開啟會自動重整一次以激活 SW |
| **三條路徑** | 同方案 4a，路徑 0/1 不變，路徑 2 `SharedArrayBuffer` 現已可用 |

---

## 四、當前方案的潛在風險與對策

| 風險 | 對策 |
|------|------|
| 路徑 1 在 2 小時邊界 OOM | `try/catch` 捕捉 OOM → 自動 fallback 路徑 2 |
| ffmpeg.wasm CDN 載入失敗 | 顯示錯誤訊息，提示使用者確認網路連線 |
| Service Worker 未啟用（用 file:// 開啟）| 偵測到 `SharedArrayBuffer` 不可用時顯示警告，提示改用 localhost 開啟 |
| SW 首次啟用需要重整 | 頁面偵測到 SW 剛安裝完成後自動重整，使用者無感知 |
| `-c copy` 在某些 M4A 切點不準 | 前後 30 秒 overlap + 時間戳去重合併吸收誤差 |
| overlap 去重失效（Gemini 未輸出時間戳） | fallback 直接 join，寧可少量重複，不漏內容 |
| ffmpeg.wasm 0.11.6 在特定瀏覽器不支援 | 偵測後顯示提示，建議使用 Chrome |

---

*相關文件：[PLAN_abd_transcribe.md](./PLAN_abd_transcribe.md)、[archived/PLAN_files_api.md](./archived/PLAN_files_api.md)*

---

> ⚠️ **使用前提**：請務必以 `http://localhost` 或 `https://` 方式開啟 `index.html`，不可直接雙擊用 `file://` 開啟。可在專案目錄下執行 `python -m http.server 8080` 後前往 `http://localhost:8080`。
