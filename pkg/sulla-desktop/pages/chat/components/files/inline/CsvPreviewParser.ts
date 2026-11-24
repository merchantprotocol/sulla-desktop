// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const INLINE_CSV_MAX_ROWS = 12;
export const INLINE_CSV_MAX_COLUMNS = 12;
export const INLINE_CSV_MAX_CHARACTERS = 256_000;

export interface CsvPreviewOptions {
  maxRows?: number;
  maxColumns?: number;
  maxCharacters?: number;
  /** False when the authorized read itself was capped before reaching EOF. */
  sourceComplete?: boolean;
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  shownRows: number;
  totalRows?: number;
  hasMoreRows?: boolean;
  hasMoreColumns: boolean;
  truncated: boolean;
  malformed: boolean;
}

/** Parses bounded CSV text without retaining rows or columns outside the preview window. */
export class CsvPreviewParser {
  parse(source: string, options: CsvPreviewOptions = {}): CsvPreview {
    const maxRows = Math.max(0, options.maxRows ?? INLINE_CSV_MAX_ROWS);
    const maxColumns = Math.max(1, options.maxColumns ?? INLINE_CSV_MAX_COLUMNS);
    const maxCharacters = Math.max(1, options.maxCharacters ?? INLINE_CSV_MAX_CHARACTERS);
    const truncated = source.length > maxCharacters || options.sourceComplete === false;
    const input = source.slice(0, maxCharacters);
    const boundedComplete = !truncated;
    const retainedRecords: string[][] = [];
    let currentRecord: string[] = [];
    let cell = '';
    let inQuotes = false;
    let malformed = false;
    let hasMoreColumns = false;
    let recordCount = 0;

    const finishCell = (): void => {
      if (currentRecord.length < maxColumns) currentRecord.push(cell);
      else hasMoreColumns = true;
      cell = '';
    };

    const finishRecord = (): void => {
      finishCell();
      recordCount += 1;
      if (retainedRecords.length < maxRows + 1) retainedRecords.push(currentRecord);
      currentRecord = [];
    };

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];

      if (inQuotes) {
        if (character === '"') {
          if (input[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cell += character;
        }
        continue;
      }

      if (character === '"' && cell.length === 0) {
        inQuotes = true;
      } else if (character === ',') {
        finishCell();
      } else if (character === '\n' || character === '\r') {
        finishRecord();
        if (character === '\r' && input[index + 1] === '\n') index += 1;
      } else {
        cell += character;
      }
    }

    if (inQuotes && boundedComplete) malformed = true;
    // A trailing record separator already finished its row. Avoid inventing an
    // extra empty row, but preserve a final empty cell after a trailing comma.
    if (input.length > 0 && (cell.length > 0 || currentRecord.length > 0 || !/[\r\n]$/.test(input))) {
      finishRecord();
    }

    const headers = (retainedRecords[0] ?? []).map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
    const rows = retainedRecords.slice(1);
    const parsedDataRows = Math.max(0, recordCount - 1);
    const totalRows = boundedComplete ? parsedDataRows : undefined;

    return {
      headers,
      rows,
      shownRows: rows.length,
      totalRows,
      hasMoreRows: totalRows === undefined ? undefined : totalRows > maxRows,
      hasMoreColumns,
      truncated,
      malformed,
    };
  }
}
