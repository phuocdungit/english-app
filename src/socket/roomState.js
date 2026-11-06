/**
 * src/socket/roomState.js
 * Trạng thái phòng học giữ TRONG BỘ NHỚ (nét vẽ, trang, quyền, sao, người tham gia).
 * Dữ liệu bền (danh sách phòng, bài học, sao) nằm ở db.js.
 */
import { config } from "../config.js";
import * as db from "../db.js";

const rooms = new Map(); // code -> Room

const { maxStrokesPerPage, maxPointsPerStroke, maxStudentsPerRoom } = config.limits;

export function pageKey(mode, pageIndex) {
  return mode === "screen" ? "screen" : `lesson:${Number(pageIndex) || 0}`;
}

function makeRoom(record) {
  return {
    code: record.code,
    lessonId: record.lessonId,
    createdAt: record.createdAt,
    startedAt: record.startedAt || null,
    ended: Boolean(record.endedAt),

    /** socketId -> { socketId, userId, name, role, agoraUid, joinedAt } */
    participants: new Map(),
    /** userId -> agoraUid (cấp phát ổn định, lưu cả vào db để reconnect không đổi uid) */
    uids: new Map(Object.entries(record.agoraUids || {}).map(([k, v]) => [k, Number(v)])),

    mode: "lesson", // "lesson" | "screen"
    pageIndex: 0,
    video: { playing: false, time: 0, updatedAt: 0 },
    screen: { active: false, width: 1920, height: 1080, uid: null },
    studentCanDraw: true,
    stars: Number(record.stars) || 0,

    /** pageKey -> Stroke[] */
    strokes: new Map(),

    teacherLeftAt: null,
    graceTimer: null,
  };
}

/** Lấy phòng trong bộ nhớ; nếu chưa có thì dựng lại từ db (sau khi server khởi động lại). */
export function ensureRoom(code) {
  if (!code) return null;
  const existing = rooms.get(code);
  if (existing && !existing.ended) return existing;

  const record = db.getRoomRecord(code);
  if (!record || !db.isRoomActive(record)) return null;

  const room = makeRoom(record);
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code) || null;
}

export function putRoom(code, room) {
  rooms.set(code, room);
}

export function deleteRoom(code) {
  const room = rooms.get(code);
  if (room?.graceTimer) clearTimeout(room.graceTimer);
  rooms.delete(code);
}

export function allRooms() {
  return [...rooms.values()];
}

/* ---------------- Người tham gia ---------------- */

export function addParticipant(room, socketId, { userId, name, role }) {
  const agoraUid = allocateUid(room, userId, role);
  const participant = { socketId, userId, name, role, agoraUid, joinedAt: Date.now() };
  room.participants.set(socketId, participant);

  if (!room.startedAt && role === "teacher") {
    room.startedAt = Date.now();
    db.updateRoomRecord(room.code, { startedAt: room.startedAt });
  }
  if (role === "teacher") {
    room.teacherLeftAt = null;
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
  }
  return participant;
}

export function removeParticipant(room, socketId) {
  const p = room.participants.get(socketId);
  if (!p) return null;
  room.participants.delete(socketId);
  return p;
}

export function presenceOf(room) {
  return [...room.participants.values()].map((p) => ({
    userId: p.userId,
    name: p.name,
    role: p.role,
    agoraUid: p.agoraUid,
    media: p.media || { mic: true, cam: true },
  }));
}

export function teacherPresent(room) {
  for (const p of room.participants.values()) if (p.role === "teacher") return true;
  return false;
}

export function studentCount(room) {
  let n = 0;
  const seen = new Set();
  for (const p of room.participants.values()) {
    if (p.role === "student" && !seen.has(p.userId)) {
      seen.add(p.userId);
      n += 1;
    }
  }
  return n;
}

export function isFull(room) {
  return studentCount(room) >= maxStudentsPerRoom;
}

/**
 * Cấp phát uid Agora do SERVER quyết định (mục 7.1):
 * - giáo viên: uid = 1
 * - học viên: uid = 2..(1+maxStudents), lấy số nhỏ nhất còn trống
 * uid được nhớ theo userId nên F5/kết nối lại vẫn giữ nguyên uid.
 */
export function allocateUid(room, userId, role) {
  const cached = room.uids.get(userId);
  if (typeof cached === "number" && cached > 0) return cached;

  let uid;
  if (role === "teacher") {
    uid = 1;
  } else {
    const used = new Set(room.uids.values());
    uid = 2;
    while (used.has(uid) && uid <= 1 + maxStudentsPerRoom) uid += 1;
    if (uid > 1 + maxStudentsPerRoom) uid = 2 + (room.uids.size % maxStudentsPerRoom);
  }
  room.uids.set(userId, uid);
  db.setRoomUid(room.code, userId, uid);
  return uid;
}

export function uidOf(room, userId) {
  return room.uids.get(userId) || null;
}

/* ---------------- Nét vẽ ---------------- */

export function strokesOf(room, key) {
  if (!room.strokes.has(key)) room.strokes.set(key, []);
  return room.strokes.get(key);
}

export function currentPageKey(room) {
  return pageKey(room.mode, room.pageIndex);
}

export function currentStrokes(room) {
  return strokesOf(room, currentPageKey(room));
}

export function addStroke(room, key, stroke) {
  const list = strokesOf(room, key);
  list.push(stroke);
  // Vượt giới hạn thì bỏ nét cũ nhất (mục 6.2)
  while (list.length > maxStrokesPerPage) list.shift();
  return stroke;
}

export function findStroke(room, key, id) {
  return strokesOf(room, key).find((s) => s.id === id) || null;
}

export function appendPoints(room, key, id, points) {
  const stroke = findStroke(room, key, id);
  if (!stroke) return null;
  const space = maxPointsPerStroke - stroke.points.length;
  if (space <= 0) return stroke;
  stroke.points.push(...points.slice(0, space));
  return stroke;
}

/** Undo: xoá nét CUỐI CÙNG của chính người gửi ở trang hiện tại (mục 8.1). */
export function undoLastStrokeOf(room, key, userId) {
  const list = strokesOf(room, key);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].userId === userId) {
      const [removed] = list.splice(i, 1);
      return removed;
    }
  }
  return null;
}

/** Tẩy: xoá các nét bị chạm (ids do client tính, server kiểm tra quyền). */
export function eraseStrokes(room, key, ids) {
  const list = strokesOf(room, key);
  const wanted = new Set(ids);
  const removed = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (wanted.has(list[i].id)) removed.push(list.splice(i, 1)[0].id);
  }
  return removed;
}

export function clearPage(room, key) {
  room.strokes.set(key, []);
}

/* ---------------- Trạng thái công khai gửi cho client ---------------- */

export function publicState(room) {
  const key = currentPageKey(room);
  return {
    code: room.code,
    lessonId: room.lessonId,
    mode: room.mode,
    pageIndex: room.pageIndex,
    video: { ...room.video },
    screen: { ...room.screen },
    studentCanDraw: room.studentCanDraw,
    stars: room.stars,
    participants: presenceOf(room),
    teacherPresent: teacherPresent(room),
    startedAt: room.startedAt,
    createdAt: room.createdAt,
    pageKey: key,
    strokes: strokesOf(room, key),
  };
}

/** Kết thúc phòng: đánh dấu db, xoá khỏi bộ nhớ. */
export function endRoom(room) {
  if (!room) return;
  room.ended = true;
  if (room.graceTimer) clearTimeout(room.graceTimer);
  db.updateRoomRecord(room.code, { endedAt: Date.now() });
  deleteRoom(room.code);
}

/** Dọn phòng quá hạn / không còn ai (chạy định kỳ). */
export function cleanupRooms() {
  const purgedDb = db.purgeExpired();
  let purgedMem = 0;
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const expired = now - room.createdAt >= config.roomTtlHours * 3600 * 1000;
    const empty = room.participants.size === 0 && !teacherPresent(room);
    if (room.ended || expired) {
      deleteRoom(code);
      purgedMem += 1;
    } else if (empty && now - (room.startedAt || room.createdAt) > config.roomTtlHours * 3600 * 1000) {
      deleteRoom(code);
      purgedMem += 1;
    }
  }
  return { purgedDb, purgedMem, remaining: rooms.size };
}
