import { del, get, list } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import type { SiteFileStore } from "./site-files.ts";

/**
 * Every site's files in one private Vercel Blob store on Otaku's account, reached with the
 * store's read–write token. The token stays in Locus: a site gets one client token per upload.
 */
export function blobFileStore(token: string): SiteFileStore {
  return {
    uploadToken: ({ pathname, contentType, maxBytes, validUntil }) =>
      generateClientTokenFromReadWriteToken({
        token,
        pathname,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
        validUntil,
        addRandomSuffix: false,
        allowOverwrite: false,
      }),
    async read(pathname) {
      const found = await get(pathname, { access: "private", token });
      if (found?.statusCode !== 200) return null;
      return { body: found.stream, contentType: found.blob.contentType, size: found.blob.size };
    },
    async delete(pathnames) {
      if (pathnames.length > 0) await del(pathnames, { token });
    },
    async list(prefix, cursor) {
      const page = await list({ prefix, token, limit: 100, ...(cursor ? { cursor } : {}) });
      return {
        files: page.blobs.map((b) => ({
          pathname: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
        })),
        cursor: page.hasMore && page.cursor ? page.cursor : null,
      };
    },
  };
}
