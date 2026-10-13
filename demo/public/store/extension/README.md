# Holdback for Shopify (theme app extension)

The widget in `demo/public/holdback.js` is the whole plugin. On Shopify it ships as a theme app extension:

```
extensions/holdback/
  shopify.extension.toml      name + type = "theme"
  blocks/holdback.liquid      app block: one <div data-holdback-item> + settings
  assets/holdback.js          copy of demo/public/holdback.js (npm run shopify:assets)
```

Merchant steps: install the app, open the theme editor, product template, Add block, Apps, **Holdback offers & bids**,
then set the market URL. The block maps the product to a Holdback item by the `item_id` setting, the
`holdback.item_id` product metafield, or the product handle.

Any other site uses the same two lines:

```html
<script src="https://YOUR-MARKET/holdback.js" defer></script>
<div data-holdback-item="monkey-3"></div>
```

The demo store at `/store/` (served by the market server) shows the block on a product page in Shopify's default store style.
It is a local demo page, not a Shopify store.
