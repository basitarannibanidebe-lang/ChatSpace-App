/* ChatSpace Translator
   - Language list for the sign-up picker, the Profile page and the translator.
   - A translate button beside the person's name and picture inside a chat.
     It pops up a translator: their messages in your language, and a box to
     write a reply in their language.
   - Talks to /api/translate (worker.js). Needs window.ChatSpaceApp from app.js. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const app = () => window.ChatSpaceApp;
  const toast = (m) => app()?.toast?.(m);
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

  // [code, English name, name in that language]
  // These are the languages the free Cloudflare translator understands.
  const LANGS = [
    ["af", "Afrikaans", "Afrikaans"],
    ["sq", "Albanian", "Shqip"],
    ["am", "Amharic", "አማርኛ"],
    ["ar", "Arabic", "العربية"],
    ["hy", "Armenian", "Հայերեն"],
    ["ast", "Asturian", "Asturianu"],
    ["az", "Azerbaijani", "Azərbaycanca"],
    ["ba", "Bashkir", "Башҡортса"],
    ["be", "Belarusian", "Беларуская"],
    ["bn", "Bengali", "বাংলা"],
    ["bs", "Bosnian", "Bosanski"],
    ["br", "Breton", "Brezhoneg"],
    ["bg", "Bulgarian", "Български"],
    ["my", "Burmese", "မြန်မာ"],
    ["ca", "Catalan", "Català"],
    ["ceb", "Cebuano", "Cebuano"],
    ["zh", "Chinese", "中文"],
    ["hr", "Croatian", "Hrvatski"],
    ["cs", "Czech", "Čeština"],
    ["da", "Danish", "Dansk"],
    ["nl", "Dutch", "Nederlands"],
    ["en", "English", "English"],
    ["et", "Estonian", "Eesti"],
    ["ff", "Fulah", "Fulfulde"],
    ["fi", "Finnish", "Suomi"],
    ["fr", "French", "Français"],
    ["gl", "Galician", "Galego"],
    ["lg", "Ganda (Luganda)", "Luganda"],
    ["ka", "Georgian", "ქართული"],
    ["de", "German", "Deutsch"],
    ["el", "Greek", "Ελληνικά"],
    ["gu", "Gujarati", "ગુજરાતી"],
    ["ht", "Haitian Creole", "Kreyòl ayisyen"],
    ["ha", "Hausa", "Hausa"],
    ["he", "Hebrew", "עברית"],
    ["hi", "Hindi", "हिन्दी"],
    ["hu", "Hungarian", "Magyar"],
    ["is", "Icelandic", "Íslenska"],
    ["ig", "Igbo", "Igbo"],
    ["ilo", "Iloko", "Ilokano"],
    ["id", "Indonesian", "Bahasa Indonesia"],
    ["ga", "Irish", "Gaeilge"],
    ["it", "Italian", "Italiano"],
    ["ja", "Japanese", "日本語"],
    ["jv", "Javanese", "Basa Jawa"],
    ["kn", "Kannada", "ಕನ್ನಡ"],
    ["kk", "Kazakh", "Қазақша"],
    ["km", "Khmer", "ខ្មែរ"],
    ["ko", "Korean", "한국어"],
    ["lo", "Lao", "ລາວ"],
    ["lv", "Latvian", "Latviešu"],
    ["ln", "Lingala", "Lingála"],
    ["lt", "Lithuanian", "Lietuvių"],
    ["lb", "Luxembourgish", "Lëtzebuergesch"],
    ["mk", "Macedonian", "Македонски"],
    ["mg", "Malagasy", "Malagasy"],
    ["ms", "Malay", "Bahasa Melayu"],
    ["ml", "Malayalam", "മലയാളം"],
    ["mr", "Marathi", "मराठी"],
    ["mn", "Mongolian", "Монгол"],
    ["ne", "Nepali", "नेपाली"],
    ["ns", "Northern Sotho", "Sepedi"],
    ["no", "Norwegian", "Norsk"],
    ["oc", "Occitan", "Occitan"],
    ["or", "Odia", "ଓଡ଼ିଆ"],
    ["ps", "Pashto", "پښتو"],
    ["fa", "Persian", "فارسی"],
    ["pl", "Polish", "Polski"],
    ["pt", "Portuguese", "Português"],
    ["pa", "Punjabi", "ਪੰਜਾਬੀ"],
    ["ro", "Romanian", "Română"],
    ["ru", "Russian", "Русский"],
    ["gd", "Scottish Gaelic", "Gàidhlig"],
    ["sr", "Serbian", "Српски"],
    ["sd", "Sindhi", "سنڌي"],
    ["si", "Sinhala", "සිංහල"],
    ["sk", "Slovak", "Slovenčina"],
    ["sl", "Slovenian", "Slovenščina"],
    ["so", "Somali", "Soomaali"],
    ["es", "Spanish", "Español"],
    ["su", "Sundanese", "Basa Sunda"],
    ["sw", "Swahili", "Kiswahili"],
    ["ss", "Swati", "SiSwati"],
    ["sv", "Swedish", "Svenska"],
    ["tl", "Tagalog (Filipino)", "Tagalog"],
    ["ta", "Tamil", "தமிழ்"],
    ["th", "Thai", "ไทย"],
    ["tn", "Tswana", "Setswana"],
    ["tr", "Turkish", "Türkçe"],
    ["uk", "Ukrainian", "Українська"],
    ["ur", "Urdu", "اردو"],
    ["uz", "Uzbek", "Oʻzbekcha"],
    ["vi", "Vietnamese", "Tiếng Việt"],
    ["cy", "Welsh", "Cymraeg"],
    ["fy", "Western Frisian", "Frysk"],
    ["wo", "Wolof", "Wolof"],
    ["xh", "Xhosa", "isiXhosa"],
    ["yi", "Yiddish", "ייִדיש"],
    ["yo", "Yoruba", "Yorùbá"],
    ["zu", "Zulu", "isiZulu"],
  ];
  const BY_CODE = new Map(LANGS.map((l) => [l[0], l]));
  const langName = (code) => BY_CODE.get(code)?.[1] || "Unknown language";
  const optionLabel = (l) => (l[1] === l[2] ? l[1] : `${l[1]} — ${l[2]}`);

  function browserLanguage() {
    const list = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || "en"];
    for (const l of list) {
      let c = String(l).toLowerCase().split("-")[0];
      if (c === "fil") c = "tl";
      if (c === "nb" || c === "nn") c = "no";
      if (c === "iw") c = "he";
      if (BY_CODE.has(c)) return c;
    }
    return "en";
  }

  function fillSelect(select, value, { blank } = {}) {
    if (!select) return;
    select.innerHTML =
      (blank ? `<option value="">${esc(blank)}</option>` : "") +
      LANGS.map(
        (l) => `<option value="${l[0]}">${esc(optionLabel(l))}</option>`,
      ).join("");
    select.value = BY_CODE.has(value) ? value : blank ? "" : "en";
  }

  // ---------- my language ----------
  const myKey = () => "cs:mylang:" + (app()?.user?.id || "guest");
  function myLang() {
    const fromProfile = app()?.profile?.language;
    if (BY_CODE.has(fromProfile)) return fromProfile;
    try {
      const saved = localStorage.getItem(myKey());
      if (BY_CODE.has(saved)) return saved;
    } catch {}
    return browserLanguage();
  }
  async function saveMyLanguage(code) {
    if (!BY_CODE.has(code) || !app()?.user) return false;
    try {
      localStorage.setItem(myKey(), code);
    } catch {}
    if (app().profile) app().profile.language = code;
    langCache.set(app().user.id, code);
    const { error } = await app()
      .supabase.from("profiles")
      .update({ language: code })
      .eq("id", app().user.id);
    if (error) {
      toast(
        "Saved on this phone only. Run translate_setup.sql in Supabase so others can see your language.",
      );
      return false;
    }
    return true;
  }

  // ---------- other people's languages ----------
  const langCache = new Map(); // user id -> code or null
  async function languagesFor(ids) {
    const need = ids.filter((id) => !langCache.has(id));
    if (need.length) {
      let rows = [];
      try {
        const { data, error } = await app()
          .supabase.from("profiles")
          .select("id,language")
          .in("id", need);
        if (!error) rows = data || [];
      } catch {}
      for (const r of rows) langCache.set(r.id, r.language || null);
      for (const id of need) if (!langCache.has(id)) langCache.set(id, null);
    }
    return new Map(ids.map((id) => [id, langCache.get(id) || null]));
  }

  // ---------- talking to the translator ----------
  const CACHE_KEY = "cs:tr-cache:v1";
  let memo = null;
  const loadMemo = () => {
    if (memo) return memo;
    try {
      memo = new Map(
        Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY)) || {}),
      );
    } catch {
      memo = new Map();
    }
    return memo;
  };
  const saveMemo = () => {
    try {
      const entries = [...loadMemo().entries()].slice(-250);
      memo = new Map(entries);
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify(Object.fromEntries(entries)),
      );
    } catch {}
  };
  const memoKey = (src, tgt, text) => `${src || "auto"}>${tgt}:${text}`;

  async function callApi(texts, src, tgt) {
    if (!navigator.onLine)
      throw new Error("You're offline. Translating needs internet.");
    const { data } = await app().supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Please log in again.");
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        texts,
        source: src || "auto",
        target: tgt,
        source_name: src ? langName(src) : "",
        target_name: langName(tgt),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Translation failed.");
    return Array.isArray(json.translations) ? json.translations : [];
  }

  // items: [{ text, src }]  ->  array of translated strings (same order)
  async function translateMany(items, tgt) {
    const cache = loadMemo();
    const out = new Array(items.length).fill(null);
    const groups = new Map(); // src -> [index,...]
    items.forEach((it, i) => {
      const hit = cache.get(memoKey(it.src, tgt, it.text));
      if (hit != null) out[i] = hit;
      else if (it.src && it.src === tgt) out[i] = it.text;
      else {
        const k = it.src || "auto";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      }
    });
    for (const [src, idxs] of groups) {
      for (let p = 0; p < idxs.length; p += 20) {
        const part = idxs.slice(p, p + 20);
        const result = await callApi(
          part.map((i) => items[i].text),
          src === "auto" ? "" : src,
          tgt,
        );
        part.forEach((i, n) => {
          const t = String(result[n] || "").trim();
          if (t) {
            out[i] = t;
            cache.set(memoKey(items[i].src, tgt, items[i].text), t);
          }
        });
      }
    }
    saveMemo();
    return out;
  }

  // ---------- header button ----------
  let sheet = null;
  const unreadDot = { on: false };
  function setDot(on) {
    unreadDot.on = on;
    $("translateBtn")?.classList.toggle("has-new", on);
  }
  async function refreshButton() {
    const btn = $("translateBtn");
    if (!btn) return;
    const peer = app()?.activePeer;
    if (!peer) return btn.classList.add("hidden");
    if (peer.isGroup) return btn.classList.remove("hidden");
    const id = peer.id;
    const map = await languagesFor([id]);
    if (app()?.activePeer?.id !== id) return;
    const theirs = map.get(id);
    btn.classList.toggle("hidden", Boolean(theirs) && theirs === myLang());
    btn.title = theirs
      ? `Translate from ${langName(theirs)}`
      : "Translate messages";
  }

  // ---------- popup ----------
  function closeSheet() {
    sheet?.remove();
    sheet = null;
  }

  function collectMessages() {
    const peer = app().activePeer;
    const me = app().user.id;
    const members = new Map(
      (app().groupMembers || []).map((m) => [m.user_id, m]),
    );
    const rows = [];
    for (const m of app().messageCache.values()) {
      if (!m || m.sender_id === me) continue;
      const text = String(m.content || "").trim();
      if (!text || m.deleted_for_everyone || m.view_once) continue;
      if (/^https?:\/\/\S+$/i.test(text)) continue; // links and GIFs
      if (
        !document.querySelector(
          `[data-message-id="${CSS.escape(String(m.id))}"]`,
        )
      )
        continue; // hidden for me
      rows.push({
        id: String(m.id),
        sender: m.sender_id,
        text: text.slice(0, 1500),
        at: new Date(m.created_at).getTime() || 0,
        who: peer?.isGroup
          ? members.get(m.sender_id)?.display_name ||
            members.get(m.sender_id)?.username ||
            "Member"
          : "",
      });
    }
    rows.sort((a, b) => a.at - b.at);
    return rows.slice(-15);
  }

  function itemHtml(r) {
    return `<div class="tr-item" data-id="${esc(r.id)}">
      ${r.who ? `<small class="tr-who-name">${esc(r.who)}</small>` : ""}
      <div class="tr-orig">${esc(r.text)}</div>
      <div class="tr-new"><span class="tr-shimmer"></span></div>
    </div>`;
  }

  async function translateList() {
    if (!sheet) return;
    const list = sheet.querySelector("#trList");
    const tgt = sheet.querySelector("#trTarget").value;
    const rows = collectMessages();
    const peer = app().activePeer;
    if (!rows.length) {
      list.innerHTML = `<p class="tr-empty">No text messages from ${esc(
        peer?.isGroup ? "this group" : $("peerName").textContent,
      )} to translate yet. Open this again when they write.</p>`;
      return;
    }
    list.innerHTML = rows.map(itemHtml).join("");
    list.scrollTop = list.scrollHeight;
    const langs = await languagesFor([...new Set(rows.map((r) => r.sender))]);
    const items = rows.map((r) => ({
      text: r.text,
      src: langs.get(r.sender) || "",
    }));
    try {
      const done = await translateMany(items, tgt);
      if (!sheet || sheet.querySelector("#trTarget").value !== tgt) return;
      rows.forEach((r, i) => {
        const slot = list.querySelector(
          `[data-id="${CSS.escape(r.id)}"] .tr-new`,
        );
        if (!slot) return;
        if (done[i] == null)
          slot.innerHTML = `<span class="tr-fail">Couldn't translate this one.</span>`;
        else if (items[i].src && items[i].src === tgt)
          slot.innerHTML = `<span class="tr-same">Already in ${esc(langName(tgt))}</span>`;
        else slot.textContent = done[i];
      });
    } catch (e) {
      list.querySelectorAll(".tr-new").forEach((n) => {
        n.innerHTML = `<span class="tr-fail">${esc(e.message || "Couldn't translate.")}</span>`;
      });
    }
  }

  async function appendIncoming(msg) {
    if (!sheet || !msg?.content) return;
    const text = String(msg.content).trim();
    if (!text || /^https?:\/\/\S+$/i.test(text) || msg.view_once) return;
    const list = sheet.querySelector("#trList");
    list.querySelector(".tr-empty")?.remove();
    const members = new Map(
      (app().groupMembers || []).map((m) => [m.user_id, m]),
    );
    const row = {
      id: String(msg.id),
      text: text.slice(0, 1500),
      who: app().activePeer?.isGroup
        ? members.get(msg.sender_id)?.display_name ||
          members.get(msg.sender_id)?.username ||
          "Member"
        : "",
    };
    list.insertAdjacentHTML("beforeend", itemHtml(row));
    list.scrollTop = list.scrollHeight;
    const tgt = sheet.querySelector("#trTarget").value;
    const src = (await languagesFor([msg.sender_id])).get(msg.sender_id) || "";
    const slot = list.querySelector(
      `[data-id="${CSS.escape(row.id)}"] .tr-new`,
    );
    try {
      const [t] = await translateMany([{ text: row.text, src }], tgt);
      if (slot) slot.textContent = t ?? "Couldn't translate this one.";
    } catch (e) {
      if (slot)
        slot.innerHTML = `<span class="tr-fail">${esc(e.message)}</span>`;
    }
  }

  async function openTranslator() {
    const peer = app()?.activePeer;
    if (!peer) return;
    closeSheet();
    setDot(false);
    const mine = myLang();
    let theirs = "";
    if (!peer.isGroup)
      theirs = (await languagesFor([peer.id])).get(peer.id) || "";
    const avatar = $("peerAvatar")?.innerHTML || "";
    const name = $("peerName")?.textContent || "Translator";

    sheet = document.createElement("div");
    sheet.className = "tr-backdrop";
    sheet.innerHTML = `
      <div class="tr-sheet" role="dialog" aria-label="Translator">
        <div class="tr-head">
          <div class="tr-avatar user-avatar">${avatar}</div>
          <div class="tr-title">
            <strong>${esc(name)}</strong>
            <small>${
              theirs
                ? `${esc(langName(theirs))} → ${esc(langName(mine))}`
                : peer.isGroup
                  ? "Translator"
                  : "Their language isn't set yet"
            }</small>
          </div>
          <button type="button" class="tr-x" data-tr="close" aria-label="Close">✕</button>
        </div>
        <div class="tr-tabs">
          <button type="button" class="active" data-tab="read">Their messages</button>
          <button type="button" data-tab="write">Reply in their language</button>
        </div>
        <div class="tr-pane" data-pane="read">
          <label class="tr-label" for="trTarget">Translate into</label>
          <select id="trTarget" class="tr-select"></select>
          <div id="trList" class="tr-list" aria-live="polite"></div>
        </div>
        <div class="tr-pane hidden" data-pane="write">
          <label class="tr-label" for="trPeerLang">Their language</label>
          <select id="trPeerLang" class="tr-select"></select>
          <label class="tr-label" for="trInput">Your message</label>
          <textarea id="trInput" class="tr-input" rows="3" maxlength="1000" placeholder="Type in ${esc(langName(mine))}…"></textarea>
          <button type="button" class="tr-go" data-tr="go">Translate</button>
          <div id="trOut" class="tr-out hidden">
            <p id="trOutText"></p>
            <div class="tr-actions">
              <button type="button" data-tr="use">Use in chat</button>
              <button type="button" data-tr="copy">Copy</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    fillSelect(sheet.querySelector("#trTarget"), mine);
    fillSelect(sheet.querySelector("#trPeerLang"), theirs || "en");

    sheet.addEventListener("click", async (e) => {
      if (e.target === sheet) return closeSheet();
      const tab = e.target.closest("[data-tab]")?.dataset.tab;
      if (tab) {
        sheet
          .querySelectorAll("[data-tab]")
          .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
        sheet
          .querySelectorAll("[data-pane]")
          .forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
        if (tab === "write") sheet.querySelector("#trInput").focus();
        return;
      }
      const act = e.target.closest("[data-tr]")?.dataset.tr;
      if (act === "close") return closeSheet();
      const outText = sheet.querySelector("#trOutText");
      if (act === "copy" && outText.textContent) {
        try {
          await navigator.clipboard.writeText(outText.textContent);
          toast("Copied.");
        } catch {
          toast("Couldn't copy. Press and hold the text to copy it.");
        }
      }
      if (act === "use" && outText.textContent) {
        app().composerInsert(outText.textContent);
        closeSheet();
      }
      if (act === "go") {
        const input = sheet.querySelector("#trInput");
        const text = input.value.trim();
        if (!text) return input.focus();
        const btn = e.target.closest("[data-tr]");
        const out = sheet.querySelector("#trOut");
        btn.disabled = true;
        btn.textContent = "Translating…";
        try {
          const [t] = await translateMany(
            [{ text, src: myLang() }],
            sheet.querySelector("#trPeerLang").value,
          );
          outText.textContent = t || "";
          out.classList.toggle("hidden", !t);
          if (!t) toast("Couldn't translate that. Try again.");
        } catch (err) {
          toast(err.message || "Couldn't translate that.");
        } finally {
          btn.disabled = false;
          btn.textContent = "Translate";
        }
      }
    });
    sheet.querySelector("#trTarget").addEventListener("change", translateList);
    document.addEventListener("keydown", escClose);
    translateList();
  }
  const escClose = (e) => {
    if (e.key === "Escape" && sheet) closeSheet();
  };

  // ---------- first-time language prompt (people who joined before this feature) ----------
  function askLanguageOnce() {
    const user = app()?.user;
    if (!user || app()?.profile?.language) return;
    const askedKey = "cs:lang-asked:" + user.id;
    try {
      if (localStorage.getItem(askedKey) || localStorage.getItem(myKey()))
        return;
    } catch {}
    let tries = 0;
    const attempt = () => {
      if (!app()?.user || app().profile?.language) return;
      if (
        document.querySelector(".whatsnew-backdrop, .camera-modal, .vo-viewer")
      ) {
        if (++tries < 30) setTimeout(attempt, 1500);
        return;
      }
      showLanguagePrompt(askedKey);
    };
    setTimeout(attempt, 1200);
  }
  function showLanguagePrompt(askedKey) {
    if (document.querySelector(".tr-backdrop.tr-ask")) return;
    const box = document.createElement("div");
    box.className = "tr-backdrop tr-ask";
    box.innerHTML = `
      <div class="tr-sheet" role="dialog" aria-label="Choose your language">
        <h2 class="tr-ask-title">🌍 Choose your language</h2>
        <p class="tr-ask-text">When someone writes to you in another language, ChatSpace can translate it for you. Pick the language you speak.</p>
        <select id="trAskLang" class="tr-select"></select>
        <button type="button" class="tr-go" data-ask="save">Save</button>
        <button type="button" class="tr-skip" data-ask="skip">Not now</button>
      </div>`;
    document.body.appendChild(box);
    fillSelect(box.querySelector("#trAskLang"), browserLanguage());
    box.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-ask]")?.dataset.ask;
      if (!act) return;
      try {
        localStorage.setItem(askedKey, "1");
      } catch {}
      if (act === "save") {
        await saveMyLanguage(box.querySelector("#trAskLang").value);
        syncProfileSelect();
        refreshButton();
        toast("Language saved.");
      }
      box.remove();
    });
  }

  // ---------- Profile page selector ----------
  const LANG_SELECTS = ["profileLanguage", "settingsLanguage"];
  function syncProfileSelect() {
    for (const id of LANG_SELECTS) {
      const sel = $(id);
      if (!sel) continue;
      if (!sel.options.length) fillSelect(sel, myLang());
      else sel.value = myLang();
    }
  }

  // ---------- wiring ----------
  function init() {
    fillSelect($("signupLanguage"), browserLanguage());
    $("translateBtn")?.addEventListener("click", openTranslator);
    for (const id of LANG_SELECTS) {
      fillSelect($(id), "en");
      $(id)?.addEventListener("change", async (e) => {
        const ok = await saveMyLanguage(e.target.value);
        syncProfileSelect();
        if (ok) toast("Language saved.");
        refreshButton();
      });
    }
    document.addEventListener("cs:profile-ready", () => {
      syncProfileSelect();
      askLanguageOnce();
    });
    document.addEventListener("cs:chat-open", () => {
      closeSheet();
      setDot(false);
      refreshButton();
    });
    document.addEventListener("cs:chat-close", () => {
      closeSheet();
      setDot(false);
      $("translateBtn")?.classList.add("hidden");
    });
    document.addEventListener("cs:incoming", (e) => {
      const msg = e.detail;
      if (!msg || msg.sender_id === app()?.user?.id) return;
      if (sheet) return appendIncoming(msg);
      if (!$("translateBtn")?.classList.contains("hidden")) setDot(true);
    });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CSTranslate = { languages: LANGS, langName, myLang };
})();
