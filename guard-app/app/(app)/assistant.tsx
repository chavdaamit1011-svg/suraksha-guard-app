import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { H2, Muted } from '@/components/ui';
import { useI18n, useT } from '@/i18n';
import { api } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space, touch } from '@/theme';

type Role = 'user' | 'assistant';
type Msg = { id: string; role: Role; text: string };

export default function Assistant() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const scrollRef = useRef<ScrollView>(null);

  const [messages, setMessages] = useState<Msg[]>([
    { id: 'greeting', role: 'assistant', text: t('assistant.greeting') },
  ]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);

  const scrollToEnd = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

  const send = async () => {
    const text = input.trim();
    if (!text || typing) return;
    const userMsg: Msg = { id: `u-${Date.now()}`, role: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setTyping(true);
    scrollToEnd();
    try {
      const history = messages
        .filter((m) => m.id !== 'greeting')
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));
      const res = await api.assistant(text, guardId(guard), lang, history);
      const reply = res.reply || res.answer || res.message || t('assistant.error');
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', text: reply }]);
    } catch {
      setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: 'assistant', text: t('assistant.error') }]);
    } finally {
      setTyping(false);
      scrollToEnd();
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.head}>
        <Ionicons name="arrow-back" size={24} color={colors.text} onPress={() => router.back()} />
        <H2>{t('assistant.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // Android 15 draws edge-to-edge, so the window no longer shrinks for the keyboard on its
        // own; without padding here the question box sat under the keyboard (seen on a phone).
        behavior="padding"
        keyboardVerticalOffset={12}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={scrollToEnd}
        >
          <View style={styles.disclaimer}>
            <Ionicons name="information-circle" size={16} color={colors.textFaint} />
            <Muted style={{ flex: 1 }}>{t('assistant.disclaimer')}</Muted>
          </View>

          {messages.map((m) => (
            <View
              key={m.id}
              style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.assistantBubble]}
            >
              <Text style={[styles.bubbleText, m.role === 'user' && { color: colors.onPrimary }]}>{m.text}</Text>
            </View>
          ))}

          {typing ? (
            <View style={[styles.bubble, styles.assistantBubble, styles.typingRow]}>
              <ActivityIndicator color={colors.textMuted} size="small" />
              <Text style={styles.typingText}>{t('assistant.typing')}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            multiline
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <Pressable
            onPress={send}
            disabled={!input.trim() || typing}
            style={({ pressed }) => [styles.sendBtn, { opacity: !input.trim() || typing ? 0.5 : pressed ? 0.85 : 1 }]}
          >
            <Ionicons name="send" size={22} color={colors.onPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md },
  list: { gap: space.sm, paddingBottom: space.lg },
  disclaimer: { flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, marginBottom: space.sm },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.primary },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  bubbleText: { color: colors.text, fontSize: font.body },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  typingText: { color: colors.textMuted, fontSize: font.label },
  // The floating SOS button (72 dp, 16 dp from the right edge) sits over the bottom-right corner
  // of every screen; keep the send button clear of it.
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingVertical: space.md, marginRight: 80 },
  input: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    maxHeight: 120,
    minHeight: touch.minTap,
  },
  sendBtn: { width: touch.minTap, height: touch.minTap, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
});
