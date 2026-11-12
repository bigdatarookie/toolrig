import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 1024 * 1024;
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
  constructor({ command, root, artifactDir }) {
    this.command = command;
    this.root = root;
    this.artifactDir = artifactDir ? resolve(artifactDir) : null;
    this.temporaryArtifactDir = null;
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

    let canonicalRoot;
    let canonicalPath;
    try {
      [canonicalRoot, canonicalPath] = await Promise.all([realpath(this.root), realpath(inputPath)]);
    } catch {
      return errorResult(operation, inputPath, 'file_not_found', 'The requested document or configured root is unavailable.');
    }
    if (!within(canonicalRoot, canonicalPath)) {
      return errorResult(operation, inputPath, 'path_outside_configured_root', 'The requested document is outside the configured document root.');
    }

    try {
      const { stdout } = await execFileAsync(this.command, cliArgs(operation, canonicalPath, args), {
        cwd: canonicalRoot,
        env: { ...process.env, TOOLRIG_DOCUMENT_ARTIFACT_DIR: await this.outputDirectory() },
        timeout: OP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      const result = JSON.parse(stdout);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('invalid tool response');
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
  expose(server, adapter, 'inspect', 'Inspect a supported document inside the configured root.', { path: pathSchema }, 'inspect');
  expose(server, adapter, 'read', 'Read a bounded page, sheet, cell, or row range; OCR is approximate and only used when needed or requested.', {
    path: pathSchema, ...ranges, ocr: z.boolean().optional(), include_formulas: z.boolean().optional(),
  }, 'read');
  expose(server, adapter, 'render', 'Render up to five selected PDF pages to task-owned PNG artifacts.', {
    path: pathSchema, pages: ranges.pages, dpi: z.number().int().min(36).max(300).optional(),
  }, 'render');
  expose(server, adapter, 'extract_tables', 'Extract tables from selected PDF pages or bounded DOCX, XLSX, or CSV ranges.', {
    path: pathSchema, ...ranges,
  }, 'extract_tables');
}

export function configuredDocumentsAdapter(env = process.env) {
  const command = env.TOOLRIG_DOCUMENTS_CLI;
  const root = env.TOOLRIG_DOCUMENTS_ROOT;
  const artifactDir = env.TOOLRIG_DOCUMENT_ARTIFACT_DIR;
  return command && root ? new DocumentsAdapter({ command: resolve(command), root: resolve(root), artifactDir }) : null;
}
