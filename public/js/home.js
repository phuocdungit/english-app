/**
 * public/js/home.js
 * Trang chủ: giáo viên đăng nhập + quản lý bài học + tạo phòng;
 * học viên nhập mã phòng và tên rồi vào phòng.
 */
import * as api from "./api.js";
import { $, toast, setNotice, escapeHtml, copyText } from "./ui.js";

const el = {
  authView: $("#authView"),
  dashView: $("#dashView"),
  teacherForm: $("#teacherForm"),
  teacherPassword: $("#teacherPassword"),
  teacherName: $("#teacherName"),
  teacherMsg: $("#teacherMsg"),
  studentForm: $("#studentForm"),
  roomCode: $("#roomCode"),
  studentName: $("#studentName"),
  studentMsg: $("#studentMsg"),
  hello: $("#helloTeacher"),
  btnLogout: $("#btnLogout"),
  lessonList: $("#lessonList"),
  lessonListEmpty: $("#lessonListEmpty"),
  lessonForm: $("#lessonForm"),
  lessonTitle: $("#lessonTitle"),
  lessonType: $("#lessonType"),
  slidesPane: $("#slidesPane"),
  videoPane: $("#videoPane"),
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  fileList: $("#fileList"),
  videoUrl: $("#videoUrl"),
  btnCreateLesson: $("#btnCreateLesson"),
  lessonMsg: $("#lessonMsg"),
  noRoom: $("#noRoom"),
  roomInfo: $("#roomInfo"),
  roomCodeBig: $("#roomCodeBig"),
  roomLinkText: $("#roomLinkText"),
  btnCopyLink: $("#btnCopyLink"),
  btnEnterRoom: $("#btnEnterRoom"),
  btnNewRoom: $("#btnNewRoom"),
  maxSlides: $("#maxSlides"),
  maxMB: $("#maxMB"),
  ttlHours: $("#ttlHours"),
};

const store = {
  lessons: [],
  selectedLessonId: null,
  files: [], // {file, url}
  room: null,
  config: null,
};

boot().catch((err) => {
  console.error(err);
  toast(err.message || "Có lỗi khi tải trang.", "err", 5000);
});

async function boot() {
  try {
    store.config = await api.getClientConfig();
    if (el.maxSlides) el.maxSlides.textContent = String(store.config.maxSlidesPerLesson);
    if (el.maxMB) el.maxMB.textContent = String(store.config.maxSlideMB);
    if (el.ttlHours) el.ttlHours.textContent = String(store.config.roomTtlHours);
  } catch {
    /* không có config thì dùng mặc định hiển thị */
  }

  // Nếu link có sẵn mã phòng (?code=) thì điền luôn cho học viên
  const codeFromUrl = new URLSearchParams(location.search).get("code");
  if (codeFromUrl) el.roomCode.value = codeFromUrl.toUpperCase();

  wireAuth();
  wireDashboard();

  if (api.getToken()) {
    try {
      await enterDashboard();
    } catch {
      api.clearToken();
    }
  }
}

/* ============================ Đăng nhập / vào phòng ============================ */

function wireAuth() {
  el.teacherForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setNotice(el.teacherMsg, "");
    const password = el.teacherPassword.value;
    if (!password) return setNotice(el.teacherMsg, "Hãy nhập mật khẩu giáo viên.");
    try {
      const data = await api.teacherLogin(password, el.teacherName.value.trim());
      toast(`Xin chào ${data.name} 👋`, "ok", 2400);
      el.teacherPassword.value = "";
      await enterDashboard();
    } catch (err) {
      setNotice(el.teacherMsg, err.message);
    }
    return undefined;
  });

  el.studentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setNotice(el.studentMsg, "");
    const code = el.roomCode.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const name = el.studentName.value.trim();
    if (!code) return setNotice(el.studentMsg, "Hãy nhập mã phòng.");
    if (!name) return setNotice(el.studentMsg, "Hãy nhập tên của bạn.");
    try {
      const data = await api.joinRoom(code, name);
      sessionStorage.setItem("ea_last_name", name);
      location.href = data.room?.link || `/room.html?code=${code}`;
    } catch (err) {
      setNotice(el.studentMsg, err.message);
    }
    return undefined;
  });

  const lastName = sessionStorage.getItem("ea_last_name") || localStorage.getItem("ea_last_name");
  if (lastName && !el.studentName.value) el.studentName.value = lastName;

  el.roomCode.addEventListener("input", () => {
    el.roomCode.value = el.roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  });

  el.btnLogout.addEventListener("click", () => {
    api.clearToken();
    store.room = null;
    el.dashView.classList.add("hidden");
    el.authView.classList.remove("hidden");
    toast("Đã đăng xuất.", "", 2000);
  });
}

async function enterDashboard() {
  const profile = api.getTeacherProfile();
  el.hello.textContent = `Xin chào, ${profile?.name || "cô"} 👋`;
  el.authView.classList.add("hidden");
  el.dashView.classList.remove("hidden");
  await loadLessons();
}

/* ============================ Bài học ============================ */

async function loadLessons() {
  try {
    store.lessons = await api.listLessons();
  } catch (err) {
    setNotice(el.lessonMsg, err.message);
    return;
  }
  renderLessonList();
}

function renderLessonList() {
  el.lessonList.innerHTML = "";
  el.lessonListEmpty.classList.toggle("hidden", store.lessons.length > 0);

  for (const lesson of store.lessons) {
    const li = document.createElement("li");
    li.className = "lesson-item";
    if (lesson.id === store.selectedLessonId) li.classList.add("selected");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.textContent = lesson.id === store.selectedLessonId ? "✔ Đang chọn" : "Chọn";
    pick.addEventListener("click", () => {
      store.selectedLessonId = lesson.id;
      renderLessonList();
    });

    const meta = document.createElement("div");
    meta.className = "meta";
    const b = document.createElement("b");
    b.textContent = lesson.title;
    const small = document.createElement("small");
    small.textContent =
      lesson.type === "video"
        ? `🎬 Video · ${new Date(lesson.createdAt).toLocaleDateString("vi-VN")}`
        : `🖼️ ${lesson.slides.length} slide · ${new Date(lesson.createdAt).toLocaleDateString("vi-VN")}`;
    meta.append(b, small);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "🗑";
    del.title = "Xoá bài học";
    del.addEventListener("click", async () => {
      if (!window.confirm(`Xoá bài học "${lesson.title}"? Ảnh của bài học cũng sẽ bị xoá.`)) return;
      try {
        await api.deleteLesson(lesson.id);
        if (store.selectedLessonId === lesson.id) store.selectedLessonId = null;
        toast("Đã xoá bài học.", "ok", 2000);
        await loadLessons();
      } catch (err) {
        toast(err.message, "err", 4000);
      }
    });

    li.append(pick, meta, del);
    el.lessonList.appendChild(li);
  }
}

function wireDashboard() {
  el.lessonType.addEventListener("change", () => {
    const isVideo = el.lessonType.value === "video";
    el.slidesPane.classList.toggle("hidden", isVideo);
    el.videoPane.classList.toggle("hidden", !isVideo);
  });

  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener("change", () => {
    addFiles([...el.fileInput.files]);
    el.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("dragover");
    })
  );
  el.dropzone.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    addFiles(files);
  });

  el.lessonForm.addEventListener("submit", onCreateLesson);
  el.btnNewRoom.addEventListener("click", onCreateRoom);
  el.btnCopyLink.addEventListener("click", async () => {
    if (!store.room) return;
    const ok = await copyText(store.room.link);
    toast(ok ? "Đã sao chép link phòng 📋" : "Không sao chép được, hãy bôi đen link và copy thủ công.", ok ? "ok" : "err", 2600);
  });
  el.btnEnterRoom.addEventListener("click", () => {
    if (store.room) location.href = store.room.link;
  });
}

function addFiles(incoming) {
  const max = store.config?.maxSlidesPerLesson || 40;
  const maxBytes = (store.config?.maxSlideMB || 5) * 1024 * 1024;
  for (const file of incoming) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast(`"${file.name}" không phải ảnh JPEG/PNG/WEBP.`, "err", 3200);
      continue;
    }
    if (file.size > maxBytes) {
      toast(`"${file.name}" nặng quá ${Math.round(maxBytes / 1024 / 1024)} MB.`, "err", 3200);
      continue;
    }
    if (store.files.length >= max) {
      toast(`Tối đa ${max} ảnh cho một bài học.`, "err", 3200);
      break;
    }
    store.files.push({ file, url: URL.createObjectURL(file) });
  }
  renderFileList();
}

function renderFileList() {
  el.fileList.innerHTML = "";
  store.files.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "file-row";
    row.draggable = true;
    row.dataset.index = String(index);

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.file.name;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${index + 1}. ${item.file.name}`;

    const up = miniBtn("▲", "Lên", () => moveFile(index, -1));
    const down = miniBtn("▼", "Xuống", () => moveFile(index, 1));
    const del = miniBtn("✕", "Bỏ", () => {
      URL.revokeObjectURL(item.url);
      store.files.splice(index, 1);
      renderFileList();
    });

    row.append(img, name, up, down, del);

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(index));
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (Number.isFinite(from) && from !== index) {
        const [moved] = store.files.splice(from, 1);
        store.files.splice(index, 0, moved);
        renderFileList();
      }
    });

    el.fileList.appendChild(row);
  });
}

function miniBtn(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function moveFile(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= store.files.length) return;
  const [item] = store.files.splice(index, 1);
  store.files.splice(target, 0, item);
  renderFileList();
}

async function onCreateLesson(e) {
  e.preventDefault();
  setNotice(el.lessonMsg, "");
  const title = el.lessonTitle.value.trim();
  const type = el.lessonType.value;
  if (!title) return setNotice(el.lessonMsg, "Hãy nhập tên bài học.");
  if (type === "slides" && !store.files.length) return setNotice(el.lessonMsg, "Hãy chọn ít nhất một ảnh slide.");
  if (type === "video" && !el.videoUrl.value.trim()) return setNotice(el.lessonMsg, "Hãy nhập URL video.");

  const form = new FormData();
  form.append("title", title);
  form.append("type", type);
  if (type === "slides") {
    for (const item of store.files) form.append("files", item.file, item.file.name);
  } else {
    form.append("videoUrl", el.videoUrl.value.trim());
  }

  el.btnCreateLesson.disabled = true;
  el.btnCreateLesson.textContent = "Đang tải lên…";
  try {
    const data = await api.createLesson(form);
    toast(`Đã tạo bài học "${data.lesson.title}" 🎉`, "ok", 3000);
    if (data.warning) toast(data.warning, "err", 6000);
    for (const item of store.files) URL.revokeObjectURL(item.url);
    store.files = [];
    renderFileList();
    el.lessonTitle.value = "";
    el.videoUrl.value = "";
    store.selectedLessonId = data.lesson.id;
    await loadLessons();
  } catch (err) {
    setNotice(el.lessonMsg, err.message);
  } finally {
    el.btnCreateLesson.disabled = false;
    el.btnCreateLesson.textContent = "Tải bài học lên";
  }
  return undefined;
}

/* ============================ Tạo phòng ============================ */

async function onCreateRoom() {
  setNotice(el.lessonMsg, "");
  if (!store.selectedLessonId) {
    toast("Hãy chọn một bài học trước khi tạo phòng.", "err", 3000);
    return;
  }
  try {
    const data = await api.createRoom(store.selectedLessonId);
    store.room = data.room || { code: data.code, link: data.link };
    el.noRoom.classList.add("hidden");
    el.roomInfo.classList.remove("hidden");
    el.roomCodeBig.textContent = store.room.code;
    el.roomLinkText.textContent = store.room.link;
    toast(`Đã tạo phòng ${store.room.code} 🎉`, "ok", 3000);
  } catch (err) {
    toast(err.message, "err", 4000);
  }
}

export { escapeHtml };
