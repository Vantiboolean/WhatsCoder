import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from '../lib/theme';
import type { ThreadSummary } from '@codex-mobile/shared';

type Props = {
  thread: ThreadSummary;
  onPress: () => void;
};

function relativeTime(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function statusIcon(status?: { type: string; activeFlags?: string[] }) {
  if (!status) return { name: 'ellipse' as const, color: colors.status.idle };
  switch (status.type) {
    case 'active':
      return { name: 'radio-button-on' as const, color: colors.status.active };
    case 'idle':
      return { name: 'ellipse' as const, color: colors.status.idle };
    case 'systemError':
      return { name: 'alert-circle' as const, color: colors.status.error };
    default:
      return { name: 'ellipse-outline' as const, color: colors.status.idle };
  }
}

export function ThreadListItem({ thread, onPress }: Props) {
  const icon = statusIcon(thread.status);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.container, pressed && styles.pressed]}
    >
      <View style={styles.statusDot}>
        <Ionicons name={icon.name} size={10} color={icon.color} />
      </View>
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {thread.name || thread.preview || 'Untitled thread'}
          </Text>
          <Text style={styles.time}>{relativeTime(thread.updatedAt ?? thread.createdAt)}</Text>
        </View>
        <Text style={styles.preview} numberOfLines={2}>
          {thread.preview || 'No messages yet'}
        </Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={colors.text.tertiary}
        style={styles.chevron}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.subtle,
  },
  pressed: {
    backgroundColor: colors.bg.hover,
  },
  statusDot: {
    width: 20,
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  content: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.md,
    fontWeight: typography.weight.medium,
    flex: 1,
    marginRight: spacing.sm,
  },
  time: {
    color: colors.text.tertiary,
    fontSize: typography.size.xs,
  },
  preview: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    lineHeight: typography.size.sm * typography.lineHeight.normal,
  },
  chevron: {
    marginLeft: spacing.sm,
  },
});
