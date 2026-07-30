export const up = `
  CREATE TABLE IF NOT EXISTS sulla_settings (
    property TEXT PRIMARY KEY,
    value TEXT
  );
`;

export const down = `DROP TABLE IF EXISTS sulla_settings;`;
