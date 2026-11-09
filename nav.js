(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const mobileMQ = window.matchMedia("(max-width: 760px)");
  const isMobile = () => mobileMQ.matches;
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const buzz = (ms = 8) => {
    try {
      navigator.vibrate?.(ms);
    } catch {}
  };
  const api = () => window.CSAppNav || {};
  const shell = () => $("appScreen");
  const appVisible = () => {
    const s = shell();
    return !!s && !s.classList.contains("hidden");
  };
  const shown = (el) =>
    !!el &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const chatOpen = () =>
    isMobile() && !!shell()?.classList.contains("chat-open");

  // ---------- Screens and pop-ups that "Back" can close ----------
  const PANEL_IDS = [
    "profilePanel",
    "settingsPanel",
    "newChatPanel",
    "peerProfilePanel",
    "groupPanel",
  ];
  const panelOpen = (id) => {
    const el = $(id);
    return !!el && !el.classList.contains("hidden");
  };
  const topPanel = () => {
    for (const id of [
      "groupPanel",
      "peerProfilePanel",
      "newChatPanel",
      "settingsPanel",
      "profilePanel",
    ])
      if (panelOpen(id)) return $(id);
    return null;
  };
  const OVERLAYS = [
    {
      sel: ".moment-viewer",
      close: (el) => el.querySelector(".mv-close")?.click(),
    },
    {
      sel: ".vo-viewer",
      close: (el) => el.querySelector("[data-close]")?.click(),
    },
    {
      sel: ".image-viewer.visible",
      close: (el) => el.classList.remove("visible"),
    },
    { sel: ".lightbox", close: (el) => el.click() },
    {
      sel: ".camera-modal",
      close: (el) => el.querySelector('[data-cam="cancel"]')?.click(),
    },
    {
      sel: ".enh-overlay",
      close: (el) => el.querySelector('[data-act="cancel"]')?.click(),
    },
    {
      sel: ".whatsnew-backdrop",
      close: (el) => (el.querySelector('[data-wn="done"]') || el).click(),
    },
    {
      sel: ".stats-backdrop, .gc-picker-backdrop, .chat-menu-backdrop",
      close: (el) => el.click(),
    },
    {
      sel: ".pin-backdrop",
      close: (el) =>
        (
          el.querySelector("[data-cancel],[data-act='cancel'],[data-close]") ||
          el
        ).click(),
    },
    { sel: "#aiPanel:not(.hidden)", close: () => $("aiBack")?.click() },
  ];
  function overlays() {
    const out = [];
    for (const o of OVERLAYS)
      document.querySelectorAll(o.sel).forEach((el) => {
        if (shown(el)) out.push({ el, close: o.close });
      });
    out.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    );
    return out;
  }
  function depth() {
    if (!appVisible()) return 0;
    return (
      (chatOpen() ? 1 : 0) +
      PANEL_IDS.filter(panelOpen).length +
      overlays().length
    );
  }
  function closeTop() {
    const ov = overlays();
    if (ov.length) {
      const t = ov[ov.length - 1];
      try {
        t.close(t.el);
      } catch {}
      return true;
    }
    const sub = ["groupPanel", "peerProfilePanel"].find(panelOpen);
    if (sub) {
      $(sub).classList.add("hidden");
      return true;
    }
    const main = ["newChatPanel", "settingsPanel", "profilePanel"].find(
      panelOpen,
    );
    if (main) {
      if (api().showView) api().showView("messages");
      else $(main).classList.add("hidden");
      return true;
    }
    if (chatOpen()) {
      if (api().closeChat) api().closeChat();
      else shell().classList.remove("chat-open");
      return true;
    }
    return false;
  }

  // ---------- Back button / back gesture (history) ----------
  const stateD = (s) => (s && typeof s.csd === "number" ? s.csd : 0);
  let pending = false,
    exitArmed = false,
    raf = 0;
  const watched = new WeakSet();
  const observer = new MutationObserver(() => schedule());
  function watch(el) {
    if (!el || watched.has(el)) return;
    watched.add(el);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  }
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      watch($("aiPanel"));
      watch(document.querySelector(".image-viewer"));
      sync();
      updateJump();
    });
  }
  function sync() {
    if (pending) return;
    const d = depth(),
      cur = stateD(history.state);
    try {
      if (d > cur) {
        for (let i = cur + 1; i <= d; i++) history.pushState({ csd: i }, "");
      } else if (d < cur) {
        pending = true;
        history.go(d - cur);
        setTimeout(() => {
          if (pending) {
            pending = false;
            schedule();
          }
        }, 700);
      }
    } catch {}
  }
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2000);
  }
  window.addEventListener("popstate", (e) => {
    if (pending) {
      pending = false;
      schedule();
      return;
    }
    const target = stateD(e.state);
    if (target < 0) {
      // Back pressed on the home screen: needs a second press to leave the app.
      if (exitArmed && !api().inCall?.()) {
        exitArmed = false;
        history.back();
        return;
      }
      try {
        history.pushState({ csd: 0 }, "");
      } catch {}
      if (!api().inCall?.()) {
        exitArmed = true;
        toast("Press back again to exit");
        setTimeout(() => (exitArmed = false), 2200);
      }
      return;
    }
    if (depth() > target) closeTop();
    schedule();
  });

  // ---------- Swipe from left to right = go back ----------
  const THRESH = 0.32,
    VELO = 0.55;
  const BLOCK =
    'input, textarea, select, [contenteditable="true"], audio, video, canvas, .moments-bar, .gif-panel, .reaction-options, .moment-viewer, .call-screen, .gc-screen, .incoming-call, .enh-overlay, .camera-modal, .image-viewer, .lightbox, .vo-viewer, .stats-backdrop, .pin-backdrop, .chat-context-menu, .whatsnew-backdrop, .leaflet-container';
  function insideHScroll(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (
        (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
        n.scrollWidth > n.clientWidth + 2
      )
        return true;
    }
    return false;
  }
  function topLayer() {
    if (overlays().some((o) => o.el.id !== "aiPanel")) return null;
    if (shown($("aiPanel")))
      return {
        kind: "panel",
        el: $("aiPanel"),
        close: () => $("aiBack")?.click(),
      };
    const p = topPanel();
    if (p) return { kind: "panel", el: p, close: () => closeTop() };
    if (chatOpen())
      return {
        kind: "chat",
        el: document.querySelector(".chat-panel"),
        close: () => closeTop(),
      };
    return null;
  }
  const hint = document.createElement("div");
  hint.className = "cs-back-hint";
  hint.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  let g = null,
    settling = false;

  function setPeek(p) {
    const s = shell();
    s.style.setProperty("--cs-peek-x", -24 * (1 - p) + "%");
    s.style.setProperty("--cs-peek-b", String(0.75 + 0.25 * p));
  }
  function cleanup() {
    const L = g?.layer;
    if (L) {
      L.el.style.transform = "";
      L.el.style.transition = "";
      L.el.style.willChange = "";
    }
    const s = shell();
    s?.classList.remove("cs-peek");
    s?.style.removeProperty("--cs-peek-x");
    s?.style.removeProperty("--cs-peek-b");
    const sb = document.querySelector(".sidebar");
    if (sb) sb.style.transition = "";
    hint.style.opacity = "0";
    hint.classList.remove("ready");
  }
  function begin() {
    g.mode = "drag";
    g.w = window.innerWidth;
    document.activeElement?.blur?.();
    if (!hint.isConnected) document.body.appendChild(hint);
    if (g.layer.kind === "chat") shell().classList.add("cs-peek");
    g.layer.el.style.transition = "none";
    g.layer.el.style.willChange = "transform";
  }
  function move(dx) {
    g.dx = dx;
    const p = Math.min(1, dx / g.w);
    g.layer.el.style.transform = `translate3d(${dx}px,0,0)`;
    if (g.layer.kind === "chat") setPeek(p);
    const ready = dx > g.w * THRESH;
    if (ready !== g.ready) {
      g.ready = ready;
      hint.classList.toggle("ready", ready);
      if (ready) buzz(6);
    }
    hint.style.opacity = String(Math.min(1, dx / 70));
    hint.style.transform = `translate3d(${Math.min(dx * 0.45, 56) - 20}px,0,0) scale(${0.7 + 0.3 * Math.min(1, dx / 90)})`;
  }
  function finish(commit) {
    const L = g.layer,
      w = g.w;
    settling = true;
    L.el.style.transition = "transform .24s cubic-bezier(.2,.8,.2,1)";
    if (L.kind === "chat") {
      const sb = document.querySelector(".sidebar");
      if (sb) sb.style.transition = "transform .24s, filter .24s";
      setPeek(commit ? 1 : 0);
    }
    L.el.style.transform = `translate3d(${commit ? w : 0}px,0,0)`;
    setTimeout(() => {
      if (commit) {
        buzz(10);
        L.close();
      }
      cleanup();
      g = null;
      settling = false;
      schedule();
    }, 240);
  }
  document.addEventListener(
    "touchstart",
    (e) => {
      g = settling ? g : null;
      if (settling || !isMobile() || !appVisible() || e.touches.length !== 1)
        return;
      if (api().inCall?.()) return;
      const t = e.touches[0];
      if (isIOS && t.clientX <= 14) return; // iOS has its own edge swipe
      const edge = t.clientX <= 24;
      if (!edge && (e.target.closest?.(BLOCK) || insideHScroll(e.target)))
        return;
      const layer = topLayer();
      if (!layer) return;
      g = {
        x: t.clientX,
        y: t.clientY,
        t: performance.now(),
        layer,
        mode: "idle",
        dx: 0,
      };
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!g || settling) return;
      const t = e.touches[0],
        dx = t.clientX - g.x,
        dy = t.clientY - g.y;
      if (g.mode === "idle") {
        if (dx < -12 || (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx))) {
          g = null;
          return;
        }
        if (dx > 14 && dx > Math.abs(dy) * 1.4) begin();
        else return;
      }
      if (e.cancelable) e.preventDefault();
      move(Math.max(0, dx));
    },
    { passive: false },
  );
  const end = (e) => {
    if (!g || settling) return;
    if (g.mode !== "drag") {
      g = null;
      return;
    }
    const v = g.dx / Math.max(1, performance.now() - g.t);
    finish(
      e.type !== "touchcancel" &&
        (g.dx > g.w * THRESH || (v > VELO && g.dx > 40)),
    );
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });

  // ---------- Jump to latest message ----------
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "cs-jump";
  jump.setAttribute("aria-label", "Jump to latest message");
  jump.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  function updateJump() {
    const msgs = $("messages");
    if (!msgs) return;
    const far = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight > 320;
    const vis =
      far &&
      appVisible() &&
      shown(msgs) &&
      !PANEL_IDS.some(panelOpen) &&
      overlays().length === 0;
    if (vis) {
      const r = msgs.getBoundingClientRect(),
        c = $("composer"),
        top = c && shown(c) ? c.getBoundingClientRect().top : r.bottom;
      jump.style.left = Math.round(r.right - 58) + "px";
      jump.style.top = Math.round(top - 58) + "px";
    }
    jump.classList.toggle("show", vis);
  }
  jump.addEventListener("click", () => {
    $("messages")?.scrollTo({
      top: $("messages").scrollHeight,
      behavior: "smooth",
    });
    buzz(6);
  });

  // ---------- Small extras ----------
  document.addEventListener("click", (e) => {
    if (e.target.closest?.(".nav-btn")) buzz(6);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (/input|textarea|select/i.test(document.activeElement?.tagName || ""))
      return;
    if (depth() > 0 && closeTop()) e.preventDefault();
  });

  function init() {
    document.body.appendChild(jump);
    $("messages")?.addEventListener(
      "scroll",
      () => requestAnimationFrame(updateJump),
      {
        passive: true,
      },
    );
    window.addEventListener("resize", updateJump);
    window.visualViewport?.addEventListener("resize", updateJump);
    watch(shell());
    PANEL_IDS.forEach((id) => watch($(id)));
    watch($("messages"));
    watch($("composer"));
    new MutationObserver(schedule).observe(document.body, { childList: true });
    if (
      isMobile() &&
      !(history.state && typeof history.state.csd === "number")
    ) {
      try {
        history.replaceState({ csd: -1 }, "");
        history.pushState({ csd: 0 }, "");
      } catch {}
    }
    schedule();
  }
  init();
})();
