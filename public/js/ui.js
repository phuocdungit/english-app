/**
 * public/js/ui.js
 * Các thành phần giao diện dùng chung: toast, modal, banner, hiệu ứng sao, âm thanh.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape mọi chuỗi hiển thị ra HTML (mục 12.6 - chống XSS). */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- Toast ---------------- */

export function toast(message, kind = "", ms = 3200) {
  let host = $("#toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

/* ---------------- Banner (mất kết nối...) ---------------- */

let bannerEl = null;
export function showBanner(message, kind = "") {
  if (!bannerEl) {
    bannerEl = document.createElement("div");
    bannerEl.id = "banner";
    document.body.prepend(bannerEl);
  }
  bannerEl.className = kind;
  bannerEl.textContent = message;
  bannerEl.classList.remove("hidden");
}
export function hideBanner() {
  if (bannerEl) bannerEl.classList.add("hidden");
}

/* ---------------- Notice trong form ---------------- */

export function setNotice(host, message, kind = "error") {
  if (!host) return;
  if (!message) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="notice ${kind}">${escapeHtml(message)}</div>`;
}

/* ---------------- Modal ---------------- */

let backdrop = null;

/**
 * Mở modal dựng từ DOM (không innerHTML với dữ liệu người dùng).
 * @param {HTMLElement} content
 * @param {{onClose?:Function, dismissible?:boolean}} opts
 */
export function openModal(content, { onClose, dismissible = true } = {}) {
  closeModal();
  backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const box = document.createElement("div");
  box.className = "modal";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.appendChild(content);
  backdrop.appendChild(box);
  if (dismissible) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });
  }
  document.body.appendChild(backdrop);
  backdrop._onClose = onClose;
  const first = box.querySelector("input, select, button");
  if (first) setTimeout(() => first.focus(), 60);
  return box;
}

export function closeModal() {
  if (!backdrop) return;
  const cb = backdrop._onClose;
  backdrop.remove();
  backdrop = null;
  if (typeof cb === "function") cb();
}

/** Hộp thoại xác nhận, trả về Promise<boolean>. */
export function confirmDialog({ title = "Xác nhận", message = "", okText = "Đồng ý", cancelText = "Huỷ", danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = message;
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = cancelText;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = danger ? "danger" : "primary";
    ok.textContent = okText;
    actions.append(cancel, ok);
    wrap.append(h, p, actions);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    openModal(wrap, { dismissible: true, onClose: () => finish(false) });
  });
}

/* ---------------- Sao thưởng ---------------- */

let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** Tiếng "ting" ngắn khi có sao mới (WebAudio, không cần file âm thanh). */
export function playStarSound(up = true) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = up ? [880, 1320] : [660, 440];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.22, now + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.35);
    });
  } catch {
    /* trình duyệt chặn âm thanh thì bỏ qua */
  }
}

/** Vẽ 5 ngôi sao, trả về hàm cập nhật. */
export function mountStars(host, { editable = false, onChange } = {}) {
  host.innerHTML = "";
  const buttons = [];
  for (let i = 1; i <= 5; i += 1) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "★";
    b.setAttribute("aria-label", `${i} sao`);
    b.dataset.value = String(i);
    if (editable) b.addEventListener("click", () => onChange?.(i));
    buttons.push(b);
    host.appendChild(b);
  }
  return function setStars(n, { animate = true } = {}) {
    const value = Math.max(0, Math.min(5, Number(n) || 0));
    buttons.forEach((b, idx) => {
      const filled = idx < value;
      if (filled && !b.classList.contains("filled") && animate) {
        b.classList.remove("pop");
        void b.offsetWidth; // khởi động lại animation
        b.classList.add("pop");
      }
      b.classList.toggle("filled", filled);
    });
  };
}

/* ---------------- Định dạng ---------------- */

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatTimecode(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Sinh id ngẫu nhiên kiểu nanoid (dùng crypto.getRandomValues) cho nét vẽ.
 * Phía client không nạp được gói nanoid vì không có bước build (mục 2).
 */
const ALPHABET = "useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";
export function nanoid(size = 8) {
  const bytes = new Uint8Array(size);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < size; i += 1) out += ALPHABET[bytes[i] & 63];
  return out;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sao chép văn bản, có fallback cho trình duyệt cũ / không phải HTTPS. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* thử cách khác */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
