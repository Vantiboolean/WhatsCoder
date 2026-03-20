import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { OverlayView } from './CodeViewer';

type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

function fileIcon(name: string, isDir: boolean): React.ReactElement {
  if (isDir) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
      </svg>
    );
  }
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const codeExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'swift', 'kt', 'cs'];
  const configExts = ['json', 'yaml', 'yml', 'toml', 'xml', 'env', 'ini', 'cfg'];
  const docExts = ['md', 'txt', 'rst', 'doc'];

  let color = 'var(--text-tertiary)';
  if (codeExts.includes(ext)) color = 'var(--status-info)';
  else if (configExts.includes(ext)) color = 'var(--status-warning)';
  else if (docExts.includes(ext)) color = 'var(--accent-green)';

  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h5l4 4V13a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 13V3A1.5 1.5 0 014 1.5z" />
      <path d="M9 1.5v4h4" />
    </svg>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TreeNode = DirEntry & { children?: TreeNode[]; depth: number };

function FileTreeItem({
  node,
  expandedPaths,
  onToggle,
  onClickFile,
}: {
  node: TreeNode;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onClickFile: (node: TreeNode) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);

  return (
    <>
      <button
        className="fe-tree-item"
        style={{ paddingLeft: 12 + node.depth * 16 }}
        onClick={() => {
          if (node.isDir) {
            onToggle(node.path);
          } else {
            onClickFile(node);
          }
        }}
      >
        {node.isDir && (
          <svg
            className={`fe-chevron${isExpanded ? ' fe-chevron--open' : ''}`}
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M3 1.5l4 3.5-4 3.5" />
          </svg>
        )}
        {!node.isDir && <span className="fe-spacer" />}
        {fileIcon(node.name, node.isDir)}
        <span className="fe-item-name">{node.name}</span>
        {!node.isDir && <span className="fe-item-size">{formatSize(node.size)}</span>}
      </button>
      {node.isDir && isExpanded && node.children?.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          onClickFile={onClickFile}
        />
      ))}
    </>
  );
}

export function FileExplorer({
  cwd,
  onOverlayView,
}: {
  cwd: string | null;
  onOverlayView: (view: OverlayView) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [dirCache, setDirCache] = useState<Map<string, DirEntry[]>>(new Map());

  const loadDir = useCallback(async (path: string, depth: number): Promise<TreeNode[]> => {
    const cached = dirCache.get(path);
    if (cached) {
      return cached.map((e) => ({ ...e, depth, children: e.isDir ? [] : undefined }));
    }

    try {
      const entries = await invoke<DirEntry[]>('list_directory', { path });
      setDirCache((prev) => new Map(prev).set(path, entries));
      return entries.map((e) => ({ ...e, depth, children: e.isDir ? [] : undefined }));
    } catch {
      return [];
    }
  }, [dirCache]);

  useEffect(() => {
    if (!cwd) { setTree([]); return; }
    setLoading(true);
    setDirCache(new Map());
    setExpandedPaths(new Set());
    loadDir(cwd, 0).then((nodes) => {
      setTree(nodes);
      setLoading(false);
    });
  }, [cwd]);

  const handleToggle = useCallback(async (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

    if (!expandedPaths.has(path)) {
      const loadChildren = async (parentPath: string, nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (node) => {
            if (node.path === parentPath && node.isDir && (!node.children || node.children.length === 0)) {
              const children = await loadDir(node.path, node.depth + 1);
              return { ...node, children };
            }
            if (node.children) {
              const updatedChildren = await loadChildren(parentPath, node.children);
              return { ...node, children: updatedChildren };
            }
            return node;
          })
        );
      };
      const updated = await loadChildren(path, tree);
      setTree(updated);
    }
  }, [expandedPaths, tree, loadDir]);

  const handleClickFile = async (node: TreeNode) => {
    try {
      const result = await invoke<{ content: string; truncated: boolean }>('read_file_content', {
        path: node.path,
        maxBytes: 512000,
      });
      const name = node.path.replace(/\\/g, '/').split('/').pop() || node.name;
      onOverlayView({
        type: 'file',
        title: name,
        content: result.content + (result.truncated ? '\n\n... (file truncated)' : ''),
        language: undefined,
      });
    } catch { /* ignore */ }
  };

  const filterTree = (nodes: TreeNode[], query: string): TreeNode[] => {
    if (!query) return nodes;
    const lower = query.toLowerCase();
    return nodes.reduce<TreeNode[]>((acc, node) => {
      if (node.name.toLowerCase().includes(lower)) {
        acc.push(node);
      } else if (node.isDir && node.children) {
        const filtered = filterTree(node.children, query);
        if (filtered.length > 0) {
          acc.push({ ...node, children: filtered });
        }
      }
      return acc;
    }, []);
  };

  const filteredTree = filterTree(tree, search);

  if (!cwd) {
    return (
      <div className="fe-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7.5V18a2 2 0 002 2h14a2 2 0 002-2V9.5a2 2 0 00-2-2h-6l-2-3H5a2 2 0 00-2 2z" />
        </svg>
        <span>No project selected</span>
      </div>
    );
  }

  return (
    <div className="fe-container">
      <div className="fe-search">
        <svg className="fe-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3.5 3.5" />
        </svg>
        <input
          className="fe-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files..."
        />
        {search && (
          <button className="fe-search-clear" onClick={() => setSearch('')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>
      <div className="fe-tree">
        {loading ? (
          <div className="fe-loading">Loading...</div>
        ) : filteredTree.length === 0 ? (
          <div className="fe-loading">{search ? 'No matches found' : 'Empty directory'}</div>
        ) : (
          filteredTree.map((node) => (
            <FileTreeItem
              key={node.path}
              node={node}
              expandedPaths={expandedPaths}
              onToggle={handleToggle}
              onClickFile={handleClickFile}
            />
          ))
        )}
      </div>
    </div>
  );
}
