# CLAUDE.md：課金師（Tutor）專案交接文件

> 本檔案供 Claude Code 在本機接手作業時自動讀取，內容整理自雲端工作階段的完整對話。
> 回覆使用者時請用**繁體中文**。

---

## 1. 使用者需求（原始對話）

使用者的原話：
> 「https://desirable-silver-gvze7fst.edgeone.dev/ 幫我複製並且持續修正，確保雲端同步跟資安風險控管。我使用 firebase 當作雲端資料庫，edgeone 作為網址，你需要什麼直接跟我說。」

之後的請求：
> 「幫我將這邊的對話做成一個 claude 可以完整讀取的檔案，我要轉到本機作業。」（也就是本檔案）

**持續性任務**：持續修正網站，重點放在 (1) 雲端同步正確性 (2) 資安風險控管。

---

## 2. 專案概要

- **產品**：「課金師」，一個家教排課、學費結算、師生雙向學習的單頁網站（老師端與學生端）。
- **前端**：單一檔案 `index.html`（約 5,200 行，含 HTML、Tailwind CDN 與一大段內嵌 JS，JS 包在 IIFE 裡）。
- **託管**：騰訊 EdgeOne Pages，網址 `https://desirable-silver-gvze7fst.edgeone.dev`。
- **後端**：Firebase 專案 `tutor-f907b`（Auth + Firestore），SDK 從 `https://www.gstatic.com/firebasejs/11.6.1/` 動態 import。
- **Git**：repo `hunterchou2006-stack/Tutor`，工作分支 `claude/firebase-sync-security-gju74v`（已推送）。
  - Commit 1 `a5fd044`：原始網站 baseline。原始碼中的帳號密碼已改成 `[REDACTED]`。
  - Commit 2 `0aba7ef`：完整重寫雲端同步與資安。
  - 尚未建立 PR（使用者沒有要求）。

### 主要功能分頁（`activeTab`）
`calendar`（月曆排課、請假、調課、48 小時確認完課）、`learning`（講義作業、拍照提問、成績折線圖）、`annual`（年度時數與鐘點費）、`plans`（訂閱方案）、`settings`（個人檔案、綁定、密碼、主題）、`finance`（僅管理者可見的財務報表）。

### 會籍等級 `PLAN_TIERS`
`free` / `m1`（NT$50，30 天）/ `m3`（130，90 天）/ `m6`（270，180 天，PRO）/ `m12`（550，365 天，PRO）。功能鎖由 `hasTierPermission(user, tierId)` 判斷；管理者關閉「訂閱制」時，所有人都有全部功能。

---

## 3. 原版發現的資安問題（都已修正）

1. 開發者、測試老師、測試學生的 Email 與**明文密碼寫死在原始碼**（`DEV_EMAIL/DEV_PASS/TEACHER_*/STUDENT_*`）。
2. 所有使用者資料（含 FNV 32-bit 密碼雜湊 `syncPwdDigest`）存在**單一份公開文件** `artifacts/tutor-f907b-production/public/data/kejinshi_cloud_config/global_state`，匿名登入即可讀寫。
3. 登入在瀏覽器端比對弱雜湊，可直接繞過。
4. `planTier` 由前端設定，按「付款」就直接開通。
5. 管理者身分用 `user.email === DEV_EMAIL` 在前端判斷。
6. 配對碼只有 900 種組合，而且全站使用者可被列舉。
7. 綁定對象的名稱、頭貼、教材等內容直接插入 innerHTML，有 XSS 風險。
8. 切換綁定對象時，會把 A 對象的共享資料覆寫到 B 對象。
9. 每 6 秒全量上傳下載，採最後寫入者覆蓋全站（last-write-wins），容易遺失資料。
10. 「下載 index.html」會把畫面上的個資一起存進檔案。
11. CSV 匯出沒有處理公式注入。

---

## 4. 新架構（目前程式碼）

### Firestore 資料結構
```
users/{uid}                  個人檔案：email, role, name, subject, gradeNote, avatarData, pairCode,
                             activePartnerUid, planTier, planExpiresAt, colorTheme, weeklySchedule,
                             hasAcceptedTerms, hasCompletedOnboarding, guidedTiersCompleted, seenReleaseId,
                             bgNotifyEnabled, devSubBgNotifyEnabled, shareExamWithPartner, createdAt, updatedAt
users/{uid}/private/solo     尚未綁定時的 calendarOverrides / materials / questions / inAppNotifications
users/{uid}/private/exams    { examScores: [] }（學生開啟分享時，綁定老師可讀）
pairCodes/{CODE}             { uid, createdAt }；8 碼，字元集 A-Z（不含 I、O）與 2-9
pairs/{uidA_uidB}            uid 排序後用 "_" 連接：members, joinCode, createdBy, createdAt,
                             calendarOverrides, materials, questions, inAppNotifications, updatedAt
config/global                subscriptionEnabled, latestRelease, updatedAt
orders/{autoId}              buyerUid, buyerEmail, buyerName, role, planId, planName, amount, channel,
                             status(pending|paid|rejected), createdAt(ISO), createdAtMs, [paidAt, approvedBy, isTest]
admins/{uid}                 存在即代表管理者（只能在主控台建立）
```

### 前端關鍵設計（`index.html` 內嵌 script）
- 全域快取物件 `cloud`（sdk, auth, db, uid, isAdmin, me, myExams, solo, pairs, partners, partnerExams, config, orders, unsubs…），**Firestore 是唯一資料來源**，localStorage 不存任何帳號資料（啟動時會清除舊版的 `kejinshi_v15_*` key）。
- `getAllUsers()` / `getCurrentUser()`：從快取組出舊程式相容的「以 email 為 key 的使用者檢視」。目前檢視對象的共享欄位會合併進 me 與 partner；過期的會籍顯示為 free。
- `updateCurrentUserRecord(mutator)`：產生 before/after 兩份檢視 → `commitUserChanges` 依差異寫入：
  - 個人檔案欄位（`PROFILE_EDITABLE_FIELDS`）寫入 `users/{uid}`。
  - 共享欄位（`SHARED_FIELDS`）寫入 `pairs/{pid}`，沒有綁定時寫入 `private/solo`。`calendarOverrides` 用 `FieldPath` 逐日合併。
  - `examScores` 寫入 `private/exams`。
  - 會先樂觀更新快取，失敗時由 snapshot 還原；寫入前會檢查是否超過 1 MiB 上限（`MAX_DOC_BYTES`）。
- 即時監聽（`startUserListeners`）：自己的 user / solo / exams、`pairs where members array-contains uid`（`includeMetadataChanges: true`）、`config/global`、orders（管理者看全部，一般使用者只看自己的）。綁定對象的資料用 `watchPartner` 監聽，失敗會重試；剛建立、尚未經伺服器確認的 pair 會先跳過。
- `scheduleWorkspaceRender()`：用 rAF 合併多次重繪，並以 `computeViewFingerprint()` 去重，避免打字時畫面被重繪。
- **入站消毒**：`sanitizeCloudDoc`。圖片欄位（`IMAGE_FIELD_NAMES`：avatarData, fileData, photoData, paperPhoto…）只接受 `data:image/(png|jpeg|webp|gif);base64`；其他字串把 `< > " ' \` \\` 轉成全形字。`escapeHtml` 也會跳脫 `'` 和反引號。
- 認證：`signInWithEmailAndPassword`、`createUserWithEmailAndPassword`（搭配 `window.__pendingProfileOpts` 傳遞註冊資料）、Google popup/redirect、`sendPasswordResetEmail`、reauth 後 `updatePassword`、刪除帳號（batch 刪除後呼叫 `deleteUser`）。
- `isDevUser(u)` = `cloud.isAdmin && u.uid === cloud.uid`（讀取 `admins/{uid}`）。
- 登出會 `signOut`、`terminate`、`clearIndexedDbPersistence`，然後重新載入頁面。
- 付款：沒有真正的金流。`confirmSubscriptionPayment` 建立 `pending` 訂單；管理者在財務頁用 `adminApproveOrder`（批次寫入：訂單改為 paid，並更新使用者的 `planTier` 與 `planExpiresAt`）或 `adminRejectOrder` 處理。
- **模擬器開關**：只有在 `localhost`/`127.0.0.1` 且網址帶 `?emulator` 時，才會連到 Auth 9099 與 Firestore 8080。
- CSP 寫在 `<meta http-equiv="Content-Security-Policy">`（允許 tailwind CDN、gstatic、apis.google.com、googleapis、firebaseapp.com）。

### 其他檔案
- `firestore.rules`：預設全部拒絕，開放本人與綁定對象；使用者只能降級成 free；訂單金額必須等於定價；管理者只能改會籍欄位。
- `firebase.json` / `.firebaserc`：規則部署設定與模擬器 port（auth 9099、firestore 8080）。
- `edgeone.json`：安全標頭（X-Frame-Options、HSTS、nosniff、Referrer-Policy、Permissions-Policy、Cache-Control）。**尚未確認 EdgeOne 方案是否支援**；不支援時要在主控台規則引擎手動加入。
- `SECURITY.md`：給使用者看的資安說明與 Firebase 主控台設定步驟（中文）。
- `tests/`：`rules.test.mjs`（21 項規則測試）、`e2e.mjs`（Playwright 開兩個瀏覽器分別扮演師生，12 步驟）。

---

## 5. 測試指令

```bash
cd tests
npm install
npm test        # Firestore 規則測試（firebase emulators:exec，需 Java 11+）
npm run e2e     # 端對端測試（需 Java，以及 playwright：本地或全域安裝皆可，並需 Chromium）
```
- `e2e.mjs` 會在 5179 port 架一個本機伺服器，並移除 CSP meta（否則 CSP 會擋下 127.0.0.1 的模擬器連線），然後用 `?emulator` 開啟網頁。
- 最後一次結果：規則 21/21 通過，E2E 連跑 3 次全部通過。
- Lint：`no-undef` 會回報 2 個 `finishCoachGuide`。這是誤報，執行期會解析成 `window.finishCoachGuide`。

---

## 6. 使用者尚未完成的上線步驟（請提醒使用者）

1. **如果 `hunter2006` 這組密碼曾用在其他地方，請立即更改**（它曾公開出現在原始碼）。
2. Firebase 主控台：
   - 啟用「Email/Password」（與 Google）登入。
   - 在 Authorized domains 加入 `desirable-silver-gvze7fst.edgeone.dev`。
   - 發布 `firestore.rules`（`firebase deploy --only firestore:rules`，或貼到主控台）。
   - **刪除舊的 `artifacts` 集合**。
3. 使用者先註冊自己的帳號，再在 Firestore 建立 `admins/{自己的UID}`。
4. Google Cloud Console 限制 API 金鑰的 HTTP referrer。
5. 上傳 `index.html` 與 `edgeone.json` 到 EdgeOne。
6. 舊使用者都需要重新註冊（舊帳號不在 Firebase Auth 裡）。

## 7. 等待使用者提供的資訊或決定

- 收款資訊（LINE Pay、銀行帳號），要加到結帳彈窗 `#checkoutModal`。
- 是否啟用 App Check（reCAPTCHA Enterprise site key）。
- 是否串接真正的金流（綠界、藍新、LINE Pay API，需搭配 Cloud Functions 與 Blaze 方案）。

## 8. 已知限制與後續可改善項目

- 教材與照片以 base64 存在 Firestore 文件中，單份上限 1 MiB（已有提示）；長期應改用 Firebase Storage（需 Blaze 方案）。
- Tailwind 使用 Play CDN（官方不建議正式環境使用），可改為預先編譯的 CSS，CSP 也能隨之收緊。
- inline `onclick` 很多，所以 CSP 必須保留 `'unsafe-inline'`；可逐步改用 addEventListener。
- 配對碼目前無法重新產生；解除綁定後，對方若還記得代碼可以再綁一次（可新增「重新產生配對碼」）。
- 會籍功能鎖只是前端畫面限制；真正受保護的是資料規則與開通權限。
- 尚未要求驗證 Email（`emailVerified`）。
- 服務條款裡的客服信箱是使用者刻意公開的，保留即可。

## 9. 工作慣例

- 修改後要跑 `npm test` 與 `npm run e2e`；修改資料結構或規則時，要同步更新 `firestore.rules`、`tests/rules.test.mjs` 與本檔案。
- 任何新的雲端讀取都要經過 `sanitizeCloudDoc`；任何 innerHTML 插值都要用 `escapeHtml`。
- 不要把帳號密碼、token 寫進 repo。
- Commit 訊息用英文；回覆使用者用繁體中文。
