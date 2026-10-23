// Builds a list of gallery links from NetX.
//
// 1. Finds every asset in NETX_FOLDER_ID (and its subfolders) that has a value in
//    the gallery attribute (NETX_GALLERY_FIELD, e.g. "Project").
// 2. Collects the distinct values and how many assets carry each one.
// 3. Writes site/galleries.json with a portal search link for each value.
//
// No images or asset details are published: the site only lists names and counts,
// and the photos stay behind the NetX Portal login.

const fs = require("fs/promises");
const path = require("path");

const NETX_BASE_URL = (process.env.NETX_BASE_URL || "").replace(/\/$/, "");
const NETX_TOKEN = process.env.NETX_TOKEN;
const GALLERY_FIELD = process.env.NETX_GALLERY_FIELD || "Gallery Title";
const PAGE_TITLE = process.env.NETX_PAGE_TITLE || GALLERY_FIELD;
const FOLDER_ID = process.env.NETX_FOLDER_ID ? Number(process.env.NETX_FOLDER_ID) : null;
// Portal search URL. Use {search} for a NetX portal advanced search (the script encodes
// the search for each value), or {value} to insert the plain URL-encoded value.
const SEARCH_URL = process.env.NETX_PORTAL_SEARCH_URL || "";
const HAS_PLACEHOLDER = SEARCH_URL.includes("{search}") || SEARCH_URL.includes("{value}");
const PAGE_SIZE = 500;
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

async function rpcCall(method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { Authorization: `apiToken ${NETX_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
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
  const assets = await fetchTaggedAssets();

  const counts = new Map();
  for (const asset of assets) {
    for (const value of galleryValues(asset)) counts.set(value, (counts.get(value) || 0) + 1);
  }

  const galleries = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
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

  console.log(`Wrote ${galleries.length} ${GALLERY_FIELD} values from ${assets.length} assets.`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
