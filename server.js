/**
 * server.js
 * Một tiến trình duy nhất phục vụ: giao diện (public/), API REST và Socket.IO.
 * Chạy: node server.js   (cổng lấy từ SERVER_PORT || PORT || 3000, lắng nghe 0.0.0.0)
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import helmet from "helmet";

import { config, warnIfPlaceholderAgora } from "./src/config.js";
import * as db from "./src/db.js";
import { initSocket } from "./src/socket/index.js";
import * as roomState from "./src/socket/roomState.js";
import { authRouter } from "./src/routes/auth.routes.js";
import { roomRouter } from "./src/routes/room.routes.js";
import { lessonRouter } from "./src/routes/lesson.routes.js";
import { agoraRouter } from "./src/routes/agora.routes.js";

const app = express();
// Phía trước có proxy HTTPS (Cloudflare Tunnel...) nên cần tin header X-Forwarded-*
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ---------------- Bảo mật: helmet + CSP ---------------- */

const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
  objectSrc: ["'none'"],
  // SDK Agora nạp từ CDN chính thức; bản dự phòng cục bộ nằm ở /vendor
  scriptSrc: ["'self'", "https://download.agora.io", "https://cdn.jsdelivr.net", "https://unpkg.com"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:"],
  mediaSrc: ["'self'", "blob:", "data:", "mediastream:"],
  fontSrc: ["'self'", "data:"],
  // Agora cần kết nối tới nhiều cụm máy chủ (agora.io, sd-rtn.com...) qua https/wss
  connectSrc: ["'self'", "https:", "wss:", "blob:", "data:"],
  workerSrc: ["'self'", "blob:"],
  childSrc: ["'self'", "blob:"],
};
if (config.publicUrl.startsWith("https://")) cspDirectives.upgradeInsecureRequests = [];

app.use(
  helmet({
    contentSecurityPolicy: config.cspEnabled ? { useDefaults: false, directives: cspDirectives } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  })
);

/* ---------------- CORS (mục 12.2) ---------------- */

const allowedHosts = new Set();
try {
  allowedHosts.add(new URL(config.publicUrl).host);
} catch {
  /* bỏ qua nếu PUBLIC_URL sai */
}
for (const extra of (process.env.EXTRA_ALLOWED_ORIGINS || "").split(",")) {
  const v = extra.trim();
  if (!v) continue;
  try {
    allowedHosts.add(new URL(v).host);
  } catch {
    allowedHosts.add(v);
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      host = "";
    }
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].some((h) => origin.includes(h));
    const isSameOrigin = host && host === req.headers.host;
    const isPreview = !config.isProduction && host.endsWith(".e2b.app");
    if (allowedHosts.has(host) || isLocal || isSameOrigin || isPreview) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  return next();
});

/* ---------------- Body parser ---------------- */
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

// Để Socket.IO tự xử lý /socket.io/* (client script + engine), Express bỏ qua đường dẫn này
app.use((req, res, next) => {
  if (req.path === "/socket.io" || req.path.startsWith("/socket.io/")) return undefined;
  return next();
});

/* ---------------- File tĩnh ---------------- */
app.use(express.static(config.paths.publicDir, { extensions: ["html"], maxAge: "5m" }));

// Ảnh slide đã upload
app.use(
  "/uploads",
  express.static(config.paths.uploadsDir, {
    maxAge: "7d",
    index: false,
    dotfiles: "ignore",
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    },
  })
);

// Bản SDK Agora dự phòng (cùng phiên bản đã chốt) phục vụ từ node_modules,
// dùng khi CDN không truy cập được (ví dụ mạng chặn download.agora.io).
const agoraSdkDir = path.join(config.paths.root, "node_modules", "agora-rtc-sdk-ng");
const agoraSdkFile = path.join(agoraSdkDir, "AgoraRTC_N-production.min.js");
const agoraSdkVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(agoraSdkDir, "package.json"), "utf8")).version;
  } catch {
    return config.agora.sdkVersion;
  }
})();
app.get(`/vendor/AgoraRTC_N-${agoraSdkVersion}.prod.js`, (req, res) => {
  if (!fs.existsSync(agoraSdkFile)) return res.status(404).send("Agora SDK not installed");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  return res.sendFile(agoraSdkFile);
});

/* ---------------- Cấu hình công khai cho frontend (không chứa bí mật) ---------------- */
app.get("/api/config", (req, res) => {
  // Cờ cho frontend biết cấu hình Agora đã phải giá trị thật chưa (không lộ bí mật)
  const agoraReady =
    !config.agora.disabled && /^[0-9a-f]{32}$/i.test(config.agora.appId) && config.agora.appCert.length >= 16;
  res.json({
    agoraReady,
    agoraSdkVersion,
    sdkUrls: [
      `https://download.agora.io/sdk/release/AgoraRTC_N-${agoraSdkVersion}.js`,
      `https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@${agoraSdkVersion}/AgoraRTC_N-production.min.js`,
      `/vendor/AgoraRTC_N-${agoraSdkVersion}.prod.js`,
    ],
    maxStudentsPerRoom: config.maxStudentsPerRoom,
    roomTtlHours: config.roomTtlHours,
    teacherGraceMinutes: config.teacherGraceMinutes,
    maxNameLength: config.limits.maxNameLength,
    maxSlidesPerLesson: config.limits.maxSlidesPerLesson,
    maxSlideMB: Math.round(config.limits.maxSlideBytes / 1024 / 1024),
    logLevel: config.logLevel,
    screenUidOffset: config.agora.screenUidOffset,
  });
});

/* ---------------- API ---------------- */
app.use("/api/auth", authRouter);
app.use("/api/rooms", roomRouter);
app.use("/api/lessons", lessonRouter);
app.use("/api/agora", agoraRouter);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: roomState.allRooms().length,
    rssMB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    now: Date.now(),
  });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Không tìm thấy API này." }));

/* ---------------- Trang lỗi thân thiện ---------------- */
app.use((req, res) => {
  if (res.headersSent) return undefined;
  return res.status(404).sendFile(path.join(config.paths.publicDir, "404.html"), (err) => {
    if (err && !res.headersSent) res.status(404).type("text/plain; charset=utf-8").send("404 - Không tìm thấy trang.");
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("[server]", err);
  res.status(status).json({ error: err.expose ? err.message : "Có lỗi phía máy chủ. Hãy thử lại." });
});

/* ---------------- Khởi động ---------------- */

db.read(); // tạo data/db.json nếu chưa có
warnIfPlaceholderAgora();

const server = http.createServer(app);
initSocket(server);

server.listen(config.port, config.host, () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log("  Ứng dụng học trực tuyến 1-1 đã sẵn sàng");
  console.log(`  Local   : http://localhost:${config.port}`);
  console.log(`  Network : http://${config.host}:${config.port}`);
  console.log(`  PUBLIC  : ${config.publicUrl}`);
  console.log(`  Môi trường: ${config.env} | RSS: ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
  console.log("──────────────────────────────────────────────────────────");
  if (!config.publicUrl.startsWith("https://") && config.isProduction) {
    console.warn("[CẢNH BÁO] PUBLIC_URL không phải HTTPS: trình duyệt sẽ CHẶN camera/mic.");
  }
});

/* Dọn phòng quá hạn mỗi giờ (mục 12.9) */
const cleanupTimer = setInterval(() => {
  const r = roomState.cleanupRooms();
  if (r.purgedDb || r.purgedMem) {
    console.log(`[cleanup] đã dọn ${r.purgedDb} phòng quá hạn trong db, ${r.purgedMem} phòng trong bộ nhớ. Còn ${r.remaining}.`);
  }
}, 3600_000);
cleanupTimer.unref();

/* Tắt gọn gàng */
function shutdown(signal) {
  console.log(`\n[server] nhận ${signal}, đang tắt...`);
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

export { app, server };
