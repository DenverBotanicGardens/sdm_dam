// Builds a list of gallery links from NetX.
//
// Fast mode (default):
// 1. Gets the list of values for the gallery attribute (NETX_GALLERY_FIELD, e.g. "Project").
// 2. For each value, asks NetX how many assets in NETX_FOLDER_ID (and its subfolders)
//    have it. Only the count comes back, not the assets, so this stays quick even
//    with tens of thousands of assets. Values with no assets in the folder are skipped.
// 3. Writes site/galleries.json with a portal search link for each value.
//
// Full mode (NETX_COUNT_MODE=full, or automatic fallback if the token can't list
// attribute values) downloads every tagged asset and counts them, as before.
//
// No images or asset details are published: the site only lists names and counts,
// and the photos stay behind the NetX Portal login.

const fs = require("fs/promises");
const path = require("path");

const NETX_BASE_URL = (process.env.NETX_BASE_URL || "").replace(/\/$/, "");
const NETX_TOKEN = process.env.NETX_TOKEN;
const GALLERY_FIELD = process.env.NETX_GALLERY_FIELD || "Project";
const PAGE_TITLE = process.env.NETX_PAGE_TITLE || GALLERY_FIELD;
const FOLDER_ID = process.env.NETX_FOLDER_ID ? Number(process.env.NETX_FOLDER_ID) : null;
// Portal search URL. Use {search} for a NetX portal advanced search (the script encodes
// the search for each value), or {value} to insert the plain URL-encoded value.
const SEARCH_URL = process.env.NETX_PORTAL_SEARCH_URL || "";
const HAS_PLACEHOLDER = SEARCH_URL.includes("{search}") || SEARCH_URL.includes("{value}");
// Optional: the attribute's numeric ID; looked up by name if not set.
const ATTRIBUTE_ID = process.env.NETX_GALLERY_ATTRIBUTE_ID ? Number(process.env.NETX_GALLERY_ATTRIBUTE_ID) : null;
const COUNT_MODE = (process.env.NETX_COUNT_MODE || "fast").toLowerCase();
const COUNT_CONCURRENCY = 4;
const PAGE_SIZE = 250;
const SITE_DIR = "site";

if (!NETX_BASE_URL || !NETX_TOKEN) {
  console.error("NETX_BASE_URL and NETX_TOKEN must be set.");
  process.exit(1);
}
if (!FOLDER_ID) {
  console.error("NETX_FOLDER_ID must be set so only that folder's assets are counted.");
  process.exit(1);
}
if (!HAS_PLACEHOLDER) {
  console.warn("NETX_PORTAL_SEARCH_URL is missing or has no {search} or {value}; names will be listed without links.");
}

// The portal stores an advanced search in the URL as base64-encoded JSON.
// This matches the format of a portal "Project is <value>" search.
function portalAdvancedSearch(value) {
  const search = {
    a: "file",
    b: 0,
    c: 0,
    d: [3],
    e: [4],
    f: [0],
    g: [value],
    h: [GALLERY_FIELD],
    i: [""]
  };
  return Buffer.from(JSON.stringify(search), "utf8").toString("base64");
}

function linkFor(value) {
  if (!HAS_PLACEHOLDER) return null;
  return SEARCH_URL
    .split("{search}").join(portalAdvancedSearch(value))
    .split("{value}").join(encodeURIComponent(value));
}

const rpcUrl = `${NETX_BASE_URL}/api/rpc`;

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors worth retrying: dropped connections, timeouts, rate limits and server errors.
// Bad tokens (401/403) and bad queries fail immediately.
class RetryableError extends Error {}

async function rpcOnce(method, params) {
  let res;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { Authorization: `apiToken ${NETX_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw new RetryableError(`network error (${describe(err)})`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);

  let json;
  try {
    json = await res.json(); // a connection dropped mid-response fails here ("terminated")
  } catch (err) {
    throw new RetryableError(`response cut off (${describe(err)})`);
  }
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

function describe(err) {
  const cause = err && err.cause && (err.cause.code || err.cause.message);
  return [err && (err.name === "TimeoutError" ? "timed out" : err.message), cause].filter(Boolean).join(": ");
}

async function rpcCall(method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpcOnce(method, params);
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err;
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${method} failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
      }
      const wait = 5000 * 2 ** (attempt - 1); // 5s, 10s, 20s, 40s
      console.warn(`${method}: ${err.message}. Retrying in ${wait / 1000}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }
}

async function fetchTaggedAssets() {
  const query = [
    { operator: "and", exists: { attribute: GALLERY_FIELD } },
    { operator: "and", folder: { folderId: FOLDER_ID, recursive: true } }
  ];
  const assets = [];
  let startIndex = 0;
  let total = Infinity;
  while (startIndex < total) {
    const result = await rpcCall("getAssetsByQuery", [
      { query },
      { page: { startIndex, size: PAGE_SIZE }, data: ["asset.id", "asset.attributes"] }
    ]);
    const page = result.results || [];
    total = result.size ?? page.length;
    assets.push(...page);
    if (page.length === 0) break;
    startIndex += page.length;
    console.log(`Fetched ${assets.length} of ${total} assets`);
  }
  return assets;
}

// ---- Ordering ----
// Titles that start with a date or number (e.g. "20260412 Orchid Show") come first,
// newest first. Everything else follows, alphabetically.
const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

function compareGalleries(a, b) {
  const da = (a.match(/^\d+/) || [""])[0];
  const db = (b.match(/^\d+/) || [""])[0];
  if (da && !db) return -1;
  if (!da && db) return 1;
  if (da && db && da !== db) return da < db ? 1 : -1; // YYYYMMDD compares correctly as text
  return byText(a, b); // same date, or both without a date
}

// ---- Fast mode ----

async function findAttributeId() {
  if (ATTRIBUTE_ID) return ATTRIBUTE_ID;
  let startIndex = 0;
  let total = Infinity;
  while (startIndex < total) {
    const result = await rpcCall("getAttributes", [{ page: { startIndex, size: 100 } }]);
    const page = result.results || [];
    total = result.size ?? page.length;
    const hit = page.find(a => a && a.name === GALLERY_FIELD);
    if (hit) return hit.id;
    if (page.length === 0) break;
    startIndex += page.length;
  }
  throw new Error(`No attribute named "${GALLERY_FIELD}" was found.`);
}

async function listAttributeValues(attributeId) {
  const values = [];
  let startIndex = 0;
  let total = Infinity;
  while (startIndex < total) {
    const result = await rpcCall("getValuesByAttribute", [attributeId, { page: { startIndex, size: 500 } }]);
    const page = result.results || [];
    total = result.size ?? page.length;
    for (const item of page) {
      const value = typeof item === "string" ? item : item && item.value;
      if (value != null && String(value).trim()) values.push(String(value).trim());
    }
    if (page.length === 0) break;
    startIndex += page.length;
  }
  return [...new Set(values)];
}

// How many assets in the folder have this exact value. Asks for one result; NetX
// reports the full match count in "size".
async function countAssetsWithValue(value) {
  const result = await rpcCall("getAssetsByQuery", [
    {
      query: [
        { operator: "and", exact: { attribute: GALLERY_FIELD, value } },
        { operator: "and", folder: { folderId: FOLDER_ID, recursive: true } }
      ]
    },
    { page: { startIndex: 0, size: 1 }, data: ["asset.id"] }
  ]);
  return result.size ?? (result.results || []).length;
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function countsFast() {
  const attributeId = await findAttributeId();
  const values = await listAttributeValues(attributeId);
  console.log(`"${GALLERY_FIELD}" (attribute ${attributeId}) has ${values.length} values; counting assets in folder ${FOLDER_ID}...`);

  const counts = new Map();
  let done = 0;
  await runPool(values, COUNT_CONCURRENCY, async value => {
    const count = await countAssetsWithValue(value);
    if (count > 0) counts.set(value, count);
    done++;
    if (done % 25 === 0 || done === values.length) console.log(`Counted ${done} of ${values.length} values`);
  });
  return counts;
}

// ---- Full mode ----

async function countsFull() {
  const assets = await fetchTaggedAssets();
  const counts = new Map();
  for (const asset of assets) {
    for (const value of galleryValues(asset)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  console.log(`Counted values on ${assets.length} assets.`);
  return counts;
}

// asset.attributes may come back as a name -> values map or as a list of
// { name, value(s) } objects depending on NetX version; handle both.
function galleryValues(asset) {
  const attrs = asset.attributes;
  if (!attrs) return [];
  let raw;
  if (Array.isArray(attrs)) {
    const hit = attrs.find(a => a && (a.name === GALLERY_FIELD || a.label === GALLERY_FIELD));
    raw = hit ? (hit.values ?? hit.value) : undefined;
  } else {
    raw = attrs[GALLERY_FIELD];
  }
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return [...new Set(list.map(v => String(v).trim()).filter(Boolean))];
}

(async () => {
  const started = Date.now();
  let counts;
  if (COUNT_MODE === "full") {
    console.log("Full mode: downloading every tagged asset.");
    counts = await countsFull();
  } else {
    try {
      counts = await countsFast();
    } catch (err) {
      console.warn(`Fast counting failed (${err.message}). Falling back to downloading every tagged asset.`);
      counts = await countsFull();
    }
  }

  const galleries = [...counts.entries()]
    .sort(([a], [b]) => compareGalleries(a, b))
    .map(([title, count]) => ({
      title,
      count,
      url: linkFor(title)
    }));

  await fs.mkdir(SITE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SITE_DIR, "galleries.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), title: PAGE_TITLE, galleries }, null, 2),
    "utf8"
  );
  await fs.copyFile("index.html", path.join(SITE_DIR, "index.html"));

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`Wrote ${galleries.length} ${GALLERY_FIELD} values in ${seconds}s.`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
