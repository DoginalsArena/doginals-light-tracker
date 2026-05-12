const axios = require("axios");
const Database = require("better-sqlite3");
require("dotenv").config();

const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:22555";
const START_HEIGHT = Number(process.env.START_HEIGHT || 4583000);

const DOGE = 100000000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params = []) {
  const res = await axios.post(
    RPC_URL,
    {
      jsonrpc: "1.0",
      id: "doginals-light-sat-tracker",
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

function sats(valueDoge) {
  return Math.round(Number(valueDoge) * DOGE);
}

function extractAddress(vout) {
  return (
    vout?.scriptPubKey?.addresses?.[0] ||
    vout?.scriptPubKey?.address ||
    null
  );
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

function detectDoginalVin(tx) {
  const mimes = [
    ["696d6167652f706e67", "image/png"],
    ["696d6167652f6a706567", "image/jpeg"],
    ["696d6167652f6a7067", "image/jpg"],
    ["696d6167652f676966", "image/gif"],
    ["696d6167652f77656270", "image/webp"],
    ["746578742f706c61696e", "text/plain"],
    ["746578742f68746d6c", "text/html"],
    ["746578742f637373", "text/css"],
    ["746578742f6a617661736372697074", "text/javascript"],
    ["6170706c69636174696f6e2f6a736f6e", "application/json"],
    ["6170706c69636174696f6e2f706466", "application/pdf"],
  ];

  for (let i = 0; i < (tx.vin || []).length; i++) {
    const hex = (tx.vin[i]?.scriptSig?.hex || "").toLowerCase();
    if (!hex) continue;

    if (hex.includes("6f7264")) {
      console.log("ORD FOUND", tx.txid, "vin", i, hex.slice(0, 300));
    }

    if (!hex.includes("6f7264")) continue;

    const mime = mimes.find(([h]) => hex.includes(h));

    if (!mime) {
      console.log(
        "ORD BUT MIME NOT FOUND",
        tx.txid,
        "vin",
        i,
        hex.slice(0, 500)
      );

      return {
        vinIndex: i,
        contentType: "unknown",
      };
    }

    return {
      vinIndex: i,
      contentType: mime[1],
    };
  }

  return null;
}

async function getPrevoutValue(txid, vout) {
  const prevTx = await rpc("getrawtransaction", [txid, true]);
  const out = prevTx.vout?.[vout];

  if (!out) {
    return 0;
  }

  return sats(out.value);
}

async function getInputValues(tx) {
  const values = [];

  for (const vin of tx.vin || []) {
    if (!vin.txid && vin.vout !== 0) {
      values.push(0);
      continue;
    }

    if (!vin.txid) {
      values.push(0);
      continue;
    }

    const value = await getPrevoutValue(vin.txid, vin.vout);
    values.push(value);
  }

  return values;
}

function mapSatToOutput(tx, absoluteInputOffset) {
  let cursor = 0;

  for (const out of tx.vout || []) {
    const valueSat = sats(out.value);
    const start = cursor;
    const end = cursor + valueSat;

    if (
      absoluteInputOffset >= start &&
      absoluteInputOffset < end
    ) {
      return {
        vout: out.n,
        offset: absoluteInputOffset - start,
        owner: extractAddress(out),
        valueSat,
      };
    }

    cursor = end;
  }

  return null;
}

function txSpendsKnownInscription(tx) {
  for (const vin of tx.vin || []) {
    if (!vin.txid && vin.vout !== 0) continue;
    if (!vin.txid) continue;

    const row = db.prepare(`
      SELECT inscription_id
      FROM inscriptions
      WHERE current_txid=?
        AND current_vout=?
      LIMIT 1
    `).get(vin.txid, vin.vout);

    if (row) return true;
  }

  return false;
}

async function processMovements(tx, height, blockTime) {
  if (!txSpendsKnownInscription(tx)) {
    return 0;
  }

  const inputValues = await getInputValues(tx);
  let moved = 0;

  for (let vinIndex = 0; vinIndex < (tx.vin || []).length; vinIndex++) {
    const vin = tx.vin[vinIndex];

    if (!vin.txid && vin.vout !== 0) continue;
    if (!vin.txid) continue;

    const rows = db.prepare(`
      SELECT *
      FROM inscriptions
      WHERE current_txid=?
        AND current_vout=?
    `).all(vin.txid, vin.vout);

    if (rows.length === 0) continue;

    const inputBaseOffset = inputValues
      .slice(0, vinIndex)
      .reduce((a, b) => a + b, 0);

    for (const ins of rows) {
      const absolute =
        inputBaseOffset + Number(ins.current_offset || 0);

      const mapped = mapSatToOutput(tx, absolute);

      if (!mapped) {
        console.log(
          `WARN could not map ${ins.inscription_id} in tx ${tx.txid}`
        );
        continue;
      }

      db.prepare(`
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
      `).run(
        ins.inscription_id,
        ins.current_txid,
        ins.current_vout,
        ins.current_offset || 0,
        tx.txid,
        mapped.vout,
        mapped.offset,
        mapped.owner,
        mapped.valueSat,
        height,
        blockTime
      );

      db.prepare(`
        UPDATE inscriptions
        SET
          current_txid=?,
          current_vout=?,
          current_offset=?,
          current_owner=?,
          current_value_sat=?,
          updated_height=?
        WHERE inscription_id=?
      `).run(
        tx.txid,
        mapped.vout,
        mapped.offset,
        mapped.owner,
        mapped.valueSat,
        height,
        ins.inscription_id
      );

      console.log(
        `MOVE ${ins.inscription_id} -> ${tx.txid}:${mapped.vout}:${mapped.offset} owner=${mapped.owner}`
      );

      moved++;
    }
  }

  return moved;
}

async function processGenesis(tx, height, blockTime) {
  const detected = detectDoginalVin(tx);

  if (!detected) {
    return 0;
  }

  const inputValues = await getInputValues(tx);

  const absolute = inputValues
    .slice(0, detected.vinIndex)
    .reduce((a, b) => a + b, 0);

  const mapped = mapSatToOutput(tx, absolute);

  if (!mapped) {
    console.log(`WARN could not map genesis ${tx.txid}`);
    return 0;
  }

  const inscriptionId = `${tx.txid}i0`;

  const info = db.prepare(`
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
  `).run(
    inscriptionId,

    tx.txid,
    mapped.vout,
    mapped.offset,

    tx.txid,
    mapped.vout,
    mapped.offset,

    mapped.owner,
    mapped.valueSat,

    detected.contentType,

    height,
    height
  );

  if (info.changes > 0) {
    console.log(
      `NEW ${inscriptionId} -> ${tx.txid}:${mapped.vout}:${mapped.offset} owner=${mapped.owner} type=${detected.contentType}`
    );
    return 1;
  }

  return 0;
}

async function scanBlock(height) {
  const hash = await rpc("getblockhash", [height]);
  const block = await rpc("getblock", [hash, 2]);

  let newCount = 0;
  let moveCount = 0;

  for (const tx of block.tx || []) {
    moveCount += await processMovements(tx, height, block.time);
    newCount += await processGenesis(tx, height, block.time);
  }

  setState("last_height", height);

  console.log(
    `BLOCK ${height} DONE | new=${newCount} moves=${moveCount}`
  );
}

async function main() {
  let height = Number(getState("last_height", START_HEIGHT));

  console.log(`Doginals LIGHT sat tracker starting at block ${height}`);

  while (true) {
    try {
      const tip = await rpc("getblockcount");

      while (height <= tip) {
        await scanBlock(height);
        height++;
      }

      console.log(`At tip ${tip}. Waiting...`);
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
