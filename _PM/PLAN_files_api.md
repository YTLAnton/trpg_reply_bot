# 開發計畫：改用 Gemini Files API + 時間分段辨識

> **目標**：解決大型 M4A 檔案（>20MB）在瀏覽器解碼時 OOM 的問題。
> **核心策略**：不在瀏覽器解碼音訊，改為直接上傳原始檔案至 Gemini Files API，再以 prompt 指定時間區間逐段辨識。

---

## 為什麼這次不會有上次 Files API 的問題？

上次的 Files API 實作（已在 commit `032967c` 刪除）採用「**續接模式**」：
- 叫 Gemini 辨識整個檔案
- 遇到 `finishReason=STOP/MAX_TOKENS` 就叫它「接著說」
- 問題：Gemini 有時從頭重來（regression）、有時重疊、行為不可預測

**這次改用「時間分段 prompt」**：
- 每個請求明確告訴 Gemini：「**只辨識第 N 到第 M 分鐘**」
- 每段完全獨立，不依賴 Gemini 的自我續接
- 邏輯跟現在的 PCM 切段一樣可預測，只是不需要在瀏覽器解碼

---

## 新流程（替換現有 `runStage1Chunked`）

```
[大型檔案（>20MB）]
        ↓
Step 1. 用 HTMLAudioElement 取得音訊總時長（讀 metadata，不 decode PCM）
        ↓
Step 2. 計算分段數（每段 SEGMENT_MINUTES 分鐘）
        ↓
Step 3. Resumable Upload 原始檔案至 Gemini Files API → 取得 fileUri
        ↓
Step 4. 逐段呼叫 generateContent，每段 prompt 指定時間範圍
        ↓
Step 5. 拼接各段逐字稿（同現有邏輯）
        ↓
Step 6. 刪除 Gemini 上的暫存檔（DELETE /v1beta/files/{name}）
```

小型檔案（≤20MB）維持現有路徑（base64 inline_data），不動。

---

## 技術規格

### 常數

```javascript
const SEGMENT_MINUTES = 10;          // 每段辨識 10 分鐘（可調整）
const FILES_API_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const FILES_API_MANAGE = 'https://generativelanguage.googleapis.com/v1beta/files';
```

> **為何選 10 分鐘**：上次 7 分鐘是 PCM 記憶體限制，現在沒有此限制。
> 10 分鐘對 Gemini 來說足夠短（不會 MAX_TOKENS），又減少 API 請求次數。

---

### Step 1：取得音訊時長

用 `HTMLAudioElement` 讀 metadata，完全不解碼音訊：

```javascript
function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration); // 秒
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取音訊時長'));
    };
    audio.src = url;
  });
}
```

記憶體消耗：可忽略（只讀 header）。

---

### Step 2：Resumable Upload

```javascript
async function uploadAudioToGemini(file, onProgress) {
  const key = state.config.geminiKey;
  const mimeType = guessMimeType(file.name);

  // 初始化上傳
  const initRes = await fetch(`${FILES_API_BASE}?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': file.size,
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { displayName: file.name } }),
  });
  if (!initRes.ok) throw new Error(`上傳初始化失敗 (${initRes.status})`);
  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');

  // 上傳檔案本體（含進度回呼）
  const fileUri = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        resolve(data.file?.uri);
      } catch { reject(new Error('上傳回應解析失敗')); }
    };
    xhr.onerror = () => reject(new Error('上傳網路錯誤'));
    xhr.send(file);
  });

  if (!fileUri) throw new Error('未取得檔案 URI');

  // 等待 Gemini 處理完成（狀態從 PROCESSING → ACTIVE）
  await waitForFileActive(fileUri);
  return { fileUri, mimeType };
}
```

**等待檔案啟用**（這是上次有但邏輯正確的部分，保留）：

```javascript
async function waitForFileActive(fileUri) {
  const key = state.config.geminiKey;
  const fileName = fileUri.split('/').pop(); // 取 files/xxxxxxxx 的 ID
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`${FILES_API_MANAGE}/${fileName}?key=${key}`);
    const data = await res.json();
    if (data.state === 'ACTIVE') return;
    if (data.state === 'FAILED') throw new Error('Gemini 檔案處理失敗');
  }
  throw new Error('等待 Gemini 檔案啟用超時');
}
```

---

### Step 3：時間分段辨識

每個請求用 `file_data` 取代 `inline_data`，並在 prompt 指定時間範圍：

```javascript
async function runStage1WithFileSegment(fileUri, mimeType, startMin, endMin, segIndex, totalSegs) {
  const timeRange = `${formatTime(startMin * 60)} 到 ${formatTime(Math.min(endMin, totalDuration) * 60)}`;
  const body = {
    contents: [{
      parts: [
        { file_data: { mime_type: mimeType, file_uri: fileUri } },
        { text: STAGE1_PROMPT_TIMED(timeRange) }
      ]
    }],
    generationConfig: { temperature: 0.1 }
  };
  return await geminiRequest(body);
}

function formatTime(totalSec) {
  const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
```

**時間分段 prompt**（在現有 `STAGE1_PROMPT` 基礎上加一行限制）：

```javascript
const STAGE1_PROMPT_TIMED = (timeRange) =>
  `請只辨識這段錄音中 ${timeRange} 的部分，其他時間請完全忽略。\n\n` + STAGE1_PROMPT;
```

---

### Step 4：主控函式

替換現有 `runStage1Chunked(file)`：

```javascript
async function runStage1Chunked(file) {
  // 1. 取得時長
  setStepStatus('gemini1', 'processing', '讀取音訊資訊…');
  const durationSec = await getAudioDuration(file);
  const totalMins = durationSec / 60;
  const numSegs = Math.ceil(totalMins / SEGMENT_MINUTES);

  // 2. 上傳檔案
  setStepStatus('gemini1', 'processing', `上傳檔案至 Gemini（${formatBytes(file.size)}）…`);
  const { fileUri, mimeType } = await uploadAudioToGemini(file, (pct) => {
    setStepStatus('gemini1', 'processing', `上傳中 ${Math.round(pct * 100)}%…`);
  });

  // 3. 逐段辨識
  const allTranscripts = [];
  for (let i = 0; i < numSegs; i++) {
    const startMin = i * SEGMENT_MINUTES;
    const endMin = Math.min((i + 1) * SEGMENT_MINUTES, totalMins);
    setStepStatus('gemini1', 'processing', `辨識第 ${i + 1}/${numSegs} 段（${Math.floor(startMin)}–${Math.ceil(endMin)} 分）…`);
    const transcript = await runStage1WithFileSegment(fileUri, mimeType, startMin, endMin, i, numSegs);
    allTranscripts.push(transcript);
  }

  // 4. 清理暫存檔
  deleteGeminiFile(fileUri).catch(() => {}); // 背景執行，失敗不影響結果

  return allTranscripts.map(t => t.trimEnd()).filter(t => t.trim()).join('\n');
}
```

**刪除 Gemini 暫存檔**（Files API 會自動在 48 小時後刪除，但主動清理較好）：

```javascript
async function deleteGeminiFile(fileUri) {
  const key = state.config.geminiKey;
  const fileName = fileUri.split('/').slice(-2).join('/'); // files/xxxxxxxx
  await fetch(`${FILES_API_MANAGE}/${fileName}?key=${key}`, { method: 'DELETE' });
}
```

---

## 要改動的範圍

| 位置 | 動作 |
|------|------|
| `runStage1Chunked(file)` | **整個替換**為新邏輯 |
| `pcmToWav` | 可刪除（不再需要） |
| `CHUNK_DURATION_SEC`, `CHUNK_SAMPLE_RATE` | 可刪除 |
| `STAGE1_PROMPT` | **保留**，新增 `STAGE1_PROMPT_TIMED` 包裝函式 |
| `fileToBase64` | 保留（小型檔案路徑仍用） |
| 新增函式 | `getAudioDuration`, `uploadAudioToGemini`, `waitForFileActive`, `runStage1WithFileSegment`, `deleteGeminiFile`, `formatTime` |

**小型檔案（≤20MB）路徑完全不動。**

---

## 潛在風險與對策

| 風險 | 對策 |
|------|------|
| Gemini 忽略時間範圍 prompt，辨識全部音訊 | 可接受（只是多做，結果仍正確）；若回應過長觸發 MAX_TOKENS，再縮短 `SEGMENT_MINUTES` |
| Gemini 在時間邊界附近漏辨識幾秒 | 各段加 30 秒 overlap（如 0–10:30、10:00–20:30），然後拼接時截掉重複 |
| `getAudioDuration` 對某些格式失敗 | fallback 改用 `file.size / (128 * 1024 / 8)` 估算（假設 128kbps） |
| 上傳大檔時使用者等太久 | 進度條顯示上傳百分比（已在 `onProgress` 回呼中處理） |
| CORS 問題（Files API 跨域） | Gemini Files API 已明確支援瀏覽器直接呼叫，應無問題；若有問題同現有路徑需要代理 |

---

## 開發順序

1. `getAudioDuration` — 最小的獨立功能，先確認瀏覽器能讀到 M4A 時長
2. `uploadAudioToGemini` + `waitForFileActive` — 上傳流程，獨立測試確認拿到 fileUri
3. `runStage1WithFileSegment` — 單段辨識，先測試一個固定時間範圍
4. 主控 `runStage1Chunked` 整合 + 進度顯示
5. `deleteGeminiFile`
6. 刪除舊的 PCM 相關程式碼（`pcmToWav`, 舊 `runStage1Chunked`, 相關常數）
