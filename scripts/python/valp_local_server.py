"""A local VALP public service, in memory, for test/valp-contract.test.ts (the live contract check).

It runs VALP's real hashes route (valp_collector.hashes / projects / public) with one enrolled agent and a
project whose key is test/vectors/signature.json's, with pricing samples wanted, so a 201 carries a
``sample``. Its sample signer points back at this server (PUT /_sample/<name>), which checks the signed
headers the way GCS would and records what arrived (GET /_samples).

    PYTHONPATH=<VALP>/src:<VALP> <VALP>/.venv/bin/python scripts/python/valp_local_server.py

Prints one JSON line {url, token, agent_id, key_id} on stdout once it is listening.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import socket
import sys
import threading
import time
import urllib.request

import uvicorn
from fastapi import Request
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient

from tests.support.ledger_fixture import AGENT  # VALP's test agent id
from tests.unit.test_submitter import COLLECTOR
from valp_collector.app import create_app
from valp_collector.hashes import Hashes
from valp_collector.ingest import Ingest
from valp_collector.ledger import Enrolment
from valp_collector.projects import Projects
from valp_collector.public import create_public_app
from valp_collector.store.memory import MemoryObjectStore

VECTOR = json.loads((pathlib.Path(__file__).resolve().parents[2] / "test" / "vectors" / "signature.json").read_text())

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"


class LocalSigner:
    """Signs "URLs" that point back here; the PUT handler enforces the headers as GCS would."""

    def sign(self, method, name, ttl, headers):
        return f"{BASE}/_sample/{name}"


ledger, ops = MemoryObjectStore(), MemoryObjectStore()
ledger.create(f"agents/{AGENT}/registration", Enrolment(AGENT, "install-1").encode())
hashes = Hashes(Projects(ledger), ops, LocalSigner())
platform = TestClient(create_app(Ingest(ledger, COLLECTOR), hashes=hashes))
r = platform.post("/v1/projects", json={"project_ref": "redberry-otel-contract", "agent_ids": [AGENT],
                                        "public_key": VECTOR["public_key_hex"]})
assert r.status_code == 201, r.text
project = r.json()
assert project["key_id"] == VECTOR["key_id"], (project["key_id"], VECTOR["key_id"])
assert platform.put(f"/v1/agents/{AGENT}/pricing-sample", json={"wanted": True}).status_code == 200

app = create_public_app(Ingest(ledger, COLLECTOR, strict_tokens=True), hashes=hashes)
samples: dict[str, dict] = {}


@app.put("/_sample/{name:path}")
async def sample(name: str, request: Request):
    body = await request.body()
    h = request.headers
    lo, hi = (int(x) for x in h.get("x-goog-content-length-range", "0,0").split(","))
    if h.get("x-goog-if-generation-match") != "0" or not lo <= len(body) <= hi:
        return Response(status_code=400)
    if name in samples:
        return Response(status_code=412)
    samples[name] = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest(), "meta_sha256": h.get("x-goog-meta-sha256")}
    return Response(status_code=200)


@app.get("/_samples")
async def list_samples():
    return JSONResponse(samples)


def announce() -> None:
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{BASE}/_samples", timeout=0.2)
            break
        except OSError:
            time.sleep(0.05)
    print(json.dumps({"url": BASE, "token": project["project_token"], "agent_id": AGENT, "key_id": project["key_id"],
                      "project_id": project["project_id"]}), flush=True)


threading.Thread(target=announce, daemon=True).start()
uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
sys.exit(0)
