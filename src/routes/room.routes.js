/**
 * src/routes/room.routes.js
 * Tạo phòng, tham gia phòng, xem thông tin phòng, kết thúc phòng.
 */
import express from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import * as db from "../db.js";
import { requireAuth, requireTeacher, signSession } from "../auth.js";
import { normalizeRoomCode, sanitizeName, isNonEmptyString, publicBaseFor } from "../util.js";
import * as state from "../socket/roomState.js";
import { broadcastRoomEnded } from "../socket/index.js";

export const roomRouter = express.Router();

const joinLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu vào phòng từ mạng của bạn. Vui lòng đợi 1 phút." },
});

/** Bài học trả về cho client (không chứa đường dẫn vật lý trên server). */
export function serializeLesson(lesson) {
  if (!lesson) return null;
  return {
    id: lesson.id,
    title: lesson.title,
    type: lesson.type,
    slides: lesson.slides || [],
    videoUrl: lesson.videoUrl || null,
    createdAt: lesson.createdAt,
  };
}

export function serializeRoom(record, base = config.publicUrl) {
  if (!record) return null;
  return {
    code: record.code,
    lessonId: record.lessonId,
    lesson: serializeLesson(db.getLesson(record.lessonId)),
    createdAt: record.createdAt,
    startedAt: record.startedAt || null,
    endedAt: record.endedAt || null,
    stars: record.stars || 0,
    link: `${base}/room.html?code=${record.code}`,
    active: db.isRoomActive(record),
    maxStudents: config.maxStudentsPerRoom,
  };
}

/* ---------- Tạo phòng (giáo viên) ---------- */
roomRouter.post("/", requireAuth, requireTeacher, (req, res) => {
  const { lessonId } = req.body || {};
  if (!isNonEmptyString(lessonId, 64)) {
    return res.status(400).json({ error: "Thiếu bài học. Hãy chọn hoặc tạo bài học trước." });
  }
  const lesson = db.getLesson(lessonId);
  if (!lesson) return res.status(404).json({ error: "Không tìm thấy bài học này." });
  if (lesson.type === "slides" && (!lesson.slides || lesson.slides.length === 0)) {
    return res.status(400).json({ error: "Bài học chưa có slide nào." });
  }

  const code = db.newRoomCode(6);
  const record = db.addRoomRecord({ code, lessonId });
  state.ensureRoom(code);
  const base = publicBaseFor(req, config.publicUrl);
  return res.status(201).json({ code, link: `${base}/room.html?code=${code}`, room: serializeRoom(record, base) });
});

/* ---------- Học viên vào phòng (công khai, chỉ cần mã phòng + tên) ---------- */
roomRouter.post("/:code/join", joinLimiter, (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const name = sanitizeName((req.body || {}).name, config.limits.maxNameLength);
  if (!code) return res.status(400).json({ error: "Mã phòng không hợp lệ." });
  if (!name) return res.status(400).json({ error: "Hãy nhập tên của bạn (tối đa 30 ký tự)." });

  const record = db.getRoomRecord(code);
  if (!record) return res.status(404).json({ error: "Không tìm thấy phòng này. Hãy kiểm tra lại mã." });
  if (!db.isRoomActive(record)) {
    return res.status(410).json({ error: "Phòng đã kết thúc hoặc hết hạn. Hãy xin cô mã phòng mới." });
  }

  const room = state.ensureRoom(code);
  if (room && state.isFull(room)) {
    return res.status(403).json({ error: "Phòng đã đủ học viên." });
  }

  // Học viên không cần tài khoản: server sinh userId ngẫu nhiên cho phiên này
  const userId = `stu_${crypto.randomBytes(6).toString("base64url")}`;
  if (room) state.allocateUid(room, userId, "student");

  const token = signSession({ userId, name, role: "student", code });
  return res.json({ token, role: "student", userId, name, room: serializeRoom(record, publicBaseFor(req, config.publicUrl)) });
});

/* ---------- Xem thông tin phòng ---------- */
roomRouter.get("/:code", requireAuth, (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const record = db.getRoomRecord(code);
  if (!record) return res.status(404).json({ error: "Không tìm thấy phòng này." });
  if (req.session.role !== "teacher" && req.session.code !== code) {
    return res.status(403).json({ error: "Bạn không có quyền xem phòng này." });
  }
  return res.json({ room: serializeRoom(record, publicBaseFor(req, config.publicUrl)), expired: !db.isRoomActive(record) });
});

/* ---------- Kết thúc phòng (giáo viên) ---------- */
roomRouter.post("/:code/end", requireAuth, requireTeacher, (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const record = db.getRoomRecord(code);
  if (!record) return res.status(404).json({ error: "Không tìm thấy phòng này." });
  const room = state.getRoom(code);
  if (room) state.endRoom(room);
  else db.updateRoomRecord(code, { endedAt: Date.now() });
  broadcastRoomEnded(code);
  return res.json({ ok: true, code });
});
