/**
 * public/js/toolbar.js
 * Dựng và nối dây thanh công cụ: bút, màu, nét, tẩy, undo, xoá hết, laser,
 * quyền vẽ của học viên, mic, camera, chia sẻ màn hình, rời phòng.
 */
import { $, $$ } from "./ui.js";
import { COLORS, WIDTHS } from "./whiteboard.js";

/**
 * @param {object} o
 * @param {"teacher"|"student"} o.role
 * @param {import("./whiteboard.js").Whiteboard} o.board bảng vẽ
 * @param {object} o.callbacks
 */
export function mountToolbar({ role, board, callbacks = {} }) {
  const isTeacher = role === "teacher";

  const toolButtons = $$("#toolGroup .tool-btn[data-tool]");
  const btnUndo = $("#btnUndo");
  const btnClear = $("#btnClear");
  const btnPerm = $("#btnPerm");
  const btnMic = $("#btnMic");
  const btnCam = $("#btnCam");
  const btnShare = $("#btnShare");
  const btnLeave = $("#btnLeave");
  const swatchHost = $("#swatches");
  const widthHost = $("#widths");

  /* ---- Công cụ ---- */
  function selectTool(tool) {
    toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    board.setTool(tool);
  }
  toolButtons.forEach((b) => {
    b.addEventListener("click", () => {
      selectTool(b.dataset.tool);
      callbacks.onTool?.(b.dataset.tool);
    });
  });

  /* ---- Màu ---- */
  const swatches = [];
  COLORS.forEach((color) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = color;
    b.title = color;
    b.setAttribute("aria-label", `Màu ${color}`);
    b.addEventListener("click", () => {
      board.setColor(color);
      swatches.forEach((s) => s.el.classList.toggle("active", s.color === color));
      if (board.tool === "eraser" || board.tool === "laser") selectTool("pen");
      callbacks.onColor?.(color);
    });
    swatchHost.appendChild(b);
    swatches.push({ el: b, color });
  });

  /* ---- Độ dày nét ---- */
  const widthButtons = [];
  WIDTHS.forEach((w, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = `Nét ${idx + 1}`;
    const dot = document.createElement("span");
    dot.className = `dot ${["s", "m", "l"][idx]}`;
    b.appendChild(dot);
    b.addEventListener("click", () => {
      board.setWidth(w);
      widthButtons.forEach((x) => x.el.classList.toggle("active", x.w === w));
    });
    widthHost.appendChild(b);
    widthButtons.push({ el: b, w });
  });

  // Mặc định: giáo viên đỏ #e53e5a, học viên xanh #2b8cff, nét vừa (mục 10.2)
  const defaultColor = isTeacher ? COLORS[0] : COLORS[1];
  board.setColor(defaultColor);
  board.setWidth(WIDTHS[1]);
  swatches.forEach((s) => s.el.classList.toggle("active", s.color === defaultColor));
  widthButtons.forEach((x) => x.el.classList.toggle("active", x.w === WIDTHS[1]));

  /* ---- Undo / xoá hết ---- */
  btnUndo?.addEventListener("click", () => {
    if (!board.undo()) callbacks.onNotice?.("Bạn chưa vẽ nét nào ở trang này.");
  });
  if (isTeacher) {
    btnClear?.classList.remove("hidden");
    btnClear?.addEventListener("click", () => callbacks.onClear?.());
  } else {
    btnClear?.classList.add("hidden");
  }

  /* ---- Quyền vẽ của học viên (chỉ giáo viên thấy) ---- */
  if (isTeacher) {
    btnPerm?.classList.remove("hidden");
    btnPerm?.addEventListener("click", () => callbacks.onPerm?.(!board.canDraw));
  } else {
    btnPerm?.classList.add("hidden");
  }

  /* ---- Mic / Cam / Share / Rời ---- */
  btnMic?.addEventListener("click", () => callbacks.onMic?.());
  btnCam?.addEventListener("click", () => callbacks.onCam?.());
  btnShare?.addEventListener("click", () => callbacks.onShare?.());
  btnLeave?.addEventListener("click", () => callbacks.onLeave?.());

  return {
    selectTool,
    setMic(on, available = true) {
      if (!btnMic) return;
      btnMic.classList.toggle("on", Boolean(on) && available);
      btnMic.classList.toggle("off", !on || !available);
      btnMic.querySelector(".ico").textContent = on && available ? "🎙️" : "🔇";
      btnMic.disabled = !available;
      btnMic.title = available ? (on ? "Tắt micro" : "Bật micro") : "Không có micro khả dụng";
    },
    setCam(on, available = true) {
      if (!btnCam) return;
      btnCam.classList.toggle("on", Boolean(on) && available);
      btnCam.classList.toggle("off", !on || !available);
      btnCam.querySelector(".ico").textContent = on && available ? "📷" : "🚫";
      btnCam.disabled = !available;
      btnCam.title = available ? (on ? "Tắt camera" : "Bật camera") : "Không có camera khả dụng";
    },
    setShare(active, supported) {
      if (!btnShare) return;
      if (!supported) {
        btnShare.classList.add("hidden"); // ẩn hẳn trên di động, không báo lỗi (mục 9.4)
        return;
      }
      btnShare.classList.remove("hidden");
      btnShare.classList.toggle("active", Boolean(active));
      btnShare.querySelector(".ico").textContent = active ? "⏹️" : "🖥️";
      btnShare.lastChild.textContent = active ? "Dừng chia sẻ" : "Chia sẻ MH";
    },
    setPerm(allowed) {
      if (!btnPerm) return;
      btnPerm.classList.toggle("active", !allowed);
      btnPerm.querySelector(".ico").textContent = allowed ? "🔓" : "🔒";
      btnPerm.lastChild.textContent = allowed ? "Bút của bé: BẬT" : "Bút của bé: TẮT";
    },
    setEndVisible(visible) {
      const btn = $("#btnEnd");
      if (btn) btn.classList.toggle("hidden", !visible);
    },
    setShareSupported(supported) {
      if (!btnShare) return;
      btnShare.classList.toggle("hidden", !supported);
    },
  };
}
