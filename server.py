from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import socket
import struct
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = 4173
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
ROOMS: dict[str, "Room"] = {}
CLIENTS: dict[str, "Client"] = {}
LOCK = threading.RLock()

SUITS = ["S", "H", "D", "C"]
RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


def make_deck():
    deck = [{"suit": suit, "rank": rank} for suit in SUITS for rank in RANKS]
    random.shuffle(deck)
    return deck


def score(cards):
    total = 0
    aces = 0
    for card in cards:
        rank = card["rank"]
        if rank == "A":
            total += 11
            aces += 1
        elif rank in {"K", "Q", "J"}:
            total += 10
        else:
            total += int(rank)
    while total > 21 and aces:
        total -= 10
        aces -= 1
    return {"total": total, "soft": aces > 0, "blackjack": len(cards) == 2 and total == 21, "bust": total > 21}


def new_player(client_id, name, balance):
    return {
        "id": client_id,
        "name": name[:16] or "Player",
        "balance": max(0, int(balance or 10000)),
        "bet": 0,
        "ready": False,
        "hands": [],
        "activeHand": 0,
        "insurance": 0,
        "result": "",
        "net": 0,
    }


class Room:
    def __init__(self, code):
        self.code = code
        self.clients: set[str] = set()
        self.players = {}
        self.deck = make_deck()
        self.dealer = []
        self.phase = "lobby"
        self.activePlayer = ""
        self.created = time.time()

    def draw(self):
        if len(self.deck) < 14:
            self.deck.extend(make_deck())
        return self.deck.pop()

    def public_state(self, viewer_id=""):
        dealer_cards = self.dealer[:]
        if self.phase == "playing" and len(dealer_cards) > 1:
            dealer_cards = [dealer_cards[0], {"hidden": True}]
        return {
            "type": "state",
            "you": viewer_id,
            "room": self.code,
            "phase": self.phase,
            "dealer": dealer_cards,
            "dealerScore": score(self.dealer)["total"] if self.phase in {"dealer", "complete"} else (score([self.dealer[0]])["total"] if self.dealer else 0),
            "activePlayer": self.activePlayer,
            "players": list(self.players.values()),
        }

    def reset_round(self):
        self.deck = make_deck()
        self.dealer = []
        self.phase = "betting"
        self.activePlayer = ""
        for player in self.players.values():
            player.update({"bet": 0, "ready": False, "hands": [], "activeHand": 0, "insurance": 0, "result": "", "net": 0})

    def maybe_start(self):
        ready_players = [p for p in self.players.values() if p["ready"] and p["bet"] > 0]
        if not ready_players or len(ready_players) != len(self.players):
            return
        self.phase = "playing"
        self.dealer = []
        for player in ready_players:
            player["balance"] -= player["bet"]
            cards = [self.draw(), self.draw()]
            player["hands"] = [{"cards": cards, "bet": player["bet"], "done": score(cards)["blackjack"], "result": ""}]
            player["activeHand"] = 0
        self.dealer = [self.draw(), self.draw()]
        self.advance_turn()

    def current_player(self):
        return self.players.get(self.activePlayer)

    def current_hand(self, player):
        if not player or not player["hands"]:
            return None
        return player["hands"][player["activeHand"]]

    def advance_turn(self):
        for player in self.players.values():
            for hand in player["hands"]:
                if not hand["done"] and not score(hand["cards"])["bust"]:
                    self.activePlayer = player["id"]
                    return
        self.activePlayer = ""
        self.play_dealer()

    def finish_hand(self, player):
        hand = self.current_hand(player)
        if hand:
            hand["done"] = True
        for index, candidate in enumerate(player["hands"]):
            if not candidate["done"]:
                player["activeHand"] = index
                return
        self.advance_turn()

    def play_dealer(self):
        self.phase = "dealer"
        while score(self.dealer)["total"] < 17:
            self.dealer.append(self.draw())
        self.settle()

    def settle(self):
        self.phase = "complete"
        dealer_score = score(self.dealer)
        dealer_blackjack = dealer_score["blackjack"]
        for player in self.players.values():
            net = 0
            labels = []
            if player["insurance"]:
                if dealer_blackjack:
                    player["balance"] += player["insurance"] * 3
                    net += player["insurance"] * 2
                else:
                    net -= player["insurance"]
            for hand in player["hands"]:
                hand_score = score(hand["cards"])
                payout = hand["bet"]
                label = "Push"
                hand_net = 0
                if hand_score["bust"]:
                    payout = 0
                    label = "Defeat"
                    hand_net = -hand["bet"]
                elif hand_score["blackjack"] and not dealer_blackjack and len(player["hands"]) == 1:
                    payout = hand["bet"] + int(hand["bet"] * 1.5)
                    label = "Blackjack"
                    hand_net = payout - hand["bet"]
                elif dealer_score["bust"] or hand_score["total"] > dealer_score["total"]:
                    payout = hand["bet"] * 2
                    label = "Victory"
                    hand_net = hand["bet"]
                elif dealer_score["total"] > hand_score["total"] or dealer_blackjack:
                    payout = 0
                    label = "Defeat"
                    hand_net = -hand["bet"]
                player["balance"] += payout
                net += hand_net
                hand["result"] = label
                labels.append(label)
            player["net"] = net
            player["result"] = ", ".join(labels) if labels else "No bet"


class Client:
    def __init__(self, sock, client_id):
        self.sock = sock
        self.id = client_id
        self.room = ""

    def send(self, data):
        try:
            payload = json.dumps(data).encode("utf-8")
            header = bytearray([0x81])
            if len(payload) < 126:
                header.append(len(payload))
            elif len(payload) < 65536:
                header.extend([126, *struct.pack("!H", len(payload))])
            else:
                header.extend([127, *struct.pack("!Q", len(payload))])
            self.sock.sendall(header + payload)
        except OSError:
            disconnect(self.id)


def broadcast(room):
    for client_id in list(room.clients):
        client = CLIENTS.get(client_id)
        if client:
            client.send(room.public_state(client_id))


def disconnect(client_id):
    with LOCK:
        client = CLIENTS.pop(client_id, None)
        if not client:
            return
        room = ROOMS.get(client.room)
        if room:
            room.clients.discard(client_id)
            room.players.pop(client_id, None)
            if room.activePlayer == client_id:
                room.advance_turn()
            if room.clients:
                broadcast(room)
            else:
                ROOMS.pop(room.code, None)


def handle_message(client, message):
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return
    with LOCK:
        kind = data.get("type")
        if kind == "join":
            code = (data.get("room") or short_code()).upper()[:8]
            room = ROOMS.setdefault(code, Room(code))
            client.room = code
            room.clients.add(client.id)
            room.players[client.id] = new_player(client.id, data.get("name", "Player"), data.get("balance", 10000))
            if room.phase == "lobby":
                room.phase = "betting"
            broadcast(room)
        elif not client.room or client.room not in ROOMS:
            return
        else:
            room = ROOMS[client.room]
            player = room.players.get(client.id)
            if not player:
                return
            if kind == "bet" and room.phase in {"betting", "complete"}:
                if room.phase == "complete":
                    room.reset_round()
                bet = max(0, min(int(data.get("bet", 0)), player["balance"]))
                player["bet"] = bet
                player["ready"] = bet > 0
                room.maybe_start()
            elif kind == "next" and room.phase == "complete":
                room.reset_round()
            elif kind == "insurance" and room.phase == "playing" and room.dealer and room.dealer[0]["rank"] == "A":
                cost = min(max(0, player["bet"] // 2), player["balance"])
                player["balance"] -= cost
                player["insurance"] = cost
            elif kind in {"hit", "stand", "double", "split"} and room.phase == "playing" and room.activePlayer == client.id:
                hand = room.current_hand(player)
                if not hand:
                    return
                if kind == "hit":
                    hand["cards"].append(room.draw())
                    if score(hand["cards"])["bust"]:
                        room.finish_hand(player)
                elif kind == "stand":
                    room.finish_hand(player)
                elif kind == "double" and len(hand["cards"]) == 2 and player["balance"] >= hand["bet"]:
                    player["balance"] -= hand["bet"]
                    hand["bet"] *= 2
                    hand["cards"].append(room.draw())
                    room.finish_hand(player)
                elif kind == "split" and len(hand["cards"]) == 2 and hand["cards"][0]["rank"] == hand["cards"][1]["rank"] and player["balance"] >= hand["bet"]:
                    player["balance"] -= hand["bet"]
                    moved = hand["cards"].pop()
                    hand["cards"].append(room.draw())
                    player["hands"].insert(player["activeHand"] + 1, {"cards": [moved, room.draw()], "bet": hand["bet"], "done": False, "result": ""})
            broadcast(room)


def short_code():
    return "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(5))


def recv_frame(sock):
    first = sock.recv(2)
    if not first:
        return None
    opcode = first[0] & 0x0F
    if opcode == 8:
        return None
    masked = first[1] & 0x80
    length = first[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    mask = sock.recv(4) if masked else b""
    payload = sock.recv(length)
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return payload.decode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return os.path.join(ROOT, super().translate_path(path).split(os.getcwd(), 1)[-1].lstrip("\\/"))

    def do_GET(self):
        if self.path.startswith("/ws"):
            self.websocket()
            return
        super().do_GET()

    def websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400)
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.request.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
        )
        client_id = uuid.uuid4().hex[:10]
        client = Client(self.request, client_id)
        with LOCK:
            CLIENTS[client_id] = client
        try:
            while True:
                message = recv_frame(self.request)
                if message is None:
                    break
                handle_message(client, message)
        except (OSError, ConnectionError, ValueError):
            pass
        finally:
            disconnect(client_id)


if __name__ == "__main__":
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Aurum 21 multiplayer server running on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
