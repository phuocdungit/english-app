/**
 * src/routes/lesson.routes.js
 * Quản lý bài học: danh sách, tạo (upload nhiều ảnh hoặc URL video), xoá.
 * Bảo mật upload (mục 12.5): chỉ nhận jpeg/png/webp, kiểm tra magic bytes,
 * đổi tên file bằng id ngẫu nhiên, không cho path traversal.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { config } from "../config.js";
import * as db from "../db.js";
import { requireAuth, requireTeacher } from "../auth.js";
import { asyncHandler, generateId, isNonEmptyString, sniffImageMime, EXT_BY_MIME } from "../util.js";
import { serializeLesson } from "./room.routes.js";

export const lessonRouter = express.Router();

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const UPLOAD_ROOT = path.resolve(config.paths.uploadsDir);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      if (!req.lessonDraft) {
        const id = generateId("les");
        const dir = path.join(UPLOAD_ROOT, id);
        fs.mkdirSync(dir, { recursive: true });
        req.lessonDraft = { id, dir };
      }
      cb(null, req.lessonDraft.dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    // Tên tạm, sẽ đổi thành <số thứ tự>_<ngẫu nhiên>.<ext> sau khi kiểm tra magic bytes
    cb(null, `${crypto.randomBytes(10).toString("hex")}.part`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.limits.maxSlideBytes, files: config.limits.maxSlidesPerLesson, fields: 8 },
  fileFilter(req, file, cb) {
    if (file.fieldname !== "files") return cb(new Error("FIELD: Chỉ chấp nhận trường files[] cho ảnh."));
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("MIME: Chỉ chấp nhận ảnh JPEG, PNG hoặc WEBP."));
    }
    return cb(null, true);
  },
});

/** Xoá sạch thư mục nháp khi có lỗi. */
function discardDraft(req) {
  const dir = req.lessonDraft?.dir;
  if (dir && dir.startsWith(UPLOAD_ROOT)) fs.rmSync(dir, { recursive: true, force: true });
}

function readHead(filePath, bytes = 16) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- Danh sách bài học ---------- */
lessonRouter.get("/", requireAuth, requireTeacher, (req, res) => {
  res.json({ lessons: db.listLessons().map(serializeLesson) });
});

/* ---------- Tạo bài học ---------- */
lessonRouter.post(
  "/",
  requireAuth,
  requireTeacher,
  (req, res, next) => {
    upload.array("files", config.limits.maxSlidesPerLesson)(req, res, (err) => {
      if (!err) return next();
      discardDraft(req);
      if (err instanceof multer.MulterError) {
        const msg =
          err.code === "LIMIT_FILE_SIZE"
            ? `Ảnh vượt quá ${Math.round(config.limits.maxSlideBytes / 1024 / 1024)} MB.`
            : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
              ? `Tối đa ${config.limits.maxSlidesPerLesson} ảnh cho một bài học.`
              : `Lỗi tải file lên: ${err.message}`;
        return res.status(400).json({ error: msg });
      }
      return res.status(400).json({ error: err.message || "Không tải được file lên." });
    });
  },
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const type = body.type === "video" ? "video" : "slides";
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) {
      discardDraft(req);
      return res.status(400).json({ error: "Hãy nhập tên bài học." });
    }

    let slides = [];

    if (type === "slides") {
      const files = req.files || [];
      if (!files.length) {
        discardDraft(req);
        return res.status(400).json({ error: "Hãy chọn ít nhất một ảnh slide." });
      }
      const lessonId = req.lessonDraft.id;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const mime = sniffImageMime(readHead(file.path));
        if (!mime) {
          discardDraft(req);
          return res
            .status(400)
            .json({ error: `File "${file.originalname}" không phải ảnh JPEG/PNG/WEBP hợp lệ.` });
        }
        const finalName = `${String(i + 1).padStart(3, "0")}_${crypto.randomBytes(8).toString("hex")}${EXT_BY_MIME[mime]}`;
        const finalPath = path.join(req.lessonDraft.dir, finalName);
        fs.renameSync(file.path, finalPath);
        // URL công khai, không lộ đường dẫn vật lý
        slides.push(`/uploads/${lessonId}/${finalName}`);
      }
      const lesson = db.addLesson({ id: lessonId, title, type: "slides", slides });
      return finish(res, lesson);
    }

    // type = video
    discardDraft(req); // video không cần thư mục upload
    const videoUrl = String(body.videoUrl || "").trim();
    if (!isNonEmptyString(videoUrl, 600)) {
      return res.status(400).json({ error: "Hãy nhập URL video (mp4 hoặc m3u8)." });
    }
    let parsed;
    try {
      parsed = new URL(videoUrl);
    } catch {
      return res.status(400).json({ error: "URL video không hợp lệ." });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ error: "URL video phải bắt đầu bằng http:// hoặc https://." });
    }
    const lesson = db.addLesson({ title, type: "video", videoUrl: parsed.toString() });
    return finish(res, lesson);
  })
);

function finish(res, lesson) {
  const total = db.uploadsSize();
  const payload = { lesson: serializeLesson(lesson) };
  if (total > config.limits.uploadsWarnBytes) {
    payload.warning = `Thư mục uploads đã dùng ${(total / 1024 / 1024).toFixed(0)} MB (vượt ngưỡng 700 MB). Hãy xoá bớt bài học cũ.`;
    console.warn("[uploads]", payload.warning);
  }
  return res.status(201).json(payload);
}

/* ---------- Xoá bài học ---------- */
lessonRouter.delete("/:id", requireAuth, requireTeacher, (req, res) => {
  const id = String(req.params.id || "");
  if (!/^les_[A-Za-z0-9_-]{1,40}$/.test(id)) return res.status(400).json({ error: "Mã bài học không hợp lệ." });

  const lesson = db.getLesson(id);
  if (!lesson) return res.status(404).json({ error: "Không tìm thấy bài học." });

  const inUse = db
    .listRooms()
    .some((r) => r.lessonId === id && db.isRoomActive(r));
  if (inUse) return res.status(409).json({ error: "Bài học đang được dùng trong một phòng còn hoạt động." });

  db.removeLesson(id);

  // Chống path traversal: chỉ xoá đúng thư mục con của uploads/
  const dir = path.resolve(path.join(UPLOAD_ROOT, id));
  if (dir.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return res.json({ ok: true, id });
});
