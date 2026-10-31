/* ChatSpace photo editor: auto-enhance, adjustments, rotate and a quality choice.
   Self-contained. Usage:  const file2 = await ChatSpaceEnhance.open(file);
   Resolves with a File (edited or original), or null if the person cancels. */
(() => {
  const MB = 1024 * 1024;
  const fmtSize = (n) =>
    n >= MB ? (n / MB).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Which files the editor can handle (animated GIFs and SVGs are sent untouched).
  function canEdit(file) {
    return /^image\/(jpeg|png|webp|bmp)$/i.test(file?.type || "");
  }

  async function decode(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (_) {}
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  // Brightest and darkest "real" levels, ignoring 1% outliers (used by Auto).
  function levelsOf(data) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4)
      hist[(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) | 0]++;
    const total = data.length / 4;
    let acc = 0,
      lo = 0,
      hi = 255;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= total * 0.01) {
        lo = i;
        break;
      }
    }
    acc = 0;
    for (let i = 255; i >= 0; i--) {
      acc += hist[i];
      if (acc >= total * 0.01) {
        hi = i;
        break;
      }
    }
    if (hi - lo < 40) return { lo: 0, hi: 255 };
    return { lo, hi };
  }

  // Applies the settings to an ImageData in place.
  function adjust(img, s, levels) {
    const d = img.data;
    const w = img.width,
      h = img.height;
    const auto = s.auto;
    const bright = s.brightness * 2.55;
    const c = s.contrast * 2.55;
    const cf = (259 * (c + 255)) / (255 * (259 - c));
    const sat = 1 + (s.saturation + (auto ? 12 : 0)) / 100;
    const lo = auto ? levels.lo : 0;
    const scale = auto ? 255 / Math.max(1, levels.hi - levels.lo) : 1;
    const needPixels = auto || s.brightness || s.contrast || s.saturation;
    if (needPixels) {
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        if (auto) {
          r = (r - lo) * scale;
          g = (g - lo) * scale;
          b = (b - lo) * scale;
        }
        r += bright;
        g += bright;
        b += bright;
        if (s.contrast) {
          r = cf * (r - 128) + 128;
          g = cf * (g - 128) + 128;
          b = cf * (b - 128) + 128;
        }
        if (sat !== 1) {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          r = gray + (r - gray) * sat;
          g = gray + (g - gray) * sat;
          b = gray + (b - gray) * sat;
        }
        d[i] = clamp(r, 0, 255);
        d[i + 1] = clamp(g, 0, 255);
        d[i + 2] = clamp(b, 0, 255);
      }
    }
    const amount = (s.sharpness + (auto ? 30 : 0)) / 100;
    if (amount > 0.01) {
      const src = new Uint8ClampedArray(d);
      const a = amount * 0.9;
      const row = w * 4;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * row + x * 4;
          for (let k = 0; k < 3; k++) {
            const v =
              src[p + k] * (1 + 4 * a) -
              a * (src[p - 4 + k] + src[p + 4 + k] + src[p - row + k] + src[p + row + k]);
            d[p + k] = v < 0 ? 0 : v > 255 ? 255 : v;
          }
        }
      }
    }
  }

  function drawRotated(source, sw, sh, rot, maxEdge) {
    const turned = rot % 180 !== 0;
    let w = turned ? sh : sw,
      h = turned ? sw : sh;
    const k = Math.min(1, maxEdge / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const dw = turned ? h : w,
      dh = turned ? w : h;
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    return canvas;
  }

  const QUALITY = {
    original: { label: "Original", edge: 6000, q: 0.95, note: "Full size, nothing shrunk" },
    hd: { label: "HD", edge: 2560, q: 0.9, note: "Sharp on any phone, a good size" },
    saver: { label: "Data saver", edge: 1280, q: 0.72, note: "Smallest, loads fast" },
  };

  function open(file) {
    return new Promise(async (resolve) => {
      if (!canEdit(file)) return resolve(file);
      let bitmap;
      try {
        bitmap = await decode(file);
      } catch (_) {
        return resolve(file); // e.g. a format this browser cannot read
      }
      const natW = bitmap.width || bitmap.naturalWidth,
        natH = bitmap.height || bitmap.naturalHeight;
      const state = { auto: false, brightness: 0, contrast: 0, saturation: 0, sharpness: 0, rotate: 0, quality: "hd" };
      let levels = { lo: 0, hi: 255 };
      let baseCanvas = null,
        baseData = null,
        busy = false,
        queued = false;

      const root = document.createElement("div");
      root.className = "enh-overlay";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Improve photo");
      root.innerHTML = `
        <div class="enh-top">
          <button type="button" class="ghost-btn" data-act="cancel">Cancel</button>
          <strong>Improve photo</strong>
          <button type="button" class="primary-btn" data-act="use">Use photo</button>
        </div>
        <div class="enh-stage"><canvas class="enh-canvas"></canvas></div>
        <div class="enh-panel">
          <p class="enh-info tiny muted"></p>
          <div class="enh-row">
            <button type="button" class="enh-chip" data-act="auto" aria-pressed="false">✨ Auto-enhance</button>
            <button type="button" class="enh-chip" data-act="rotate">⟳ Rotate</button>
            <button type="button" class="enh-chip" data-act="reset">Reset</button>
          </div>
          <div class="enh-seg" role="group" aria-label="Quality"></div>
          <p class="enh-qnote tiny muted"></p>
          <label class="enh-slider">Brightness<input type="range" min="-50" max="50" value="0" data-key="brightness"></label>
          <label class="enh-slider">Contrast<input type="range" min="-50" max="50" value="0" data-key="contrast"></label>
          <label class="enh-slider">Colour<input type="range" min="-60" max="60" value="0" data-key="saturation"></label>
          <label class="enh-slider">Sharpness<input type="range" min="0" max="100" value="0" data-key="sharpness"></label>
        </div>`;
      document.body.appendChild(root);
      const canvas = root.querySelector(".enh-canvas");
      const info = root.querySelector(".enh-info");
      const seg = root.querySelector(".enh-seg");
      const qnote = root.querySelector(".enh-qnote");
      const useBtn = root.querySelector('[data-act="use"]');

      const finish = (value) => {
        root.remove();
        bitmap.close?.();
        resolve(value);
      };

      const edited = () =>
        state.auto || state.brightness || state.contrast || state.saturation || state.sharpness || state.rotate;

      function refreshInfo() {
        const q = QUALITY[state.quality];
        const turned = state.rotate % 180 !== 0;
        const w = turned ? natH : natW,
          h = turned ? natW : natH;
        const k = Math.min(1, q.edge / Math.max(w, h));
        info.textContent = `Original: ${fmtSize(file.size)} · ${w}×${h}  →  sends at ${Math.round(w * k)}×${Math.round(h * k)}`;
        qnote.textContent = q.note;
        seg.innerHTML = Object.entries(QUALITY)
          .map(
            ([key, v]) =>
              `<button type="button" class="enh-segbtn${key === state.quality ? " on" : ""}" data-q="${key}">${v.label}</button>`,
          )
          .join("");
        root.querySelector('[data-act="auto"]').setAttribute("aria-pressed", String(state.auto));
        root.querySelector('[data-act="auto"]').classList.toggle("on", state.auto);
      }

      function rebuildBase() {
        baseCanvas = drawRotated(bitmap, natW, natH, state.rotate, 1000);
        const ctx = baseCanvas.getContext("2d", { willReadFrequently: true });
        baseData = ctx.getImageData(0, 0, baseCanvas.width, baseCanvas.height);
        levels = levelsOf(baseData.data);
      }

      function paint() {
        if (busy) {
          queued = true;
          return;
        }
        busy = true;
        requestAnimationFrame(() => {
          const copy = new ImageData(new Uint8ClampedArray(baseData.data), baseData.width, baseData.height);
          adjust(copy, state, levels);
          canvas.width = copy.width;
          canvas.height = copy.height;
          canvas.getContext("2d").putImageData(copy, 0, 0);
          busy = false;
          if (queued) {
            queued = false;
            paint();
          }
        });
      }

      async function exportFile() {
        const q = QUALITY[state.quality];
        if (state.quality === "original" && !edited()) return file; // untouched: send as picked
        const full = drawRotated(bitmap, natW, natH, state.rotate, q.edge);
        const ctx = full.getContext("2d", { willReadFrequently: true });
        const data = ctx.getImageData(0, 0, full.width, full.height);
        adjust(data, state, levels);
        ctx.putImageData(data, 0, 0);
        const png = state.quality === "original" && file.type === "image/png";
        const blob = await new Promise((ok) =>
          full.toBlob(ok, png ? "image/png" : "image/jpeg", q.q),
        );
        if (!blob) return file;
        // Never make a normal photo bigger than it was unless it was edited.
        if (!edited() && blob.size >= file.size) return file;
        const base = (file.name || "photo").replace(/\.[^.]+$/, "");
        return new File([blob], `${base}${png ? ".png" : ".jpg"}`, {
          type: blob.type,
          lastModified: Date.now(),
        });
      }

      root.addEventListener("click", async (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        const q = e.target.closest("[data-q]")?.dataset.q;
        if (q) {
          state.quality = q;
          refreshInfo();
          return;
        }
        if (act === "cancel") return finish(null);
        if (act === "auto") {
          state.auto = !state.auto;
          refreshInfo();
          paint();
        }
        if (act === "rotate") {
          state.rotate = (state.rotate + 90) % 360;
          rebuildBase();
          refreshInfo();
          paint();
        }
        if (act === "reset") {
          Object.assign(state, { auto: false, brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
          const turned = state.rotate !== 0;
          state.rotate = 0;
          root.querySelectorAll("input[type=range]").forEach((r) => (r.value = 0));
          if (turned) rebuildBase();
          refreshInfo();
          paint();
        }
        if (act === "use") {
          useBtn.disabled = true;
          useBtn.textContent = "Preparing…";
          try {
            finish(await exportFile());
          } catch (err) {
            console.error("Photo export failed:", err);
            finish(file);
          }
        }
      });
      root.addEventListener("input", (e) => {
        const key = e.target.dataset?.key;
        if (!key) return;
        state[key] = Number(e.target.value);
        paint();
      });
      document.addEventListener(
        "keydown",
        function esc(e) {
          if (!root.isConnected) return document.removeEventListener("keydown", esc);
          if (e.key === "Escape") finish(null);
        },
      );

      rebuildBase();
      refreshInfo();
      paint();
    });
  }

  window.ChatSpaceEnhance = { open, canEdit };
})();
