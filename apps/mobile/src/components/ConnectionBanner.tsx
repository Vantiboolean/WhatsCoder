import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from '../lib/theme';
import type { ConnectionState } from '@whats-coder/shared';

type Props = {
  state: ConnectionState;
  onPress?: () => void;
};

const config: Record<ConnectionState, { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }> = {
  connected: { icon: 'checkmark-circle', color: colors.status.active, label: 'Connected' },
  connecting: { icon: 'sync-circle', color: colors.status.warning, label: 'Connecting...' },
  disconnected: { icon: 'close-circle', color: colors.status.idle, label: 'Disconnected' },
  error: { icon: 'alert-circle', color: colors.status.error, label: 'Connection Error' },
};

export function ConnectionBanner({ state, onPress }: Props) {
  const c = config[state];
  if (state === 'connected') return null;

  return (
    <Pressable onPress={onPress} style={styles.container}>
      <Ionicons name={c.icon} size={16} color={c.color} />
      <Text style={[styles.text, { color: c.color }]}>{c.label}</Text>
      {state === 'disconnected' && (
        <Text style={styles.hint}>Tap to connect</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.bg.tertiary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  text: {
    fontSize: typography.size.sm,
    fontWeight: typography.weight.medium,
  },
  hint: {
    fontSize: typography.size.xs,
    color: colors.text.tertiary,
  },
});
