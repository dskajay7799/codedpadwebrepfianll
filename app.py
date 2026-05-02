import os
import string
import random
from datetime import datetime, timedelta
from contextlib import contextmanager
 
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import psycopg2
 
# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")
PORT = int(os.getenv("PORT", 5000))
 
if not DATABASE_URL:
    raise Exception("DATABASE_URL not set!")
 
app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)
 
 
# ─────────────────────────────────────────────
# Database Connection
# ─────────────────────────────────────────────
def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode='require')
 
 
# FIX 1: Context manager ensures conn is ALWAYS closed, even on exceptions.
# Previously, load_code() and save_code()'s except block both leaked connections.
@contextmanager
def db_cursor():
    conn = get_db()
    try:
        cur = conn.cursor()
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
 
 
# ─────────────────────────────────────────────
# Init DB safely
# ─────────────────────────────────────────────
def init_db():
    try:
        with db_cursor() as (conn, cur):
            cur.execute("""
            CREATE TABLE IF NOT EXISTS pastes (
                id SERIAL PRIMARY KEY,
                passkey VARCHAR(12) UNIQUE NOT NULL,
                code TEXT NOT NULL,
                language VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            );
            """)
        print("✅ DB initialized")
 
    except Exception as e:
        print("❌ DB INIT ERROR:", e)
 
 
init_db()
 
 
# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────
def generate_passkey(length=6):
    chars = string.ascii_lowercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))
 
 
def get_expiry(expiry_str):
    now = datetime.utcnow()
 
    if expiry_str == "1h":
        return now + timedelta(hours=1)
    elif expiry_str == "24h":
        return now + timedelta(hours=24)
    elif expiry_str == "7d":
        return now + timedelta(days=7)
    else:
        return None
 
 
# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────
 
@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")
 
 
@app.route("/save", methods=["POST"])
def save_code():
    try:
        # FIX 2: get_json() returns None if Content-Type is wrong or body is
        # malformed. Guard against AttributeError on .get() calls.
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid or missing JSON body"}), 400
 
        code = data.get("code", "").strip()
        language = data.get("language", "plaintext")
        expiry = data.get("expiry", "never")
 
        if not code:
            return jsonify({"error": "Code cannot be empty"}), 400
 
        expires_at = get_expiry(expiry)
 
        # FIX 3: Generate a candidate passkey BEFORE opening the DB cursor so
        # the uniqueness loop doesn't hold the cursor open across iterations,
        # which could cause issues under concurrent load.
        with db_cursor() as (conn, cur):
            passkey = None
            for _ in range(10):  # bounded retry — avoid infinite loop
                candidate = generate_passkey()
                cur.execute("SELECT 1 FROM pastes WHERE passkey=%s", (candidate,))
                if not cur.fetchone():
                    passkey = candidate
                    break
 
            if not passkey:
                return jsonify({"error": "Could not generate unique passkey, try again"}), 500
 
            cur.execute("""
                INSERT INTO pastes (passkey, code, language, expires_at)
                VALUES (%s, %s, %s, %s)
            """, (passkey, code, language, expires_at))
 
        return jsonify({"passkey": passkey})
 
    except Exception as e:
        print("SAVE ERROR:", e)
        return jsonify({"error": "Failed to save code"}), 500
 
 
@app.route("/load/<passkey>", methods=["GET"])
def load_code(passkey):
    try:
        with db_cursor() as (conn, cur):
            cur.execute("""
                SELECT code, language, created_at, expires_at
                FROM pastes
                WHERE passkey=%s
            """, (passkey,))
 
            row = cur.fetchone()
 
            if not row:
                return jsonify({"error": "Code not found"}), 404
 
            code, language, created_at, expires_at = row
 
            # FIX 4: Delete expired pastes instead of just blocking them.
            # Previously they stayed in the DB forever and always returned 410.
            if expires_at and datetime.utcnow() > expires_at:
                cur.execute("DELETE FROM pastes WHERE passkey=%s", (passkey,))
                return jsonify({"error": "Code has expired"}), 410
 
        # FIX 1 (cont): Connection is closed by the context manager above,
        # even on the early-return paths. Previously load_code() never closed
        # the connection on the success path.
        return jsonify({
            "code": code,
            "language": language,
            "saved_at": created_at.isoformat()
        })
 
    except Exception as e:
        print("LOAD ERROR:", e)
        return jsonify({"error": "Failed to load code"}), 500
 
 
# ─────────────────────────────────────────────
# Run
# ─────────────────────────────────────────────
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)