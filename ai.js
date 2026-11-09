/* ChatSpace AI: a built-in assistant for app help and general questions.
   Accepts text, photos, PDFs/text files and voice notes. Talks to /api/ai (worker.js).
   Needs window.ChatSpaceApp from app.js. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const app = () => window.ChatSpaceApp;
  const toast = (m) => app()?.toast(m);
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  const MAX_FILE = 5 * 1024 * 1024; // per attachment sent to the AI
  const MAX_FILES = 4;
  const MAX_VOICE_SECONDS = 120;
  const SUGGESTIONS = [
    "How do I share my profile?",
    "What does view once do?",
    "How do streaks work?",
    "Help me write a polite message",
  ];
  const ACCEPT =
    "image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json," +
    ".docx,.xlsx,.pptx";

  const state = {
    messages: [], // { role, content, label?, error?, transcript? }
    pending: [], // files waiting to be sent
    busy: false,
    rec: null,
  };
  const storeKey = () => "cs:ai-chat:" + (app()?.user?.id || "guest");
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(storeKey())) || [];
    } catch {
      return [];
    }
  };
  const save = () => {
    try {
      localStorage.setItem(
        storeKey(),
        JSON.stringify(state.messages.filter((m) => !m.error).slice(-40)),
      );
    } catch {}
  };

  /* ---------- tiny safe markdown ---------- */
  function md(text) {
    return String(text)
      .split("```")
      .map((part, i) => {
        if (i % 2)
          return `<pre><code>${esc(part.replace(/^\w*\n/, ""))}</code></pre>`;
        let out = "",
          list = null;
        const close = () => {
          if (list) out += `</${list}>`;
          list = null;
        };
        for (const raw of esc(part).split("\n")) {
          const line = raw
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(
              /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
              '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
            );
          const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
          const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
          if (ul || ol) {
            const kind = ul ? "ul" : "ol";
            if (list !== kind) {
              close();
              out += `<${kind}>`;
              list = kind;
            }
            out += `<li>${(ul || ol)[1]}</li>`;
          } else {
            close();
            if (line.trim()) out += `<p>${line}</p>`;
          }
        }
        close();
        return out;
      })
      .join("");
  }

  /* ---------- panel ---------- */
  function build() {
    if ($("aiPanel")) return $("aiPanel");
    const panel =
      el(`<section id="aiPanel" class="ai-panel hidden" role="dialog" aria-label="ChatSpace AI">
      <header class="ai-head">
        <button type="button" class="ai-back" id="aiBack" aria-label="Back">${CSIcons.icon("back", 20)}</button>
        <div class="ai-avatar" aria-hidden="true">✨</div>
        <div class="ai-title"><strong>ChatSpace AI</strong><small>Ask about the app or anything else</small></div>
        <button type="button" class="ghost-btn ai-clear" id="aiClear">Clear</button>
      </header>
      <div class="ai-messages" id="aiMessages" aria-live="polite"></div>
      <div class="ai-composer">
        <div id="aiAttachments" class="ai-attachments hidden"></div>
        <div id="aiRecBar" class="ai-recbar hidden"><span class="ai-rec-dot"></span><span id="aiRecTime">0:00</span><span class="ai-rec-hint">Recording…</span><button type="button" class="ghost-btn" id="aiRecCancel">Cancel</button></div>
        <div class="ai-row">
          <button type="button" class="ai-icon-btn" id="aiAttach" title="Attach a photo or file" aria-label="Attach a photo or file">${CSIcons.icon("paperclip", 20)}</button>
          <input id="aiFile" type="file" hidden multiple accept="${ACCEPT}" />
          <textarea id="aiInput" rows="1" placeholder="Ask ChatSpace AI…" aria-label="Message ChatSpace AI" enterkeyhint="send"></textarea>
          <button type="button" class="ai-icon-btn" id="aiMic" title="Record a voice note" aria-label="Record a voice note">${CSIcons.icon("mic", 20)}</button>
          <button type="button" class="ai-send" id="aiSend" aria-label="Send">${CSIcons.icon("send", 18)}</button>
        </div>
        <p class="ai-hint">AI can make mistakes. Don't share passwords or private details.</p>
      </div>
    </section>`);
    document.body.appendChild(panel);
    $("aiBack").addEventListener("click", close);
    $("aiClear").addEventListener("click", () => {
      if (
        !state.messages.length ||
        confirm("Clear this conversation with ChatSpace AI?")
      ) {
        state.messages = [];
        save();
        render();
      }
    });
    const input = $("aiInput");
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 132) + "px";
    });
    input.addEventListener("keydown", (e) => {
      // Enter sends on computers; on phones Enter makes a new line.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.isComposing &&
        matchMedia("(hover: hover) and (pointer: fine)").matches
      ) {
        e.preventDefault();
        send();
      }
    });
    $("aiSend").addEventListener("click", () => send());
    $("aiMic").addEventListener("click", toggleRecording);
    $("aiRecCancel").addEventListener("click", () => stopRecording(true));
    $("aiFile").addEventListener("change", onFiles);
    $("aiAttach").addEventListener("click", () => $("aiFile").click());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.classList.contains("hidden")) close();
    });
    return panel;
  }

  function render() {
    const box = $("aiMessages");
    if (!box) return;
    if (!state.messages.length && !state.busy) {
      box.innerHTML = `<div class="ai-welcome"><div class="ai-orb">${CSIcons.icon("sparkles", 26)}</div><h3>Hi, I'm ChatSpace AI</h3><p>I can show you around the app and answer other questions too. Send text, photos, PDFs or a voice note.</p><div class="ai-chips">${SUGGESTIONS.map((s) => `<button type="button" class="ai-chip">${esc(s)}</button>`).join("")}</div></div>`;
      box
        .querySelectorAll(".ai-chip")
        .forEach((b) => b.addEventListener("click", () => send(b.textContent)));
      return;
    }
    box.innerHTML =
      state.messages
        .map((m) => {
          if (m.role === "user")
            return `<div class="ai-msg user"><div class="ai-bubble">${m.label ? `<span class="ai-att">${esc(m.label)}</span>` : ""}${m.content ? `<p>${esc(m.content)}</p>` : ""}</div></div>`;
          return `<div class="ai-msg bot${m.error ? " error" : ""}"><div class="ai-bubble">${m.error ? esc(m.content) : md(m.content)}</div></div>`;
        })
        .join("") +
      (state.busy
        ? `<div class="ai-msg bot"><div class="ai-bubble typing" aria-label="ChatSpace AI is typing"><i></i><i></i><i></i></div></div>`
        : "");
    box.scrollTop = box.scrollHeight;
  }

  function open() {
    if (!app()?.user) return;
    const panel = build();
    state.messages = load();
    panel.classList.remove("hidden");
    document.body.classList.add("ai-open");
    render();
    setTimeout(() => $("aiInput")?.focus({ preventScroll: true }), 150);
  }
  function close() {
    $("aiPanel")?.classList.add("hidden");
    document.body.classList.remove("ai-open");
    stopRecording(true);
  }

  /* ---------- attachments ---------- */
  const toB64 = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  // Photos are shrunk before sending: faster, and the AI doesn't need 12 megapixels.
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      const blob = await new Promise((r) =>
        canvas.toBlob(r, "image/jpeg", 0.85),
      );
      return blob && blob.size < file.size
        ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
            type: "image/jpeg",
          })
        : file;
    } catch {
      return file;
    }
  }

  // Office files report an empty or odd type on some phones, so go by the extension too.
  const OFFICE = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const mimeOf = (f) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (OFFICE[ext]) return OFFICE[ext];
    if (!f.type && ext === "md") return "text/markdown";
    return f.type;
  };
  const supported = (m) =>
    /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/|application\/json|application\/vnd\.openxmlformats-officedocument\.)/.test(
      m,
    );

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    for (const f of files) {
      if (state.pending.length >= MAX_FILES) {
        toast(`You can attach up to ${MAX_FILES} files.`);
        break;
      }
      if (!supported(mimeOf(f))) {
        toast(
          `${f.name}: I can read photos, PDFs, Office files and text files.`,
        );
        continue;
      }
      const prepared = await shrink(f);
      if (prepared.size > MAX_FILE) {
        toast(`${f.name} is too big for the AI (5 MB max).`);
        continue;
      }
      state.pending.push(prepared);
    }
    renderPending();
  }
  function renderPending() {
    const box = $("aiAttachments");
    box.classList.toggle("hidden", !state.pending.length);
    box.innerHTML = state.pending
      .map(
        (f, i) =>
          `<span class="ai-file">${f.type.startsWith("image/") ? "🖼" : "📄"} <span class="ai-file-name">${esc(f.name)}</span><button type="button" data-i="${i}" aria-label="Remove ${esc(f.name)}">${CSIcons.icon("x", 12)}</button></span>`,
      )
      .join("");
    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.pending.splice(Number(b.dataset.i), 1);
        renderPending();
      }),
    );
  }

  /* ---------- voice notes ---------- */
  const fmtTime = (s) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  async function toggleRecording() {
    if (state.busy) return;
    if (state.rec) return stopRecording(false);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      return toast("Voice recording isn't supported in this browser.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      const rec = {
        recorder,
        stream,
        chunks,
        started: Date.now(),
        cancelled: false,
        timer: null,
      };
      state.rec = rec;
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        clearInterval(rec.timer);
        stream.getTracks().forEach((t) => t.stop());
        state.rec = null;
        $("aiRecBar").classList.add("hidden");
        $("aiMic").classList.remove("recording");
        if (rec.cancelled) return;
        const secs = Math.round((Date.now() - rec.started) / 1000);
        if (secs < 1)
          return toast("That was too short. Hold on a little longer.");
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        send("", { blob, secs });
      };
      recorder.start();
      $("aiRecBar").classList.remove("hidden");
      $("aiMic").classList.add("recording");
      $("aiRecTime").textContent = "0:00";
      rec.timer = setInterval(() => {
        const s = Math.round((Date.now() - rec.started) / 1000);
        $("aiRecTime").textContent = fmtTime(s);
        if (s >= MAX_VOICE_SECONDS) stopRecording(false);
      }, 250);
    } catch {
      toast("Microphone permission was denied or unavailable.");
    }
  }
  function stopRecording(cancel) {
    const rec = state.rec;
    if (!rec) return;
    rec.cancelled = cancel;
    try {
      rec.recorder.stop();
    } catch {}
  }

  /* ---------- sending ---------- */
  async function send(prefill = "", voice = null) {
    if (state.busy) return;
    const input = $("aiInput");
    const text = (prefill || input.value).trim();
    const files = voice ? [] : state.pending.slice();
    if (!text && !files.length && !voice) return;
    if (!navigator.onLine)
      return toast("You're offline. The AI needs an internet connection.");

    const userMsg = {
      role: "user",
      content: text,
      label: voice
        ? `🎙 Voice note · ${fmtTime(voice.secs)}`
        : files.map((f) => f.name).join(", "),
    };
    state.messages.push(userMsg);
    input.value = "";
    input.style.height = "auto";
    state.pending = [];
    renderPending();
    state.busy = true;
    render();

    try {
      const { data } = await app().supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Please log in again.");

      const history = state.messages
        .slice(-13, -1)
        .filter((m) => !m.error)
        .map((m) => ({
          role: m.role,
          content: m.content || (m.label ? `(${m.label})` : ""),
        }));
      history.push({ role: "user", content: text });
      const body = { messages: history };
      if (voice)
        body.audio = {
          mime: voice.blob.type || "audio/webm",
          data: await toB64(voice.blob),
        };
      if (files.length)
        body.attachments = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            mime: mimeOf(f),
            data: await toB64(f),
          })),
        );

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.reply) {
        throw new Error(
          json?.error ||
            (res.status === 404
              ? "The AI isn't set up on this site yet."
              : "The AI couldn't answer right now. Please try again."),
        );
      }
      if (json.transcript) userMsg.content = json.transcript;
      state.messages.push({ role: "assistant", content: json.reply });
    } catch (err) {
      state.messages.push({
        role: "assistant",
        content: err.message || "Something went wrong. Please try again.",
        error: true,
      });
    } finally {
      state.busy = false;
      save();
      render();
    }
  }

  /* ---------- entry points ---------- */
  // Called by app.js each time a chat list is drawn: adds ChatSpace AI as the first row.
  function decorateList(list) {
    if (!list || list.id !== "chatList" || list.querySelector(".ai-entry"))
      return;
    const entry =
      el(`<div class="chat-item ai-entry" role="button" tabindex="0">
      <span class="user-avatar ai-avatar">✨</span>
      <span class="chat-item-details"><strong>ChatSpace AI <span class="ai-tag">AI</span></strong><small>Ask about the app or anything else</small></span>
    </div>`);
    entry.addEventListener("click", open);
    entry.addEventListener("keydown", (e) => {
      if (e.target === entry && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open();
      }
    });
    list.prepend(entry);
  }

  function addWelcomeCard() {
    const panel = $("welcomePanel");
    if (!panel || panel.querySelector(".ai-card")) return;
    const card = el(
      `<button type="button" class="ai-card"><span class="ai-orb sm">${CSIcons.icon("sparkles", 18)}</span><span><strong>Ask ChatSpace AI</strong><small>Get help with the app, or ask anything</small></span></button>`,
    );
    card.addEventListener("click", open);
    const anchor = panel.querySelector(".support-card");
    anchor ? anchor.before(card) : panel.appendChild(card);
  }
  const waitForApp = setInterval(() => {
    if ($("welcomePanel")) {
      addWelcomeCard();
      clearInterval(waitForApp);
    }
  }, 300);
  setTimeout(() => clearInterval(waitForApp), 10000);

  window.ChatSpaceAI = { open, close, decorateList };
})();
