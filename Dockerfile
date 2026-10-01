# Sentinel CLI image. No build step, no runtime deps.
FROM node:22-alpine
RUN apk add --no-cache git github-cli
WORKDIR /opt/sentinel
COPY package.json README.md ./
COPY bin ./bin
COPY lib ./lib
COPY mcp ./mcp
COPY apps ./apps
COPY console ./console
COPY policies ./policies
COPY docs ./docs
RUN npm link --omit=dev >/dev/null 2>&1 || ln -s /opt/sentinel/bin/sentinel.js /usr/local/bin/sentinel
USER node
ENTRYPOINT ["sentinel"]
CMD ["--help"]
