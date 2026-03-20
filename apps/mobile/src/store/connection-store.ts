import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SavedConnection } from '@codex-mobile/shared';

const STORAGE_KEY = 'codex_connections';

export async function loadConnections(): Promise<SavedConnection[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as SavedConnection[];
  } catch {
    return [];
  }
}

export async function saveConnections(connections: SavedConnection[]) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}

export async function addConnection(conn: Omit<SavedConnection, 'id'>) {
  const list = await loadConnections();
  if (conn.isDefault) {
    list.forEach((c) => (c.isDefault = false));
  }
  list.push({ ...conn, id: Date.now().toString(36) });
  await saveConnections(list);
  return list;
}

export async function removeConnection(id: string) {
  let list = await loadConnections();
  list = list.filter((c) => c.id !== id);
  await saveConnections(list);
  return list;
}

export async function getDefaultConnection(): Promise<SavedConnection | null> {
  const list = await loadConnections();
  return list.find((c) => c.isDefault) ?? list[0] ?? null;
}

export function buildWsUrl(conn: SavedConnection): string {
  return `ws://${conn.host}:${conn.port}`;
}
