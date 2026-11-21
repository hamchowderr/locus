# What Coolify deploys for locus-agent and locus-agent-staging: the image GitHub Actions built for this commit (README.md).
ARG SOURCE_COMMIT
FROM ghcr.io/hamchowderr/locus-agent:sha-${SOURCE_COMMIT}
