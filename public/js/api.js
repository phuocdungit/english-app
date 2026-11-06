/**
 * public/js/api.js
 * Gọi API REST + quản lý token phiên (giáo viên: localStorage, học viên: sessionStorage).
 */

const TEACHER_KEY = "ea_teacher";
const studentKey = (code) => `ea_student_${String(code || "").toUpperCase()}`;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status || 0;
  }
}

let cachedConfig = null;

async function request(path, { method = "GET", body, auth = true, form = false } = {}) {
  const headers = {};
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !form) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: form ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại.", 0);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const message = (data && data.error) || `Lỗi máy chủ (${res.status}).`;
    if (res.status === 401 && auth) clearToken();
    throw new ApiError(message, res.status);
  }
  return data || {};
}

/* ---------------- Token ---------------- */

export function getToken() {
  try {
    const t = localStorage.getItem(TEACHER_KEY);
    if (t) return JSON.parse(t).token || null;
  } catch {
    /* bỏ qua */
  }
  return null;
}

export function getTeacherProfile() {
  try {
    const raw = localStorage.getItem(TEACHER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setTeacherSession({ token, name, userId }) {
  localStorage.setItem(TEACHER_KEY, JSON.stringify({ token, name, userId }));
}

export function getStudentSession(code) {
  try {
    const raw = sessionStorage.getItem(studentKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStudentSession(code, session) {
  sessionStorage.setItem(studentKey(code), JSON.stringify(session));
}

export function clearToken() {
  localStorage.removeItem(TEACHER_KEY);
}

export function clearStudentSession(code) {
  sessionStorage.removeItem(studentKey(code));
}

/** Token dùng cho một phòng cụ thể: giáo viên hoặc học viên. */
export function tokenForRoom(code) {
  const student = getStudentSession(code);
  if (student?.token) return student.token;
  return getToken();
}

/* ---------------- Cấu hình công khai ---------------- */

export async function getClientConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = await request("/api/config", { auth: false });
  return cachedConfig;
}

/* ---------------- Auth ---------------- */

export async function teacherLogin(password, name) {
  const data = await request("/api/auth/teacher", { method: "POST", body: { password, name }, auth: false });
  setTeacherSession({ token: data.token, name: data.name, userId: data.userId });
  return data;
}

export async function joinRoom(code, name) {
  const data = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: "POST",
    body: { name },
    auth: false,
  });
  setStudentSession(code, { token: data.token, name: data.name, userId: data.userId, role: "student" });
  return data;
}

/* ---------------- Phòng ---------------- */

export async function createRoom(lessonId) {
  return request("/api/rooms", { method: "POST", body: { lessonId } });
}

export async function getRoom(code) {
  return request(`/api/rooms/${encodeURIComponent(code)}`, {});
}

export async function endRoom(code) {
  return request(`/api/rooms/${encodeURIComponent(code)}/end`, { method: "POST", body: {} });
}

/* ---------------- Bài học ---------------- */

export async function listLessons() {
  const data = await request("/api/lessons");
  return data.lessons || [];
}

export async function createLesson(formData) {
  const data = await request("/api/lessons", { method: "POST", body: formData, form: true });
  return data;
}

export async function deleteLesson(id) {
  return request(`/api/lessons/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---------------- Agora ---------------- */

export async function agoraToken(code, kind = "cam") {
  return request("/api/agora/token", { method: "POST", body: { code, kind } });
}
