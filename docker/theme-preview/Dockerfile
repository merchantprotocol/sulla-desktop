# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --ignore-scripts
COPY . .
EXPOSE 4174
CMD ["yarn", "webpack", "serve", "--config", "scripts/theme-preview-webpack.config.cjs"]
