# Manage cached maps

Open **Manage cached maps** in the sidebar. No city needs to be selected first.

- **This browser** lists city datasets and live road fragments. Filter by name,
  area ID, tile or road class. Each row shows its size and download date. Older
  city records may only have an area ID; their displayed date is their last use.
- **Remove** deletes one local record. Other overlapping records can contain the
  same roads. A fragment can cover several nearby cities.
- **Clear all local maps** clears both road stores with one action. Saved designs,
  provider cooldowns and map settings are preserved.
- Roads already on screen remain visible. Pending writes from old loads cannot
  restore cleared records, including in other same-origin tabs. Existing live
  sessions stop writing to the cache; explicitly load a map again to cache it.
- A storage failure is reported as a partial failure, with a retry action available
  through the same clear button. The list reads metadata rather than geometry.

## Enable R2 administration

The feature is disabled unless all server settings are present. It does not use
the search bucket's credentials. Create an additional R2 **Object Read & Write**
credential restricted to the dataset bucket, as described in
[Cloudflare's token documentation](https://developers.cloudflare.com/r2/api/tokens/).

Set these in the server environment, or in `.env.local` for local Vite development:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Exact app origin, such as `https://maps.example.com`; no path or trailing slash |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_DATA_BUCKET` | Dataset bucket, normally `citymap-data`; must differ from `R2_SEARCH_BUCKET` |
| `R2_CACHE_ACCESS_KEY_ID` | Dedicated dataset credential access key |
| `R2_CACHE_SECRET_ACCESS_KEY` | Dedicated dataset credential secret |
| `CACHE_ADMIN_TOKEN` | Random secret of at least 32 characters; for example, generate with `openssl rand -hex 32` |

Never prefix secrets with `VITE_`. Redeploy after changing server settings. Enter
the administrator key in the manager and select **Connect to R2**. The key remains
in memory until the dialog closes; it is never stored in browser storage or a URL.
Use HTTPS for hosted apps. Local HTTP development is supported on localhost.

Authenticated `/api/cache` requests list objects using paginated S3
[ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
Only the `v2/` map prefix is managed. Individual removal groups all revisions and
chunks for a city; live road fragments are currently browser-only. Lists with more
than 1,000 files have **Load more R2 files**; counts reflect the files loaded so far.

**Remove from R2** first publishes a catalog without that city, using a conditional
write so a changed catalog stops deletion. It then removes the latest pointer and
all files beneath that city's exact prefix. Other cities remain in the catalog.
Historical catalog indexes can still contain old city references, whose deleted
city files will be unavailable. **Clear all R2 maps** removes the entire `v2/`
prefix, including catalogs. **Clear local and R2 maps** also clears this browser.

Cloud deletion runs in batches of at most 100 files with four concurrent deletes.
Each batch has a 20-second server budget. The browser continues until the list is
exhausted. Failed batches report partial deletion; retrying is safe. Closing the
dialog can stop the browser between batches; an already-started server batch may
still finish. Reconnect and retry to finish a large deletion.

Do not publish datasets while deleting them. Catalog conditional writes detect a
competing catalog update, but multi-object deletion and publishing are not one
atomic transaction. Uploads that arrive after a deletion listing can remain.

R2 search results, Nominatim leases and provider cooldowns are outside this scope.
Deletion does not remove app-bundled files, raw publisher extracts or browser
caches on other devices. An object removed from R2 can remain in Cloudflare's
delivery cache until it expires or is purged; see
[R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/).
Use the Cloudflare dashboard to purge the affected delivery URLs when immediate
CDN removal is required. No live cloud data is erased when running the test suite.
