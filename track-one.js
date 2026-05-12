const axios = require("axios");
require("dotenv").config();

const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:22555";

const targets = [
  {
    name: "first",
    inscriptionId: "4b6195fee728f6f25a0ff2b5601bf3c37cd8bd233c08525f11d005c48670a7fdi0",
    txid: "4b6195fee728f6f25a0ff2b5601bf3c37cd8bd233c08525f11d005c48670a7fd",
    vout: 0,
    startHeight: 4985336,
  },
  {
    name: "second",
    inscriptionId: "86a4ad5df44547a6a3f2f0e1645b410a2c5b43d7c4d5797327341d24f4f16855i0",
    txid: "86a4ad5df44547a6a3f2f0e1645b410a2c5b43d7c4d5797327341d24f4f16855",
    vout: 0,
    startHeight: 4985336,
  },
];

async function rpc(method, params = []) {
  const res = await axios.post(
    RPC_URL,
    { jsonrpc: "1.0", id: "track-one", method, params },
    {
      auth: { username: RPC_USER, password: RPC_PASSWORD },
      headers: { "content-type": "text/plain" },
      timeout: 60000,
    }
  );

  if (res.data.error) throw new Error(res.data.error.message);
  return res.data.result;
}

function extractAddress(vout) {
  return (
    vout?.scriptPubKey?.addresses?.[0] ||
    vout?.scriptPubKey?.address ||
    null
  );
}

async function isUnspent(txid, vout) {
  const res = await rpc("gettxout", [txid, vout]);
  return !!res;
}

async function findSpend(txid, vout, fromHeight, tip) {
  for (let h = fromHeight; h <= tip; h++) {
    if (h % 1000 === 0) {
      console.log(`Scanning height ${h}/${tip} for ${txid}:${vout}`);
    }

    const hash = await rpc("getblockhash", [h]);
    const block = await rpc("getblock", [hash, 2]);

    for (const tx of block.tx || []) {
      for (const vin of tx.vin || []) {
        if (vin.txid === txid && vin.vout === vout) {
          return { tx, height: h, blockTime: block.time };
        }
      }
    }
  }

  return null;
}

async function trackTarget(target) {
  const tip = await rpc("getblockcount");

  let currentTxid = target.txid;
  let currentVout = target.vout;
  let scanFrom = target.startHeight;
  let hops = 0;

  console.log(`\nTracking ${target.inscriptionId}`);
  console.log(`Start: ${currentTxid}:${currentVout}`);

  while (true) {
    const unspent = await isUnspent(currentTxid, currentVout);

    if (unspent) {
      const tx = await rpc("getrawtransaction", [currentTxid, true]);
      const out = tx.vout[currentVout];
      const owner = extractAddress(out);

      console.log("\nCURRENT HOLDER FOUND");
      console.log({
        inscriptionId: target.inscriptionId,
        currentTxid,
        currentVout,
        owner,
        valueDoge: out.value,
        hops,
      });
      return;
    }

    const spend = await findSpend(currentTxid, currentVout, scanFrom, tip);

    if (!spend) {
      console.log("\nSpend not found up to tip");
      console.log({ currentTxid, currentVout, scanFrom, tip, hops });
      return;
    }

    const nextTx = spend.tx;
    const nextVout = 0;
    const nextOut = nextTx.vout[nextVout];
    const nextOwner = extractAddress(nextOut);

    console.log("\nMOVE FOUND");
    console.log({
      from: `${currentTxid}:${currentVout}`,
      to: `${nextTx.txid}:${nextVout}`,
      owner: nextOwner,
      valueDoge: nextOut?.value,
      height: spend.height,
    });

    currentTxid = nextTx.txid;
    currentVout = nextVout;
    scanFrom = spend.height;
    hops++;

    if (hops > 100) {
      console.log("Too many hops, stopping.");
      return;
    }
  }
}

async function main() {
  for (const target of targets) {
    await trackTarget(target);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
