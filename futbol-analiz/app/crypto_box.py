"""Statik site verisini şifreler: gzip + AES-256-GCM, anahtar PBKDF2-SHA256 ile şifreden türetilir.
Tarayıcı tarafı (static/app.js) aynı parametrelerle WebCrypto kullanarak çözer."""
import base64
import gzip
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SALT = b"mac-analiz-merkezi:v1"
ITERATIONS = 150_000


def derive_key(password):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), SALT, ITERATIONS, 32)


def seal(key, obj):
    raw = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, raw, None)
    return {"v": 1, "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def unseal(key, box):
    raw = AESGCM(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["ct"]), None)
    return json.loads(gzip.decompress(raw))
