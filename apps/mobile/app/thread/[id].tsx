import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Text,
  KeyboardAvoidingView,
  Platform,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '../../src/lib/theme';
import { codexClient, type ThreadItem, type Turn, type ConnectionState } from '@whats-coder/shared';
import { ChatBubble } from '../../src/components/ChatBubble';
import { ChatInput } from '../../src/components/ChatInput';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';

const SCROLL_NEAR_BOTTOM_THRESHOLD = 150;
const OPTIMISTIC_PREFIX = 'optimistic-';

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);

  const [connState, setConnState] = useState<ConnectionState>(codexClient.state);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [turnActive, setTurnActive] = useState(false);

  const activeTurnId = useRef<string | null>(null);
  const isNearBottom = useRef(true);
  const scrollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return codexClient.onStateChange(setConnState);
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    if (!isNearBottom.current) return;
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated });
    }, 80);
    scrollTimers.current.push(timer);
  }, []);

  useEffect(() => {
    return () => {
      scrollTimers.current.forEach(clearTimeout);
    };
  }, []);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    isNearBottom.current = distanceFromBottom < SCROLL_NEAR_BOTTOM_THRESHOLD;
  }, []);

  // ── Load thread data ──────────────────────────────────────

  const loadThread = useCallback(async () => {
    if (!id || codexClient.state !== 'connected') return;
    setLoading(true);
    setError(null);
    try {
      const thread = await codexClient.readThread(id, true);
      navigation.setOptions({
        title: thread.name || thread.preview || 'Thread',
      });

      const allItems: ThreadItem[] = [];
      if (thread.turns) {
        for (const turn of thread.turns) {
          allItems.push(...turn.items);
        }
      }
      setItems(allItems);

      try {
        await codexClient.resumeThread(id);
      } catch {
        // thread might already be loaded by another subscriber
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thread');
    }
    setLoading(false);
  }, [id, navigation]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  // Unsubscribe on unmount
  useEffect(() => {
    return () => {
      if (id && codexClient.state === 'connected') {
        codexClient.unsubscribeThread(id).catch(() => {});
      }
    };
  }, [id]);

  // ── Live streaming events (filtered by thread) ────────────

  useEffect(() => {
    if (!id) return;

    const unsub = codexClient.onNotification((method, params) => {
      const notifThreadId = params.threadId as string | undefined;
      const notifTurnId = params.turnId as string | undefined;

      // Filter: only process events for this thread
      if (notifThreadId && notifThreadId !== id) return;

      if (method === 'turn/started') {
        const turn = params.turn as Turn;
        // Also check turn's thread ownership
        activeTurnId.current = turn.id;
        setTurnActive(true);
      }

      if (method === 'turn/completed') {
        activeTurnId.current = null;
        setTurnActive(false);
        setSending(false);
      }

      if (method === 'item/started') {
        const item = params.item as ThreadItem;
        setItems((prev) => {
          // Replace optimistic user message if the server echo matches
          if (item.type === 'userMessage') {
            const optimisticIdx = prev.findIndex(
              (i) => i.id.startsWith(OPTIMISTIC_PREFIX) && i.type === 'userMessage',
            );
            if (optimisticIdx >= 0) {
              const next = [...prev];
              next[optimisticIdx] = item;
              return next;
            }
          }
          // Avoid duplicates: item may already exist from initial thread load
          if (prev.some((i) => i.id === item.id)) return prev;
          return [...prev, item];
        });
        scrollToBottom();
      }

      if (method === 'item/completed') {
        const item = params.item as ThreadItem;
        setItems((prev) => {
          const idx = prev.findIndex((i) => i.id === item.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = item;
            return next;
          }
          return [...prev, item];
        });
      }

      if (method === 'item/agentMessage/delta') {
        const itemId = params.itemId as string;
        const delta = params.delta as string;
        if (!delta) return;
        setItems((prev) => {
          const idx = prev.findIndex((i) => i.id === itemId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], text: (next[idx].text ?? '') + delta };
            return next;
          }
          return prev;
        });
        scrollToBottom();
      }

      if (method === 'thread/name/updated') {
        const name = params.name as string;
        navigation.setOptions({ title: name });
      }
    });

    return unsub;
  }, [id, navigation, scrollToBottom]);

  // ── Send message ──────────────────────────────────────────

  const handleSend = async (text: string) => {
    if (!id || codexClient.state !== 'connected') return;
    setSending(true);

    const userItem: ThreadItem = {
      type: 'userMessage',
      id: `${OPTIMISTIC_PREFIX}${Date.now()}`,
      content: [{ type: 'text', text }],
    };
    setItems((prev) => [...prev, userItem]);
    isNearBottom.current = true;
    scrollToBottom();

    try {
      await codexClient.startTurn(id, text);
    } catch (e) {
      setSending(false);
      // Remove optimistic message on failure
      setItems((prev) => prev.filter((i) => i.id !== userItem.id));
    }
  };

  // ── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={colors.accent.green} />
        <Text style={styles.loadingText}>Loading thread...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{error}</Text>
        <Text style={styles.retryText} onPress={loadThread}>Tap to retry</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 95 + insets.top : 0}
    >
      <ConnectionBanner state={connState} />
      <FlatList
        ref={flatListRef}
        data={items}
        keyExtractor={(item, index) => `${item.id}-${index}`}
        renderItem={({ item }) => <ChatBubble item={item} />}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom }]}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <View style={styles.emptyChat}>
            <Text style={styles.emptyChatText}>
              No messages yet. Send a message to start.
            </Text>
          </View>
        }
      />
      {turnActive && (
        <View style={styles.typingIndicator}>
          <ActivityIndicator size="small" color={colors.accent.green} />
          <Text style={styles.typingText}>Codex is working...</Text>
        </View>
      )}
      <ChatInput
        onSend={handleSend}
        disabled={connState !== 'connected'}
        loading={sending}
        placeholder={turnActive ? 'Codex is working...' : 'Message Codex...'}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxxl,
  },
  loadingText: {
    color: colors.text.tertiary,
    fontSize: typography.size.sm,
  },
  errorText: {
    color: colors.status.error,
    fontSize: typography.size.md,
    textAlign: 'center',
  },
  retryText: {
    color: colors.accent.green,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.medium,
  },
  listContent: {
    paddingVertical: spacing.md,
    flexGrow: 1,
  },
  emptyChat: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
  },
  emptyChatText: {
    color: colors.text.tertiary,
    fontSize: typography.size.sm,
    textAlign: 'center',
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  typingText: {
    color: colors.accent.green,
    fontSize: typography.size.xs,
    fontWeight: typography.weight.medium,
  },
});
