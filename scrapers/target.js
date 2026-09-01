/**
 * Target scraper — uses Target's internal Redsky aggregation API (same JSON
 * endpoint Target's own website uses for search and category pages).
 *
 * Authentication note:
 *   The API key below is embedded in Target's front-end JS bundle. If requests
 *   start returning 400 "Bad Request", the key has rotated. To get the new one:
 *     1. Open target.com → DevTools → Network tab
 *     2. Filter for "redsky_aggregations"
 *     3. Copy the `key` query param from any request URL
 *
 *   The `pricing_store_id` (store number) must also be a valid Target store.
 *   1375 is a Chicago-area store that consistently works for pricing lookups.
 *
 * Stock status strategy:
 *   Two-pass approach — one pass with purchasability filter ON (in-stock only),
 *   one pass with it OFF (all products). TCINs in both → in_stock.
 *   TCINs only in the unfiltered pass → out_of_stock.
 *   Pre-orders are detected via price-type annotation in the API response.
 */

const axios = require('axios');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

// ── API config ─────────────────────────────────────────────────────────────────

const REDSKY_BASE   = 'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2';
const FULFILLMENT_BASE = 'https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1';
const REDSKY_KEY    = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const VISITOR_ID    = '018c8d4b-a1b7-7e65-8e16-e60f2a64b4a6';
const STORE_ID      = '1375';  // Chicago area — change if this breaks pricing lookups

const COUNT         = 24;
const DELAY_MS      = 1500;
const MAX_RETRIES   = 3;

// Search terms — first term is used for both passes; additional terms run OOS-only for discovery
const SEARCH_KEYWORD  = 'pokemon cards';
const EXTRA_KEYWORDS  = ['pokemon trading card game', 'pokemon booster'];

// ── HTTP ──────────────────────────────────────────────────────────────────────

const REQUEST_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Referer':         `https://www.target.com/s?searchTerm=${encodeURIComponent(SEARCH_KEYWORD)}`,
  'Origin':          'https://www.target.com',
};

const BASE_PARAMS = {
  keyword:                      SEARCH_KEYWORD,
  channel:                      'WEB',
  platform:                     'desktop',
  page:                         '/search',
  visitor_id:                   VISITOR_ID,
  key:                          REDSKY_KEY,
  pricing_store_id:             STORE_ID,
  scheduled_delivery_store_id:  STORE_ID,
  store_id:                     STORE_ID,
  fulfillment_test_mode:        'grocery',
  zip:                          '60601',
  state:                        'IL',
  latitude:                     '41.882',
  longitude:                    '-87.628',
  include_sponsored:            true,
};

async function fetchRedsky(params) {
  return withRetry(
    async () => {
      try {
        const res = await axios.get(REDSKY_BASE, {
          params:     { ...BASE_PARAMS, ...params },
          headers:    REQUEST_HEADERS,
          timeout:    22000,
          decompress: true,
        });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        if (status === 400) {
          const msg = err.response?.data?.errors?.[0]?.message ?? 'Bad Request';
          const e   = new Error(`[Target] Redsky 400: ${msg} — API key may have rotated (see file header)`);
          e.permanent = true;
          throw e;
        }
        if (status === 403) {
          const e = new Error('[Target] Redsky 403: Forbidden — API key rejected or IP blocked');
          e.permanent = true;
          throw e;
        }
        throw err;
      }
    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 2000,
      isRetryable(err) {
        if (err.permanent) return false;
        const status = err.response?.status;
        return !status || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      onRetry(err, attempt, delayMs) {
        console.warn(`[Target] Attempt ${attempt} failed (${err.message}), retrying in ${delayMs / 1000}s…`);
      },
    },
  );
}async function fetchFulfillmentByTcins(tcins) {
  if (!tcins?.length) return [];

  const res = await axios.get(
    'https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1',
    {
      params: {
        key: REDSKY_KEY,
        tcins: tcins.join(','),
        store_id: process.env.TARGET_STORE_ID || STORE_ID,
        scheduled_delivery_store_id: process.env.TARGET_STORE_ID || STORE_ID,
        required_store_id: process.env.TARGET_STORE_ID || STORE_ID,
        zip: process.env.TARGET_ZIP || BASE_PARAMS.zip,
        state: process.env.TARGET_STATE || BASE_PARAMS.state,
        latitude: process.env.TARGET_LATITUDE || BASE_PARAMS.latitude,
        longitude: process.env.TARGET_LONGITUDE || BASE_PARAMS.longitude,
        channel: 'WEB',
page: '/s/pokemon cards',
        visitor_id: process.env.TARGET_VISITOR_ID,
        paid_membership: false,
        base_membership: true,
        card_membership: false,
      },
      headers: REQUEST_HEADERS,
      timeout: 22000,
    }
  );

  return res.data;
}

// ── Paged fetch — returns all TCINs across pages ──────────────────────────────

async function fetchAllTcins(purchasabilityFilter) {
  const label = purchasabilityFilter ? 'in-stock' : 'all';
  const tcins = new Map(); // tcin → raw product object
  let offset = 0;
  let total  = Infinity;
  let page   = 0;

  while (offset < total && page < config.maxPages) {
    let data;
    try {
      data = await fetchRedsky({
        count: COUNT,
        offset,
        default_purchasability_filter: purchasabilityFilter,
      });
    } catch (err) {
      console.error(`[Target] ${label} pass — page ${page + 1} failed: ${err.message}`);
      break;
    }

    const search = data?.data?.search ?? {};
    const items  = search?.products ?? [];
    const meta   = search?.search_response?.metadata ?? {};

    if (page === 0) {
      total = meta.total_results ?? items.length;
      console.log(`[Target] ${label} pass: ${total} total results across ${meta.total_pages ?? '?'} pages`);
    }

    if (items.length === 0) break;

    for (const raw of items) {
      const tcin = raw?.tcin ?? raw?.item?.tcin;
      if (tcin) tcins.set(tcin, raw);
    }

    offset  += COUNT;
    page    += 1;

    if (offset < total && page < config.maxPages) await sleep(DELAY_MS);
  }

  return tcins;
}

// ── Product normalisation ─────────────────────────────────────────────────────

/**
 * Returns true when item is sold and fulfilled by Target directly.
 * `is_marketplace: true` marks 3rd-party TargetPlus sellers.
 */
function isSoldByTarget(raw) {
  if (raw?.item?.fulfillment?.is_marketplace === true) return false;
  // Some older API shapes use relationship_type
  const rel = raw?.item?.relationship_type ?? '';
  if (rel === 'TargetPlus' || rel === 'TargetPlus_CollectionItem') return false;
  return true;
}

/**
 * Detect pre-orders from price annotation returned by Redsky.
 * `formatted_current_price_type === 'pre_order'` is Target's own label.
 */
function isPreOrder(raw) {
  const priceType = raw?.price?.formatted_current_price_type ?? '';
  return priceType === 'pre_order' || priceType === 'preorder';
}

function buildUrl(raw) {
  // buy_url is now a full URL, not a path
  const buyUrl = raw?.item?.enrichment?.buy_url ?? '';
  if (buyUrl.startsWith('http')) return buyUrl;
  if (buyUrl.startsWith('/'))    return `https://www.target.com${buyUrl}`;
  const tcin = raw?.tcin ?? raw?.item?.tcin;
  return `https://www.target.com/p/-/A-${tcin}`;
}

/**
 * Check whether the configured store has this item available for in-store pickup.
 * The Redsky API returns store_options[] within fulfillment when store_id is passed.
 */
function getInStoreStatus(raw) {
  const storeOptions = raw?.item?.fulfillment?.store_options ?? [];
  const storeOpt = storeOptions.find(o => String(o.location_id) === STORE_ID) ?? storeOptions[0];
  if (!storeOpt) return null;
  const status = storeOpt?.availability?.availability_status ?? storeOpt?.order_pickup?.availability?.availability_status ?? '';
  if (!status) return null;
  return status === 'IN_STOCK' ? 'in_stock' : status === 'OUT_OF_STOCK' ? 'out_of_stock' : status.toLowerCase();
}

function normalizeProduct(raw, stockStatus) {
  const tcin     = raw?.tcin ?? raw?.item?.tcin;
  const name     = raw?.item?.product_description?.title ?? '';
  const price    = raw?.price?.current_retail;
  const regPrice = raw?.price?.reg_retail;
  const brand    = raw?.item?.primary_brand?.name ?? null;

  return {
    id:               `target-${tcin}`,
    retailer:         'target',
    tcin,
    name:             name.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)),
    brand,
    price:            price != null ? `$${Number(price).toFixed(2)}` : 'N/A',
    priceNumeric:     price ?? null,
    regularPrice:     regPrice != null && regPrice !== price ? `$${Number(regPrice).toFixed(2)}` : null,
    url:              buildUrl(raw),
    inStock:          stockStatus === 'in_stock',
    stockStatus,      // 'in_stock' | 'out_of_stock' | 'pre_order'
    inStoreStatus:    getInStoreStatus(raw),  // null if not available from API; 'in_stock' | 'out_of_stock'
    releaseDate:      null, // pre-order date not surfaced in search API; check PDP for details
  };
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeTarget() {
  console.log(`[Target] Starting — keyword: "${SEARCH_KEYWORD}"`);

  // Pass 1: all products (including OOS) — used to discover new listings
  const allPass = await fetchAllTcins(false);
  if (allPass.size === 0) {
    console.warn('[Target] All-products pass returned 0 items');
    throw new Error('Target search failed or was blocked; results were not updated');
  }

  await sleep(DELAY_MS * 2); // pause between passes

  // Pass 2: purchasable items only — used to determine in_stock status
  const inStockPass = await fetchAllTcins(true);
  console.log(`[Target] Pass summary: ${allPass.size} total, ${inStockPass.size} in-stock`);

  const products        = [];
  let   thirdPartyCount = 0;

  for (const [tcin, raw] of allPass) {
    if (!isSoldByTarget(raw)) {
      thirdPartyCount++;
      continue;
    }

    const shippingStatus =
  raw?.item?.fulfillment?.shipping_options?.availability_status ?? '';
const shippingQty = Number(raw?.item?.fulfillment?.shipping_options?.available_to_promise_quantity ?? 0);
console.log(`[Target] DEBUG TCIN=${raw?.tcin ?? raw?.item?.tcin ?? '?'} shipping=${shippingStatus || 'UNKNOWN'} qty=${shippingQty}`);
let stockStatus;

if (isPreOrder(raw)) {
  stockStatus = 'pre_order';
} else if (shippingStatus === 'IN_STOCK' && shippingQty >= 10) {
  stockStatus = 'in_stock';
} else {
  stockStatus = 'out_of_stock';
}

    products.push(normalizeProduct(raw, stockStatus));
  }

  const inStock     = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock  = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder    = products.filter(p => p.stockStatus === 'pre_order').length;
  const inStoreAvail = products.filter(p => p.inStoreStatus === 'in_stock').length;

  console.log(
    `[Target] Done: ${products.length} Target-sold products ` +
    `(${inStock} online in-stock, ${inStoreAvail} in-store, ${outOfStock} OOS, ` +
    `${preOrder} pre-order, ${thirdPartyCount} 3rd-party skipped)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/target.js            → run and show 5 sample products
// node scrapers/target.js --all      → show all products as JSON
// node scrapers/target.js --json     → output raw JSON (pipe-friendly)

if (require.main === module) {
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeTarget()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Target Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:   ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:  ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      sample.forEach((p, i) => {
        const status = { in_stock: '✅ In Stock', out_of_stock: '❌ OOS', pre_order: '🔜 Pre-order' }[p.stockStatus] ?? p.stockStatus;
        console.log(`\n[${i + 1}] ${p.name}`);
        console.log(`    Brand:  ${p.brand ?? 'N/A'}`);
        console.log(`    Price:  ${p.price}${p.regularPrice ? ` (reg ${p.regularPrice})` : ''}`);
        console.log(`    Status: ${status}${p.inStoreStatus === 'in_stock' ? ' (also in-store)' : ''}`);
        console.log(`    URL:    ${p.url}`);
      });
      console.log(`\n${'─'.repeat(70)}`);
    })
    .catch(err => {
      console.error('[Target] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { scrapeTarget, normalizeProduct, isSoldByTarget, isPreOrder, fetchFulfillmentByTcins };
