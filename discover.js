/* Find people: nearby (rough location) and from your phone contacts.
   Everything is opt-in and off by default. Needs window.ChatSpaceApp from app.js
   and the SQL in chatspace_batch_f.sql. */
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

  const COUNTRY_CODES = {
    NG: "234",
    GH: "233",
    KE: "254",
    ZA: "27",
    UG: "256",
    TZ: "255",
    CM: "237",
    SN: "221",
    CI: "225",
    US: "1",
    CA: "1",
    GB: "44",
    IE: "353",
    IN: "91",
    PK: "92",
    BD: "880",
    AE: "971",
    SA: "966",
    DE: "49",
    FR: "33",
    ES: "34",
    IT: "39",
    BR: "55",
    MX: "52",
    PH: "63",
    ID: "62",
    AU: "61",
    EG: "20",
  };
  const guessCountryCode = () => {
    const region = (navigator.language || "").split("-")[1]?.toUpperCase();
    return COUNTRY_CODES[region] || "234";
  };

  const state = {
    tab: "nearby",
    settings: { nearby_enabled: false, phone_enabled: false },
    loaded: false,
    radius: 25,
    cc: localStorage.getItem("chatspace-cc") || guessCountryCode(),
    myPhoneSaved: false,
    map: null,
    mapVisible: false,
  };

  /* ---------- phone numbers ---------- */
  function toE164(raw, cc) {
    let d = String(raw || "").trim();
    if (!d) return null;
    const plus = d.startsWith("+");
    d = d.replace(/\D/g, "");
    if (!d) return null;
    if (!plus) {
      if (d.startsWith("00")) d = d.slice(2);
      else if (d.startsWith("0")) d = cc + d.slice(1);
      else if (!(d.startsWith(cc) && d.length >= cc.length + 8)) d = cc + d;
    }
    return /^[1-9]\d{7,14}$/.test(d) ? "+" + d : null;
  }

  // vCard (.vcf) files: every phone and iPhone can export contacts in this format.
  function parseVcf(text) {
    const unfolded = text.replace(/\r?\n[ \t]/g, "");
    const people = [];
    for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
      let name = "";
      const tels = [];
      for (const line of block.split(/\r?\n/)) {
        const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toUpperCase();
        if (key === "FN") name = m[3].trim();
        else if (key === "N" && !name)
          name = m[3].split(";").filter(Boolean).reverse().join(" ").trim();
        else if (key === "TEL") tels.push(m[3].trim());
      }
      if (tels.length) people.push({ name, tel: tels });
    }
    return people;
  }

  /* ---------- server calls ---------- */
  const rpc = async (fn, args) => {
    const { data, error } = await app().supabase.rpc(fn, args);
    if (error) {
      const msg =
        /does not exist|schema cache|Could not find the function/i.test(
          error.message,
        )
          ? "Find people isn't set up yet. Run chatspace_batch_f.sql in Supabase."
          : error.message;
      throw new Error(msg);
    }
    return data;
  };

  async function loadSettings() {
    const { data, error } = await app()
      .supabase.from("discovery_settings")
      .select("nearby_enabled,phone_enabled")
      .eq("user_id", app().user.id)
      .maybeSingle();
    if (error && /does not exist|schema cache/i.test(error.message))
      throw new Error(
        "Find people isn't set up yet. Run chatspace_batch_f.sql in Supabase.",
      );
    state.settings = data || { nearby_enabled: false, phone_enabled: false };
    state.loaded = true;
  }
  const saveSettings = (nearby, phone) =>
    rpc("set_discovery_settings", { nearby, phone }).then(() => {
      state.settings = { nearby_enabled: nearby, phone_enabled: phone };
    });

  /* ---------- screen ---------- */
  const root = () => $("discoverRoot");
  const setBusy = (el, busy, label) => {
    if (!el) return;
    el.disabled = busy;
    if (label) el.textContent = label;
  };

  async function show() {
    const box = root();
    if (state.userId !== app().user.id) {
      state.userId = app().user.id;
      state.loaded = false;
      state.tab = "nearby";
    }
    destroyMap();
    box.innerHTML = `<p class="muted tiny">Loading…</p>`;
    try {
      if (!state.loaded) await loadSettings();
    } catch (e) {
      box.innerHTML = `<p class="dc-error">${esc(e.message)}</p>`;
      return;
    }
    render();
  }

  function render() {
    const box = root();
    box.innerHTML = `
      <div class="dc-tabs three" role="tablist">
        <button type="button" role="tab" class="dc-tab" data-tab="nearby" aria-selected="${state.tab === "nearby"}">📍 Nearby</button>
        <button type="button" role="tab" class="dc-tab" data-tab="map" aria-selected="${state.tab === "map"}">🗺 Map</button>
        <button type="button" role="tab" class="dc-tab" data-tab="contacts" aria-selected="${state.tab === "contacts"}">👥 Contacts</button>
      </div>
      <div id="dcBody"></div>`;
    box.querySelectorAll(".dc-tab").forEach((b) =>
      b.addEventListener("click", () => {
        state.tab = b.dataset.tab;
        render();
      }),
    );
    destroyMap();
    ({ nearby: renderNearby, map: renderMap, contacts: renderContacts })[
      state.tab
    ]($("dcBody"));
  }

  const personRow = (p, sub, extra = "") => `
    <div class="dc-person" data-id="${esc(p.user_id)}">
      <span class="user-avatar">${esc((p.display_name || p.username || "?")[0].toUpperCase())}</span>
      <span class="dc-person-text"><strong>${esc(p.display_name || p.username)}</strong><small>@${esc(p.username)} · ${esc(sub)}</small></span>
      <span class="dc-person-actions">${extra}<button type="button" class="primary-btn dc-msg">Message</button></span>
    </div>`;
  function wirePeople(container, people, onSave) {
    container.querySelectorAll(".dc-person").forEach((row) => {
      const p = people.find((x) => x.user_id === row.dataset.id);
      row
        .querySelector(".dc-msg")
        .addEventListener("click", () =>
          app().startConversation({
            id: p.user_id,
            username: p.username,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
          }),
        );
      row
        .querySelector(".dc-save")
        ?.addEventListener("click", (e) => onSave?.(p, e.currentTarget));
    });
  }

  /* ----- nearby ----- */
  function renderNearby(body) {
    if (!state.settings.nearby_enabled) {
      body.innerHTML = `
        <div class="dc-card">
          <h3>Find people near you</h3>
          <p class="muted">Turn this on to see other ChatSpace users around you, and to let them see you.</p>
          <ul class="dc-points">
            <li>Only a <strong>rough area (about 2 km)</strong> is saved, never your exact spot.</li>
            <li>People only see an <strong>approximate distance</strong>. A map is separate and off unless you choose it in the Map tab.</li>
            <li>You only appear to people who have also turned it on.</li>
            <li>You can switch it off at any time and your location is deleted.</li>
          </ul>
          <button type="button" class="primary-btn full" id="dcNearbyOn">Turn on and find people</button>
          <p id="dcMsg" class="dc-error" role="status"></p>
        </div>`;
      $("dcNearbyOn").addEventListener("click", enableNearby);
      return;
    }
    body.innerHTML = `
      <div class="dc-row">
        <label for="dcRadius" class="muted">Within</label>
        <select id="dcRadius">${[5, 25, 100].map((k) => `<option value="${k}" ${k === state.radius ? "selected" : ""}>${k} km</option>`).join("")}</select>
        <button type="button" class="ghost-btn" id="dcRefresh">Refresh</button>
      </div>
      <div id="dcResults" class="dc-results"><p class="muted tiny">Looking…</p></div>
      <button type="button" class="ghost-btn danger full" id="dcNearbyOff">Turn off and delete my location</button>
      <p id="dcMsg" class="dc-error" role="status"></p>`;
    $("dcRadius").addEventListener("change", (e) => {
      state.radius = Number(e.target.value);
      runNearby(false);
    });
    $("dcRefresh").addEventListener("click", () => runNearby(true));
    $("dcNearbyOff").addEventListener("click", async (e) => {
      setBusy(e.currentTarget, true);
      try {
        await saveSettings(false, state.settings.phone_enabled);
        toast("Location sharing is off and your location was deleted.");
        render();
      } catch (err) {
        $("dcMsg").textContent = err.message;
        setBusy(e.currentTarget, false);
      }
    });
    runNearby(true);
  }

  const getPosition = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation)
        return reject(new Error("This browser can't share a location."));
      navigator.geolocation.getCurrentPosition(
        resolve,
        (err) =>
          reject(
            new Error(
              err.code === 1
                ? "Location permission was denied. Allow it in your browser's site settings and try again."
                : "Couldn't get your location. Try again.",
            ),
          ),
        {
          enableHighAccuracy: false,
          timeout: 15000,
          maximumAge: 10 * 60 * 1000,
        },
      );
    });

  async function enableNearby(e) {
    const btn = e.currentTarget;
    setBusy(btn, true, "Asking for your location…");
    try {
      await saveSettings(true, state.settings.phone_enabled);
      await shareLocation();
      render();
    } catch (err) {
      await saveSettings(false, state.settings.phone_enabled).catch(() => {});
      $("dcMsg").textContent = err.message;
      setBusy(btn, false, "Turn on and find people");
    }
  }
  async function shareLocation() {
    const pos = await getPosition();
    // Rounded on the phone first; the database rounds again to a 2 km square.
    await rpc("set_my_location", {
      lat_in: Math.round(pos.coords.latitude * 100) / 100,
      lng_in: Math.round(pos.coords.longitude * 100) / 100,
    });
  }
  let nearbyToken = 0;
  async function runNearby(refreshLocation) {
    const token = ++nearbyToken;
    const out = $("dcResults");
    if (!out) return;
    out.innerHTML = `<p class="muted tiny">Looking…</p>`;
    try {
      if (refreshLocation)
        await shareLocation().catch((err) => {
          if (/denied/i.test(err.message)) throw err;
        });
      const people = (await rpc("find_nearby", { max_km: state.radius })) || [];
      if (token !== nearbyToken || !$("dcResults")) return;
      if (!people.length) {
        out.innerHTML = `<p class="dc-empty">No one nearby yet.<br /><small>Only people who turned on "nearby" appear here. Try a wider distance, or invite friends.</small></p>`;
        return;
      }
      out.innerHTML = people
        .map((p) =>
          personRow(
            p,
            p.distance_km < 3
              ? "Less than 3 km away"
              : `About ${p.distance_km} km away`,
          ),
        )
        .join("");
      wirePeople(out, people);
    } catch (err) {
      if (token === nearbyToken && $("dcResults"))
        out.innerHTML = `<p class="dc-error">${esc(err.message)}</p>`;
    }
  }

  /* ----- map ----- */
  const LEAFLET = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist";
  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET + "/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = LEAFLET + "/leaflet.js";
      js.onload = resolve;
      js.onerror = () => {
        leafletPromise = null;
        reject(new Error("Couldn't load the map. Check your connection."));
      };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }
  function destroyMap() {
    mapToken++;
    if (state.map) {
      state.map.remove();
      state.map = null;
    }
  }
  let mapToken = 0;

  async function renderMap(body) {
    if (!state.settings.nearby_enabled) {
      body.innerHTML = `<div class="dc-card"><h3>Map</h3><p class="muted">Turn on Nearby first. After that you can choose to appear on the map.</p><button type="button" class="primary-btn full" id="dcMapGo">Go to Nearby</button></div>`;
      $("dcMapGo").addEventListener("click", () => {
        state.tab = "nearby";
        render();
      });
      return;
    }
    body.innerHTML = `<p class="muted tiny">Loading…</p>`;
    const { data, error } = await app()
      .supabase.from("discovery_settings")
      .select("map_visible")
      .eq("user_id", app().user.id)
      .maybeSingle();
    if (state.tab !== "map" || !$("dcBody")) return;
    if (error) {
      body.innerHTML = `<p class="dc-error">${esc(/does not exist|schema cache/i.test(error.message) ? "The map isn't set up yet. Run chatspace_discover_map.sql in Supabase." : error.message)}</p>`;
      return;
    }
    state.mapVisible = Boolean(data?.map_visible);
    if (!state.mapVisible) {
      body.innerHTML = `
        <div class="dc-card">
          <h3>Appear on the map</h3>
          <p class="muted">See nearby people on a map, and let them see you.</p>
          <ul class="dc-points">
            <li>You show as a <strong>circle about 2 km wide</strong>, never a pin on your exact spot.</li>
            <li>The map can't zoom in past city level, and it isn't live tracking.</li>
            <li>Only people who also chose to appear on the map can see you, and you see only them.</li>
            <li>Turn it off any time and you disappear from the map right away.</li>
          </ul>
          <button type="button" class="primary-btn full" id="dcMapOn">Show me on the map</button>
          <p id="dcMsg" class="dc-error" role="status"></p>
        </div>`;
      $("dcMapOn").addEventListener("click", async (e) => {
        setBusy(e.currentTarget, true, "Turning on…");
        try {
          await rpc("set_map_visibility", { visible: true });
          state.mapVisible = true;
          renderMap($("dcBody"));
        } catch (err) {
          $("dcMsg").textContent = err.message;
          setBusy(e.currentTarget, false, "Show me on the map");
        }
      });
      return;
    }
    body.innerHTML = `
      <div class="dc-row">
        <label for="dcRadius" class="muted">Within</label>
        <select id="dcRadius">${[5, 25, 100].map((k) => `<option value="${k}" ${k === state.radius ? "selected" : ""}>${k} km</option>`).join("")}</select>
        <button type="button" class="ghost-btn" id="dcRefresh">Refresh</button>
      </div>
      <div id="dcMap" class="dc-map"></div>
      <p id="dcMapNote" class="muted tiny" role="status">Looking…</p>
      <button type="button" class="ghost-btn danger full" id="dcMapOff">Hide me from the map</button>
      <p id="dcMsg" class="dc-error" role="status"></p>`;
    $("dcRadius").addEventListener("change", (e) => {
      state.radius = Number(e.target.value);
      runMap(false);
    });
    $("dcRefresh").addEventListener("click", () => runMap(true));
    $("dcMapOff").addEventListener("click", async (e) => {
      setBusy(e.currentTarget, true);
      try {
        await rpc("set_map_visibility", { visible: false });
        state.mapVisible = false;
        toast("You're hidden from the map.");
        render();
      } catch (err) {
        $("dcMsg").textContent = err.message;
        setBusy(e.currentTarget, false);
      }
    });
    runMap(true);
  }

  async function runMap(refreshLocation) {
    const token = ++mapToken;
    const note = $("dcMapNote");
    if (!note) return;
    note.className = "muted tiny";
    note.textContent = "Looking…";
    try {
      await loadLeaflet();
      if (refreshLocation)
        await shareLocation().catch((err) => {
          if (/denied/i.test(err.message)) throw err;
        });
      const rows =
        (await rpc("find_nearby_map", { max_km: state.radius })) || [];
      if (token !== mapToken || !$("dcMap")) return;
      drawMap(rows);
    } catch (err) {
      if (token !== mapToken || !$("dcMapNote")) return;
      $("dcMapNote").className = "dc-error";
      $("dcMapNote").textContent = err.message;
    }
  }

  function drawMap(rows) {
    if (state.map) {
      state.map.remove();
      state.map = null;
    }
    const L = window.L;
    const map = L.map("dcMap", { minZoom: 4, maxZoom: 15, zoomControl: true });
    state.map = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 15,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    // One circle per ~2 km area; everyone in that area is listed in its popup.
    const areas = new Map();
    for (const r of rows) {
      const key = r.lat.toFixed(3) + "," + r.lng.toFixed(3);
      if (!areas.has(key))
        areas.set(key, { lat: r.lat, lng: r.lng, people: [] });
      areas.get(key).people.push(r);
    }
    const layers = [];
    for (const a of areas.values()) {
      const mine = a.people.some((p) => p.is_me);
      const circle = L.circle([a.lat, a.lng], {
        radius: 1000,
        color: mine ? "#16a34a" : "#5d58db",
        weight: 2,
        fillOpacity: 0.25,
      }).addTo(map);
      const box = document.createElement("div");
      box.className = "dc-popup";
      for (const p of a.people) {
        const line = document.createElement("div");
        line.className = "dc-popup-row";
        const name = document.createElement("strong");
        name.textContent = p.is_me
          ? "You (approximate area)"
          : p.display_name || p.username;
        line.appendChild(name);
        if (!p.is_me) {
          const sub = document.createElement("small");
          sub.textContent =
            p.distance_km < 3
              ? "Less than 3 km away"
              : `About ${p.distance_km} km away`;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "primary-btn dc-msg";
          btn.textContent = "Message";
          btn.addEventListener("click", () =>
            app().startConversation({
              id: p.user_id,
              username: p.username,
              display_name: p.display_name,
              avatar_url: p.avatar_url,
            }),
          );
          line.append(sub, btn);
        }
        box.appendChild(line);
      }
      circle.bindPopup(box);
      layers.push(circle);
    }
    if (layers.length)
      map.fitBounds(L.featureGroup(layers).getBounds().pad(0.3), {
        maxZoom: 13,
      });
    else map.setView([9.08, 7.4], 5);
    setTimeout(() => map.invalidateSize(), 60);
    const others = rows.filter((r) => !r.is_me).length;
    const note = $("dcMapNote");
    note.className = "muted tiny";
    note.textContent = others
      ? `${others} ${others === 1 ? "person" : "people"} on the map. Circles are about 2 km wide. Tap one to see who's there.`
      : "No one else is on the map yet. Only people who chose to appear here are shown.";
  }

  /* ----- contacts ----- */
  function renderContacts(body) {
    if (!state.settings.phone_enabled) {
      body.innerHTML = `
        <div class="dc-card">
          <h3>Find friends from your contacts</h3>
          <p class="muted">See which of the people in your phone book already use ChatSpace, and let them find you too.</p>
          <ul class="dc-points">
            <li>Your number is stored only as a <strong>scrambled code</strong> nobody can read or list.</li>
            <li>Contacts you choose are checked once and <strong>not saved</strong> by ChatSpace.</li>
            <li>It's optional. Switch it off any time and your number is deleted.</li>
          </ul>
          <label for="dcCc">Your country code</label>
          <div class="dc-cc"><span>+</span><input id="dcCc" inputmode="numeric" maxlength="4" value="${esc(state.cc)}" /></div>
          <label for="dcMyPhone">Your phone number</label>
          <input id="dcMyPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 0801 234 5678" />
          <button type="button" class="primary-btn full" id="dcPhoneOn">Turn on</button>
          <p id="dcMsg" class="dc-error" role="status"></p>
        </div>`;
      $("dcPhoneOn").addEventListener("click", enablePhone);
      return;
    }
    const canPick = Boolean(navigator.contacts?.select);
    body.innerHTML = `
      <div class="dc-card">
        <h3>Check your contacts</h3>
        <p class="muted tiny">We only compare the numbers you choose, and don't keep them.</p>
        <div class="dc-actions">
          ${canPick ? `<button type="button" class="primary-btn" id="dcPick">Choose contacts</button>` : ""}
          <button type="button" class="${canPick ? "ghost-btn" : "primary-btn"}" id="dcVcf">Import a .vcf file</button>
          <input id="dcVcfInput" type="file" accept=".vcf,text/vcard,text/x-vcard" hidden />
        </div>
        ${canPick ? "" : `<p class="muted tiny">Tip: on iPhone, open Contacts, select people, tap Share, and save as a vCard file. On Android, "Choose contacts" works in Chrome.</p>`}
        <label for="dcNumbers">Or type numbers (one per line)</label>
        <textarea id="dcNumbers" rows="3" placeholder="0801 234 5678&#10;+44 7700 900123"></textarea>
        <button type="button" class="ghost-btn full" id="dcCheck">Check these numbers</button>
        <p id="dcMsg" class="dc-error" role="status"></p>
      </div>
      <div id="dcResults" class="dc-results"></div>
      <button type="button" class="ghost-btn danger full" id="dcPhoneOff">Turn off and delete my number</button>`;
    $("dcPick")?.addEventListener("click", pickContacts);
    $("dcVcf").addEventListener("click", () => $("dcVcfInput").click());
    $("dcVcfInput").addEventListener("change", importVcf);
    $("dcCheck").addEventListener("click", checkTyped);
    $("dcPhoneOff").addEventListener("click", async (e) => {
      setBusy(e.currentTarget, true);
      try {
        await saveSettings(state.settings.nearby_enabled, false);
        toast("Phone discovery is off and your number was deleted.");
        render();
      } catch (err) {
        $("dcMsg").textContent = err.message;
        setBusy(e.currentTarget, false);
      }
    });
  }

  async function enablePhone(e) {
    const btn = e.currentTarget;
    const cc = ($("dcCc").value || "").replace(/\D/g, "");
    const number = toE164($("dcMyPhone").value, cc);
    if (!cc)
      return ($("dcMsg").textContent = "Enter your country code, like 234.");
    if (!number)
      return ($("dcMsg").textContent = "That phone number doesn't look right.");
    state.cc = cc;
    localStorage.setItem("chatspace-cc", cc);
    setBusy(btn, true, "Turning on…");
    try {
      await saveSettings(state.settings.nearby_enabled, true);
      await rpc("set_my_phone", { phone_in: number });
      render();
    } catch (err) {
      await saveSettings(state.settings.nearby_enabled, false).catch(() => {});
      $("dcMsg").textContent = err.message;
      setBusy(btn, false, "Turn on");
    }
  }

  // contacts = [{ name, tel: [raw numbers] }]
  async function matchContacts(contacts) {
    const out = $("dcResults");
    const names = new Map(); // e164 -> contact name
    for (const c of contacts)
      for (const t of c.tel || []) {
        const n = toE164(t, state.cc);
        if (n && !names.has(n)) names.set(n, (c.name || "").trim());
      }
    const numbers = [...names.keys()];
    if (!numbers.length) {
      out.innerHTML = `<p class="dc-empty">No usable phone numbers found.</p>`;
      return;
    }
    out.innerHTML = `<p class="muted tiny">Checking ${numbers.length} number${numbers.length === 1 ? "" : "s"}…</p>`;
    try {
      const rows = [];
      for (let i = 0; i < numbers.length; i += 400)
        rows.push(
          ...((await rpc("match_phone_contacts", {
            numbers: numbers.slice(i, i + 400),
          })) || []),
        );
      // One row per person, with the name from your contacts.
      const byUser = new Map();
      for (const r of rows)
        if (!byUser.has(r.user_id))
          byUser.set(r.user_id, {
            ...r,
            contactName: names.get(r.matched_number) || "",
          });
      const people = [...byUser.values()];
      if (!people.length) {
        out.innerHTML = `<p class="dc-empty">None of these ${numbers.length} numbers are on ChatSpace yet.<br /><small>Invite them with your profile link.</small></p>`;
        return;
      }
      out.innerHTML =
        `<p class="tiny muted">${people.length} of your contacts ${people.length === 1 ? "is" : "are"} on ChatSpace. Numbers are not verified, so check it's really them.</p>` +
        people
          .map((p) =>
            personRow(
              { ...p, display_name: p.contactName || p.display_name },
              p.contactName
                ? `in your contacts as “${p.contactName}”`
                : "in your contacts",
              p.contactName && p.contactName !== (p.display_name || p.username)
                ? `<button type="button" class="ghost-btn dc-save">Save name</button>`
                : "",
            ),
          )
          .join("");
      wirePeople(out, people, async (p, btn) => {
        setBusy(btn, true);
        try {
          await app().saveContactName(p.user_id, p.contactName);
          btn.textContent = "Saved ✓";
        } catch (err) {
          toast(err.message);
          setBusy(btn, false);
        }
      });
    } catch (err) {
      out.innerHTML = `<p class="dc-error">${esc(err.message)}</p>`;
    }
  }

  async function pickContacts() {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], {
        multiple: true,
      });
      if (!picked.length) return;
      await matchContacts(
        picked.map((c) => ({
          name: (c.name || [])[0] || "",
          tel: c.tel || [],
        })),
      );
    } catch (err) {
      if (err?.name !== "AbortError")
        $("dcMsg").textContent = "Couldn't open your contacts.";
    }
  }
  async function importVcf(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024)
      return ($("dcMsg").textContent = "That file is too big.");
    const people = parseVcf(await file.text());
    if (!people.length)
      return ($("dcMsg").textContent =
        "No contacts with phone numbers were found in that file.");
    $("dcMsg").textContent = "";
    await matchContacts(people);
  }
  async function checkTyped() {
    const lines = $("dcNumbers")
      .value.split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length)
      return ($("dcMsg").textContent = "Type at least one number.");
    $("dcMsg").textContent = "";
    await matchContacts(lines.map((t) => ({ name: "", tel: [t] })));
  }

  /* ---------- entry point ---------- */
  document.addEventListener("click", (e) => {
    if (e.target.closest("#ncFindPeople")) {
      app().ncShow("ncDiscoverStep");
      show();
    }
  });
})();
