/**
 * public/js/sdk-loader.js
 * Nạp Agora Web SDK NG với PHIÊN BẢN CỐ ĐỊNH.
 * Thử lần lượt: CDN chính thức của Agora -> jsDelivr -> bản dự phòng cục bộ /vendor
 * (bản cục bộ do chính server phục vụ, lấy từ node_modules/agora-rtc-sdk-ng).
 */

let pending = null;

function inject(src, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (window.AgoraRTC) return resolve(window.AgoraRTC);
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      s.remove();
      reject(new Error(`timeout: ${src}`));
    }, timeoutMs);

    s.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (window.AgoraRTC) resolve(window.AgoraRTC);
      else reject(new Error(`SDK không khởi tạo biến toàn cục AgoraRTC: ${src}`));
    };
    s.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.remove();
      reject(new Error(`không tải được: ${src}`));
    };
    document.head.appendChild(s);
    return undefined;
  });
}

/**
 * @param {string[]} urls danh sách nguồn nạp, thử theo thứ tự
 * @returns {Promise<object>} đối tượng AgoraRTC toàn cục
 */
export function loadAgoraSdk(urls) {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (pending) return pending;

  pending = (async () => {
    const list = Array.isArray(urls) && urls.length ? urls : ["/vendor/AgoraRTC_N.prod.js"];
    const errors = [];
    for (const url of list) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const sdk = await inject(url);
        return sdk;
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new Error(`Không nạp được Agora Web SDK. Đã thử: ${errors.join(" | ")}`);
  })();

  return pending;
}
