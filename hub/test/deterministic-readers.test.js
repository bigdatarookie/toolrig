import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCsvRows, normalizeTypedTicker } from '../src/deterministic-readers.js';

test('CSV reader preserves raw cells and normalizes only an explicitly typed ticker', () => {
  const result = extractCsvRows('\uFEFFTicker,NAME,ID,Date,Price,Units,PIT\n"  BRK.B \t"," Berkshire Hathaway ",0012,2026-11-14,1.20,USD,2026-11-14T09:30:00Z\n', {
    tickerColumn: 'Ticker',
  });
  assert.deepEqual(result.rows[0].values, {
    Ticker: '  BRK.B \t', NAME: ' Berkshire Hathaway ', ID: '0012', Date: '2026-11-14',
    Price: '1.20', Units: 'USD', PIT: '2026-11-14T09:30:00Z',
  });
  assert.deepEqual(result.rows[0].typed_ticker, { raw: '  BRK.B \t', typed: 'BRK.B', status: 'ok' });
  assert.deepEqual(result.rows[0].source_ref, { source: 'source.csv', csv_record: 2 });
  assert.equal(result.coverage.value_casting, false);
  assert.equal(result.coverage.complete_source, true);
});

test('CSV selection keeps record locators and exact values across row and column bounds', () => {
  const result = extractCsvRows('Ticker,ID,Amount\n x ,0007,12.00\n y ,0008,13.00\n', {
    rowStart: 2, rowLimit: 1, columns: ['ID'], tickerColumn: 'Ticker',
  });
  assert.deepEqual(result.columns, ['ID', 'Ticker']);
  assert.deepEqual(result.rows[0].values, { ID: '0008', Ticker: ' y ' });
  assert.deepEqual(result.rows[0].typed_ticker, { raw: ' y ', typed: 'y', status: 'ok' });
  assert.deepEqual(result.source_refs, [{ source: 'source.csv', csv_record: 3 }]);
  assert.equal(result.coverage.next_row_start, null);
  assert.equal(result.coverage.complete_source, false);
});

test('CSV reader rejects ambiguous headers and invalid selection', () => {
  assert.throws(() => extractCsvRows('Name,Name\na,b\n'), /csv_header_invalid_or_ambiguous/);
  assert.throws(() => extractCsvRows('Name\na\n', { rowStart: 0 }), /invalid_row_start/);
  assert.throws(() => extractCsvRows('Name\na\n', { columns: ['Missing'] }), /selected_columns_invalid/);
  assert.deepEqual(normalizeTypedTicker(' \t '), {
    raw: ' \t ', typed: '', status: 'unknown', reason: 'ticker_blank_after_whitespace_trim',
  });
});
