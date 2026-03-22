import React, { useCallback, useEffect, useState } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../../src/lib/theme';
import { codexClient, type ConnectionState, type ThreadSummary } from '@whats-coder/shared';
import { getDefaultConnection, buildWsUrl } from '../../src/store/connection-store';
import { ThreadListItem } from '../../src/components/ThreadListItem';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { EmptyState } from '../../src/components/EmptyState';

export default function SessionsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connState, setConnState] = useState<ConnectionState>(codexClient.state);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    return codexClient.onStateChange(setConnState);
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (codexClient.state === 'disconnected') {
      autoConnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoConnect = useCallback(async () => {
    const conn = await getDefaultConnection();
    if (!conn) return;
    try {
      await codexClient.connect(buildWsUrl(conn), { autoReconnect: true });
    } catch {
      // state listeners will update the UI
    }
  }, []);

  const loadThreads = useCallback(async () => {
    if (codexClient.state !== 'connected') return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await codexClient.listThreads({ limit: 50, sortKey: 'updated_at' });
      setThreads(result.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load sessions';
      setLoadError(msg);
    }
    setLoading(false);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (codexClient.state !== 'connected') {
      await autoConnect();
    } else {
      await loadThreads();
    }
    setRefreshing(false);
  }, [autoConnect, loadThreads]);

  useEffect(() => {
    if (connState === 'connected') {
      loadThreads();
    } else {
      setThreads([]);
    }
  }, [connState, loadThreads]);

  useEffect(() => {
    const unsub = codexClient.onNotification((method) => {
      if (
        method === 'thread/started' ||
        method === 'thread/archived' ||
        method === 'thread/unarchived' ||
        method === 'thread/name/updated' ||
        method === 'thread/status/changed'
      ) {
        loadThreads();
      }
    });
    return unsub;
  }, [loadThreads]);

  const openThread = (threadId: string) => {
    router.push(`/thread/${threadId}`);
  };

  const goToSettings = () => {
    router.navigate('/(tabs)/settings');
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <ConnectionBanner state={connState} onPress={goToSettings} />
      {connState !== 'connected' ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Not Connected"
          subtitle="Connect to a Codex App Server to view your sessions."
          actionLabel="Go to Settings"
          onAction={goToSettings}
        />
      ) : loadError ? (
        <EmptyState
          icon="alert-circle-outline"
          title="Load Failed"
          subtitle={loadError}
          actionLabel="Retry"
          onAction={loadThreads}
        />
      ) : threads.length === 0 && !loading ? (
        <EmptyState
          icon="chatbubbles-outline"
          title="No Sessions"
          subtitle="Start a conversation from Codex desktop, or pull to refresh."
        />
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ThreadListItem thread={item} onPress={() => openThread(item.id)} />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent.green}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
});
