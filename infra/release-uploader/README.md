# Release uploader

A small Cloudflare Worker that lets CI publish release files to the
`sulla-desktop-releases` R2 bucket (served at `https://releases.sulladesktop.com`)
using one bearer token, with no Cloudflare API token or R2 access keys in CI.

It can only **write** objects under `releases/` and `channels/`. It cannot read,
list or delete anything. Large files are sent in parts of at most 95 MB (a Worker
request body is limited to about 100 MB) and assembled by R2 multipart upload.

## API

All routes need `Authorization: Bearer <UPLOAD_TOKEN>`.

| Route | Purpose |
|---|---|
| `POST /v1/upload/create?key=K[&contentType=T][&cacheControl=C]` | start a multipart upload, returns `{uploadId}` |
| `PUT /v1/upload/part?key=K&uploadId=U&partNumber=N` | upload one part (body, `Content-Length` required), returns `{partNumber, etag}` |
| `POST /v1/upload/complete?key=K&uploadId=U` | body `{"parts":[{"partNumber":1,"etag":"..."}]}`, returns `{key,size,etag}` |
| `POST /v1/upload/abort?key=K&uploadId=U` | cancel an upload |
| `PUT /v1/object?key=K[&contentType=T][&cacheControl=C]` | upload a small file (at most 95 MB) in one request |

CI talks to it through `scripts/release/publish-to-releases.mjs`; the release
flow and bucket layout are in [`docs/releasing.md`](../../docs/releasing.md).

`cacheControl` must be one of `no-cache`, `no-store`, `public, max-age=300`,
`public, max-age=31536000, immutable`. Use `no-cache` for the update feed
(`latest-mac.yml`) and the immutable value for versioned zips.

## Deploy and secrets

```bash
cd infra/release-uploader
npx wrangler deploy

# Generate the token once and store it in both places without printing it.
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | npx wrangler secret put UPLOAD_TOKEN
printf %s "$TOKEN" | gh secret set RELEASES_UPLOAD_TOKEN -R merchantprotocol/sulla-desktop
unset TOKEN

gh variable set RELEASES_UPLOAD_URL --body "https://<worker>.workers.dev" -R merchantprotocol/sulla-desktop
```

Notes:

- Run `wrangler` from a folder without a `.env` that sets `CLOUDFLARE_API_TOKEN`
  (wrangler loads it automatically and it overrides `wrangler login`), or the wrong
  account is used.
- Pass `-R` to `gh`: a checkout with several git remotes makes `gh` refuse to guess.
- A new secret takes a few seconds to reach the Worker; retry on a 401 right after setting it.
- To rotate the token, run the block again. The old token stops working immediately.
