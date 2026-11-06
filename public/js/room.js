/**
 * public/js/room.js
 * Điều phối chính của phòng học:
 * phiên đăng nhập -> kiểm tra thiết bị -> Socket.IO -> Agora -> stage + whiteboard + toolbar.
 */
import * as api from "./api.js";
import {
  $,
  toast,
  showBanner,
  hideBanner,
  mountStars,
  playStarSound,
  formatClock,
  formatTimecode,
  confirmDialog,
  openModal,
  closeModal,
} from "./ui.js";
import { Stage } from "./stage.js";
import { Whiteboard } from "./whiteboard.js";
import { mountToolbar } from "./toolbar.js";
import { CallSession, canShareScreen, isScreenUid, describeDeviceError } from "./agora.js";
import { openPreflight, askForAutoplay } from "./preflight.js";

/* ============================ Bối cảnh ============================ */

const params = new URLSearchParams(window.location.search);
const CODE = String(params.get("code") || "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "")
  .slice(0, 12);

const el = {
  codeChip: $("#codeChip"),
  timer: $("#timer"),
  stars: $("#stars"),
  starCtl: $("#starCtl"),
  btnStarPlus: $("#btnStarPlus"),
  btnStarMinus: $("#btnStarMinus"),
  netDot: $("#netDot"),
  btnHelp: $("#btnHelp"),
  btnEnd: $("#btnEnd"),
  btnBack: $("#btnBack"),

  stageWrap: $("#stageWrap"),
  stageFrame: $("#stageFrame"),
  stageContent: $("#stageContent"),
  slideImg: $("#slideImg"),
  lessonVideo: $("#lessonVideo"),
  screenView: $("#screenView"),
  overlay: $("#stageOverlay"),
  board: $("#board"),
  laserLayer: $("#laserLayer"),

  slideControls: $("#slideControls"),
  btnPrev: $("#btnPrev"),
  btnNext: $("#btnNext"),
  pageLabel: $("#pageLabel"),
  videoControls: $("#videoControls"),
  btnPlayPause: $("#btnPlayPause"),
  videoSeek: $("#videoSeek"),
  videoTime: $("#videoTime"),

  drawLockNote: $("#drawLockNote"),
  waitNote: $("#waitNote"),
  screenWarn: $("#screenWarn"),
  camTiles: $("#camTiles"),
};

const state = {
  role: null,
  token: null,
  name: "",
  userId: null,
  selfUid: null,
  lesson: null,
  mode: "lesson",
  pageIndex: 0,
  stars: 0,
  studentCanDraw: true,
  teacherPresent: false,
  participants: [],
  sharing: false,
  screen: { active: false, width: 1920, height: 1080, uid: null },
  video: { playing: false, time: 0, updatedAt: 0 },
  startedAt: null,
  ended: false,
  media: { mic: true, cam: true },
  config: null,
};

let socket = null;
let call = null;
let stage = null;
let board = null;
let toolbar = null;
let setStars = () => {};
let screenPlayed = null;
const tiles = new Map(); // agoraUid -> {el, host, tag, mic, placeholder, played}
let timerId = null;
let videoSyncId = null;

/* ============================ Khởi động ============================ */

main().catch((err) => {
  console.error(err);
  fatal(err?.message || "Có lỗi khi vào phòng.", "😵");
});

async function main() {
  if (!CODE) {
    fatal("Thiếu mã phòng trong đường dẫn. Hãy mở đúng link cô gửi.", "🔗");
    return;
  }
  el.codeChip.textContent = CODE;
  document.title = `Phòng ${CODE} · Lớp học 1-1`;

  state.config = await api.getClientConfig();

  // 1) Xác định phiên: giáo viên (localStorage) hoặc học viên (sessionStorage / nhập tên)
  const session = await resolveSession();
  if (!session) return; // người dùng đã huỷ -> quay về trang chủ
  Object.assign(state, {
    role: session.role,
    token: session.token,
    name: session.name,
    userId: session.userId,
    lesson: session.room?.lesson || null,
    stars: session.room?.stars || 0,
    startedAt: session.room?.startedAt || null,
  });
  if (session.room?.endedAt || session.room?.active === false) {
    fatal("Phòng này đã kết thúc hoặc hết hạn. Hãy xin cô mã phòng mới.", "⌛");
    return;
  }

  // 2) Dựng giao diện
  setStars = mountStars(el.stars, { editable: false });
  setStars(state.stars, { animate: false });
  stage = new Stage({
    wrap: el.stageWrap,
    frame: el.stageFrame,
    content: el.stageContent,
    slideImg: el.slideImg,
    lessonVideo: el.lessonVideo,
    screenView: el.screenView,
    overlay: el.overlay,
    onViewportChange: (v) => board?.resize(v),
  });
  board = new Whiteboard({
    canvas: el.board,
    laserLayer: el.laserLayer,
    stage,
    socket: { emit: emitSocket },
    role: state.role,
    onLockedNotice: ({ locked, transient }) => {
      el.drawLockNote.classList.toggle("hidden", !locked);
      if (locked && transient) toast("🔒 Cô đang tạm khoá bút của bạn.", "", 1800);
    },
  });
  board.setSelfUserId(state.userId);
  stage.setLesson(state.lesson);
  if (state.lesson) {
    stage.setPage(0);
    board.setPage(`lesson:0`, []);
  } else {
    stage.setOverlay("no-lesson", "📭", "Chưa có bài học", "Phòng này chưa gắn bài học nào.");
  }

  // 3) Kiểm tra thiết bị trước khi vào (mục 11)
  const devices = await openPreflight({ role: state.role });
  if (devices?.cancelled) {
    location.href = "/";
    return;
  }

  // 4) Toolbar + nút điều khiển
  toolbar = mountToolbar({ role: state.role, board, callbacks: toolbarCallbacks() });
  toolbar.setShareSupported(state.role === "teacher" && canShareScreen());
  toolbar.setMic(devices.micOn);
  toolbar.setCam(devices.camOn);
  toolbar.setPerm(state.studentCanDraw);
  wireStageControls();
  wireTopbar();

  // 5) Socket.IO
  connectSocket();

  // 6) Agora
  await connectCall(devices);

  // 7) Đồng hồ buổi học + đồng bộ video
  startTimer();
  startVideoSync();

  // 8) Dọn dẹp khi đóng tab (mục 9.3.6)
  window.addEventListener("beforeunload", hardCleanup);
  window.addEventListener("pagehide", hardCleanup);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") board?._flush?.();
  });
}

function hardCleanup() {
  try {
    call?.hardLeave();
  } catch {
    /* bỏ qua */
  }
  try {
    socket?.disconnect();
  } catch {
    /* bỏ qua */
  }
}

/* ============================ Phiên đăng nhập ============================ */

async function resolveSession() {
  const teacherToken = api.getToken();
  if (teacherToken) {
    try {
      const data = await api.getRoom(CODE);
      return {
        role: "teacher",
        token: teacherToken,
        name: api.getTeacherProfile()?.name || "Cô giáo",
        userId: "teacher",
        room: data.room,
      };
    } catch (err) {
      if (err.status === 401) {
        api.clearToken();
        toast("Phiên giáo viên hết hạn, hãy đăng nhập lại.", "err");
        setTimeout(() => (location.href = "/"), 1500);
        return null;
      }
      return roomError(err);
    }
  }

  const saved = api.getStudentSession(CODE);
  if (saved?.token) {
    try {
      const data = await api.getRoom(CODE);
      return { role: "student", token: saved.token, name: saved.name, userId: saved.userId, room: data.room };
    } catch (err) {
      if (err.status === 401 || err.status === 403) api.clearStudentSession(CODE);
      else return roomError(err);
    }
  }

  const name = await askStudentName();
  if (!name) {
    location.href = "/";
    return null;
  }
  try {
    const data = await api.joinRoom(CODE, name);
    return { role: "student", token: data.token, name: data.name, userId: data.userId, room: data.room };
  } catch (err) {
    return roomError(err);
  }
}

function roomError(err) {
  if (err.status === 404) fatal("Không tìm thấy phòng này. Hãy kiểm tra lại mã phòng.", "🔍");
  else if (err.status === 410) fatal("Phòng đã kết thúc hoặc hết hạn. Hãy xin cô mã phòng mới.", "⌛");
  else fatal(err.message || "Không vào được phòng.", "😵");
  return null;
}

/** Học viên mở link trực tiếp: hỏi tên rồi vào phòng (mục 5.2 bước 4). */
function askStudentName() {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h2>🧒 Vào phòng ${CODE}</h2>
      <p class="sub">Nhập tên để cô biết bạn là ai. Không cần tài khoản.</p>
      <label class="field"><span>Tên của bạn</span>
        <input id="joinName" type="text" maxlength="30" placeholder="Bé Minh" autocomplete="given-name" /></label>
      <div id="joinMsg"></div>
      <div class="modal-actions">
        <button type="button" id="joinCancel">Huỷ</button>
        <button type="button" class="primary" id="joinGo">Vào phòng</button>
      </div>`;
    const input = wrap.querySelector("#joinName");
    const msg = wrap.querySelector("#joinMsg");
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    wrap.querySelector("#joinCancel").addEventListener("click", () => finish(null));
    wrap.querySelector("#joinGo").addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) {
        msg.innerHTML = '<div class="notice error">Hãy nhập tên của bạn.</div>';
        return;
      }
      finish(v.slice(0, 30));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") wrap.querySelector("#joinGo").click();
    });
    openModal(wrap, { dismissible: true, onClose: () => finish(null) });
  });
}

/* ============================ Socket.IO ============================ */

function emitSocket(event, payload) {
  if (!socket || !socket.connected || state.ended) return false;
  socket.emit(event, payload);
  return true;
}

function connectSocket() {
  if (typeof window.io !== "function") {
    fatal("Không tải được thư viện Socket.IO. Hãy tải lại trang.", "🔌");
    return;
  }
  socket = window.io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: { token: state.token, code: CODE },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
    timeout: 12000,
  });

  socket.on("connect", () => {
    hideBanner();
    if (state.ended) return;
    // Server tự gửi room:state khi kết nối; yêu cầu thêm một lần cho chắc
    socket.emit("room:sync");
  });

  socket.on("connect_error", (err) => {
    const msg = String(err?.message || "");
    if (msg.includes("UNAUTHORIZED")) {
      fatal("Phiên của bạn không hợp lệ. Hãy tải lại trang hoặc vào lại từ link của cô.", "🔐");
      socket.close();
      return;
    }
    if (msg.includes("ROOM_GONE")) {
      fatal("Phòng không tồn tại hoặc đã hết hạn.", "⌛");
      socket.close();
      return;
    }
    showBanner("Mất kết nối, đang thử lại…");
  });

  socket.on("disconnect", (reason) => {
    if (state.ended) return;
    if (reason !== "io client disconnect") showBanner("Mất kết nối, đang thử lại…");
  });

  socket.on("reconnect", () => hideBanner());

  socket.on("room:state", applyRoomState);
  socket.on("presence", applyPresence);
  socket.on("you:are", (me) => {
    state.userId = me.userId;
    state.name = me.name;
    state.role = me.role;
    state.selfUid = me.agoraUid;
    board?.setSelfUserId(me.userId);
    renderTiles();
  });

  socket.on("teacher:joined", (p) => {
    state.teacherPresent = true;
    el.waitNote.classList.add("hidden");
    stage?.hideOverlay("wait-teacher");
    toast(`👩‍🏫 ${p?.name || "Cô"} đã vào phòng`, "ok", 2600);
  });

  socket.on("teacher:left", (p) => {
    state.teacherPresent = false;
    el.waitNote.classList.remove("hidden");
    el.waitNote.textContent = `⏳ Cô đã rời phòng — phòng được giữ ${p?.graceMinutes || 10} phút để cô quay lại…`;
    if (state.role !== "teacher") toast("👋 Cô đã rời phòng. Bạn chờ cô một chút nhé.", "", 4000);
    renderTiles();
  });

  /* ---- Nét vẽ ---- */
  socket.on("stroke:begin", (p) => board?.onRemoteBegin(p));
  socket.on("stroke:append", (p) => board?.onRemoteAppend(p));
  socket.on("stroke:end", (p) => board?.onRemoteEnd(p));
  socket.on("stroke:undo", (p) => board?.onRemoteUndo(p));
  socket.on("stroke:erase", (p) => board?.onRemoteErase(p));
  socket.on("board:clear", () => {
    board?.onRemoteClear();
    toast("🧹 Cô đã xoá toàn bộ nét vẽ trên trang này.", "", 2200);
  });
  socket.on("laser:move", (p) => {
    if (!board) return;
    if (p?.off) board.hideLaser(p.userId);
    else board.showLaser(p.userId, [p.x, p.y]);
  });

  /* ---- Bài học ---- */
  socket.on("page:set", (p) => {
    state.pageIndex = p.index;
    state.mode = p.mode || "lesson";
    stage?.setMode(state.mode);
    stage?.setPage(p.index);
    board?.setPage(p.pageKey || `lesson:${p.index}`, p.strokes || []);
    updateSlideUI();
  });

  socket.on("mode:set", (p) => {
    state.mode = p.mode;
    stage?.setMode(p.mode);
    if (p.strokes) board?.setPage(p.pageKey, p.strokes);
    updateSlideUI();
    renderScreen();
  });

  socket.on("video:control", (p) => applyVideoControl(p));

  socket.on("screen:state", (p) => {
    state.screen = { active: Boolean(p.active), width: p.width || 1920, height: p.height || 1080, uid: p.uid || null };
    stage?.setScreenSize(state.screen.width, state.screen.height);
    if (p.mode) {
      state.mode = p.mode;
      stage?.setMode(state.mode);
    }
    updateSlideUI();
    renderScreen();
    if (state.role !== "teacher" && !state.screen.active) {
      // Cô dừng chia sẻ -> về bài học
      stage?.hideOverlay("wait-screen");
    }
  });

  socket.on("perm:draw", (p) => {
    state.studentCanDraw = p.allowed !== false;
    board?.setCanDraw(state.role === "teacher" ? true : state.studentCanDraw);
    toolbar?.setPerm(state.studentCanDraw);
    if (state.role !== "teacher") {
      toast(state.studentCanDraw ? "✏️ Cô đã mở bút cho bạn" : "🔒 Cô đang tạm khoá bút của bạn", "", 2600);
    }
  });

  socket.on("star:give", (p) => {
    const prev = state.stars;
    state.stars = Math.max(0, Math.min(5, Number(p.stars) || 0));
    setStars(state.stars);
    if (state.stars > prev) {
      playStarSound(true);
      toast(`⭐ Tuyệt vời! Bạn có ${state.stars} sao`, "star", 2600);
    } else if (state.stars < prev) {
      playStarSound(false);
    }
  });

  socket.on("help:request", (p) => {
    if (state.role === "teacher") {
      toast(`🙋 ${p?.name || "Học viên"} cần trợ giúp!`, "err", 5000);
      el.btnHelp.classList.remove("help-flash");
      void el.btnHelp.offsetWidth;
      el.btnHelp.classList.add("help-flash");
      setTimeout(() => el.btnHelp.classList.remove("help-flash"), 3200);
    }
  });

  socket.on("room:ended", () => {
    showEnded("Buổi học đã kết thúc", "Cảm ơn bạn đã học cùng cô. Hẹn gặp lại buổi sau!");
  });

  socket.on("session:replaced", (p) => {
    fatal(p?.message || "Bạn vừa mở phòng này ở tab khác.", "🪟", false);
  });

  socket.on("error:msg", (p) => toast(p?.message || "Có lỗi xảy ra.", "err", 3200));
}

function applyRoomState(s) {
  if (!s) return;
  state.mode = s.mode || "lesson";
  state.pageIndex = Number(s.pageIndex) || 0;
  state.stars = Number(s.stars) || 0;
  state.studentCanDraw = s.studentCanDraw !== false;
  state.teacherPresent = Boolean(s.teacherPresent);
  state.participants = Array.isArray(s.participants) ? s.participants : [];
  state.startedAt = s.startedAt || state.startedAt || Date.now();
  state.screen = s.screen || state.screen;
  state.video = s.video || state.video;

  setStars(state.stars, { animate: false });
  stage?.setScreenSize(state.screen.width, state.screen.height);
  stage?.setMode(state.mode);
  stage?.setPage(state.pageIndex);
  board?.setPage(s.pageKey || (state.mode === "screen" ? "screen" : `lesson:${state.pageIndex}`), s.strokes || []);
  board?.setCanDraw(state.role === "teacher" ? true : state.studentCanDraw);
  toolbar?.setPerm(state.studentCanDraw);
  applyVideoControl(state.video, { silent: true });
  updateSlideUI();
  updateWaitNote();
  renderTiles();
  renderScreen();
}

function applyPresence(p) {
  state.participants = Array.isArray(p?.participants) ? p.participants : [];
  state.teacherPresent = Boolean(p?.teacherPresent);
  updateWaitNote();
  renderTiles();
  const names = state.participants.map((x) => x.name).filter(Boolean);
  if (names.length) document.title = `${names.join(", ")} · Phòng ${CODE}`;
}

function updateWaitNote() {
  const waiting = state.role !== "teacher" && !state.teacherPresent;
  el.waitNote.classList.toggle("hidden", !waiting);
  if (waiting) {
    el.waitNote.textContent = "⏳ Đang chờ cô vào phòng…";
    stage?.setOverlay(
      "wait-teacher",
      "⏳",
      "Đang chờ cô vào phòng…",
      "Bạn vẫn xem được bài học và vẽ chú thích. Khi cô vào, camera sẽ hiện ở khung bên phải."
    );
  } else {
    stage?.hideOverlay("wait-teacher");
  }
}

/* ============================ Khung camera ============================ */

function createTile(participant) {
  const node = document.createElement("div");
  node.className = `cam-tile ${participant.role === "teacher" ? "teacher" : "student"}`;
  node.innerHTML = `
    <div class="video-host"></div>
    <div class="placeholder">📷</div>
    <div class="tag"></div>
    <div class="mic-state">🎙️</div>`;
  return {
    el: node,
    host: node.querySelector(".video-host"),
    placeholder: node.querySelector(".placeholder"),
    tag: node.querySelector(".tag"),
    mic: node.querySelector(".mic-state"),
    played: null,
    userId: participant.userId,
  };
}

function renderTiles() {
  if (!el.camTiles) return;
  const list = [...state.participants];
  if (!list.some((p) => p.userId === state.userId)) {
    list.push({ userId: state.userId, name: state.name, role: state.role, agoraUid: state.selfUid });
  }
  list.sort((a, b) => {
    const ar = a.role === "teacher" ? 0 : 1;
    const br = b.role === "teacher" ? 0 : 1;
    return ar - br || (a.agoraUid || 0) - (b.agoraUid || 0);
  });

  const seen = new Set();
  for (const p of list) {
    if (!p.agoraUid) continue;
    seen.add(p.agoraUid);
    let tile = tiles.get(p.agoraUid);
    if (!tile) {
      tile = createTile(p);
      tiles.set(p.agoraUid, tile);
    }
    el.camTiles.appendChild(tile.el); // giữ đúng thứ tự: cô ở trên, bé ở dưới

    const isSelf = p.userId === state.userId;
    const media = p.media || {};
    const micOn = isSelf ? state.media.mic : media.mic !== false;
    const camOn = isSelf ? state.media.cam : media.cam !== false;

    tile.tag.textContent = `${p.role === "teacher" ? "👩‍🏫 " : "🧒 "}${p.name || (isSelf ? "Bạn" : "Học viên")}${isSelf ? " (bạn)" : ""}`;
    tile.mic.textContent = micOn ? "🎙️" : "🔇";
    tile.mic.classList.toggle("muted", !micOn);

    let track = null;
    if (isSelf) track = camOn && call?.camTrack ? call.camTrack : null;
    else track = camOn ? call?.remoteVideo.get(p.agoraUid) || null : null;

    if (track !== tile.played) {
      try {
        tile.played?.stop?.();
      } catch {
        /* bỏ qua */
      }
      tile.host.innerHTML = "";
      tile.played = null;
      if (track) {
        try {
          track.play(tile.host, { fit: "cover" });
          tile.played = track;
        } catch (err) {
          console.warn("[tiles] play lỗi:", err?.message);
        }
      }
    }
    tile.el.classList.toggle("has-video", Boolean(tile.played));
    tile.placeholder.textContent = p.role === "teacher" ? "👩‍🏫" : "🧒";
  }

  for (const [uid, tile] of [...tiles.entries()]) {
    if (!seen.has(uid)) {
      try {
        tile.played?.stop?.();
      } catch {
        /* bỏ qua */
      }
      tile.el.remove();
      tiles.delete(uid);
    }
  }
}

function renderScreen() {
  if (!el.screenView) return;
  let track = null;
  if (state.role === "teacher") track = state.sharing ? call?.screenTrack || null : null;
  else track = state.screen.uid ? call?.remoteVideo.get(state.screen.uid) || null : null;

  if (track !== screenPlayed) {
    try {
      screenPlayed?.stop?.();
    } catch {
      /* bỏ qua */
    }
    el.screenView.innerHTML = "";
    screenPlayed = null;
    if (track) {
      try {
        track.play(el.screenView, { fit: "contain" });
        screenPlayed = track;
      } catch (err) {
        console.warn("[screen] play lỗi:", err?.message);
      }
    }
  }

  if (state.mode === "screen" && !screenPlayed) {
    stage?.setOverlay(
      "wait-screen",
      "🖥️",
      state.role === "teacher" ? "Đang chuẩn bị chia sẻ màn hình…" : "Đang chờ màn hình của cô…",
      "Hình chia sẻ sẽ hiện ở đây trong vài giây."
    );
  } else {
    stage?.hideOverlay("wait-screen");
  }
}

/* ============================ Agora ============================ */

async function connectCall(devices) {
  if (state.config?.agoraReady === false) {
    // Chưa điền AGORA_APP_ID / AGORA_APP_CERT thật (hoặc AGORA_DISABLED=true):
    // bỏ qua video để không treo, bài học + bảng vẽ + sao vẫn hoạt động đầy đủ.
    showBanner("Chưa cấu hình Agora: video/mic tạm tắt. Bài học, bảng vẽ và sao thưởng vẫn hoạt động.");
    toolbar?.setMic(false, false);
    toolbar?.setCam(false, false);
    toolbar?.setShareSupported(false);
    renderTiles();
    return;
  }
  call = new CallSession({
    code: CODE,
    role: state.role,
    config: state.config,
    onEvent: onCallEvent,
  });
  try {
    await call.init();
    state.selfUid = await call.join();
  } catch (err) {
    console.warn("[agora] không vào được phòng video:", err);
    showBanner("Không kết nối được video (Agora). Bảng vẽ và bài học vẫn dùng được.");
    el.btnHelp.classList.remove("hidden");
    return;
  }
  renderTiles();

  try {
    const res = await call.startLocalMedia({
      micOn: devices.micOn,
      camOn: devices.camOn,
      micId: devices.micId,
      camId: devices.camId,
      resolution: "480p_1", // 480p để tiết kiệm phút miễn phí (mục A5)
    });
    state.media = { mic: res.hasMic && devices.micOn, cam: res.hasCam && devices.camOn };
    toolbar?.setMic(state.media.mic, res.hasMic);
    toolbar?.setCam(state.media.cam, res.hasCam);
    if (res.problems?.length) toast(res.problems[0], "err", 6000);
    broadcastMedia();
    renderTiles();
  } catch (err) {
    toast(describeDeviceError(err), "err", 6000);
  }
}

function onCallEvent(type, payload) {
  switch (type) {
    case "joined":
      state.selfUid = payload.uid;
      renderTiles();
      break;
    case "local-media":
      if (typeof payload.micEnabled === "boolean") state.media.mic = payload.micEnabled;
      if (typeof payload.camEnabled === "boolean") state.media.cam = payload.camEnabled;
      renderTiles();
      break;
    case "video-updated":
      if (isScreenUid(payload.uid)) {
        renderScreen();
      } else {
        renderTiles();
      }
      break;
    case "audio-updated":
      renderTiles();
      break;
    case "user-left":
      renderTiles();
      renderScreen();
      break;
    case "network": {
      const worst = payload.up === "bad" || payload.down === "bad" ? "bad" : payload.up === "mid" || payload.down === "mid" ? "mid" : "good";
      el.netDot.className = `net-dot ${worst}`;
      el.netDot.title = `Mạng: ${worst === "good" ? "tốt" : worst === "mid" ? "trung bình" : "kém"}`;
      break;
    }
    case "volume": {
      for (const [uidStr, level] of Object.entries(payload.levels || {})) {
        const uid = Number(uidStr);
        const tile = tiles.get(uid);
        if (!tile) continue;
        const speaking = Number(level) > 55;
        if (speaking !== tile.el.classList.contains("speaking")) tile.el.classList.toggle("speaking", speaking);
      }
      break;
    }
    case "share-changed":
      if (!payload.active) {
        state.sharing = false;
        toolbar?.setShare(false, canShareScreen());
        renderScreen();
        if (!payload.silent) {
          emitSocket("screen:state", { active: false });
          emitSocket("mode:set", { mode: "lesson" });
          state.mode = "lesson";
          stage?.setMode("lesson");
          updateSlideUI();
        }
        if (payload.byBrowser) toast("Đã dừng chia sẻ màn hình.", "", 2600);
      }
      break;
    case "autoplay-blocked":
      askForAutoplay().then(() => {
        for (const track of call?.remoteAudio.values() || []) {
          try {
            track.play();
          } catch {
            /* bỏ qua */
          }
        }
        if (state.video.playing && state.mode === "lesson" && stage?.isVideoLesson) {
          el.lessonVideo.play().catch(() => {});
        }
      });
      break;
    case "reconnecting":
      showBanner("Mất kết nối video, đang thử lại…");
      break;
    case "reconnected":
      hideBanner();
      toast("Đã kết nối video lại.", "ok", 2200);
      renderTiles();
      renderScreen();
      break;
    case "reconnect-failed":
      showBanner("Không kết nối lại được video. Hãy tải lại trang.", "bad");
      break;
    case "sdk-error":
    case "subscribe-error":
      console.warn("[agora]", type, payload);
      break;
    default:
      break;
  }
}

function broadcastMedia() {
  emitSocket("media:state", { mic: state.media.mic, cam: state.media.cam });
}

/* ============================ Điều khiển bài học ============================ */

function updateSlideUI() {
  const lessonMode = state.mode !== "screen";
  const isVideo = stage?.isVideoLesson;
  el.slideControls.classList.toggle("hidden", !(lessonMode && !isVideo));
  el.videoControls.classList.toggle("hidden", !(lessonMode && isVideo));

  if (!isVideo) {
    const total = state.lesson?.slides?.length || 1;
    el.pageLabel.textContent = `${state.pageIndex + 1}/${total}`;
    const onlyTeacher = state.role !== "teacher";
    el.btnPrev.disabled = onlyTeacher || state.pageIndex <= 0;
    el.btnNext.disabled = onlyTeacher || state.pageIndex >= total - 1;
  }
  el.btnPlayPause.disabled = state.role !== "teacher";
  el.videoSeek.disabled = state.role !== "teacher";
}

function wireStageControls() {
  el.btnPrev.addEventListener("click", () => goToPage(state.pageIndex - 1));
  el.btnNext.addEventListener("click", () => goToPage(state.pageIndex + 1));

  el.btnPlayPause.addEventListener("click", () => {
    const v = el.lessonVideo;
    if (v.paused) {
      v.play()
        .then(() => emitVideo(true))
        .catch(() => askForAutoplay().then(() => v.play().then(() => emitVideo(true)).catch(() => {})));
    } else {
      v.pause();
      emitVideo(false);
    }
  });

  el.videoSeek.addEventListener("input", () => {
    const v = el.lessonVideo;
    if (!v.duration) return;
    const t = (Number(el.videoSeek.value) / 1000) * v.duration;
    v.currentTime = t;
    el.videoTime.textContent = formatTimecode(t);
  });
  el.videoSeek.addEventListener("change", () => emitVideo(!el.lessonVideo.paused));

  el.lessonVideo.addEventListener("play", () => {
    if (state.role === "teacher") emitVideo(true);
    updatePlayButton();
  });
  el.lessonVideo.addEventListener("pause", () => {
    if (state.role === "teacher") emitVideo(false);
    updatePlayButton();
  });
  el.lessonVideo.addEventListener("timeupdate", () => {
    const v = el.lessonVideo;
    if (!v.duration) return;
    el.videoTime.textContent = `${formatTimecode(v.currentTime)} / ${formatTimecode(v.duration)}`;
    if (state.role === "teacher" && document.activeElement !== el.videoSeek) {
      el.videoSeek.value = String(Math.round((v.currentTime / v.duration) * 1000));
    }
  });

  // Giáo viên bấm phím mũi tên để đổi slide
  document.addEventListener("keydown", (e) => {
    if (state.mode === "screen" || stage?.isVideoLesson) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(state.pageIndex + 1);
    if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(state.pageIndex - 1);
  });
}

function goToPage(index) {
  if (state.role !== "teacher") return;
  const total = state.lesson?.slides?.length || 1;
  const next = Math.max(0, Math.min(total - 1, index));
  if (next === state.pageIndex && stage?.mode === "lesson") return;
  state.pageIndex = next;
  stage.setPage(next);
  updateSlideUI();
  emitSocket("page:set", { index: next });
}

function updatePlayButton() {
  el.btnPlayPause.textContent = el.lessonVideo.paused ? "▶" : "⏸";
}

function emitVideo(playing) {
  state.video = { playing, time: el.lessonVideo.currentTime || 0, updatedAt: Date.now() };
  emitSocket("video:control", { playing, time: state.video.time });
}

function applyVideoControl(v, { silent = false } = {}) {
  state.video = { playing: Boolean(v?.playing), time: Number(v?.time) || 0, updatedAt: Number(v?.updatedAt) || Date.now() };
  const video = el.lessonVideo;
  if (!video || !stage?.isVideoLesson) return;

  if (state.role !== "teacher") {
    const age = (Date.now() - state.video.updatedAt) / 1000;
    const target = state.video.time + (state.video.playing ? Math.max(0, age) : 0);
    // Lệch hơn 1,5 giây thì tự tua cho khớp (mục 10.1)
    if (Math.abs(video.currentTime - target) > 1.5) video.currentTime = target;
    if (state.video.playing && video.paused) {
      video.play().catch(() => {
        if (!silent) {
          askForAutoplay().then(() => video.play().catch(() => {}));
        }
      });
    } else if (!state.video.playing && !video.paused) {
      video.pause();
    }
  }
  updatePlayButton();
  if (video.duration) el.videoSeek.value = String(Math.round((Math.min(video.currentTime, video.duration) / video.duration) * 1000));
}

/** Giáo viên phát lại tiến độ mỗi 5 giây; học viên tự kiểm tra lệch. */
function startVideoSync() {
  if (videoSyncId) clearInterval(videoSyncId);
  videoSyncId = setInterval(() => {
    if (!stage?.isVideoLesson || state.mode !== "lesson") return;
    const video = el.lessonVideo;
    if (state.role === "teacher") {
      if (!video.paused) emitVideo(true);
      return;
    }
    if (!state.video.playing) return;
    const age = (Date.now() - state.video.updatedAt) / 1000;
    const target = state.video.time + age;
    if (Math.abs(video.currentTime - target) > 1.5) {
      video.currentTime = target;
      toast("Đã đồng bộ lại tiến độ video với cô.", "", 1800);
    }
  }, 5000);
}

/* ============================ Thanh trên / toolbar ============================ */

function wireTopbar() {
  const isTeacher = state.role === "teacher";
  el.starCtl.classList.toggle("hidden", !isTeacher);
  el.btnEnd.classList.toggle("hidden", !isTeacher);
  el.btnHelp.textContent = isTeacher ? "❔ Hướng dẫn" : "🙋 Trợ giúp";

  el.btnStarPlus?.addEventListener("click", () => emitSocket("star:give", { delta: 1 }));
  el.btnStarMinus?.addEventListener("click", () => emitSocket("star:give", { delta: -1 }));

  el.btnHelp.addEventListener("click", () => {
    if (isTeacher) {
      showTeacherHelp();
    } else {
      emitSocket("help:request", {});
      toast("Đã gửi yêu cầu trợ giúp tới cô 🙋", "ok", 2600);
    }
  });

  el.btnEnd.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Kết thúc buổi học?",
      message: "Mọi người sẽ rời phòng và không vào lại được bằng mã này.",
      okText: "Kết thúc",
      cancelText: "Học tiếp",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.endRoom(CODE);
    } catch (err) {
      toast(err.message, "err");
    }
    showEnded("Buổi học đã kết thúc", "Cảm ơn cô và bé. Hẹn gặp lại buổi sau!");
  });

  el.btnBack.addEventListener("click", () => toolbarCallbacks().onLeave());
}

function showTeacherHelp() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h2>❔ Hướng dẫn nhanh cho cô</h2>
    <p class="sub">Phím tắt và mẹo dùng phòng học.</p>
    <ul style="line-height:1.9;padding-left:20px;margin:0;font-size:14.5px">
      <li><b>← / →</b>: đổi slide (học viên thấy ngay).</li>
      <li><b>Bút / Dạ quang / Tẩy</b>: tẩy sẽ xoá cả nét bị chạm vào.</li>
      <li><b>Undo</b> chỉ xoá nét của người bấm; <b>Xoá hết</b> chỉ cô dùng được.</li>
      <li><b>Bút của bé</b>: bật/tắt quyền vẽ của học viên (server kiểm tra, học viên không lách được).</li>
      <li><b>Chia sẻ MH</b>: chọn cửa sổ/tab KHÁC, tránh chia sẻ chính trang này để không bị lặp hình.</li>
      <li>Nét vẽ của mỗi slide được giữ lại khi lật trang và khi học viên vào muộn.</li>
    </ul>
    <div class="modal-actions"><button type="button" class="primary" id="helpClose">Đã hiểu</button></div>`;
  wrap.querySelector("#helpClose").addEventListener("click", () => closeModal());
  openModal(wrap);
}

function toolbarCallbacks() {
  return {
    onNotice: (msg) => toast(msg, "", 2000),
    onClear: async () => {
      const ok = await confirmDialog({
        title: "Xoá toàn bộ nét vẽ?",
        message: "Nét vẽ của trang này sẽ bị xoá cho cả hai bên.",
        okText: "Xoá hết",
        cancelText: "Giữ lại",
        danger: true,
      });
      if (!ok) return;
      board.clear();
    },
    onPerm: async (allowed) => {
      emitSocket("perm:draw", { allowed });
      board.setCanDraw(state.role === "teacher" ? true : allowed);
      toolbar.setPerm(allowed);
      toast(allowed ? "🔓 Đã mở bút cho bé" : "🔒 Đã tạm khoá bút của bé", "", 2400);
    },
    onMic: async () => {
      if (!call) {
        toast("Chưa cấu hình Agora nên không có âm thanh. Xem hướng dẫn trong README.", "err", 4200);
        return;
      }
      if (!call?.micTrack) {
        toast("Chưa có micro. Hãy tải lại trang và cho phép micro.", "err", 4000);
        return;
      }
      const next = !(state.media.mic && call.micEnabled);
      await call.setMicEnabled(next);
      state.media.mic = call.micEnabled;
      toolbar.setMic(state.media.mic, true);
      broadcastMedia();
      renderTiles();
    },
    onCam: async () => {
      if (!call) {
        toast("Chưa cấu hình Agora nên không có hình ảnh. Xem hướng dẫn trong README.", "err", 4200);
        return;
      }
      if (!call?.camTrack) {
        toast("Chưa có camera. Hãy tải lại trang và cho phép camera.", "err", 4000);
        return;
      }
      const next = !(state.media.cam && call.camEnabled);
      await call.setCamEnabled(next);
      state.media.cam = call.camEnabled;
      toolbar.setCam(state.media.cam, true);
      broadcastMedia();
      renderTiles();
    },
    onShare: () => toggleShare(),
    onLeave: async () => {
      const isTeacher = state.role === "teacher";
      const ok = await confirmDialog({
        title: isTeacher ? "Rời phòng?" : "Rời khỏi phòng?",
        message: isTeacher
          ? `Phòng được giữ ${state.config?.teacherGraceMinutes || 10} phút để cô quay lại. Nếu muốn kết thúc hẳn, bấm "Kết thúc buổi học" ở góc trên.`
          : "Bạn sẽ rời buổi học. Muốn vào lại thì mở link của cô một lần nữa.",
        okText: "Rời phòng",
        cancelText: "Ở lại",
        danger: true,
      });
      if (!ok) return;
      await leaveRoom();
      location.href = "/";
    },
  };
}

/* ============================ Chia sẻ màn hình ============================ */

function showScreenWarn(text) {
  if (!text) {
    el.screenWarn.classList.add("hidden");
    return;
  }
  el.screenWarn.textContent = text;
  el.screenWarn.classList.remove("hidden");
}

async function toggleShare() {
  if (state.role !== "teacher") return;
  if (!canShareScreen()) {
    toast("Thiết bị này không hỗ trợ chia sẻ màn hình trên trình duyệt. Hãy dùng máy tính.", "err", 4000);
    return;
  }
  if (state.sharing) {
    await stopShare();
    return;
  }
  if (!call?.joined) {
    toast("Chưa kết nối video nên không chia sẻ màn hình được.", "err", 3500);
    return;
  }

  const ok = await confirmDialog({
    title: "Chia sẻ màn hình",
    message:
      "Hãy chọn chia sẻ MỘT CỬA SỔ HOẶC TAB KHÁC. Không chia sẻ chính trang này để tránh hiệu ứng lặp hình vô tận.",
    okText: "Chọn màn hình",
    cancelText: "Huỷ",
  });
  if (!ok) return;

  try {
    showScreenWarn("Đang chờ bạn chọn cửa sổ để chia sẻ…");
    const info = await call.startShare();
    state.sharing = true;
    state.screen = { active: true, width: info.width, height: info.height, uid: info.uid };
    toolbar.setShare(true, true);
    stage.setScreenSize(info.width, info.height);
    showScreenWarn("Đang chia sẻ màn hình. Học viên xem và vẽ chú thích được trên hình này.");
    renderScreen();
    // Báo cho học viên: kích thước hình -> mode screen (mục 9.4)
    emitSocket("screen:state", { active: true, width: info.width, height: info.height });
    emitSocket("mode:set", { mode: "screen" });
    state.mode = "screen";
    stage.setMode("screen");
    updateSlideUI();
  } catch (err) {
    showScreenWarn(null);
    const name = String(err?.name || "");
    if (name.includes("NotAllowed") || /cancel|denied|permission/i.test(String(err?.message || ""))) {
      toast("Bạn đã huỷ chia sẻ màn hình.", "", 2600);
    } else {
      toast(`Không chia sẻ màn hình được: ${err?.message || name}`, "err", 5000);
    }
    try {
      await call.stopShare({ silent: true });
    } catch {
      /* bỏ qua */
    }
    state.sharing = false;
    toolbar.setShare(false, true);
  }
}

async function stopShare() {
  try {
    await call.stopShare();
  } catch {
    /* bỏ qua */
  }
  state.sharing = false;
  state.screen = { ...state.screen, active: false, uid: null };
  toolbar.setShare(false, canShareScreen());
  showScreenWarn(null);
  emitSocket("screen:state", { active: false });
  emitSocket("mode:set", { mode: "lesson" });
  state.mode = "lesson";
  stage.setMode("lesson");
  updateSlideUI();
  renderScreen();
}

/* ============================ Đồng hồ / kết thúc ============================ */

function startTimer() {
  if (timerId) clearInterval(timerId);
  const tick = () => {
    const from = state.startedAt || Date.now();
    el.timer.textContent = formatClock(Date.now() - from);
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function showEnded(title, text) {
  if (state.ended) return;
  state.ended = true;
  hideBanner();
  el.board.classList.add("no-draw");
  stage?.setOverlay("ended", "👋", title, text, [
    { label: "Về trang chủ", className: "primary", onClick: () => (location.href = "/") },
  ]);
  try {
    call?.leave();
  } catch {
    /* bỏ qua */
  }
  try {
    socket?.disconnect();
  } catch {
    /* bỏ qua */
  }
  if (timerId) clearInterval(timerId);
  if (videoSyncId) clearInterval(videoSyncId);
}

function fatal(message, emoji = "😵", canRetry = true) {
  state.ended = true;
  const host = el.overlay || $("#stageOverlay");
  const wrap = host || document.body;
  if (host) {
    host.innerHTML = "";
    const e = document.createElement("div");
    e.className = "big";
    e.textContent = emoji;
    const h = document.createElement("h3");
    h.textContent = "Không vào được phòng";
    const p = document.createElement("p");
    p.textContent = message;
    host.append(e, h, p);
    const back = document.createElement("button");
    back.type = "button";
    back.className = "primary";
    back.textContent = "Về trang chủ";
    back.addEventListener("click", () => (location.href = "/"));
    host.appendChild(back);
    if (canRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Thử lại";
      retry.addEventListener("click", () => location.reload());
      host.appendChild(retry);
    }
    host.classList.remove("hidden");
    host.dataset.kind = "fatal";
  } else {
    wrap.textContent = message;
  }
  showBanner(message, "bad");
  try {
    call?.hardLeave();
  } catch {
    /* bỏ qua */
  }
}

async function leaveRoom() {
  try {
    board?._flush?.();
  } catch {
    /* bỏ qua */
  }
  try {
    await call?.leave();
  } catch {
    /* bỏ qua */
  }
  try {
    socket?.disconnect();
  } catch {
    /* bỏ qua */
  }
}
