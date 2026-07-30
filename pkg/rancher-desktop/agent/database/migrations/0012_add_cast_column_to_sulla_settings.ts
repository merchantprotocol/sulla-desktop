export const up = `
  ALTER TABLE sulla_settings ADD COLUMN IF NOT EXISTS "cast" TEXT;
`;

export const down = `
  ALTER TABLE sulla_settings DROP COLUMN IF EXISTS "cast";
`;
