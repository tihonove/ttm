FROM node:24-alpine
RUN apk add --no-cache git git-daemon && git config --system safe.directory '*'
WORKDIR /app
COPY package.json ./
COPY packages/git packages/git
COPY packages/parser packages/parser
COPY apps/server apps/server
# The server has no third-party dependencies; only the workspace link is needed.
RUN mkdir -p node_modules/@ttm && ln -s ../../packages/git node_modules/@ttm/git && ln -s ../../packages/parser node_modules/@ttm/parser
USER node
ENV PORT=8080 TTM_REPO=/data/repos/notes.git
EXPOSE 8080
CMD ["node", "apps/server/src/main.ts"]
