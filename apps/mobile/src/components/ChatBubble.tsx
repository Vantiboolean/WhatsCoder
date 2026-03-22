import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from '../lib/theme';
import type { ThreadItem } from '@whats-coder/shared';

type Props = {
  item: ThreadItem;
};

export function ChatBubble({ item }: Props) {
  switch (item.type) {
    case 'userMessage':
      return <UserMessage item={item} />;
    case 'agentMessage':
      return <AgentMessage item={item} />;
    case 'commandExecution':
      return <CommandExecution item={item} />;
    case 'fileChange':
      return <FileChange item={item} />;
    case 'reasoning':
      return <Reasoning item={item} />;
    case 'plan':
      return <PlanItem item={item} />;
    default:
      return null;
  }
}

function extractContentText(item: ThreadItem): string {
  if (!Array.isArray(item.content)) {
    return '';
  }

  return item.content
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      return entry.text ?? entry.path ?? entry.url ?? entry.imageUrl ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractSummaryText(item: ThreadItem): string {
  if (Array.isArray(item.summary)) {
    return item.summary.join('\n\n');
  }
  return item.summary ?? item.text ?? '';
}

function UserMessage({ item }: Props) {
  const text = extractContentText(item);

  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{text}</Text>
      </View>
    </View>
  );
}

function AgentMessage({ item }: Props) {
  return (
    <View style={styles.agentRow}>
      <View style={styles.agentBubble}>
        <Text style={styles.agentText}>{item.text ?? ''}</Text>
      </View>
    </View>
  );
}

function CommandExecution({ item }: Props) {
  const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
  const statusColor =
    item.status === 'completed' ? colors.status.active :
    item.status === 'failed' ? colors.status.error :
    colors.status.idle;

  return (
    <View style={styles.commandContainer}>
      <View style={styles.commandHeader}>
        <Ionicons name="terminal" size={14} color={colors.accent.green} />
        <Text style={styles.commandLabel}>Command</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
          <View style={[styles.statusDotSmall, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>
            {item.status ?? 'running'}
          </Text>
        </View>
      </View>
      <View style={styles.commandBody}>
        <Text style={styles.commandText}>$ {cmd}</Text>
      </View>
      {item.aggregatedOutput ? (
        <View style={styles.commandOutput}>
          <Text style={styles.outputText} numberOfLines={8}>
            {String(item.aggregatedOutput)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function FileChange({ item }: Props) {
  const changes = item.changes ?? [];
  return (
    <View style={styles.fileContainer}>
      <View style={styles.commandHeader}>
        <Ionicons name="document-text" size={14} color={colors.accent.green} />
        <Text style={styles.commandLabel}>File Changes</Text>
        <View style={[styles.statusBadge, { backgroundColor: colors.accent.greenMuted }]}>
          <Text style={[styles.statusText, { color: colors.accent.green }]}>
            {changes.length} file{changes.length !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>
      {changes.map((c, i) => (
        <View key={i} style={styles.fileDiffRow}>
          <Ionicons
            name={c.kind === 'create' ? 'add-circle' : c.kind === 'delete' ? 'remove-circle' : 'create'}
            size={14}
            color={c.kind === 'create' ? colors.status.active : c.kind === 'delete' ? colors.status.error : colors.status.warning}
          />
          <Text style={styles.filePath} numberOfLines={1}>
            {c.path}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Reasoning({ item }: Props) {
  if (!item.summary && !item.text) return null;
  return (
    <View style={styles.reasoningContainer}>
      <Ionicons name="bulb-outline" size={14} color={colors.text.tertiary} />
      <Text style={styles.reasoningText} numberOfLines={3}>
        {extractSummaryText(item)}
      </Text>
    </View>
  );
}

function PlanItem({ item }: Props) {
  return (
    <View style={styles.planContainer}>
      <View style={styles.commandHeader}>
        <Ionicons name="list" size={14} color={colors.accent.green} />
        <Text style={styles.commandLabel}>Plan</Text>
      </View>
      <Text style={styles.planText}>{item.text ?? ''}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // User message
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs,
  },
  userBubble: {
    maxWidth: '82%',
    backgroundColor: colors.item.userMessage,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  userText: {
    color: colors.text.primary,
    fontSize: typography.size.md,
    lineHeight: typography.size.md * typography.lineHeight.normal,
  },

  // Agent message
  agentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs,
  },
  agentBubble: {
    flex: 1,
    paddingVertical: spacing.xs,
  },
  agentText: {
    color: colors.text.primary,
    fontSize: typography.size.md,
    lineHeight: typography.size.md * typography.lineHeight.relaxed,
  },

  // Command
  commandContainer: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    backgroundColor: colors.item.commandBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  commandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.subtle,
    gap: spacing.sm,
  },
  commandLabel: {
    color: colors.text.secondary,
    fontSize: typography.size.xs,
    fontWeight: typography.weight.medium,
    flex: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    gap: 4,
  },
  statusDotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: typography.size.xs,
    fontWeight: typography.weight.medium,
  },
  commandBody: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  commandText: {
    color: colors.accent.green,
    fontSize: typography.size.sm,
    fontFamily: typography.fontFamily.mono,
  },
  commandOutput: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.subtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  outputText: {
    color: colors.text.secondary,
    fontSize: typography.size.xs,
    fontFamily: typography.fontFamily.mono,
    lineHeight: typography.size.xs * typography.lineHeight.relaxed,
  },

  // File change
  fileContainer: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    backgroundColor: colors.item.fileDiffBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  fileDiffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  filePath: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    fontFamily: typography.fontFamily.mono,
    flex: 1,
  },

  // Reasoning
  reasoningContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    gap: spacing.sm,
  },
  reasoningText: {
    color: colors.text.tertiary,
    fontSize: typography.size.sm,
    fontStyle: 'italic',
    flex: 1,
    lineHeight: typography.size.sm * typography.lineHeight.normal,
  },

  // Plan
  planContainer: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    backgroundColor: colors.item.commandBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  planText: {
    color: colors.text.primary,
    fontSize: typography.size.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    lineHeight: typography.size.sm * typography.lineHeight.normal,
  },
});
