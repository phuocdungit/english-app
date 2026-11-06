/**
 * public/js/preflight.js
 * Màn hình kiểm tra thiết bị trước khi vào phòng (mục 11):
 * xem trước camera, thử micro (có vạch mức âm), chọn thiết bị.
 * Nếu trình duyệt chặn quyền -> vẫn cho vào phòng ở chế độ chỉ xem/nghe (mục 9.3.2).
 */
import { openModal, closeModal, toast } from "./ui.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function openPreflight({ role }) {
  return new Promise((resolve) => {
    let stream = null;
    let audioCtx = null;
    let analyser = null;
    let rafId = 0;
    let settled = false;
    let currentMic = "";
    let currentCam = "";

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h2>${role === "teacher" ? "👩‍🏫 Kiểm tra thiết bị" : "🧒 Kiểm tra thiết bị"}</h2>
      <p class="sub">Cho phép trình duyệt dùng camera và micro, kiểm tra hình và tiếng rồi bấm "Vào phòng".</p>
      <div class="preflight-video"><video id="pfVideo" autoplay muted playsinline></video></div>
      <div id="pfMsg"></div>
      <label class="field"><span>Camera</span><select id="pfCam"></select></label>
      <label class="field"><span>Micro</span><select id="pfMic"></select></label>
      <div><span style="font-size:14px;font-weight:800;color:var(--ink-soft)">Mức âm micro</span>
        <div class="mic-meter"><span id="pfMeter"></span></div></div>
      <div class="modal-actions">
        <button type="button" class="ghost" id="pfBack" style="background:#eef3fb;color:#16233a">← Quay lại</button>
        <button type="button" id="pfSkip">Vào không cần camera</button>
        <button type="button" class="primary" id="pfGo">Vào phòng</button>
      </div>
    `;

    const video = wrap.querySelector("#pfVideo");
    const camSel = wrap.querySelector("#pfCam");
    const micSel = wrap.querySelector("#pfMic");
    const meter = wrap.querySelector("#pfMeter");
    const msg = wrap.querySelector("#pfMsg");
    const btnGo = wrap.querySelector("#pfGo");
    const btnSkip = wrap.querySelector("#pfSkip");

    function setMsg(text, kind = "error") {
      msg.innerHTML = text ? `<div class="notice ${kind}">${text}</div>` : "";
    }

    function stopStream() {
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
        stream = null;
      }
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    async function listDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const mics = devices.filter((d) => d.kind === "audioinput");
      fillSelect(camSel, cams, currentCam, "Camera");
      fillSelect(micSel, mics, currentMic, "Micro");
    }

    function fillSelect(sel, devices, current, fallbackLabel) {
      sel.innerHTML = "";
      if (!devices.length) {
        const opt = document.createElement("option");
        opt.textContent = `Không tìm thấy ${fallbackLabel}`;
        opt.value = "";
        sel.appendChild(opt);
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      devices.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
        if (d.deviceId === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (!current) sel.selectedIndex = 0;
    }

    function startMeter() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx || !stream) return;
        audioCtx = audioCtx || new Ctx();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
          meter.style.width = `${Math.min(100, Math.round(peak * 180))}%`;
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        /* không có WebAudio thì bỏ qua vạch mức âm */
      }
    }

    async function start({ videoOn = true, audioOn = true } = {}) {
      stopStream();
      if (!navigator.mediaDevices?.getUserMedia) {
        setMsg("Trình duyệt không hỗ trợ camera/mic. Bạn vẫn vào phòng được để xem và gõ/vẽ.");
        return false;
      }
      try {
        const constraints = {
          audio: audioOn ? (currentMic ? { deviceId: { exact: currentMic } } : true) : false,
          video: videoOn
            ? Object.assign({ width: { ideal: 640 }, height: { ideal: 480 } }, currentCam ? { deviceId: { exact: currentCam } } : {})
            : false,
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play().catch(() => {});
        setMsg("", "");
        currentCam = stream.getVideoTracks()[0]?.getSettings?.().deviceId || currentCam;
        currentMic = stream.getAudioTracks()[0]?.getSettings?.().deviceId || currentMic;
        await listDevices();
        startMeter();
        return true;
      } catch (err) {
        const name = String(err?.name || "");
        if (name.includes("NotAllowed")) {
          setMsg(
            "Trình duyệt đang <b>chặn</b> camera/mic. Hãy bấm biểu tượng 🔒 ở thanh địa chỉ, cho phép Camera và Micro, rồi tải lại trang. " +
              "Bạn vẫn có thể vào phòng để xem và nghe.",
            "warn"
          );
        } else if (name.includes("NotFound")) {
          setMsg("Không tìm thấy camera hoặc micro. Bạn vẫn vào phòng được để xem và nghe.", "warn");
        } else if (name.includes("NotReadable")) {
          setMsg("Camera/mic đang bị ứng dụng khác chiếm. Hãy tắt ứng dụng đó hoặc chọn thiết bị khác.", "warn");
        } else {
          setMsg(`Không mở được thiết bị: ${err?.message || name}`, "warn");
        }
        return false;
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      stopStream();
      analyser = null;
      try {
        audioCtx?.close();
      } catch {
        /* bỏ qua */
      }
      closeModal();
      resolve(result);
    }

    btnGo.addEventListener("click", () => {
      finish({
        micOn: Boolean(stream?.getAudioTracks().length),
        camOn: Boolean(stream?.getVideoTracks().length),
        micId: micSel.value || undefined,
        camId: camSel.value || undefined,
      });
    });
    btnSkip.addEventListener("click", () => finish({ micOn: false, camOn: false }));
    wrap.querySelector("#pfBack").addEventListener("click", () => finish({ cancelled: true }));

    camSel.addEventListener("change", () => {
      currentCam = camSel.value;
      start({ videoOn: true, audioOn: true });
    });
    micSel.addEventListener("change", () => {
      currentMic = micSel.value;
      start({ videoOn: true, audioOn: true });
    });

    openModal(wrap, { dismissible: false });

    (async () => {
      const ok = await start({ videoOn: true, audioOn: true });
      if (!ok) {
        btnGo.textContent = "Vào phòng (chỉ xem/nghe)";
        await sleep(50);
      }
      if (navigator.mediaDevices?.addEventListener) {
        navigator.mediaDevices.addEventListener("devicechange", () => listDevices());
      }
    })();
  });
}

/** Hộp thoại "chạm để bật âm thanh" (chính sách autoplay của Safari/iOS). */
export function askForAutoplay() {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h2>🔊 Bật âm thanh</h2>
      <p class="sub">Trình duyệt cần bạn bấm một lần để cho phép phát tiếng và video trong buổi học.</p>
      <div class="modal-actions"><button type="button" class="primary" id="apGo">Bắt đầu học</button></div>
    `;
    wrap.querySelector("#apGo").addEventListener("click", () => {
      closeModal();
      resolve();
    });
    openModal(wrap, { dismissible: false });
  });
}

export { toast };
