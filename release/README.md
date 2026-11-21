# Release image

The agent server is built on GitHub, never on the server that runs it. On every change to `main`,
`.github/workflows/image.yml` builds `apps/agent/Dockerfile`, publishes it to GHCR as
`ghcr.io/hamchowderr/locus-agent:sha-<commit>` and `:latest`, then moves the branch `release/locus-agent` to that
commit.

| App | URL | Image and branch |
| --- | --- | --- |
| locus-agent | locus-agent.otakusolutions.io | `locus-agent` |
| locus-agent-staging | locus-agent-staging.otakusolutions.io | `locus-agent` |

Both apps deploy from `release/locus-agent` with `release/locus-agent.Dockerfile`, which only names the image published
for that commit (`SOURCE_COMMIT`), so a deploy downloads the image and builds nothing. The branch moves only after the
image is published, so a deploy never asks for an image that is missing. Only main's newest commit moves `latest` and
the release branch, so re-running an older commit's workflow cannot roll the apps back.

Two server settings make this work: each app has "Include source commit in build" on (otherwise `SOURCE_COMMIT` is
empty and the tag is `sha-`), and the server is logged in to `ghcr.io` with a token that can read packages, because
the package is private.
