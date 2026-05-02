import os
import re
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
    raise Exception("DATABASE_URL environment variable is not set!")

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)


# ─────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────
def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode='require')


@contextmanager
def db_cursor():
    conn = get_db()
    cur = None
    try:
        cur = conn.cursor()
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        if cur:
            cur.close()
        conn.close()


# ─────────────────────────────────────────────
# Init DB
# ─────────────────────────────────────────────
def init_db():
    try:
        with db_cursor() as (conn, cur):
            cur.execute("""
                CREATE TABLE IF NOT EXISTS pastes (
                    id         SERIAL PRIMARY KEY,
                    passkey    VARCHAR(64) UNIQUE NOT NULL,
                    code       TEXT NOT NULL,
                    language   VARCHAR(50),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP
                );
            """)
            # Widen the column if DB was previously created with VARCHAR(12)
            cur.execute("""
                ALTER TABLE pastes ALTER COLUMN passkey TYPE VARCHAR(64);
            """)
        print("DB ready")
    except Exception as e:
        print("DB INIT ERROR:", e)


init_db()


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────
PASSKEY_RE = re.compile(r'^[a-zA-Z0-9_\-]{3,32}$')


def validate_passkey(passkey):
    if not passkey:
        return "Passkey cannot be empty."
    if not PASSKEY_RE.match(passkey):
        return "Passkey must be 3-32 characters: letters, numbers, hyphens or underscores only."
    return None


def random_passkey(length=8):
    chars = string.ascii_lowercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))


def get_expiry(s):
    mapping = {"1h": timedelta(hours=1), "24h": timedelta(hours=24), "7d": timedelta(days=7)}
    delta = mapping.get(s)
    return datetime.utcnow() + delta if delta else None


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")


@app.route("/suggest-passkey", methods=["GET"])
def suggest_passkey():
    """Return a random passkey not already in the DB."""
    try:
        with db_cursor() as (conn, cur):
            for _ in range(20):
                candidate = random_passkey()
                cur.execute("SELECT 1 FROM pastes WHERE passkey = %s", (candidate,))
                if not cur.fetchone():
                    return jsonify({"passkey": candidate})
        return jsonify({"passkey": random_passkey(12)})
    except Exception as e:
        print("SUGGEST ERROR:", e)
        return jsonify({"passkey": random_passkey(10)})


@app.route("/check/<passkey>", methods=["GET"])
def check_passkey(passkey):
    """Live availability check as the user types."""
    try:
        passkey = passkey.strip().lower()
        err = validate_passkey(passkey)
        if err:
            return jsonify({"available": False, "reason": err})
        with db_cursor() as (conn, cur):
            cur.execute("SELECT 1 FROM pastes WHERE passkey = %s", (passkey,))
            taken = cur.fetchone() is not None
        return jsonify({"available": not taken})
    except Exception as e:
        print("CHECK ERROR:", e)
        return jsonify({"available": None, "error": str(e)}), 500


@app.route("/save", methods=["POST"])
def save_code():
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid or missing JSON body"}), 400

        passkey = (data.get("passkey") or "").strip().lower()
        err = validate_passkey(passkey)
        if err:
            return jsonify({"error": err}), 400

        code = data.get("code", "").strip()
        if not code:
            return jsonify({"error": "Code cannot be empty"}), 400

        language   = data.get("language", "plaintext")
        expiry     = data.get("expiry", "never")
        expires_at = get_expiry(expiry)
        saved_at   = datetime.utcnow()

        with db_cursor() as (conn, cur):
            cur.execute("SELECT 1 FROM pastes WHERE passkey = %s", (passkey,))
            if cur.fetchone():
                return jsonify({"error": f"Passkey '{passkey}' is already taken. Choose another."}), 409

            cur.execute(
                "INSERT INTO pastes (passkey, code, language, expires_at) VALUES (%s, %s, %s, %s)",
                (passkey, code, language, expires_at)
            )

        return jsonify({"passkey": passkey, "saved_at": saved_at.isoformat()})

    except Exception as e:
        print("SAVE ERROR:", e)
        return jsonify({"error": "Failed to save code. Please try again."}), 500


@app.route("/load/<passkey>", methods=["GET"])
def load_code(passkey):
    try:
        passkey = passkey.strip().lower()

        with db_cursor() as (conn, cur):
            cur.execute(
                "SELECT code, language, created_at, expires_at FROM pastes WHERE passkey = %s",
                (passkey,)
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "No paste found for that passkey."}), 404

            code, language, created_at, expires_at = row

            if expires_at and datetime.utcnow() > expires_at:
                cur.execute("DELETE FROM pastes WHERE passkey = %s", (passkey,))
                return jsonify({"error": "This paste has expired and was deleted."}), 410

        return jsonify({"code": code, "language": language, "saved_at": created_at.isoformat()})

    except Exception as e:
        print("LOAD ERROR:", e)
        return jsonify({"error": "Failed to load code. Please try again."}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
