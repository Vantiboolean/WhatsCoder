import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, typography } from '../../src/lib/theme';
import { codexClient, type ConnectionState, type SavedConnection } from '@codex-mobile/shared';
import {
  loadConnections,
  removeConnection,
  buildWsUrl,
} from '../../src/store/connection-store';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connState, setConnState] = useState<ConnectionState>(codexClient.state);
  const [connections, setConnections] = useState<SavedConnection[]>([]);

  useEffect(() => {
    return codexClient.onStateChange(setConnState);
  }, []);

  const refresh = useCallback(async () => {
    const list = await loadConnections();
    setConnections(list);
  }, []);

  // Refresh on every focus (handles returning from add-connection modal)
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const connectedUrl = codexClient.state === 'connected' ? codexClient.url : null;

  const isActiveConnection = (conn: SavedConnection) => {
    return connState === 'connected' && connectedUrl === buildWsUrl(conn);
  };

  const handleConnect = async (conn: SavedConnection) => {
    if (connState === 'connected') {
      codexClient.disconnect();
    }
    try {
      await codexClient.connect(buildWsUrl(conn), { autoReconnect: true });
    } catch {
      Alert.alert('Connection Failed', `Could not connect to ${conn.host}:${conn.port}`);
    }
  };

  const handleDisconnect = () => {
    codexClient.disconnect();
  };

  const handleDelete = (id: string) => {
    Alert.alert('Remove Connection', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeConnection(id);
          refresh();
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
    >
      {/* Connection status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>CONNECTION STATUS</Text>
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    connState === 'connected'
                      ? colors.status.active
                      : connState === 'connecting'
                      ? colors.status.warning
                      : connState === 'error'
                      ? colors.status.error
                      : colors.status.idle,
                },
              ]}
            />
            <Text style={styles.statusLabel}>
              {connState === 'connected'
                ? 'Connected'
                : connState === 'connecting'
                ? 'Connecting...'
                : connState === 'error'
                ? 'Error'
                : 'Disconnected'}
            </Text>
          </View>
          {connState === 'connected' && (
            <Pressable onPress={handleDisconnect} style={styles.disconnectBtn}>
              <Text style={styles.disconnectText}>Disconnect</Text>
            </Pressable>
          )}
        </View>
        {connState === 'error' && codexClient.lastError ? (
          <Text style={styles.errorHint}>{codexClient.lastError}</Text>
        ) : null}
      </View>

      {/* Saved connections */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>SAVED CONNECTIONS</Text>
          <Pressable
            onPress={() => router.push('/add-connection')}
            style={styles.addBtn}
          >
            <Ionicons name="add-circle" size={22} color={colors.accent.green} />
          </Pressable>
        </View>

        {connections.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="server-outline" size={24} color={colors.text.tertiary} />
            <Text style={styles.emptyText}>
              No connections saved.{'\n'}Add a Codex App Server endpoint.
            </Text>
          </View>
        ) : (
          connections.map((conn) => {
            const active = isActiveConnection(conn);
            return (
              <View key={conn.id} style={styles.connCard}>
                <View style={styles.connInfo}>
                  <Text style={styles.connLabel}>{conn.label}</Text>
                  <Text style={styles.connUrl}>
                    ws://{conn.host}:{conn.port}
                  </Text>
                  {conn.isDefault && (
                    <View style={styles.defaultBadge}>
                      <Text style={styles.defaultText}>Default</Text>
                    </View>
                  )}
                </View>
                <View style={styles.connActions}>
                  <Pressable
                    onPress={() => handleConnect(conn)}
                    style={[styles.connectBtn, active && styles.connectedBtn]}
                  >
                    <Text
                      style={[styles.connectBtnText, active && styles.connectedBtnText]}
                    >
                      {active ? 'Active' : 'Connect'}
                    </Text>
                  </Pressable>
                  <Pressable onPress={() => handleDelete(conn.id)} style={styles.deleteBtn}>
                    <Ionicons name="trash-outline" size={18} color={colors.status.error} />
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </View>

      {/* How to use */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>HOW TO USE</Text>
        <View style={styles.helpCard}>
          <Text style={styles.helpStep}>1. Start the Codex App Server on your desktop:</Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText}>
              codex app-server --listen ws://0.0.0.0:4500
            </Text>
          </View>
          <Text style={styles.helpStep}>
            2. Add a connection above with your desktop's IP and port 4500.
          </Text>
          <Text style={styles.helpStep}>
            3. Make sure your phone and desktop are on the same network.
          </Text>
        </View>
      </View>

      {/* About */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ABOUT</Text>
        <View style={styles.aboutCard}>
          <Text style={styles.aboutLabel}>Codex Mobile</Text>
          <Text style={styles.aboutValue}>v1.0.0</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  content: {
    padding: spacing.lg,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: colors.text.tertiary,
    fontSize: typography.size.xs,
    fontWeight: typography.weight.semibold,
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },
  statusCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusLabel: {
    color: colors.text.primary,
    fontSize: typography.size.md,
    fontWeight: typography.weight.medium,
  },
  errorHint: {
    color: colors.status.error,
    fontSize: typography.size.xs,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  disconnectBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.status.error + '44',
  },
  disconnectText: {
    color: colors.status.error,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.medium,
  },
  addBtn: {
    marginBottom: spacing.sm,
  },
  emptyCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  emptyText: {
    color: colors.text.tertiary,
    fontSize: typography.size.sm,
    textAlign: 'center',
    lineHeight: typography.size.sm * typography.lineHeight.relaxed,
  },
  connCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  connInfo: { flex: 1 },
  connLabel: {
    color: colors.text.primary,
    fontSize: typography.size.md,
    fontWeight: typography.weight.medium,
    marginBottom: 2,
  },
  connUrl: {
    color: colors.text.tertiary,
    fontSize: typography.size.xs,
    fontFamily: typography.fontFamily.mono,
  },
  defaultBadge: {
    marginTop: spacing.xs,
    backgroundColor: colors.accent.greenMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  defaultText: {
    color: colors.accent.green,
    fontSize: typography.size.xs,
    fontWeight: typography.weight.medium,
  },
  connActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  connectBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.accent.green,
  },
  connectedBtn: {
    backgroundColor: colors.accent.greenMuted,
  },
  connectBtnText: {
    color: colors.text.inverse,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.semibold,
  },
  connectedBtnText: {
    color: colors.accent.green,
  },
  deleteBtn: {
    padding: spacing.xs,
  },
  helpCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  helpStep: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    lineHeight: typography.size.sm * typography.lineHeight.relaxed,
  },
  codeBlock: {
    backgroundColor: colors.bg.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  codeText: {
    color: colors.accent.green,
    fontSize: typography.size.sm,
    fontFamily: typography.fontFamily.mono,
  },
  aboutCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  aboutLabel: { color: colors.text.primary, fontSize: typography.size.md },
  aboutValue: { color: colors.text.tertiary, fontSize: typography.size.md },
});
