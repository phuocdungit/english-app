/**
 * public/js/whiteboard.js
 * Bảng vẽ phủ lên khung bài học.
 *
 * - Toạ độ gửi đi CHUẨN HOÁ 0..1 theo vùng nội dung (mục A7 + 10.2).
 * - Pointer Events: dùng được với chuột, cảm ứng và bút; canvas có touch-action:none.
 * - Điểm vẽ được gom lại và gửi mỗi 40 ms (không gửi từng pixel).
 * - Nét lưu theo từng trang (lesson:0, lesson:1, screen) do server giữ.
 */
import { nanoid } from "./ui.js";

export const COLORS = ["#e53e5a", "#2b8cff", "#22b573", "#ffc93c", "#8e44ad", "#ff8a3d", "#1f2937", "#ffffff"];
export const WIDTHS = [0.003, 0.0065, 0.013]; // tỉ lệ so với chiều rộng khung
export const TOOLS = ["pen", "highlighter", "eraser", "laser"];

const FLUSH_MS = 40;
const MIN_POINT_DIST = 1.4; // px — bỏ qua các điểm quá gần nhau
const ERASER_RADIUS = 16; // px
const MAX_DPR = 2;

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export class Whiteboard {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas
   * @param {HTMLElement} o.laserLayer
   * @param {import('./stage.js').Stage} o.stage
   * @param {{emit:(ev:string,payload:object)=>void}} o.socket
   * @param {"teacher"|"student"} o.role
   * @param {(info:object)=>void} o.onLockedNotice
   */
  constructor({ canvas, laserLayer, stage, socket, role, onLockedNotice }) {
    this.canvas = canvas;
    this.laserLayer = laserLayer;
    this.stage = stage;
    this.socket = socket;
    this.role = role;
    this.onLockedNotice = onLockedNotice || (() => {});

    this.ctx = canvas.getContext("2d", { alpha: true });
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.view = { width: 0, height: 0 };

    this.tool = "pen";
    this.color = role === "teacher" ? COLORS[0] : COLORS[1];
    this.width = WIDTHS[1];
    this.canDraw = true;

    /** Nét đã chốt của trang hiện tại */
    this.strokes = [];
    /** Nét đang vẽ dở (của mình và của người khác) */
    this.active = new Map();
    this.localStroke = null;
    this.pageKey = "lesson:0";

    this._buffer = [];
    this._flushTimer = setInterval(() => this._flush(), FLUSH_MS);
    this._pointerId = null;
    this._laserThrottle = 0;
    this._eraseBuffer = new Set();
    this._eraseTimer = 0;
    this._laserDots = new Map();

    this._bindEvents();
  }

  /* ---------------- Cấu hình công cụ ---------------- */

  setTool(tool) {
    this.tool = TOOLS.includes(tool) ? tool : "pen";
    this.canvas.classList.toggle("tool-eraser", this.tool === "eraser");
    this.canvas.classList.toggle("tool-laser", this.tool === "laser");
    if (this.tool !== "laser") this.socket.emit("laser:move", { off: true });
    return this.tool;
  }

  setColor(color) {
    if (/^#[0-9a-fA-F]{6}$/.test(String(color))) this.color = String(color).toLowerCase();
    if (this.tool === "eraser" || this.tool === "laser") this.setTool("pen");
    return this.color;
  }

  setWidth(w) {
    const n = Number(w);
    if (Number.isFinite(n) && n > 0) this.width = Math.min(0.05, Math.max(0.0005, n));
    return this.width;
  }

  /** Giáo viên khoá/mở bút của học viên (mục 8.1 perm:draw). */
  setCanDraw(allowed) {
    this.canDraw = Boolean(allowed);
    const student = this.role !== "teacher";
    const blocked = student && !this.canDraw;
    this.canvas.classList.toggle("locked", blocked);
    this.canvas.classList.toggle("no-draw", blocked);
    if (blocked) {
      this._endLocalStroke(true);
      this.onLockedNotice({ locked: true });
    } else {
      this.onLockedNotice({ locked: false });
    }
    return this.canDraw;
  }

  /* ---------------- Kích thước / vẽ lại ---------------- */

  resize(view) {
    const next = view || this.stage?.getContentRect() || this.view;
    const w = Math.max(1, Math.round(next.width));
    const h = Math.max(1, Math.round(next.height));
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.view = { width: w, height: h };
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.redrawAll();
  }

  toPx(x, y) {
    return { x: x * this.view.width, y: y * this.view.height };
  }

  toNorm(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [Math.min(1.25, Math.max(-0.25, x)), Math.min(1.25, Math.max(-0.25, y))];
  }

  _style(stroke) {
    const base = Number(stroke.width) || this.width;
    const isHl = stroke.tool === "highlighter";
    return {
      lineWidth: Math.max(1, base * (isHl ? 3 : 1) * this.view.width),
      alpha: isHl ? 0.4 : 1,
      color: stroke.color || "#e53e5a",
      eraser: stroke.tool === "eraser",
    };
  }

  /** Vẽ trọn một nét (dùng khi redrawAll). */
  _drawFull(stroke) {
    const pts = stroke.points || [];
    if (!pts.length) return;
    const s = this._style(stroke);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.lineWidth = s.lineWidth;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.globalCompositeOperation = s.eraser ? "destination-out" : "source-over";

    if (pts.length === 1) {
      const p = this.toPx(pts[0][0], pts[0][1]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    let prev = this.toPx(pts[0][0], pts[0][1]);
    ctx.moveTo(prev.x, prev.y);
    for (let i = 1; i < pts.length - 1; i += 1) {
      const cur = this.toPx(pts[i][0], pts[i][1]);
      const next = this.toPx(pts[i + 1][0], pts[i + 1][1]);
      const mid = midpoint(cur, next);
      // Làm mượt nét bằng quadraticCurveTo (mục 10.2)
      ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
      prev = mid;
    }
    const last = this.toPx(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Vẽ nối tiếp CÁC ĐIỂM MỚI của nét đang vẽ dở (O(1) cho mỗi điểm).
   * Kỹ thuật: nối từ "điểm giữa" trước đó bằng quadraticCurveTo để nét mượt.
   */
  _drawIncremental(stroke, newPoints) {
    if (!newPoints || !newPoints.length) return;
    const s = this._style(stroke);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.lineWidth = s.lineWidth;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.globalCompositeOperation = s.eraser ? "destination-out" : "source-over";

    let pts = newPoints;
    if (!stroke._last) {
      const p = this.toPx(pts[0][0], pts[0][1]);
      stroke._last = p;
      stroke._lastMid = p;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      pts = pts.slice(1);
    }
    for (let i = 0; i < pts.length; i += 1) {
      const cur = this.toPx(pts[i][0], pts[i][1]);
      const mid = midpoint(stroke._last, cur);
      ctx.beginPath();
      ctx.moveTo(stroke._lastMid.x, stroke._lastMid.y);
      ctx.quadraticCurveTo(stroke._last.x, stroke._last.y, mid.x, mid.y);
      ctx.stroke();
      stroke._lastMid = mid;
      stroke._last = cur;
    }
    ctx.restore();
  }

  /** Đặt lại trạng thái "đuôi nét" sau khi vẽ trọn, để vẽ tiếp không bị đứt. */
  _syncTail(stroke) {
    const pts = stroke.points || [];
    if (!pts.length) {
      stroke._last = null;
      stroke._lastMid = null;
      return;
    }
    const last = this.toPx(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    if (pts.length === 1) {
      stroke._last = last;
      stroke._lastMid = last;
      return;
    }
    const prev = this.toPx(pts[pts.length - 2][0], pts[pts.length - 2][1]);
    stroke._last = last;
    stroke._lastMid = midpoint(prev, last);
  }

  redrawAll() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    for (const stroke of this.strokes) {
      stroke._last = null;
      stroke._lastMid = null;
      this._drawFull(stroke);
    }
    for (const stroke of this.active.values()) {
      stroke._last = null;
      stroke._lastMid = null;
      this._drawFull(stroke);
      // Nét đang vẽ dở: nhớ vị trí đuôi để các điểm tới vẽ tiếp liền mạch
      this._syncTail(stroke);
    }
  }

  /* ---------------- Dữ liệu trang ---------------- */

  setPage(pageKey, strokes = []) {
    this.pageKey = pageKey;
    this.strokes = Array.isArray(strokes)
      ? strokes.map((s) => ({ ...s, points: (s.points || []).map((p) => [p[0], p[1]]) }))
      : [];
    this.active.clear();
    this._buffer = [];
    this.localStroke = null;
    this.clearLaser();
    this.redrawAll();
  }

  _findAnywhere(id) {
    const a = this.active.get(id);
    if (a) return a;
    return this.strokes.find((s) => s.id === id) || null;
  }

  /* ---------------- Sự kiện từ server ---------------- */

  onRemoteBegin(payload) {
    if (!payload?.id) return;
    const stroke = {
      id: payload.id,
      userId: payload.userId,
      tool: payload.tool || "pen",
      color: payload.color || "#2b8cff",
      width: Number(payload.width) || 0.004,
      points: (payload.points || []).slice(),
    };
    this.active.set(stroke.id, stroke);
    this._drawIncremental(stroke, stroke.points);
  }

  onRemoteAppend(payload) {
    const stroke = this._findAnywhere(payload?.id);
    if (!stroke) return;
    if (this.localStroke && stroke.id === this.localStroke.id) return; // không vẽ lại nét của mình
    const pts = Array.isArray(payload.points) ? payload.points : [];
    if (!pts.length) return;
    stroke.points.push(...pts);
    this._drawIncremental(stroke, pts);
  }

  onRemoteEnd(payload) {
    const stroke = this.active.get(payload?.id);
    if (!stroke) return;
    this.active.delete(stroke.id);
    stroke._last = null;
    stroke._lastMid = null;
    this.strokes.push(stroke);
    this._drawFull(stroke);
  }

  onRemoteUndo(payload) {
    this._removeIds([payload?.id]);
  }

  onRemoteErase(payload) {
    this._removeIds(payload?.ids || []);
  }

  onRemoteClear() {
    this.strokes = [];
    this.active.clear();
    this.localStroke = null;
    this._buffer = [];
    this.redrawAll();
  }

  _removeIds(ids) {
    const set = new Set(ids.filter(Boolean));
    if (!set.size) return;
    this.strokes = this.strokes.filter((s) => !set.has(s.id));
    for (const id of set) this.active.delete(id);
    if (this.localStroke && set.has(this.localStroke.id)) this.localStroke = null;
    this.redrawAll();
  }

  /* ---------------- Vẽ cục bộ ---------------- */

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    c.addEventListener("pointerup", (e) => this._onUp(e));
    c.addEventListener("pointercancel", (e) => this._onUp(e));
    c.addEventListener("pointerleave", (e) => {
      if (this.tool === "laser") this.socket.emit("laser:move", { off: true });
      if (e.pointerId === this._pointerId) this._onUp(e);
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _allowed() {
    if (this.role !== "teacher" && !this.canDraw) {
      this.onLockedNotice({ locked: true, transient: true });
      return false;
    }
    return true;
  }

  _onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
    if (this._pointerId !== null) return; // chỉ một nét mỗi lần
    if (!this._allowed()) return;
    const norm = this.toNorm(e.clientX, e.clientY);
    if (!norm) return;

    if (this.tool === "laser") {
      this._pointerId = e.pointerId;
      this.canvas.setPointerCapture?.(e.pointerId);
      this._emitLaser(norm);
      this.showLocalLaser(norm);
      return;
    }

    if (this.tool === "eraser") {
      this._pointerId = e.pointerId;
      this.canvas.setPointerCapture?.(e.pointerId);
      this._eraseAt(e.clientX, e.clientY);
      return;
    }

    this._pointerId = e.pointerId;
    this.canvas.setPointerCapture?.(e.pointerId);

    const stroke = {
      id: `s_${nanoid(10)}`,
      userId: null, // server tự gắn userId từ JWT, không tin client
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [norm],
    };
    stroke._consumed = 0;
    this.localStroke = stroke;
    this.active.set(stroke.id, stroke);
    this._drawIncremental(stroke, stroke.points);
    this._lastClient = { x: e.clientX, y: e.clientY };
    this.socket.emit("stroke:begin", {
      id: stroke.id,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points,
    });
  }

  _onMove(e) {
    if (this.tool === "laser" && this._pointerId === null) {
      // Di chuột (không bấm) vẫn hiện laser cho người khác thấy — chỉ khi đang giữ chuột
      return;
    }
    if (this._pointerId === null || e.pointerId !== this._pointerId) return;
    const norm = this.toNorm(e.clientX, e.clientY);
    if (!norm) return;

    if (this.tool === "laser") {
      this._emitLaser(norm);
      this.showLocalLaser(norm);
      return;
    }
    if (this.tool === "eraser") {
      this._eraseAt(e.clientX, e.clientY);
      return;
    }

    const stroke = this.localStroke;
    if (!stroke) return;
    const lastPx = this.toPx(stroke.points[stroke.points.length - 1][0], stroke.points[stroke.points.length - 1][1]);
    const curPx = this.toPx(norm[0], norm[1]);
    const dist = Math.hypot(curPx.x - lastPx.x, curPx.y - lastPx.y);
    if (dist < MIN_POINT_DIST) return;

    stroke.points.push(norm);
    this._drawIncremental(stroke, [norm]);
    this._buffer.push(norm);
  }

  _onUp(e) {
    if (this._pointerId === null) return;
    if (e.pointerId !== undefined && e.pointerId !== this._pointerId) return;
    try {
      this.canvas.releasePointerCapture?.(this._pointerId);
    } catch {
      /* bỏ qua */
    }
    this._pointerId = null;

    if (this.tool === "laser") {
      this.socket.emit("laser:move", { off: true });
      return;
    }
    if (this.tool === "eraser") {
      this._flushErase();
      return;
    }
    this._endLocalStroke(false);
  }

  _endLocalStroke(silent) {
    const stroke = this.localStroke;
    this.localStroke = null;
    if (this._buffer.length) this._flush();
    if (!stroke) return;
    if (!silent) this.socket.emit("stroke:end", { id: stroke.id });
    const active = this.active.get(stroke.id);
    if (active) {
      this.active.delete(stroke.id);
      active._last = null;
      active._lastMid = null;
      active._consumed = 0;
      this.strokes.push(active);
      this._drawFull(active);
    }
  }

  _flush() {
    if (!this._buffer.length || !this.localStroke) return;
    const points = this._buffer;
    this._buffer = [];
    this.socket.emit("stroke:append", { id: this.localStroke.id, points });
  }

  _emitLaser(norm) {
    const now = performance.now();
    if (now - this._laserThrottle < 33) return; // tối đa ~30 lần/giây (mục 8.1)
    this._laserThrottle = now;
    this.socket.emit("laser:move", { x: norm[0], y: norm[1] });
  }

  /* ---------------- Tẩy: xoá nét bị chạm ---------------- */

  _eraseAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const r = ERASER_RADIUS;
    const hits = [];

    const test = (stroke) => {
      const pts = stroke.points || [];
      for (let i = 0; i < pts.length; i += 1) {
        const p = this.toPx(pts[i][0], pts[i][1]);
        if (Math.abs(p.x - px) <= r && Math.abs(p.y - py) <= r) {
          if (Math.hypot(p.x - px, p.y - py) <= r) return true;
        }
      }
      // Nét dài có thể đi qua con trỏ mà không có điểm nào gần: kiểm tra từng đoạn
      for (let i = 1; i < pts.length; i += 1) {
        const a = this.toPx(pts[i - 1][0], pts[i - 1][1]);
        const b = this.toPx(pts[i][0], pts[i][1]);
        if (distToSegment(px, py, a, b) <= r) return true;
      }
      return false;
    };

    for (let i = this.strokes.length - 1; i >= 0; i -= 1) {
      if (test(this.strokes[i])) hits.push(this.strokes[i].id);
    }
    for (const stroke of this.active.values()) {
      if (stroke.id === this.localStroke?.id) continue;
      if (test(stroke)) hits.push(stroke.id);
    }
    if (!hits.length) {
      this._paintEraserCursor(px, py);
      return;
    }
    for (const id of hits) this._eraseBuffer.add(id);
    this._removeIds(hits);
    const now = performance.now();
    if (now - this._eraseTimer > 120) this._flushErase();
  }

  _paintEraserCursor() {
    // Không vẽ gì thêm: con trỏ CSS (cell) đã báo vị trí tẩy
  }

  _flushErase() {
    if (!this._eraseBuffer.size) return;
    const ids = [...this._eraseBuffer];
    this._eraseBuffer.clear();
    this._eraseTimer = performance.now();
    this.socket.emit("stroke:erase", { ids });
  }

  /* ---------------- Undo / xoá hết ---------------- */

  undo() {
    // Xoá nét cuối cùng CỦA CHÍNH MÌNH ở trang hiện tại (mục 8.1)
    for (let i = this.strokes.length - 1; i >= 0; i -= 1) {
      const s = this.strokes[i];
      if (s.userId == null || s.userId === this.selfUserId) {
        this.strokes.splice(i, 1);
        this.socket.emit("stroke:undo", {});
        this.redrawAll();
        return true;
      }
    }
    return false;
  }

  clear() {
    this.socket.emit("board:clear", {});
    this.onRemoteClear();
  }

  setSelfUserId(userId) {
    this.selfUserId = userId;
  }

  /* ---------------- Laser ---------------- */

  showLaser(userId, norm) {
    if (!this.laserLayer) return;
    let dot = this._laserDots.get(userId);
    if (!dot) {
      dot = document.createElement("div");
      dot.className = "laser-dot";
      this.laserLayer.appendChild(dot);
      this._laserDots.set(userId, dot);
    }
    dot.style.left = `${Math.max(-2, Math.min(102, norm[0] * 100))}%`;
    dot.style.top = `${Math.max(-2, Math.min(102, norm[1] * 100))}%`;
    dot.classList.remove("fade");
    clearTimeout(dot._t);
    // Chấm laser tự mờ sau 1 giây, không lưu (mục 10.2)
    dot._t = setTimeout(() => {
      dot.classList.add("fade");
      setTimeout(() => {
        dot.remove();
        if (this._laserDots.get(userId) === dot) this._laserDots.delete(userId);
      }, 400);
    }, 1000);
  }

  showLocalLaser(norm) {
    this.showLaser("__me__", norm);
  }

  hideLaser(userId) {
    const dot = this._laserDots.get(userId);
    if (!dot) return;
    dot.classList.add("fade");
    setTimeout(() => dot.remove(), 350);
    this._laserDots.delete(userId);
  }

  clearLaser() {
    for (const dot of this._laserDots.values()) dot.remove();
    this._laserDots.clear();
  }

  destroy() {
    clearInterval(this._flushTimer);
    this.clearLaser();
  }
}

/** Khoảng cách từ điểm P tới đoạn AB. */
function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
