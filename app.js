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
    authScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
  }
  function showApp() {
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
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .maybeSingle();
    if (error) throw error;
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
    $("myUsername").textContent = currentProfile.username;
    $("myAvatar").textContent = currentProfile.username[0].toUpperCase();
  }

  async function getChatPreferences(conversationIds) {
    if (!conversationIds.length) return new Map();

    const { data, error } = await supabase
      .from("chat_preferences")
      .select(
        "conversation_id,is_pinned,is_archived,is_deleted,is_muted,is_locked",
      )
      .eq("user_id", currentUser.id)
      .in("conversation_id", conversationIds);

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
      const { error } = await supabase
        .from("chat_preferences")
        .update({
          ...changes,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", currentUser.id)
        .eq("conversation_id", conversationId);

      if (error) throw error;
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
    const { data: rows, error } = await supabase
      .from("conversation_participants")
      .select("conversation_id,user_id")
      .eq("user_id", currentUser.id);

    if (error) {
      toast("Couldn't load chats: " + error.message);
      return;
    }

    const peers = [];

    for (const row of rows || []) {
      const { data: members, error: membersError } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", row.conversation_id);

      if (membersError) continue;

      const peer = (members || []).find(
        (member) => member.user_id !== currentUser.id,
      );

      if (!peer) continue;

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id,username")
        .eq("id", peer.user_id)
        .maybeSingle();

      if (
        profileError ||
        !profile ||
        peers.some((item) => item.conversationId === row.conversation_id)
      ) {
        continue;
      }

      peers.push({
        ...profile,
        conversationId: row.conversation_id,
      });
    }

    const conversationIds = peers.map((peer) => peer.conversationId);

    const preferences = await getChatPreferences(conversationIds);

    // Find the latest message in each conversation.
    const latestTimes = new Map();

    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const { data, error } = await supabase
          .from("messages")
          .select("created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .limit(1);

        latestTimes.set(
          conversationId,
          !error && data?.length ? new Date(data[0].created_at).getTime() : 0,
        );
      }),
    );

    const allPeers = peers
      .map((peer) => ({
        ...peer,
        preferences: preferences.get(peer.conversationId) || {},
        latestTime: latestTimes.get(peer.conversationId) || 0,
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

    const recentPeers = allPeers.filter(
      (peer) => !peer.preferences.is_archived,
    );

    const archivedPeers = allPeers.filter(
      (peer) => peer.preferences.is_archived,
    );

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

    $("chatList").classList.toggle("hidden", showingArchivedChats);
    $("archivedChatList").classList.toggle("hidden", !showingArchivedChats);

    $("recentChatsBtn").classList.toggle("active", !showingArchivedChats);

    $("archivedChatsBtn").classList.toggle("active", showingArchivedChats);
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

      item.innerHTML = `
        <span class="user-avatar">
          ${escapeHtml(peer.username[0].toUpperCase())}
        </span>

        <span class="chat-item-details">
          <strong>
            ${escapeHtml(peer.username)}
            ${markers}
          </strong>

          <small>
            ${peer.latestTime ? "Recent conversation" : "Open conversation"}
          </small>
        </span>

        <button
          type="button"
          class="chat-menu-trigger"
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
      .querySelectorAll(".chat-context-menu")
      .forEach((menu) => menu.remove());

    const prefs = peer.preferences || {};

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    const actions = [
      [prefs.is_pinned ? "Unpin chat" : "Pin chat", "pin"],
      [prefs.is_archived ? "Restore chat" : "Archive chat", "archive"],
      [prefs.is_muted ? "Unmute chat" : "Mute chat", "mute"],
      ["Delete chat from my list", "delete"],
    ];

    for (const [label, action] of actions) {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "chat-context-action";
      button.textContent = label;

      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        menu.remove();

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

    anchor.appendChild(menu);

    const closeMenu = (event) => {
      if (!menu.contains(event.target) && !anchor.contains(event.target)) {
        menu.remove();
        document.removeEventListener("click", closeMenu);
      }
    };

    setTimeout(() => {
      document.addEventListener("click", closeMenu);
    }, 0);
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
    const { data: existingRows } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", currentUser.id);
    for (const row of existingRows || []) {
      const { data: other } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", row.conversation_id)
        .eq("user_id", peer.id)
        .maybeSingle();
      if (other) {
        await openConversation(peer, row.conversation_id);
        return;
      }
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
    activePeer = peer;
    activeConversation = conversationId;
    $("peerName").textContent = peer.username;
    $("peerAvatar").textContent = peer.username[0].toUpperCase();
    $("peerStatus").textContent = "Private conversation";
    $("welcomePanel").classList.add("hidden");
    $("messages").classList.remove("hidden");
    $("composer").classList.remove("hidden");
    appScreen.classList.add("chat-open");
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
          if (payload.new.sender_id !== currentUser.id)
            renderMessage(payload.new);
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

  async function loadMessages() {
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

  // Add a reaction, remove your existing reaction,
  // or change it to a different emoji.
  async function toggleReaction(message, emoji) {
    if (!currentUser || !activeConversation) {
      toast("Choose a conversation first.");
      return;
    }

    if (message.deleted_for_everyone) {
      toast("You can't react to a deleted message.");
      return;
    }

    const messageId = String(message.id);
    const conversationId = activeConversation;

    const reactions = reactionCache.get(messageId) || [];

    const existing = reactions.find(
      (reaction) => reaction.user_id === currentUser.id,
    );

    try {
      if (existing?.emoji === emoji) {
        // Clicking your selected emoji removes it.
        const { error } = await supabase
          .from("message_reactions")
          .delete()
          .eq("id", existing.id)
          .eq("user_id", currentUser.id);

        if (error) throw error;
      } else if (existing) {
        // Change the existing reaction instead of creating another.
        const { error } = await supabase
          .from("message_reactions")
          .update({ emoji })
          .eq("id", existing.id)
          .eq("user_id", currentUser.id);

        if (error) throw error;
      } else {
        // Add a new reaction.

        const { error } = await supabase.from("message_reactions").upsert(
          {
            message_id: message.id,
            user_id: currentUser.id,
            emoji: emoji,
          },
          {
            onConflict: "message_id,user_id",
          },
        );

        if (error) throw error;
        if (error) {
          console.error("Could not upload reaction:", error);
          alert("Could not save reaction: " + error.message);
          return;
        }
      }

      // Don't update a different conversation if the user switched chats.
      if (conversationId === activeConversation) {
        await refreshVisibleReactions();
      }
    } catch (error) {
      console.error("Reaction update failed:", error);

      toast(
        "Couldn't update reaction: " + (error.message || "Please try again."),
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
    row.dataset.messageId = messageId;

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
      const url = escapeHtml(msg.attachment_url);

      if (msg.attachment_type === "audio") {
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
    const reactionBar = document.createElement("div");
    reactionBar.className = "message-reactions";

    renderReactionBar(msg, reactionBar);

    const meta = document.createElement("span");
    meta.className = "message-meta";

    meta.textContent =
      `${mine ? "You" : activePeer?.username || "User"} · ` +
      new Date(msg.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }) +
      (msg.is_edited ? " · edited" : "");

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
    let attachmentUrl = null,
      finalContent = content.trim();
    if (attachment) {
      if (attachment.size > 10 * 1024 * 1024) {
        toast("File is larger than 10 MB.");
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
      if (attachmentType !== "audio")
        finalContent = attachment.name || "Shared file";
    }
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeConversation,
      sender_id: currentUser.id,
      content: finalContent || null,
      attachment_url: attachmentUrl,
      attachment_type: attachment ? attachmentType : null,
      reply_to: replyingToMessage?.id || null,
    });
    if (error) {
      toast("Message failed: " + error.message);
      return;
    }
    cancelReply();
    await loadMessages();
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

  $("fileInput").addEventListener("change", (event) => {
    selectedFile = event.target.files?.[0] || null;

    if (!selectedFile) {
      $("attachmentPreview").classList.add("hidden");
      return;
    }

    if (selectedFile.size > 10 * 1024 * 1024) {
      toast("Choose a file smaller than 10 MB.");
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
        if (blob.size > 10 * 1024 * 1024) {
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
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    await supabase.auth.signOut();
    currentUser = currentProfile = activePeer = activeConversation = null;
    appScreen.classList.remove("chat-open");
    showAuth();
    $("password").value = "";
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
  $("recentChatsBtn").addEventListener("click", () => {
    showingArchivedChats = false;

    $("recentChatsBtn").classList.add("active");
    $("archivedChatsBtn").classList.remove("active");

    $("chatList").classList.remove("hidden");
    $("archivedChatList").classList.add("hidden");
  });

  $("archivedChatsBtn").addEventListener("click", async () => {
    showingArchivedChats = true;

    $("recentChatsBtn").classList.remove("active");
    $("archivedChatsBtn").classList.add("active");

    $("chatList").classList.add("hidden");
    $("archivedChatList").classList.remove("hidden");

    await loadChats();
  });

  async function init() {
    if (!configReady) {
      showAuth();
      authMessage(
        "Add your Supabase URL and publishable key in config.js to connect ChatSpace.",
      );
      return;
    }
    if (!window.supabase?.createClient) {
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
