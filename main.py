import json
import uuid
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Messenger")

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_UPLOAD = 50 * 1024 * 1024  # 50 MB


class Peer:
    def __init__(self, peer_id: str, username: str, room: str, ws: WebSocket):
        self.id = peer_id
        self.username = username
        self.room = room
        self.ws = ws
        self.in_voice = False


class Hub:
    def __init__(self):
        self.rooms: Dict[str, Dict[str, Peer]] = {}
        self.history: Dict[str, list] = {}

    def room_peers(self, room: str) -> Dict[str, Peer]:
        return self.rooms.setdefault(room, {})

    async def join(self, peer: Peer):
        self.room_peers(peer.room)[peer.id] = peer

    def leave(self, peer: Peer):
        peers = self.rooms.get(peer.room)
        if peers and peer.id in peers:
            del peers[peer.id]

    async def send(self, peer: Peer, message: dict):
        try:
            await peer.ws.send_text(json.dumps(message))
        except Exception:
            pass

    async def broadcast(self, room: str, message: dict, exclude: str = None):
        for pid, peer in list(self.room_peers(room).items()):
            if pid == exclude:
                continue
            await self.send(peer, message)

    def roster(self, room: str) -> list:
        return [
            {"id": p.id, "username": p.username, "inVoice": p.in_voice}
            for p in self.room_peers(room).values()
        ]


hub = Hub()


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix[:12]
    fid = uuid.uuid4().hex + ext
    dest = UPLOAD_DIR / fid
    size = 0
    try:
        with open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD:
                    f.close()
                    dest.unlink(missing_ok=True)
                    return JSONResponse(
                        {"error": "\u0424\u0430\u0439\u043b \u0441\u043b\u0438\u0448\u043a\u043e\u043c \u0431\u043e\u043b\u044c\u0448\u043e\u0439 (\u043c\u0430\u043a\u0441 50 \u041c\u0411)"},
                        status_code=413,
                    )
                f.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        return JSONResponse({"error": "\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438"}, status_code=500)
    return {
        "url": f"/uploads/{fid}",
        "name": file.filename,
        "size": size,
        "mime": file.content_type or "",
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    peer: Peer = None
    try:
        raw = await ws.receive_text()
        data = json.loads(raw)
        if data.get("type") != "join":
            await ws.close()
            return

        username = (data.get("username") or "Anon").strip()[:32] or "Anon"
        room = (data.get("room") or "general").strip()[:32] or "general"
        peer = Peer(str(uuid.uuid4()), username, room, ws)
        await hub.join(peer)

        await hub.send(peer, {
            "type": "welcome",
            "id": peer.id,
            "room": room,
            "roster": hub.roster(room),
            "history": hub.history.get(room, [])[-50:],
        })
        await hub.broadcast(room, {
            "type": "roster",
            "roster": hub.roster(room),
        })
        await hub.broadcast(room, {
            "type": "system",
            "text": f"{username} \u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u043b\u0441\u044f",
        }, exclude=peer.id)

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "chat":
                text = (msg.get("text") or "").strip()[:2000]
                if not text:
                    continue
                out = {
                    "type": "chat",
                    "id": peer.id,
                    "username": peer.username,
                    "text": text,
                    "ts": msg.get("ts"),
                }
                hub.history.setdefault(room, []).append(out)
                hub.history[room] = hub.history[room][-200:]
                await hub.broadcast(room, out)

            elif mtype == "file":
                url = (msg.get("url") or "").strip()
                if not url.startswith("/uploads/"):
                    continue
                out = {
                    "type": "file",
                    "id": peer.id,
                    "username": peer.username,
                    "url": url,
                    "name": (msg.get("name") or "file")[:200],
                    "size": int(msg.get("size") or 0),
                    "mime": (msg.get("mime") or "")[:100],
                    "ts": msg.get("ts"),
                }
                hub.history.setdefault(room, []).append(out)
                hub.history[room] = hub.history[room][-200:]
                await hub.broadcast(room, out)

            elif mtype == "voice-join":
                peer.in_voice = True
                await hub.broadcast(room, {"type": "roster", "roster": hub.roster(room)})
                await hub.broadcast(room, {
                    "type": "voice-peer-join",
                    "id": peer.id,
                    "username": peer.username,
                }, exclude=peer.id)

            elif mtype == "voice-leave":
                peer.in_voice = False
                await hub.broadcast(room, {"type": "roster", "roster": hub.roster(room)})
                await hub.broadcast(room, {
                    "type": "voice-peer-leave",
                    "id": peer.id,
                }, exclude=peer.id)

            elif mtype in ("offer", "answer", "candidate"):
                target_id = msg.get("target")
                target = hub.room_peers(room).get(target_id)
                if target:
                    payload = dict(msg)
                    payload["from"] = peer.id
                    payload["username"] = peer.username
                    await hub.send(target, payload)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if peer:
            room = peer.room
            hub.leave(peer)
            await hub.broadcast(room, {"type": "roster", "roster": hub.roster(room)})
            await hub.broadcast(room, {"type": "voice-peer-leave", "id": peer.id})
            await hub.broadcast(room, {
                "type": "system",
                "text": f"{peer.username} \u0432\u044b\u0448\u0435\u043b",
            })


app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
