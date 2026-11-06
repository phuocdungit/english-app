/**
 * public/js/stage.js
 * Khung bài học (slide ảnh / video / màn hình chia sẻ) + tính vùng hiển thị thật.
 *
 * Ý tưởng quan trọng (mục 10.1): khung (frame) LUÔN được đặt đúng tỉ lệ của nội dung,
 * nên nội dung object-fit:contain không tạo viền đen và canvas phủ kín frame.
 * Nhờ đó toạ độ chuẩn hoá 0..1 của nét vẽ = vị trí tương đối trong frame,
 * khớp tuyệt đối giữa các màn hình có kích thước khác nhau.
 */

const DEFAULT_ASPECT = 16 / 9;

export class Stage {
  constructor({ wrap, frame, content, slideImg, lessonVideo, screenView, overlay, onViewportChange }) {
    this.wrap = wrap;
    this.frame = frame;
    this.content = content;
    this.slideImg = slideImg;
    this.lessonVideo = lessonVideo;
    this.screenView = screenView;
    this.overlay = overlay;
    this.onViewportChange = typeof onViewportChange === "function" ? onViewportChange : () => {};

    this.mode = "lesson"; // "lesson" | "screen"
    this.lesson = null;
    this.pageIndex = 0;
    this.aspect = DEFAULT_ASPECT;
    this.screenSize = { width: 1920, height: 1080 };
    this.viewport = { width: 0, height: 0 };

    this.slideImg.addEventListener("load", () => {
      const { naturalWidth: w, naturalHeight: h } = this.slideImg;
      if (w > 0 && h > 0) this.setAspectFrom(w, h, "lesson");
    });
    this.slideImg.addEventListener("error", () => {
      this.setOverlay("error-slide", "😕", "Không tải được ảnh slide", "Hãy kiểm tra lại kết nối mạng rồi thử đổi trang.");
    });

    this.lessonVideo.addEventListener("loadedmetadata", () => {
      const w = this.lessonVideo.videoWidth;
      const h = this.lessonVideo.videoHeight;
      if (w > 0 && h > 0) this.setAspectFrom(w, h, "lesson-video");
    });

    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(this.wrap);
    window.addEventListener("orientationchange", () => setTimeout(() => this.layout(), 220));
    this.layout();
  }

  /** Cập nhật tỉ lệ khung hình từ kích thước thật của nội dung. */
  setAspectFrom(w, h, source) {
    if (!(w > 0) || !(h > 0)) return;
    const next = w / h;
    if (Math.abs(next - this.aspect) < 0.001) return;
    // Chỉ đổi tỉ lệ khi nguồn khớp với chế độ đang hiển thị
    if (source === "screen" && this.mode !== "screen") return;
    if ((source === "lesson" || source === "lesson-video") && this.mode !== "lesson") return;
    this.aspect = next;
    this.layout();
  }

  setLesson(lesson) {
    this.lesson = lesson;
    if (lesson?.type === "video") {
      this.lessonVideo.src = lesson.videoUrl || "";
      this.lessonVideo.load?.();
    } else {
      this.lessonVideo.removeAttribute("src");
      this.lessonVideo.load?.();
    }
    this.setPage(this.pageIndex);
  }

  get isVideoLesson() {
    return this.lesson?.type === "video";
  }

  get slideCount() {
    if (!this.lesson) return 0;
    return this.isVideoLesson ? 1 : this.lesson.slides.length;
  }

  get currentSlideUrl() {
    if (!this.lesson || this.isVideoLesson) return null;
    return this.lesson.slides[this.pageIndex] || null;
  }

  setPage(index) {
    const total = this.slideCount || 1;
    this.pageIndex = Math.max(0, Math.min(total - 1, Number(index) || 0));
    if (!this.isVideoLesson) {
      const url = this.currentSlideUrl;
      if (url && this.slideImg.getAttribute("src") !== url) this.slideImg.src = url;
    }
    this.renderMode();
    return this.pageIndex;
  }

  setMode(mode) {
    this.mode = mode === "screen" ? "screen" : "lesson";
    if (this.mode === "screen") {
      this.setAspectFrom(this.screenSize.width, this.screenSize.height, "screen");
    } else if (this.isVideoLesson) {
      const w = this.lessonVideo.videoWidth;
      const h = this.lessonVideo.videoHeight;
      if (w && h) this.setAspectFrom(w, h, "lesson-video");
      else this.aspect = DEFAULT_ASPECT;
    } else {
      const w = this.slideImg.naturalWidth;
      const h = this.slideImg.naturalHeight;
      if (w && h) this.setAspectFrom(w, h, "lesson");
      else this.aspect = DEFAULT_ASPECT;
    }
    this.renderMode();
    this.layout();
  }

  setScreenSize(width, height) {
    this.screenSize = { width: Number(width) || 1920, height: Number(height) || 1080 };
    if (this.mode === "screen") {
      this.setAspectFrom(this.screenSize.width, this.screenSize.height, "screen");
    }
  }

  /** Hiện/ẩn đúng lớp nội dung theo chế độ. */
  renderMode() {
    const lessonMode = this.mode !== "screen";
    const video = lessonMode && this.isVideoLesson;
    this.slideImg.classList.toggle("hidden", !(lessonMode && !this.isVideoLesson));
    this.lessonVideo.classList.toggle("hidden", !video);
    this.screenView.classList.toggle("hidden", this.mode !== "screen");
    if (!video && !this.lessonVideo.paused) this.lessonVideo.pause();
  }

  /**
   * Tính kích thước frame (px) vừa khít vùng khả dụng, giữ đúng tỉ lệ nội dung.
   * Sau khi tính xong sẽ báo cho whiteboard để canvas khớp lại.
   */
  layout() {
    const style = getComputedStyle(this.wrap);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) || 0;
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
    const availW = Math.max(160, this.wrap.clientWidth - padX);
    const availH = Math.max(120, this.wrap.clientHeight - padY);
    const aspect = this.aspect > 0 ? this.aspect : DEFAULT_ASPECT;

    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    w = Math.round(w);
    h = Math.round(h);
    if (w !== this.viewport.width || h !== this.viewport.height) {
      this.frame.style.width = `${w}px`;
      this.frame.style.height = `${h}px`;
      this.viewport = { width: w, height: h };
      this.onViewportChange(this.viewport);
    } else {
      this.frame.style.width = `${w}px`;
      this.frame.style.height = `${h}px`;
    }
    return this.viewport;
  }

  /** Vùng hiển thị thật của nội dung — vì frame luôn đúng tỉ lệ nên bằng đúng frame. */
  getContentRect() {
    return { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height };
  }

  /* ---------------- Lớp phủ thông báo ---------------- */

  setOverlay(kind, emoji, title, text, actions = []) {
    if (!this.overlay) return;
    this.overlay.dataset.kind = kind;
    this.overlay.innerHTML = "";
    if (emoji) {
      const e = document.createElement("div");
      e.className = "big";
      e.textContent = emoji;
      this.overlay.appendChild(e);
    }
    if (title) {
      const h = document.createElement("h3");
      h.textContent = title;
      this.overlay.appendChild(h);
    }
    if (text) {
      const p = document.createElement("p");
      p.textContent = text;
      this.overlay.appendChild(p);
    }
    for (const action of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = action.className || "primary";
      b.textContent = action.label;
      b.addEventListener("click", action.onClick);
      this.overlay.appendChild(b);
    }
    this.overlay.classList.remove("hidden");
  }

  hideOverlay(kind) {
    if (!this.overlay) return;
    if (kind && this.overlay.dataset.kind !== kind) return;
    this.overlay.classList.add("hidden");
    this.overlay.innerHTML = "";
    delete this.overlay.dataset.kind;
  }

  /** Cho phép phát video/âm thanh sau một thao tác chạm (Safari/iOS). */
  async unlockMedia() {
    try {
      await this.lessonVideo.play();
      this.lessonVideo.pause();
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this._ro?.disconnect();
  }
}
