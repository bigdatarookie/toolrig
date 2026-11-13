import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { extractCsvRows } from './deterministic-readers.js';
import { configuredQwenCompactor } from './qwen-compactor.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 1024 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const OP_TIMEOUT_MS = 75_000;

function errorResult(operation, source, code, message) {
  const name = typeof source === 'string' ? basename(source) : '';
  return {
    ok: false,
    status: 'error',
    operation,
    source: { name, format: extname(name).slice(1).toLowerCase() },
    data: null,
    source_refs: [],
    warnings: [],
    error: { code, message },
  };
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function cliArgs(operation, path, args) {
  const command = operation === 'extract_tables' ? 'extract-tables' : operation;
  const values = [command, path];
  for (const [key, flag] of [
    ['pages', '--pages'], ['sheet', '--sheet'], ['cell_range', '--cell-range'], ['row_range', '--row-range'],
  ]) {
    if (args[key] !== undefined) values.push(flag, String(args[key]));
  }
  if (operation === 'read') {
    if (args.ocr === true) values.push('--ocr');
    if (args.ocr === false) values.push('--no-ocr');
    if (args.include_formulas === false) values.push('--no-formulas');
  }
  if (operation === 'render' && args.dpi !== undefined) values.push('--dpi', String(args.dpi));
  return values;
}

export class DocumentsAdapter {
  constructor({ command, root, artifactDir, qwenCompactor = null }) {
    this.command = command;
    this.root = root;
    this.artifactDir = artifactDir ? resolve(artifactDir) : null;
    this.qwenCompactor = qwenCompactor;
    this.temporaryArtifactDir = null;
  }

  async canonicalPaths(inputPath) {
    if (!this.root || !isAbsolute(inputPath)) return null;
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([realpath(this.root), realpath(inputPath)]);
      return { canonicalRoot, canonicalPath, withinRoot: within(canonicalRoot, canonicalPath) };
    } catch {
      return null;
    }
  }

  async outputDirectory() {
    if (this.artifactDir) return this.artifactDir;
    this.temporaryArtifactDir ??= mkdtemp(join(tmpdir(), 'toolrig-hub-documents-'));
    return this.temporaryArtifactDir;
  }

  async invoke(operation, args) {
    const inputPath = args.path;
    if (!this.command || !this.root) {
      return errorResult(operation, inputPath, 'documents_not_configured', 'Document tools require a trusted CLI path and configured root.');
    }
    if (!isAbsolute(inputPath)) {
      return errorResult(operation, inputPath, 'invalid_path', 'Document paths must be absolute.');
    }

    const paths = await this.canonicalPaths(inputPath);
    if (!paths) {
      return errorResult(operation, inputPath, 'file_not_found', 'The requested document or configured root is unavailable.');
    }
    if (!paths.withinRoot) {
      return errorResult(operation, inputPath, 'path_outside_configured_root', 'The requested document is outside the configured document root.');
    }
    const { canonicalRoot, canonicalPath } = paths;

    try {
      const childEnv = { ...process.env, TOOLRIG_DOCUMENT_ARTIFACT_DIR: await this.outputDirectory() };
      // The document CLI does not need the local gateway credential.
      delete childEnv.TOOLRIG_QWEN_API_KEY;
      const { stdout } = await execFileAsync(this.command, cliArgs(operation, canonicalPath, args), {
        cwd: canonicalRoot,
        env: childEnv,
        timeout: OP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      const result = JSON.parse(stdout);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('invalid tool response');
      if (operation === 'read' && args.compact_for_context === true && result.ok) {
        return this.compactReadResult(result, args);
      }
      return result;
    } catch (error) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
      if (stdout) {
        try {
          const result = JSON.parse(stdout);
          if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
        } catch { /* Do not return process output that may include document content. */ }
      }
      const code = error?.code === 'ETIMEDOUT' ? 'operation_timeout'
        : error?.code === 'ENOENT' ? 'dependency_missing' : 'document_tool_failed';
      const message = code === 'operation_timeout' ? 'The document operation exceeded its time limit.'
        : code === 'dependency_missing' ? 'The configured document CLI is unavailable.'
          : 'The document operation failed.';
      return errorResult(operation, inputPath, code, message);
    }
  }

  async compactReadResult(result, args) {
    const data = result.data;
    const text = typeof data === 'string' ? data
      : data && typeof data === 'object' && typeof data.text === 'string' ? data.text : null;
    if (text === null) {
      return { ...result, compaction: { status: 'direct_source', reason: 'structured_source_kept_exact' } };
    }
    if (!this.qwenCompactor) {
      return { ...result, compaction: { status: 'direct_source', reason: 'qwen_route_not_configured' } };
    }
    const compaction = await this.qwenCompactor.compact({
      question: args.question,
      text,
      sourceRefs: result.source_refs,
      exactFacts: Array.isArray(result.exact_facts) ? result.exact_facts : [],
      consumerWindowTokens: args.consumer_window_tokens,
      consumerTokensUsed: args.consumer_tokens_used,
      consumerReserveTokens: args.consumer_reserve_tokens ?? 512,
      qwenEligible: args.qwen_eligible === true,
    });
    if (compaction.status !== 'compacted') return { ...result, compaction };
    const { summary, ...metadata } = compaction;
    return { ...result, data: { kind: 'question_directed_compaction', ...summary }, compaction: metadata };
  }

  async extractCsv(args) {
    const inputPath = args.path;
    if (!this.root) return errorResult('extract_csv', inputPath, 'documents_not_configured', 'CSV reading requires a configured document root.');
    if (!isAbsolute(inputPath)) return errorResult('extract_csv', inputPath, 'invalid_path', 'Document paths must be absolute.');
    if (extname(inputPath).toLowerCase() !== '.csv') return errorResult('extract_csv', inputPath, 'unsupported_format', 'The deterministic row reader supports CSV files.');
    const paths = await this.canonicalPaths(inputPath);
    if (!paths) return errorResult('extract_csv', inputPath, 'path_outside_configured_root', 'The requested document or configured root is unavailable or outside the configured root.');
    if (!paths.withinRoot) return errorResult('extract_csv', inputPath, 'path_outside_configured_root', 'The requested document or configured root is unavailable or outside the configured root.');
    try {
      const info = await stat(paths.canonicalPath);
      if (!info.isFile()) return errorResult('extract_csv', inputPath, 'invalid_source', 'The requested CSV source is not a regular file.');
      if (info.size > MAX_CSV_BYTES) return errorResult('extract_csv', inputPath, 'source_too_large', 'The CSV exceeds the deterministic reader input bound; select a supported smaller source.');
      const bytes = await readFile(paths.canonicalPath);
      if (bytes.byteLength > MAX_CSV_BYTES) return errorResult('extract_csv', inputPath, 'source_too_large', 'The CSV exceeds the deterministic reader input bound; select a supported smaller source.');
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return errorResult('extract_csv', inputPath, 'invalid_utf8', 'The CSV is not valid UTF-8; exact cell values cannot be preserved.');
      }
      const result = extractCsvRows(content, {
        sourceName: basename(paths.canonicalPath),
        rowStart: args.row_start ?? 1,
        rowLimit: args.row_limit ?? 100,
        columns: args.columns,
        tickerColumn: args.ticker_column,
      });
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BUFFER) {
        return errorResult('extract_csv', inputPath, 'result_too_large', 'The selected CSV result exceeds the response bound; narrow rows or columns.');
      }
      return result;
    } catch (error) {
      const code = error instanceof RangeError ? 'invalid_row_selection'
        : error instanceof TypeError ? 'invalid_csv' : 'invalid_csv';
      const known = new Set(['invalid_row_start', 'invalid_row_limit', 'csv_header_missing',
        'csv_header_invalid_or_ambiguous', 'ticker_column_not_found', 'selected_columns_invalid']);
      const message = known.has(error.message) ? error.message : 'The CSV is malformed or cannot be read without changing exact cell values.';
      return errorResult('extract_csv', inputPath, code, message);
    }
  }
}

const pathSchema = z.string().min(1).describe('Absolute path inside the configured document root.');
const ranges = {
  pages: z.string().optional(),
  sheet: z.string().optional(),
  cell_range: z.string().optional(),
  row_range: z.string().optional(),
};

function expose(server, adapter, name, description, inputSchema, operation) {
  server.registerTool(`documents_${name}`, {
    description,
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async args => {
    const result = await adapter.invoke(operation, args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
}

export function registerDocumentsTools(server, adapter) {
  if (!adapter) return;
  if (adapter.command) {
    expose(server, adapter, 'inspect', 'Inspect a supported document inside the configured root.', { path: pathSchema }, 'inspect');
    expose(server, adapter, 'read', 'Read a bounded page, sheet, cell, or row range; OCR is approximate and only used when needed or requested.', {
      path: pathSchema, ...ranges, ocr: z.boolean().optional(), include_formulas: z.boolean().optional(),
      compact_for_context: z.boolean().optional(), question: z.string().min(1).optional(),
      qwen_eligible: z.boolean().optional().describe('Explicitly attest that this selected source contains no secrets, credentials, or private material and may be sent to the configured local Qwen service.'), consumer_window_tokens: z.number().int().positive().optional(),
      consumer_tokens_used: z.number().int().nonnegative().optional(), consumer_reserve_tokens: z.number().int().nonnegative().optional(),
    }, 'read');
    expose(server, adapter, 'render', 'Render up to five selected PDF pages to task-owned PNG artifacts.', {
      path: pathSchema, pages: ranges.pages, dpi: z.number().int().min(36).max(300).optional(),
    }, 'render');
    expose(server, adapter, 'extract_tables', 'Extract tables from selected PDF pages or bounded DOCX, XLSX, or CSV ranges.', {
      path: pathSchema, ...ranges,
    }, 'extract_tables');
  }
  server.registerTool('documents_extract_csv', {
    description: 'Read an exact bounded CSV record range. Values stay strings; an explicitly selected ticker column gets a separate whitespace-trimmed typed value while its raw value and all other cells remain unchanged.',
    inputSchema: {
      path: pathSchema,
      row_start: z.number().int().min(1).optional(),
      row_limit: z.number().int().min(1).max(250).optional(),
      columns: z.array(z.string().min(1)).max(128).optional(),
      ticker_column: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    const result = await adapter.extractCsv(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
}

export function configuredDocumentsAdapter(env = process.env) {
  const command = env.TOOLRIG_DOCUMENTS_CLI;
  const root = env.TOOLRIG_DOCUMENTS_ROOT;
  const artifactDir = env.TOOLRIG_DOCUMENT_ARTIFACT_DIR;
  const qwenCompactor = env.TOOLRIG_QWEN_API_KEY && env.TOOLRIG_QWEN_MODEL
    ? configuredQwenCompactor(env) : null;
  return root ? new DocumentsAdapter({ command: command ? resolve(command) : null,
    root: resolve(root), artifactDir, qwenCompactor }) : null;
}
