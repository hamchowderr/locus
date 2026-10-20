---
name: site-media
description: Use when a site needs the client's own images (logo, favicon, team or product photos) or its link-preview (Open Graph) image. How to find them in the client's Media Library and copy them into the site with the crm tool.
license: Proprietary (Otaku Solutions)
---

# Site media

The client keeps their images in their CRM's Media Library. Prefer them to generated or stock
images whenever they fit: a business looks like itself with its own logo and photos.

## Find an image
- `crm` with action `media` lists the newest images: `id`, `name`, `format` (png, jpg, webp,
  gif or ico). Pass `search` to match names ("logo", "team", "storefront").
- Names are the client's own; judge by them, and ask the person when it's unclear which is the
  current logo.
- If you found the image with `search`, pass the same `search` to `use_media`.

## Use it
`crm` with action `use_media`, the image's `id` and `as`:
- `favicon`: the browser-tab icon. A square logo or mark works best; png, jpg or ico. It
  becomes `app/icon.png` (or `.jpg`, or `app/favicon.ico`) and replaces any earlier icon.
- `share`: the image shown when the site's link is shared (Open Graph). Landscape, about
  1200×630, with the business's name or a strong photo; png, jpg or gif. It becomes
  `app/opengraph-image.*` and replaces any earlier one. Next adds the meta tags itself; make
  sure `metadata` in `app/layout.tsx` has `metadataBase: new URL("https://<the site's domain>")`
  once the site has its own domain, so the preview's address points there.
- `image`: any other picture, copied under `public/` (by default
  `public/images/<name>.<format>`, or `path` with the same extension). Reference it as
  `/images/<name>.<format>` with `next/image` or `<img>`, and real alt text.

## Rules
- Never hot-link an image from the CRM's storage address; always copy it with `use_media`, so
  the site serves its own copy.
- SVGs aren't offered (one can carry script). Ask for a PNG version of a logo if only an SVG
  exists.
- Images over 4 MB are refused; ask for a smaller one.
- With no suitable image, use generate_image, and tell the person they can add their own to
  the Media Library later.
