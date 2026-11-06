/**
 * src/routes/agora.routes.js
 * Cấp token Agora. SERVER TỰ QUYẾT ĐỊNH uid — client không được gửi uid lên (mục 7.1).
 *
 * Lưu ý: gói agora-token phiên bản 2.x KHÔNG export named `RtcTokenBuilder`,
 * phải lấy từ default export (khác với đoạn mã mẫu C1 trong tài liệu).
 */
import express from "express";
import AgoraToken from "agora-token";
import { config } from "../config.js";
import { requireAuth } from "../auth.js";
import { asyncHandler, normalizeRoomCode } from "../util.js";
import * as state from "../socket/roomState.js";

const { RtcTokenBuilder, RtcRole } = AgoraToken;

export const agoraRouter = express.Router();

agoraRouter.post(
  "/token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const code = normalizeRoomCode((req.body || {}).code || req.session.code);
    if (!code) return res.status(400).json({ error: "Thiếu mã phòng." });

    // Học viên chỉ xin token cho đúng phòng trong JWT của mình
    if (req.session.role !== "teacher" && req.session.code !== code) {
      return res.status(403).json({ error: "Bạn không có quyền vào phòng này." });
    }

    const room = state.ensureRoom(code);
    if (!room) return res.status(404).json({ error: "Phòng không còn tồn tại hoặc đã hết hạn." });

    const kind = (req.body || {}).kind === "screen" ? "screen" : "cam";
    // Chỉ giáo viên được share màn hình (mục 7.1 + A6)
    if (kind === "screen" && req.session.role !== "teacher") {
      return res.status(403).json({ error: "Chỉ giáo viên mới chia sẻ màn hình được." });
    }

    const camUid =
      state.uidOf(room, req.session.userId) || state.allocateUid(room, req.session.userId, req.session.role);
    const uid = kind === "screen" ? camUid + config.agora.screenUidOffset : camUid;

    const ttl = config.agora.tokenTtlSeconds;
    let token = "";
    try {
      token = RtcTokenBuilder.buildTokenWithUid(
        config.agora.appId,
        config.agora.appCert,
        code, // channel = roomCode
        uid,
        RtcRole.PUBLISHER,
        ttl, // thời hạn token
        ttl // thời hạn quyền publish
      );
    } catch (err) {
      console.error("[agora] Không tạo được token:", err.message);
    }

    if (!token || typeof token !== "string") {
      return res.status(500).json({
        error:
          "Không tạo được token Agora. Hãy kiểm tra AGORA_APP_ID và AGORA_APP_CERT trong biến môi trường.",
      });
    }

    return res.json({
      appId: config.agora.appId,
      channel: code,
      uid,
      token,
      kind,
      expiresAt: Date.now() + ttl * 1000,
    });
  })
);
