// 端對端測試：在 Firebase 模擬器上跑真正的 index.html（兩個瀏覽器分別扮演老師與學生）
// 執行：npm run e2e（需要 Java 與 Playwright/Chromium）
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(execSync("npm root -g").toString().trim() + "/playwright"); }
const { chromium } = playwright;
import http from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const PROJECT = "tutor-f907b";
const FS = "http://127.0.0.1:8080";
const PORT = 5179;

// 本機伺服器：移除 CSP（CSP 會擋下 127.0.0.1 模擬器連線），其他內容與正式版相同
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(PORT);
const URL_APP = `http://localhost:${PORT}/?emulator`;

async function makeAdmin(uid) {
  const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/admins/${uid}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { note: { stringValue: "e2e" } } })
  });
  assert.ok(r.ok, "make admin failed " + r.status);
}
async function getUidByEmail(email) {
  const r = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] })
  });
  const j = await r.json();
  const uid = (j.users || [])[0]?.localId;
  assert.ok(uid, "找不到使用者 " + JSON.stringify(j));
  return uid;
}

const browser = await chromium.launch();
const errors = [];
async function newUser() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "warning" || m.type() === "error") console.log("  [console]", m.text().slice(0, 300)); });
  page.on("dialog", d => d.accept());
  await page.goto(URL_APP);
  await page.waitForSelector("#authScreen:not(.hidden)", { timeout: 20000 });
  return page;
}
async function register(page, { role, name, email, pwd }) {
  await page.click("#tabBtnRegister");
  await page.check(`input[name="regRole"][value="${role}"]`, { force: true });
  await page.fill("#regNameInput", name);
  await page.fill("#regEmailInput", email);
  await page.fill("#regPasswordInput", pwd);
  await page.click("#registerSubmitBtn");
  await page.waitForSelector("#termsModal:not(.hidden)", { timeout: 20000 });
  await page.check("#agreeTermsCheckbox");
  await page.evaluate(() => window.confirmTermsStep());
  await page.waitForSelector("#onboardingScheduleModal:not(.hidden)");
  await page.fill("#onboardDisplayName", name);
  await page.evaluate(() => window.completeOnboardingSetup());
  await page.evaluate(() => window.finishCoachGuide && window.finishCoachGuide());
  await page.waitForTimeout(800);
}
const text = page => page.evaluate(() => document.getElementById("tabContentContainer").innerText);
const step = msg => console.log("✓", msg);

try {
  const t = await newUser();
  await register(t, { role: "teacher", name: "林老師", email: "teacher@example.com", pwd: "Teach1234" });
  const teacherCode = (await t.textContent("#headerPairCode")).trim();
  assert.match(teacherCode, /^[A-Z2-9]{8}$/);
  step(`老師註冊成功，配對代碼 ${teacherCode}`);

  // 弱密碼被擋
  const weak = await newUser();
  await weak.click("#tabBtnRegister");
  await weak.fill("#regNameInput", "弱密碼");
  await weak.fill("#regEmailInput", "weak@example.com");
  await weak.fill("#regPasswordInput", "123456");
  await weak.click("#registerSubmitBtn");
  await weak.waitForSelector("#regErrorAlertBox:not(.hidden)");
  step("弱密碼註冊被擋下");

  const s = await newUser();
  await register(s, { role: "student", name: "王小明", email: "student@example.com", pwd: "Stud12345" });
  step("學生註冊成功");

  // 學生用代碼綁定老師
  await s.evaluate(() => window.switchTab("settings"));
  await s.fill("#settingPartnerCodeInput", teacherCode);
  await s.evaluate(() => window.bindPartnerByCode());
  await s.waitForFunction(() => document.getElementById("tabContentContainer").innerText.includes("林老師"), null, { timeout: 15000 });
  await t.evaluate(() => window.switchTab("settings"));
  await t.waitForFunction(() => document.getElementById("tabContentContainer").innerText.includes("王小明"), null, { timeout: 15000 });
  step("配對綁定成功，雙方即時看到對方");

  // 老師成為管理者 → 重新整理後出現管理按鈕
  const teacherUid = await getUidByEmail("teacher@example.com");
  await makeAdmin(teacherUid);
  await t.reload();
  await t.waitForSelector("#devDrawerBtn:not(.hidden)", { timeout: 20000 });
  step("admins/{uid} 授權後才出現管理功能");

  // 學生送出訂單 → 仍為免費版
  await s.evaluate(() => { window.openCheckoutModal("m1"); });
  await s.check("#checkoutDigitalConsentChk");
  await s.evaluate(() => window.confirmSubscriptionPayment());
  await s.waitForFunction(() => document.getElementById("toastMessage").textContent.includes("已送出"), null, { timeout: 15000 });
  assert.match(await s.textContent("#headerPlanBadge"), /免費/);
  step("學生送出訂單後仍是免費版（等待確認）");

  // 管理者確認收款
  await t.evaluate(() => window.switchTab("finance"));
  await t.waitForSelector("button:has-text(\"確認收款並開通\")", { timeout: 15000 });
  await t.click("button:has-text(\"確認收款並開通\")");
  await t.waitForTimeout(2000);
  await s.waitForFunction(() => document.getElementById("headerPlanBadge").textContent.includes("1 個月"), null, { timeout: 15000 });
  step("管理者確認收款後，學生端即時升級為 1 個月會籍");

  // 老師（管理者）也升級才能發講義：關閉訂閱制 → 全功能開放
  await t.evaluate(() => window.toggleGlobalSubscriptionSwitch());
  await t.waitForTimeout(800);
  await t.evaluate(() => window.switchTab("learning"));
  await t.waitForSelector("#matTitleInput");
  await t.fill("#matTitleInput", "第三章 三角函數講義");
  await t.fill("#matNoteInput", "p.12-20");
  await t.evaluate(() => window.addSharedMaterialItem());
  await s.evaluate(() => window.switchTab("learning"));
  await s.waitForFunction(() => document.getElementById("tabContentContainer").innerText.includes("第三章 三角函數講義"), null, { timeout: 15000 });
  step("老師發布講義，學生端即時同步看到");

  // XSS：學生把名稱改成惡意腳本，老師端不得執行
  await s.evaluate(() => window.switchTab("settings"));
  await s.fill("#settingUserNameInput", `<img src=x onerror="window.__xss=1">`);
  await s.evaluate(() => window.saveSettingsAndSchedule());
  await t.evaluate(() => window.switchTab("settings"));
  await t.waitForFunction(() => document.getElementById("tabContentContainer").innerText.includes("＜img"), null, { timeout: 15000 });
  await t.waitForTimeout(500);
  assert.equal(await t.evaluate(() => window.__xss), undefined);
  assert.equal(await t.evaluate(() => document.querySelectorAll('img[src="x"]').length), 0);
  step("惡意名稱在對方畫面被無害化，未執行腳本");

  // 解除綁定
  await t.evaluate(() => window.unbindSpecificPartner());
  await s.waitForFunction(() => !document.getElementById("tabContentContainer").innerText.includes("林老師"), null, { timeout: 15000 });
  step("解除綁定後雙方即時移除");

  // 登出後清除本機快取並回到登入頁
  await s.evaluate(() => window.logoutCurrentUser());
  await s.waitForSelector("#authScreen:not(.hidden)", { timeout: 20000 });
  const lsKeys = await s.evaluate(() => Object.keys(localStorage));
  assert.ok(!lsKeys.some(k => k.startsWith("kejinshi_v15")), "殘留舊版帳號資料");
  step("登出成功，回到登入頁且無本機帳號資料");

  // 登入錯誤密碼
  await s.fill("#loginEmailInput", "student@example.com");
  await s.fill("#loginPasswordInput", "wrongpass1");
  await s.click("#loginSubmitBtn");
  await s.waitForSelector("#loginErrorAlertBox:not(.hidden)");
  await s.fill("#loginPasswordInput", "Stud12345");
  await s.click("#loginSubmitBtn");
  await s.waitForSelector("#appWorkspace:not(.hidden)", { timeout: 20000 });
  assert.match(await s.textContent("#headerPlanBadge"), /1 個月/);
  step("錯誤密碼被拒；正確密碼重新登入後資料（會籍）由雲端還原");

  await s.screenshot({ path: new URL("./e2e-student.png", import.meta.url).pathname, fullPage: false });
  assert.deepEqual(errors, [], "頁面 JS 錯誤：" + errors.join("\n"));
  console.log("\nE2E 全部通過");
} catch (e) {
  console.error("E2E 失敗：", e);
  console.error("頁面錯誤：", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
