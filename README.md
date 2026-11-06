# 🎈 english-app — Ứng dụng học trực tuyến 1-1 (Node.js + Agora + Socket.IO)

Web app cho lớp học online **1 giáo viên – 1 học viên** (chủ yếu trẻ em):
gọi video hai chiều, khung bài học lớn bên trái với **bảng vẽ chú thích đồng bộ thời gian thực**,
hai khung camera bên phải, **chia sẻ màn hình** (học viên vẽ được lên hình share), và **sao thưởng**.

Toàn bộ giao diện **tiếng Việt**, không có bước build frontend (HTML/CSS/JS thuần, ES Modules).

---

## 1. Tính năng chính

| Nhóm | Chi tiết |
|---|---|
| Video/audio | Gọi hai chiều qua Agora Web SDK NG 4.x, camera 480p (tiết kiệm phút miễn phí), chỉ báo chất lượng mạng, chỉ báo "ai đang nói" |
| Bài học | Slide ảnh (upload nhiều ảnh, kéo thả đổi thứ tự) hoặc video (URL mp4). Giáo viên điều khiển, học viên đồng bộ tự động (lệch > 1,5 s tự tua) |
| Bảng vẽ | Bút, dạ quang, tẩy (xoá nét bị chạm), undo (chỉ nét của mình), xoá hết (chỉ giáo viên), laser, 8 màu, 3 độ dày. Nét chuẩn hoá 0..1 theo vùng nội dung nên **khớp vị trí tuyệt đối** giữa laptop/iPad/điện thoại |
| Lưu nét theo trang | Lật trang vẫn giữ nét; học viên vào muộn hoặc F5 vẫn thấy đủ nét của trang hiện tại |
| Share màn hình | Giáo viên dùng client Agora thứ hai (uid = uid camera + 100000); học viên xem ở khung lớn và vẽ chú thích lên |
| Quyền | Giáo viên bật/tắt bút của học viên — **server thực thi**, học viên không lách được bằng cách gửi sự kiện thủ công |
| Sao thưởng | 5 sao, hiệu ứng phóng to + âm thanh "ting" khi có sao mới |
| Phòng | Mã 6 ký tự dễ đọc (không có `0/O/1/I`), hết hạn theo `ROOM_TTL_HOURS`, giữ 10 phút khi cô rớt mạng, tối đa 4 học viên |
| Bảo mật | JWT + role kiểm tra ở server, `helmet` + CSP, rate limit, so sánh mật khẩu bằng `timingSafeEqual`, upload kiểm tra magic bytes, escape tên hiển thị, không bao giờ lộ `AGORA_APP_CERT`/`JWT_SECRET` |

---

## 2. Yêu cầu

- **Node.js 22** (đã thử với 22.22.x). Không cần native module, không cần build step.
- Tài khoản [Agora](https://console.agora.io) → tạo project → lấy **App ID** và **App Certificate** (bật *Primary Certificate*).
- Một domain có **HTTPS** khi chạy thật (trình duyệt chỉ cho bật camera/mic trên HTTPS hoặc localhost).

---

## 3. Cài đặt & chạy (5 phút)

```bash
# 1) Cài phụ thuộc
npm install

# 2) Cấu hình
cp .env.example .env
#    Sửa .env: AGORA_APP_ID, AGORA_APP_CERT, JWT_SECRET, TEACHER_PASSWORD, PUBLIC_URL

# 3) Chạy
npm start            # hoặc: node server.js
#    Mở http://localhost:3000
```

Tạo nhanh một `JWT_SECRET` mạnh:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**Chưa có App ID Agora?** Đặt `AGORA_DISABLED=true` trong `.env` để chạy thử giao diện,
bài học, bảng vẽ và sao thưởng (video sẽ tạm tắt, có banner giải thích). Khi có App ID thật thì bỏ dòng này.

### Chạy test tự động

```bash
npm test        # 11 test: auth, upload, phòng, uid Agora, đồng bộ nét/trang/quyền/sao, 2 tab, kết thúc phòng...
```

Test chạy **cách ly** trong `/tmp` (biến `DATA_DIR`, `UPLOADS_DIR`) nên không đụng dữ liệu thật.

---

## 4. Biến môi trường (`.env`)

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `AGORA_APP_ID` | ✅ | – | App ID trong Agora Console |
| `AGORA_APP_CERT` | ✅ | – | App Certificate (chỉ nằm ở server) |
| `JWT_SECRET` | ✅ (≥ 32 ký tự) | – | Khoá ký token phiên |
| `TEACHER_PASSWORD` | ✅ | – | Mật khẩu đăng nhập của giáo viên |
| `PUBLIC_URL` | – | `http://localhost:PORT` | URL HTTPS công khai, dùng để sinh link phòng |
| `SERVER_PORT` / `PORT` | – | `3000` | Cổng lắng nghe (luôn bind `0.0.0.0`) |
| `ROOM_TTL_HOURS` | – | `12` | Tuổi thọ phòng |
| `SESSION_TTL_HOURS` | – | = TTL phòng | Tuổi thọ JWT phiên |
| `TEACHER_GRACE_MINUTES` | – | `10` | Thời gian giữ phòng khi cô rớt mạng |
| `MAX_STUDENTS_PER_ROOM` | – | `4` | Số học viên tối đa |
| `AGORA_TOKEN_TTL_SECONDS` | – | `7200` | Thời hạn token Agora (client tự gia hạn) |
| `AGORA_DISABLED` | – | `false` | `true` = bỏ qua video để thử giao diện |
| `CSP_ENABLED` | – | `true` | `false` để tắt CSP khi gỡ lỗi SDK |
| `EXTRA_ALLOWED_ORIGINS` | – | – | Thêm origin được phép (phân cách bằng dấu phẩy) |
| `DATA_DIR`, `UPLOADS_DIR` | – | `./data`, `./uploads` | Nơi lưu `db.json` và ảnh slide |
| `NODE_ENV` | – | `development` | `production` bật các khoá an toàn chặt hơn |

Server **từ chối khởi động** và in hướng dẫn nếu thiếu 4 biến bắt buộc.

---

## 5. Triển khai lên panel hosting (máy nhỏ 512 MB RAM)

App rất nhẹ vì video/audio do Agora lo; server chỉ cấp token, relay Socket.IO và phục vụ file tĩnh
(đo thực tế ~75–80 MB RSS, dưới ngưỡng 150 MB).

### 5.1 Chạy trên server

1. Upload mã nguồn, chạy `npm install --omit=dev`.
2. Đặt biến môi trường ở mục Startup/Environment của panel (đừng ghi vào code).
3. Start command: `node server.js` (hoặc `npm start`).
4. Mở `https://<domain>/health` để kiểm tra.

### 5.2 HTTPS bằng Cloudflare Tunnel (khuyên dùng)

```bash
# Trên server, sau khi đã có domain trỏ vào Cloudflare:
cloudflared tunnel login
cloudflared tunnel create hoc11
cloudflared tunnel route dns hoc11 hoc.example.com

cloudflared tunnel run \
  --url http://127.0.0.1:3000 \
  --hostname hoc.example.com \
  --tunnel-id <id> 
```

- Tunnel tự cấp HTTPS và **hỗ trợ WebSocket** (cần cho Socket.IO).
- Trong `.env` đặt `PUBLIC_URL=https://hoc.example.com` và `NODE_ENV=production`.
- Server đã `app.set("trust proxy", 1)` nên đọc đúng `X-Forwarded-Proto/Host`.

Nếu panel không chạy được `cloudflared`: đặt frontend tĩnh lên Cloudflare Pages/Vercel **và** vẫn phải
cho backend một domain HTTPS (tunnel hoặc proxy khác), vì trang HTTPS không được gọi `http://`/`ws://`.

### 5.3 Sau khi deploy

1. Đăng nhập giáo viên bằng `TEACHER_PASSWORD`.
2. Tạo bài học (kéo thả ảnh) → Tạo phòng → gửi link cho học viên.
3. Mở link ở **hai thiết bị khác nhau** để kiểm tra.
4. Vào Agora Console đặt cảnh báo mức dùng phút (gói miễn phí 10.000 phút/tháng).

---

## 6. Cấu trúc thư mục

```
├─ server.js               # Express + Socket.IO trong MỘT tiến trình
├─ src/
│  ├─ config.js            # biến môi trường + kiểm tra bắt buộc
│  ├─ auth.js              # JWT phiên, middleware requireAuth/requireTeacher
│  ├─ db.js                # data/db.json ghi nguyên tử
│  ├─ util.js              # timingSafeEqual, mã phòng, magic bytes...
│  ├─ routes/              # auth / rooms / lessons / agora
│  └─ socket/              # xác thực socket, roomState (bộ nhớ), handlers (vẽ/trang/quyền/sao)
├─ public/
│  ├─ index.html           # trang chủ: đăng nhập GV + vào phòng HV + quản lý bài học
│  ├─ room.html            # phòng học
│  ├─ 404.html
│  ├─ css/style.css
│  └─ js/                  # api, ui, sdk-loader, agora, stage, whiteboard, toolbar, preflight, home, room
├─ data/db.json            # tự tạo khi chạy (đã .gitignore)
├─ uploads/                # ảnh slide (đã .gitignore)
└─ test/smoke.test.js      # npm test
```

---

## 7. Những điểm đã điều chỉnh so với đặc tả gốc (và lý do)

1. **`agora-token` 2.x không export named `RtcTokenBuilder`** như đoạn mẫu C1 — phải lấy từ
   default export: `import AgoraToken from "agora-token"; const { RtcTokenBuilder, RtcRole } = AgoraToken;`.
   Chữ ký: `buildTokenWithUid(appId, cert, channel, uid, role, tokenExpireSec, privilegeExpireSec)`.
2. **Bổ sung sự kiện `stroke:erase`** `{ids}` (cùng quyền vẽ) vì mục 10.2 yêu cầu tẩy “xoá nét bị chạm”
   nhưng bảng sự kiện mục 8.1 chưa có sự kiện tương ứng.
3. **Bổ sung sự kiện `media:state`** `{mic, cam}` để hiển thị icon mic/camera của người ở xa:
   `setEnabled(false)` của Agora không sinh `user-unpublished` nên phải báo qua Socket.IO (gộp vào `presence`).
4. **SDK Agora**: nạp theo thứ tự CDN chính thức (`download.agora.io`) → jsDelivr → bản dự phòng
   `/vendor/AgoraRTC_N-<ver>.prod.js` do chính server phục vụ từ `node_modules`, để chạy được cả khi mạng chặn CDN.
   Phiên bản cố định **4.24.9**.
5. **`enableAudioVolumeIndicator()` ở 4.24.9 không nhận tham số** (sự kiện bắn mỗi 2 s, `level` 0..100,
   ngưỡng “đang nói” dùng > 55) — khác giả định ban đầu.
6. **Link phòng ở chế độ development** được sinh theo origin của request (để dùng được qua tunnel/preview/IP LAN);
   ở `NODE_ENV=production` luôn dùng `PUBLIC_URL` (chống host-header injection).
7. **Client không nạp gói `nanoid`** (không có bước build) — dùng `crypto.getRandomValues` với đúng bảng chữ cái của nanoid.
8. **Sao**: giáo viên cộng/trừ bằng nút **− / +** (đúng sự kiện `star:give {delta}`), 5 sao hiển thị cho cả hai bên.
9. **Tẩy** xoá nét bị chạm (theo 10.2); renderer vẫn hiểu nét có `tool:"eraser"` (vẽ kiểu `destination-out`) nếu nhận được.

---

## 8. Giới hạn đã biết

- **iOS/Android không share màn hình** trên trình duyệt (giới hạn của WebRTC/Agora) → nút tự ẩn trên di động; giáo viên cần dùng máy tính. Học viên xem + vẽ được trên mọi thiết bị.
- Video bài học nằm ở domain khác phải cho phép **CORS** mới phát được.
- Không ghi hình buổi học (chủ đích, để an toàn cho trẻ em và vì đĩa 1 GB).
- Tối đa 1 giáo viên + 4 học viên mỗi phòng (thiết kế mở rộng thêm sau).
- Nét vẽ giữ trong bộ nhớ theo phòng; khi **server khởi động lại**, nét của phòng đang mở bị mất (trang, quyền, sao, bài học vẫn còn vì nằm trong `db.json`).
- Hai tab cùng một người trong một phòng: tab cũ bị ngắt kèm thông báo (chủ đích).
- Lượt dùng Agora miễn phí tính theo từng người tham gia; quên đóng tab vẫn bị tính phút — app đã `leave()`/`close()` khi đóng tab.

---

## 9. Gỡ lỗi nhanh

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Camera/mic không lên, trình duyệt báo lỗi | Trang phải chạy **HTTPS** (hoặc localhost). Kiểm tra quyền ở biểu tượng ổ khoá |
| Banner “Chưa cấu hình Agora” | Chưa điền `AGORA_APP_ID`/`AGORA_APP_CERT` thật, hoặc đang bật `AGORA_DISABLED=true` |
| Hai bên không thấy nhau nhưng bảng vẽ chạy | Kiểm tra mạng UDP/WebRTC; thử thiết bị khác. Xem console để xem mã lỗi Agora |
| Nét vẽ lệch giữa 2 máy | Không xảy ra nếu dùng đúng bản này (toạ độ chuẩn hoá theo vùng nội dung). Nếu bạn tự sửa `stage.js`, giữ nguyên logic tỉ lệ khung |
| Socket.IO báo `UNAUTHORIZED` | Hết hạn JWT → tải lại trang / vào lại từ link |
| `npm test` báo thiếu env | Test tự đặt env giả; nếu bạn đặt `DATA_DIR`/`UPLOADS_DIR` trong `.env` hãy xoá để test dùng thư mục tạm |

---

## 10. Giấy phép & ghi chú

Mã nguồn phục vụ mục đích học tập/giảng dạy. Ảnh slide minh hoạ trong `demo-slides/` là ảnh sinh tự động,
chỉ dùng để thử nghiệm trong môi trường phát triển (đã `.gitignore`).
