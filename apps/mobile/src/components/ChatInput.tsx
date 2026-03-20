import React, { useState } from 'react';
import { View, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from '../lib/theme';

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
};

export function ChatInput({ onSend, disabled, loading, placeholder }: Props) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? 'Message Codex...'}
          placeholderTextColor={colors.text.tertiary}
          multiline
          maxLength={10000}
          editable={!disabled}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.sendBtn,
            canSend && styles.sendBtnActive,
            pressed && canSend && styles.sendBtnPressed,
          ]}
        >
          {loading ? (
            <ActivityIndicator size={18} color={colors.text.inverse} />
          ) : (
            <Ionicons
              name="arrow-up"
              size={18}
              color={canSend ? colors.text.inverse : colors.text.tertiary}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.subtle,
    backgroundColor: colors.bg.primary,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.bg.input,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 44,
  },
  input: {
    flex: 1,
    color: colors.text.primary,
    fontSize: typography.size.md,
    maxHeight: 120,
    paddingVertical: spacing.sm,
    lineHeight: typography.size.md * typography.lineHeight.normal,
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg.tertiary,
    marginLeft: spacing.sm,
    marginBottom: 2,
  },
  sendBtnActive: {
    backgroundColor: colors.accent.green,
  },
  sendBtnPressed: {
    backgroundColor: colors.accent.greenHover,
  },
});
