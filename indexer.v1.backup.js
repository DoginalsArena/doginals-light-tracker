const axios = require("axios");
const Database = require("better-sqlite3");
require("dotenv").config();

const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const RPC_URL =
  process.env.RPC_URL || "http://127.0.0.1:22555";

const START_HEIGHT = Number(
  process.env.START_HEIGHT || 4000000
);

const db = new Database("./doginals-tracker.db");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS inscriptions (
  inscription_id TEXT PRIMARY KEY,

  genesis_txid TEXT NOT NULL,
  genesis_vout INTEGER NOT NULL,

  current_txid TEXT NOT NULL,
  current_vout INTEGER NOT NULL,

  current_owner TEXT,
  current_value_sat INTEGER,

  created_height INTEGER,
  updated_height INTEGER,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  inscription_id TEXT NOT NULL,

  from_txid TEXT NOT NULL,
  from_vout INTEGER NOT NULL,

  to_txid TEXT NOT NULL,
  to_vout INTEGER NOT NULL,

  to_owner TEXT,
  value_sat INTEGER,

  block_height INTEGER,
  block_time INTEGER,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_current_location
ON inscriptions(current_txid, current_vout);

CREATE INDEX IF NOT EXISTS idx_owner
ON inscriptions(current_owner);
`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getState(key, fallback) {
  const row = db
    .prepare(
      "SELECT value FROM state WHERE key=?"
    )
    .get(key);

  return row ? row.value : fallback;
}

function setState(key, value) {
  db.prepare(`
    INSERT OR REPLACE INTO state(key,value)
    VALUES(?,?)
  `).run(key, String(value));
}

async function rpc(method, params = []) {
  const res = await axios.post(
    RPC_URL,
    {
      jsonrpc: "1.0",
      id: "doginals-tracker",
      method,
      params,
    },
    {
      auth: {
        username: RPC_USER,
        password: RPC_PASSWORD,
      },
      headers: {
        "content-type": "text/plain",
      },
      timeout: 60000,
    }
  );

  if (res.data.error) {
    throw new Error(res.data.error.message);
  }

  return res.data.result;
}

function extractAddress(vout) {
  return (
    vout?.scriptPubKey?.addresses?.[0] ||
    vout?.scriptPubKey?.address ||
    null
  );
}

function txContainsOrd(tx) {
  const raw = JSON.stringify(tx).toLowerCase();

  return raw.includes("6f7264");
}

function moveInscription(
  inscription,
  tx,
  height,
  blockTime
) {
  const nextVout = 0;
  const out = tx.vout[nextVout];

  if (!out) return;

  const owner = extractAddress(out);

  db.prepare(`
    INSERT INTO movements (
      inscription_id,
      from_txid,
      from_vout,
      to_txid,
      to_vout,
      to_owner,
      value_sat,
      block_height,
      block_time
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inscription.inscription_id,
    inscription.current_txid,
    inscription.current_vout,
    tx.txid,
    nextVout,
    owner,
    Math.round(Number(out.value) * 100000000),
    height,
    blockTime
  );

  db.prepare(`
    UPDATE inscriptions
    SET
      current_txid=?,
      current_vout=?,
      current_owner=?,
      current_value_sat=?,
      updated_height=?
    WHERE inscription_id=?
  `).run(
    tx.txid,
    nextVout,
    owner,
    Math.round(Number(out.value) * 100000000),
    height,
    inscription.inscription_id
  );

  console.log(
    `MOVE ${inscription.inscription_id} -> ${tx.txid}:0`
  );
}

function createInscription(
  tx,
  height,
  blockTime
) {
  const out = tx.vout[0];

  if (!out) return;

  const owner = extractAddress(out);

  const inscriptionId = `${tx.txid}i0`;

  db.prepare(`
    INSERT OR IGNORE INTO inscriptions (
      inscription_id,

      genesis_txid,
      genesis_vout,

      current_txid,
      current_vout,

      current_owner,
      current_value_sat,

      created_height,
      updated_height
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inscriptionId,

    tx.txid,
    0,

    tx.txid,
    0,

    owner,
    Math.round(Number(out.value) * 100000000),

    height,
    height
  );

  console.log(`NEW ${inscriptionId}`);
}

async function scanBlock(height) {
  const hash = await rpc("getblockhash", [height]);

  const block = await rpc(
    "getblock",
    [hash, 2]
  );

  for (const tx of block.tx || []) {
    for (const vin of tx.vin || []) {
      if (
        !vin.txid &&
        vin.vout !== 0
      ) {
        continue;
      }

      const inscription = db
        .prepare(`
          SELECT *
          FROM inscriptions
          WHERE current_txid=?
          AND current_vout=?
          LIMIT 1
        `)
        .get(vin.txid, vin.vout);

      if (inscription) {
        moveInscription(
          inscription,
          tx,
          height,
          block.time
        );
      }
    }

    if (txContainsOrd(tx)) {
      createInscription(
        tx,
        height,
        block.time
      );
    }
  }

  setState("last_height", height);

  console.log(`BLOCK ${height} DONE`);
}

async function main() {
  let height = Number(
    getState(
      "last_height",
      START_HEIGHT
    )
  );

  console.log(
    `Tracker starting at ${height}`
  );

  while (true) {
    try {
      const tip = await rpc(
        "getblockcount"
      );

      while (height <= tip) {
        await scanBlock(height);
        height++;
      }

      console.log(
        `At tip ${tip}, waiting...`
      );

      await sleep(15000);
    } catch (e) {
      console.error(
        "Loop error:",
        e.message
      );

      await sleep(5000);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
