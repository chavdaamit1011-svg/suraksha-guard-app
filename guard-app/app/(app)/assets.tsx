import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Card, H2, Muted, Screen, Button } from '@/components/ui';
import { goBack } from '@/lib/navigation';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { guardId, useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

interface IssuedAssetItem {
  issuanceId: string;
  assetMongoId?: string;
  assetId: string;
  assetName: string;
  category: string;
  subcategory: string;
  assetType: string;
  unitOfMeasure: string;
  quantity: number;
  size: string;
  assetTag: string;
  serialNumber: string;
  issueCondition: string;
  issuedAt: string;
  issuedBy: string;
  expectedReturnDate: string | null;
  returnedAt: string | null;
  returnedQuantity: number;
  returnCondition: string;
  returnNote: string;
  acknowledgementStatus: string;
  note: string;
  status: string;
}

export default function GuardAssetsScreen() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const id = guard ? guardId(guard) : '';

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [assets, setAssets] = useState<IssuedAssetItem[]>([]);
  const [returnModalItem, setReturnModalItem] = useState<IssuedAssetItem | null>(null);
  const [returnCondition, setReturnCondition] = useState<'Good' | 'Fair' | 'Damaged'>('Good');
  const [returnNote, setReturnNote] = useState('');
  const [submittingReturn, setSubmittingReturn] = useState(false);

  const fetchAssets = useCallback(async (isManualRefresh = false) => {
    if (!id) {
      setLoading(false);
      return;
    }
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await api.guardAssets(id);
      if (res.success && Array.isArray(res.assets)) {
        setAssets(res.assets);
      } else {
        setAssets([]);
      }
    } catch (err) {
      console.error('Failed to fetch guard assets:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  const handleReturnSubmit = async () => {
    if (!returnModalItem || !id) return;
    setSubmittingReturn(true);
    try {
      const res = await api.returnAsset({
        guardId: id,
        issuanceId: returnModalItem.issuanceId,
        assetId: returnModalItem.assetId,
        returnCondition: returnCondition,
        returnNote: returnNote.trim() || 'Handed over by guard',
      });

      if (res.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert(
          'Asset Returned',
          `${returnModalItem.assetName} has been successfully returned and recorded in the Agency inventory.`
        );
        setReturnModalItem(null);
        setReturnNote('');
        setReturnCondition('Good');
        await fetchAssets(true);
      } else {
        Alert.alert('Return Failed', res.message || 'Could not process return.');
      }
    } catch (err: any) {
      Alert.alert('Return Error', err?.message || 'Failed to submit asset return.');
    } finally {
      setSubmittingReturn(false);
    }
  };

  const activeAssets = assets.filter((a) => !a.returnedAt);
  const returnedAssets = assets.filter((a) => a.returnedAt);

  return (
    <Screen>
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <Pressable onPress={() => goBack()} hitSlop={10} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1, marginLeft: space.sm }}>
          <H2>Issued Gear & Assets</H2>
          <Text style={styles.subTitle}>Kits, Uniforms & Security Equipment</Text>
        </View>
        <Pressable
          onPress={() => fetchAssets(true)}
          hitSlop={10}
          style={styles.refreshBtn}
          disabled={refreshing || loading}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Ionicons name="refresh" size={20} color={colors.primary} />
          )}
        </Pressable>
      </View>

      {/* ── SUMMARY STATS BAR ── */}
      <View style={styles.statsRow}>
        <View style={[styles.statBox, { borderColor: 'rgba(245,198,35,0.3)', backgroundColor: 'rgba(245,198,35,0.06)' }]}>
          <Text style={[styles.statNum, { color: colors.primary }]}>{assets.length}</Text>
          <Text style={styles.statLabel}>Total Assigned</Text>
        </View>

        <View style={[styles.statBox, { borderColor: 'rgba(16,185,129,0.3)', backgroundColor: 'rgba(16,185,129,0.06)' }]}>
          <Text style={[styles.statNum, { color: colors.onDuty }]}>{activeAssets.length}</Text>
          <Text style={styles.statLabel}>In Possession</Text>
        </View>

        <View style={[styles.statBox, { borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.03)' }]}>
          <Text style={[styles.statNum, { color: colors.textMuted }]}>{returnedAssets.length}</Text>
          <Text style={styles.statLabel}>Returned</Text>
        </View>
      </View>

      {/* ── MAIN SCROLL CONTENT ── */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space.xl * 2, gap: space.md }}
      >
        {loading && !refreshing ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Muted style={{ marginTop: space.sm }}>Loading issued items & handover logs…</Muted>
          </View>
        ) : assets.length === 0 ? (
          <Card style={styles.emptyCard}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="cube-outline" size={40} color={colors.textFaint} />
            </View>
            <Text style={styles.emptyTitle}>No Assets Currently Issued</Text>
            <Muted style={styles.emptyDesc}>
              When uniforms, walkie talkies, torches, or safety equipment are issued to you by the agency store, the exact date, time, and handover logs will appear here.
            </Muted>
          </Card>
        ) : (
          <View style={{ gap: space.md }}>
            {/* Active Gear Section */}
            {activeAssets.length > 0 && (
              <View style={{ gap: space.sm }}>
                <View style={styles.sectionHeaderRow}>
                  <Ionicons name="shield-checkmark" size={16} color={colors.onDuty} />
                  <Text style={styles.sectionTitle}>ACTIVE IN YOUR POSSESSION ({activeAssets.length})</Text>
                </View>

                {activeAssets.map((ast, idx) => (
                  <AssetCard
                    key={ast.issuanceId || `active-${idx}`}
                    item={ast}
                    onReturnClick={() => setReturnModalItem(ast)}
                  />
                ))}
              </View>
            )}

            {/* Returned Gear Section */}
            {returnedAssets.length > 0 && (
              <View style={{ gap: space.sm, marginTop: space.sm }}>
                <View style={styles.sectionHeaderRow}>
                  <Ionicons name="time-outline" size={16} color={colors.textMuted} />
                  <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
                    RETURNED / CLEARED GEAR ({returnedAssets.length})
                  </Text>
                </View>

                {returnedAssets.map((ast, idx) => (
                  <AssetCard key={ast.issuanceId || `returned-${idx}`} item={ast} />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* ── RETURN ASSET HANDOVER MODAL ── */}
      {returnModalItem && (
        <Modal
          visible={Boolean(returnModalItem)}
          transparent
          animationType="fade"
          onRequestClose={() => !submittingReturn && setReturnModalItem(null)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              {/* Modal Header */}
              <View style={styles.modalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={styles.modalIconWrap}>
                    <Ionicons name="arrow-undo-circle" size={24} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalTitle}>Return Asset / Gear</Text>
                    <Text style={styles.modalSubtitle} numberOfLines={1}>
                      {returnModalItem.assetName} ({returnModalItem.category})
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => !submittingReturn && setReturnModalItem(null)}
                  hitSlop={8}
                  style={styles.closeBtn}
                >
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </Pressable>
              </View>

              {/* Item Info Summary */}
              <View style={styles.returnInfoBox}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoKey}>Asset Code:</Text>
                  <Text style={styles.infoVal}>{returnModalItem.assetId}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoKey}>Quantity:</Text>
                  <Text style={styles.infoVal}>
                    {returnModalItem.quantity} {returnModalItem.unitOfMeasure || 'pcs'} {returnModalItem.size ? `(Size: ${returnModalItem.size})` : ''}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoKey}>Issued On:</Text>
                  <Text style={styles.infoVal}>
                    {returnModalItem.issuedAt
                      ? new Date(returnModalItem.issuedAt).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })
                      : '—'}
                  </Text>
                </View>
              </View>

              {/* Condition Selector */}
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>Current Condition on Return:</Text>
                <View style={styles.conditionBtnRow}>
                  {(['Good', 'Fair', 'Damaged'] as const).map((cond) => {
                    const isSel = returnCondition === cond;
                    return (
                      <Pressable
                        key={cond}
                        onPress={() => setReturnCondition(cond)}
                        style={[
                          styles.condBtn,
                          isSel && styles.condBtnActive,
                          cond === 'Damaged' && isSel && { borderColor: colors.danger, backgroundColor: 'rgba(239,68,68,0.15)' },
                        ]}
                      >
                        <Text
                          style={[
                            styles.condBtnText,
                            isSel && styles.condBtnTextActive,
                            cond === 'Damaged' && isSel && { color: colors.danger },
                          ]}
                        >
                          {cond === 'Good' ? '✓ Good (Working)' : cond === 'Fair' ? 'Fair (Usable)' : '⚠ Damaged'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Note / Remarks */}
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>Handover Remarks (Optional):</Text>
                <TextInput
                  value={returnNote}
                  onChangeText={setReturnNote}
                  placeholder="e.g. Handed over to store manager / end of shift"
                  placeholderTextColor={colors.textFaint}
                  style={styles.modalTextInput}
                  multiline
                  numberOfLines={2}
                />
              </View>

              {/* Modal Buttons */}
              <View style={styles.modalBtnRow}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  disabled={submittingReturn}
                  onPress={() => setReturnModalItem(null)}
                />
                <Button
                  label={submittingReturn ? 'Submitting…' : 'Confirm Return'}
                  variant="primary"
                  disabled={submittingReturn}
                  loading={submittingReturn}
                  icon={<Ionicons name="checkmark-done" size={18} color="#0B0D0F" />}
                  onPress={handleReturnSubmit}
                />
              </View>
            </View>
          </View>
        </Modal>
      )}
    </Screen>
  );
}

/**
 * Single Asset / Gear Card Component
 */
function AssetCard({
  item,
  onReturnClick,
}: {
  item: IssuedAssetItem;
  onReturnClick?: () => void;
}) {
  const isReturned = Boolean(item.returnedAt);
  const issueDateObj = item.issuedAt ? new Date(item.issuedAt) : null;
  const returnDateObj = item.returnedAt ? new Date(item.returnedAt) : null;

  const formattedIssueDate = issueDateObj && !isNaN(issueDateObj.getTime())
    ? issueDateObj.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

  const formattedIssueTime = issueDateObj && !isNaN(issueDateObj.getTime())
    ? issueDateObj.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : '';

  const formattedReturnDate = returnDateObj && !isNaN(returnDateObj.getTime())
    ? `${returnDateObj.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })} at ${returnDateObj.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })}`
    : '';

  return (
    <Card
      style={[
        styles.assetCard,
        isReturned ? styles.assetCardReturned : styles.assetCardActive,
      ]}
    >
      {/* Top Header: Title, Category & Status */}
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.assetName}>{item.assetName}</Text>
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryBadgeText}>{item.category}</Text>
            </View>
          </View>
          <Text style={styles.assetCode}>
            {item.assetId}
            {item.assetTag ? ` · Tag: ${item.assetTag}` : ''}
            {item.serialNumber ? ` · SN: ${item.serialNumber}` : ''}
          </Text>
        </View>

        {isReturned ? (
          <View style={styles.returnedBadge}>
            <Ionicons name="checkmark-done" size={12} color={colors.textMuted} />
            <Text style={styles.returnedBadgeText}>Returned</Text>
          </View>
        ) : (
          <View style={styles.activeBadge}>
            <View style={styles.greenDot} />
            <Text style={styles.activeBadgeText}>In Possession</Text>
          </View>
        )}
      </View>

      {/* Meta Grid: Qty, Date, Time & Issued By */}
      <View style={styles.metaGrid}>
        {/* Quantity / Size */}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Quantity</Text>
          <Text style={styles.metaValue}>
            {item.quantity} {item.unitOfMeasure || 'pcs'}
            {item.size ? ` (${item.size})` : ''}
          </Text>
        </View>

        {/* Handover Date & Time */}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Received On</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="time" size={13} color={colors.primary} />
            <Text style={[styles.metaValue, { color: colors.primary }]}>
              {formattedIssueDate} {formattedIssueTime ? `· ${formattedIssueTime}` : ''}
            </Text>
          </View>
        </View>

        {/* Issued By */}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Handed Over By</Text>
          <Text style={styles.metaValue}>{item.issuedBy || 'Store In-Charge'}</Text>
        </View>

        {/* Condition */}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Condition</Text>
          <Text style={styles.metaValue}>{item.issueCondition || 'Good'}</Text>
        </View>
      </View>

      {/* Return Information (if returned) */}
      {isReturned && (
        <View style={styles.returnAuditBox}>
          <Ionicons name="information-circle" size={14} color={colors.textMuted} />
          <Text style={styles.returnAuditText}>
            Handed back on <Text style={{ color: colors.text, fontWeight: '700' }}>{formattedReturnDate}</Text>
            {item.returnCondition ? ` (${item.returnCondition})` : ''}
            {item.returnNote ? ` · "${item.returnNote}"` : ''}
          </Text>
        </View>
      )}

      {/* Action Footer for Active Items */}
      {!isReturned && onReturnClick && (
        <View style={styles.actionFooter}>
          <Pressable onPress={onReturnClick} style={styles.returnBtn}>
            <Ionicons name="arrow-undo" size={14} color={colors.primary} />
            <Text style={styles.returnBtnText}>Return Gear to Store</Text>
          </Pressable>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.md,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(245,198,35,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subTitle: {
    fontSize: font.tiny,
    color: colors.textMuted,
    marginTop: 2,
  },
  statsRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginBottom: space.md,
  },
  statBox: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    alignItems: 'center',
  },
  statNum: {
    fontSize: font.h2,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xl * 2,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: space.xl * 1.5,
    paddingHorizontal: space.md,
    gap: space.sm,
    backgroundColor: '#121418',
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  emptyTitle: {
    fontSize: font.body,
    fontWeight: '800',
    color: colors.text,
  },
  emptyDesc: {
    fontSize: font.label,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 18,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.onDuty,
    letterSpacing: 0.5,
  },
  assetCard: {
    padding: space.md,
    gap: space.sm,
    backgroundColor: '#14171C',
  },
  assetCardActive: {
    borderColor: 'rgba(245,198,35,0.25)',
    borderWidth: 1,
  },
  assetCardReturned: {
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  assetName: {
    fontSize: font.body,
    fontWeight: '800',
    color: colors.text,
  },
  categoryBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  categoryBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
  },
  assetCode: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textMuted,
    marginTop: 3,
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  greenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.onDuty,
  },
  activeBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.onDuty,
  },
  returnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  returnedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
  },
  metaGrid: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: radius.sm,
    padding: space.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  metaItem: {
    width: '47%',
    gap: 2,
  },
  metaLabel: {
    fontSize: 10,
    color: colors.textFaint,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  metaValue: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text,
  },
  returnAuditBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: space.sm,
    borderRadius: radius.sm,
  },
  returnAuditText: {
    fontSize: 11,
    color: colors.textMuted,
    flex: 1,
    lineHeight: 16,
  },
  actionFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: space.xs,
  },
  returnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,198,35,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.3)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.sm,
  },
  returnBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#131519',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    padding: space.md,
    gap: space.md,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(245,198,35,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: font.body,
    fontWeight: '800',
    color: colors.text,
  },
  modalSubtitle: {
    fontSize: font.tiny,
    color: colors.textMuted,
  },
  closeBtn: {
    padding: 4,
  },
  returnInfoBox: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.sm,
    padding: space.sm,
    gap: 4,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  infoKey: {
    fontSize: 11,
    color: colors.textMuted,
  },
  infoVal: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text,
    fontFamily: 'monospace',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
  },
  conditionBtnRow: {
    flexDirection: 'row',
    gap: 6,
  },
  condBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  condBtnActive: {
    backgroundColor: 'rgba(245,198,35,0.15)',
    borderColor: colors.primary,
  },
  condBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
  },
  condBtnTextActive: {
    color: colors.primary,
  },
  modalTextInput: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.sm,
    color: colors.text,
    padding: space.sm,
    fontSize: font.label,
    textAlignVertical: 'top',
    minHeight: 56,
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
    marginTop: space.xs,
  },
});
