const express = require("express");
const Database = require("better-sqlite3");
require("dotenv").config();

const PORT = Number(process.env.INDEXER_API_PORT || 3001);
const API_KEY = process.env.INDEXER_API_KEY || "";

const app = express();

const db = new Database("./doginals-light.db", {
  readonly: true,
  fileMustExist: true,
});

//db.pragma("journal_mode = WAL");

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const key = req.headers.authorization?.replace("Bearer ", "");

  if (key !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  next();
}

app.use(requireApiKey);

app.get("/health", (req, res) => {
  const lastHeight = db.prepare(`
    SELECT value FROM state WHERE key = 'last_height'
  `).get();

  res.json({
    ok: true,
    service: "doginals-light-indexer-api",
    last_height: lastHeight ? Number(lastHeight.value) : null,
  });
});

app.get("/inscription/:id", (req, res) => {
  const row = db.prepare(`
    SELECT *
    FROM inscriptions
    WHERE inscription_id = ?
    LIMIT 1
  `).get(req.params.id);

  if (!row) {
    return res.status(404).json({
      ok: false,
      error: "Inscription not found",
    });
  }

  res.json({
    ok: true,
    inscription: row,
  });
});

app.get("/address/:address", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const rows = db.prepare(`
    SELECT *
    FROM inscriptions
    WHERE owner_address = ?
      AND spent = 0
    ORDER BY block_height DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(req.params.address, limit, offset);

  res.json({
    ok: true,
    address: req.params.address,
    count: rows.length,
    inscriptions: rows,
  });
});

app.get("/latest", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 500);

  const rows = db.prepare(`
    SELECT *
    FROM inscriptions
    ORDER BY block_height DESC, id DESC
    LIMIT ?
  `).all(limit);

  res.json({
    ok: true,
    count: rows.length,
    inscriptions: rows,
  });
});

app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: "Missing q",
    });
  }

  const rows = db.prepare(`
    SELECT *
    FROM inscriptions
    WHERE inscription_id LIKE ?
       OR txid LIKE ?
       OR owner_address LIKE ?
    ORDER BY block_height DESC
    LIMIT 100
  `).all(`%${q}%`, `%${q}%`, `%${q}%`);

  res.json({
    ok: true,
    q,
    count: rows.length,
    results: rows,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Doginals indexer API running on port ${PORT}`);
});
