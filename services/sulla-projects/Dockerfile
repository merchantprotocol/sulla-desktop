FROM node:24-alpine AS build
WORKDIR /app
COPY services/sulla-projects/package.json ./package.json
RUN npm install --ignore-scripts
COPY services/sulla-projects/tsconfig.json ./tsconfig.json
COPY services/sulla-projects/src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production SULLA_PROJECTS_PORT=8793
COPY services/sulla-projects/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8793
USER node
CMD ["node","dist/index.js"]
