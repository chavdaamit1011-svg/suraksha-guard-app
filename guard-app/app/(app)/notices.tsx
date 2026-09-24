import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, space } from '@/theme';

type Notice = {
  _id: string;
  title?: string;
  body?: string;
  kind?: string;
  acknowledged?: boolean;
  createdAt?: string;
};

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Notices() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);

  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.notices(guardId(guard));
      setNotices((res.notices as Notice[] | undefined) ?? []);
    } catch {
      /* offline — show empty state */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acknowledge = async (id: string) => {
    setAcking(id);
    try {
      await api.ackNotice(guardId(guard), id);
    } catch {
      /* mark locally even if the network is down */
    }
    setNotices((prev) => prev.map((n) => (n._id === id ? { ...n, acknowledged: true } : n)));
    setAcking(null);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <Ionicons name="arrow-back" size={24} color={colors.text} onPress={() => goBack()} />
        <H2>{t('notices.title')}</H2>
        <View style={{ width: 24 }} />
      </View>

      <Muted>{t('notices.note')}</Muted>

      {loading ? (
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      ) : notices.length === 0 ? (
        <Card style={styles.center}>
          <Ionicons name="megaphone" size={28} color={colors.textFaint} />
          <Muted>{t('notices.empty')}</Muted>
        </Card>
      ) : (
        notices.map((n) => (
          <Card key={n._id}>
            <View style={styles.titleRow}>
              <Ionicons name="megaphone" size={20} color={colors.primary} />
              <Text style={styles.title}>{n.title ?? ''}</Text>
            </View>
            {n.body ? <Body style={{ color: colors.textMuted }}>{n.body}</Body> : null}
            <View style={styles.footer}>
              <Muted>{fmtDate(n.createdAt)}</Muted>
              {n.acknowledged ? (
                <View style={styles.rowGap}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.onDuty} />
                  <Text style={[styles.acked, { color: colors.onDuty }]}>{t('notices.acknowledged')}</Text>
                </View>
              ) : (
                <Button
                  label={t('notices.acknowledge')}
                  variant="primary"
                  size="small"
                  loading={acking === n._id}
                  onPress={() => acknowledge(n._id)}
                />
              )}
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { color: colors.text, fontSize: font.body, fontWeight: '800', flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xs },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  acked: { fontSize: font.label, fontWeight: '800' },
});
