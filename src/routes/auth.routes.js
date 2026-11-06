/**
 * src/routes/auth.routes.js
 * Đăng nhập giáo viên bằng mật khẩu -> cấp JWT.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { checkTeacherPassword, signSession } from "../auth.js";
import { sanitizeName } from "../util.js";
import { config } from "../config.js";

export const authRouter = express.Router();

// 10 lần/phút/IP (mục 7)
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Bạn thử đăng nhập quá nhiều lần. Vui lòng đợi 1 phút rồi thử lại." },
});

authRouter.post("/teacher", loginLimiter, (req, res) => {
  const { password, name } = req.body || {};
  if (!checkTeacherPassword(password)) {
    return res.status(401).json({ error: "Mật khẩu giáo viên không đúng." });
  }
  const displayName = sanitizeName(name, config.limits.maxNameLength) || "Cô giáo";
  const token = signSession({ userId: "teacher", name: displayName, role: "teacher" });
  return res.json({ token, role: "teacher", userId: "teacher", name: displayName });
});
