/**
 * src/config.js
 * Đọc biến môi trường và kiểm tra các giá trị bắt buộc.
 * Server sẽ TỪ CHỐI khởi động nếu thiếu cấu hình quan trọng (mục 4 của đặc tả).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, "..");

// Nạp file .env nằm ở thư mục gốc dự án (không phụ thuộc vào thư mục chạy lệnh)
dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

const REQUIRED = ["AGORA_APP_ID", "AGORA_APP_CERT", "JWT_SECRET", "TEACHER_PASSWORD"];

function fail(messages) {
  console.error("\n[KHỞI ĐỘNG THẤT BẠI] Thiếu hoặc sai cấu hình:");
  for (const m of messages) console.error("  - " + m);
  console.error("\nHãy sao chép .env.example thành .env rồi điền giá trị,");
  console.error("hoặc đặt các biến này trong phần Environment của panel hosting.\n");
  process.exit(1);
}

function readConfig() {
  const problems = [];

  const raw = (key) => (process.env[key] ?? "").trim();

  const AGORA_APP_ID = raw("AGORA_APP_ID");
  const AGORA_APP_CERT = raw("AGORA_APP_CERT");
  const JWT_SECRET = raw("JWT_SECRET");
  const TEACHER_PASSWORD = raw("TEACHER_PASSWORD");

  if (!AGORA_APP_ID) problems.push("AGORA_APP_ID còn trống (lấy trong Agora Console > Project).");
  if (!AGORA_APP_CERT) problems.push("AGORA_APP_CERT còn trống (bắt buộc bật Primary Certificate trong Agora Console).");
  if (!JWT_SECRET) problems.push("JWT_SECRET còn trống.");
  else if (JWT_SECRET.length < 32) problems.push("JWT_SECRET phải dài tối thiểu 32 ký tự.");
  if (!TEACHER_PASSWORD) problems.push("TEACHER_PASSWORD còn trống.");

  if (problems.length) fail(problems);

  const port = Number(raw("SERVER_PORT") || raw("PORT") || 3000);
  const publicUrl = (raw("PUBLIC_URL") || `http://localhost:${port}`).replace(/\/+$/, "");
  const ttlHours = Number(raw("ROOM_TTL_HOURS") || 12);

  // Đường dẫn dữ liệu (cho phép ghi đè để chạy test cách ly)
  const resolveDir = (value, fallback) => (value ? path.resolve(ROOT_DIR, value) : fallback);
  const dataDir = resolveDir(raw("DATA_DIR"), path.join(ROOT_DIR, "data"));
  const uploadsDir = resolveDir(raw("UPLOADS_DIR"), path.join(ROOT_DIR, "uploads"));
  const publicDir = path.join(ROOT_DIR, "public");
  for (const dir of [dataDir, uploadsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  return Object.freeze({
    env: process.env.NODE_ENV || "development",
    isProduction: (process.env.NODE_ENV || "") === "production",

    agora: Object.freeze({
      // Đặt AGORA_DISABLED=true khi chỉ muốn thử giao diện/bảng vẽ mà chưa có App ID thật
      disabled: raw("AGORA_DISABLED").toLowerCase() === "true",
      appId: AGORA_APP_ID,
      appCert: AGORA_APP_CERT,
      // Token Agora hết hạn sau 2 giờ (mục 7.1)
      tokenTtlSeconds: Number(raw("AGORA_TOKEN_TTL_SECONDS") || 2 * 3600),
      // uid màn hình = uid camera + offset (mục A6)
      screenUidOffset: 100000,
      // Phiên bản SDK Web cố định, dùng cho cả CDN lẫn bản dự phòng cục bộ
      sdkVersion: raw("AGORA_SDK_VERSION") || "4.24.9",
    }),

    jwtSecret: JWT_SECRET,
    sessionTtlHours: Number(raw("SESSION_TTL_HOURS") || ttlHours || 12),
    teacherPassword: TEACHER_PASSWORD,

    port: Number.isFinite(port) ? port : 3000,
    host: raw("SERVER_HOST") || "0.0.0.0",
    publicUrl,

    roomTtlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12,
    // Khi giáo viên thoát đột ngột, phòng được giữ 10 phút để cô quay lại (mục 13)
    teacherGraceMinutes: Number(raw("TEACHER_GRACE_MINUTES") || 10),

    maxStudentsPerRoom: Number(raw("MAX_STUDENTS_PER_ROOM") || 4),

    paths: Object.freeze({ root: ROOT_DIR, dataDir, uploadsDir, publicDir, dbFile: path.join(dataDir, "db.json") }),

    limits: Object.freeze({
      maxSlideBytes: 5 * 1024 * 1024, // 5 MB/ảnh
      maxSlidesPerLesson: 40, // 40 ảnh/bài học
      uploadsWarnBytes: 700 * 1024 * 1024, // cảnh báo khi uploads/ vượt 700 MB
      maxStrokesPerPage: 2000,
      maxPointsPerStroke: 2000,
      drawEventsPerSecond: 60,
      laserEventsPerSecond: 30,
      maxHttpBufferSize: 1e5, // payload Socket.IO < 20 KB thực tế, trần 100 KB
      maxNameLength: 30,
    }),

    // Bật/tắt Content-Security-Policy (mặc định bật). Đặt CSP_ENABLED=false để gỡ lỗi Agora.
    cspEnabled: raw("CSP_ENABLED").toLowerCase() !== "false",
    logLevel: raw("LOG_LEVEL") || (process.env.NODE_ENV === "production" ? "warn" : "info"),
  });
}

export const config = readConfig();

/** Cảnh báo (không chặn khởi động) nếu cấu hình Agora trông giống giá trị mẫu. */
export function warnIfPlaceholderAgora() {
  const id = config.agora.appId;
  const looksFake = !/^[0-9a-f]{32}$/i.test(id);
  if (looksFake) {
    console.warn(
      "[CẢNH BÁO] AGORA_APP_ID không giống App ID thật (32 ký tự hex). " +
        "Giao diện và bảng vẽ vẫn chạy, nhưng gọi video sẽ KHÔNG hoạt động cho tới khi điền App ID/App Certificate thật."
    );
  }
}

export default config;
