/**
 * src/db.js
 * Lưu dữ liệu ra file JSON (data/db.json), ghi nguyên tử (ghi file tạm rồi đổi tên)
 * để không bao giờ để lại file hỏng nếu tiến trình bị kill giữa chừng.
 * Không dùng thư viện cần biên dịch native (mục 2).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { generateId, generateRoomCode } from "./util.js";

const DB_FILE = config.paths.dbFile;
const TMP_FILE = DB_FILE + ".tmp";

const EMPTY = { lessons: [], rooms: [] };

let cache = null;

function isValidShape(data) {
  return data && typeof data === "object" && Array.isArray(data.lessons) && Array.isArray(data.rooms);
}

/** Đọc db từ đĩa (có cache trong bộ nhớ). */
export function read() {
  if (cache) return cache;
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      cache = isValidShape(parsed) ? parsed : structuredClone(EMPTY);
    } else {
      cache = structuredClone(EMPTY);
      persist();
    }
  } catch (err) {
    console.error("[db] Không đọc được data/db.json, tạo mới:", err.message);
    cache = structuredClone(EMPTY);
  }
  return cache;
}

/** Ghi nguyên tử ra đĩa. */
export function persist() {
  const data = cache || EMPTY;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(TMP_FILE, DB_FILE);
}

function mutate(fn) {
  const db = read();
  const result = fn(db);
  persist();
  return result;
}

/* ---------------- Bài học ---------------- */

export function listLessons() {
  return read()
    .lessons.slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getLesson(id) {
  return read().lessons.find((l) => l.id === id) || null;
}

export function addLesson({ id, title, type, slides = [], videoUrl = null }) {
  const lesson = {
    id: id || generateId("les"),
    title: String(title).slice(0, 120),
    type: type === "video" ? "video" : "slides",
    slides: type === "video" ? [] : slides.slice(0, config.limits.maxSlidesPerLesson),
    videoUrl: type === "video" ? videoUrl : null,
    createdAt: Date.now(),
  };
  return mutate((db) => {
    db.lessons.push(lesson);
    return lesson;
  });
}

export function removeLesson(id) {
  return mutate((db) => {
    const idx = db.lessons.findIndex((l) => l.id === id);
    if (idx === -1) return null;
    const [removed] = db.lessons.splice(idx, 1);
    return removed;
  });
}

/* ---------------- Phòng học ---------------- */

/** Mã phòng chưa trùng trong db. */
export function newRoomCode(length = 6) {
  const db = read();
  const taken = new Set(db.rooms.map((r) => r.code));
  for (let i = 0; i < 40; i += 1) {
    const code = generateRoomCode(length);
    if (!taken.has(code)) return code;
  }
  // Cực kỳ hiếm: tăng độ dài mã
  return generateRoomCode(8);
}

export function listRooms() {
  return read().rooms.slice();
}

export function getRoomRecord(code) {
  return read().rooms.find((r) => r.code === code) || null;
}

export function addRoomRecord({ code, lessonId, agoraUids = {} }) {
  const record = {
    code,
    lessonId,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    stars: 0,
    agoraUids,
  };
  return mutate((db) => {
    db.rooms.push(record);
    return record;
  });
}

export function updateRoomRecord(code, patch) {
  return mutate((db) => {
    const room = db.rooms.find((r) => r.code === code);
    if (!room) return null;
    Object.assign(room, patch);
    return room;
  });
}

export function setRoomStars(code, stars) {
  return updateRoomRecord(code, { stars });
}

export function setRoomUid(code, userId, uid) {
  return mutate((db) => {
    const room = db.rooms.find((r) => r.code === code);
    if (!room) return null;
    room.agoraUids = room.agoraUids || {};
    room.agoraUids[userId] = uid;
    return room;
  });
}

/** Phòng còn dùng được: chưa kết thúc và chưa quá ROOM_TTL_HOURS. */
export function isRoomActive(record, now = Date.now()) {
  if (!record || record.endedAt) return false;
  const ttlMs = config.roomTtlHours * 3600 * 1000;
  return now - record.createdAt < ttlMs;
}

/** Xoá các phòng/bản ghi quá hạn (chạy mỗi giờ, mục 12.9). */
export function purgeExpired(now = Date.now()) {
  const ttlMs = config.roomTtlHours * 3600 * 1000;
  return mutate((db) => {
    const before = db.rooms.length;
    db.rooms = db.rooms.filter((r) => {
      const expired = now - r.createdAt >= ttlMs;
      const endedLongAgo = r.endedAt && now - r.endedAt >= 3600 * 1000;
      return !(expired || endedLongAgo);
    });
    return before - db.rooms.length;
  });
}

/** Dung lượng thư mục uploads (byte). */
export function uploadsSize(dir = config.paths.uploadsDir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* bỏ qua file vừa bị xoá */
        }
      }
    }
  }
  return total;
}
