import { parse } from 'csv-parse/sync';

const MAX_ROWS = 250;
const MAX_COLUMNS = 128;

export function normalizeTypedTicker(raw) {
  if (typeof raw !== 'string') {
    return { raw, typed: null, status: 'unknown', reason: 'ticker_not_text' };
  }
  const typed = raw.trim();
  return {
    raw,
    typed,
    status: typed ? 'ok' : 'unknown',
    ...(typed ? {} : { reason: 'ticker_blank_after_whitespace_trim' }),
  };
}

export function extractCsvRows(text, {
  sourceName = 'source.csv',
  rowStart = 1,
  rowLimit = 100,
  columns,
  tickerColumn,
} = {}) {
  if (typeof text !== 'string') throw new TypeError('csv_text_required');
  if (!Number.isInteger(rowStart) || rowStart < 1) throw new RangeError('invalid_row_start');
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_ROWS) throw new RangeError('invalid_row_limit');

  const records = parse(text, {
    bom: true,
    columns: false,
    cast: false,
    skip_empty_lines: true,
    trim: false,
    ltrim: false,
    rtrim: false,
    relax_column_count: false,
  });
  if (!records.length || !Array.isArray(records[0])) throw new Error('csv_header_missing');

  const headers = records[0];
  if (!headers.length || headers.length > MAX_COLUMNS ||
      headers.some(header => typeof header !== 'string' || !header.trim()) ||
      new Set(headers).size !== headers.length) {
    throw new Error('csv_header_invalid_or_ambiguous');
  }
  if (tickerColumn !== undefined && !headers.includes(tickerColumn)) {
    throw new Error('ticker_column_not_found');
  }

  let selectedColumns = headers;
  if (columns !== undefined) {
    if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS ||
        columns.some(column => typeof column !== 'string') || new Set(columns).size !== columns.length ||
        columns.some(column => !headers.includes(column))) {
      throw new Error('selected_columns_invalid');
    }
    selectedColumns = columns;
  }
  if (tickerColumn !== undefined && !selectedColumns.includes(tickerColumn)) {
    selectedColumns = [...selectedColumns, tickerColumn];
  }

  const data = records.slice(1);
  const first = rowStart - 1;
  const selected = data.slice(first, first + rowLimit);
  const rows = selected.map((record, offset) => {
    const values = Object.fromEntries(selectedColumns.map(column => [column, record[headers.indexOf(column)]]));
    return {
      source_ref: { source: sourceName, csv_record: first + offset + 2 },
      values,
      ...(tickerColumn !== undefined
        ? { typed_ticker: normalizeTypedTicker(record[headers.indexOf(tickerColumn)]) }
        : {}),
    };
  });
  const nextRowStart = first + selected.length < data.length ? first + selected.length + 1 : null;

  return {
    ok: true,
    status: 'ok',
    operation: 'extract_csv',
    source: { name: sourceName, format: 'csv' },
    columns: selectedColumns,
    rows,
    source_refs: rows.map(row => row.source_ref),
    coverage: {
      total_data_records: data.length,
      row_start: rowStart,
      row_limit: rowLimit,
      returned_records: rows.length,
      next_row_start: nextRowStart,
      complete_source: rowStart === 1 && rows.length === data.length,
      exact_cell_values: true,
      value_casting: false,
      ticker_normalization: tickerColumn === undefined ? 'not_requested' : 'trim_outer_whitespace_only_raw_preserved',
    },
    warnings: [],
    error: null,
  };
}
