# Spending explorer

A private, static browser application for exploring grocery purchase exports.
It has no build step, package installation, Python runtime, or server-side
component. Imported data is processed locally and stored only in the browser.

## Run locally

Open `index.html`, then add or drag-and-drop one or more supported JSON files:

- REMA 1000 GDPR JSON containing `TransactionsInfo`.
- Oda portability JSON containing `orders`.
- An array of canonical purchase lines, or an object containing `rows`.

The browser detects each format, deduplicates imported lines, applies the
category configuration, and rebuilds the analysis immediately. Use **Clear
browser data** to remove the saved browser copy.

Encrypted ZIP exports must be unpacked before import because the browser app
does not support password-protected ZIP files.

## Host the website

Publish the repository with any static host. No build command is required, and
`index.html` is the entry point.

When served over HTTP, the app loads the JSON resources in `config/`
automatically. For direct `file://` use, equivalent defaults are bundled in
`web/default-config.js`, since browsers normally block adjacent JSON requests
from local files. Dropped configuration files override the defaults for the
current session.

## Configuration

- `config/main_categories.json` defines main-category classification.
- `config/subcategories.json` defines subcategory classification.
- `config/product_overrides.json` stores exact product mappings.
- `config/product_family.json` normalizes product families.

After recategorizing selected products in the table, use **Download mappings**
to save an updated `product_overrides.json`.

On the hosted site, **Send category suggestion** sends only the selected product
names and proposed mappings to the project's Cloudflare Worker. The Worker
creates a branch and opens a pull request against `main`; it does not upload
transaction records, prices, dates, addresses, or imported files. A repository
maintainer must review and merge the pull request before it changes the public
configuration.

When configuration JSON changes, update `web/default-config.js` as well so direct
local-file use has matching defaults.

## Privacy

Files under `data/` are ignored by Git and are never requested automatically.
Raw exports can contain names, addresses, order identifiers, purchase history,
and other personal information. Never commit real exports. Review custom
product mappings before submitting them because product names and mappings are
published in the resulting pull request and may reveal personal purchases or
habits.
