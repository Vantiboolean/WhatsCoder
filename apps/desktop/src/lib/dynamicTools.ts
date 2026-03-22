/**
 * Desktop implementations of agent-callable tools: validate args in JS, then `invoke` Rust commands for filesystem IO.
 * `DESKTOP_DYNAMIC_TOOL_SPECS` mirrors what the model sees—`name`, `description`, and JSON-Schema-shaped `inputSchema` (plus optional `deferLoading`).
 */
import { invoke } from '@tauri-apps/api/core';
import type { DynamicToolCallContentItem } from '@codex-mobile/shared';

const DEFAULT_READ_MAX_BYTES = 32_768;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_SEARCH_RESULTS = 40;

type ToolRequest = {
  requestId: number;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
};

type ToolResponse = {
  contentItems: DynamicToolCallContentItem[];
  success: boolean;
};

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
};

type ReadFileArgs = {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
};

type ListDirectoryArgs = {
  path?: string;
  limit?: number;
};

type SearchInFilesArgs = {
  path?: string;
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

type ReadFileResult = {
  path: string;
  content: string;
  truncated: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
};

type DirectoryEntryResult = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

type ListDirectoryResult = {
  path: string;
  entries: DirectoryEntryResult[];
  truncated: boolean;
};

type SearchMatchResult = {
  path: string;
  lineNumber: number;
  lineText: string;
};

type SearchInFilesResult = {
  rootPath: string;
  matches: SearchMatchResult[];
  scannedFiles: number;
  truncated: boolean;
};

type ToolSummary = {
  title: string;
  subtitle?: string | null;
  badges?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value);
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function clampPositiveInteger(value: number | null, fallback: number, max: number): number {
  if (value == null || value <= 0) {
    return fallback;
  }

  return Math.min(value, max);
}

function basename(path: string | null | undefined): string {
  if (!path) {
    return 'workspace';
  }

  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function shortenText(value: string, max = 64): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, max - 3)}...`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isAbsoluteLikePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
}

function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split(/\r?\n/);
  const width = String(startLine + Math.max(lines.length - 1, 0)).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

function buildTextResponse(text: string, success: boolean): ToolResponse {
  const contentItems: DynamicToolCallContentItem[] = text.trim().length > 0
    ? [{ type: 'inputText', text }]
    : [];

  return { contentItems, success };
}

function parseReadFileArgs(value: unknown): ReadFileArgs | null {
  if (!isRecord(value)) {
    return null;
  }

  const path = getString(value.path);
  if (!path) {
    return null;
  }

  const startLine = getNumber(value.startLine) ?? undefined;
  const endLine = getNumber(value.endLine) ?? undefined;
  const maxBytes = getNumber(value.maxBytes) ?? undefined;

  return { path, startLine, endLine, maxBytes };
}

function parseListDirectoryArgs(value: unknown): ListDirectoryArgs {
  if (!isRecord(value)) {
    return {};
  }

  return {
    path: getString(value.path) ?? undefined,
    limit: getNumber(value.limit) ?? undefined,
  };
}

function parseSearchInFilesArgs(value: unknown): SearchInFilesArgs | null {
  if (!isRecord(value)) {
    return null;
  }

  const query = getString(value.query);
  if (!query) {
    return null;
  }

  return {
    path: getString(value.path) ?? undefined,
    query,
    maxResults: getNumber(value.maxResults) ?? undefined,
    caseSensitive: getBoolean(value.caseSensitive) ?? undefined,
  };
}

function formatReadFileResult(result: ReadFileResult, args: ReadFileArgs): string {
  const linesLabel =
    result.startLine === result.endLine
      ? `Line ${result.startLine}`
      : `Lines ${result.startLine}-${result.endLine}`;

  const meta = [
    `Path: ${result.path}`,
    `${linesLabel} of ${result.totalLines}`,
  ];

  if (result.truncated) {
    meta.push(`Output truncated to ${formatBytes(args.maxBytes ?? DEFAULT_READ_MAX_BYTES)}.`);
  }

  return `${meta.join('\n')}\n\n${addLineNumbers(result.content, result.startLine)}`;
}

function formatListDirectoryResult(result: ListDirectoryResult): string {
  const lines = result.entries.map((entry) => {
    const prefix = entry.isDirectory ? '[D]' : '[F]';
    const suffix = entry.isDirectory ? '/' : entry.size > 0 ? ` (${formatBytes(entry.size)})` : '';
    return `${prefix} ${entry.name}${suffix}`;
  });

  if (result.truncated) {
    lines.push('...');
    lines.push(`Showing the first ${result.entries.length} entries only.`);
  }

  return [`Path: ${result.path}`, `Entries: ${result.entries.length}`, '', ...lines].join('\n');
}

function formatSearchInFilesResult(result: SearchInFilesResult, args: SearchInFilesArgs): string {
  const lines = result.matches.map(
    (match) => `${match.path}:${match.lineNumber}:${match.lineText}`,
  );

  if (result.truncated) {
    lines.push('...');
    lines.push(`Search stopped after ${result.matches.length} matches.`);
  }

  return [
    `Query: ${args.query}`,
    `Root: ${result.rootPath}`,
    `Scanned files: ${result.scannedFiles}`,
    `Matches: ${result.matches.length}`,
    '',
    ...lines,
  ].join('\n');
}

export const DESKTOP_DYNAMIC_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description:
      'Fast local text file reader for the current workspace. Use this before shelling out when you need file contents or a specific line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the thread workspace.' },
        startLine: { type: 'integer', minimum: 1, description: 'Optional 1-based inclusive start line.' },
        endLine: { type: 'integer', minimum: 1, description: 'Optional 1-based inclusive end line.' },
        maxBytes: { type: 'integer', minimum: 1024, description: 'Optional byte cap for the returned file content.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'Fast local directory listing for the current workspace. Returns direct children only and skips noisy build directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to inspect. Defaults to the thread workspace root.' },
        limit: { type: 'integer', minimum: 1, description: 'Optional maximum number of entries to return.' },
      },
    },
  },
  {
    name: 'search_in_files',
    description:
      'Fast workspace text search that returns grep-like path:line:text matches without starting a shell. Best for pinpointing code or settings quickly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file or directory path. Defaults to the thread workspace root.' },
        query: { type: 'string', description: 'The plain-text query to search for.' },
        maxResults: { type: 'integer', minimum: 1, description: 'Optional maximum number of matches to return.' },
        caseSensitive: { type: 'boolean', description: 'Whether the search should be case-sensitive.' },
      },
      required: ['query'],
    },
  },
];

export function summarizeDesktopDynamicTool(tool: string, args: unknown): ToolSummary | null {
  if (tool === 'read_file') {
    const parsed = parseReadFileArgs(args);
    if (!parsed) {
      return { title: 'Read file' };
    }

    const badges: string[] = [];
    if (parsed.startLine != null || parsed.endLine != null) {
      const start = parsed.startLine ?? 1;
      const end = parsed.endLine ?? start;
      badges.push(start === end ? `Line ${start}` : `Lines ${start}-${end}`);
    }

    return {
      title: `Read ${basename(parsed.path)}`,
      subtitle: parsed.path,
      badges,
    };
  }

  if (tool === 'list_directory') {
    const parsed = parseListDirectoryArgs(args);
    const path = parsed.path ?? '.';
    const badges: string[] = [];
    if (parsed.limit != null) {
      badges.push(`Limit ${parsed.limit}`);
    }

    return {
      title: `List ${basename(path)}`,
      subtitle: path,
      badges,
    };
  }

  if (tool === 'search_in_files') {
    const parsed = parseSearchInFilesArgs(args);
    if (!parsed) {
      return { title: 'Search files' };
    }

    const badges = [parsed.caseSensitive ? 'Case sensitive' : 'Case insensitive'];
    return {
      title: `Search ${shortenText(parsed.query, 40)}`,
      subtitle: parsed.path ?? '.',
      badges,
    };
  }

  return null;
}

/**
 * Returns `null` when `request.tool` is not a desktop tool so the caller can fall through to other handlers.
 */
export async function executeDesktopDynamicToolCall(
  request: ToolRequest,
  cwd?: string | null,
): Promise<ToolResponse | null> {
  if (request.tool === 'read_file') {
    const parsed = parseReadFileArgs(request.arguments);
    if (!parsed) {
      return buildTextResponse('Invalid `read_file` arguments. Expected at least a non-empty `path`.', false);
    }
    if (!cwd && !isAbsoluteLikePath(parsed.path)) {
      return buildTextResponse('`read_file` needs an absolute path when the thread has no workspace cwd.', false);
    }

    try {
      const result = await invoke<ReadFileResult>('tool_read_file', {
        cwd: cwd ?? null,
        path: parsed.path,
        startLine: parsed.startLine ?? null,
        endLine: parsed.endLine ?? null,
        maxBytes: clampPositiveInteger(parsed.maxBytes ?? null, DEFAULT_READ_MAX_BYTES, 131_072),
      });
      return buildTextResponse(formatReadFileResult(result, parsed), true);
    } catch (error) {
      return buildTextResponse(`read_file failed: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  if (request.tool === 'list_directory') {
    const parsed = parseListDirectoryArgs(request.arguments);
    if (!cwd && parsed.path && !isAbsoluteLikePath(parsed.path)) {
      return buildTextResponse('`list_directory` needs an absolute path when the thread has no workspace cwd.', false);
    }
    if (!cwd && !parsed.path) {
      return buildTextResponse('`list_directory` needs a workspace cwd or an explicit absolute `path`.', false);
    }

    try {
      const result = await invoke<ListDirectoryResult>('tool_list_directory', {
        cwd: cwd ?? null,
        path: parsed.path ?? null,
        limit: clampPositiveInteger(parsed.limit ?? null, DEFAULT_LIST_LIMIT, 500),
      });
      return buildTextResponse(formatListDirectoryResult(result), true);
    } catch (error) {
      return buildTextResponse(`list_directory failed: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  if (request.tool === 'search_in_files') {
    const parsed = parseSearchInFilesArgs(request.arguments);
    if (!parsed) {
      return buildTextResponse('Invalid `search_in_files` arguments. Expected a non-empty `query`.', false);
    }
    if (!cwd && parsed.path && !isAbsoluteLikePath(parsed.path)) {
      return buildTextResponse('`search_in_files` needs an absolute path when the thread has no workspace cwd.', false);
    }
    if (!cwd && !parsed.path) {
      return buildTextResponse('`search_in_files` needs a workspace cwd or an explicit absolute `path`.', false);
    }

    try {
      const result = await invoke<SearchInFilesResult>('tool_search_in_files', {
        cwd: cwd ?? null,
        path: parsed.path ?? null,
        query: parsed.query,
        maxResults: clampPositiveInteger(parsed.maxResults ?? null, DEFAULT_SEARCH_RESULTS, 200),
        caseSensitive: parsed.caseSensitive ?? false,
      });
      return buildTextResponse(formatSearchInFilesResult(result, parsed), true);
    } catch (error) {
      return buildTextResponse(`search_in_files failed: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  return null;
}
