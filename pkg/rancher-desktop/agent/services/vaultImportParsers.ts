/**
 * RFC 4180 CSV parser for password-manager exports. Unlike a line splitter it
 * keeps quoted fields intact when they contain commas, doubled quotes, or
 * newlines (multi-line notes are common in Bitwarden/1Password exports and
 * would otherwise shift passwords into the wrong columns).
 *
 * Returns non-empty records; each field is trimmed of surrounding whitespace.
 */
export function parseCSV(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    record.push(field.trim());
    field = '';
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || record.length > 0) endRecord();

  return records;
}
