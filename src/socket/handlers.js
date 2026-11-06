/**
 * src/socket/handlers.js
 * Xử lý các sự kiện Socket.IO: nét vẽ, trang, quyền, sao, share màn hình.
 * MỌI quyền đều kiểm tra tại server (mục 12.1) — client không tự khai role/userId.
 */
import { config } from "../config.js";
import * as db from "../db.js";
import { clamp, toFiniteNumber } from "../util.js";
import * as state from "./roomState.js";

const { drawEventsPerSecond, laserEventsPerSecond, maxPointsPerStroke } = config.limits;

const TOOLS = new Set(["pen", "highlighter", "eraser"]);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/* ---------- Bộ giới hạn tốc độ theo "token bucket" cho từng socket ---------- */
function makeLimiter(perSecond) {
  let tokens = perSecond;
  let last = Date.now();
  return function take() {
    const now = Date.now();
    tokens = Math.min(perSecond, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/* ---------- Làm sạch dữ liệu client gửi lên ---------- */

function cleanId(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= 64 ? v : null;
}

function cleanPoints(raw, maxCount = 512) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const n = Math.min(raw.length, maxCount);
  for (let i = 0; i < n; i += 1) {
    const p = raw[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = toFiniteNumber(p[0], NaN);
    const y = toFiniteNumber(p[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Cho phép hơi tràn viền một chút (nét bắt đầu sát mép), nhưng chặn số vô lý
    out.push([clamp(x, -0.25, 1.25), clamp(y, -0.25, 1.25)]);
  }
  return out;
}

function cleanStrokePayload(payload, session) {
  if (!payload || typeof payload !== "object") return null;
  const id = cleanId(payload.id);
  if (!id) return null;
  const tool = TOOLS.has(payload.tool) ? payload.tool : "pen";
  const color = COLOR_RE.test(String(payload.color || "")) ? String(payload.color).toLowerCase() : "#e53e5a";
  const width = clamp(toFiniteNumber(payload.width, 0.004), 0.0005, 0.05);
  const points = cleanPoints(payload.points);
  return { id, userId: session.userId, tool, color, width, points };
}

/** Đăng ký toàn bộ handler cho một socket đã xác thực. */
export function registerHandlers(io, socket, session) {
  const code = session.code;
  const drawLimiter = makeLimiter(drawEventsPerSecond);
  const laserLimiter = makeLimiter(laserEventsPerSecond);

  const room = () => {
    const r = state.getRoom(code);
    return r && !r.ended ? r : null;
  };

  const fail = (message) => socket.emit("error:msg", { message });

  const isTeacher = () => session.role === "teacher";

  const canDraw = (r) => isTeacher() || (r && r.studentCanDraw);

  /** Lấy room hoặc báo lỗi. */
  const needRoom = () => {
    const r = room();
    if (!r) {
      fail("Phòng không còn tồn tại hoặc đã kết thúc.");
      socket.emit("room:ended", {});
      return null;
    }
    return r;
  };

  /* ---------------- Nét vẽ ---------------- */

  socket.on("stroke:begin", (payload) => {
    const r = needRoom();
    if (!r || !drawLimiter()) return;
    if (!canDraw(r)) return fail("Cô đang tạm khoá bút của bạn.");
    const stroke = cleanStrokePayload(payload, session);
    if (!stroke) return;
    stroke.points = stroke.points.slice(0, maxPointsPerStroke);
    const key = state.currentPageKey(r);
    state.addStroke(r, key, stroke);
    socket.to(code).emit("stroke:begin", { ...stroke, pageKey: key });
  });

  socket.on("stroke:append", (payload) => {
    const r = needRoom();
    if (!r || !drawLimiter()) return;
    if (!canDraw(r)) return;
    if (!payload || typeof payload !== "object") return;
    const id = cleanId(payload.id);
    if (!id) return;
    const key = state.currentPageKey(r);
    const points = cleanPoints(payload.points, 512);
    if (!points.length) return;
    const stroke = state.appendPoints(r, key, id, points);
    if (!stroke) return; // nét không tồn tại (có thể đã bị xoá) -> bỏ qua im lặng
    socket.to(code).emit("stroke:append", { id, points, pageKey: key });
  });

  socket.on("stroke:end", (payload) => {
    const r = needRoom();
    if (!r || !drawLimiter()) return;
    if (!canDraw(r)) return;
    const id = cleanId(payload?.id);
    if (!id) return;
    socket.to(code).emit("stroke:end", { id, userId: session.userId, pageKey: state.currentPageKey(r) });
  });

  socket.on("stroke:undo", () => {
    const r = needRoom();
    if (!r || !drawLimiter()) return;
    if (!canDraw(r)) return fail("Cô đang tạm khoá bút của bạn.");
    const key = state.currentPageKey(r);
    const removed = state.undoLastStrokeOf(r, key, session.userId);
    if (!removed) return;
    socket.to(code).emit("stroke:undo", { id: removed.id, userId: session.userId, pageKey: key });
  });

  /**
   * stroke:erase — dùng cho công cụ TẨY (xoá các nét bị chạm).
   * Đặc tả mục 10.2 yêu cầu tẩy "xoá nét đã chạm" nhưng bảng sự kiện mục 8.1
   * chưa có sự kiện tương ứng, nên bổ sung sự kiện này với CÙNG quyền vẽ.
   */
  socket.on("stroke:erase", (payload) => {
    const r = needRoom();
    if (!r || !drawLimiter()) return;
    if (!canDraw(r)) return fail("Cô đang tạm khoá bút của bạn.");
    const ids = Array.isArray(payload?.ids) ? payload.ids.map(cleanId).filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return;
    const key = state.currentPageKey(r);
    const removed = state.eraseStrokes(r, key, ids);
    if (!removed.length) return;
    socket.to(code).emit("stroke:erase", { ids: removed, userId: session.userId, pageKey: key });
  });

  socket.on("board:clear", () => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới xoá được toàn bộ bảng.");
    const key = state.currentPageKey(r);
    state.clearPage(r, key);
    io.to(code).emit("board:clear", { pageKey: key, userId: session.userId });
  });

  socket.on("laser:move", (payload) => {
    const r = needRoom();
    if (!r || !laserLimiter()) return;
    if (!canDraw(r)) return;
    if (!payload || typeof payload !== "object") return;
    if (payload.off === true) {
      socket.to(code).emit("laser:move", { off: true, userId: session.userId, pageKey: state.currentPageKey(r) });
      return;
    }
    const x = toFiniteNumber(payload.x, NaN);
    const y = toFiniteNumber(payload.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    socket.to(code).emit("laser:move", {
      x: clamp(x, -0.05, 1.05),
      y: clamp(y, -0.05, 1.05),
      userId: session.userId,
      pageKey: state.currentPageKey(r),
    });
  });

  /* ---------------- Điều khiển bài học ---------------- */

  socket.on("page:set", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới đổi được trang.");
    const lesson = db.getLesson(r.lessonId);
    const total = lesson && lesson.type === "slides" ? lesson.slides.length : 1;
    const index = clamp(Math.trunc(toFiniteNumber(payload?.index, 0)), 0, Math.max(0, total - 1));
    r.pageIndex = index;
    if (r.mode !== "lesson") r.mode = "lesson";
    const key = state.pageKey("lesson", index);
    io.to(code).emit("page:set", { index, mode: r.mode, pageKey: key, strokes: state.strokesOf(r, key) });
  });

  socket.on("mode:set", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới đổi được chế độ hiển thị.");
    const mode = payload?.mode === "screen" ? "screen" : "lesson";
    r.mode = mode;
    const key = state.currentPageKey(r);
    io.to(code).emit("mode:set", { mode, pageKey: key, strokes: state.strokesOf(r, key) });
  });

  socket.on("video:control", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên điều khiển được video bài học.");
    r.video = {
      playing: Boolean(payload?.playing),
      time: clamp(toFiniteNumber(payload?.time, 0), 0, 1e6),
      updatedAt: Date.now(),
    };
    io.to(code).emit("video:control", { ...r.video });
  });

  socket.on("screen:state", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới chia sẻ màn hình được.");
    const active = Boolean(payload?.active);
    const myUid = state.uidOf(r, session.userId) || 1;
    r.screen = {
      active,
      width: clamp(Math.trunc(toFiniteNumber(payload?.width, 1920)), 160, 7680),
      height: clamp(Math.trunc(toFiniteNumber(payload?.height, 1080)), 120, 4320),
      uid: active ? myUid + config.agora.screenUidOffset : null,
    };
    if (!active && r.mode === "screen") r.mode = "lesson";
    io.to(code).emit("screen:state", { ...r.screen, mode: r.mode });
  });

  /* ---------------- Quyền, sao, trợ giúp ---------------- */

  socket.on("perm:draw", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới đổi được quyền vẽ.");
    r.studentCanDraw = payload?.allowed !== false;
    io.to(code).emit("perm:draw", { allowed: r.studentCanDraw });
  });

  socket.on("star:give", (payload) => {
    const r = needRoom();
    if (!r) return;
    if (!isTeacher()) return fail("Chỉ giáo viên mới chấm sao.");
    const delta = toFiniteNumber(payload?.delta, 0) >= 0 ? 1 : -1;
    r.stars = clamp(r.stars + delta, 0, 5);
    db.setRoomStars(r.code, r.stars);
    io.to(code).emit("star:give", { stars: r.stars, delta });
  });

  socket.on("help:request", () => {
    const r = needRoom();
    if (!r) return;
    if (isTeacher()) return;
    socket.to(code).emit("help:request", { userId: session.userId, name: session.name });
  });

  /**
   * media:state — báo trạng thái mic/camera của mình cho người khác thấy icon đúng.
   * (Bổ sung nhỏ ngoài bảng sự kiện mục 8.1: setEnabled(false) của Agora
   *  không sinh sự kiện user-unpublished nên phải báo qua Socket.IO.)
   */
  socket.on("media:state", (payload) => {
    const r = needRoom();
    if (!r) return;
    const p = socket.data.participant;
    if (!p) return;
    p.media = {
      mic: payload?.mic === undefined ? true : Boolean(payload.mic),
      cam: payload?.cam === undefined ? true : Boolean(payload.cam),
    };
    io.to(code).emit("presence", {
      participants: state.presenceOf(r),
      teacherPresent: state.teacherPresent(r),
    });
  });

  /* ---------------- Yêu cầu trạng thái (dùng khi reconnect) ---------------- */

  socket.on("room:sync", () => {
    const r = needRoom();
    if (!r) return;
    socket.emit("room:state", state.publicState(r));
  });
}
