import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  Alert,
  Switch,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors, spacing, radius, typography } from '../src/lib/theme';
import { addConnection } from '../src/store/connection-store';


export default function AddConnectionScreen() {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('4500');
  const [isDefault, setIsDefault] = useState(true);

  const handleSave = async () => {
    const trimmedLabel = label.trim() || 'My Codex Server';
    const trimmedHost = host.trim();
    const portNum = parseInt(port, 10);

    if (!trimmedHost) {
      Alert.alert('Invalid Host', 'Please enter a host address.');
      return;
    }
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      Alert.alert('Invalid Port', 'Please enter a valid port number (1-65535).');
      return;
    }

    await addConnection({
      label: trimmedLabel,
      host: trimmedHost,
      port: portNum,
      isDefault,
    });
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.description}>
          Enter the connection details for your Codex App Server.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Label</Text>
          <TextInput
            style={styles.input}
            value={label}
            onChangeText={setLabel}
            placeholder="My Codex Server"
            placeholderTextColor={colors.text.tertiary}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Host</Text>
          <TextInput
            style={styles.input}
            value={host}
            onChangeText={setHost}
            placeholder="192.168.1.100"
            placeholderTextColor={colors.text.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Port</Text>
          <TextInput
            style={styles.input}
            value={port}
            onChangeText={setPort}
            placeholder="4500"
            placeholderTextColor={colors.text.tertiary}
            keyboardType="number-pad"
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.label}>Set as Default</Text>
            <Text style={styles.switchHint}>Auto-connect on app launch</Text>
          </View>
          <Switch
            value={isDefault}
            onValueChange={setIsDefault}
            trackColor={{ false: colors.bg.tertiary, true: colors.accent.greenBorder }}
            thumbColor={isDefault ? colors.accent.green : colors.text.tertiary}
          />
        </View>

        <Pressable
          onPress={handleSave}
          style={({ pressed }) => [styles.saveBtn, pressed && styles.saveBtnPressed]}
        >
          <Text style={styles.saveBtnText}>Save Connection</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  description: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    lineHeight: typography.size.sm * typography.lineHeight.relaxed,
  },

  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.medium,
  },
  input: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border.primary,
    color: colors.text.primary,
    fontSize: typography.size.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
  },
  switchLabel: {
    flex: 1,
    marginRight: spacing.md,
  },
  switchHint: {
    color: colors.text.tertiary,
    fontSize: typography.size.xs,
    marginTop: 2,
  },

  saveBtn: {
    backgroundColor: colors.accent.green,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  saveBtnPressed: {
    backgroundColor: colors.accent.greenHover,
  },
  saveBtnText: {
    color: colors.text.inverse,
    fontSize: typography.size.md,
    fontWeight: typography.weight.semibold,
  },
});
