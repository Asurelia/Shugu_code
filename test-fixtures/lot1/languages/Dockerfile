# LOT 1 — Dockerfile syntax highlighting + region folding test.
# Tests: basename match (no extension), # comment style, # region folding (regression fix).

# region build-stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
# endregion

# region runtime-stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Run as the unprivileged nginx user (CWE-250: avoid root in container).
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s CMD curl -f http://localhost:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
# endregion
