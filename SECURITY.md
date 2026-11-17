# 課金師：雲端同步與資安說明

本文件說明 `index.html`（部署在 EdgeOne）搭配 Firebase 的資料架構、安全措施，以及**上線前必須在 Firebase 主控台完成的設定**。

---

## 一、原版發現的資安問題（已修正）

| # | 問題 | 風險 | 修正方式 |
|---|------|------|----------|
| 1 | 開發者、測試老師、測試學生的 **Email 與明文密碼寫死在網頁原始碼** | 任何人「檢視原始碼」即可登入開發者帳號、操作財務與全站設定 | 全部移除，改用 Firebase Authentication |
| 2 | **所有使用者資料**（課表、成績、講義、照片、密碼雜湊）存在**同一份公開文件** `artifacts/.../global_state`，匿名登入即可讀寫 | 任何人可下載全站個資、竄改或清空所有人的資料 | 改為每人一份文件 + 師生共享文件，安全規則限定本人／綁定對象 |
| 3 | 密碼只用 32 位元 FNV 雜湊、在瀏覽器比對 | 雜湊可在數秒內破解，且可直接繞過登入 | 由 Firebase Auth 驗證（伺服器端 scrypt），並內建暴力破解鎖定 |
| 4 | 會籍（planTier）由前端自行設定，「付款」按鈕直接開通 | 任何人都能免費變成年費 PRO | 規則禁止使用者自行升級；訂單需管理者確認收款才開通 |
| 5 | 開發者權限用「Email 是否等於某字串」在前端判斷 | 可偽造 | 改為 Firestore `admins/{uid}` 名單，只能在主控台建立 |
| 6 | 配對代碼只有 900 種組合，且所有使用者資料可被列舉 | 可猜出代碼綁定陌生人、讀取對方資料 | 8 碼隨機代碼（約 1 兆種）＋禁止列舉；綁定須出示代碼 |
| 7 | 綁定對象的名稱、頭貼、教材等內容直接插入 HTML | 對方可植入惡意腳本（XSS）盜用帳號 | 雲端資料入站消毒（圖片只收 `data:image/...`、特殊字元轉全形）＋ CSP |
| 8 | 切換綁定對象時，會把 A 對象的資料覆寫到 B 對象 | 資料互相覆蓋、外洩給錯的人 | 每對師生各自一份共享文件 `pairs/{uidA_uidB}` |
| 9 | 每 6 秒整份資料上傳／下載、最後寫入者覆蓋全站 | 多人同時使用時資料遺失 | Firestore 即時監聽＋只寫入有變動的欄位（請假紀錄逐日合併） |
| 10 | 「下載 index.html」會把畫面上的個資一起存進檔案 | 個資外流 | 移除此功能 |
| 11 | 財務 CSV 未處理公式注入 | 開啟 CSV 時可執行 Excel 公式 | 欄位加引號並跳脫 `= + - @` 開頭 |

## 二、新的資料架構（Firestore）

```
users/{uid}                    個人檔案（姓名、科目、課表、頭貼、會籍）— 本人可改；綁定對象可讀
users/{uid}/private/solo       尚未綁定對象時的請假紀錄、教材、提問 — 僅本人
users/{uid}/private/exams      學生成績 — 本人可讀寫；學生開啟「分享成績」時綁定老師可讀
pairCodes/{code}               配對代碼 → uid（只能用完整代碼查詢，不能列舉）
pairs/{uidA_uidB}              師生共享：請假／調課、講義、提問、通知 — 只有兩位成員可讀寫
config/global                  訂閱制開關、系統更新公告 — 登入者可讀，管理者可寫
orders/{orderId}               訂單 — 使用者只能建立自己的「待確認」訂單；管理者確認收款
admins/{uid}                   管理者名單 — 只能在 Firebase 主控台手動建立
```

所有規則在 `firestore.rules`，並有 21 項自動化測試（`tests/rules.test.mjs`）。

---

## 三、上線前必做（Firebase 主控台）

> 專案：`tutor-f907b`，網址：`https://desirable-silver-gvze7fst.edgeone.dev`

1. **啟用登入方式**：Authentication → Sign-in method → 啟用「電子郵件/密碼」（以及「Google」如需 Google 登入）。
2. **授權網域**：Authentication → Settings → Authorized domains → 加入 `desirable-silver-gvze7fst.edgeone.dev`（日後換正式網域也要加）。
3. **部署安全規則**（擇一）：
   - 主控台：Firestore Database → 規則 → 貼上 `firestore.rules` 全文 → 發布。
   - 指令：`npm i -g firebase-tools && firebase login && firebase deploy --only firestore:rules`
4. **刪除舊的公開資料**：Firestore Database → 資料 → 刪除整個 `artifacts` 集合（內含舊版所有人的資料與密碼雜湊）。新規則已禁止存取，但仍建議刪除。
5. **設定管理者（你自己）**：
   1. 先在網站用你的 Email 註冊並登入一次。
   2. Authentication → Users → 複製你帳號的「使用者 UID」。
   3. Firestore → 開始集合 `admins` → 文件 ID 貼上 UID → 隨便加一個欄位（例如 `note: "owner"`）→ 儲存。
   4. 重新整理網站，頂端會出現「管理」按鈕與財務報表。
6. **限制 API 金鑰**：Google Cloud Console → API 和服務 → 憑證 → Browser key → 應用程式限制選「網站」，加入
   `https://desirable-silver-gvze7fst.edgeone.dev/*` 與 `https://tutor-f907b.firebaseapp.com/*`。
7. **（建議）密碼政策**：Authentication → Settings → Password policy → 要求至少 8 碼、含英數。
8. **（建議）App Check**：啟用 reCAPTCHA Enterprise 的 App Check，可阻擋非本網站的機器人直接呼叫 API（需要另外在程式中加入 site key，提供給我即可）。

## 四、密碼與帳號提醒

- 原版原始碼中曾公開出現開發者帳號密碼。**若該密碼曾用於其他網站（Gmail 等），請立即更改。**
- 舊版帳號存在瀏覽器與公開文件中，並非 Firebase 帳號，**所有使用者需要重新註冊**（新版啟動時會自動清除瀏覽器裡的舊資料）。

## 五、付款流程（目前）

目前沒有串接真正的金流 API。流程為：使用者選方案 → 送出「待確認」訂單 → 依所選管道付款 → 管理者在「財務報表 → 待確認收款訂單」核對入帳後按「確認收款並開通」→ 系統自動計算到期日。
若要做到「付款完成自動開通」，需要串接綠界／藍新／LINE Pay API，並使用 Cloud Functions（Blaze 方案）在伺服器端驗證付款通知後開通。

## 六、已知限制與後續可改善

- Firestore 單一文件上限 1 MB：教材圖片、提問照片都存在師生共享文件中（已壓縮至 640px）。照片很多時會提示刪除舊圖。長期建議改用 Firebase Storage（需 Blaze 方案）。
- Tailwind 使用 CDN 版本（官方不建議正式環境使用），日後可改為預先編譯的 CSS 以提升速度與安全性。
- 訂閱功能鎖定屬於前端畫面限制；真正受保護的是資料存取（規則）與會籍開通（只有管理者能改）。

## 七、開發與測試

```bash
cd tests
npm install
npm test        # Firestore 安全規則測試（需 Java）
npm run e2e     # 端對端測試：在模擬器上以兩個瀏覽器扮演老師與學生（需 Java 與 Playwright）
```

本機手動測試：啟動模擬器後，用 `http://localhost:<port>/?emulator` 開啟網頁即可連到本機模擬器（正式網址不受影響）。

## 八、EdgeOne 部署

上傳 `index.html` 與 `edgeone.json`（安全標頭：禁止被嵌入 iframe、HSTS、nosniff 等）。
`edgeone.json` 為 EdgeOne Pages 的設定檔，若你的 EdgeOne 方案不支援，可在 EdgeOne 主控台 →「規則引擎」手動加入相同的 HTTP 回應標頭。
