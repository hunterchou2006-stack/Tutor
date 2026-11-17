// Firestore 安全規則測試：npm test（需要 Java，會自動啟動 Firestore 模擬器）
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where, getDocs, addDoc
} from "firebase/firestore";

let env;
const T = { uid: "teacherUid", email: "teacher@example.com" };
const S = { uid: "studentUid", email: "student@example.com" };
const X = { uid: "attackerUid", email: "attacker@example.com" };
const A = { uid: "adminUid", email: "admin@example.com" };
const PAIR = "studentUid_teacherUid";

const ctx = u => env.authenticatedContext(u.uid, { email: u.email, email_verified: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

function profile(u, role, code, extra = {}) {
  return {
    email: u.email, role, name: role === "teacher" ? "林老師" : "王小明", pairCode: code,
    planTier: "free", subject: "數學", gradeNote: "高二", avatarData: "", activePartnerUid: "",
    shareExamWithPartner: true, weeklySchedule: {}, createdAt: 1, updatedAt: 1, ...extra
  };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-kejinshi",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") }
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, "pairCodes", "TEACH234"), { uid: T.uid, createdAt: 1 });
    await setDoc(doc(db, "pairCodes", "STUD2345"), { uid: S.uid, createdAt: 1 });
    await setDoc(doc(db, "pairCodes", "ATTK2345"), { uid: X.uid, createdAt: 1 });
    await setDoc(doc(db, "users", T.uid), profile(T, "teacher", "TEACH234"));
    await setDoc(doc(db, "users", S.uid), profile(S, "student", "STUD2345"));
    await setDoc(doc(db, "users", X.uid), profile(X, "teacher", "ATTK2345"));
    await setDoc(doc(db, "users", S.uid, "private", "exams"), { examScores: [{ id: "e1", score: 90 }] });
    await setDoc(doc(db, "users", S.uid, "private", "solo"), { materials: [] });
    await setDoc(doc(db, "pairs", PAIR), {
      members: [S.uid, T.uid], joinCode: "STUD2345", createdBy: T.uid, createdAt: 1,
      calendarOverrides: {}, materials: [], questions: [], inAppNotifications: []
    });
    await setDoc(doc(db, "admins", A.uid), { note: "owner" });
    await setDoc(doc(db, "config", "global"), { subscriptionEnabled: true });
    await setDoc(doc(db, "orders", "o1"), { buyerUid: S.uid, status: "pending", planId: "m1", amount: 50 });
    await setDoc(doc(db, "artifacts", "tutor-f907b-production", "public", "data", "kejinshi_cloud_config", "global_state"), { allUsersJson: "{}" });
  });
});

// ---------- 舊版公開文件 ----------
test("舊版公開 global_state 文件：未登入與登入者都無法讀寫", async () => {
  const path = ["artifacts", "tutor-f907b-production", "public", "data", "kejinshi_cloud_config", "global_state"];
  await assertFails(getDoc(doc(anon(), ...path)));
  await assertFails(getDoc(doc(ctx(X), ...path)));
  await assertFails(setDoc(doc(ctx(X), ...path), { allUsersJson: "{}" }));
});

// ---------- 個人檔案 ----------
test("未登入者不能讀任何使用者", async () => {
  await assertFails(getDoc(doc(anon(), "users", T.uid)));
});

test("本人與綁定對象可讀；陌生人不可讀、也不可列出全部使用者", async () => {
  await assertSucceeds(getDoc(doc(ctx(T), "users", T.uid)));
  await assertSucceeds(getDoc(doc(ctx(S), "users", T.uid)));
  await assertFails(getDoc(doc(ctx(X), "users", T.uid)));
  await assertFails(getDocs(collection(ctx(X), "users")));
});

test("管理者可讀使用者", async () => {
  await assertSucceeds(getDoc(doc(ctx(A), "users", S.uid)));
});

test("本人可改名稱與課表，但不能自行升級會籍或改身分／email／配對碼", async () => {
  const db = ctx(T);
  await assertSucceeds(updateDoc(doc(db, "users", T.uid), { name: "新名字", weeklySchedule: { 1: { enabled: true } } }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { planTier: "m12" }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { planExpiresAt: 9999999999999 }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { role: "student" }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { email: "x@example.com" }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { pairCode: "STUD2345" }));
  await assertSucceeds(updateDoc(doc(db, "users", T.uid), { planTier: "free" }));
});

test("名稱長度與頭貼格式受限（防止塞入腳本或超大資料）", async () => {
  const db = ctx(T);
  await assertFails(updateDoc(doc(db, "users", T.uid), { name: "x".repeat(41) }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { avatarData: "javascript:alert(1)" }));
  await assertFails(updateDoc(doc(db, "users", T.uid), { avatarData: "data:image/png;base64,AAA\" onerror=\"alert(1)" }));
  await assertSucceeds(updateDoc(doc(db, "users", T.uid), { avatarData: "data:image/png;base64,iVBORw0KGgo=" }));
});

test("綁定對象與陌生人都不能修改別人的個人檔案", async () => {
  await assertFails(updateDoc(doc(ctx(S), "users", T.uid), { name: "被改了" }));
  await assertFails(updateDoc(doc(ctx(X), "users", T.uid), { name: "被改了" }));
  await assertFails(deleteDoc(doc(ctx(X), "users", T.uid)));
});

test("註冊：只能建立自己的檔案、且必須是免費版並擁有自己的配對碼", async () => {
  const N = { uid: "newUid", email: "new@example.com" };
  const db = ctx(N);
  const good = writeBatch(db);
  good.set(doc(db, "pairCodes", "NEWC2345"), { uid: N.uid, createdAt: 1 });
  good.set(doc(db, "users", N.uid), profile(N, "student", "NEWC2345"));
  await assertSucceeds(good.commit());

  const N2 = { uid: "newUid2", email: "new2@example.com" };
  const db2 = ctx(N2);
  const paid = writeBatch(db2);
  paid.set(doc(db2, "pairCodes", "NEWD2345"), { uid: N2.uid, createdAt: 1 });
  paid.set(doc(db2, "users", N2.uid), profile(N2, "student", "NEWD2345", { planTier: "m12" }));
  await assertFails(paid.commit());

  // 冒用別人的配對碼
  await assertFails(setDoc(doc(db2, "users", N2.uid), profile(N2, "student", "TEACH234")));
  // 冒用別人的 email
  await assertFails(setDoc(doc(db2, "users", N2.uid), profile({ ...N2, email: T.email }, "student", "NEWD2345")));
  // 替別人建立檔案
  await assertFails(setDoc(doc(db2, "users", "someoneElse"), profile(N2, "student", "NEWD2345")));
});

// ---------- 配對代碼 ----------
test("配對代碼：可單筆查詢，但不可列舉、不可搶佔或覆寫別人的代碼", async () => {
  await assertSucceeds(getDoc(doc(ctx(X), "pairCodes", "TEACH234")));
  await assertFails(getDocs(collection(ctx(X), "pairCodes")));
  await assertFails(setDoc(doc(ctx(X), "pairCodes", "TEACH234"), { uid: X.uid, createdAt: 1 }));
  await assertFails(deleteDoc(doc(ctx(X), "pairCodes", "TEACH234")));
  await assertFails(setDoc(doc(ctx(X), "pairCodes", "ZZZZ2345"), { uid: T.uid, createdAt: 1 }));
  await assertFails(getDoc(doc(anon(), "pairCodes", "TEACH234")));
});

// ---------- 師生共享資料 ----------
test("共享資料：成員可讀寫，陌生人不可讀寫或刪除", async () => {
  await assertSucceeds(getDoc(doc(ctx(T), "pairs", PAIR)));
  await assertSucceeds(updateDoc(doc(ctx(S), "pairs", PAIR), { materials: [{ id: "m1", title: "講義" }] }));
  await assertFails(getDoc(doc(ctx(X), "pairs", PAIR)));
  await assertFails(updateDoc(doc(ctx(X), "pairs", PAIR), { materials: [] }));
  await assertFails(deleteDoc(doc(ctx(X), "pairs", PAIR)));
});

test("共享資料：成員不能竄改成員名單", async () => {
  await assertFails(updateDoc(doc(ctx(T), "pairs", PAIR), { members: [T.uid, X.uid] }));
  await assertFails(updateDoc(doc(ctx(T), "pairs", PAIR), { joinCode: "ATTK2345" }));
});

test("只能查詢自己所在的配對", async () => {
  await assertSucceeds(getDocs(query(collection(ctx(T), "pairs"), where("members", "array-contains", T.uid))));
  await assertFails(getDocs(query(collection(ctx(X), "pairs"), where("members", "array-contains", T.uid))));
  await assertFails(getDocs(collection(ctx(X), "pairs")));
});

test("建立綁定必須出示對方正確的配對代碼", async () => {
  const pid = "attackerUid_teacherUid";
  const base = { members: [X.uid, T.uid], createdBy: X.uid, createdAt: 1, calendarOverrides: {}, materials: [], questions: [], inAppNotifications: [] };
  await assertFails(setDoc(doc(ctx(X), "pairs", pid), { ...base, joinCode: "WRONG234" }));
  await assertFails(setDoc(doc(ctx(X), "pairs", pid), { ...base, joinCode: "ATTK2345" }));
  // 偽造他人之間的配對
  await assertFails(setDoc(doc(ctx(X), "pairs", PAIR), { ...base, members: [S.uid, T.uid], createdBy: X.uid, joinCode: "TEACH234" }));
  await assertSucceeds(setDoc(doc(ctx(X), "pairs", pid), { ...base, joinCode: "TEACH234" }));
  // 綁定後才能讀對方檔案
  await assertSucceeds(getDoc(doc(ctx(X), "users", T.uid)));
});

test("成員可解除綁定（刪除配對）", async () => {
  await assertSucceeds(deleteDoc(doc(ctx(T), "pairs", PAIR)));
  await assertFails(getDoc(doc(ctx(T), "users", S.uid)));
});

// ---------- 私人資料 / 成績 ----------
test("私人資料：只有本人可讀寫 solo", async () => {
  await assertSucceeds(getDoc(doc(ctx(S), "users", S.uid, "private", "solo")));
  await assertFails(getDoc(doc(ctx(T), "users", S.uid, "private", "solo")));
  await assertFails(setDoc(doc(ctx(T), "users", S.uid, "private", "exams"), { examScores: [] }));
  await assertFails(setDoc(doc(ctx(S), "users", S.uid, "private", "other"), { x: 1 }));
});

test("成績：學生開啟分享時綁定老師可讀，關閉後不可讀；陌生人永遠不可讀", async () => {
  await assertSucceeds(getDoc(doc(ctx(T), "users", S.uid, "private", "exams")));
  await assertFails(getDoc(doc(ctx(X), "users", S.uid, "private", "exams")));
  await assertSucceeds(updateDoc(doc(ctx(S), "users", S.uid), { shareExamWithPartner: false }));
  await assertFails(getDoc(doc(ctx(T), "users", S.uid, "private", "exams")));
});

// ---------- 全站設定 / 管理者 ----------
test("全站設定：登入者可讀，只有管理者可寫", async () => {
  await assertSucceeds(getDoc(doc(ctx(X), "config", "global")));
  await assertFails(setDoc(doc(ctx(X), "config", "global"), { subscriptionEnabled: false }));
  await assertSucceeds(setDoc(doc(ctx(A), "config", "global"), { subscriptionEnabled: false }));
});

test("管理者名單無法由前端建立或讀取他人的", async () => {
  await assertFails(setDoc(doc(ctx(X), "admins", X.uid), { note: "me" }));
  await assertFails(getDoc(doc(ctx(X), "admins", A.uid)));
  await assertSucceeds(getDoc(doc(ctx(A), "admins", A.uid)));
});

// ---------- 訂單 ----------
const order = (u, extra = {}) => ({
  buyerUid: u.uid, buyerEmail: u.email, buyerName: "王小明", role: "student", planId: "m6",
  planName: "6 個月・半年會籍 PRO", amount: 270, channel: "LINE Pay", status: "pending",
  createdAt: "2026-11-17T00:00:00Z", createdAtMs: 1, ...extra
});

test("訂單：使用者只能建立自己的待確認訂單，且金額需符合定價", async () => {
  await assertSucceeds(addDoc(collection(ctx(S), "orders"), order(S)));
  await assertFails(addDoc(collection(ctx(S), "orders"), order(S, { status: "paid" })));
  await assertFails(addDoc(collection(ctx(S), "orders"), order(S, { amount: 1 })));
  await assertFails(addDoc(collection(ctx(S), "orders"), order(S, { buyerUid: T.uid })));
  await assertFails(addDoc(collection(ctx(S), "orders"), order(S, { buyerEmail: T.email })));
  await assertFails(addDoc(collection(ctx(S), "orders"), order(S, { isTest: true })));
});

test("訂單：使用者不能確認自己的訂單，也看不到別人的訂單", async () => {
  await assertFails(updateDoc(doc(ctx(S), "orders", "o1"), { status: "paid" }));
  await assertSucceeds(getDoc(doc(ctx(S), "orders", "o1")));
  await assertFails(getDoc(doc(ctx(X), "orders", "o1")));
  await assertFails(getDocs(collection(ctx(X), "orders")));
  await assertSucceeds(getDocs(query(collection(ctx(S), "orders"), where("buyerUid", "==", S.uid))));
});

test("管理者確認收款：可更新訂單與開通會籍，但不能改使用者其他欄位", async () => {
  const db = ctx(A);
  const batch = writeBatch(db);
  batch.update(doc(db, "orders", "o1"), { status: "paid" });
  batch.update(doc(db, "users", S.uid), { planTier: "m1", planExpiresAt: Date.now() + 30 * 86400000, updatedAt: Date.now() });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(db, "users", S.uid), { name: "管理者改名" }));
  await assertSucceeds(getDocs(collection(db, "orders")));
});
