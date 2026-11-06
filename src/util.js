/**
 * src/util.js
 * Các hàm tiện ích dùng chung phía server.
 */
import crypto from "node:crypto";

/**
 * So sánh hai chuỗi mật khẩu/chuỗi bí mật an toàn theo thời gian (mục 12.3).
 * timingSafeEqual yêu cầu 2 buffer cùng độ dài, nên ta băm SHA-256 cả hai trước.
 */
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Bảng ký tự dễ đọc, đã loại 0/O/1/I (mục 5.2). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Sinh mã phòng ngẫu nhiên bằng crypto, mặc định 6 ký tự. */
export function generateRoomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Sinh id có tiền tố, ví dụ les_abc123. */
export function generateId(prefix = "id", size = 10) {
  return `${prefix}_${crypto.randomBytes(size).toString("base64url").slice(0, size)}`;
}

/** Cắt/loại bỏ ký tự điều khiển và giới hạn độ dài tên hiển thị (mục 12.6). */
export function sanitizeName(value, max = 30) {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>]/g, "")
    .trim();
  return cleaned.slice(0, max);
}

export function isNonEmptyString(v, max = 512) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export function toFiniteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Chuẩn hoá mã phòng nhận từ URL/body. */
export function normalizeRoomCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

/**
 * Kiểm tra "magic bytes" của ảnh để chắc chắn nội dung file đúng với đuôi mở rộng
 * (mục 12.5). Trả về mime thật hoặc null nếu không phải ảnh được phép.
 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
    return "image/png";
  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

export const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/**
 * URL gốc công khai để dựng link phòng.
 * - Production: luôn dùng PUBLIC_URL đã khai báo (an toàn, chống Host header injection).
 * - Development: dùng đúng origin người dùng đang truy cập (hữu ích khi xem qua
 *   tunnel/preview hoặc IP LAN mà chưa đổi PUBLIC_URL).
 */
export function publicBaseFor(req, fallback) {
  const cfg = fallback || "";
  if (process.env.NODE_ENV === "production") return cfg;
  const fwdProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const fwdHost = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = fwdProto || req?.protocol || "http";
  const host = fwdHost || req?.headers?.host || "";
  return host ? `${proto}://${host}` : cfg;
}

/** Bao lỗi async cho route Express 4 (tránh lặp try/catch). */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
