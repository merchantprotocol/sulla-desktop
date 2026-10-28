-- SPDX-License-Identifier: GPL-2.0-or-later
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
