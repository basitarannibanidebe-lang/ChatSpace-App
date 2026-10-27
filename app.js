(() => {
  const cfg = window.CHATSPACE_CONFIG || {};
  const configReady = cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_URL.includes("PASTE_") && !cfg.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");
  const $ = (id) => document.getElementById(id);
  const authScreen = $("authScreen"), appScreen = $("appScreen");
  let supabase, currentUser, currentProfile, activePeer, activeConversation;
  let isSignup = false, selectedFile = null, mediaRecorder = null, recordingChunks = [], realtimeChannel = null;
  const usernameEmail = (name) => `${name.toLowerCase()}@users.chatspace.invalid`;
  const cleanUsername = (name) => name.trim().toLowerCase();
  const validUsername = (name) => /^[a-z0-9_]{3,24}$/.test(name);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3200); }
  function authMessage(msg, error=false) { $("authMessage").textContent = msg; $("authMessage").classList.toggle("error", error); }
  function showAuth() { authScreen.classList.remove("hidden"); appScreen.classList.add("hidden"); }
  function showApp() { authScreen.classList.add("hidden"); appScreen.classList.remove("hidden"); }
  function setAuthMode(signup) {
    isSignup = signup; $("loginTab").classList.toggle("active", !signup); $("signupTab").classList.toggle("active", signup);
    $("authSubmit").textContent = signup ? "Create account" : "Log in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    authMessage(signup ? "Username: 3–24 letters, numbers, or underscores." : "");
  }
  $("loginTab").addEventListener("click", () => setAuthMode(false));
  $("signupTab").addEventListener("click", () => setAuthMode(true));

  async function handleAuth(e) {
    e.preventDefault();
    if (!configReady) { authMessage("First add your Supabase URL and publishable key to config.js.", true); return; }
    const username = cleanUsername($("username").value), password = $("password").value;
    if (!validUsername(username)) { authMessage("Username must be 3–24 characters using letters, numbers, or underscores.", true); return; }
    if (password.length < 8) { authMessage("Use a password with at least 8 characters.", true); return; }
    $("authSubmit").disabled = true;
    authMessage(isSignup ? "Creating your account..." : "Logging in...");
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({ email: usernameEmail(username), password, options: { data: { username } } });
        if (error) throw error;
        if (!data.session || !data.user) {
          authMessage("Account request received. If email confirmation is still required, disable it in Supabase Auth settings and try again.", true);
          return;
        }
        const { error: profileError } = await supabase.from("profiles").insert({ id: data.user.id, username });
        if (profileError && profileError.code !== "23505") throw profileError;
        currentUser = data.user;
        await loadCurrentProfile();
        showApp(); await loadChats();
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
        if (error) throw new Error("Login failed. Check your username and password.");
        currentUser = data.user; await loadCurrentProfile(); showApp(); await loadChats();
      }
    } catch (err) {
      authMessage(err.message || "Something went wrong. Please try again.", true);
    } finally { $("authSubmit").disabled = false; }
  }
  $("authForm").addEventListener("submit", handleAuth);

  async function loadCurrentProfile() {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    if (error) throw error;
    if (!data) {
      const name = currentUser.user_metadata?.username;
      if (!name) throw new Error("Your profile is missing. Please contact the site owner.");
      const { data: inserted, error: insertError } = await supabase.from("profiles").insert({id: currentUser.id, username: name}).select().single();
      if (insertError) throw insertError;
      currentProfile = inserted;
    } else currentProfile = data;
    $("myUsername").textContent = currentProfile.username;
    $("myAvatar").textContent = currentProfile.username[0].toUpperCase();
  }

  async function loadChats() {
    const { data: rows, error } = await supabase.from("conversation_participants").select("conversation_id,user_id").eq("user_id", currentUser.id);
    if (error) { toast("Couldn't load chats: " + error.message); return; }
    const list = $("chatList"); list.innerHTML = "";
    const peers = [];
    for (const row of rows || []) {
      const { data: members } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", row.conversation_id);
      const peer = (members || []).find(m => m.user_id !== currentUser.id);
      if (!peer) continue;
      const { data: profile } = await supabase.from("profiles").select("id,username").eq("id", peer.user_id).maybeSingle();
      if (!profile || peers.some(p => p.id === profile.id)) continue;
      peers.push({...profile, conversationId: row.conversation_id});
    }
    if (!peers.length) { list.innerHTML = '<p class="tiny muted" style="padding:8px">Your chats will appear here. Search for a username above to start one.</p>'; return; }
    peers.sort((a,b) => a.username.localeCompare(b.username));
    for (const peer of peers) {
      const btn = document.createElement("button"); btn.className = "chat-item" + (activePeer?.id === peer.id ? " active" : "");
      btn.innerHTML = `<span class="user-avatar">${escapeHtml(peer.username[0].toUpperCase())}</span><span><strong>${escapeHtml(peer.username)}</strong><small>Open conversation</small></span>`;
      btn.addEventListener("click", () => openConversation(peer, peer.conversationId));
      list.appendChild(btn);
    }
  }

  let searchTimer;
  $("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer); searchTimer = setTimeout(searchUsers, 250);
  });
  async function searchUsers() {
    const term = cleanUsername($("userSearch").value), result = $("searchResults");
    result.innerHTML = "";
    if (term.length < 2) return;
    const { data, error } = await supabase.from("profiles").select("id,username").ilike("username", `%${term}%`).neq("id", currentUser.id).limit(8);
    if (error) { toast("User search failed. Check database permissions."); return; }
    for (const person of data || []) {
      const btn = document.createElement("button"); btn.className = "search-item";
      btn.innerHTML = `<span class="user-avatar">${escapeHtml(person.username[0].toUpperCase())}</span><span><strong>${escapeHtml(person.username)}</strong><small>Start a conversation</small></span>`;
      btn.addEventListener("click", () => startConversation(person)); result.appendChild(btn);
    }
    if (!data?.length) result.innerHTML = '<p class="tiny muted" style="padding:8px">No users found.</p>';
  }

  async function startConversation(peer) {
    const { data: existingRows } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
    for (const row of existingRows || []) {
      const { data: other } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", row.conversation_id).eq("user_id", peer.id).maybeSingle();
      if (other) { await openConversation(peer, row.conversation_id); return; }
    }
    const { data: newId, error } = await supabase.rpc("create_private_conversation", { other_user_id: peer.id });
    if (error) { toast("Couldn't start chat: " + error.message); return; }
    $("userSearch").value = ""; $("searchResults").innerHTML = "";
    await loadChats(); await openConversation(peer, newId);
  }

  async function openConversation(peer, conversationId) {
    activePeer = peer; activeConversation = conversationId;
    $("peerName").textContent = peer.username; $("peerAvatar").textContent = peer.username[0].toUpperCase();
    $("peerStatus").textContent = "Private conversation";
    $("welcomePanel").classList.add("hidden"); $("messages").classList.remove("hidden"); $("composer").classList.remove("hidden");
    appScreen.classList.add("chat-open");
    document.querySelectorAll(".chat-item").forEach(el => el.classList.toggle("active", el.textContent.includes(peer.username)));
    await loadMessages();
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    realtimeChannel = supabase.channel("messages-" + conversationId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, payload => {
        if (payload.new.sender_id !== currentUser.id) renderMessage(payload.new);
      }).subscribe();
  }

  async function loadMessages() {
    $("messages").innerHTML = "";
    const { data, error } = await supabase.from("messages").select("*").eq("conversation_id", activeConversation).order("created_at", {ascending:true}).limit(300);
    if (error) { toast("Couldn't load messages: " + error.message); return; }
    for (const msg of data || []) renderMessage(msg);
    scrollMessages();
  }
  function renderMessage(msg) {
    if (document.querySelector(`[data-message-id="${CSS.escape(msg.id)}"]`)) return;
    const mine = msg.sender_id === currentUser.id;
    const row = document.createElement("div"); row.className = "message-row" + (mine ? " mine" : ""); row.dataset.messageId = msg.id;
    let body = msg.content ? `<div>${escapeHtml(msg.content)}</div>` : "";
    if (msg.attachment_url) {
      if (msg.attachment_type === "audio") body += `<audio class="audio-player" controls preload="metadata" src="${escapeHtml(msg.attachment_url)}"></audio>`;
      else {
        const fileName = msg.content || "Shared file";
        body += `<a class="file-card" href="${escapeHtml(msg.attachment_url)}" target="_blank" rel="noopener"><span class="file-icon">${msg.attachment_type === "image" ? "▧" : "📄"}</span><span>${escapeHtml(fileName)}<br><small>Open / download</small></span></a>`;
      }
    }
    row.innerHTML = `<div class="bubble">${body}</div><span class="message-meta">${mine ? "You" : escapeHtml(activePeer?.username || "User")} · ${new Date(msg.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>`;
    $("messages").appendChild(row); scrollMessages();
  }
  function scrollMessages() { $("messages").scrollTop = $("messages").scrollHeight; }

  async function sendMessage(content = "", attachment = null, attachmentType = null) {
    if (!activeConversation) { toast("Choose a conversation first."); return; }
    if (!content.trim() && !attachment) return;
    let attachmentUrl = null, finalContent = content.trim();
    if (attachment) {
      if (attachment.size > 10 * 1024 * 1024) { toast("File is larger than 10 MB."); return; }
      const ext = (attachment.name?.split(".").pop() || (attachmentType === "audio" ? "webm" : "bin")).replace(/[^a-z0-9]/gi,"").toLowerCase();
      const path = `${activeConversation}/${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("chat-attachments").upload(path, attachment, { contentType: attachment.type || "application/octet-stream", upsert: false });
      if (uploadError) { toast("File upload failed: " + uploadError.message); return; }
      const { data: signed, error: signedError } = await supabase.storage.from("chat-attachments").createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signedError) { toast("Could not create file link: " + signedError.message); return; }
      attachmentUrl = signed.signedUrl;
      if (attachmentType !== "audio") finalContent = attachment.name || "Shared file";
    }
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeConversation, sender_id: currentUser.id, content: finalContent || null,
      attachment_url: attachmentUrl, attachment_type: attachment ? attachmentType : null
    });
    if (error) { toast("Message failed: " + error.message); return; }
    await loadMessages();
  }

  $("sendBtn").addEventListener("click", async () => {
    const text = $("messageInput").value;
    $("sendBtn").disabled = true;
    await sendMessage(text);
    $("messageInput").value = ""; $("messageInput").style.height = "auto";
    $("sendBtn").disabled = false;
  });
  $("messageInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("sendBtn").click(); }
  });
  $("messageInput").addEventListener("input", e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight,120) + "px"; });
  $("fileInput").addEventListener("change", e => {
    selectedFile = e.target.files?.[0] || null;
    if (!selectedFile) { $("attachmentPreview").classList.add("hidden"); return; }
    if (selectedFile.size > 10 * 1024 * 1024) { toast("Choose a file smaller than 10 MB."); selectedFile = null; e.target.value = ""; return; }
    $("attachmentPreview").textContent = `Ready to share: ${selectedFile.name} — press Send to upload`;
    $("attachmentPreview").classList.remove("hidden");
    $("sendBtn").onclick = async () => {
      $("sendBtn").disabled = true; await sendMessage("", selectedFile, selectedFile.type.startsWith("image/") ? "image" : "file");
      selectedFile = null; $("fileInput").value = ""; $("attachmentPreview").classList.add("hidden"); $("sendBtn").disabled = false;
      $("sendBtn").onclick = null;
    };
  });
  $("recordBtn").addEventListener("click", async () => {
    if (!activeConversation) { toast("Choose a conversation first."); return; }
    if (mediaRecorder?.state === "recording") { mediaRecorder.stop(); $("recordBtn").classList.remove("recording"); $("recordBtn").textContent = "🎙"; return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Voice recording isn't supported by this browser."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      recordingChunks = []; mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => { if (e.data.size) recordingChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordingChunks, {type: mediaRecorder.mimeType || "audio/webm"});
        if (blob.size > 10 * 1024 * 1024) { toast("Voice note is too large. Record a shorter note."); return; }
        await sendMessage("", new File([blob], `voice-note-${Date.now()}.webm`, {type: blob.type}), "audio");
      };
      mediaRecorder.start(); $("recordBtn").classList.add("recording"); $("recordBtn").textContent = "■";
      toast("Recording… press the button again to send your voice note.");
    } catch { toast("Microphone permission was denied or unavailable."); }
  });

  $("logoutBtn").addEventListener("click", async () => {
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    await supabase.auth.signOut(); currentUser = currentProfile = activePeer = activeConversation = null;
    appScreen.classList.remove("chat-open"); showAuth(); $("password").value = ""; authMessage("You've logged out.");
  });
  // Mobile back navigation: tapping the chat header's leading chevron returns to the chat list.
  document.querySelector(".chat-header").addEventListener("click", e => {
    if (window.innerWidth <= 760 && e.clientX < 45) appScreen.classList.remove("chat-open");
  });

  async function init() {
    if (!configReady) { showAuth(); authMessage("Add your Supabase URL and publishable key in config.js to connect ChatSpace."); return; }
    if (!window.supabase?.createClient) { authMessage("Could not load Supabase client. Check your internet connection."); return; }
    supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      currentUser = session.user;
      try { await loadCurrentProfile(); showApp(); await loadChats(); } catch (e) { showAuth(); authMessage(e.message, true); }
    } else showAuth();
    supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session) return;
      currentUser = session.user;
    });
  }
  init();
})();