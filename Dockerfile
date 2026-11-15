FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-alpine AS final
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
USER node
CMD ["node", "dist/main"]
