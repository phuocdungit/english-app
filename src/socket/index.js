/**
 * src/socket/index.js
 * Khởi tạo Socket.IO: xác thực JWT ở handshake, đưa socket vào room,
 * phát presence, xử lý "hai tab cùng một người" và khoảng chờ khi giáo viên rớt mạng.
 */
import { Server } from "socket.io";
import { config } from "../config.js";
import { verifySession } from "../auth.js";
import { normalizeRoomCode } from "../util.js";
import * as db from "../db.js";
import * as state from "./roomState.js";
import { registerHandlers } from "./handlers.js";

let io = null;
export function getIO() {
  return io;
}

/* ---------- Kiểm tra Origin (mục 12.2: CORS chỉ cho PUBLIC_URL) ---------- */

function originAllowed(req) {
  const origin = req.headers?.origin;
  if (!origin) return true; // không phải trình duyệt, hoặc request cùng origin
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.host;
  const hostname = url.hostname;

  const allowed = new Set();
  try {
    allowed.add(new URL(config.publicUrl).host);
  } catch {
    /* PUBLIC_URL sai định dạng thì bỏ qua */
  }
  if (req.headers?.host) allowed.add(req.headers.host);
  for (const extra of (process.env.EXTRA_ALLOWED_ORIGINS || "").split(",")) {
    const v = extra.trim();
    if (!v) continue;
    try {
      allowed.add(new URL(v).host);
    } catch {
      allowed.add(v);
    }
  }
  if (allowed.has(host)) return true;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  // Môi trường xem trước của sandbox (chỉ khi không phải production)
  if (!config.isProduction && hostname.endsWith(".e2b.app")) return true;
  return false;
}

/* ---------- Thông báo cho cả phòng khi kết thúc ---------- */

export function broadcastRoomEnded(code) {
  if (!io) return;
  io.to(code).emit("room:ended", {});
  const sockets = io.sockets.adapter.rooms.get(code);
  if (sockets) for (const id of sockets) io.sockets.sockets.get(id)?.disconnect(true);
}

export function broadcastState(code) {
  if (!io) return;
  const room = state.getRoom(code);
  if (room) io.to(code).emit("room:state", state.publicState(room));
}

function emitPresence(code) {
  if (!io) return;
  const room = state.getRoom(code);
  if (!room) return;
  io.to(code).emit("presence", {
    participants: state.presenceOf(room),
    teacherPresent: state.teacherPresent(room),
  });
}

/* ---------- Khởi tạo ---------- */

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    maxHttpBufferSize: config.limits.maxHttpBufferSize,
    pingInterval: 20000,
    pingTimeout: 20000,
    connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: true },
    cors: {
      // allowRequest bên dưới đã chặn origin lạ, nên ở đây chỉ cần phản hồi đúng origin đó
      origin: (reqOrigin, cb) => cb(null, reqOrigin ? [reqOrigin] : true),
      credentials: true,
    },
    allowRequest(req, cb) {
      if (originAllowed(req)) return cb(null, true);
      return cb(new Error("Origin không được phép"), false);
    },
  });

  // Middleware xác thực: auth: { token, code }
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const session = verifySession(auth.token);
    if (!session) return next(new Error("UNAUTHORIZED: Phiên đăng nhập không hợp lệ."));

    const code = normalizeRoomCode(auth.code || session.code);
    if (!code) return next(new Error("NO_ROOM: Thiếu mã phòng."));

    const record = db.getRoomRecord(code);
    if (!record || !db.isRoomActive(record)) return next(new Error("ROOM_GONE: Phòng không tồn tại hoặc đã hết hạn."));

    socket.data.session = { ...session, code };
    return next();
  });

  io.on("connection", (socket) => {
    const session = socket.data.session;
    const code = session.code;
    const room = state.ensureRoom(code);
    if (!room) {
      socket.emit("error:msg", { message: "Phòng không còn tồn tại hoặc đã kết thúc." });
      socket.disconnect(true);
      return;
    }

    // Chặn vượt giới hạn số người trong phòng (mục 12.4)
    const alreadyIn = [...room.participants.values()].some((p) => p.userId === session.userId);
    if (session.role === "student" && !alreadyIn && state.isFull(room)) {
      socket.emit("error:msg", { message: "Phòng đã đủ học viên. Hãy thử lại sau." });
      socket.disconnect(true);
      return;
    }

    // Hai tab cùng một người: ngắt TAB CŨ kèm thông báo (mục 13)
    const existing = io.sockets.adapter.rooms.get(code);
    if (existing) {
      for (const sid of existing) {
        const other = io.sockets.sockets.get(sid);
        if (other && other.id !== socket.id && other.data?.session?.userId === session.userId) {
          other.emit("session:replaced", { message: "Bạn vừa mở phòng này ở một tab khác, tab này sẽ đóng." });
          other.disconnect(true);
        }
      }
    }

    socket.join(code);
    const participant = state.addParticipant(room, socket.id, {
      userId: session.userId,
      name: session.name,
      role: session.role,
    });
    socket.data.participant = participant;

    // Gửi trạng thái đầy đủ cho người mới vào / vừa kết nối lại (mục 8.2, 8.3)
    socket.emit("room:state", state.publicState(room));
    socket.emit("you:are", { userId: session.userId, name: session.name, role: session.role, agoraUid: participant.agoraUid, code });
    emitPresence(code);
    if (session.role === "teacher") io.to(code).emit("teacher:joined", { name: session.name });

    registerHandlers(io, socket, session);

    socket.on("disconnect", (reason) => {
      const r = state.getRoom(code);
      if (!r) return;
      state.removeParticipant(r, socket.id);
      emitPresence(code);

      if (session.role === "teacher" && !state.teacherPresent(r)) {
        // Học viên thấy "Cô đã rời phòng", phòng giữ 10 phút để cô quay lại (mục 13)
        r.teacherLeftAt = Date.now();
        io.to(code).emit("teacher:left", {
          name: session.name,
          graceMinutes: config.teacherGraceMinutes,
          reason,
        });
        if (r.graceTimer) clearTimeout(r.graceTimer);
        r.graceTimer = setTimeout(() => {
          const current = state.getRoom(code);
          if (!current || state.teacherPresent(current)) return;
          io.to(code).emit("room:ended", { reason: "teacher-timeout" });
          state.endRoom(current);
          broadcastRoomEnded(code);
        }, config.teacherGraceMinutes * 60 * 1000);
        r.graceTimer.unref?.();
      }
    });

    socket.on("error", (err) => {
      console.warn(`[socket] lỗi của ${socket.id}:`, err?.message || err);
    });
  });

  return io;
}
