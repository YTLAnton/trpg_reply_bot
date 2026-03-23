# 開發計畫：PCM 切段 + ffmpeg.wasm 雙路策略

> **目標**：可靠地處理最長 9 小時的 M4A 錄音，不依賴 Gemini 的續接或時間範圍指令。
> **核心策略**：依錄音時長自動選路；短錄音走 PCM decode → 7 分鐘 WAV 切段（快、穩），長錄音走 ffmpeg.wasm 瀏覽器切段（不解碼、不 OOM）。

---

## 為什麼之前的方案都失敗？

| 方案 | 失敗原因 |
|------|----------|
| PCM 解碼切段（大檔） | M4A 整檔解碼後 PCM 約 2GB+，瀏覽器 OOM |
| Files API + 時間範圍 prompt | Gemini 無視時間範圍，每段都從 00:00 辨識，造成 N 份重複 |
| Files API + Gemini 續接 | Gemini 常從頭重來（regression），已在 commit `032967c` 放棄 |
| Files API 單次請求 | Gemini 在重複性高的段落進入無限輸出迴圈（如大量「我」的搶話），35 分鐘後掛掉；且 5 小時以上會超出 65,536 token 輸出上限 |

**核心結論**：
- **Files API 在任何形式下對長錄音均不可靠**。無論是單次請求、時間範圍提示、或續接，Gemini 處理長檔案時都可能出現幻覺或無限迴圈。
- **唯一可靠方式**：將音訊切成短小、完全獨立的片段，讓 Gemini 各自辨識後自行合併。
- **穩定基準**：commit `236dfa5` 的 PCM decode → 7 分鐘 WAV chunk → inline_data 路徑，已在 1 小時錄音上驗證可靠。

---

## 兩條路徑總覽

```
檔案選取
    ↓
讀取檔案大小
    ↓
    ├─ ≤ 20MB（小檔）────────────────────→ 路徑 0：base64 inline_data（現有，不動）
    │
    ├─ > 20MB 且估計時長 ≤ 2 小時 ────→ 路徑 1：PCM decode → 7 分鐘 WAV → inline_data
    │   （估算：20MB≈1hr，因此 2hr≈40MB）    └─ 穩定基準，恢復 236dfa5 邏輯
    │
    └─ > 20MB 且估計時長 > 2 小時 ────→ 路徑 2：ffmpeg.wasm -c copy 切段 → inline_data
        （或路徑 1 記憶體不足 fallback）        └─ 不解碼，不 OOM

模型選擇（路徑 0 / 1 / 2 皆適用）
    Flash（預設）│ Pro（路徑 D）
```

> **為什麼 2 小時是分界點**：PCM decode 的記憶體消耗約為 `時長(秒) × 16000採樣 × 2bytes ≈ 2hr × 7200s × 32KB/s = ~230MB`，多數瀏覽器可接受。3 小時以上則超過 400MB，風險增加。保守取 2 小時作為切換點。

---

## 路徑 1：PCM decode → WAV 切段（恢復 236dfa5 邏輯）

### 適用條件
- 檔案 > 20MB
- 估計時長 ≤ 2 小時

### 流程
```
1. AudioContext.decodeAudioData(file)
2. resample → 16kHz mono Float32Array
3. 每 7 分鐘切一段（CHUNK_DURATION_SEC = 420）
4. pcmToWav(chunk) → Blob
5. base64 → runStage1(base64, 'audio/wav') inline_data
6. 各段結果自行合併（直接 join，因各段不重疊）
```

### 已知限制
- 整檔 PCM decode 仍需在記憶體中持有全部 PCM，2 小時約 230MB，邊界值需測試
- 若瀏覽器 OOM，自動 fallback 路徑 2

### 程式碼狀態
- `236dfa5` 版本的 `runStage1Chunked` 即此邏輯，需從該 commit 恢復
- 相關函式：`pcmToWav`, `CHUNK_DURATION_SEC = 420`, `CHUNK_SAMPLE_RATE = 16000`

---

## 路徑 2：ffmpeg.wasm 瀏覽器切段

### 適用條件
- 估計時長 > 2 小時
- 或路徑 1 瀏覽器 OOM fallback

### 核心概念
ffmpeg 的 `-c copy` 是 **container-level remux**，不解碼音訊：

```
原始 M4A（259MB，9小時）
    ↓ ffmpeg -c copy -ss 0 -t 600
seg_000.m4a（約 4.8MB，10分鐘，有完整 header）
seg_001.m4a（約 4.8MB，10分鐘）
...（共 54 段）
    ↓ 每段 base64 → runStage1(base64, 'audio/mp4') inline_data 路徑
    ↓ 各段獨立辨識，自行合併
```

記憶體消耗：約 **檔案大小 + 單段大小**（遠低於 PCM 方案的 2GB+）

### ffmpeg.wasm 選用版本
- 使用 **`@ffmpeg/core`（單執行緒版）**
- 不需要 `SharedArrayBuffer`，**不需要修改 server CORS 設定**
- 比多執行緒版慢，但對於 remux（不解碼）操作速度仍可接受

### CDN 載入（lazy，首次使用才載入）
```javascript
const FFMPEG_CDN = {
  core: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
  wasm: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
};
```

### 切段參數
```javascript
const FFMPEG_SEGMENT_SEC = 10 * 60;    // 每段 10 分鐘
const FFMPEG_OVERLAP_SEC = 30;          // 前後各 30 秒 overlap，避免邊界漏字
```

> **Overlap 處理**：各段辨識後合併時，用時間戳偵測重複行並去除。
> 若 Gemini 在段落開頭輸出了前一段末尾的內容，時間戳會重疊，可比對截斷。

### 切段指令（每段）
```
ffmpeg -i input.m4a -ss [start] -t [duration+overlap] -c copy seg_NNN.m4a
```

- `start`：段落開始秒數（第一段 = 0，後續段落 = N×600 - 30 秒）
- `duration+overlap`：600 + 30 = 630 秒（最後一段不加後 overlap）

### 各段辨識
- 每段 ≤ 20MB → 走現有 `runStage1(base64, mimeType)` inline_data 路徑
- 不需要 Files API，不需要等待 ACTIVE 狀態

### 合併邏輯
```
seg_000 逐字稿：語者1 00:00 ... 語者2 10:28（overlap 內容）
seg_001 逐字稿：語者2 10:03（重複）... 語者1 20:45

合併時：掃描 seg_001 開頭，找到時間戳 < seg_000 最後時間戳的行 → 全部截掉
結果：語者1 00:00 ... 語者2 10:28 \n 語者2 10:31 ... 語者1 20:45
```

---

## 路徑 D：模型選擇

現有的模型下拉選單（Flash / Pro / 自訂）**直接套用**於路徑 0、1、2，不需要額外修改。

---

## 常數定義

```javascript
const SMALL_FILE_THRESHOLD  = 20 * 1024 * 1024;  // ≤20MB → 路徑 0（不動）
const PCM_MAX_DURATION_MIN  = 120;                 // ≤120分 → 路徑 1（PCM），否則路徑 2
const CHUNK_DURATION_SEC    = 7 * 60;              // 路徑 1：每段 7 分鐘
const CHUNK_SAMPLE_RATE     = 16000;               // 路徑 1：16kHz mono
const FFMPEG_SEGMENT_SEC    = 10 * 60;             // 路徑 2：每段 10 分鐘
const FFMPEG_OVERLAP_SEC    = 30;                  // 路徑 2：overlap 30 秒
```

---

## 新增函式清單

| 函式 | 說明 |
|------|------|
| `loadFfmpeg()` | lazy 載入 ffmpeg.wasm，回傳 FFmpeg instance（singleton） |
| `splitAudioWithFfmpeg(file, onProgress)` | 切段，回傳 `Blob[]`（各段 M4A） |
| `mergeTranscriptsByTimestamp(transcripts)` | 依時間戳去重合併各段逐字稿（路徑 2 用） |
| `runStage1Chunked(file)` | **主控函式**，依檔案大小與時長自動選路 0、1 或 2 |

路徑 1 的 `pcmToWav`, `CHUNK_DURATION_SEC`, `CHUNK_SAMPLE_RATE` 從 `236dfa5` 恢復。

---

## 修改範圍

| 位置 | 動作 |
|------|------|
| `runStage1Chunked(file)` | 改為三路選擇邏輯（0 / 1 / 2） |
| `pcmToWav` 等相關函式 | 從 `236dfa5` 恢復，路徑 1 使用 |
| `SEGMENT_MINUTES`（現有） | 替換為新常數組 |
| 進度顯示 | 路徑 2 需顯示：載入 ffmpeg → 切段進度 → 辨識第 N/M 段 |
| `<head>` | 加入 ffmpeg.wasm UMD script（lazy，不阻塞首屏） |
| Files API 相關函式 | **全部移除**（`uploadAudioToGemini`, `waitForFileActive`, `deleteGeminiFile`, `runStage1WithFileSegment`, `FILES_API_BASE`, `FILES_API_MANAGE`, `SEGMENT_MINUTES`） |

---

## 潛在風險與對策

| 風險 | 對策 |
|------|------|
| 路徑 1 OOM（2 小時邊界） | try/catch OOM → 自動 fallback 路徑 2 |
| ffmpeg.wasm CDN 載入失敗 | 顯示錯誤，提示使用者檢查網路或改用路徑 1（手動強制） |
| `-c copy` 在某些 M4A 編碼切點不準 | overlap 30 秒吸收誤差；合併時時間戳去重 |
| overlap 去重失效（Gemini 沒有輸出時間戳） | fallback：直接 join，不截斷（寧可有少量重複，不漏內容） |
| ffmpeg.wasm 在某些瀏覽器不支援 | 偵測後顯示提示；建議使用 Chrome |

---

## 開發順序

1. **恢復穩定基準**：從 `236dfa5` 還原 `runStage1Chunked` 的 PCM 邏輯，移除 Files API 相關程式碼
2. **加入路徑選擇邏輯**：`runStage1Chunked` 依 `SMALL_FILE_THRESHOLD` / `PCM_MAX_DURATION_MIN` 分流
3. **準備 ffmpeg.wasm**：確認 CDN 可正常載入，寫 `loadFfmpeg()` 測試
4. **`splitAudioWithFfmpeg`**：切一個已知時長的 M4A，確認各段有完整 header 且可播放
5. **`mergeTranscriptsByTimestamp`**：用 mock 資料測試時間戳去重邏輯
6. **整合路徑 2**：路徑 2 接上辨識與合併
7. **進度 UI**：ffmpeg 載入、切段、辨識進度分別顯示
8. **端對端測試**：短錄音（路徑 1）、長錄音（路徑 2）各一次
