/**
 * test/smoke.test.js
 * Kiểm tra tự động các tiêu chí nghiệm thu phía server (mục 14):
 *  - auth giáo viên, tạo bài học, tạo phòng, học viên vào phòng
 *  - cấp token Agora với uid do server quyết định
 *  - đồng bộ nét vẽ / trang / quyền / sao qua Socket.IO
 *  - server thực thi quyền (học viên không lách được)
 *  - người vào muộn nhận đủ nét của trang hiện tại
 *
 * Chạy: npm test
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

// Đặt biến môi trường TRƯỚC khi nạp server (dotenv không ghi đè biến đã có)
process.env.AGORA_APP_ID = crypto.randomBytes(16).toString("hex");
process.env.AGORA_APP_CERT = crypto.randomBytes(16).toString("hex");
process.env.JWT_SECRET = crypto.randomBytes(48).toString("base64url");
process.env.TEACHER_PASSWORD = "test-password-123";
process.env.SERVER_PORT = "0"; // cổng ngẫu nhiên
process.env.PUBLIC_URL = "http://localhost:3000";
process.env.NODE_ENV = "test";
// Chạy test cách ly hoàn toàn với data/db.json và uploads/ thật
const TMP = `/tmp/ea-test-${Date.now()}`;
process.env.DATA_DIR = `${TMP}/data`;
process.env.UPLOADS_DIR = `${TMP}/uploads`;

const { server } = await import("../server.js");
const { io: ioClient } = await import("socket.io-client");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

await new Promise((resolve) => {
  if (server.listening) return resolve();
  server.once("listening", resolve);
});
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

async function json(path, { method = "GET", body, token, form } = {}) {
  // form: FormData (multipart) - body: object (JSON)
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !form) headers["Content-Type"] = "application/json";
  const payload = form || (body ? JSON.stringify(body) : undefined);
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout chờ sự kiện "${event}"`));
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connect(token, code) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token, code }, transports: ["websocket"], reconnection: false, forceNew: true });
    // Server gửi room:state NGAY khi kết nối -> phải lắng nghe trước khi connect xong
    s.firstState = once(s, "room:state");
    s.firstPresence = once(s, "presence", 6000).catch(() => null);
    const t = setTimeout(() => reject(new Error("timeout kết nối socket")), 5000);
    s.on("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tạo một học viên MỚI (userId mới) để kiểm tra "vào muộn / F5".
 * Không dùng lại token cũ vì server sẽ ngắt tab cũ (đúng hành vi mục 13).
 */
async function newStudentToken(code, name) {
  const r = await json(`/api/rooms/${code}/join`, { method: "POST", body: { name } });
  assert.equal(r.status, 200);
  return r.data.token;
}

/** Chờ đến khi điều kiện đúng (kiểm tra mỗi 20 ms). */
async function until(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

test("health + config công khai không lộ bí mật", async () => {
  const h = await json("/health");
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);

  const c = await json("/api/config");
  assert.equal(c.status, 200);
  const raw = JSON.stringify(c.data);
  assert.ok(!raw.includes(process.env.AGORA_APP_CERT), "không được lộ AGORA_APP_CERT");
  assert.ok(!raw.includes(process.env.JWT_SECRET), "không được lộ JWT_SECRET");
});

test("đăng nhập giáo viên: đúng/sai mật khẩu", async () => {
  const bad = await json("/api/auth/teacher", { method: "POST", body: { password: "wrong" } });
  assert.equal(bad.status, 401);

  const ok = await json("/api/auth/teacher", { method: "POST", body: { password: "test-password-123", name: "Cô Test" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token.length > 40);
  assert.equal(ok.data.role, "teacher");
});

test("upload bài học: nhận PNG hợp lệ, chặn file giả mạo", async () => {
  const login = await json("/api/auth/teacher", { method: "POST", body: { password: "test-password-123" } });
  const token = login.data.token;

  const fd = new FormData();
  fd.append("title", "Bài test");
  fd.append("type", "slides");
  fd.append("files", new Blob([PNG], { type: "image/png" }), "slide1.png");
  fd.append("files", new Blob([PNG], { type: "image/png" }), "slide2.png");
  const ok = await json("/api/lessons", { method: "POST", token, form: fd });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.lesson.slides.length, 2);

  // Ảnh phải tải được qua /uploads
  const img = await fetch(BASE + ok.data.lesson.slides[0]);
  assert.equal(img.status, 200);

  // File không phải ảnh thật (magic bytes sai) -> từ chối
  const fd2 = new FormData();
  fd2.append("title", "Bài lỗi");
  fd2.append("type", "slides");
  fd2.append("files", new Blob([Buffer.from("GIF89a khong phai png", "utf8")], { type: "image/png" }), "fake.png");
  const bad = await json("/api/lessons", { method: "POST", token, form: fd2 });
  assert.equal(bad.status, 400);

  // Không có token -> 401
  const noAuth = await json("/api/lessons", { method: "POST", form: fd2 });
  assert.equal(noAuth.status, 401);

  globalThis.__teacherToken = token;
  globalThis.__lessonId = ok.data.lesson.id;
});

test("tạo phòng + học viên vào phòng + token Agora do server cấp uid", async () => {
  const token = globalThis.__teacherToken;
  const room = await json("/api/rooms", { method: "POST", token, body: { lessonId: globalThis.__lessonId } });
  assert.equal(room.status, 201);
  const code = room.data.code;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.ok(!/[0O1I]/.test(code), "mã phòng không chứa 0/O/1/I");
  globalThis.__code = code;

  // Học viên vào phòng
  const join = await json(`/api/rooms/${code}/join`, { method: "POST", body: { name: "Bé Test" } });
  assert.equal(join.status, 200);
  assert.equal(join.data.role, "student");
  globalThis.__studentToken = join.data.token;

  // Token Agora: uid do server quyết định
  const camT = await json("/api/agora/token", { method: "POST", token, body: { code, kind: "cam" } });
  assert.equal(camT.status, 200);
  assert.equal(camT.data.uid, 1, "giáo viên uid = 1");
  assert.equal(camT.data.channel, code);
  assert.ok(camT.data.token.length > 50);
  assert.equal(camT.data.appId, process.env.AGORA_APP_ID);

  const screenT = await json("/api/agora/token", { method: "POST", token, body: { code, kind: "screen" } });
  assert.equal(screenT.data.uid, 100001, "uid màn hình = uid camera + 100000");

  const stuT = await json("/api/agora/token", {
    method: "POST",
    token: globalThis.__studentToken,
    body: { code, kind: "cam" },
  });
  assert.equal(stuT.data.uid, 2, "học viên uid = 2");

  const stuScreen = await json("/api/agora/token", {
    method: "POST",
    token: globalThis.__studentToken,
    body: { code, kind: "screen" },
  });
  assert.equal(stuScreen.status, 403, "học viên không được xin token màn hình");
});

test("socket: từ chối kết nối khi token sai", async () => {
  await assert.rejects(() => connect("token-gia", globalThis.__code));
});

test("socket: đồng bộ nét vẽ, trang, quyền, sao (tiêu chí 2,3,5,6,7)", async () => {
  const code = globalThis.__code;
  const teacher = await connect(globalThis.__teacherToken, code);
  const tState = await teacher.firstState;
  assert.equal(tState.code, code);
  assert.equal(tState.pageKey, "lesson:0");

  const student = await connect(globalThis.__studentToken, code);
  const sState = await student.firstState;
  assert.equal(sState.participants.length, 2);

  // presence: gom tất cả sự kiện rồi chờ đến khi có đủ cả 2 vai trò
  const presenceLog = [];
  teacher.on("presence", (p) => presenceLog.push(p));
  assert.ok(await until(() => presenceLog.some((p) => p.participants.some((x) => x.role === "student"))), "presence phải có học viên");
  const presence = presenceLog[presenceLog.length - 1];
  assert.ok(presence.participants.some((p) => p.role === "teacher"));
  assert.ok(presence.participants.some((p) => p.role === "student"));
  assert.ok(presence.participants.every((p) => p.media && typeof p.media.mic === "boolean"), "presence kèm trạng thái mic/cam");

  // --- Đổi slide: giáo viên gửi, học viên nhận ---
  const pageWait = once(student, "page:set");
  teacher.emit("page:set", { index: 1 });
  const page = await pageWait;
  assert.equal(page.index, 1);
  assert.equal(page.pageKey, "lesson:1");

  // --- Học viên KHÔNG được đổi trang (server thực thi quyền) ---
  const errWait = once(student, "error:msg");
  student.emit("page:set", { index: 0 });
  const err = await errWait;
  assert.match(err.message, /giáo viên/i);

  // --- Vẽ: học viên gửi nét, giáo viên nhận được ---
  const beginWait = once(teacher, "stroke:begin");
  const appendWait = once(teacher, "stroke:append");
  const endWait = once(teacher, "stroke:end");
  student.emit("stroke:begin", { id: "s_test1", tool: "pen", color: "#2b8cff", width: 0.004, points: [[0.1, 0.2]] });
  student.emit("stroke:append", { id: "s_test1", points: [[0.15, 0.25], [0.2, 0.3]] });
  student.emit("stroke:end", { id: "s_test1" });
  const begin = await beginWait;
  assert.equal(begin.id, "s_test1");
  assert.ok(typeof begin.userId === "string" && begin.userId.startsWith("stu_"), "server tự gắn userId, không tin client");
  await appendWait;
  await endWait;

  // --- Khoá quyền vẽ: học viên gửi nét sẽ bị chặn ---
  const permWait = once(student, "perm:draw");
  teacher.emit("perm:draw", { allowed: false });
  const perm = await permWait;
  assert.equal(perm.allowed, false);

  let gotBlocked = false;
  const blockedWait = once(student, "error:msg", 1500).then(
    (m) => {
      gotBlocked = true;
      return m;
    },
    () => null
  );
  const leakWait = once(teacher, "stroke:begin", 900).then(
    () => "LEAK",
    () => "OK"
  );
  student.emit("stroke:begin", { id: "s_hack", tool: "pen", color: "#ff0000", width: 0.004, points: [[0.5, 0.5]] });
  assert.equal(await leakWait, "OK", "nét vẽ của học viên phải bị server chặn khi đã khoá bút");
  const blockedMsg = await blockedWait;
  assert.ok(gotBlocked && /khoá bút/i.test(blockedMsg.message));

  // Mở lại quyền vẽ
  teacher.emit("perm:draw", { allowed: true });
  await once(student, "perm:draw");

  // --- Undo chỉ xoá nét của người bấm ---
  teacher.emit("stroke:begin", { id: "s_t1", tool: "pen", color: "#e53e5a", width: 0.004, points: [[0.4, 0.4]] });
  teacher.emit("stroke:end", { id: "s_t1" });
  await sleep(120);
  const undoWait = once(teacher, "stroke:undo");
  student.emit("stroke:undo", {});
  const undo = await undoWait;
  assert.equal(undo.id, "s_test1", "undo của học viên chỉ xoá nét của học viên");

  // --- Vào muộn vẫn thấy nét của trang hiện tại (tiêu chí 7) ---
  teacher.emit("stroke:begin", { id: "s_t2", tool: "pen", color: "#e53e5a", width: 0.006, points: [[0.6, 0.6], [0.7, 0.7]] });
  teacher.emit("stroke:end", { id: "s_t2" });
  await sleep(150);
  const late = await connect(await newStudentToken(code, "Bé Vào Muộn"), code);
  const lateState = await late.firstState;
  assert.equal(lateState.pageKey, "lesson:1");
  assert.ok(
    lateState.strokes.some((s) => s.id === "s_t2"),
    "người vào muộn phải thấy nét của trang hiện tại"
  );
  late.close();

  // --- Xoá hết: chỉ giáo viên ---
  const stuClearErr = once(student, "error:msg");
  student.emit("board:clear", {});
  assert.match((await stuClearErr).message, /giáo viên/i);
  const clearWait = once(student, "board:clear");
  teacher.emit("board:clear", {});
  await clearWait;
  const afterClear = await connect(await newStudentToken(code, "Bé Kiểm Tra Xoá"), code);
  const clearedState = await afterClear.firstState;
  assert.equal(clearedState.strokes.length, 0, "xoá hết phải làm rỗng nét của trang");
  afterClear.close();

  // --- Sao thưởng (gom sự kiện vì có nhiều emit liên tiếp) ---
  const starLog = [];
  student.on("star:give", (p) => starLog.push(p));
  teacher.emit("star:give", { delta: 1 });
  teacher.emit("star:give", { delta: 1 });
  assert.ok(await until(() => starLog.length >= 2), "phải nhận đủ 2 sự kiện sao");
  assert.equal(starLog[0].stars, 1);
  assert.equal(starLog[1].stars, 2);
  teacher.emit("star:give", { delta: -1 });
  assert.ok(await until(() => starLog.length >= 3));
  assert.equal(starLog[2].stars, 1, "trừ sao phải giảm");
  for (let i = 0; i < 10; i += 1) teacher.emit("star:give", { delta: 1 });
  await sleep(250);
  const s3 = await connect(await newStudentToken(code, "Bé Kiểm Tra Sao"), code);
  const st3 = await s3.firstState;
  assert.equal(st3.stars, 5, "sao bị chặn ở mức 5");
  s3.close();

  // --- Chế độ màn hình + trạng thái share ---
  const screenWait = once(student, "screen:state");
  teacher.emit("screen:state", { active: true, width: 2560, height: 1440 });
  const sc = await screenWait;
  assert.equal(sc.active, true);
  assert.equal(sc.width, 2560);
  assert.equal(sc.uid, 100001);

  const modeWait = once(student, "mode:set");
  teacher.emit("mode:set", { mode: "screen" });
  const mode = await modeWait;
  assert.equal(mode.mode, "screen");
  assert.equal(mode.pageKey, "screen");

  // Học viên không tự đổi mode được
  const modeErr = once(student, "error:msg");
  student.emit("mode:set", { mode: "lesson" });
  assert.match((await modeErr).message, /giáo viên/i);

  teacher.emit("screen:state", { active: false });
  await once(student, "screen:state");

  teacher.close();
  student.close();
});

test("hai tab cùng một người: tab cũ bị ngắt (mục 13)", async () => {
  const code = globalThis.__code;
  const first = await connect(globalThis.__studentToken, code);
  await first.firstState;
  const replaced = once(first, "session:replaced");
  const second = await connect(globalThis.__studentToken, code);
  await second.firstState;
  const msg = await replaced;
  assert.match(msg.message, /tab khác/i);
  await sleep(150);
  assert.equal(first.connected, false, "tab cũ phải bị ngắt");
  second.close();
});

test("giáo viên rời: học viên nhận teacher:left, phòng vẫn giữ (mục 13)", async () => {
  const code = globalThis.__code;
  const teacher = await connect(globalThis.__teacherToken, code);
  await teacher.firstState;
  const student = await connect(globalThis.__studentToken, code);
  await student.firstState;

  const leftWait = once(student, "teacher:left");
  teacher.close();
  const left = await leftWait;
  assert.equal(left.graceMinutes, 10);

  // Phòng vẫn còn: học viên mới vào được
  const info = await json(`/api/rooms/${code}`, { token: globalThis.__studentToken });
  assert.equal(info.status, 200);
  assert.equal(info.data.room.active, true);
  student.close();
});

test("kết thúc phòng: mọi người nhận room:ended và không vào lại được", async () => {
  const code = globalThis.__code;
  const teacher = await connect(globalThis.__teacherToken, code);
  await teacher.firstState;
  const student = await connect(globalThis.__studentToken, code);
  await student.firstState;
  const endedStudent = once(student, "room:ended");
  const endedTeacher = once(teacher, "room:ended");

  const end = await json(`/api/rooms/${code}/end`, { method: "POST", token: globalThis.__teacherToken, body: {} });
  assert.equal(end.status, 200);
  await endedStudent;
  await endedTeacher;

  await sleep(200);
  const joinAgain = await json(`/api/rooms/${code}/join`, { method: "POST", body: { name: "Bé khác" } });
  assert.equal(joinAgain.status, 410, "phòng đã kết thúc thì không vào được nữa");

  await assert.rejects(() => connect(globalThis.__teacherToken, code), /ROOM_GONE|không tồn tại/i);
});

test("không lộ bí mật trong mã client", async () => {
  const files = ["/js/api.js", "/js/room.js", "/js/agora.js", "/js/whiteboard.js", "/js/home.js", "/index.html", "/room.html"];
  for (const f of files) {
    const res = await fetch(BASE + f);
    const text = await res.text();
    assert.ok(!text.includes(process.env.AGORA_APP_CERT), `${f} không được chứa AGORA_APP_CERT`);
    assert.ok(!text.includes(process.env.JWT_SECRET), `${f} không được chứa JWT_SECRET`);
  }
});

test("bộ nhớ tiến trình dưới 150 MB (mục 2.1)", () => {
  const rss = process.memoryUsage().rss / 1024 / 1024;
  assert.ok(rss < 150, `RSS đang là ${rss.toFixed(1)} MB`);
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* bỏ qua */
  }
  try {
    server.closeAllConnections?.();
  } catch {
    /* bỏ qua */
  }
  server.close();
});
