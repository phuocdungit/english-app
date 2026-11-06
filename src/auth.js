/**
 * src/auth.js
 * Tạo và kiểm tra JWT phiên làm việc. Role/userId luôn do server quyết định.
 */
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { safeEqual, sanitizeName } from "./util.js";

const ISSUER = "english-app";

/**
 * Ký token phiên.
 * @param {{userId:string,name:string,role:"teacher"|"student",code?:string}} payload
 */
export function signSession(payload) {
  return jwt.sign(
    {
      userId: String(payload.userId),
      name: sanitizeName(payload.name, config.limits.maxNameLength) || (payload.role === "teacher" ? "Cô giáo" : "Học viên"),
      role: payload.role === "teacher" ? "teacher" : "student",
      code: payload.code ? String(payload.code).toUpperCase() : undefined,
    },
    config.jwtSecret,
    {
      issuer: ISSUER,
      expiresIn: `${config.sessionTtlHours}h`,
    }
  );
}

/** Giải mã token, trả về null nếu sai/hết hạn. */
export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const data = jwt.verify(token, config.jwtSecret, { issuer: ISSUER });
    if (!data || (data.role !== "teacher" && data.role !== "student")) return null;
    return { userId: String(data.userId), name: String(data.name || ""), role: data.role, code: data.code || null };
  } catch {
    return null;
  }
}

/** Lấy token từ header Authorization: Bearer xxx. */
export function bearerFrom(req) {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** Middleware: yêu cầu JWT hợp lệ. */
export function requireAuth(req, res, next) {
  const session = verifySession(bearerFrom(req));
  if (!session) return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại." });
  req.session = session;
  return next();
}

/** Middleware: yêu cầu vai trò giáo viên. */
export function requireTeacher(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Chưa đăng nhập." });
  if (req.session.role !== "teacher") return res.status(403).json({ error: "Chỉ giáo viên mới thực hiện được thao tác này." });
  return next();
}

/** Kiểm tra mật khẩu giáo viên (so sánh an toàn theo thời gian). */
export function checkTeacherPassword(password) {
  return typeof password === "string" && password.length > 0 && safeEqual(config.teacherPassword, password);
}
