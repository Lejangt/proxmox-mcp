# The OS keyring is not available inside the container. Provide secrets with
# environment variables, files under /run/secrets, or a secret manager.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json LICENSE README.md ./
RUN npm ci --omit=dev --omit=optional
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "dist/index.js"]
