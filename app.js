(() => {
  const cfg = window.CHATSPACE_CONFIG || {};
  const configReady =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_URL.includes("PASTE_") &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");
  const $ = (id) => document.getElementById(id);
  const authScreen = $("authScreen"),
    appScreen = $("appScreen");
  let supabase, currentUser, currentProfile, activePeer, activeConversation;

  let replyingToMessage = null;
  const messageCache = new Map();
  let isSignup = false,
    selectedFile = null,
    mediaRecorder = null,
    recordingChunks = [],
    realtimeChannel = null,
    showingArchivedChats = false;
  const reactionCache = new Map();

  const REACTION_EMOJIS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];

  let reactionsChannel = null;
  let reactionRequestNumber = 0;
  const SUPPORT_USERNAME = "cyber-ace";
  const usernameEmail = (name) =>
    `${name.toLowerCase()}@users.chatspace.invalid`;
  const cleanUsername = (name) => name.trim().toLowerCase();
  const validUsername = (name) => /^[a-z0-9_-]{3,24}$/.test(name);
  const SUPA_ORIGIN = (() => {
    try {
      return new URL(cfg.SUPABASE_URL).origin;
    } catch {
      return "";
    }
  })();
  const okAvatar = (u) => {
    try {
      return new URL(u).origin === SUPA_ORIGIN ? u : null;
    } catch {
      return null;
    }
  };
  const escapeHtml = (s) =>
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
  const avatarInner = (p) =>
    okAvatar(p.avatar_url)
      ? `<img src="${escapeHtml(p.avatar_url)}" alt="" />`
      : escapeHtml((peerName(p)[0] || "?").toUpperCase());
  const peerName = (p) => p.display_name || p.username;
  function setAvatar(el, p) {
    el.innerHTML = okAvatar(p.avatar_url)
      ? `<img src="${escapeHtml(p.avatar_url)}" alt="" />`
      : escapeHtml((peerName(p)[0] || "?").toUpperCase());
  }
  let listChannel = null,
    listTimer = null;
  function watchChatList() {
    if (listChannel) return;
    listChannel = supabase
      .channel("chat-list")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          if (payload.new.sender_id !== currentUser.id)
            notifyIncoming(payload.new);
          if (payload.new.conversation_id === activeConversation) return;
          clearTimeout(listTimer);
          listTimer = setTimeout(loadChats, 400);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_participants",
          filter: `user_id=eq.${currentUser.id}`,
        },
        () => loadChats(),
      )
      .subscribe();
  }
  async function markRead() {
    if (!activeConversation) return;
    await supabase.rpc("mark_conversation_read", {
      target_conversation_id: activeConversation,
    });
    loadChats();
  }
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function authMessage(msg, error = false) {
    $("authMessage").textContent = msg;
    $("authMessage").classList.toggle("error", error);
  }
  function showAuth() {
    document.getElementById("splash")?.classList.add("hidden");
    authScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
  }
  function showApp() {
    document.getElementById("splash")?.classList.add("hidden");
    authScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
  }
  function setAuthMode(signup) {
    isSignup = signup;
    $("loginTab").classList.toggle("active", !signup);
    $("signupTab").classList.toggle("active", signup);
    $("authSubmit").textContent = signup ? "Create account" : "Log in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    authMessage(
      signup ? "Username: 3–24 letters, numbers, or underscores." : "",
    );
  }
  $("loginTab").addEventListener("click", () => setAuthMode(false));
  $("signupTab").addEventListener("click", () => setAuthMode(true));

  async function handleAuth(e) {
    e.preventDefault();
    if (!configReady) {
      authMessage(
        "First add your Supabase URL and publishable key to config.js.",
        true,
      );
      return;
    }
    const username = cleanUsername($("username").value),
      password = $("password").value;
    if (!validUsername(username)) {
      authMessage(
        "Username must be 3–24 characters using letters, numbers, or underscores.",
        true,
      );
      return;
    }
    if (password.length < 8) {
      authMessage("Use a password with at least 8 characters.", true);
      return;
    }
    $("authSubmit").disabled = true;
    authMessage(isSignup ? "Creating your account..." : "Logging in...");
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: usernameEmail(username),
          password,
          options: { data: { username } },
        });
        if (error) throw error;
        if (!data.session || !data.user) {
          authMessage(
            "Account request received. If email confirmation is still required, disable it in Supabase Auth settings and try again.",
            true,
          );
          return;
        }
        const { error: profileError } = await supabase
          .from("profiles")
          .insert({ id: data.user.id, username });
        if (profileError && profileError.code !== "23505") throw profileError;
        currentUser = data.user;
        await loadCurrentProfile();
        showApp();
        await loadChats();
        flushOutbox();
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: usernameEmail(username),
          password,
        });
        if (error)
          throw new Error("Login failed. Check your username and password.");
        currentUser = data.user;
        await loadCurrentProfile();
        showApp();
        await loadChats();
      }
    } catch (err) {
      authMessage(
        err.message || "Something went wrong. Please try again.",
        true,
      );
    } finally {
      $("authSubmit").disabled = false;
    }
  }
  $("authForm").addEventListener("submit", handleAuth);

  async function loadCurrentProfile() {
    let { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .maybeSingle();
    if (error) {
      const saved = cacheGet("profile");
      if (!saved || saved.id !== currentUser.id) throw error;
      data = saved;
    } else if (data) cacheSet("profile", data);
    if (!data) {
      const name = currentUser.user_metadata?.username;
      if (!name)
        throw new Error(
          "Your profile is missing. Please contact the site owner.",
        );
      const { data: inserted, error: insertError } = await supabase
        .from("profiles")
        .insert({ id: currentUser.id, username: name })
        .select()
        .single();
      if (insertError) throw insertError;
      currentProfile = inserted;
    } else currentProfile = data;
    $("myUsername").textContent = peerName(currentProfile);
    setAvatar($("myAvatar"), currentProfile);
    loadAppearance();
  }

  async function getChatPreferences(conversationIds) {
    if (!conversationIds.length) return new Map();

    const { data, error } = await supabase
      .from("chat_preferences")
      .select(
        "conversation_id,is_pinned,is_archived,is_deleted,is_muted,is_locked,wallpaper",
      )
      .eq("user_id", currentUser.id)
      .in("conversation_id", conversationIds);

    if (error && cacheGet("prefs")) {
      return new Map(
        cacheGet("prefs").map((item) => [item.conversation_id, item]),
      );
    }
    if (!error) cacheSet("prefs", data || []);
    if (error) {
      console.error("Chat preferences:", error.message);
      toast("Couldn't load chat settings: " + error.message);
      return new Map();
    }

    return new Map((data || []).map((item) => [item.conversation_id, item]));
  }

  async function saveChatPreference(conversationId, changes) {
    const { data: existing, error: readError } = await supabase
      .from("chat_preferences")
      .select("conversation_id")
      .eq("user_id", currentUser.id)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (readError) throw readError;

    if (existing) {
      const { data: updated, error } = await supabase
        .from("chat_preferences")
        .update({
          ...changes,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", currentUser.id)
        .eq("conversation_id", conversationId)
        .select("conversation_id");

      if (error) throw error;
      if (!updated?.length)
        throw new Error("The database blocked this change (permissions).");
    } else {
      const { error } = await supabase.from("chat_preferences").insert({
        user_id: currentUser.id,
        conversation_id: conversationId,
        ...changes,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;
    }
  }

  async function loadChats() {
    let { data: rows, error } = await supabase.rpc("get_my_chats");
    if (error) {
      const saved = cacheGet("chats");
      if (saved) {
        rows = saved;
        error = null;
      }
    } else cacheSet("chats", rows);
    if (error) {
      toast("Couldn't load chats: " + error.message);
      return;
    }

    const peers = (rows || [])
      .filter((r) => r.is_group || r.peer_id)
      .map((r) => ({
        isGroup: Boolean(r.is_group),
        id: r.is_group ? "group:" + r.conversation_id : r.peer_id,
        username: r.is_group ? r.group_name : r.peer_username,
        display_name: r.is_group ? r.group_name : r.peer_display_name,
        avatar_url: r.is_group ? r.group_avatar_url : r.peer_avatar_url,
        conversationId: r.conversation_id,
        lastMessage: r.last_message,
        lastFromMe: r.last_message_sender === currentUser.id,
        unread: Number(r.unread_count) || 0,
        latestTime: r.last_message_at
          ? new Date(r.last_message_at).getTime()
          : 0,
      }));
    const preferences = await getChatPreferences(
      peers.map((p) => p.conversationId),
    );
    watchChatList();
    await loadBlocks();

    const allPeers = peers
      .map((peer) => ({
        ...peer,
        preferences: preferences.get(peer.conversationId) || {},
      }))
      .filter((peer) => !peer.preferences.is_deleted)
      .sort((a, b) => {
        const pinDifference =
          Number(Boolean(b.preferences.is_pinned)) -
          Number(Boolean(a.preferences.is_pinned));

        if (pinDifference !== 0) return pinDifference;

        return (
          b.latestTime - a.latestTime || a.username.localeCompare(b.username)
        );
      });

    lastPeers = allPeers;
    const recentPeers = allPeers.filter(
      (peer) => !peer.preferences.is_archived && !peer.preferences.is_locked,
    );

    const archivedPeers = allPeers.filter(
      (peer) => peer.preferences.is_archived && !peer.preferences.is_locked,
    );
    const lockedPeers = allPeers.filter((peer) => peer.preferences.is_locked);

    $("archivedCount").textContent = archivedPeers.length;
    $("archivedCount").classList.toggle("hidden", archivedPeers.length === 0);

    renderChatList(
      $("chatList"),
      recentPeers,
      "Your chats will appear here. Search for a username above to start one.",
    );

    renderChatList(
      $("archivedChatList"),
      archivedPeers,
      "You have no archived chats.",
    );

    $("lockedDot").classList.toggle(
      "hidden",
      !lockedPeers.some((p) => p.unread),
    );
    if (lockUnlocked || !appSettings.chat_lock_hash)
      renderChatList(
        $("lockedChatList"),
        lockedPeers,
        "Chats you lock appear here. Open a chat's ⋮ menu and choose Lock chat.",
      );
    else
      $("lockedChatList").innerHTML =
        '<p class="tiny muted" style="padding:8px">🔒 Tap the Locked tab and enter your PIN to see these chats.</p>';

    setListView(
      showingLocked ? "locked" : showingArchivedChats ? "archived" : "recent",
    );
  }

  function renderChatList(list, peers, emptyMessage) {
    list.innerHTML = "";

    if (!peers.length) {
      list.innerHTML = `
        <p class="tiny muted" style="padding:8px">
          ${escapeHtml(emptyMessage)}
        </p>
      `;
      return;
    }

    for (const peer of peers) {
      const prefs = peer.preferences || {};

      const item = document.createElement("div");

      item.className =
        "chat-item" +
        (activeConversation === peer.conversationId ? " active" : "");

      item.dataset.conversationId = peer.conversationId;
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");

      const markers = [prefs.is_pinned ? "📌" : "", prefs.is_muted ? "🔕" : ""]
        .filter(Boolean)
        .join(" ");

      const preview = peer.lastMessage
        ? (peer.lastFromMe ? "You: " : "") + peer.lastMessage
        : "Say hello 👋";
      item.innerHTML = `
        <span class="user-avatar">${avatarInner(peer)}${isOnline(peer.id) ? `<i class="online-dot"></i>` : ""}</span>

        <span class="chat-item-details">
          <strong>
            ${escapeHtml(peerName(peer))} ${markers}
          </strong>

          <small>
            ${escapeHtml(preview)}
          </small>
        </span>

        ${peer.unread ? `<span class="unread-badge">${peer.unread > 99 ? "99+" : peer.unread}</span>` : ""}

        <button type="button" class="chat-menu-trigger"
          aria-label="Chat options"
          title="Chat options"
        >⋮</button>
      `;

      item.addEventListener("click", (event) => {
        if (event.target.closest(".chat-menu-trigger")) {
          event.stopPropagation();
          showChatMenu(peer, item);
          return;
        }

        openConversation(peer, peer.conversationId);
      });

      item.addEventListener("keydown", (event) => {
        if (
          event.target === item &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          openConversation(peer, peer.conversationId);
        }
      });

      list.appendChild(item);
    }
  }

  function showChatMenu(peer, anchor) {
    document
      .querySelectorAll(".chat-context-menu, .chat-menu-backdrop")
      .forEach((n) => n.remove());

    const prefs = peer.preferences || {};

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    const backdrop = document.createElement("div");
    backdrop.className = "chat-menu-backdrop";
    const close = () => {
      menu.remove();
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();

    const actions = [
      [prefs.is_pinned ? "Unpin chat" : "Pin chat", "pin"],
      [prefs.is_archived ? "Restore chat" : "Archive chat", "archive"],
      [prefs.is_muted ? "Unmute chat" : "Mute chat", "mute"],
      peer.isGroup
        ? ["Leave group", "leave"]
        : [blockedIds.has(peer.id) ? "Unblock user" : "Block user", "block"],
      [prefs.is_locked ? "Unlock chat" : "Lock chat", "lock"],
      ["Change wallpaper", "wallpaper"],
      ["Delete chat from my list", "delete"],
    ];

    for (const [label, action] of actions) {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "chat-context-action";
      button.textContent = label;

      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        close();

        try {
          if (action === "pin") {
            await saveChatPreference(peer.conversationId, {
              is_pinned: !prefs.is_pinned,
            });

            toast(prefs.is_pinned ? "Chat unpinned." : "Chat pinned.");
          }

          if (action === "archive") {
            await saveChatPreference(peer.conversationId, {
              is_archived: !prefs.is_archived,
            });

            toast(prefs.is_archived ? "Chat restored." : "Chat archived.");
          }

          if (action === "mute") {
            await saveChatPreference(peer.conversationId, {
              is_muted: !prefs.is_muted,
            });

            toast(prefs.is_muted ? "Chat unmuted." : "Chat muted.");
          }

          if (action === "lock") {
            if (!prefs.is_locked && !(await ensurePinSet())) return;
            await saveChatPreference(peer.conversationId, {
              is_locked: !prefs.is_locked,
            });
            if (!prefs.is_locked && activeConversation === peer.conversationId)
              closeActiveChat();
            toast(
              prefs.is_locked
                ? "Chat unlocked."
                : "Chat locked. Find it in the Locked tab.",
            );
          }

          if (action === "wallpaper") {
            openWallpaperPicker(peer);
            return;
          }

          if (action === "leave") {
            if (!window.confirm("Leave this group?")) return;
            await rpcOrThrow("leave_group", {
              target_conversation_id: peer.conversationId,
            });
            if (activeConversation === peer.conversationId) closeActiveChat();
            toast("You left the group.");
          }

          if (action === "block") {
            const isBlocked = blockedIds.has(peer.id);
            if (
              !isBlocked &&
              !window.confirm(
                "Block " +
                  peerName(peer) +
                  "? They won't be able to message you.",
              )
            )
              return;
            const { error: blockError } = isBlocked
              ? await supabase
                  .from("user_blocks")
                  .delete()
                  .eq("blocker_id", currentUser.id)
                  .eq("blocked_id", peer.id)
              : await supabase
                  .from("user_blocks")
                  .insert({ blocker_id: currentUser.id, blocked_id: peer.id });
            if (blockError) throw blockError;
            await loadBlocks();
            toast(isBlocked ? "User unblocked." : "User blocked.");
          }

          if (action === "delete") {
            const confirmed = window.confirm(
              "Hide this chat from your list? This will not delete the other person's messages.",
            );

            if (!confirmed) return;

            await saveChatPreference(peer.conversationId, {
              is_deleted: true,
              is_archived: false,
            });

            if (activeConversation === peer.conversationId) {
              activePeer = null;
              activeConversation = null;

              $("messages").innerHTML = "";
              $("messages").classList.add("hidden");
              $("composer").classList.add("hidden");
              $("welcomePanel").classList.remove("hidden");

              appScreen.classList.remove("chat-open");
            }

            toast("Chat hidden from your list.");
          }

          await loadChats();
        } catch (error) {
          console.error("Chat action failed:", error);

          toast(
            "Couldn't update chat: " + (error.message || "Please try again."),
          );
        }
      });

      menu.appendChild(button);
    }

    // The menu lives on <body> with a full-screen backdrop, so it can't be
    // clipped by the chat list, covered by the nav bar, or tap through to
    // the chat underneath.
    backdrop.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      close();
    });
    document.body.append(backdrop, menu);
    document.addEventListener("keydown", onKey);

    if (matchMedia("(max-width: 760px)").matches) {
      menu.classList.add("sheet");
    } else {
      const r = anchor.getBoundingClientRect();
      const mh = menu.offsetHeight;
      const mw = menu.offsetWidth;
      let top = r.bottom + 6;
      if (top + mh > innerHeight - 10) top = Math.max(10, r.top - mh - 6);
      const left = Math.min(Math.max(10, r.right - mw), innerWidth - mw - 10);
      menu.style.top = top + "px";
      menu.style.left = left + "px";
    }
  }

  let searchTimer;
  $("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchUsers, 250);
  });
  async function searchUsers() {
    const term = cleanUsername($("userSearch").value),
      result = $("searchResults");
    result.innerHTML = "";
    if (term.length < 2) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id,username")
      .ilike("username", `%${term}%`)
      .neq("id", currentUser.id)
      .limit(8);
    if (error) {
      toast("User search failed. Check database permissions.");
      return;
    }
    for (const person of data || []) {
      const btn = document.createElement("button");
      btn.className = "search-item";
      btn.innerHTML = `<span class="user-avatar">${escapeHtml(person.username[0].toUpperCase())}</span><span><strong>${escapeHtml(person.username)}</strong><small>Start a conversation</small></span>`;
      btn.addEventListener("click", () => startConversation(person));
      result.appendChild(btn);
    }
    if (!data?.length)
      result.innerHTML =
        '<p class="tiny muted" style="padding:8px">No users found.</p>';
  }

  async function startConversation(peer) {
    const { data: chatRows } = await supabase.rpc("get_my_chats");
    const existing = (chatRows || []).find(
      (r) => !r.is_group && r.peer_id === peer.id,
    );
    if (existing) {
      peer.preferences = lastPeers.find(
        (p) => p.conversationId === existing.conversation_id,
      )?.preferences;
      await openConversation(peer, existing.conversation_id);
      return;
    }
    const { data: newId, error } = await supabase.rpc(
      "create_private_conversation",
      { other_user_id: peer.id },
    );
    if (error) {
      toast("Couldn't start chat: " + error.message);
      return;
    }
    $("userSearch").value = "";
    $("searchResults").innerHTML = "";
    await loadChats();
    await openConversation(peer, newId);
  }

  async function openConversation(peer, conversationId) {
    if (
      peer.preferences?.is_locked &&
      appSettings.chat_lock_hash &&
      !(await unlockLocked())
    )
      return;
    showView("messages");
    activePeer = peer;
    activeConversation = conversationId;
    $("peerName").textContent = peerName(peer);
    setAvatar($("peerAvatar"), peer);
    refreshPeerStatus();
    $("welcomePanel").classList.add("hidden");
    $("messages").classList.remove("hidden");
    $("composer").classList.remove("hidden");
    appScreen.classList.add("chat-open");
    markRead();
    watchConversationExtras(conversationId);
    document
      .querySelectorAll(".chat-item")
      .forEach((el) =>
        el.classList.toggle("active", el.textContent.includes(peer.username)),
      );
    await loadMessages();
    if (realtimeChannel) {
      await supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    if (reactionsChannel) {
      await supabase.removeChannel(reactionsChannel);
      reactionsChannel = null;
    }

    reactionCache.clear();
    messageCache.clear();
    realtimeChannel = supabase
      .channel("messages-" + conversationId)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (payload.new.sender_id !== currentUser.id) {
            resolveAttachments([payload.new]).then(() =>
              renderMessage(payload.new),
            );
            markRead();
          }
        },
      )
      .subscribe();
    // Listen for reaction additions, changes and removals.
    if (reactionsChannel) {
      await supabase.removeChannel(reactionsChannel);
    }

    reactionsChannel = supabase
      .channel("reactions-" + conversationId)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "message_reactions",
        },
        () => {
          // Refresh only the currently visible messages' reactions.
          refreshVisibleReactions();
        },
      )
      .subscribe();
  }

  // Fresh signed links for attachments, so they never expire on screen.
  // Works for new messages (attachment_path) and old ones (path is
  // recovered from the old signed link).
  const pathFromUrl = (url) => {
    const m = /\/object\/sign\/chat-attachments\/([^?]+)/.exec(url || "");
    return m ? decodeURIComponent(m[1]) : null;
  };
  async function resolveAttachments(msgs) {
    const todo = msgs
      .filter((m) => m.attachment_url && !m.deleted_for_everyone)
      .map((m) => ({
        m,
        path: m.attachment_path || pathFromUrl(m.attachment_url),
      }))
      .filter((x) => x.path);
    if (!todo.length) return;
    const { data, error } = await supabase.storage
      .from("chat-attachments")
      .createSignedUrls([...new Set(todo.map((x) => x.path))], 60 * 60 * 6);
    if (error || !data) return;
    const urls = new Map(
      data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]),
    );
    for (const { m, path } of todo) {
      if (urls.has(path)) m.attachment_url = urls.get(path);
    }
  }

  async function loadMessages() {
    if (activePeer?.isGroup && groupMembersFor !== activeConversation)
      await loadGroupMembers();
    if (!navigator.onLine) return loadMessagesOffline();
    $("messages").innerHTML = "";
    messageCache.clear();

    // Load messages hidden by the current user.
    const { data: hiddenMessages, error: hiddenError } = await supabase
      .from("message_hidden_for_user")
      .select("message_id")
      .eq("user_id", currentUser.id);

    if (hiddenError) {
      console.error("Couldn't load hidden messages:", hiddenError);
      toast("Couldn't load hidden messages: " + hiddenError.message);
      return;
    }

    const hiddenIds = new Set(
      (hiddenMessages || []).map((item) => String(item.message_id)),
    );

    // Load the conversation messages.
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", activeConversation)
      .order("created_at", { ascending: true })
      .limit(300);

    if (error) {
      toast("Couldn't load messages: " + error.message);
      return;
    }

    await resolveAttachments(data || []);
    cacheMessages(activeConversation, data || [], [...hiddenIds]);

    // Cache every loaded message so replies can still find their originals.
    for (const msg of data || []) {
      messageCache.set(String(msg.id), msg);
    }

    // Render only messages this user hasn't hidden.
    for (const msg of data || []) {
      if (hiddenIds.has(String(msg.id))) {
        continue;
      }

      renderMessage(msg);
    }

    renderPendingFor(activeConversation);
    scrollMessages();
  }
  // =========================================
  // MESSAGE REACTIONS
  // =========================================

  async function loadReactionData(messages) {
    const requestNumber = ++reactionRequestNumber;
    const conversationId = activeConversation;

    const messageIds = messages
      .filter((msg) => !msg.deleted_for_everyone)
      .map((msg) => String(msg.id));

    reactionCache.clear();

    if (!messageIds.length) return;

    const { data, error } = await supabase
      .from("message_reactions")
      .select("id,message_id,user_id,emoji")
      .in("message_id", messageIds);

    // Ignore results belonging to an older conversation or request.
    if (
      requestNumber !== reactionRequestNumber ||
      conversationId !== activeConversation
    ) {
      return;
    }

    if (error) {
      console.error("Couldn't load reactions:", error);
      return;
    }

    for (const reaction of data || []) {
      const messageId = String(reaction.message_id);

      if (!reactionCache.has(messageId)) {
        reactionCache.set(messageId, []);
      }

      reactionCache.get(messageId).push(reaction);
    }
  }

  // Render the reaction buttons underneath a message.
  function renderReactionBar(message, container) {
    container.replaceChildren();

    if (message.deleted_for_everyone) {
      container.classList.add("hidden");
      return;
    }

    container.classList.remove("hidden");

    const reactions = reactionCache.get(String(message.id)) || [];

    // Display emojis that already have reactions.
    // Also display the six available emojis in the picker.
    for (const emoji of REACTION_EMOJIS) {
      const matching = reactions.filter((reaction) => reaction.emoji === emoji);

      const mine = matching.some(
        (reaction) => reaction.user_id === currentUser.id,
      );

      // Don't display empty reaction-count buttons.
      // The picker below lets users add a new reaction.
      if (!matching.length) continue;

      const button = document.createElement("button");

      button.type = "button";
      button.className = "reaction-chip" + (mine ? " selected" : "");

      button.textContent = `${emoji} ${matching.length}`;

      button.title = mine ? "Remove your reaction" : `React with ${emoji}`;

      button.setAttribute(
        "aria-label",
        `${emoji}, ${matching.length} reaction${matching.length === 1 ? "" : "s"}`,
      );

      button.setAttribute("aria-pressed", String(mine));

      button.addEventListener("click", () => {
        toggleReaction(message, emoji);
      });

      container.appendChild(button);
    }

    // Reaction picker.
    const picker = document.createElement("div");
    picker.className = "reaction-picker";

    const pickerButton = document.createElement("button");

    pickerButton.type = "button";
    pickerButton.className = "reaction-picker-trigger";
    pickerButton.textContent = "＋";
    pickerButton.title = "Add a reaction";
    pickerButton.setAttribute("aria-label", "Add a reaction");
    pickerButton.setAttribute("aria-expanded", "false");

    const options = document.createElement("div");
    options.className = "reaction-options hidden";

    for (const emoji of REACTION_EMOJIS) {
      const option = document.createElement("button");

      option.type = "button";
      option.className = "reaction-option";
      option.textContent = emoji;
      option.title = `React with ${emoji}`;
      option.setAttribute("aria-label", `React with ${emoji}`);

      option.addEventListener("click", async () => {
        options.classList.add("hidden");
        pickerButton.setAttribute("aria-expanded", "false");

        await toggleReaction(message, emoji);
      });

      options.appendChild(option);
    }

    pickerButton.addEventListener("click", (event) => {
      event.stopPropagation();

      const opening = options.classList.contains("hidden");

      // Close any other open reaction picker.
      document.querySelectorAll(".reaction-options").forEach((element) => {
        if (element !== options) {
          element.classList.add("hidden");

          const trigger = element.parentElement?.querySelector(
            ".reaction-picker-trigger",
          );

          trigger?.setAttribute("aria-expanded", "false");
        }
      });

      options.classList.toggle("hidden", !opening);

      pickerButton.setAttribute("aria-expanded", String(opening));
    });

    picker.append(pickerButton, options);
    container.appendChild(picker);
  }

  // Add, remove, or change a reaction through the secured Supabase RPC.
  // Direct table writes are intentionally disabled by the database policies.
  async function toggleReaction(message, emoji) {
    if (!currentUser || !activeConversation) {
      toast("Choose a conversation first.");
      return;
    }

    if (message.deleted_for_everyone) {
      toast("You can't react to a deleted message.");
      return;
    }

    if (!REACTION_EMOJIS.includes(emoji)) {
      toast("That reaction is not supported.");
      return;
    }

    const conversationId = activeConversation;

    try {
      const { error } = await supabase.rpc("toggle_message_reaction", {
        target_message_id: message.id,
        target_emoji: emoji,
      });

      if (error) throw error;

      // Refresh only if the user is still viewing the same conversation.
      if (conversationId === activeConversation) {
        await refreshVisibleReactions();
      }
    } catch (error) {
      console.error("Reaction update failed:", error);
      toast(
        "Couldn't send reaction: " + (error.message || "Please try again."),
      );
    }
  }

  // Refresh reaction counts without rebuilding all messages.
  async function refreshVisibleReactions() {
    if (!currentUser || !activeConversation) return;

    const conversationId = activeConversation;

    const visibleMessages = Array.from(
      $("messages").querySelectorAll("[data-message-id]"),
    )
      .map((row) => messageCache.get(String(row.dataset.messageId)))
      .filter(Boolean);

    await loadReactionData(visibleMessages);

    if (conversationId !== activeConversation) return;

    for (const message of visibleMessages) {
      const row = $("messages").querySelector(
        `[data-message-id="${CSS.escape(String(message.id))}"]`,
      );

      const bar = row?.querySelector(".message-reactions");

      if (bar) {
        renderReactionBar(message, bar);
      }
    }
  }
  function renderMessage(msg) {
    const messageId = String(msg.id);

    if (
      document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    ) {
      return;
    }

    messageCache.set(messageId, msg);

    const mine = msg.sender_id === currentUser.id;
    const row = document.createElement("div");

    row.className = "message-row" + (mine ? " mine" : "");
    // Play the entrance animation once, only for brand-new messages.
    if (
      !animatedIds.has(msg.id) &&
      Math.abs(Date.now() - new Date(msg.created_at)) < 8000
    )
      row.classList.add("msg-new");
    animatedIds.add(msg.id);
    row.dataset.messageId = messageId;
    let holdTimer = null;
    let touchStartX = 0,
      touchStartY = 0,
      touchHandled = false,
      swipeTriggered = false;
    const revealActions = () => {
      document.querySelectorAll(".message-row.actions-open").forEach((el) => {
        if (el !== row) el.classList.remove("actions-open");
      });
      row.classList.add("actions-open");
    };
    // Desktop: reveal actions only from the message's context menu.
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      revealActions();
    });
    // Mobile: attach the hold gesture to the bubble only, not the whole row.
    const gestureTarget = row;
    gestureTarget.addEventListener(
      "touchstart",
      (event) => {
        if (event.target.closest("button, a, audio, video")) return;
        const t = event.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        touchHandled = false;
        swipeTriggered = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          touchHandled = true;
          if (navigator.vibrate) navigator.vibrate(12);
          revealActions();
        }, 560);
      },
      { passive: true },
    );
    gestureTarget.addEventListener(
      "touchmove",
      (event) => {
        const t = event.touches[0];
        const dx = t.clientX - touchStartX,
          dy = t.clientY - touchStartY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(holdTimer);
        if (dx < -65 && Math.abs(dy) < 38 && !swipeTriggered) {
          swipeTriggered = true;
          touchHandled = true;
          startReply(msg);
          row.classList.add("swipe-reply");
          setTimeout(() => row.classList.remove("swipe-reply"), 450);
        }
      },
      { passive: true },
    );
    gestureTarget.addEventListener("touchend", () => clearTimeout(holdTimer), {
      passive: true,
    });
    gestureTarget.addEventListener(
      "touchcancel",
      () => clearTimeout(holdTimer),
      { passive: true },
    );
    row.addEventListener("click", (event) => {
      if (touchHandled) {
        event.preventDefault();
        event.stopPropagation();
        touchHandled = false;
        return;
      }
      if (event.target.closest("button, a, audio, img")) return;
      if (
        window.matchMedia("(max-width: 760px)").matches &&
        row.classList.contains("actions-open")
      )
        row.classList.remove("actions-open");
    });

    let body = "";

    // Display the original message when this message is a reply.
    if (msg.reply_to) {
      const original = messageCache.get(String(msg.reply_to));

      const quote = document.createElement("button");
      quote.type = "button";
      quote.className = "reply-quote";

      if (original) {
        const originalSender =
          original.sender_id === currentUser.id
            ? "You"
            : activePeer?.username || "User";

        let originalText = original.content || "";

        if (original.attachment_type === "image") {
          originalText = originalText || "📷 Image";
        } else if (original.attachment_type === "audio") {
          originalText = originalText || "🎙 Voice note";
        } else if (original.attachment_url && !originalText) {
          originalText = "📎 Attachment";
        }

        quote.innerHTML = `
    <strong>${escapeHtml(originalSender)}</strong>
    <span>${escapeHtml(originalText || "Message")}</span>
  `;

        quote.addEventListener("click", () => {
          const target = document.querySelector(
            `[data-message-id="${CSS.escape(String(original.id))}"]`,
          );

          if (target) {
            target.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });

            target.classList.add("message-highlight");

            setTimeout(() => {
              target.classList.remove("message-highlight");
            }, 1400);
          }
        });
      } else {
        quote.textContent = "Original message unavailable";
        quote.disabled = true;
      }

      body += quote.outerHTML;
    }

    if (msg.content) {
      body += `<div>${escapeHtml(msg.content)}</div>`;
    }

    if (msg.attachment_url) {
      let raw = "";
      try {
        const u = new URL(msg.attachment_url);
        if (
          u.protocol === "https:" &&
          (msg.attachment_type === "image" || u.origin === SUPA_ORIGIN)
        )
          raw = u.href;
      } catch {}
      const url = escapeHtml(raw);

      if (!raw) {
        body += '<div class="tiny muted">Attachment unavailable</div>';
      } else if (msg.attachment_type === "audio") {
        body += `
    <audio
      class="audio-player"
      controls
      preload="metadata"
      src="${url}"
    ></audio>
  `;
      } else if (msg.attachment_type === "image") {
        body += `
    <img
      class="chat-image"
      src="${url}"
      alt="Shared image"
      loading="lazy"
      style="cursor: zoom-in;"
    >
  `;
      } else {
        const fileName = msg.content || "Shared file";

        body += `
    <a
      class="file-card"
      href="${url}"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="file-icon">📄</span>
      <span>
        ${escapeHtml(fileName)}
        <br>
        <small>Open / download</small>
      </span>
    </a>
  `;
      }
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = body;
    if (activePeer?.isGroup && !mine)
      bubble.insertAdjacentHTML(
        "afterbegin",
        `<div class="sender-name">${escapeHtml(memberName(msg.sender_id))}</div>`,
      );
    const reactionBar = document.createElement("div");
    reactionBar.className = "message-reactions";

    renderReactionBar(msg, reactionBar);

    const meta = document.createElement("span");
    meta.className = "message-meta";

    meta.textContent =
      `${mine ? "You" : activePeer?.isGroup ? memberName(msg.sender_id) : activePeer?.username || "User"} · ` +
      new Date(msg.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }) +
      (msg.is_edited ? " · edited" : "");
    if (mine && !msg.deleted_for_everyone) {
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.dataset.ts = msg.created_at;
      if (msg.pending) tick.dataset.pending = "1";
      setTick(tick);
      meta.appendChild(tick);
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";

    // Reply button
    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.className = "message-reply-btn";
    replyButton.textContent = "↩ Reply";
    replyButton.setAttribute("aria-label", "Reply to this message");

    replyButton.addEventListener("click", () => {
      startReply(msg);
    });

    actions.appendChild(replyButton);

    // Only show Edit for your own text messages.
    if (mine && msg.content && !msg.attachment_url) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "message-edit-btn";
      editButton.textContent = "✏️ Edit";

      editButton.addEventListener("click", () => {
        startEditMessage(msg);
      });

      actions.appendChild(editButton);
    }
    if (mine && !msg.deleted_for_everyone) {
      const deleteButton = document.createElement("button");

      deleteButton.className = "message-delete-btn";
      deleteButton.textContent = "Delete";

      deleteButton.addEventListener("click", () => {
        deleteMessage(msg);
      });

      actions.appendChild(deleteButton);
    }
    const hideButton = document.createElement("button");

    hideButton.className = "message-hide-btn";
    hideButton.textContent = "Delete for me";

    hideButton.addEventListener("click", () => {
      hideMessageForMe(msg);
    });

    actions.appendChild(hideButton);

    row.append(bubble, reactionBar, actions, meta);

    const image = row.querySelector(".chat-image");

    if (image) {
      image.addEventListener("click", () => {
        openImageViewer(image.src);
      });

      image.addEventListener("error", () => {
        image.alt =
          "Image could not be loaded. Try opening the attachment again.";
      });
    }

    // Convert the quoted message's HTML into a real interactive button.
    const quoted = row.querySelector(".reply-quote");

    if (quoted) {
      const original = msg.reply_to
        ? messageCache.get(String(msg.reply_to))
        : null;

      if (original) {
        quoted.addEventListener("click", () => {
          const target = document.querySelector(
            `[data-message-id="${CSS.escape(String(original.id))}"]`,
          );

          if (target) {
            target.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });

            target.classList.add("message-highlight");

            setTimeout(() => {
              target.classList.remove("message-highlight");
            }, 1400);
          }
        });
      }
    }

    $("messages").appendChild(row);
    scrollMessages();
  }

  function openImageViewer(imageUrl) {
    let viewer = document.getElementById("image-viewer");

    if (!viewer) {
      viewer = document.createElement("div");
      viewer.id = "image-viewer";
      viewer.className = "image-viewer";

      viewer.innerHTML = `
        <button type="button" class="image-viewer-close" aria-label="Close image">
          &times;
        </button>
        <img class="image-viewer-content" alt="Full-size shared image">
      `;

      document.body.appendChild(viewer);

      viewer.addEventListener("click", (event) => {
        if (
          event.target === viewer ||
          event.target.classList.contains("image-viewer-close")
        ) {
          viewer.classList.remove("visible");
        }
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          viewer.classList.remove("visible");
        }
      });
    }

    viewer.querySelector(".image-viewer-content").src = imageUrl;
    viewer.classList.add("visible");
  }

  function scrollMessages() {
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  function startReply(msg) {
    replyingToMessage = msg;

    const preview = $("replyPreview");
    const previewText = $("replyPreviewText");

    if (!preview || !previewText) {
      toast("Reply preview is missing from index.html.");
      replyingToMessage = null;
      return;
    }

    const sender =
      msg.sender_id === currentUser.id ? "You" : activePeer?.username || "User";

    let text = msg.content || "";

    if (msg.attachment_type === "image") {
      text = text || "📷 Image";
    } else if (msg.attachment_type === "audio") {
      text = text || "🎙 Voice note";
    } else if (msg.attachment_url && !text) {
      text = "📎 Attachment";
    }

    previewText.textContent = `${sender}: ${text || "Message"}`;
    preview.classList.remove("hidden");

    $("messageInput").focus();
  }

  function cancelReply() {
    replyingToMessage = null;

    $("replyPreview")?.classList.add("hidden");

    if ($("replyPreviewText")) {
      $("replyPreviewText").textContent = "";
    }
  }
  let editingMessageId = null;

  async function startEditMessage(msg) {
    if (msg.sender_id !== currentUser.id) {
      toast("You can only edit your own messages.");
      return;
    }
    const messageTime = new Date(msg.created_at).getTime();
    const wasSeen =
      peerReadAt &&
      Number.isFinite(messageTime) &&
      peerReadAt.getTime() >= messageTime;
    if (wasSeen && Date.now() > peerReadAt.getTime() + 60_000) {
      toast(
        "This message can no longer be edited: it was seen more than one minute ago.",
      );
      return;
    }

    const newContent = window.prompt("Edit your message:", msg.content || "");

    if (newContent === null) return;

    const content = newContent.trim();

    if (!content) {
      toast("A message cannot be empty.");
      return;
    }

    if (content === msg.content) {
      toast("No changes were made.");
      return;
    }

    editingMessageId = String(msg.id);

    try {
      const { data, error } = await supabase
        .from("messages")
        .update({
          content,
          is_edited: true,
        })
        .eq("id", msg.id)
        .eq("sender_id", currentUser.id)
        .select("id");

      if (error) throw error;

      if (!data || data.length === 0) {
        throw new Error(
          "The message was not updated. Check your Supabase permissions.",
        );
      }

      toast("Message edited successfully.");
      await loadMessages();
    } catch (error) {
      console.error("Edit message failed:", error);
      toast("Couldn't edit message: " + error.message);
    } finally {
      editingMessageId = null;
    }
  }
  async function deleteMessage(msg) {
    if (msg.sender_id !== currentUser.id) {
      alert("You can only delete your own messages.");
      return;
    }

    const confirmed = confirm(
      "Delete this message for everyone? This cannot be undone.",
    );

    if (!confirmed) return;

    const { data, error } = await supabase
      .from("messages")
      .update({
        deleted_for_everyone: true,
        content: "This message was deleted",
        attachment_url: null,
        attachment_type: null,
        is_edited: false,
      })
      .eq("id", msg.id)
      .eq("sender_id", currentUser.id)
      .select("id");

    if (error) {
      console.error("Delete message error:", error);
      alert("Could not delete the message. Please try again.");
      return;
    }

    if (!data || data.length === 0) {
      alert("Message could not be deleted. Check your permissions.");
      return;
    }

    await loadMessages();
  }
  async function hideMessageForMe(msg) {
    const confirmed = confirm(
      "Hide this message from your chat? The other person will still be able to see it.",
    );

    if (!confirmed) return;

    const { error } = await supabase.from("message_hidden_for_user").insert({
      message_id: msg.id,
      user_id: currentUser.id,
    });

    if (error) {
      console.error("Hide message error:", error);
      alert("Could not hide this message. Please try again.");
      return;
    }

    await loadMessages();
  }

  $("cancelReplyBtn")?.addEventListener("click", cancelReply);

  async function sendMessage(
    content = "",
    attachment = null,
    attachmentType = null,
  ) {
    if (!activeConversation) {
      toast("Choose a conversation first.");
      return;
    }
    if (!content.trim() && !attachment) return;
    if (attachment && !navigator.onLine) {
      toast("Photos, files and voice notes need an internet connection.");
      return;
    }
    let attachmentPathValue = null,
      attachmentUrl = null,
      finalContent = content.trim();
    if (attachment) {
      if (attachment.size > 50 * 1024 * 1024) {
        toast("File is larger than 50 MB.");
        return;
      }
      const ext = (
        attachment.name?.split(".").pop() ||
        (attachmentType === "audio" ? "webm" : "bin")
      )
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
      const path = `${activeConversation}/${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("chat-attachments")
        .upload(path, attachment, {
          contentType: attachment.type || "application/octet-stream",
          upsert: false,
        });
      if (uploadError) {
        toast("File upload failed: " + uploadError.message);
        return;
      }
      const { data: signed, error: signedError } = await supabase.storage
        .from("chat-attachments")
        .createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signedError) {
        toast("Could not create file link: " + signedError.message);
        return;
      }
      attachmentUrl = signed.signedUrl;
      attachmentPathValue = path;
      if (attachmentType !== "audio")
        finalContent = attachment.name || "Shared file";
    }
    if (!attachment && !navigator.onLine) return queueMessage(finalContent);
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeConversation,
      sender_id: currentUser.id,
      content: finalContent || null,
      attachment_url: attachmentUrl,
      attachment_path: attachmentPathValue,
      attachment_type: attachment ? attachmentType : null,
      reply_to: replyingToMessage?.id || null,
    });
    if (error && !attachment && isNetworkError(error))
      return queueMessage(finalContent);
    if (error) {
      toast(
        error.code === "42501"
          ? "You can't send messages to this person."
          : "Message failed: " + error.message,
      );
      return;
    }
    cancelReply();
    await loadMessages();
    loadChats();
  }

  $("sendBtn").addEventListener("click", async () => {
    if ($("sendBtn").disabled) return;

    $("sendBtn").disabled = true;

    try {
      if (selectedFile) {
        const file = selectedFile;
        const type = file.type.startsWith("image/") ? "image" : "file";

        await sendMessage("", file, type);

        selectedFile = null;
        $("fileInput").value = "";
        $("attachmentPreview").classList.add("hidden");
      } else {
        const text = $("messageInput").value.trim();

        if (!text) return;

        await sendMessage(text);

        $("messageInput").value = "";
        $("messageInput").style.height = "auto";
      }
    } catch (error) {
      console.error("Send failed:", error);
      toast("Couldn't send. Please try again.");
    } finally {
      $("sendBtn").disabled = false;
    }
  });

  // ---- Offline support: saved copy, waiting messages, banner ----
  const CS = "cs:";
  function cacheGet(k) {
    try {
      return JSON.parse(localStorage.getItem(CS + k));
    } catch {
      return null;
    }
  }
  function cacheSet(k, v) {
    try {
      localStorage.setItem(CS + k, JSON.stringify(v));
    } catch {
      try {
        (cacheGet("msgkeys") || []).forEach((x) =>
          localStorage.removeItem(CS + "msgs:" + x),
        );
        localStorage.setItem(CS + "msgkeys", "[]");
      } catch {}
    }
  }
  function clearOfflineCache() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(CS))
      .forEach((k) => localStorage.removeItem(k));
  }
  function cacheMessages(convId, messages, hidden) {
    cacheSet("msgs:" + convId, { messages: messages.slice(-80), hidden });
    const keys = (cacheGet("msgkeys") || []).filter((k) => k !== convId);
    keys.push(convId);
    while (keys.length > 15)
      localStorage.removeItem(CS + "msgs:" + keys.shift());
    cacheSet("msgkeys", keys);
  }
  const isNetworkError = (e) =>
    !e.code && /fetch|network|load failed/i.test(e.message || "");

  async function loadMessagesOffline() {
    $("messages").innerHTML = "";
    messageCache.clear();
    const saved = cacheGet("msgs:" + activeConversation);
    if (!saved)
      toast("You're offline, and this chat isn't saved on this device yet.");
    for (const msg of saved?.messages || []) {
      messageCache.set(String(msg.id), msg);
      if (!(saved.hidden || []).includes(String(msg.id))) renderMessage(msg);
    }
    renderPendingFor(activeConversation);
    scrollMessages();
  }

  // Messages typed while offline wait here, then send themselves.
  let outbox = cacheGet("outbox") || [];
  let flushing = false;
  const saveOutbox = () => cacheSet("outbox", outbox);
  function renderPendingFor(conversationId) {
    for (const item of outbox)
      if (item.conversation_id === conversationId)
        renderMessage({
          ...item,
          is_edited: false,
          deleted_for_everyone: false,
          pending: true,
        });
  }
  function queueMessage(text) {
    const item = {
      id: crypto.randomUUID(),
      conversation_id: activeConversation,
      sender_id: currentUser.id,
      content: text,
      reply_to: replyingToMessage?.id || null,
      created_at: new Date().toISOString(),
    };
    outbox.push(item);
    saveOutbox();
    cancelReply();
    renderMessage({
      ...item,
      is_edited: false,
      deleted_for_everyone: false,
      pending: true,
    });
    scrollMessages();
    updateOfflineBanner();
  }
  async function flushOutbox() {
    if (flushing || !outbox.length || !navigator.onLine || !currentUser?.id)
      return;
    flushing = true;
    try {
      for (const item of [...outbox]) {
        const { error } = await supabase.from("messages").insert({
          id: item.id,
          conversation_id: item.conversation_id,
          sender_id: item.sender_id,
          content: item.content,
          reply_to: item.reply_to,
        });
        if (error && error.code !== "23505") {
          if (isNetworkError(error)) break;
          toast("A waiting message couldn't be sent: " + error.message);
        }
        outbox = outbox.filter((x) => x.id !== item.id);
        saveOutbox();
      }
    } finally {
      flushing = false;
    }
    updateOfflineBanner();
    if (activeConversation) await loadMessages();
    loadChats();
  }

  function updateOfflineBanner() {
    let bar = $("offlineBanner");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "offlineBanner";
      bar.className = "offline-banner hidden";
      document.body.appendChild(bar);
    }
    const waiting = outbox.length
      ? ` ${outbox.length} message${outbox.length > 1 ? "s" : ""} waiting.`
      : "";
    if (!navigator.onLine)
      bar.textContent =
        "You're offline. You can read saved chats and write messages." +
        waiting;
    else bar.textContent = "Back online. Sending" + waiting;
    bar.classList.toggle("hidden", navigator.onLine && !outbox.length);
  }
  window.addEventListener("offline", updateOfflineBanner);
  window.addEventListener("online", async () => {
    updateOfflineBanner();
    if (!currentUser?.id) return;
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      showAuth();
      authMessage("Please log in again to keep chatting.", true);
      return;
    }
    await flushOutbox();
    loadChats();
    if (activeConversation) loadMessages();
  });
  setInterval(() => outbox.length && flushOutbox(), 20000);
  updateOfflineBanner();

  // ---- Calls: one-to-one voice and video ----
  let call = null,
    callChannel = null,
    ringTimer = null,
    iceCache = null,
    iceRelay = false;
  const FALLBACK_ICE = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ];
  async function getIceServers() {
    if (iceCache && Date.now() < iceCache.exp) {
      iceRelay = true;
      return iceCache.servers;
    }
    iceRelay = false;
    try {
      const res = await fetch("/api/ice", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const servers = [].concat(data.iceServers || []);
        if (servers.length) {
          iceCache = { servers, exp: Date.now() + 3600e3 };
          iceRelay = JSON.stringify(servers).includes("turn:");
          return servers;
        }
      }
    } catch {}
    return FALLBACK_ICE;
  }
  const fmtDuration = (s) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const mediaError = (e) =>
    e?.name === "NotAllowedError"
      ? "Allow microphone and camera access in your browser to make calls."
      : "Couldn't start your microphone or camera.";

  async function rawSignal(row) {
    const { error } = await supabase
      .from("call_signals")
      .insert({ from_user: currentUser.id, ...row });
    if (error) console.error("Call signal:", error.message);
  }
  const sendSignal = (kind, payload = null) =>
    call &&
    rawSignal({
      conversation_id: call.conversationId,
      call_id: call.id,
      to_user: call.peerId,
      kind,
      media: call.media,
      payload,
    });

  function startRing() {
    stopRing();
    beep();
    ringTimer = setInterval(() => {
      beep();
      setTimeout(beep, 350);
      if (call?.role === "callee") navigator.vibrate?.([300, 150, 300]);
    }, 2200);
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
  }

  function showCallScreen(status) {
    document.getElementById("incomingCall")?.remove();
    document.getElementById("callScreen")?.remove();
    const el = document.createElement("div");
    el.id = "callScreen";
    el.className =
      "call-screen " + (call.media === "video" ? "video" : "voice");
    el.innerHTML = `<video id="remoteVideo" class="call-remote" autoplay playsinline></video>
      <div class="call-info">
        <div id="callAvatar" class="user-avatar xl call-avatar"></div>
        <h2 id="callName"></h2>
        <p id="callStatus"></p>
      </div>
      <video id="localVideo" class="call-local ${call.media === "video" ? "" : "hidden"}" autoplay playsinline muted></video>
      <div class="call-controls">
        <button type="button" id="callMute" class="call-btn" aria-label="Mute microphone">🎤</button>
        <button type="button" id="callCam" class="call-btn ${call.media === "video" ? "" : "hidden"}" aria-label="Turn camera off">📷</button>
        <button type="button" id="callEnd" class="call-btn end" aria-label="End call">✕</button>
      </div>`;
    document.body.appendChild(el);
    setAvatar($("callAvatar"), call.peer);
    $("callName").textContent = call.peer.preferences?.is_locked
      ? "Someone"
      : peerName(call.peer);
    $("callStatus").textContent = status;
    if (call.media === "video") $("localVideo").srcObject = call.local;
    $("callEnd").addEventListener("click", () => endCall("hangup"));
    $("callMute").addEventListener("click", () => {
      const track = call.local.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $("callMute").textContent = track.enabled ? "🎤" : "🔇";
      $("callMute").classList.toggle("off", !track.enabled);
    });
    $("callCam").addEventListener("click", () => {
      const track = call.local.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $("callCam").classList.toggle("off", !track.enabled);
    });
  }
  const setCallStatus = (t) =>
    document.getElementById("callStatus") && ($("callStatus").textContent = t);

  async function getMedia(media) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: media === "video" ? { facingMode: "user" } : false,
    });
  }
  async function createPeer() {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
    call.pc = pc;
    // Give up cleanly instead of hanging on "Connecting…" forever.
    call.connectTimer = setTimeout(() => {
      if (call && call.state !== "connected") {
        console.error(
          "Call timed out. Relay:",
          iceRelay,
          "ICE:",
          pc.iceConnectionState,
        );
        endCall("failed");
      }
    }, 25000);
    pc.oniceconnectionstatechange = () => {
      if (call && call.state !== "connected")
        setCallStatus(
          "Connecting… (" +
            pc.iceConnectionState +
            (iceRelay ? ", relay on" : ", no relay") +
            ")",
        );
    };
    call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
    pc.onicecandidate = (e) =>
      e.candidate && sendSignal("ice", e.candidate.toJSON());
    pc.ontrack = (e) => {
      $("remoteVideo").srcObject = e.streams[0];
      $("remoteVideo")
        .play?.()
        .catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (!call) return;
      const s = pc.connectionState;
      clearTimeout(call.discTimer);
      if (s === "connected") onCallConnected();
      else if (s === "failed") endCall("failed");
      else if (s === "disconnected")
        call.discTimer = setTimeout(
          () => call && pc.connectionState !== "connected" && endCall("failed"),
          8000,
        );
    };
    return pc;
  }
  function onCallConnected() {
    if (call.state === "connected") return;
    call.state = "connected";
    call.startedAt = Date.now();
    clearTimeout(call.connectTimer);
    clearTimeout(call.ringTimeout);
    stopRing();
    document.getElementById("callScreen")?.classList.add("connected");
    setCallStatus("0:00");
    call.timer = setInterval(
      () =>
        setCallStatus(
          fmtDuration(Math.floor((Date.now() - call.startedAt) / 1000)),
        ),
      1000,
    );
  }
  async function flushIce() {
    for (const c of call.pendingIce.splice(0)) {
      try {
        await call.pc.addIceCandidate(c);
      } catch {}
    }
  }

  async function startCall(media) {
    if (call) return toast("You're already in a call.");
    if (!navigator.onLine) return toast("Calls need an internet connection.");
    if (!activePeer || activePeer.isGroup) return;
    if (blockedIds.has(activePeer.id))
      return toast("Unblock this person to call them.");
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      return toast("Calls aren't supported in this browser.");
    call = {
      id: crypto.randomUUID(),
      conversationId: activeConversation,
      peerId: activePeer.id,
      peer: activePeer,
      media,
      role: "caller",
      state: "ringing",
      pendingIce: [],
    };
    try {
      call.local = await getMedia(media);
    } catch (e) {
      call = null;
      return toast(mediaError(e));
    }
    showCallScreen("Calling…");
    startRing();
    call.ringTimeout = setTimeout(() => endCall("noanswer"), 45000);
    await sendSignal("invite");
  }

  function onInvite(row) {
    if (call) {
      rawSignal({
        conversation_id: row.conversation_id,
        call_id: row.call_id,
        to_user: row.from_user,
        kind: "decline",
        media: row.media,
        payload: { busy: true },
      });
      return;
    }
    const peer = lastPeers.find(
      (p) => p.conversationId === row.conversation_id && !p.isGroup,
    );
    if (!peer || blockedIds.has(row.from_user)) return;
    call = {
      id: row.call_id,
      conversationId: row.conversation_id,
      peerId: row.from_user,
      peer,
      media: row.media === "video" ? "video" : "voice",
      role: "callee",
      state: "ringing",
      pendingIce: [],
    };
    const name = peer.preferences?.is_locked ? "Someone" : peerName(peer);
    const box = document.createElement("div");
    box.id = "incomingCall";
    box.className = "incoming-call";
    box.innerHTML = `<div class="user-avatar xl" id="incomingAvatar"></div>
      <h2>${escapeHtml(name)}</h2>
      <p class="muted">Incoming ${call.media} call…</p>
      <div class="call-controls">
        <button type="button" class="call-btn end" id="incomingDecline" aria-label="Decline">✕</button>
        <button type="button" class="call-btn accept" id="incomingAccept" aria-label="Accept">✓</button>
      </div>`;
    document.body.appendChild(box);
    setAvatar($("incomingAvatar"), peer);
    $("incomingDecline").addEventListener("click", () => endCall("declined"));
    $("incomingAccept").addEventListener("click", acceptCall);
    startRing();
    call.ringTimeout = setTimeout(() => endCall("missed", false), 45000);
    if (
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    )
      navigator.serviceWorker?.ready
        .then((reg) =>
          reg.showNotification("Incoming call", {
            body: name,
            tag: "call",
            requireInteraction: true,
            icon: "/icons/icon-192.png",
          }),
        )
        .catch(() => {});
  }
  async function acceptCall() {
    if (!call) return;
    stopRing();
    clearTimeout(call.ringTimeout);
    try {
      call.local = await getMedia(call.media);
    } catch (e) {
      toast(mediaError(e));
      return endCall("declined");
    }
    showCallScreen("Connecting…");
    await createPeer();
    await sendSignal("accept");
  }

  async function handleSignal(row) {
    if (Date.now() - new Date(row.created_at) > 60000) return;
    if (row.kind === "invite") return onInvite(row);
    if (!call || call.id !== row.call_id) return;
    try {
      if (row.kind === "accept" && call.role === "caller") {
        clearTimeout(call.ringTimeout);
        stopRing();
        setCallStatus("Connecting…");
        const pc = await createPeer();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal("offer", { type: offer.type, sdp: offer.sdp });
      } else if (row.kind === "offer" && call.role === "callee" && call.pc) {
        await call.pc.setRemoteDescription(row.payload);
        await flushIce();
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        await sendSignal("answer", { type: answer.type, sdp: answer.sdp });
      } else if (row.kind === "answer" && call.role === "caller" && call.pc) {
        await call.pc.setRemoteDescription(row.payload);
        await flushIce();
      } else if (row.kind === "ice") {
        if (call.pc?.remoteDescription)
          await call.pc.addIceCandidate(row.payload).catch(() => {});
        else call.pendingIce.push(row.payload);
      } else if (row.kind === "decline") {
        endCall(row.payload?.busy ? "busy" : "declined", false);
      } else if (row.kind === "hangup") {
        endCall(
          call.state === "ringing" && call.role === "callee"
            ? "missed"
            : "remote",
          false,
        );
      }
    } catch (err) {
      console.error("Call error:", err);
      endCall("failed");
    }
  }

  async function endCall(reason, notify = true) {
    if (!call) return;
    const c = call;
    call = null;
    clearTimeout(c.ringTimeout);
    clearTimeout(c.discTimer);
    clearTimeout(c.connectTimer);
    clearInterval(c.timer);
    stopRing();
    c.pc?.close();
    c.local?.getTracks().forEach((t) => t.stop());
    document.getElementById("callScreen")?.remove();
    document.getElementById("incomingCall")?.remove();
    const seconds = c.startedAt
      ? Math.floor((Date.now() - c.startedAt) / 1000)
      : 0;
    if (notify && reason !== "logout")
      await rawSignal({
        conversation_id: c.conversationId,
        call_id: c.id,
        to_user: c.peerId,
        kind:
          c.state === "ringing" && c.role === "callee" ? "decline" : "hangup",
        media: c.media,
      });
    const kindLabel = c.media === "video" ? "video" : "voice";
    const notes = {
      failed: iceRelay
        ? "Call failed. Check your connection and try again."
        : "Call failed: the call relay isn't set up, so this network blocked the connection.",
      busy: "They're on another call.",
      declined: "Call declined.",
      noanswer: "No answer.",
      missed: "Missed " + kindLabel + " call from " + peerName(c.peer) + ".",
    };
    if (
      notes[reason] && reason !== "failed"
        ? c.role === "caller" || reason === "missed"
        : reason === "failed"
    )
      toast(notes[reason]);
    // The caller leaves a line in the chat as a call history entry.
    if (c.role === "caller" && reason !== "logout") {
      const label =
        c.state === "connected"
          ? `📞 ${kindLabel} call · ${fmtDuration(seconds)}`
          : reason === "declined" || reason === "busy"
            ? `📞 ${kindLabel} call declined`
            : `📞 Missed ${kindLabel} call`;
      await supabase.from("messages").insert({
        conversation_id: c.conversationId,
        sender_id: currentUser.id,
        content: label,
      });
      if (activeConversation === c.conversationId) await loadMessages();
      loadChats();
    }
    supabase
      .from("call_signals")
      .delete()
      .eq("call_id", c.id)
      .eq("from_user", currentUser?.id || "");
  }

  function startCallListener() {
    if (callChannel || !currentUser?.id) return;
    callChannel = supabase
      .channel("calls-" + currentUser.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_signals",
          filter: `to_user=eq.${currentUser.id}`,
        },
        (payload) => handleSignal(payload.new),
      )
      .subscribe();
    supabase.rpc("purge_old_call_signals");
  }
  function stopCallListener() {
    if (callChannel) supabase.removeChannel(callChannel);
    callChannel = null;
  }
  $("voiceCallBtn").addEventListener("click", () => startCall("voice"));
  $("videoCallBtn").addEventListener("click", () => startCall("video"));

  // ---- Chat lock (PIN) ----
  let lockUnlocked = false,
    showingLocked = false,
    lockTimer = null,
    pinFails = 0,
    pinBlockedUntil = 0;
  const bytesToB64 = (u8) => btoa(String.fromCharCode(...u8));
  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function hashPin(pin, saltB64) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: b64ToBytes(saltB64),
        iterations: 150000,
        hash: "SHA-256",
      },
      key,
      256,
    );
    return bytesToB64(new Uint8Array(bits));
  }
  const verifyPin = async (pin) =>
    (await hashPin(pin, appSettings.chat_lock_salt)) ===
    appSettings.chat_lock_hash;

  function pinDialog({ title, text = "", forgot = false }) {
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "pin-backdrop";
      back.innerHTML = `<div class="pin-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        ${text ? `<p class="tiny muted">${escapeHtml(text)}</p>` : ""}
        <input class="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••" aria-label="PIN" />
        <p class="tiny pin-error"></p>
        <div class="pin-actions">
          <button type="button" class="ghost-btn" data-p="cancel">Cancel</button>
          <button type="button" class="primary-btn" data-p="ok">OK</button>
        </div>
        ${forgot ? '<button type="button" class="link-btn" data-p="forgot">Forgot PIN?</button>' : ""}
      </div>`;
      document.body.appendChild(back);
      const input = back.querySelector(".pin-input");
      input.focus();
      const done = (v) => {
        back.remove();
        resolve(v);
      };
      const submit = () => {
        if (input.value.length < 4)
          back.querySelector(".pin-error").textContent =
            "PIN must be 4 to 6 digits.";
        else done(input.value);
      };
      input.addEventListener(
        "input",
        () => (input.value = input.value.replace(/\D/g, "")),
      );
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") done(null);
      });
      back.querySelector('[data-p="ok"]').onclick = submit;
      back.querySelector('[data-p="cancel"]').onclick = () => done(null);
      back
        .querySelector('[data-p="forgot"]')
        ?.addEventListener("click", () => done("__forgot__"));
    });
  }
  async function checkPinFlow(title = "Enter your PIN") {
    if (Date.now() < pinBlockedUntil) {
      toast("Too many wrong tries. Wait 30 seconds.");
      return false;
    }
    const pin = await pinDialog({ title, forgot: true });
    if (pin === null) return false;
    if (pin === "__forgot__") {
      if (
        window.confirm(
          "Resetting removes your PIN and unlocks ALL locked chats. Continue?",
        )
      ) {
        await clearPin();
        toast("PIN reset. Your chats are unlocked.");
      }
      return false;
    }
    if (await verifyPin(pin)) {
      pinFails = 0;
      return true;
    }
    if (++pinFails >= 5) {
      pinBlockedUntil = Date.now() + 30000;
      pinFails = 0;
    }
    toast("Wrong PIN.");
    return false;
  }
  async function unlockLocked() {
    if (lockUnlocked || !appSettings.chat_lock_hash) return true;
    lockUnlocked = await checkPinFlow();
    return lockUnlocked;
  }
  async function setPinFlow() {
    if (
      appSettings.chat_lock_hash &&
      !(await checkPinFlow("Enter your current PIN"))
    )
      return false;
    const first = await pinDialog({
      title: "Choose a PIN",
      text: "4 to 6 digits.",
    });
    if (first === null) return false;
    const second = await pinDialog({ title: "Confirm your PIN" });
    if (second === null) return false;
    if (first !== second) {
      toast("The PINs didn't match.");
      return false;
    }
    const prev = {
      chat_lock_hash: appSettings.chat_lock_hash,
      chat_lock_salt: appSettings.chat_lock_salt,
    };
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const ok = await saveSetting({
      chat_lock_hash: await hashPin(first, salt),
      chat_lock_salt: salt,
    });
    if (!ok) appSettings = { ...appSettings, ...prev };
    else toast("PIN saved.");
    return ok;
  }
  const ensurePinSet = async () =>
    Boolean(appSettings.chat_lock_hash) || (await setPinFlow());
  async function clearPin() {
    await supabase
      .from("chat_preferences")
      .update({ is_locked: false })
      .eq("user_id", currentUser.id)
      .eq("is_locked", true);
    await saveSetting({ chat_lock_hash: null, chat_lock_salt: null });
    lockUnlocked = false;
    loadChats();
  }
  function relock() {
    lockUnlocked = false;
    clearTimeout(lockTimer);
    if (activePeer?.preferences?.is_locked) closeActiveChat();
    if (showingLocked) setListView("recent");
    loadChats();
  }
  function setListView(view) {
    showingArchivedChats = view === "archived";
    showingLocked = view === "locked";
    $("chatList").classList.toggle("hidden", view !== "recent");
    $("archivedChatList").classList.toggle("hidden", view !== "archived");
    $("lockedChatList").classList.toggle("hidden", view !== "locked");
    $("recentChatsBtn").classList.toggle("active", view === "recent");
    $("archivedChatsBtn").classList.toggle("active", view === "archived");
    $("lockedChatsBtn").classList.toggle("active", view === "locked");
    $("lockNowBtn").classList.toggle(
      "hidden",
      !(view === "locked" && lockUnlocked && appSettings.chat_lock_hash),
    );
  }
  // Chats re-lock a minute after you leave the app.
  document.addEventListener("visibilitychange", () => {
    clearTimeout(lockTimer);
    if (document.hidden && lockUnlocked) lockTimer = setTimeout(relock, 60000);
  });
  $("pinSetBtn").addEventListener("click", async () => {
    await setPinFlow();
    renderSettingsUi();
  });
  $("pinRemoveBtn").addEventListener("click", async () => {
    if (!(await checkPinFlow("Enter your current PIN"))) return;
    if (!window.confirm("Remove your PIN? All locked chats will be unlocked."))
      return;
    await clearPin();
    toast("PIN removed.");
  });

  // ---- Groups, New chat, chat search ----
  let groupMembers = [],
    groupMembersFor = null;
  const memberName = (id) => {
    const m = groupMembers.find((x) => x.user_id === id);
    return m ? peerName(m) : "Member";
  };
  async function rpcOrThrow(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data;
  }
  async function loadGroupMembers() {
    const id = activeConversation;
    const { data } = await supabase.rpc("get_group_members", {
      target_conversation_id: id,
    });
    groupMembers = data || [];
    groupMembersFor = id;
    refreshPeerStatus();
  }
  function closeActiveChat() {
    activePeer = null;
    activeConversation = null;
    $("messages").innerHTML = "";
    $("messages").classList.add("hidden");
    $("composer").classList.add("hidden");
    $("welcomePanel").classList.remove("hidden");
    appScreen.classList.remove("chat-open");
    $("groupPanel").classList.add("hidden");
    loadChats();
  }

  // Search chats in the sidebar
  function applyChatFilter() {
    const q = $("chatFilter").value.trim().toLowerCase();
    document
      .querySelectorAll("#chatList .chat-item, #archivedChatList .chat-item")
      .forEach((it) =>
        it.classList.toggle(
          "hidden",
          Boolean(q) && !it.textContent.toLowerCase().includes(q),
        ),
      );
  }
  $("chatFilter").addEventListener("input", applyChatFilter);
  ["chatList", "archivedChatList"].forEach((id) =>
    new MutationObserver(applyChatFilter).observe($(id), { childList: true }),
  );

  // People search used by Create group and Add members
  async function findPeople(term, excludeIds = []) {
    const t = cleanUsername(term);
    if (t.length < 2) return [];
    const { data, error } = await supabase
      .from("profiles")
      .select("id,username,display_name,avatar_url")
      .ilike("username", `%${t}%`)
      .neq("id", currentUser.id)
      .limit(8);
    if (error) {
      toast("User search failed.");
      return [];
    }
    return (data || []).filter((p) => !excludeIds.includes(p.id));
  }
  function personButton(p, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "search-item";
    b.innerHTML = `<span class="user-avatar">${avatarInner(p)}</span><span><strong>${escapeHtml(peerName(p))}</strong><small class="muted"> @${escapeHtml(p.username)}</small></span>`;
    b.addEventListener("click", onClick);
    return b;
  }
  const debounce = (fn, ms = 300) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  // New chat panel
  function ncShow(step) {
    ["ncHome", "ncPersonStep", "ncGroupStep"].forEach((id) =>
      $(id).classList.toggle("hidden", id !== step),
    );
  }
  $("ncAddSomeone").addEventListener("click", () => ncShow("ncPersonStep"));
  $("ncCreateGroup").addEventListener("click", () => ncShow("ncGroupStep"));
  document
    .querySelectorAll(".nc-back")
    .forEach((b) => b.addEventListener("click", () => ncShow("ncHome")));

  const groupSelected = new Map();
  function renderGroupChips() {
    const box = $("groupChips");
    box.innerHTML = "";
    for (const p of groupSelected.values()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = peerName(p) + " ✕";
      chip.addEventListener("click", () => {
        groupSelected.delete(p.id);
        renderGroupChips();
      });
      box.appendChild(chip);
    }
  }
  $("groupMemberSearch").addEventListener(
    "input",
    debounce(async () => {
      const box = $("groupMemberResults");
      box.innerHTML = "";
      for (const p of await findPeople($("groupMemberSearch").value, [
        ...groupSelected.keys(),
      ])) {
        box.appendChild(
          personButton(p, () => {
            groupSelected.set(p.id, p);
            renderGroupChips();
            box.innerHTML = "";
            $("groupMemberSearch").value = "";
          }),
        );
      }
    }),
  );
  $("createGroupBtn").addEventListener("click", async () => {
    const name = $("groupNameInput").value.trim();
    if (!name) return toast("Give your group a name.");
    if (!groupSelected.size) return toast("Add at least one person.");
    try {
      const id = await rpcOrThrow("create_group", {
        group_name: name,
        member_ids: [...groupSelected.keys()],
      });
      groupSelected.clear();
      renderGroupChips();
      $("groupNameInput").value = "";
      await loadChats();
      const group = lastPeers.find((p) => p.conversationId === id);
      if (group) await openConversation(group, id);
    } catch (err) {
      toast("Couldn't create group: " + err.message);
    }
  });

  // Group info panel
  const myGroupRole = () =>
    groupMembers.find((m) => m.user_id === currentUser.id)?.role;
  async function openGroupPanel() {
    await loadGroupMembers();
    renderGroupPanel();
    $("groupPanel").classList.remove("hidden");
  }
  function renderGroupPanel() {
    const role = myGroupRole();
    const isAdmin = role === "owner" || role === "admin";
    setAvatar($("groupAvatar"), activePeer);
    $("groupTitle").textContent = peerName(activePeer);
    $("groupCount").textContent = groupMembers.length + " members";
    $("groupNameEdit").value = peerName(activePeer);
    $("groupAdminTools").classList.toggle("hidden", !isAdmin);
    $("groupAddWrap").classList.toggle("hidden", !isAdmin);
    const list = $("groupMembers");
    list.innerHTML = "";
    for (const m of groupMembers) {
      const you = m.user_id === currentUser.id;
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML = `<span class="user-avatar">${avatarInner(m)}</span><span class="member-name"><strong>${escapeHtml(peerName(m))}${you ? " (you)" : ""}</strong><small class="muted">@${escapeHtml(m.username)}</small></span>${m.role !== "member" ? `<span class="role-badge">${m.role}</span>` : ""}`;
      const actions = document.createElement("span");
      actions.className = "member-actions";
      const addAction = (label, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mini-btn";
        b.textContent = label;
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await fn();
            await loadGroupMembers();
            renderGroupPanel();
          } catch (err) {
            toast(err.message);
          }
        });
        actions.appendChild(b);
      };
      const args = {
        target_conversation_id: activeConversation,
        member_id: m.user_id,
      };
      if (!you && role === "owner" && m.role !== "owner")
        addAction(m.role === "admin" ? "Remove admin" : "Make admin", () =>
          rpcOrThrow("set_group_member_role", {
            ...args,
            new_role: m.role === "admin" ? "member" : "admin",
          }),
        );
      if (
        !you &&
        ((role === "owner" && m.role !== "owner") ||
          (role === "admin" && m.role === "member"))
      )
        addAction("Remove", () => rpcOrThrow("remove_group_member", args));
      row.appendChild(actions);
      if (!you)
        row.addEventListener("click", () =>
          openPeerProfile({ id: m.user_id, ...m }),
        );
      list.appendChild(row);
    }
  }
  $("groupBack").addEventListener("click", () =>
    $("groupPanel").classList.add("hidden"),
  );
  $("groupRenameBtn").addEventListener("click", async () => {
    const name = $("groupNameEdit").value.trim();
    if (!name) return toast("Group name can't be empty.");
    try {
      await rpcOrThrow("update_group", {
        target_conversation_id: activeConversation,
        new_name: name,
      });
      activePeer.display_name = activePeer.username = name;
      $("peerName").textContent = name;
      renderGroupPanel();
      loadChats();
      toast("Group renamed.");
    } catch (err) {
      toast("Couldn't rename: " + err.message);
    }
  });
  $("groupAvatarInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024)
      return toast("Choose an image under 2 MB.");
    const ext = (file.name.split(".").pop() || "jpg")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    const path = `${currentUser.id}/group-${activeConversation}-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(path, file, { contentType: file.type });
    if (upErr) return toast("Upload failed: " + upErr.message);
    const url = supabase.storage.from("avatars").getPublicUrl(path)
      .data.publicUrl;
    try {
      await rpcOrThrow("update_group", {
        target_conversation_id: activeConversation,
        new_avatar_url: url,
      });
      activePeer.avatar_url = url;
      setAvatar($("peerAvatar"), activePeer);
      renderGroupPanel();
      loadChats();
    } catch (err) {
      toast("Couldn't save photo: " + err.message);
    }
  });
  $("groupAddSearch").addEventListener(
    "input",
    debounce(async () => {
      const box = $("groupAddResults");
      box.innerHTML = "";
      for (const p of await findPeople(
        $("groupAddSearch").value,
        groupMembers.map((m) => m.user_id),
      )) {
        box.appendChild(
          personButton(p, async () => {
            try {
              await rpcOrThrow("add_group_members", {
                target_conversation_id: activeConversation,
                member_ids: [p.id],
              });
              box.innerHTML = "";
              $("groupAddSearch").value = "";
              await loadGroupMembers();
              renderGroupPanel();
              toast(peerName(p) + " added.");
            } catch (err) {
              toast("Couldn't add: " + err.message);
            }
          }),
        );
      }
    }),
  );
  $("leaveGroupBtn").addEventListener("click", async () => {
    if (!window.confirm("Leave this group?")) return;
    try {
      await rpcOrThrow("leave_group", {
        target_conversation_id: activeConversation,
      });
      closeActiveChat();
      toast("You left the group.");
    } catch (err) {
      toast("Couldn't leave: " + err.message);
    }
  });

  // ---- Online status, last seen, and other people's profiles ----
  let onlineIds = new Set(),
    peerLastSeen = null,
    peerIsTyping = false,
    presenceChannel = null,
    heartbeat = null,
    dotTimer = null,
    profilePeer = null;
  const isOnline = (id) =>
    appSettings.show_last_seen !== false && onlineIds.has(id);

  function formatLastSeen(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (d.toDateString() === now.toDateString())
      return "last seen today at " + time;
    if (d.toDateString() === new Date(now - 864e5).toDateString())
      return "last seen yesterday at " + time;
    return (
      "last seen " +
      d.toLocaleDateString([], { day: "numeric", month: "short" })
    );
  }
  function presenceText(id, lastSeen) {
    if (appSettings.show_last_seen === false) return "";
    if (onlineIds.has(id)) return "Online";
    return lastSeen ? formatLastSeen(lastSeen) : "";
  }
  function refreshPeerStatus() {
    if (!activePeer || peerIsTyping) return;
    if (activePeer.isGroup) {
      $("peerStatus").textContent = groupMembers.length
        ? groupMembers.length + " members"
        : "Group chat";
      $("peerStatus").classList.remove("online");
      return;
    }
    const t = presenceText(activePeer.id, peerLastSeen);
    $("peerStatus").textContent = t || "Private conversation";
    $("peerStatus").classList.toggle("online", t === "Online");
  }
  async function loadPeerPresence(peerId) {
    const { data } = await supabase
      .from("profiles")
      .select("last_seen_at")
      .eq("id", peerId)
      .maybeSingle();
    if (activePeer?.id === peerId) peerLastSeen = data?.last_seen_at || null;
  }

  async function beat() {
    if (!currentUser || appSettings.show_last_seen === false) return;
    await supabase
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", currentUser.id);
  }
  function startPresence() {
    if (presenceChannel || !currentUser) return;
    presenceChannel = supabase.channel("online-users", {
      config: { presence: { key: currentUser.id } },
    });
    presenceChannel
      .on("presence", { event: "sync" }, () => {
        onlineIds = new Set(Object.keys(presenceChannel.presenceState()));
        refreshPeerStatus();
        clearTimeout(dotTimer);
        dotTimer = setTimeout(loadChats, 800);
        if (activePeer && !activePeer.isGroup)
          loadPeerPresence(activePeer.id).then(refreshPeerStatus);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && appSettings.show_last_seen !== false)
          await presenceChannel.track({ at: Date.now() });
      });
    beat();
    heartbeat = setInterval(beat, 60000);
  }
  function stopPresence() {
    clearInterval(heartbeat);
    if (presenceChannel) supabase.removeChannel(presenceChannel);
    presenceChannel = null;
    onlineIds = new Set();
  }
  document.addEventListener("visibilitychange", beat);

  $("lastSeenToggle").addEventListener("change", async (e) => {
    const ok = await saveSetting({ show_last_seen: e.target.checked });
    if (!ok) return (e.target.checked = !e.target.checked);
    if (e.target.checked) {
      await presenceChannel?.track({ at: Date.now() });
      beat();
    } else {
      await presenceChannel?.untrack();
      await supabase
        .from("profiles")
        .update({ last_seen_at: null })
        .eq("id", currentUser.id);
    }
    refreshPeerStatus();
    loadChats();
  });

  function openLightbox(url) {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="" />`;
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }
  async function openPeerProfile(peer) {
    const { data } = await supabase
      .from("profiles")
      .select("username, display_name, bio, avatar_url, last_seen_at")
      .eq("id", peer.id)
      .maybeSingle();
    const p = { ...peer, ...(data || {}) };
    profilePeer = p;
    setAvatar($("peerProfileAvatar"), p);
    $("peerProfileAvatar").dataset.url = okAvatar(p.avatar_url) || "";
    $("peerProfileAvatar").classList.toggle(
      "clickable",
      Boolean(okAvatar(p.avatar_url)),
    );
    $("peerProfileName").textContent = peerName(p);
    $("peerProfileUser").textContent = "@" + p.username;
    const status = presenceText(p.id, p.last_seen_at);
    $("peerProfileStatus").textContent = status;
    $("peerProfileStatus").classList.toggle("online", status === "Online");
    $("peerProfileBio").textContent = p.bio || "No bio yet.";
    $("peerBlockBtn").textContent = blockedIds.has(p.id)
      ? "Unblock user"
      : "Block user";
    $("peerProfilePanel").classList.remove("hidden");
  }
  $("peerProfileAvatar").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.url) openLightbox(e.currentTarget.dataset.url);
  });
  $("peerProfileBack").addEventListener("click", () =>
    $("peerProfilePanel").classList.add("hidden"),
  );
  $("peerBlockBtn").addEventListener("click", async () => {
    if (!profilePeer) return;
    const isBlocked = blockedIds.has(profilePeer.id);
    if (
      !isBlocked &&
      !window.confirm(
        "Block " +
          peerName(profilePeer) +
          "? They won't be able to message you.",
      )
    )
      return;
    const { error } = isBlocked
      ? await supabase
          .from("user_blocks")
          .delete()
          .eq("blocker_id", currentUser.id)
          .eq("blocked_id", profilePeer.id)
      : await supabase
          .from("user_blocks")
          .insert({ blocker_id: currentUser.id, blocked_id: profilePeer.id });
    if (error) return toast("Couldn't update block: " + error.message);
    await loadBlocks();
    $("peerBlockBtn").textContent = isBlocked ? "Block user" : "Unblock user";
    toast(isBlocked ? "User unblocked." : "User blocked.");
  });
  document.querySelector(".chat-person").addEventListener("click", (e) => {
    if (!activePeer || (innerWidth <= 760 && e.clientX < 45)) return;
    if (activePeer.isGroup) return openGroupPanel();
    openPeerProfile(activePeer);
  });

  // ---- Show / hide password (eye) ----
  (function addPasswordEye() {
    const input = $("password");
    if (!input) return;
    const wrap = document.createElement("div");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const eyeOpen =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOff =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.9 9.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-eye";
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = eyeOpen;
    wrap.appendChild(btn);
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? eyeOff : eyeOpen;
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.setAttribute("aria-pressed", String(show));
      input.focus();
    });
  })();

  // ---- Animations ----
  const animatedIds = new Set();
  function flySend() {
    const btn = $("sendBtn");
    btn.classList.remove("sent");
    void btn.offsetWidth; // restart the animation
    btn.classList.add("sent");
    navigator.vibrate?.(8);
  }
  $("sendBtn").addEventListener("click", () => {
    if ($("messageInput").value.trim()) flySend();
  });
  $("messageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && $("messageInput").value.trim())
      flySend();
  });

  // ---- GIFs and stickers (KLIPY) ----
  const KLIPY_KEY = cfg.KLIPY_API_KEY;
  const FAV_KEY = "chatspace-gif-favs";
  let gifTab = "gifs",
    gifSearchTimer = null;
  const loadFavs = () => {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY)) || [];
    } catch {
      return [];
    }
  };
  const saveFavs = (list) => {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 60)));
    } catch {}
  };
  function klipyUrl(item, sizes) {
    const f = item.file || item.files || {};
    const formats = ["gif", "webp", "png"];
    for (const s of sizes)
      for (const fmt of formats) if (f[s]?.[fmt]?.url) return f[s][fmt].url;
    for (const fmt of formats) if (f[fmt]?.url) return f[fmt].url;
    return null;
  }
  async function fetchKlipy(type, q) {
    if (!KLIPY_KEY) throw new Error("GIF key missing in config.js");
    const params = new URLSearchParams({
      per_page: "24",
      page: "1",
      customer_id: currentUser.id,
    });
    if (q) params.set("q", q);
    const res = await fetch(
      `https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY_KEY)}/${type}/${q ? "search" : "trending"}?${params}`,
    );
    if (!res.ok) throw new Error("GIF service error " + res.status);
    const json = await res.json();
    return (json?.data?.data || [])
      .map((it) => ({
        preview: klipyUrl(it, ["sm", "xs", "md", "hd"]),
        full: klipyUrl(it, ["md", "hd", "sm", "xs"]),
      }))
      .filter((x) => x.preview && x.full);
  }
  async function sendGif(url) {
    if (!activeConversation) return;
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeConversation,
      sender_id: currentUser.id,
      content: null,
      attachment_url: url,
      attachment_type: "image",
      reply_to: replyingToMessage?.id || null,
    });
    if (error)
      return toast(
        error.code === "42501"
          ? "You can't send messages to this person."
          : "Message failed: " + error.message,
      );
    cancelReply();
    $("gifPanel").classList.add("hidden");
    await loadMessages();
    loadChats();
  }
  async function renderGifGrid() {
    const grid = $("gifGrid");
    const q = $("gifSearch").value.trim();
    grid.innerHTML = '<p class="tiny muted">Loading…</p>';
    let items;
    try {
      items = gifTab === "saved" ? loadFavs() : await fetchKlipy(gifTab, q);
    } catch (err) {
      grid.innerHTML = `<p class="tiny muted">Couldn't load: ${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!items.length) {
      grid.innerHTML = `<p class="tiny muted">${gifTab === "saved" ? "Tap ★ on a GIF to save it here." : "Nothing found."}</p>`;
      return;
    }
    grid.innerHTML = "";
    const favs = loadFavs();
    for (const item of items) {
      const cell = document.createElement("div");
      cell.className = "gif-cell";
      const isFav = favs.some((f) => f.full === item.full);
      cell.innerHTML = `<img src="${escapeHtml(item.preview)}" alt="" loading="lazy" /><button type="button" class="gif-star${isFav ? " on" : ""}" aria-label="Save">★</button>`;
      cell
        .querySelector("img")
        .addEventListener("click", () => sendGif(item.full));
      cell.querySelector(".gif-star").addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = loadFavs();
        const has = cur.some((f) => f.full === item.full);
        saveFavs(
          has ? cur.filter((f) => f.full !== item.full) : [item, ...cur],
        );
        e.target.classList.toggle("on", !has);
        if (gifTab === "saved") renderGifGrid();
      });
      grid.appendChild(cell);
    }
  }
  (function buildGifPanel() {
    const panel = document.createElement("div");
    panel.id = "gifPanel";
    panel.className = "gif-panel hidden";
    panel.innerHTML = `<div class="gif-tabs">
        <button type="button" data-gt="gifs" class="active">GIFs</button>
        <button type="button" data-gt="stickers">Stickers</button>
        <button type="button" data-gt="saved">Saved</button>
      </div>
      <input id="gifSearch" placeholder="Search KLIPY" aria-label="Search KLIPY" />
      <div id="gifGrid" class="gif-grid"></div>
      <small class="muted">Powered by KLIPY</small>`;
    $("composer").insertBefore(
      panel,
      $("composer").querySelector(".composer-row"),
    );
    panel.querySelectorAll("[data-gt]").forEach((b) =>
      b.addEventListener("click", () => {
        gifTab = b.dataset.gt;
        panel
          .querySelectorAll("[data-gt]")
          .forEach((x) => x.classList.toggle("active", x === b));
        $("gifSearch").classList.toggle("hidden", gifTab === "saved");
        renderGifGrid();
      }),
    );
    $("gifSearch").addEventListener("input", () => {
      clearTimeout(gifSearchTimer);
      gifSearchTimer = setTimeout(renderGifGrid, 350);
    });
    $("gifBtn").addEventListener("click", () => {
      const open = panel.classList.toggle("hidden") === false;
      if (open) renderGifGrid();
    });
  })();

  // ---- In-app camera (PC webcam and phones) ----
  let cameraStream = null;
  function closeCamera() {
    cameraStream?.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    document.querySelector(".camera-modal")?.remove();
  }
  $("cameraBtn").addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia) return $("cameraInput").click();
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      return toast(
        "Camera unavailable. Allow camera access in your browser, and check no other app is using it.",
      );
    }
    const modal = document.createElement("div");
    modal.className = "camera-modal";
    modal.innerHTML = `<div class="camera-box">
      <video autoplay playsinline muted></video>
      <div class="camera-actions">
        <button type="button" class="ghost-btn" data-cam="cancel">Cancel</button>
        <button type="button" class="primary-btn" data-cam="snap">Take photo</button>
      </div></div>`;
    document.body.appendChild(modal);
    const video = modal.querySelector("video");
    video.srcObject = cameraStream;
    modal
      .querySelector('[data-cam="cancel"]')
      .addEventListener("click", closeCamera);
    modal.querySelector('[data-cam="snap"]').addEventListener("click", () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      canvas.toBlob(
        (blob) => {
          closeCamera();
          if (!blob) return;
          const file = new File([blob], `photo-${Date.now()}.jpg`, {
            type: "image/jpeg",
          });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          $("fileInput").files = transfer.files;
          $("fileInput").dispatchEvent(new Event("change"));
        },
        "image/jpeg",
        0.9,
      );
    });
  });

  $("cameraInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    $("fileInput").files = transfer.files;
    $("fileInput").dispatchEvent(new Event("change"));
  });

  $("fileInput").addEventListener("change", (event) => {
    selectedFile = event.target.files?.[0] || null;

    if (!selectedFile) {
      $("attachmentPreview").classList.add("hidden");
      return;
    }

    if (selectedFile.size > 50 * 1024 * 1024) {
      toast("Choose a file smaller than 50 MB.");
      selectedFile = null;
      event.target.value = "";
      $("attachmentPreview").classList.add("hidden");
      return;
    }

    $("attachmentPreview").textContent =
      `Ready to share: ${selectedFile.name} — press Send to upload`;

    $("attachmentPreview").classList.remove("hidden");
  });

  $("recordBtn").addEventListener("click", async () => {
    if (!activeConversation) {
      toast("Choose a conversation first.");
      return;
    }
    if (mediaRecorder?.state === "recording") {
      mediaRecorder.stop();
      $("recordBtn").classList.remove("recording");
      $("recordBtn").textContent = "🎙";
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast("Voice recording isn't supported by this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size) recordingChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordingChunks, {
          type: mediaRecorder.mimeType || "audio/webm",
        });
        if (blob.size > 50 * 1024 * 1024) {
          toast("Voice note is too large. Record a shorter note.");
          return;
        }
        await sendMessage(
          "",
          new File([blob], `voice-note-${Date.now()}.webm`, {
            type: blob.type,
          }),
          "audio",
        );
      };
      mediaRecorder.start();
      $("recordBtn").classList.add("recording");
      $("recordBtn").textContent = "■";
      toast("Recording… press the button again to send your voice note.");
    } catch {
      toast("Microphone permission was denied or unavailable.");
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    stopPresence();
    endCall("logout");
    stopCallListener();
    lockUnlocked = false;
    clearOfflineCache();
    outbox = [];
    updateOfflineBanner();
    if (listChannel) {
      supabase.removeChannel(listChannel);
      listChannel = null;
    }
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    await supabase.auth.signOut();
    currentUser = currentProfile = activePeer = activeConversation = null;
    appScreen.classList.remove("chat-open");
    showAuth();
    $("password").value = "";
    $("password").type = "password";
    authMessage("You've logged out.");
  });
  // Mobile back navigation: tapping the chat header's leading chevron returns to the chat list.
  document.querySelector(".chat-header").addEventListener("click", (e) => {
    if (window.innerWidth <= 760 && e.clientX < 45)
      appScreen.classList.remove("chat-open");
  });

  // Open a private conversation with ChatSpace support
  $("supportLink").addEventListener("click", async (e) => {
    e.preventDefault();

    if (!currentUser) {
      toast("Please log in first.");
      return;
    }

    toast("Searching for the support account...");

    const { data, error } = await supabase
      .from("profiles")
      .select("id, username")
      .ilike("username", "cyber-ace")
      .maybeSingle();

    console.log("Support profile:", data);
    console.log("Support lookup error:", error);

    if (error) {
      console.error("Supabase lookup failed:", error);
      toast("Database error. Check the browser console.");
      return;
    }

    if (!data) {
      toast("Support profile not visible. Testing username search...");

      const { data: results, error: searchError } = await supabase
        .from("profiles")
        .select("id, username")
        .ilike("username", "%cyber%");

      console.log("Search results:", results);
      console.log("Search error:", searchError);

      if (searchError) {
        toast("Profile search error: " + searchError.message);
      } else if (results?.length) {
        toast("Found: " + results.map((p) => p.username).join(", "));
      } else {
        toast("No profiles visible to this account.");
      }

      return;
    }

    if (data.id === currentUser.id) {
      toast("You're logged in as the support account.");
      return;
    }

    await startConversation(data);
  });
  $("recentChatsBtn").addEventListener("click", () => setListView("recent"));
  $("archivedChatsBtn").addEventListener("click", async () => {
    setListView("archived");
    await loadChats();
  });
  $("lockedChatsBtn").addEventListener("click", async () => {
    if (!(await unlockLocked())) return;
    setListView("locked");
    await loadChats();
  });
  $("lockNowBtn").addEventListener("click", () => relock());

  // ---- Navigation and profile page ----
  function showView(view) {
    const isProfile = view === "profile";
    $("profilePanel").classList.toggle("hidden", !isProfile);
    $("peerProfilePanel").classList.add("hidden");
    $("groupPanel").classList.add("hidden");
    $("newChatPanel").classList.toggle("hidden", view !== "new");
    if (view === "new") ncShow("ncHome");
    $("settingsPanel").classList.toggle("hidden", view !== "settings");
    if (view === "settings") {
      loadSettings();
      const emailField = $("accountEmailInput");
      if (emailField && currentUser) emailField.value = currentUser.email || "";
    }
    document
      .querySelectorAll(".nav-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.nav === view));
    if (isProfile) {
      setAvatar($("profileAvatar"), currentProfile);
      $("profileUsername").textContent = currentProfile.username;
      $("displayNameInput").value = currentProfile.display_name || "";
      $("bioInput").value = currentProfile.bio || "";
    }
  }
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));

  function refreshMyProfileUi() {
    $("myUsername").textContent = peerName(currentProfile);
    setAvatar($("myAvatar"), currentProfile);
    setAvatar($("profileAvatar"), currentProfile);
  }

  $("saveProfileBtn").addEventListener("click", async () => {
    const { data, error } = await supabase
      .from("profiles")
      .update({
        display_name: $("displayNameInput").value.trim() || null,
        bio: $("bioInput").value.trim() || null,
      })
      .eq("id", currentUser.id)
      .select()
      .single();
    if (error) return toast("Could not save profile: " + error.message);
    currentProfile = data;
    refreshMyProfileUi();
    loadChats();
    toast("Profile saved.");
  });

  async function shareProfile(profile) {
    if (!profile?.username) return toast("Profile username is unavailable.");
    const link = new URL(location.pathname, location.origin);
    link.searchParams.set("user", profile.username);
    const shareUrl = link.toString();
    const shareData = {
      title: `${profile.display_name || profile.username} on ChatSpace`,
      text: `Find ${profile.display_name || profile.username} on ChatSpace (@${profile.username})`,
      url: shareUrl,
    };
    try {
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share(shareData);
        return;
      }
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const field = document.createElement("textarea");
        field.value = shareUrl;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("Clipboard unavailable");
      }
      toast("Profile link copied. You can now share it.");
    } catch (error) {
      if (error.name !== "AbortError")
        toast("Sharing failed. Copy this link: " + shareUrl);
    }
  }
  // Optional recovery email: updates Supabase Auth only when the user enters one.
  const accountEmailInput = $("accountEmailInput");
  const accountEmailStatus = $("accountEmailStatus");
  if (accountEmailInput && currentUser)
    accountEmailInput.value = currentUser.email || "";
  $("saveAccountEmailBtn")?.addEventListener("click", async () => {
    const email = accountEmailInput?.value.trim() || "";
    if (!email)
      return toast(
        "Email is optional. Enter one only if you want recovery by email.",
      );
    const { error } = await supabase.auth.updateUser({ email });
    if (error) {
      if (accountEmailStatus) accountEmailStatus.textContent = error.message;
      return toast("Could not update email: " + error.message);
    }
    if (accountEmailStatus)
      accountEmailStatus.textContent =
        "Check your inbox if email confirmation is enabled.";
    toast("Email update requested.");
  });
  $("shareMyProfileBtn")?.addEventListener("click", () =>
    shareProfile(currentProfile),
  );
  $("sharePeerProfileBtn")?.addEventListener("click", () =>
    shareProfile(profilePeer || activePeer),
  );
  $("fullscreenBtn")?.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement)
        await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      toast("Full screen is not available in this browser.");
    }
  });
  const scaleInput = $("textScaleInput");
  if (scaleInput) {
    const savedScale = Number(
      localStorage.getItem("chatspace-ui-scale") || 100,
    );
    scaleInput.value = String(Math.min(120, Math.max(90, savedScale)));
    document.documentElement.style.setProperty(
      "--ui-scale",
      `${scaleInput.value}%`,
    );
    if ($("textScaleValue"))
      $("textScaleValue").textContent = `${scaleInput.value}%`;
    scaleInput.addEventListener("input", () => {
      document.documentElement.style.setProperty(
        "--ui-scale",
        `${scaleInput.value}%`,
      );
      if ($("textScaleValue"))
        $("textScaleValue").textContent = `${scaleInput.value}%`;
      localStorage.setItem("chatspace-ui-scale", scaleInput.value);
    });
  }

  $("avatarInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast("Choose an image file.");
    if (file.size > 2 * 1024 * 1024) return toast("Photo must be under 2 MB.");
    const ext = (file.name.split(".").pop() || "jpg")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    const path = `${currentUser.id}/avatar-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) return toast("Upload failed: " + upErr.message);
    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
    const { data, error } = await supabase
      .from("profiles")
      .update({ avatar_url: pub.publicUrl })
      .eq("id", currentUser.id)
      .select()
      .single();
    if (error) return toast("Could not save photo: " + error.message);
    currentProfile = data;
    refreshMyProfileUi();
    toast("Photo updated.");
  });

  // ---- Read receipts, typing indicator, blocking, settings ----
  let peerReadAt = null,
    blockedIds = new Set(),
    readsChannel = null,
    typingChannel = null,
    typingTimer = null,
    lastTypingSent = 0;

  function setTick(el) {
    if (el.dataset.pending) {
      el.textContent = " 🕒";
      return;
    }
    const read = peerReadAt && new Date(el.dataset.ts) <= peerReadAt;
    el.textContent = read ? " ✓✓" : " ✓";
    el.classList.toggle("read", Boolean(read));
  }
  function updateTicks() {
    document.querySelectorAll("#messages .tick").forEach(setTick);
  }
  async function fetchReadState() {
    if (activePeer?.isGroup) {
      peerReadAt = null;
      return updateTicks();
    }
    const { data, error } = await supabase.rpc("get_read_state", {
      target_conversation_id: activeConversation,
    });
    if (error) return;
    const times = (data || [])
      .map((r) => (r.last_read_at ? new Date(r.last_read_at) : null))
      .filter(Boolean);
    peerReadAt = times.length ? new Date(Math.max(...times)) : null;
    updateTicks();
  }

  async function loadBlocks() {
    const { data } = await supabase
      .from("user_blocks")
      .select("blocked_id")
      .eq("blocker_id", currentUser.id);
    blockedIds = new Set((data || []).map((r) => r.blocked_id));
    applyBlockState();
  }
  function applyBlockState() {
    const blocked = activePeer && blockedIds.has(activePeer.id);
    const input = $("messageInput");
    input.disabled = Boolean(blocked);
    input.placeholder = blocked
      ? "You blocked this user. Unblock to send messages."
      : "Write a message...";
    $("sendBtn").disabled = Boolean(blocked);
    $("gifBtn").disabled = Boolean(blocked);
  }

  function watchConversationExtras(conversationId) {
    peerReadAt = null;
    clearTimeout(typingTimer);
    if (readsChannel) supabase.removeChannel(readsChannel);
    if (typingChannel) supabase.removeChannel(typingChannel);
    applyBlockState();
    applyWallpaper(activePeer?.preferences?.wallpaper);
    $("callActions").classList.toggle(
      "hidden",
      !activePeer || activePeer.isGroup,
    );
    peerLastSeen = null;
    if (activePeer && !activePeer.isGroup)
      loadPeerPresence(activePeer.id).then(refreshPeerStatus);
    fetchReadState();
    readsChannel = supabase
      .channel("reads-" + conversationId)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_participants",
          filter: `conversation_id=eq.${conversationId}`,
        },
        fetchReadState,
      )
      .subscribe();
    typingChannel = supabase
      .channel("typing-" + conversationId, {
        config: { broadcast: { self: false } },
      })
      .on("broadcast", { event: "typing" }, () => {
        peerIsTyping = true;
        $("peerStatus").textContent = "typing…";
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          peerIsTyping = false;
          refreshPeerStatus();
        }, 3000);
      })
      .subscribe();
  }
  $("messageInput").addEventListener("input", () => {
    if (!typingChannel || Date.now() - lastTypingSent < 2000) return;
    lastTypingSent = Date.now();
    typingChannel.send({
      type: "broadcast",
      event: "typing",
      payload: { user: currentUser.id },
    });
  });

  // ---- Personalization: theme, accent, wallpapers, notifications ----
  const WALLPAPERS = {
    none: ["Default", ""],
    aurora: ["Aurora", "linear-gradient(135deg,#1e1b4b,#312e81 55%,#0e7490)"],
    sunset: ["Sunset", "linear-gradient(135deg,#4c1d95,#be185d 60%,#f97316)"],
    forest: ["Forest", "linear-gradient(135deg,#052e16,#166534)"],
    ocean: ["Ocean", "linear-gradient(160deg,#0c4a6e,#0e7490)"],
    sand: ["Sand", "linear-gradient(135deg,#f5efe3,#e7d9bd)"],
  };
  const ACCENTS = [
    "#7775ff",
    "#2563eb",
    "#0ea5a4",
    "#16a34a",
    "#f97316",
    "#e11d48",
    "#c026d3",
  ];
  let appSettings = {
    theme: "dark",
    accent_color: "#7775ff",
    notifications_enabled: true,
    notification_sound: true,
  };
  let lastPeers = [];

  function applyAppearance() {
    const t = appSettings.theme;
    const resolved =
      t === "system"
        ? matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : t;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.setProperty(
      "--accent",
      appSettings.accent_color,
    );
    document.documentElement.style.colorScheme = resolved;
  }
  matchMedia("(prefers-color-scheme: light)").addEventListener(
    "change",
    applyAppearance,
  );

  async function loadAppearance() {
    const { data } = await supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (data) {
      appSettings = { ...appSettings, ...data };
      cacheSet("settings", data);
    } else if (cacheGet("settings"))
      appSettings = { ...appSettings, ...cacheGet("settings") };
    applyAppearance();
    startPresence();
    startCallListener();
  }
  async function saveSetting(changes) {
    appSettings = { ...appSettings, ...changes };
    applyAppearance();
    renderSettingsUi();
    const { error } = await supabase.from("user_settings").upsert({
      user_id: currentUser.id,
      ...changes,
      updated_at: new Date().toISOString(),
    });
    if (error) toast("Could not save setting: " + error.message);
    return !error;
  }
  function renderSettingsUi() {
    document
      .querySelectorAll("[data-theme-choice]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          b.dataset.themeChoice === appSettings.theme,
        ),
      );
    document
      .querySelectorAll("[data-accent]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          b.dataset.accent === appSettings.accent_color,
        ),
      );
    $("soundToggle").checked = appSettings.notification_sound;
    $("lastSeenToggle").checked = appSettings.show_last_seen !== false;
    const hasPin = Boolean(appSettings.chat_lock_hash);
    $("pinStatus").textContent = hasPin ? "A PIN is set." : "No PIN set yet.";
    $("pinSetBtn").textContent = hasPin ? "Change PIN" : "Set PIN";
    $("pinRemoveBtn").classList.toggle("hidden", !hasPin);
    $("notifyToggle").checked =
      appSettings.notifications_enabled &&
      "Notification" in window &&
      Notification.permission === "granted";
  }
  async function loadSettings() {
    const { data } = await supabase
      .from("user_settings")
      .select("show_read_receipts")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    $("receiptsToggle").checked = data?.show_read_receipts ?? true;
    renderSettingsUi();
  }
  $("receiptsToggle").addEventListener("change", async (e) => {
    const ok = await saveSetting({ show_read_receipts: e.target.checked });
    if (!ok) e.target.checked = !e.target.checked;
  });
  document
    .querySelectorAll("[data-theme-choice]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        saveSetting({ theme: b.dataset.themeChoice }),
      ),
    );
  $("accentRow").innerHTML = ACCENTS.map(
    (c) =>
      `<button type="button" class="swatch" data-accent="${c}" style="background:${c}" aria-label="Accent ${c}"></button>`,
  ).join("");
  document
    .querySelectorAll("[data-accent]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        saveSetting({ accent_color: b.dataset.accent }),
      ),
    );
  $("soundToggle").addEventListener("change", (e) =>
    saveSetting({ notification_sound: e.target.checked }),
  );
  $("notifyToggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!("Notification" in window)) {
        e.target.checked = false;
        return toast("This browser doesn't support notifications.");
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        e.target.checked = false;
        return toast("Notifications are blocked in your browser settings.");
      }
    }
    saveSetting({ notifications_enabled: e.target.checked });
  });

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }
  function notifyIncoming(msg) {
    const peer = lastPeers.find(
      (p) => p.conversationId === msg.conversation_id,
    );
    if (peer?.preferences?.is_muted) return;
    if (appSettings.notification_sound) beep();
    const locked = Boolean(peer?.preferences?.is_locked);
    const title = locked ? "ChatSpace" : peer ? peerName(peer) : "New message";
    const body = locked ? "New message" : msg.content || "Sent an attachment";
    const canPopup =
      appSettings.notifications_enabled &&
      "Notification" in window &&
      Notification.permission === "granted";
    if (document.hidden && canPopup) {
      const opts = {
        body,
        icon: "/icons/icon-192.png",
        tag: msg.conversation_id,
      };
      if (navigator.serviceWorker?.ready) {
        navigator.serviceWorker.ready
          .then((reg) => reg.showNotification(title, opts))
          .catch(() => new Notification(title, opts));
      } else new Notification(title, opts);
    } else if (!document.hidden && msg.conversation_id !== activeConversation) {
      toast(title + ": " + body);
    }
  }

  function applyWallpaper(key) {
    const css = (WALLPAPERS[key] || WALLPAPERS.none)[1];
    $("messages").style.background = css;
  }
  function openWallpaperPicker(peer) {
    document.querySelectorAll(".wallpaper-picker").forEach((n) => n.remove());
    const box = document.createElement("div");
    box.className = "wallpaper-picker";
    box.innerHTML =
      "<h3>Chat wallpaper</h3><div class='wp-grid'></div><button type='button' class='ghost-btn'>Close</button>";
    for (const [key, [label, css]] of Object.entries(WALLPAPERS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wp-swatch";
      b.style.background = css || "var(--panel2)";
      b.textContent = label;
      b.addEventListener("click", async () => {
        try {
          await saveChatPreference(peer.conversationId, { wallpaper: key });
          peer.preferences = { ...(peer.preferences || {}), wallpaper: key };
          if (activeConversation === peer.conversationId) applyWallpaper(key);
          box.remove();
          loadChats();
        } catch (err) {
          toast("Couldn't save wallpaper: " + err.message);
        }
      });
      box.querySelector(".wp-grid").appendChild(b);
    }
    box
      .querySelector(".ghost-btn")
      .addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }

  // Safety net: if startup stalls, show the login screen rather than a blank page.
  setTimeout(() => {
    if (
      authScreen.classList.contains("hidden") &&
      appScreen.classList.contains("hidden")
    )
      showAuth();
  }, 8000);

  async function init() {
    if (!configReady) {
      showAuth();
      authMessage(
        "Add your Supabase URL and publishable key in config.js to connect ChatSpace.",
      );
      return;
    }
    if (!window.supabase?.createClient) {
      showAuth();
      authMessage(
        "Could not load Supabase client. Check your internet connection.",
      );
      return;
    }
    supabase = window.supabase.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_PUBLISHABLE_KEY,
    );
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session) {
      currentUser = session.user;
      cacheSet("user", {
        id: session.user.id,
        user_metadata: session.user.user_metadata,
      });
      try {
        await loadCurrentProfile();
        showApp();
        await loadChats();
      } catch (e) {
        showAuth();
        authMessage(e.message, true);
      }
    } else if (!navigator.onLine && cacheGet("user")) {
      // Offline start: open the app from what is saved on this device.
      currentUser = cacheGet("user");
      try {
        await loadCurrentProfile();
        showApp();
        await loadChats();
      } catch (e) {
        showAuth();
        authMessage(e.message, true);
      }
    } else showAuth();
    supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session) return;
      currentUser = session.user;
    });
  }
  init();
})();
