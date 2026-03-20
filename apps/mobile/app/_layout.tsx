import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../src/lib/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg.primary },
          headerTintColor: colors.text.primary,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: colors.bg.primary },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="thread/[id]"
          options={{
            title: 'Thread',
            headerBackTitle: 'Back',
          }}
        />
        <Stack.Screen
          name="add-connection"
          options={{
            title: 'Add Connection',
            presentation: 'modal',
          }}
        />
      </Stack>
    </>
  );
}
