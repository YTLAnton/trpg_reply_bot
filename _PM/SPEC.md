# TRPG 團錄轉寫器 — 開發文件 v2.0

> **v2.0 變更摘要**：移除 Claude API，全部改用 Gemini API。
> Stage 1 語音辨識、Stage 3 團錄整理均呼叫 Gemini 1.5 Pro。
> 未來若需要更高文學品質，只需將 Stage 3 的 endpoint 換回 Claude。

---

### Phase 狀態總覽

| Phase | 目標 | 項目 | 當前狀態 |
|-------|------|------|----------|
| **Phase 1** | 核心功能可用 | 基本 UI 框架與狀態切換 | ✅ 完成 |
| | | 設定頁（API Key + localStorage） | ✅ 完成 |
| | | 音訊上傳與 base64 轉換 | ✅ 完成 |
| | | Gemini Stage 1 語音辨識 | ✅ 完成 |
| | | 角色確認 UI | ✅ 完成 |
| | | Gemini Stage 3 團錄整理 | ✅ 完成 |
| | | Markdown / txt 下載 | ✅ 完成 |
| **Phase 2** | 完整功能 | docx 生成與下載 | ✅ 完成 |
| | | 對話格式下載 | ✅ 完成 |
| | | 進度條動畫完整實作 | ✅ 完成 |
| | | 錯誤處理完善 | ✅ 完成 |
| | | 重新整理（保留逐字稿）功能 | ✅ 完成 |
| **Phase 3** | 體驗優化 | Markdown 預覽渲染（marked.js） | ⬜ 未開始 |
| | | 預設角色表多組設定 | ⬜ 未開始 |
| | | 逐字稿手動編輯功能 | ⬜ 未開始 |

---

## 一、專案概述

### 目標
一個單一 HTML 檔案的本地應用程式。使用者在瀏覽器中開啟後，上傳 TRPG 錄音檔，系統自動透過 Gemini API 進行語音辨識與團錄整理，最終提供多格式下載。

### 技術限制與原則
- **單一檔案**：所有邏輯、樣式、UI 寫在一個 `index.html`
- **純前端**：無後端伺服器、無 Node.js、無建置工具
- **本地執行**：使用者在瀏覽器直接開啟檔案即可使用
- **API Key 安全**：Key 僅存在 `localStorage`，只在用戶端呼叫 API，不經過任何第三方伺服器
- **外部 CDN**：僅允許從 `cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`unpkg.com` 載入函式庫

---

## 二、整體流程

```
[使用者上傳錄音檔]
        ↓
[Stage 1] Gemini API — 語音辨識
  輸入：音訊 base64
  輸出：原始逐字稿（含 Speaker A/B/C 標籤）
        ↓
[Stage 2] 使用者確認角色對照表
  UI：顯示辨識到的說話者，讓使用者對應角色名稱
  可使用預設設定或臨時修改
        ↓
[Stage 3] Gemini API — 團錄整理
  輸入：逐字稿 + 角色對照表 + 團錄風格 Prompt
  輸出：四種格式的團錄內容
        ↓
[Stage 4] 下載輸出
  提供 .md / .txt / .docx / 對話格式.txt 四個下載按鈕
```

---

## 三、UI 結構與畫面流程

### 畫面狀態（State Machine）

| 狀態 | 畫面 |
|------|------|
| `setup` | 初始設定：填入 Gemini API Key、設定預設角色表 |
| `upload` | 上傳頁：拖拉或點擊上傳錄音檔 |
| `processing` | 處理中：顯示各階段進度 |
| `confirm` | 角色確認：讓使用者確認/修改說話者對應 |
| `result` | 結果頁：預覽團錄、提供下載 |

### 頁面佈局
```
┌─────────────────────────────────────────┐
│  TRPG 團錄轉寫器          [⚙ 設定]     │  ← 固定頂部 Header
├─────────────────────────────────────────┤
│                                         │
│           主要內容區域                   │  ← 根據狀態切換
│                                         │
└─────────────────────────────────────────┘
```

### 各狀態 UI 細節

**setup 狀態**
- Gemini API Key 輸入欄（type=password，有顯示/隱藏切換）
- 預設角色對照表編輯區：
  - 列表形式，每列 = 一個角色
  - 欄位：說話者代號（Speaker A）/ 角色名稱 / 備註（可選）
  - 可新增、刪除列
- 「儲存設定」按鈕（寫入 localStorage）
- 「開始使用」按鈕（跳至 upload 狀態）

**upload 狀態**
- 大型拖拉區域（Drag & Drop），同時支援點擊選擇
- 支援格式提示：mp3、m4a、wav、ogg、flac
- 檔案大小限制提醒（Gemini 限制：inline base64 上限約 20MB；超過需提示）
- 上傳後顯示檔案名稱、大小
- 「開始處理」按鈕

**processing 狀態**
進度條設計（線性步驟，每步驟有狀態圖示）：

```
  ● 準備音訊檔案         ✓ 完成
  ● Gemini 語音辨識      ⟳ 處理中...
  ○ 辨識結果確認         — 等待中
  ○ Gemini 團錄整理      — 等待中
  ○ 生成下載檔案         — 等待中
```

每個步驟顯示：
- 步驟名稱
- 狀態圖示（等待 / 進行中 / 完成 / 錯誤）
- 進行中步驟顯示 spinner 動畫
- 錯誤時顯示紅色錯誤訊息 + 「重試」按鈕

**confirm 狀態**
在 Stage 1 完成後，自動進入此狀態：

- 標題：「請確認說話者對應」
- 顯示 Gemini 辨識出的說話者清單（例：Speaker A、Speaker B、Speaker C）
- 每個說話者旁邊有文字輸入欄，預填來自 localStorage 的預設值
- 若辨識到比預設更多的說話者，自動新增空白列
- 逐字稿預覽區（可捲動，讓使用者確認辨識品質）
- 「確認並產生團錄」按鈕 → 進入 Stage 3

**result 狀態**
- 分頁切換預覽（Markdown / 純文字 / 對話格式）
- 預覽區（`<pre>` 或簡易 Markdown 渲染）
- 四個下載按鈕：
  - 📥 下載 Markdown (.md)
  - 📥 下載純文字 (.txt)
  - 📥 下載 Word (.docx)
  - 📥 下載對話格式 (.txt)
- 「重新處理」按鈕（回到 upload 狀態）
- 「重新整理（不重新辨識）」按鈕（保留逐字稿，重新跑 Stage 3）

---

## 四、API 整合規格

兩個 Stage 均使用同一個 Gemini endpoint，差別只在 prompt 和是否包含音訊。

**共用設定**
```
Endpoint: https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent
Method: POST
Header: x-goog-api-key: {GEMINI_KEY}
        Content-Type: application/json
```

---

### 4-1. Stage 1 — 語音辨識

**請求 Body**：
```json
{
  "contents": [{
    "parts": [
      {
        "inline_data": {
          "mime_type": "audio/mp3",
          "data": "{base64_encoded_audio}"
        }
      },
      {
        "text": "請將這段錄音完整轉成逐字稿。這是一段桌上角色扮演遊戲（TRPG）的錄音，有多位玩家與主持人（GM）在說話。\n\n格式要求：\n1. 每次換人說話就換一行\n2. 每行開頭加上說話者標籤，格式為 [Speaker A]、[Speaker B] 等，依照聲線區分\n3. 保留所有發言，包含骰子判定、規則討論、角色扮演對話\n4. 如果有明顯的環境雜音或無意義音節（嗯、啊）可省略，但不要省略有意義的內容\n5. 在最後一行加上：SPEAKERS: A,B,C（列出所有出現的說話者代號）"
      }
    ]
  }],
  "generationConfig": {
    "temperature": 0.1
  }
}
```

> `temperature: 0.1` — 語音辨識要求高準確度，低溫度減少 Gemini 自由發揮。

**回應處理**：
- 取出 `candidates[0].content.parts[0].text`
- 解析最後一行的 `SPEAKERS:` 標記，取得說話者清單
- 將逐字稿本體存入 `state.rawTranscript`

---

### 4-2. Stage 3 — 團錄整理

音訊不需再次傳送，只傳逐字稿文字。

**請求 Body**：
```json
{
  "contents": [{
    "parts": [{
      "text": "{完整 prompt，見下方}"
    }]
  }],
  "generationConfig": {
    "temperature": 0.7
  },
  "systemInstruction": {
    "parts": [{
      "text": "你是一位專業的 TRPG 團錄整理師。你的任務是將玩家錄音的逐字稿整理成文學性強、易於閱讀的團錄。\n\n團錄風格要求：\n- 以小說式的第三人稱敘事描寫場景與動作\n- 角色的對白用粗體「**角色名**」格式標示說話者\n- 保留重要的規則判定結果（如骰子成功/失敗）\n- 剪去明顯的 OOC（Out of Character）閒聊，例如討論吃飯、廁所、閒聊等\n- 如果有明顯的空白停頓或重複，適當精簡\n- 維持事件的時序與因果關係\n- 輸出繁體中文"
    }]
  }
}
```

> `temperature: 0.7` — 團錄整理需要一定創意與文學性，適度提高溫度。

**User Prompt 內容**（插入 `contents[0].parts[0].text`）：
```
以下是這次 TRPG 團的逐字稿，以及說話者對照表。

【說話者對照表】
{character_map}

【逐字稿】
{transcript}

請根據以上資料，輸出以下四種格式，用 ===FORMAT:xxx=== 分隔：

===FORMAT:MARKDOWN===
（Markdown 格式的完整團錄，使用 ## 標記章節，**粗體**標記角色名）

===FORMAT:PLAIN===
（純文字格式，無 Markdown 標記）

===FORMAT:DIALOGUE===
（對話格式，每行為「角色名：台詞或動作」，適合快速閱讀）

===FORMAT:END===
```

**character_map 格式範例**：
```
Speaker A = 伍玖步（木精靈德魯伊，玩家：小明）
Speaker B = 阿拉絲琳（半精靈術士，玩家：小花）
Speaker C = GM（遊戲主持人）
```

**回應解析**：
- 取出 `candidates[0].content.parts[0].text`
- 用正規表示式分割 `===FORMAT:xxx===` 區塊：
```javascript
const sections = {};
const regex = /===FORMAT:(\w+)===([\s\S]*?)(?====FORMAT:|$)/g;
let match;
while ((match = regex.exec(responseText)) !== null) {
  sections[match[1]] = match[2].trim();
}
// sections.MARKDOWN, sections.PLAIN, sections.DIALOGUE
```

**錯誤處理**：

| HTTP 狀態 | 顯示訊息 |
|-----------|----------|
| 429 | API 請求頻率超限，請稍後重試 |
| 400 | 音訊格式不支援或請求格式錯誤 |
| 403 | API Key 無效或權限不足 |
| 其他 | 顯示原始錯誤訊息 + 狀態碼 |

---

## 五、檔案生成規格

### 5-1. Markdown (.md)
```javascript
const blob = new Blob([sections.MARKDOWN], { type: 'text/markdown;charset=utf-8' });
triggerDownload(blob, 'session_log.md');
```

### 5-2. 純文字 (.txt)
```javascript
const blob = new Blob([sections.PLAIN], { type: 'text/plain;charset=utf-8' });
triggerDownload(blob, 'session_log.txt');
```

### 5-3. 對話格式 (.txt)
```javascript
const blob = new Blob([sections.DIALOGUE], { type: 'text/plain;charset=utf-8' });
triggerDownload(blob, 'session_log_dialogue.txt');
```

### 5-4. Word (.docx)
使用 `docx.js` CDN 版本（`https://unpkg.com/docx@8.5.0/build/index.js`）在瀏覽器端生成。

**注意**：瀏覽器端必須用 `Packer.toBlob()` 而非 `Packer.toBuffer()`（Node.js 限定）。

**文件結構**：
- 第一頁：標題（檔名 + 生成日期）
- 正文：將 MARKDOWN 內容轉換為 docx 元素
  - `## 文字` → Heading 2
  - `**角色名**` → Bold TextRun
  - 一般段落 → 普通 Paragraph
- 頁面設定：A4、邊距 2cm

**Markdown 轉 docx 邏輯**：
```javascript
function markdownToDocxParagraphs(markdown) {
  const lines = markdown.split('\n');
  const children = [];

  lines.forEach(line => {
    if (line.startsWith('## ')) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun(line.replace('## ', ''))]
      }));
    } else if (line.trim() === '') {
      children.push(new Paragraph({ text: '' }));
    } else {
      // 解析行內粗體 **文字**
      const parts = line.split(/(\*\*[^*]+\*\*)/);
      const runs = parts.map(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return new TextRun({ text: part.slice(2, -2), bold: true });
        }
        return new TextRun(part);
      });
      children.push(new Paragraph({ children: runs }));
    }
  });

  return children;
}
```

**生成與下載**：
```javascript
const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } // 2cm
      }
    },
    children: markdownToDocxParagraphs(sections.MARKDOWN)
  }]
});

Packer.toBlob(doc).then(blob => {
  triggerDownload(blob, 'session_log.docx');
});
```

**共用下載函式**：
```javascript
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

---

## 六、資料狀態管理

### 應用程式狀態結構
```javascript
const state = {
  config: {
    geminiKey: '',
    defaultCharacters: [
      // { speakerId: 'A', characterName: '', playerName: '' }
    ]
  },

  currentState: 'setup', // 'setup' | 'upload' | 'processing' | 'confirm' | 'result'

  audioFile: null,
  audioBase64: '',
  audioMimeType: '',

  rawTranscript: '',
  detectedSpeakers: [],  // ['A', 'B', 'C']
  characterMap: {},      // { 'A': '伍玖步（木精靈）', 'B': '阿拉絲琳' }

  outputs: {
    markdown: '',
    plain: '',
    dialogue: '',
  },

  progress: {
    steps: [
      { id: 'prepare',  label: '準備音訊檔案',    status: 'pending' },
      { id: 'gemini1',  label: 'Gemini 語音辨識', status: 'pending' },
      { id: 'confirm',  label: '辨識結果確認',     status: 'pending' },
      { id: 'gemini2',  label: 'Gemini 團錄整理', status: 'pending' },
      { id: 'generate', label: '生成下載檔案',     status: 'pending' },
    ]
    // status: 'pending' | 'processing' | 'done' | 'error'
  }
};
```

### localStorage 持久化
```javascript
// 儲存（只存 config）
localStorage.setItem('trpg_config', JSON.stringify(state.config));

// 載入（應用程式啟動時）
const saved = localStorage.getItem('trpg_config');
if (saved) state.config = JSON.parse(saved);
```

---

## 七、音訊處理

### 檔案轉 Base64
```javascript
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

### MIME Type 對應
```javascript
const mimeTypes = {
  'mp3':  'audio/mp3',
  'mp4':  'audio/mp4',
  'm4a':  'audio/mp4',
  'wav':  'audio/wav',
  'ogg':  'audio/ogg',
  'flac': 'audio/flac',
  'aac':  'audio/aac',
};
```

### 檔案大小限制
Gemini inline base64 上限為 **20MB**（原始檔案大小）。超過時顯示：
「檔案過大（> 20MB），建議先使用音訊軟體壓縮後再上傳。」

---

## 八、樣式設計指引

### 色彩
```css
--color-bg:       #1A1A2E;  /* 主背景 */
--color-surface:  #16213E;  /* 卡片背景 */
--color-primary:  #4A3F6B;  /* 主色（深紫） */
--color-accent:   #C9A84C;  /* 強調色（金） */
--color-text:     #E0E0E0;  /* 主文字 */
--color-success:  #4CAF50;
--color-error:    #F44336;
--color-muted:    #9E9E9E;
```

### 字型
```css
/* 標題、團錄內文 */
font-family: 'Noto Serif TC', 'Georgia', serif;

/* UI 元素 */
font-family: 'Noto Sans TC', 'Arial', sans-serif;
```
從 Google Fonts 載入（`fonts.googleapis.com`）。

### 進度步驟圖示
- 等待中：`○`（灰色）
- 處理中：CSS spinner 動畫
- 完成：`✓`（綠色）
- 錯誤：`✗`（紅色）

---

## 九、錯誤處理策略

| 錯誤情境 | 處理方式 |
|----------|----------|
| API Key 未填 | 設定頁即時驗證，不允許進入下一步 |
| 音訊格式不支援 | 上傳時檢查副檔名，顯示支援格式列表 |
| 音訊檔超過 20MB | 上傳時檢查大小，顯示壓縮建議 |
| Stage 1 Gemini 失敗 | 顯示錯誤 + 「重試」按鈕，保留已上傳音訊 |
| Stage 3 Gemini 失敗 | 顯示錯誤 + 「重試」按鈕，**保留逐字稿**（不重跑 Stage 1） |
| 逐字稿無 SPEAKERS 行 | 顯示警告，讓使用者手動填寫說話者 |
| 格式區塊解析失敗 | 將完整回應放入 Markdown 欄，其他格式顯示「解析失敗，請使用 Markdown 版本」 |

---

## 十、檔案結構

```
index.html    ← 整個應用程式（單一檔案）
```

### `index.html` 內部結構
```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <!-- meta、title -->
  <!-- Google Fonts (Noto Serif TC, Noto Sans TC) -->
  <!-- docx.js: https://unpkg.com/docx@8.5.0/build/index.js -->
  <style>/* 所有樣式 */</style>
</head>
<body>
  <header><!-- Logo + 設定按鈕 --></header>
  <main>
    <section id="view-setup">      <!-- API Key + 角色預設表 --></section>
    <section id="view-upload">     <!-- 拖拉上傳區 --></section>
    <section id="view-processing"> <!-- 進度條 --></section>
    <section id="view-confirm">    <!-- 說話者對應確認 --></section>
    <section id="view-result">     <!-- 預覽 + 下載按鈕 --></section>
  </main>
  <script>
    // 1. 狀態物件與 localStorage 初始化
    // 2. UI 切換函式 (showView)
    // 3. 音訊處理 (fileToBase64, mimeTypes)
    // 4. Gemini Stage 1 — 語音辨識
    // 5. confirm 狀態渲染
    // 6. Gemini Stage 3 — 團錄整理
    // 7. 回應解析 (parseFormatBlocks)
    // 8. 檔案生成與下載 (markdownToDocxParagraphs, triggerDownload)
    // 9. 進度條更新 (setStepStatus)
    // 10. 事件監聽器綁定
  </script>
</body>
</html>
```

---

## 十一、開發優先順序

### Phase 1（核心功能可用）
1. 基本 UI 框架與狀態切換
2. 設定頁（API Key 輸入 + localStorage）
3. 音訊上傳與 base64 轉換
4. Gemini Stage 1 語音辨識
5. 角色確認 UI
6. Gemini Stage 3 團錄整理
7. Markdown / txt 下載

### Phase 2（完整功能）
8. docx 生成與下載
9. 對話格式下載
10. 進度條動畫完整實作
11. 錯誤處理完善
12. 「重新整理（保留逐字稿）」功能

### Phase 3（體驗優化）
13. Markdown 預覽渲染（使用 marked.js from CDN）
14. 預設角色表的多組設定（支援不同固定團隊）
15. 逐字稿手動編輯功能（送出 Stage 3 前可微調）

---

## 十二、已知限制與注意事項

1. **音訊大小**：Gemini inline base64 限制約 20MB。超過需實作 Gemini File API 上傳流程（v1.0 不含）。
2. **Token 限制**：錄音過長時逐字稿可能超過 Gemini context window。建議 v1.0 先以 2 小時錄音為上限，超過時顯示警告。
3. **docx.js 瀏覽器版**：使用 `Packer.toBlob()` 而非 `Packer.toBuffer()`（後者為 Node.js 限定）。
4. **API Key 安全**：Key 存於 localStorage，僅適合個人/小組本地使用，不適合部署為公開服務。
5. **未來升級路徑**：若 Gemini 的團錄文學品質不足，只需將 Stage 3 的 fetch 目標換成 Claude endpoint（`https://api.anthropic.com/v1/messages`），並加上 `anthropic-dangerous-direct-browser-access: true` header 即可，其餘邏輯不變。