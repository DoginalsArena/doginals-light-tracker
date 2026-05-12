const axios = require("axios");
const Database = require("better-sqlite3");
require("dotenv").config();

const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:22555";
const START_HEIGHT = Number(process.env.START_HEIGHT || 4200000);

const DOGE = 100000000;
const DOGINAL_DUST_SATS = 100000; // 0.001 DOGE

const db = new Database("./doginals-tracker.db");

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS inscriptions (
  inscription_id TEXT PRIMARY KEY,

  genesis_txid TEXT NOT NULL,
  genesis_vout INTEGER NOT NULL,
  genesis_offset INTEGER DEFAULT 0,

  current_txid TEXT NOT NULL,
  current_vout INTEGER NOT NULL,
  current_offset INTEGER DEFAULT 0,

  current_owner TEXT,
  current_value_sat INTEGER,

  content_type TEXT,

  created_height INTEGER,
  updated_height INTEGER,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  inscription_id TEXT NOT NULL,

  from_txid TEXT NOT NULL,
  from_vout INTEGER NOT NULL,
  from_offset INTEGER DEFAULT 0,

  to_txid TEXT NOT NULL,
  to_vout INTEGER NOT NULL,
  to_offset INTEGER DEFAULT 0,

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

CREATE INDEX IF NOT EXISTS idx_updated_height
ON inscriptions(updated_height);
`);

const getCurrentAtOutpoint = db.prepare(`
  SELECT *
  FROM inscriptions
  WHERE current_txid = ?
    AND current_vout = ?
  ORDER BY inscription_id ASC
`);

const insertMovement = db.prepare(`
  INSERT INTO movements (
    inscription_id,
    from_txid,
    from_vout,
    from_offset,
    to_txid,
    to_vout,
    to_offset,
    to_owner,
    value_sat,
    block_height,
    block_time
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateInscription = db.prepare(`
  UPDATE inscriptions
  SET
    current_txid = ?,
    current_vout = ?,
    current_offset = ?,
    current_owner = ?,
    current_value_sat = ?,
    updated_height = ?
  WHERE inscription_id = ?
`);

const insertInscription = db.prepare(`
  INSERT OR IGNORE INTO inscriptions (
    inscription_id,

    genesis_txid,
    genesis_vout,
    genesis_offset,

    current_txid,
    current_vout,
    current_offset,

    current_owner,
    current_value_sat,

    content_type,

    created_height,
    updated_height
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getState(key, fallback) {
  const row = db.prepare("SELECT value FROM state WHERE key=?").get(key);
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

function valueToSats(valueDoge) {
  return Math.round(Number(valueDoge) * DOGE);
}

function extractAddress(vout) {
  return (
    vout?.scriptPubKey?.addresses?.[0] ||
    vout?.scriptPubKey?.address ||
    null
  );
}

function hexToAscii(hex) {
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch (_) {
    return "";
  }
}

function detectDoginalInTx(tx) {
  const mimeHexes = [
    { hex: "696d6167652f706e67", type: "image/png" },
    { hex: "696d6167652f6a706567", type: "image/jpeg" },
    { hex: "696d6167652f6a7067", type: "image/jpg" },
    { hex: "696d6167652f676966", type: "image/gif" },
    { hex: "696d6167652f77656270", type: "image/webp" },
    { hex: "746578742f706c61696e", type: "text/plain" },
    { hex: "746578742f68746d6c", type: "text/html" },
    { hex: "6170706c69636174696f6e2f6a736f6e", type: "application/json" },
  ];

  for (const vin of tx.vin || []) {
    const hex = (vin?.scriptSig?.hex || "").toLowerCase();
    if (!hex) continue;

    // Doginals inscription marker "ord" in hex.
    if (!hex.includes("6f7264")) continue;

    const mime = mimeHexes.find((m) => hex.includes(m.hex));
    if (!mime) continue;

    return {
      found: true,
      contentType: mime.type,
    };
  }

  return {
    found: false,
    contentType: null,
  };
}

function getDustOutputs(tx) {
  return (tx.vout || [])
    .map((out) => ({
      n: out.n,
      out,
      valueSat: valueToSats(out.value),
      owner: extractAddress(out),
    }))
    .filter((x) => x.valueSat === DOGINAL_DUST_SATS);
}

function chooseInscriptionOutput(tx, index = 0) {
  const dustOutputs = getDustOutputs(tx);

  if (dustOutputs.length > 0) {
    return dustOutputs[Math.min(index, dustOutputs.length - 1)];
  }

  const fallback = tx.vout?.[0];

  if (!fallback) return null;

  return {
    n: fallback.n,
    out: fallback,
    valueSat: valueToSats(fallback.value),
    owner: extractAddress(fallback),
  };
}

function createInscription(tx, height, blockTime) {
  const detection = detectDoginalInTx(tx);

  if (!detection.found) return 0;

  const chosen = chooseInscriptionOutput(tx, 0);

  if (!chosen) return 0;

  const inscriptionId = `${tx.txid}i0`;

  const info = insertInscription.run(
    inscriptionId,

    tx.txid,
    chosen.n,
    0,

    tx.txid,
    chosen.n,
    0,

    chosen.owner,
    chosen.valueSat,

    detection.contentType,

    height,
    height
  );

  if (info.changes > 0) {
    console.log(
      `NEW ${inscriptionId} -> ${tx.txid}:${chosen.n}:0 owner=${chosen.owner || "unknown"}`
    );
    return 1;
  }

  return 0;
}

function moveInscription(inscription, tx, chosen, height, blockTime) {
  insertMovement.run(
    inscription.inscription_id,

    inscription.current_txid,
    inscription.current_vout,
    inscription.current_offset || 0,

    tx.txid,
    chosen.n,
    0,

    chosen.owner,
    chosen.valueSat,

    height,
    blockTime
  );

  updateInscription.run(
    tx.txid,
    chosen.n,
    0,
    chosen.owner,
    chosen.valueSat,
    height,
    inscription.inscription_id
  );

  console.log(
    `MOVE ${inscription.inscription_id} -> ${tx.txid}:${chosen.n}:0 owner=${chosen.owner || "unknown"}`
  );
}

function processMovements(tx, height, blockTime) {
  let moved = 0;

  const spentInscriptions = [];

  for (const vin of tx.vin || []) {
    if (!vin.txid && vin.vout !== 0) continue;
    if (!vin.txid) continue;

    const rows = getCurrentAtOutpoint.all(vin.txid, vin.vout);

    for (const row of rows) {
      spentInscriptions.push(row);
    }
  }

  if (spentInscriptions.length === 0) return 0;

  const usedChoiceByIndex = new Map();

  for (let i = 0; i < spentInscriptions.length; i++) {
    const inscription = spentInscriptions[i];

    let chosen;

    // Basic marketplace rule:
    // if multiple inscriptions move in same tx, map them to dust outputs in order.
    // If only one dust output exists, bundled inscriptions stay together on that output.
    if (usedChoiceByIndex.has(i)) {
      chosen = usedChoiceByIndex.get(i);
    } else {
      chosen = chooseInscriptionOutput(tx, i);
      usedChoiceByIndex.set(i, chosen);
    }

    if (!chosen) continue;

    moveInscription(inscription, tx, chosen, height, blockTime);
    moved++;
  }

  return moved;
}

async function scanBlock(height) {
  const hash = await rpc("getblockhash", [height]);
  const block = await rpc("getblock", [hash, 2]);

  let newCount = 0;
  let moveCount = 0;

  const txs = block.tx || [];

  const scanTx = db.transaction(() => {
    for (const tx of txs) {
      moveCount += processMovements(tx, height, block.time);
      newCount += createInscription(tx, height, block.time);
    }

    setState("last_height", height);
  });

  scanTx();

  console.log(
    `BLOCK ${height} DONE | new=${newCount} moves=${moveCount}`
  );
}

async function main() {
  let height = Number(getState("last_height", START_HEIGHT));

  console.log(`Doginals tracker starting at block ${height}`);

  while (true) {
    try {
      const tip = await rpc("getblockcount");

      while (height <= tip) {
        await scanBlock(height);
        height++;
      }

      console.log(`At tip ${tip}. Waiting for new blocks...`);
      await sleep(15000);
    } catch (e) {
      console.error("Loop error:", e.message);
      await sleep(5000);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
