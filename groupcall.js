/* ChatSpace group calls (voice up to 6 people, video up to 4).
   Everyone connects directly to everyone else (no media server).
   The database (group_calls, group_call_members, group_call_signals and the
   start/invite/respond/leave functions) decides who may be in a call.
   app.js hands this file what it needs through CSGroupCall.init(api). */
(() => {
  const MAX = { voice: 6, video: 4 };
  let api = null;
  let started = false;
  let g = null; // the call I am in
  let invite = null; // an incoming invitation on screen
  let chanInvites = null,
    chanSignals = null,
    chanCalls = null,
    chanMembers = null;
  let bannerTimer = null,
    memberTimer = null,
    refreshDebounce = null;

  const $id = (x) => document.getElementById(x);
  const esc = (s) => api.escapeHtml(String(s ?? ""));
  const sb = () => api.supabase;
  const me = () => api.user()?.id;
  const nameOf = (m) =>
    api.peerName({
      id: m.user_id,
      display_name: m.display_name,
      username: m.username,
    });

  // ---------- start / stop ----------
  function init(apiObject) {
    api = apiObject;
  }
  function start() {
    if (started || !api || !me()) return;
    started = true;
    const id = me();
    chanInvites = sb()
      .channel("gc-invites-" + id)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "group_call_members",
          filter: `user_id=eq.${id}`,
        },
        (p) => onMyMembership(p.new),
      )
      .subscribe();
    chanSignals = sb()
      .channel("gc-signals-" + id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "group_call_signals",
          filter: `to_user=eq.${id}`,
        },
        (p) => onSignal(p.new),
      )
      .subscribe();
    chanCalls = sb()
      .channel("gc-calls-" + id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "group_calls" },
        () => refreshBanner(),
      )
      .subscribe();
    sb().rpc("purge_old_group_call_signals");
    bannerTimer = setInterval(() => !document.hidden && refreshBanner(), 15000);
  }
  async function stop() {
    started = false;
    clearInterval(bannerTimer);
    if (g) await leave("logout");
    dismissInvite(false);
    for (const c of [chanInvites, chanSignals, chanCalls])
      if (c) sb().removeChannel(c);
    chanInvites = chanSignals = chanCalls = null;
  }

  // ---------- starting and joining ----------
  async function startFromGroupChat(media) {
    const { conversationId, peer } = api.getActive();
    if (!peer?.isGroup || !conversationId) return;
    if (g || api.getOneToOne()) return api.toast("You're already in a call.");
    if (!navigator.onLine)
      return api.toast("Calls need an internet connection.");
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      return api.toast("Calls aren't supported in this browser.");
    let local;
    try {
      local = await api.getMedia(media);
    } catch (e) {
      return api.toast(api.mediaError(e));
    }
    const { data: id, error } = await sb().rpc("start_group_call", {
      target_conversation: conversationId,
      call_media: media,
      invite_ids: [],
    });
    if (error || !id) {
      local.getTracks().forEach((t) => t.stop());
      return api.toast(
        "Couldn't start the call: " + (error?.message || "try again"),
      );
    }
    // If the group already had a live call, join that one (it may be the other type).
    let actual = media;
    const { data: act } = await sb().rpc("get_active_group_call", {
      target_conversation: conversationId,
    });
    if (act?.[0]?.media) actual = act[0].media;
    if (actual !== media) {
      local.getTracks().forEach((t) => t.stop());
      try {
        local = await api.getMedia(actual);
      } catch (e) {
        return api.toast(api.mediaError(e));
      }
    }
    await joinCall({
      callId: id,
      media: actual,
      conversationId,
      local,
      started: true,
    });
  }

  async function joinCall({
    callId,
    media,
    conversationId,
    local,
    started: isStarter,
  }) {
    if (g) return;
    g = {
      id: callId,
      media,
      conversationId: conversationId || null,
      local: null,
      peers: new Map(),
      pending: new Map(), // connections being set up
      chain: new Map(), // messages from each person, handled in order
      members: new Map(),
      tiles: new Map(),
      startedAt: null,
      timer: null,
      aloneTimer: null,
      hadOthers: false,
      joinedAt: Date.now(),
      isStarter: Boolean(isStarter),
    };
    try {
      g.local = local || (await api.getMedia(media));
    } catch (e) {
      g = null;
      return api.toast(api.mediaError(e));
    }
    showScreen();
    const { data: joined, error } = await sb().rpc("respond_group_call", {
      target_call: callId,
      accept: true,
    });
    if (error) {
      api.toast(error.message || "Couldn't join the call.");
      return teardown();
    }
    subscribeMembers();
    await refreshMembers();
    // Whoever joins later makes the first move toward everyone already in the call.
    for (const row of joined || []) {
      g.hadOthers = true;
      connectTo(row.joined_user).catch((e) =>
        console.error("Group call connect:", e),
      );
    }
    g.aloneTimer = setInterval(checkAlone, 3000);
    refreshBanner();
  }

  function subscribeMembers() {
    chanMembers = sb()
      .channel("gc-members-" + g.id)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "group_call_members",
          filter: `call_id=eq.${g.id}`,
        },
        () => {
          clearTimeout(refreshDebounce);
          refreshDebounce = setTimeout(refreshMembers, 300);
        },
      )
      .subscribe();
    memberTimer = setInterval(refreshMembers, 8000);
  }

  async function refreshMembers() {
    if (!g) return;
    const { data, error } = await sb().rpc("get_group_call_members", {
      target_call: g.id,
    });
    if (error || !g) return;
    g.members = new Map((data || []).map((m) => [m.user_id, m]));
    for (const [uid, p] of [...g.peers]) {
      const m = g.members.get(uid);
      if (m && m.state !== "joined") closePeer(uid);
      if (m?.state === "joined") g.hadOthers = true;
    }
    renderTiles();
  }

  // ---------- connections between phones ----------
  function ensurePeer(userId) {
    const existing = g.peers.get(userId);
    if (existing) return Promise.resolve(existing);
    const waiting = g.pending.get(userId);
    if (waiting) return waiting;
    const task = (async () => {
      const iceServers = await api.getIceServers();
      if (!g) return null;
      const again = g.peers.get(userId);
      if (again) return again;
      const pc = new RTCPeerConnection({ iceServers });
      const p = {
        userId,
        pc,
        pendingIce: [],
        stream: null,
        status: "Connecting…",
        connectTimer: null,
      };
      g.peers.set(userId, p);
      g.local.getTracks().forEach((t) => pc.addTrack(t, g.local));
      pc.onicecandidate = (e) =>
        e.candidate && sendSignal(userId, "ice", e.candidate.toJSON());
      pc.ontrack = (e) => {
        p.stream = e.streams[0];
        renderTiles();
      };
      pc.onconnectionstatechange = () => {
        if (!g || g.peers.get(userId) !== p) return;
        const s = pc.connectionState;
        if (s === "connected") {
          clearTimeout(p.connectTimer);
          p.status = "";
          markConnected();
        } else if (s === "failed") p.status = "Connection lost";
        else if (s === "disconnected") p.status = "Reconnecting…";
        renderTiles();
      };
      p.connectTimer = setTimeout(() => {
        if (g?.peers.get(userId) === p && pc.connectionState !== "connected") {
          p.status = "Can't connect (network)";
          renderTiles();
        }
      }, 25000);
      renderTiles();
      return p;
    })();
    g.pending.set(userId, task);
    const clear = () =>
      g?.pending.get(userId) === task && g.pending.delete(userId);
    task.then(clear, clear);
    return task;
  }
  function closePeer(userId) {
    const p = g?.peers.get(userId);
    if (!p) return;
    clearTimeout(p.connectTimer);
    try {
      p.pc.close();
    } catch {}
    g.peers.delete(userId);
    renderTiles();
  }
  async function sendSignal(to, kind, payload) {
    if (!g) return;
    const { error } = await sb()
      .from("group_call_signals")
      .insert({ call_id: g.id, from_user: me(), to_user: to, kind, payload });
    if (error) console.error("Group call signal:", error.message);
  }
  async function connectTo(userId) {
    const p = await ensurePeer(userId);
    if (!p) return;
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    await sendSignal(userId, "offer", { type: offer.type, sdp: offer.sdp });
  }
  async function flushIce(p) {
    for (const c of p.pendingIce.splice(0)) {
      try {
        await p.pc.addIceCandidate(c);
      } catch {}
    }
  }
  function onSignal(row) {
    if (!g || row.call_id !== g.id) return;
    if (Date.now() - new Date(row.created_at) > 90000) return;
    const last = g.chain.get(row.from_user) || Promise.resolve();
    g.chain.set(
      row.from_user,
      last
        .then(() => handleSignal(row))
        .catch((e) => console.error("Group call:", e)),
    );
  }
  async function handleSignal(row) {
    if (!g || row.call_id !== g.id) return;
    try {
      if (row.kind === "offer") {
        let p = g.peers.get(row.from_user);
        if (p && (p.pc.remoteDescription || p.pc.signalingState !== "stable")) {
          closePeer(row.from_user); // they came back: start fresh
          p = null;
        }
        p = p || (await ensurePeer(row.from_user));
        if (!p) return;
        await p.pc.setRemoteDescription(row.payload);
        await flushIce(p);
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        await sendSignal(row.from_user, "answer", {
          type: answer.type,
          sdp: answer.sdp,
        });
      } else if (row.kind === "answer") {
        const p = g.peers.get(row.from_user);
        if (p && p.pc.signalingState === "have-local-offer") {
          await p.pc.setRemoteDescription(row.payload);
          await flushIce(p);
        }
      } else if (row.kind === "ice") {
        const p =
          g.peers.get(row.from_user) || (await ensurePeer(row.from_user));
        if (!p) return;
        if (p.pc.remoteDescription)
          await p.pc.addIceCandidate(row.payload).catch(() => {});
        else p.pendingIce.push(row.payload);
      }
    } catch (err) {
      console.error("Group call error:", err);
    }
  }
  function markConnected() {
    if (g.startedAt) return;
    g.startedAt = Date.now();
    g.timer = setInterval(updateStatus, 1000);
    updateStatus();
  }
  function checkAlone() {
    if (!g) return;
    const others = [...g.members.values()].filter(
      (m) => m.user_id !== me() && m.state === "joined",
    ).length;
    if (others > 0) {
      g.aloneSince = null;
      return;
    }
    g.aloneSince = g.aloneSince || Date.now();
    const limit = g.hadOthers ? 20000 : 60000;
    if (Date.now() - g.aloneSince > limit) {
      api.toast(
        g.hadOthers
          ? "Everyone else has left the call."
          : "No one joined the call.",
      );
      leave("alone");
    }
  }

  // ---------- the call screen ----------
  function titleOfCall() {
    if (g.conversationId) {
      const peer = api
        .getPeers()
        .find((p) => p.conversationId === g.conversationId);
      if (peer)
        return peer.preferences?.is_locked ? "Group call" : api.peerName(peer);
    }
    return "Group call";
  }
  function showScreen() {
    $id("incomingCall")?.remove();
    $id("groupCallScreen")?.remove();
    const el = document.createElement("div");
    el.id = "groupCallScreen";
    el.className = "gc-screen " + (g.media === "video" ? "video" : "voice");
    el.innerHTML = `
      <div class="gc-top">
        <strong id="gcTitle"></strong>
        <span id="gcStatus" class="gc-status">Connecting…</span>
      </div>
      <div id="gcGrid" class="gc-grid"></div>
      <div class="gc-controls">
        <button type="button" id="gcMute" class="call-btn" aria-label="Mute microphone">${CSIcons.icon("mic", 24)}</button>
        <button type="button" id="gcCam" class="call-btn ${g.media === "video" ? "" : "hidden"}" aria-label="Turn camera off">${CSIcons.icon("camera", 24)}</button>
        <button type="button" id="gcAdd" class="call-btn" aria-label="Add people">${CSIcons.icon("plus", 24)}</button>
        <button type="button" id="gcLeave" class="call-btn end" aria-label="Leave call">${CSIcons.icon("phoneEnd", 26)}</button>
      </div>`;
    document.body.appendChild(el);
    $id("gcTitle").textContent = titleOfCall();
    $id("gcLeave").onclick = () => leave("hangup");
    $id("gcMute").onclick = () => {
      const t = g.local.getAudioTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      CSIcons.setIcon($id("gcMute"), t.enabled ? "mic" : "micOff", 24);
      $id("gcMute").classList.toggle("off", !t.enabled);
    };
    $id("gcCam").onclick = () => {
      const t = g.local.getVideoTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      $id("gcCam").classList.toggle("off", !t.enabled);
      renderTiles();
    };
    $id("gcAdd").onclick = () =>
      openPicker({
        title: "Add to call",
        exclude: new Set(),
        room: roomLeft(),
        onPick: addPeople,
      });
    renderTiles();
  }
  const roomLeft = () => {
    const taken = [...g.members.values()].filter(
      (m) => m.state === "joined" || m.state === "invited",
    ).length;
    return Math.max(0, MAX[g.media] - Math.max(taken, 1));
  };
  function updateStatus() {
    const el = $id("gcStatus");
    if (!el || !g) return;
    const inCall =
      1 +
      [...g.members.values()].filter(
        (m) => m.user_id !== me() && m.state === "joined",
      ).length;
    const time = g.startedAt
      ? api.fmtDuration(Math.floor((Date.now() - g.startedAt) / 1000))
      : "Connecting…";
    el.textContent = `${time} · ${inCall} in call`;
  }

  function tileFor(userId) {
    let t = g.tiles.get(userId);
    if (t) return t;
    const el = document.createElement("div");
    el.className = "gc-tile";
    el.innerHTML = `<video autoplay playsinline></video>
      <div class="gc-avatar user-avatar xl"></div>
      <div class="gc-label"><span class="gc-name"></span><small class="gc-state"></small></div>`;
    $id("gcGrid").appendChild(el);
    t = {
      el,
      video: el.querySelector("video"),
      avatar: el.querySelector(".gc-avatar"),
      name: el.querySelector(".gc-name"),
      state: el.querySelector(".gc-state"),
    };
    g.tiles.set(userId, t);
    return t;
  }
  function renderTiles() {
    if (!g || !$id("gcGrid")) return;
    const ids = [me()];
    for (const m of g.members.values())
      if (m.user_id !== me() && (m.state === "joined" || m.state === "invited"))
        ids.push(m.user_id);
    for (const uid of g.peers.keys()) if (!ids.includes(uid)) ids.push(uid);

    for (const [uid, t] of [...g.tiles]) {
      if (!ids.includes(uid)) {
        t.el.remove();
        g.tiles.delete(uid);
      }
    }
    for (const uid of ids) {
      const t = tileFor(uid);
      const isMe = uid === me();
      const m = g.members.get(uid);
      const p = g.peers.get(uid);
      const who = m || { user_id: uid };
      t.name.textContent = isMe ? "You" : m ? nameOf(m) : "Member";
      t.el.classList.toggle("me", isMe);
      if (m)
        api.setAvatar(t.avatar, {
          id: uid,
          display_name: m.display_name,
          username: m.username,
          avatar_url: m.avatar_url,
        });
      let state = "";
      if (!isMe) {
        if (m?.state === "invited") state = "Ringing…";
        else state = p ? p.status : "Connecting…";
      }
      t.state.textContent = state;
      const stream = isMe ? g.local : p?.stream;
      if (stream && t.video.srcObject !== stream) {
        t.video.srcObject = stream;
        t.video.muted = isMe;
        t.video.play?.().catch(() => {});
      }
      const hasVideo =
        g.media === "video" &&
        stream &&
        stream.getVideoTracks().some((x) => x.enabled);
      t.el.classList.toggle("has-video", Boolean(hasVideo));
      void who;
    }
    const n = ids.length;
    $id("gcGrid").dataset.count = String(Math.min(n, 6));
    updateStatus();
  }

  // ---------- adding people ----------
  async function addPeople(userIds) {
    if (!g || !userIds.length) return;
    const { error } = await sb().rpc("invite_to_group_call", {
      target_call: g.id,
      user_ids: userIds,
    });
    if (error) return api.toast(error.message || "Couldn't add them.");
    api.toast(userIds.length === 1 ? "Invited. Ringing…" : "Invited. Ringing…");
    refreshMembers();
  }

  async function candidates(excludeIds) {
    const out = new Map();
    const add = (id, name, p) => {
      if (!id || id === me() || excludeIds.has(id) || api.isBlocked(id)) return;
      if (!out.has(id)) out.set(id, { id, name, p });
    };
    if (g?.conversationId) {
      const { data } = await sb().rpc("get_group_members", {
        target_conversation_id: g.conversationId,
      });
      for (const m of data || []) add(m.user_id, nameOf(m), m);
    }
    for (const peer of api.getPeers())
      if (
        !peer.isGroup &&
        !peer.preferences?.is_locked &&
        !peer.preferences?.is_deleted
      )
        add(peer.id, api.peerName(peer), peer);
    return [...out.values()];
  }

  async function openPicker({ title, exclude, room, onPick }) {
    if (room <= 0) return api.toast("This call is full.");
    document.querySelectorAll(".gc-picker-backdrop").forEach((n) => n.remove());
    const taken = new Set(exclude);
    if (g)
      for (const m of g.members.values())
        if (m.state === "joined" || m.state === "invited") taken.add(m.user_id);
    const list = await candidates(taken);
    const box = document.createElement("div");
    box.className = "gc-picker-backdrop";
    box.innerHTML = `<div class="gc-picker" role="dialog" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <p class="tiny muted">Room for ${room} more. Voice calls hold 6 people, video calls 4.</p>
        <div class="gc-picker-list"></div>
        <div class="gc-picker-actions">
          <button type="button" class="ghost-btn" data-act="cancel">Cancel</button>
          <button type="button" class="primary-btn" data-act="add" disabled>Add</button>
        </div>
      </div>`;
    const listEl = box.querySelector(".gc-picker-list");
    if (!list.length)
      listEl.innerHTML =
        '<p class="muted">Nobody else to add. People you chat with privately can be added.</p>';
    for (const c of list) {
      const row = document.createElement("label");
      row.className = "gc-pick";
      row.innerHTML = `<input type="checkbox" value="${esc(c.id)}" /><span class="user-avatar"></span><span class="gc-pick-name">${esc(c.name)}</span>`;
      api.setAvatar(row.querySelector(".user-avatar"), c.p);
      listEl.appendChild(row);
    }
    const addBtn = box.querySelector('[data-act="add"]');
    const sync = () => {
      const picked = [...box.querySelectorAll("input:checked")];
      box
        .querySelectorAll("input:not(:checked)")
        .forEach((i) => (i.disabled = picked.length >= room));
      addBtn.disabled = picked.length === 0;
      addBtn.textContent = picked.length ? `Add ${picked.length}` : "Add";
    };
    box.addEventListener("change", sync);
    box.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === box || act === "cancel") return box.remove();
      if (act === "add") {
        const ids = [...box.querySelectorAll("input:checked")].map(
          (i) => i.value,
        );
        box.remove();
        onPick(ids);
      }
    });
    document.body.appendChild(box);
  }

  // ---------- turning a one-to-one call into a group call ----------
  async function upgradeFromOneToOne() {
    const one = api.getOneToOne();
    if (!one || g) return;
    if (one.state !== "connected")
      return api.toast("Wait until the call connects, then add someone.");
    openPicker({
      title: "Add to this call",
      exclude: new Set([one.peerId]),
      room: MAX[one.media] - 2,
      onPick: async (ids) => {
        const cur = api.getOneToOne();
        if (!cur) return;
        const { data: id, error } = await sb().rpc("start_group_call", {
          target_conversation: null,
          call_media: cur.media,
          invite_ids: [cur.peerId, ...ids],
        });
        if (error || !id)
          return api.toast(
            "Couldn't add them: " + (error?.message || "try again"),
          );
        const media = cur.media;
        // Keep my microphone/camera running while the call moves over.
        const stream = api.takeOneToOneStream(true);
        await joinCall({
          callId: id,
          media,
          conversationId: null,
          local: stream,
          started: true,
        });
      },
    });
  }

  // ---------- incoming invitations ----------
  async function onMyMembership(row) {
    if (!row) return;
    if (row.state !== "invited") {
      if (invite && invite.callId === row.call_id) dismissInvite(true);
      return;
    }
    if (g && g.id === row.call_id) return;
    if (invite && invite.callId === row.call_id) return;
    if (Date.now() - new Date(row.updated_at) > 60000) return;
    await showIncoming(row);
  }

  async function showIncoming(row) {
    const { data: call } = await sb()
      .from("group_calls")
      .select("id,conversation_id,started_by,media,ended_at")
      .eq("id", row.call_id)
      .maybeSingle();
    if (!call || call.ended_at) return;
    const media = call.media === "video" ? "video" : "voice";

    // Someone I'm talking with added more people: move over without ringing.
    const one = api.getOneToOne();
    const recent = api.lastOneToOneEnd();
    const fromCurrentPartner =
      (one && one.peerId === row.invited_by) ||
      (!one &&
        recent &&
        recent.peerId === row.invited_by &&
        Date.now() - recent.at < 10000);
    if (!g && fromCurrentPartner) {
      const stream = one ? api.takeOneToOneStream(false) : null;
      return joinCall({
        callId: call.id,
        media,
        conversationId: call.conversation_id,
        local: stream,
      });
    }
    if (g || one || invite) {
      sb().rpc("respond_group_call", { target_call: call.id, accept: false }); // busy
      return;
    }

    const { data: members } = await sb().rpc("get_group_call_members", {
      target_call: call.id,
    });
    const by =
      (members || []).find((m) => m.user_id === row.invited_by) ||
      (members || []).find((m) => m.user_id === call.started_by);
    const byName = by ? nameOf(by) : "Someone";
    const peer = call.conversation_id
      ? api.getPeers().find((p) => p.conversationId === call.conversation_id)
      : null;
    const locked = peer?.preferences?.is_locked;
    const title = locked ? "Someone" : peer ? api.peerName(peer) : byName;
    const sub = locked
      ? `Incoming group ${media} call…`
      : peer
        ? `${byName} started a group ${media} call`
        : `${byName} added you to a ${media} call`;

    const box = document.createElement("div");
    box.id = "incomingCall";
    box.className = "incoming-call";
    box.innerHTML = `<div class="user-avatar xl" id="gcIncomingAvatar"></div>
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(sub)}</p>
      <div class="call-controls">
        <button type="button" class="call-btn end" id="gcDecline" aria-label="Decline">✕</button>
        <button type="button" class="call-btn accept" id="gcAccept" aria-label="Join">✓</button>
      </div>`;
    document.body.appendChild(box);
    api.setAvatar(
      $id("gcIncomingAvatar"),
      peer ||
        (by
          ? {
              id: by.user_id,
              display_name: by.display_name,
              username: by.username,
              avatar_url: by.avatar_url,
            }
          : { username: "?" }),
    );
    invite = {
      callId: call.id,
      media,
      conversationId: call.conversation_id,
      el: box,
      timeout: setTimeout(() => dismissInvite(true), 45000),
    };
    api.startRing();
    $id("gcDecline").onclick = async () => {
      const id = invite?.callId;
      dismissInvite(true);
      if (id)
        sb().rpc("respond_group_call", { target_call: id, accept: false });
    };
    $id("gcAccept").onclick = async () => {
      const i = invite;
      dismissInvite(true);
      if (i)
        joinCall({
          callId: i.callId,
          media: i.media,
          conversationId: i.conversationId,
        });
    };
    if (
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    )
      navigator.serviceWorker?.ready
        .then((reg) =>
          reg.showNotification("Incoming group call", {
            body: title,
            tag: "call",
            requireInteraction: true,
            icon: "/icons/icon-192.png",
          }),
        )
        .catch(() => {});
  }
  function dismissInvite() {
    if (!invite) return;
    clearTimeout(invite.timeout);
    invite.el.remove();
    invite = null;
    api.stopRing();
  }

  // ---------- "Join call" bar inside a group chat ----------
  async function refreshBanner() {
    if (!api || !me()) return;
    let el = $id("gcBanner");
    const { conversationId, peer } = api.getActive();
    if (
      !peer?.isGroup ||
      !conversationId ||
      (g && g.conversationId === conversationId)
    )
      return el?.classList.add("hidden");
    if (!el) {
      el = document.createElement("div");
      el.id = "gcBanner";
      el.className = "gc-banner hidden";
      const anchor = $id("messages");
      anchor.parentNode.insertBefore(el, anchor);
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) joinFromBanner();
      });
    }
    const { data } = await sb().rpc("get_active_group_call", {
      target_conversation: conversationId,
    });
    const now = api.getActive();
    if (now.conversationId !== conversationId) return;
    const row = data?.[0];
    if (!row || g) return el.classList.add("hidden");
    el.dataset.call = row.call_id;
    el.dataset.media = row.media;
    el.dataset.conv = conversationId;
    el.innerHTML = `<span>📞 ${row.media === "video" ? "Video" : "Voice"} call in progress · ${row.joined_count} in call</span><button type="button" class="primary-btn">Join</button>`;
    el.classList.remove("hidden");
  }
  async function joinFromBanner() {
    const el = $id("gcBanner");
    if (!el?.dataset.call || g || api.getOneToOne())
      return api.toast("You're already in a call.");
    el.classList.add("hidden");
    await joinCall({
      callId: el.dataset.call,
      media: el.dataset.media,
      conversationId: el.dataset.conv,
    });
  }

  // ---------- leaving ----------
  function teardown() {
    const c = g;
    if (!c) return;
    g = null;
    clearInterval(c.timer);
    clearInterval(c.aloneTimer);
    clearInterval(memberTimer);
    clearTimeout(refreshDebounce);
    for (const p of c.peers.values()) {
      clearTimeout(p.connectTimer);
      try {
        p.pc.close();
      } catch {}
    }
    c.local?.getTracks().forEach((t) => t.stop());
    if (chanMembers) sb().removeChannel(chanMembers);
    chanMembers = null;
    $id("groupCallScreen")?.remove();
    return c;
  }
  async function leave(reason) {
    const c = g;
    if (!c) return;
    const seconds = c.startedAt
      ? Math.floor((Date.now() - c.startedAt) / 1000)
      : 0;
    teardown();
    if (reason !== "logout") {
      await sb().rpc("leave_group_call", { target_call: c.id });
      // The person who started a group-chat call leaves a line in the chat.
      if (c.isStarter && c.conversationId && reason !== "alone") {
        const kind = c.media === "video" ? "video" : "voice";
        const label = c.startedAt
          ? `📞 group ${kind} call · ${api.fmtDuration(seconds)}`
          : `📞 Missed group ${kind} call`;
        await api.insertCallNote(c.conversationId, label);
      }
    } else sb().rpc("leave_group_call", { target_call: c.id });
    refreshBanner();
  }

  window.CSGroupCall = {
    init,
    start,
    stop,
    startFromGroupChat,
    upgradeFromOneToOne,
    refreshBanner,
    inCall: () => Boolean(g),
    debugStats: async () => {
      const out = [];
      for (const [u, p] of g?.peers || []) {
        const st = await p.pc.getStats();
        const pairs = [],
          locals = [],
          remotes = [];
        st.forEach((r) => {
          if (r.type === "candidate-pair")
            pairs.push(r.state + (r.nominated ? "*" : ""));
          if (r.type === "local-candidate")
            locals.push(r.candidateType + ":" + r.protocol);
          if (r.type === "remote-candidate")
            remotes.push(r.candidateType + ":" + r.protocol);
        });
        out.push({
          u: u.slice(0, 6),
          dtls: p.pc.sctp ? "" : "",
          pairs,
          locals,
          remotes,
          sig: p.pc.signalingState,
          pend: p.pendingIce.length,
        });
      }
      return out;
    },
    // Handy when checking why a call will not connect.
    debug: () =>
      g
        ? [...g.peers].map(([u, p]) => [
            u.slice(0, 6),
            p.pc.connectionState,
            p.pc.iceConnectionState,
          ])
        : [],
  };
})();
