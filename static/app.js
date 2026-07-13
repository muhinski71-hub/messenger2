const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  myId: null,
  username: null,
  room: null,
  inVoice: false,
  muted: false,
  localStream: null,      // микрофон
  screenStream: null,     // демонстрация экрана
  peers: {},              // peerId -> { pc, makingOffer, polite }
};

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ---------- Login ----------
$("joinBtn").addEventListener("click", join);
$("username").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
$("room").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

function join() {
  const username = $("username").value.trim();
  const room = $("room").value.trim() || "general";
  if (!username) { $("username").focus(); return; }
  state.username = username;
  state.room = room;
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", username: state.username, room: state.room }));
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => addSystem("Соединение потеряно. Обнови страницу.");
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ---------- Message handling ----------
function handleMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.myId = msg.id;
      $("login").classList.add("hidden");
      $("app").classList.remove("hidden");
      $("roomName").textContent = state.room;
      (msg.history || []).forEach((m) => (m.type === "file" ? renderFile(m) : renderChat(m)));
      renderRoster(msg.roster || []);
      $("messageInput").focus();
      break;
    case "roster": renderRoster(msg.roster || []); break;
    case "chat": renderChat(msg); break;
    case "file": renderFile(msg); break;
    case "system": addSystem(msg.text); break;
    case "voice-peer-join":
      if (state.inVoice) callPeer(msg.id, true);
      break;
    case "voice-peer-leave": closePeer(msg.id); break;
    case "offer":
    case "answer":
    case "candidate":
      onSignal(msg);
      break;
  }
}

// ---------- Chat ----------
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text, ts: Date.now() });
  input.value = "";
});

function renderChat(msg) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "msg" + (msg.id === state.myId ? " own" : "");
  el.appendChild(metaEl(msg));
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = msg.text;
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function metaEl(msg) {
  const meta = document.createElement("div");
  meta.className = "meta";
  const time = msg.ts ? new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const a = document.createElement("span"); a.className = "author"; a.textContent = msg.username;
  const t = document.createElement("span"); t.className = "time"; t.textContent = time;
  meta.appendChild(a); meta.appendChild(t);
  return meta;
}

function addSystem(text) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ---------- File sharing ----------
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  await uploadFile(file);
});

async function uploadFile(file) {
  addSystem(`Загрузка «${file.name}»...`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) { addSystem("Ошибка: " + (data.error || "не удалось загрузить")); return; }
    send({ type: "file", url: data.url, name: data.name, size: data.size, mime: data.mime, ts: Date.now() });
  } catch (err) {
    addSystem("Ошибка загрузки: " + err.message);
  }
}

function humanSize(n) {
  if (!n) return "";
  const u = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}

function renderFile(msg) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "msg" + (msg.id === state.myId ? " own" : "");
  el.appendChild(metaEl(msg));

  const isImage = (msg.mime || "").startsWith("image/");
  if (isImage) {
    const a = document.createElement("a");
    a.href = msg.url; a.target = "_blank";
    const img = document.createElement("img");
    img.src = msg.url; img.className = "file-image"; img.alt = msg.name;
    a.appendChild(img);
    el.appendChild(a);
  } else {
    const card = document.createElement("a");
    card.className = "file-card";
    card.href = msg.url; card.download = msg.name; card.target = "_blank";
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = "📄";
    const info = document.createElement("div"); info.className = "file-info";
    const nm = document.createElement("div"); nm.className = "file-name"; nm.textContent = msg.name;
    const sz = document.createElement("div"); sz.className = "file-size"; sz.textContent = humanSize(msg.size) + " · скачать";
    info.appendChild(nm); info.appendChild(sz);
    card.appendChild(icon); card.appendChild(info);
    el.appendChild(card);
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ---------- Roster ----------
function renderRoster(roster) {
  const ul = $("members");
  ul.innerHTML = "";
  roster.forEach((m) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot" + (m.inVoice ? " voice" : "");
    const name = document.createElement("span");
    name.className = "name"; name.textContent = m.username;
    li.appendChild(dot); li.appendChild(name);
    if (m.id === state.myId) {
      const you = document.createElement("span");
      you.className = "you-badge"; you.textContent = "ты";
      li.appendChild(you);
    }
    ul.appendChild(li);
  });
}

// ---------- Voice + Screen (WebRTC mesh, perfect negotiation) ----------
$("voiceBtn").addEventListener("click", toggleVoice);
$("muteBtn").addEventListener("click", toggleMute);
$("screenBtn").addEventListener("click", toggleScreen);

async function toggleVoice() {
  if (state.inVoice) { leaveVoice(); return; }
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    alert("Не удалось получить доступ к микрофону: " + err.message);
    return;
  }
  state.inVoice = true;
  $("voiceBtn").textContent = "📞 Выйти из голосового";
  $("voiceBtn").classList.add("active");
  $("muteBtn").classList.remove("hidden");
  $("screenBtn").classList.remove("hidden");
  send({ type: "voice-join" });
}

function leaveVoice() {
  state.inVoice = false;
  send({ type: "voice-leave" });
  stopScreen();
  Object.keys(state.peers).forEach(closePeer);
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  $("voiceBtn").textContent = "🎙 Войти в голосовой";
  $("voiceBtn").classList.remove("active");
  $("muteBtn").classList.add("hidden");
  $("screenBtn").classList.add("hidden");
  state.muted = false;
}

function toggleMute() {
  if (!state.localStream) return;
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  $("muteBtn").textContent = state.muted ? "🔊 Вкл. микрофон" : "🔇 Выкл. микрофон";
  $("muteBtn").classList.toggle("muted", state.muted);
}

async function toggleScreen() {
  if (state.screenStream) { stopScreen(); return; }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    return;
  }
  const track = state.screenStream.getVideoTracks()[0];
  track.onended = () => stopScreen();
  Object.values(state.peers).forEach(({ pc }) => pc.addTrack(track, state.screenStream));
  $("screenBtn").textContent = "🛑 Остановить показ";
  $("screenBtn").classList.add("active");
  showScreenTile("local", state.screenStream, state.username + " (ты)");
}

function stopScreen() {
  if (!state.screenStream) return;
  const track = state.screenStream.getVideoTracks()[0];
  Object.values(state.peers).forEach(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track === track);
    if (sender) pc.removeTrack(sender);
  });
  state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  $("screenBtn").textContent = "🖥 Показать экран";
  $("screenBtn").classList.remove("active");
  removeScreenTile("local");
}

function createPeer(peerId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  const entry = { pc, makingOffer: false, polite: state.myId > peerId };
  state.peers[peerId] = entry;

  if (state.localStream) state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  if (state.screenStream) {
    const st = state.screenStream.getVideoTracks()[0];
    if (st) pc.addTrack(st, state.screenStream);
  }

  pc.onnegotiationneeded = async () => {
    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: "offer", target: peerId, sdp: pc.localDescription });
    } catch (e) {} finally { entry.makingOffer = false; }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "candidate", target: peerId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (e.track.kind === "video") {
      showScreenTile(peerId, stream, peerName(peerId));
      e.track.onended = () => removeScreenTile(peerId);
      stream.onremovetrack = () => removeScreenTile(peerId);
    } else {
      let audio = document.getElementById("audio-" + peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = "audio-" + peerId; audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = stream;
    }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) closePeer(peerId);
  };
  return entry;
}

async function callPeer(peerId, isInitiator) {
  if (state.peers[peerId]) return;
  const entry = createPeer(peerId);
  if (isInitiator && !state.localStream && !state.screenStream) {
    // нет медиа для отправки, но всё равно инициируем, чтобы получать
    try {
      await entry.pc.setLocalDescription(await entry.pc.createOffer({ offerToReceiveAudio: true }));
      send({ type: "offer", target: peerId, sdp: entry.pc.localDescription });
    } catch (e) {}
  }
}

async function onSignal(msg) {
  const peerId = msg.from;
  if (!state.inVoice && msg.type === "offer" && !state.peers[peerId]) return;
  let entry = state.peers[peerId];
  if (!entry) entry = createPeer(peerId);
  const pc = entry.pc;

  try {
    if (msg.type === "candidate") {
      if (msg.candidate) { try { await pc.addIceCandidate(msg.candidate); } catch (e) {} }
      return;
    }
    const desc = msg.sdp;
    const offerCollision = desc.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
    if (offerCollision && !entry.polite) return; // невежливый игнорирует

    if (offerCollision) {
      await Promise.all([
        pc.setLocalDescription({ type: "rollback" }).catch(() => {}),
        pc.setRemoteDescription(desc),
      ]);
    } else {
      await pc.setRemoteDescription(desc);
    }
    if (desc.type === "offer") {
      await pc.setLocalDescription();
      send({ type: "answer", target: peerId, sdp: pc.localDescription });
    }
  } catch (e) {}
}

function closePeer(peerId) {
  const entry = state.peers[peerId];
  if (entry) { try { entry.pc.close(); } catch (e) {} delete state.peers[peerId]; }
  const audio = document.getElementById("audio-" + peerId);
  if (audio) audio.remove();
  removeScreenTile(peerId);
}

function peerName() { return "Демонстрация экрана"; }

// ---------- Screen tiles ----------
function showScreenTile(id, stream, label) {
  const wrap = $("screens");
  wrap.classList.remove("hidden");
  let tile = document.getElementById("screen-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "screen-tile";
    tile.id = "screen-" + id;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true; v.muted = id === "local";
    const cap = document.createElement("div"); cap.className = "screen-cap";
    tile.appendChild(v); tile.appendChild(cap);
    wrap.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
  tile.querySelector(".screen-cap").textContent = "🖥 " + label;
}

function removeScreenTile(id) {
  const tile = document.getElementById("screen-" + id);
  if (tile) tile.remove();
  if (!$("screens").children.length) $("screens").classList.add("hidden");
}
