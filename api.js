const express = require("express");
const Database = require("better-sqlite3");
require("dotenv").config();

const PORT = Number(process.env.INDEXER_API_PORT || 3001);
const API_KEY = process.env.INDEXER_API_KEY || "";

const app = express();

const db = new Database("./doginals-tracker.db", {
  readonly: true,
  fileMustExist: true,
});

db.pragma("busy_timeout = 5000");

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const auth = req.headers.authorization || "";
  const key = auth.replace("Bearer ", "");

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
  const lastHeight = db
    .prepare(`
      SELECT value FROM state WHERE key = 'last_height'
    `)
    .get();

  const inscriptions = db
    .prepare(`SELECT COUNT(*) AS count FROM inscriptions`)
    .get();

  const movements = db
    .prepare(`SELECT COUNT(*) AS count FROM movements`)
    .get();

  res.json({
    ok: true,
    service: "doginals-light-tracker-api",
    last_height: lastHeight ? Number(lastHeight.value) : null,
    inscriptions: inscriptions.count,
    movements: movements.count,
  });
});

app.get("/inscription/:id", (req, res) => {
  const row = db
    .prepare(`
      SELECT *
      FROM inscriptions
      WHERE inscription_id = ?
      LIMIT 1
    `)
    .get(req.params.id);

  if (!row) {
    return res.status(404).json({
      ok: false,
      error: "Inscription not found",
    });
  }

  res.json({
    ok: true,
    inscription: {
      ...row,
      satpoint: `${row.current_txid}:${row.current_vout}:${row.current_offset}`,
    },
  });
});

app.get("/address/:address/inscriptions", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const rows = db
    .prepare(`
      SELECT *
      FROM inscriptions
      WHERE current_owner = ?
      ORDER BY updated_height DESC
      LIMIT ? OFFSET ?
    `)
    .all(req.params.address, limit, offset);

  res.json({
    ok: true,
    address: req.params.address,
    count: rows.length,
    inscriptions: rows.map((row) => ({
      ...row,
      satpoint: `${row.current_txid}:${row.current_vout}:${row.current_offset}`,
    })),
  });
});

app.get("/latest", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 500);

  const rows = db
    .prepare(`
      SELECT *
      FROM inscriptions
      ORDER BY created_height DESC
      LIMIT ?
    `)
    .all(limit);

  res.json({
    ok: true,
    count: rows.length,
    inscriptions: rows.map((row) => ({
      ...row,
      satpoint: `${row.current_txid}:${row.current_vout}:${row.current_offset}`,
    })),
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

  const like = `%${q}%`;

  const rows = db
    .prepare(`
      SELECT *
      FROM inscriptions
      WHERE inscription_id LIKE ?
         OR genesis_txid LIKE ?
         OR current_txid LIKE ?
         OR current_owner LIKE ?
      ORDER BY updated_height DESC
      LIMIT 100
    `)
    .all(like, like, like, like);

  res.json({
    ok: true,
    q,
    count: rows.length,
    results: rows.map((row) => ({
      ...row,
      satpoint: `${row.current_txid}:${row.current_vout}:${row.current_offset}`,
    })),
  });
});

app.get("/address/:address/utxos", (req, res) => {
  const rows = db
    .prepare(`
      SELECT
        current_txid AS txid,
        current_vout AS vout,
        current_offset AS offset,
        current_value_sat AS value,
        inscription_id,
        content_type
      FROM inscriptions
      WHERE current_owner = ?
      ORDER BY updated_height DESC
    `)
    .all(req.params.address);

  res.json({
    ok: true,
    address: req.params.address,
    count: rows.length,
    utxos: rows.map((row) => ({
      txid: row.txid,
      vout: row.vout,
      value: row.value,
      inscriptions: [row.inscription_id],
      content_type: row.content_type,
      satpoint: `${row.txid}:${row.vout}:${row.offset}`,
      dunes: [],
    })),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Doginals tracker API running on port ${PORT}`);
});
