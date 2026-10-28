// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Migration 0010: Create sections and categories tables
// Creates the knowledgebase_sections and knowledgebase_categories tables in postgres

export const up = `
-- Create knowledgebase_sections table
CREATE TABLE IF NOT EXISTS knowledgebase_sections (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  "order" VARCHAR(10) DEFAULT '100',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create knowledgebase_categories table
CREATE TABLE IF NOT EXISTS knowledgebase_categories (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  section_id VARCHAR(255) REFERENCES knowledgebase_sections(id) ON DELETE SET NULL,
  "order" VARCHAR(10) DEFAULT '100',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_knowledgebase_categories_section_id ON knowledgebase_categories(section_id);
CREATE INDEX IF NOT EXISTS idx_knowledgebase_sections_order ON knowledgebase_sections("order");
CREATE INDEX IF NOT EXISTS idx_knowledgebase_categories_order ON knowledgebase_categories("order");
`;

export const down = `
-- Drop tables in reverse order due to foreign key constraint
DROP TABLE IF EXISTS knowledgebase_categories;
DROP TABLE IF EXISTS knowledgebase_sections;
`;
