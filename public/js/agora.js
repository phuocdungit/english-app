/**
 * public/js/agora.js
 * Gọi video/audio bằng Agora Web SDK NG (4.x).
 *
 * Mô hình 2 client cho giáo viên (mục A6):
 *  - camClient   : camera + micro, uid do server cấp (giáo viên = 1, học viên = 2..99)
 *  - screenClient: CHỈ publish màn hình, uid = camUid + 100000
 * camClient của giáo viên KHÔNG subscribe luồng màn hình của chính mình.
 */
import { loadAgoraSdk } from "./sdk-loader.js";
import * as api from "./api.js";

export const SCREEN_UID_OFFSET = 100000;

export const isScreenUid = (uid) => Number(uid) >= SCREEN_UID_OFFSET;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** iOS/Android không hỗ trợ share màn hình trên trình duyệt (mục A6). */
export function isMobileBrowser() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

export function canShareScreen() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMobileBrowser();
}

/** Dịch lỗi thiết bị sang thông báo tiếng Việt dễ hiểu (mục 9.3.2 + 13). */
export function describeDeviceError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  if (name.includes("NotAllowed") || /permission|denied|not allowed/i.test(msg)) {
    return "Trình duyệt đang chặn camera/mic. Hãy bấm biểu tượng ổ khoá ở thanh địa chỉ, cho phép Camera và Micro rồi tải lại trang.";
  }
  if (name.includes("NotFound") || /no device|not found/i.test(msg)) {
    return "Không tìm thấy camera hoặc micro trên thiết bị này. Bạn vẫn có thể vào phòng để xem và nghe.";
  }
  if (name.includes("NotReadable") || /in use|occupied|could not start/i.test(msg)) {
    return "Camera/mic đang bị một ứng dụng khác chiếm (Zoom, Meet, OBS...). Hãy tắt ứng dụng đó hoặc chọn thiết bị khác.";
  }
  if (name.includes("Overconstrained")) {
    return "Thiết bị được chọn không hỗ trợ chế độ này. Hãy chọn thiết bị khác.";
  }
  return `Lỗi thiết bị: ${msg || name || "không xác định"}`;
}

export const NETWORK_LEVELS = { 0: "unknown", 1: "good", 2: "good", 3: "mid", 4: "bad", 5: "bad", 6: "bad" };

function levelOf(value) {
  return NETWORK_LEVELS[Number(value) || 0] || "unknown";
}

export class CallSession {
  /**
   * @param {object} opts
   * @param {string} opts.code mã phòng (= channel Agora)
   * @param {"teacher"|"student"} opts.role
   * @param {object} opts.config cấu hình công khai từ /api/config
   * @param {(type:string,payload:object)=>void} opts.onEvent
   */
  constructor({ code, role, config, onEvent }) {
    this.code = code;
    this.role = role;
    this.config = config || {};
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};

    this.AgoraRTC = null;
    this.client = null;
    this.screenClient = null;

    this.appId = null;
    this.uid = null; // uid camera do SERVER cấp
    this.screenUid = null;

    this.micTrack = null;
    this.camTrack = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;

    this.micEnabled = true;
    this.camEnabled = true;
    this.sharing = false;
    this.joined = false;
    this.left = false;

    /** uid -> videoTrack / audioTrack của người ở xa */
    this.remoteVideo = new Map();
    this.remoteAudio = new Map();
    /** uid -> tên hiển thị (lấy từ presence) */
    this.names = new Map();

    this.network = { up: "unknown", down: "unknown" };
    this.volumeTimer = null;
    this._rejoining = false;
    this._sdkReady = null;
  }

  emit(type, payload = {}) {
    try {
      this.onEvent(type, payload);
    } catch (err) {
      console.error("[agora] onEvent lỗi:", err);
    }
  }

  get isTeacher() {
    return this.role === "teacher";
  }

  /* ---------------- Khởi tạo SDK ---------------- */

  async init() {
    if (this._sdkReady) return this._sdkReady;
    this._sdkReady = (async () => {
      this.AgoraRTC = await loadAgoraSdk(this.config.sdkUrls);
      // Mức log: production chỉ in lỗi (mục 9.2)
      this.AgoraRTC.setLogLevel(this.config.logLevel === "debug" ? 1 : 3);
      if ("onAutoplayFailed" in this.AgoraRTC) {
        this.AgoraRTC.onAutoplayFailed = () => this.emit("autoplay-blocked");
      }
      this.client = this.AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      this._wire(this.client, "cam");
      return this.AgoraRTC;
    })();
    return this._sdkReady;
  }

  _wire(client, kind) {
    client.on("user-published", async (user, mediaType) => {
      // Giáo viên KHÔNG subscribe luồng màn hình của chính mình (mục 9.1)
      if (kind === "cam" && isScreenUid(user.uid) && this.sharing) return;
      try {
        await client.subscribe(user, mediaType);
      } catch (err) {
        console.warn("[agora] subscribe lỗi", mediaType, err?.message);
        this.emit("subscribe-error", { uid: user.uid, mediaType, message: err?.message });
        return;
      }
      if (mediaType === "video") {
        this.remoteVideo.set(user.uid, user.videoTrack);
        this.emit("video-updated", { uid: user.uid, screen: isScreenUid(user.uid) });
      } else if (mediaType === "audio") {
        this.remoteAudio.set(user.uid, user.audioTrack);
        try {
          user.audioTrack.play();
        } catch (err) {
          console.warn("[agora] phát âm thanh lỗi:", err?.message);
          this.emit("autoplay-blocked");
        }
        this.emit("audio-updated", { uid: user.uid });
      }
    });

    client.on("user-unpublished", (user, mediaType) => {
      if (mediaType === "video") {
        this.remoteVideo.delete(user.uid);
        this.emit("video-updated", { uid: user.uid, screen: isScreenUid(user.uid), removed: true });
      } else if (mediaType === "audio") {
        const track = this.remoteAudio.get(user.uid);
        try {
          track?.stop();
        } catch {
          /* bỏ qua */
        }
        this.remoteAudio.delete(user.uid);
        this.emit("audio-updated", { uid: user.uid, removed: true });
      }
    });

    client.on("user-left", (user, reason) => {
      this.remoteVideo.delete(user.uid);
      const a = this.remoteAudio.get(user.uid);
      try {
        a?.stop();
      } catch {
        /* bỏ qua */
      }
      this.remoteAudio.delete(user.uid);
      this.emit("user-left", { uid: user.uid, reason });
    });

    client.on("network-quality", (stats) => {
      const up = levelOf(stats?.uplinkNetworkQuality);
      const down = levelOf(stats?.downlinkNetworkQuality);
      if (up !== this.network.up || down !== this.network.down) {
        this.network = { up, down };
        this.emit("network", { ...this.network });
      }
    });

    client.on("volume-indicator", (volumes) => {
      const map = {};
      for (const v of volumes || []) map[v.uid] = v.level;
      this.emit("volume", { levels: map });
    });

    client.on("token-privilege-will-expire", async () => {
      // Tự gia hạn token để không bị ngắt giữa buổi (mục 9.3 + 7.1)
      try {
        const t = await api.agoraToken(this.code, kind);
        await client.renewToken(t.token);
        this.emit("token-renewed", { kind });
      } catch (err) {
        console.warn("[agora] gia hạn token lỗi:", err?.message);
      }
    });

    client.on("token-privilege-did-expire", async () => {
      try {
        const t = await api.agoraToken(this.code, kind);
        await client.renewToken(t.token);
      } catch {
        this._rejoin();
      }
    });

    client.on("connection-state-change", (cur, prev, reason) => {
      this.emit("connection-state", { state: cur, prev, reason, kind });
      if (cur === "DISCONNECTED" && reason !== "LEAVE_CHANNEL" && !this.left) this._rejoin();
    });

    client.on("exception", (e) => console.warn("[agora] exception:", e?.code, e?.message));
    client.on("error", (err) => {
      console.error("[agora] error:", err);
      this.emit("sdk-error", { message: String(err?.message || err) });
    });
  }

  /* ---------------- Vào phòng ---------------- */

  async join() {
    if (!this.client) await this.init();
    const t = await api.agoraToken(this.code, "cam");
    this.appId = t.appId;
    this.uid = t.uid;
    await this.client.join(t.appId, t.channel, t.token, t.uid);
    this.joined = true;
    this.left = false;
    try {
      // Bật chỉ báo âm lượng để hiện "ai đang nói" (mục 11).
      // SDK 4.24.9: hàm không nhận tham số, sự kiện bắn mỗi 2 giây, level 0..100.
      this.client.enableAudioVolumeIndicator();
    } catch {
      /* SDK cũ không hỗ trợ thì bỏ qua */
    }
    this.emit("joined", { uid: this.uid });
    return this.uid;
  }

  async _rejoin() {
    if (this.left || this._rejoining || !this.client) return;
    this._rejoining = true;
    this.emit("reconnecting");
    for (let i = 0; i < 6; i += 1) {
      if (this.left) break;
      try {
        try {
          await this.client.leave();
        } catch {
          /* có thể chưa join */
        }
        const t = await api.agoraToken(this.code, "cam");
        this.appId = t.appId;
        this.uid = t.uid;
        await this.client.join(t.appId, t.channel, t.token, t.uid);
        this.joined = true;
        const tracks = [this.micTrack, this.camTrack].filter(Boolean);
        if (tracks.length) await this.client.publish(tracks);
        this.emit("reconnected");
        this._rejoining = false;
        return;
      } catch (err) {
        console.warn(`[agora] thử kết nối lại lần ${i + 1} thất bại:`, err?.message);
        await sleep(1500 * (i + 1));
      }
    }
    this._rejoining = false;
    this.emit("reconnect-failed");
  }

  /* ---------------- Camera & micro cục bộ ---------------- */

  async startLocalMedia({ micOn = true, camOn = true, micId, camId, resolution = "480p_1" } = {}) {
    if (!this.joined) throw new Error("Chưa vào phòng Agora.");
    const problems = [];
    let wantMic = micOn;
    let wantCam = camOn;

    if (wantMic && wantCam) {
      try {
        const [mic, cam] = await this.AgoraRTC.createMicrophoneAndCameraTracks(
          micId ? { microphoneId: micId } : {},
          Object.assign({ encoderConfig: resolution }, camId ? { cameraId: camId } : {})
        );
        this.micTrack = mic;
        this.camTrack = cam;
      } catch (err) {
        problems.push(err);
      }
    }

    if (!this.micTrack && wantMic) {
      try {
        this.micTrack = await this.AgoraRTC.createMicrophoneAudioTrack(micId ? { microphoneId: micId } : {});
      } catch (err) {
        problems.push(err);
      }
    }
    if (!this.camTrack && wantCam) {
      try {
        this.camTrack = await this.AgoraRTC.createCameraVideoTrack(
          Object.assign({ encoderConfig: resolution }, camId ? { cameraId: camId } : {})
        );
      } catch (err) {
        problems.push(err);
      }
    }

    const tracks = [this.micTrack, this.camTrack].filter(Boolean);
    if (tracks.length) await this.client.publish(tracks);

    this.emit("local-media", {
      hasMic: Boolean(this.micTrack),
      hasCam: Boolean(this.camTrack),
      problems: problems.map(describeDeviceError),
    });
    return { hasMic: Boolean(this.micTrack), hasCam: Boolean(this.camTrack), problems };
  }

  async setMicEnabled(on) {
    if (!this.micTrack) return false;
    this.micEnabled = Boolean(on);
    await this.micTrack.setEnabled(this.micEnabled);
    this.emit("local-media", { hasMic: true, hasCam: Boolean(this.camTrack), micEnabled: this.micEnabled });
    return this.micEnabled;
  }

  async setCamEnabled(on) {
    if (!this.camTrack) return false;
    this.camEnabled = Boolean(on);
    await this.camTrack.setEnabled(this.camEnabled);
    this.emit("local-media", { hasMic: Boolean(this.micTrack), hasCam: true, camEnabled: this.camEnabled });
    return this.camEnabled;
  }

  /** Đổi thiết bị (khi camera bị app khác chiếm hoặc chọn sai thiết bị). */
  async switchDevice(kind, deviceId) {
    try {
      if (kind === "mic" && this.micTrack) {
        const old = this.micTrack;
        this.micTrack = await this.AgoraRTC.createMicrophoneAudioTrack({ microphoneId: deviceId });
        await this.client.unpublish(old);
        old.close();
        await this.client.publish(this.micTrack);
      }
      if (kind === "cam" && this.camTrack) {
        const old = this.camTrack;
        this.camTrack = await this.AgoraRTC.createCameraVideoTrack({ encoderConfig: "480p_1", cameraId: deviceId });
        await this.client.unpublish(old);
        old.close();
        await this.client.publish(this.camTrack);
      }
      this.emit("local-media", { hasMic: Boolean(this.micTrack), hasCam: Boolean(this.camTrack), switched: kind });
      return true;
    } catch (err) {
      this.emit("device-error", { message: describeDeviceError(err) });
      return false;
    }
  }

  /* ---------------- Chia sẻ màn hình (chỉ giáo viên) ---------------- */

  async startShare() {
    if (!this.isTeacher) throw new Error("Chỉ giáo viên mới chia sẻ màn hình được.");
    if (this.sharing) return null;
    if (!this.joined) throw new Error("Chưa vào phòng Agora.");

    // Xin token cho luồng màn hình TRƯỚC; server quyết định uid (mục 7.1)
    const t = await api.agoraToken(this.code, "screen");
    this.screenUid = t.uid;

    const result = await this.AgoraRTC.createScreenVideoTrack(
      { encoderConfig: "1080p_1", optimizationMode: "detail" },
      "auto" // tự tạo thêm luồng âm thanh nếu tab/cửa sổ có tiếng
    );
    if (Array.isArray(result)) {
      this.screenTrack = result[0];
      this.screenAudioTrack = result[1] || null;
    } else {
      this.screenTrack = result;
      this.screenAudioTrack = null;
    }

    this.screenClient = this.AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this._wire(this.screenClient, "screen");
    await this.screenClient.join(t.appId, t.channel, t.token, t.uid);
    // client màn hình CHỈ publish, không subscribe ai (mục 9.1)
    await this.screenClient.publish(
      this.screenAudioTrack ? [this.screenTrack, this.screenAudioTrack] : [this.screenTrack]
    );

    // Người học bấm "Stop sharing" của trình duyệt -> track-ended
    this.screenTrack.on("track-ended", () => {
      this.stopShare({ byBrowser: true }).catch((err) => console.warn("[agora] dừng share lỗi:", err));
    });

    this.sharing = true;
    let settings = {};
    try {
      settings = this.screenTrack.getMediaStreamTrack().getSettings() || {};
    } catch {
      settings = {};
    }
    const info = {
      width: settings.width || window.screen?.width || 1920,
      height: settings.height || window.screen?.height || 1080,
      uid: t.uid,
    };
    this.emit("share-changed", { active: true, ...info });
    return info;
  }

  async stopShare({ byBrowser = false, silent = false } = {}) {
    if (!this.sharing && !this.screenTrack) return;
    this.sharing = false;
    const track = this.screenTrack;
    const audio = this.screenAudioTrack;
    const client = this.screenClient;
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.screenClient = null;
    this.screenUid = null;

    try {
      if (client && track) await client.unpublish(audio ? [track, audio] : [track]);
    } catch {
      /* bỏ qua */
    }
    try {
      track?.close();
    } catch {
      /* bỏ qua */
    }
    try {
      audio?.close();
    } catch {
      /* bỏ qua */
    }
    try {
      if (client) await client.leave();
    } catch {
      /* bỏ qua */
    }
    if (!silent) this.emit("share-changed", { active: false, byBrowser });
  }

  /* ---------------- Rời phòng ---------------- */

  async leave() {
    this.left = true;
    try {
      await this.stopShare({ silent: true });
    } catch {
      /* bỏ qua */
    }
    for (const track of this.remoteAudio.values()) {
      try {
        track.stop();
      } catch {
        /* bỏ qua */
      }
    }
    this.remoteAudio.clear();
    this.remoteVideo.clear();
    try {
      this.micTrack?.close();
    } catch {
      /* bỏ qua */
    }
    try {
      this.camTrack?.close();
    } catch {
      /* bỏ qua */
    }
    this.micTrack = null;
    this.camTrack = null;
    try {
      if (this.joined && this.client) await this.client.leave();
    } catch {
      /* bỏ qua */
    }
    this.joined = false;
    this.emit("left");
  }

  /**
   * Dọn dẹp ĐỒNG BỘ khi đóng tab (beforeunload/pagehide) — mục 9.3.6.
   * Không await được, nhưng close() track sẽ giải phóng camera/mic ngay
   * và Agora ngừng tính phút khi peer connection bị huỷ.
   */
  hardLeave() {
    this.left = true;
    for (const t of [this.screenTrack, this.screenAudioTrack, this.micTrack, this.camTrack]) {
      try {
        t?.close();
      } catch {
        /* bỏ qua */
      }
    }
    for (const track of this.remoteAudio.values()) {
      try {
        track.stop();
      } catch {
        /* bỏ qua */
      }
    }
    try {
      this.screenClient?.leave();
    } catch {
      /* bỏ qua */
    }
    try {
      this.client?.leave();
    } catch {
      /* bỏ qua */
    }
    this.joined = false;
    this.sharing = false;
  }
}

/** Liệt kê thiết bị (dùng cho màn hình kiểm tra trước khi vào). */
export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { cameras: [], microphones: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  const cameras = all.filter((d) => d.kind === "videoinput").map((d) => ({ id: d.deviceId, label: d.label || "Camera" }));
  const microphones = all.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || "Micro" }));
  return { cameras, microphones };
}
