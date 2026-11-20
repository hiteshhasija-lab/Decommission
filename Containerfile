# The decommission orchestrator: Node.js service + govc (VMware's govmomi CLI) for vSphere.
FROM docker.io/library/node:22-slim

ARG GOVC_VERSION=v0.56.0
ARG TARGETARCH
# govc release assets are named Linux_arm64 / Linux_x86_64; the download is checked against the
# release's own checksums file.
RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends curl ca-certificates; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in arm64) a=arm64 ;; amd64) a=x86_64 ;; *) echo "unsupported arch"; exit 1 ;; esac; \
    f="govc_Linux_${a}.tar.gz"; \
    cd /tmp; \
    curl -fsSLO "https://github.com/vmware/govmomi/releases/download/${GOVC_VERSION}/${f}"; \
    curl -fsSL -o checksums.txt "https://github.com/vmware/govmomi/releases/download/${GOVC_VERSION}/checksums.txt"; \
    grep " ${f}\$" checksums.txt | sha256sum -c -; \
    tar -xzf "${f}" -C /usr/local/bin govc; chmod 755 /usr/local/bin/govc; \
    rm -f /tmp/*.tar.gz /tmp/checksums.txt; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    govc version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
