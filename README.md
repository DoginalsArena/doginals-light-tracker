# Doginals-LIGHT-Tracker

A lightweight ownership and movement tracker for Doginals built directly on top of a local Dogecoin node.

Unlike full Ordinals indexers, this tracker does not store image blobs, raw inscription content, or full blockchain copies inside the database.

The goal is simple:

```txt
Track who owns a Doginal right now.
```

---

## Features

* Lightweight SQLite database
* Uses local Dogecoin node as source of truth
* Tracks current owner of Doginals
* Tracks satpoint locations (`txid:vout:offset`)
* Tracks inscription movements
* Stores genesis transaction references
* Supports multiple content types
* Very low RAM usage
* PM2 compatible
* Easy to extend

---

## Architecture

```txt
Dogecoin Node
=
source of truth

SQLite
=
ownership + movement layer
```

The tracker stores only:

* inscription id
* genesis transaction
* current location
* current owner
* satpoint
* content type

The actual content (PNG, SVG, HTML, JSON, etc.) is never stored inside SQLite.

Content can always be reconstructed later directly from the genesis transaction stored on-chain.

---

## Requirements

You need:

* Node.js 18+
* SQLite3
* Fully synced Dogecoin Core node
* `txindex=1` enabled

---

## Dogecoin Configuration

Example `dogecoin.conf`:

```conf
server=1
daemon=1
txindex=1

rpcuser=dogerpc
rpcpassword=CHANGE_ME

rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```

Restart Dogecoin Core after changing config.

---

## Installation

### 1. Clone repository

```bash
git clone https://github.com//DoginalsArena/doginals-light-tracker.git
cd doginals-light-tracker
```

---

### 2. Install dependencies

```bash
npm install
```

Or manually:

```bash
npm install axios better-sqlite3 dotenv
```

---

### 3. Create `.env`

```bash
nano .env
```

Example:

```env
RPC_USER=dogerpc
RPC_PASSWORD=CHANGE_ME
RPC_URL=http://127.0.0.1:22555

START_HEIGHT=4583000
```

`START_HEIGHT` defines where indexing begins.

---

## Running Tracker

### Run normally

```bash
node indexer.js
```

You should see:

```txt
Doginals LIGHT sat tracker starting at block 4583000
BLOCK 4583000 DONE | new=0 moves=0
```

---

## Running With PM2

### Install PM2

```bash
npm install -g pm2
```

---

### Start tracker

```bash
pm2 start indexer.js --name doginals-tracker
```

---

### Save PM2 state

```bash
pm2 save
```

---

### Check running processes

```bash
pm2 list
```

---

### View logs

```bash
pm2 logs doginals-tracker --lines 50
```

Exit logs with:

```txt
CTRL+C
```

The tracker will continue running in background.

---

## Checking Progress

### Current indexed block

```bash
sqlite3 doginals-tracker.db "SELECT * FROM state;"
```

Example:

```txt
last_height|4724135
```

---

### Count indexed inscriptions

```bash
sqlite3 doginals-tracker.db "
SELECT COUNT(*) FROM inscriptions;
SELECT COUNT(*) FROM movements;
"
```

---

### View latest inscriptions

```bash
sqlite3 -header -column doginals-tracker.db "
SELECT
  inscription_id,
  current_owner,
  current_txid,
  current_vout,
  current_offset,
  content_type,
  created_height,
  updated_height
FROM inscriptions
ORDER BY created_height DESC
LIMIT 10;
"
```

---

## Database Size

### Check database size

```bash
du -sh doginals-tracker.db*
```

---

### Check project folder size

```bash
du -sh .
```

---

## Database Structure

### inscriptions

Stores current state:

* inscription id
* genesis tx
* current tx
* current owner
* satpoint
* content type

---

### movements

Stores historical ownership transfers:

```txt
from tx -> to tx
```

This table can optionally be disabled for an ultra-light deployment.

---

## Supported Content Types

Currently detected:

* image/png
* image/jpeg
* image/jpg
* image/gif
* image/webp
* image/svg+xml
* text/plain
* text/html
* application/json
* application/pdf

More MIME types can easily be added.

---

## Example Satpoint

```txt
txid:vout:offset
```

Example:

```txt
46cbb5bd8ddf51996d3086079e38a4b904ab2ac0baab9a4a528a0fdf667ab3e5:0:0
```

---

## Why This Exists

Most Doginals / Ordinals indexers become extremely heavy because they store:

* Full raw content
* Image blobs
* All outpoints
* Explorer metadata
* Full sat history

This project intentionally avoids that.

The tracker stores only what a marketplace or wallet actually needs.

---

## Future Plans

* REST API
* Marketplace integration
* Collection indexing
* DRC-20 support
* Metadata rebuild API
* SVG renderer
* Content fetch endpoint
* Web dashboard

---

## Disclaimer

This is an experimental Doginals tracker and may still contain edge cases regarding:

* Multipart inscriptions
* Unusual scripts
* Cursed inscriptions
* Non-standard sat flows

Use at your own risk and independently verify important ownership states.

