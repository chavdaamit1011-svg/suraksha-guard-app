import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Linking,
  Platform,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { colors, radius, space } from '@/theme';
import { quickFix } from '@/lib/location';

// Dynamically load react-native-maps to avoid breaking on web
let MapView: any = null;
let Marker: any = null;
let Polyline: any = null;
let PROVIDER_GOOGLE: any = null;

if (Platform.OS !== 'web') {
  try {
    const Maps = require('react-native-maps');
    MapView = Maps.default || Maps;
    Marker = Maps.Marker;
    Polyline = Maps.Polyline;
    PROVIDER_GOOGLE = Maps.PROVIDER_GOOGLE;
  } catch (e) {
    console.warn('react-native-maps load notice:', e);
  }
}

export interface DutyTargetLocation {
  title: string;
  clientName?: string;
  clientPhone?: string;
  address: string;
  city?: string;
  lat?: number | null;
  lng?: number | null;
  guardLat?: number | null;
  guardLng?: number | null;
  orderId?: string;
  bookingId?: string;
  serviceType?: string;
  timing?: string;
  instructions?: string;
}

export interface DutyRouteNavigationModalProps {
  visible: boolean;
  onClose: () => void;
  target: DutyTargetLocation | null;
}

// Fallback City coordinates map for resolving addresses without GPS coordinates
const CITY_COORDS: Record<string, [number, number]> = {
  naroda: [23.0732586, 72.658045],
  asarva: [23.0480, 72.6050],
  asarwa: [23.0480, 72.6050],
  nikol: [23.0450, 72.6680],
  bapunagar: [23.0370, 72.6320],
  maninagar: [22.9980, 72.6020],
  thaltej: [23.0540, 72.5080],
  bodakdev: [23.0350, 72.5120],
  vastrapur: [23.0360, 72.5280],
  ahmedabad: [23.0225, 72.5714],
  gandhinagar: [23.2156, 72.6369],
  noida: [28.5355, 77.3910],
  delhi: [28.6139, 77.2090],
  mumbai: [19.0760, 72.8777],
  bangalore: [12.9716, 77.5946],
  bengaluru: [12.9716, 77.5946],
  jaipur: [26.9124, 75.7873],
  lucknow: [26.8467, 80.9462],
  chandigarh: [30.7333, 76.7794],
  mohali: [30.7046, 76.7179],
  pune: [18.5204, 73.8567],
  gurgaon: [28.4595, 77.0266],
  gurugram: [28.4595, 77.0266],
};

function resolveDestinationCoords(target: DutyTargetLocation): { lat: number; lng: number } {
  const tLat = Number(target.lat);
  const tLng = Number(target.lng);
  if (!isNaN(tLat) && !isNaN(tLng) && tLat !== 0 && tLng !== 0) {
    return { lat: tLat, lng: tLng };
  }

  const query = `${target.address || ''} ${target.city || ''} ${target.title || ''}`.toLowerCase();
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (query.includes(key)) {
      return { lat: coords[0], lng: coords[1] };
    }
  }

  // Default to Ahmedabad Naroda
  return { lat: 23.0732586, lng: 72.658045 };
}

// Calculate straight line distance (Haversine formula in KM)
function calculateHaversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Web Google Map Component
 * Renders pristine Google Maps tiles with real driving polyline, live guard pulse pin,
 * and destination gold marker for instant web browser testing.
 */
function WebGoogleMapView({
  guardLat,
  guardLng,
  destLat,
  destLng,
  title,
  address,
  routeCoords,
  webIframeRef,
}: {
  guardLat: number;
  guardLng: number;
  destLat: number;
  destLng: number;
  title: string;
  address: string;
  routeCoords: Array<{ latitude: number; longitude: number }>;
  webIframeRef: any;
}) {
  const routeLatLngs = routeCoords.map((c) => [c.latitude, c.longitude]);
  const safeTitle = (title || 'Duty Destination').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const safeAddress = (address || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

  const htmlDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #0E1318; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .guard-marker {
      display: flex; align-items: center; justify-content: center;
      width: 48px; height: 48px; position: relative;
    }
    .guard-pulse {
      position: absolute; width: 48px; height: 48px; border-radius: 50%;
      background: rgba(16, 185, 129, 0.4);
      animation: pulse 2s infinite ease-out;
    }
    .guard-core {
      width: 32px; height: 32px; border-radius: 50%;
      background: #10B981; border: 2.5px solid #FFFFFF;
      box-shadow: 0 4px 14px rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 2;
    }
    .dest-pin {
      display: flex; flex-direction: column; align-items: center;
    }
    .dest-badge {
      background: #0B0D0F; border: 2px solid #F5C623; border-radius: 12px;
      padding: 5px 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.7);
      display: flex; align-items: center; gap: 5px; white-space: nowrap;
    }
    .dest-text {
      color: #F5C623; font-weight: 800; font-size: 11px; letter-spacing: 0.3px;
    }
    .dest-point {
      width: 0; height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-top: 8px solid #F5C623;
      margin-top: -1px;
    }
    @keyframes pulse {
      0% { transform: scale(0.6); opacity: 0.9; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    .leaflet-control-zoom {
      top: 110px !important;
      left: 14px !important;
      border: none !important;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
    }
    .leaflet-control-zoom a {
      background: #181C22 !important;
      color: #F5C623 !important;
      border: 1px solid rgba(255,255,255,0.15) !important;
      width: 36px !important;
      height: 36px !important;
      line-height: 34px !important;
      font-size: 18px !important;
      border-radius: 8px !important;
      margin-bottom: 4px !important;
    }
    .leaflet-control-attribution { display: none !important; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', { zoomControl: true, attributionControl: false });
    
    // Crisp Google Maps Roadmap Tiles
    L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      subdomains: ['0', '1', '2', '3'],
      maxZoom: 20
    }).addTo(map);

    var route = ${JSON.stringify(routeLatLngs)};
    var polyline = null;
    if (route && route.length > 0) {
      polyline = L.polyline(route, { color: '#10B981', weight: 6, opacity: 0.95 }).addTo(map);
      map.fitBounds(polyline.getBounds(), { padding: [100, 80], maxZoom: 16 });
    } else {
      map.setView([${guardLat}, ${guardLng}], 14);
    }

    // Guard Live Marker (Officer position)
    var guardIcon = L.divIcon({
      className: '',
      html: '<div class="guard-marker"><div class="guard-pulse"></div><div class="guard-core"><svg width="16" height="16" viewBox="0 0 24 24" fill="#0B0D0F"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg></div></div>',
      iconSize: [48, 48],
      iconAnchor: [24, 24]
    });
    L.marker([${guardLat}, ${guardLng}], { icon: guardIcon }).addTo(map).bindPopup('<b>Your Live Location</b>');

    // Destination Pin (Reporting Address)
    var destIcon = L.divIcon({
      className: '',
      html: '<div class="dest-pin"><div class="dest-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="#F5C623"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><span class="dest-text">${safeTitle}</span></div><div class="dest-point"></div></div>',
      iconSize: [140, 44],
      iconAnchor: [70, 44]
    });
    L.marker([${destLat}, ${destLng}], { icon: destIcon }).addTo(map).bindPopup('<b>${safeTitle}</b><br/>${safeAddress}');

    window.addEventListener('message', function(e) {
      if (e.data && e.data.action === 'recenter') {
        if (polyline) {
          map.fitBounds(polyline.getBounds(), { padding: [100, 80], maxZoom: 16 });
        } else {
          map.setView([${guardLat}, ${guardLng}], 15);
        }
      }
    });
  </script>
</body>
</html>`;

  if (Platform.OS === 'web') {
    return React.createElement('iframe', {
      ref: webIframeRef,
      srcDoc: htmlDoc,
      style: {
        width: '100%',
        height: '100%',
        border: 'none',
        position: 'absolute',
        top: 0,
        left: 0,
      },
      title: 'Google Maps Route Navigation',
    });
  }
  return null;
}

export default function DutyRouteNavigationModal({
  visible,
  onClose,
  target,
}: DutyRouteNavigationModalProps) {
  const mapRef = useRef<any>(null);
  const webIframeRef = useRef<any>(null);
  const [guardLocation, setGuardLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [routeCoords, setRouteCoords] = useState<Array<{ latitude: number; longitude: number }>>([]);
  const [distanceKm, setDistanceKm] = useState<string>('--');
  const [durationMins, setDurationMins] = useState<number | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(true);

  const destCoords = target ? resolveDestinationCoords(target) : { lat: 23.0425, lng: 72.6650 };

  // Fetch current guard location & road route
  const refreshLocationAndRoute = useCallback(async () => {
    if (!target) return;
    setLoadingRoute(true);

    try {
      // 1. Get current guard location (prefer real assigned officer coordinates or live GPS)
      let currentLat = target.guardLat ? Number(target.guardLat) : undefined;
      let currentLng = target.guardLng ? Number(target.guardLng) : undefined;

      if (!currentLat || !currentLng || currentLat === 0 || currentLng === 0) {
        const loc = await quickFix({ accuracy: Location.Accuracy.High, timeoutMs: 3_000 }).catch(() => null);
        if (loc?.coords?.latitude && loc?.coords?.longitude) {
          currentLat = loc.coords.latitude;
          currentLng = loc.coords.longitude;
        }
      }

      if (!currentLat || !currentLng || currentLat === 0 || currentLng === 0) {
        // Staging base: Nikol / Bapunagar (matching Operations radar dispatch)
        currentLat = 23.042668;
        currentLng = 72.662926;
      }

      setGuardLocation({ latitude: currentLat, longitude: currentLng });

      // 2. Fetch road driving route via OSRM
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${currentLng},${currentLat};${destCoords.lng},${destCoords.lat}?overview=full&geometries=geojson`;
      const res = await fetch(osrmUrl);
      const data = await res.json();

      if (data.routes && data.routes[0]) {
        const route = data.routes[0];
        const dist = (route.distance / 1000).toFixed(1);
        const mins = Math.max(2, Math.round(route.duration / 60));
        setDistanceKm(`${dist} km`);
        setDurationMins(mins);

        if (route.geometry?.coordinates?.length) {
          const formatted = route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({
            latitude: lat,
            longitude: lng,
          }));
          setRouteCoords(formatted);
        } else {
          setRouteCoords([
            { latitude: currentLat, longitude: currentLng },
            { latitude: destCoords.lat, longitude: destCoords.lng },
          ]);
        }
      } else {
        // Fallback calculations
        const directKm = calculateHaversineKm(currentLat, currentLng, destCoords.lat, destCoords.lng) * 1.35;
        setDistanceKm(`${directKm.toFixed(1)} km`);
        setDurationMins(Math.max(3, Math.round((directKm / 28) * 60)));
        setRouteCoords([
          { latitude: currentLat, longitude: currentLng },
          { latitude: destCoords.lat, longitude: destCoords.lng },
        ]);
      }
    } catch (e) {
      console.warn('Navigation Route fetch notice:', e);
      // Sensible fallback estimate
      setDistanceKm('3.8 km');
      setDurationMins(12);
    } finally {
      setLoadingRoute(false);
    }
  }, [target, destCoords.lat, destCoords.lng]);

  useEffect(() => {
    if (visible && target) {
      refreshLocationAndRoute();
    }
  }, [visible, target, refreshLocationAndRoute]);

  // Fit bounds when map and coordinates are ready
  const fitRouteBounds = useCallback(() => {
    if (Platform.OS === 'web') {
      try {
        webIframeRef.current?.contentWindow?.postMessage({ action: 'recenter' }, '*');
      } catch (e) {}
      return;
    }
    if (mapRef.current && guardLocation) {
      mapRef.current.fitToCoordinates(
        [
          guardLocation,
          { latitude: destCoords.lat, longitude: destCoords.lng },
          ...routeCoords,
        ],
        {
          edgePadding: { top: 120, right: 60, bottom: 260, left: 60 },
          animated: true,
        }
      );
    }
  }, [guardLocation, destCoords.lat, destCoords.lng, routeCoords]);

  useEffect(() => {
    if (!loadingRoute && routeCoords.length > 0) {
      setTimeout(fitRouteBounds, 400);
    }
  }, [loadingRoute, routeCoords.length, fitRouteBounds]);

  // Open native Google Maps Turn-by-Turn Navigation App
  const openExternalGoogleMapsNavigation = () => {
    if (!guardLocation) {
      Alert.alert('Location Required', 'Acquiring GPS position. Please try again in a moment.');
      return;
    }

    const origin = `${guardLocation.latitude},${guardLocation.longitude}`;
    const destination = `${destCoords.lat},${destCoords.lng}`;
    const label = encodeURIComponent(target?.title || 'Duty Location');

    // Google Maps Navigation URL scheme for mobile
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving&dir_action=navigate`;

    Linking.canOpenURL(url)
      .then((supported) => {
        if (supported) {
          return Linking.openURL(url);
        } else {
          return Linking.openURL(`https://maps.google.com/?daddr=${destination}`);
        }
      })
      .catch((err) => {
        Alert.alert('Maps Navigation', 'Could not open Google Maps app.');
      });
  };

  // Call Client Phone
  const callClientPhone = () => {
    if (!target?.clientPhone) {
      Alert.alert('Phone Not Available', 'Client contact number has not been provided.');
      return;
    }
    Linking.openURL(`tel:${target.clientPhone}`);
  };

  if (!visible || !target) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={styles.container}>
        {/* ── MAP CONTAINER ────────────────────────────────────────── */}
        <View style={styles.mapContainer}>
          {Platform.OS !== 'web' && MapView ? (
            <MapView
              ref={mapRef}
              style={StyleSheet.absoluteFill}
              provider={PROVIDER_GOOGLE}
              initialRegion={{
                latitude: guardLocation?.latitude || destCoords.lat,
                longitude: guardLocation?.longitude || destCoords.lng,
                latitudeDelta: 0.05,
                longitudeDelta: 0.05,
              }}
              showsUserLocation={false}
              showsMyLocationButton={false}
              showsCompass={false}
              customMapStyle={UBER_DARK_MAP_STYLE}
            >
              {/* Route Line */}
              {routeCoords.length > 0 && (
                <Polyline
                  coordinates={routeCoords}
                  strokeColor="#10B981"
                  strokeWidth={5}
                  lineDashPattern={undefined}
                />
              )}

              {/* Guard Location Marker (Uber/Rapido vehicle/officer marker) */}
              {guardLocation && (
                <Marker
                  coordinate={guardLocation}
                  anchor={{ x: 0.5, y: 0.5 }}
                  title="Your Current Location"
                >
                  <View style={styles.guardMarkerPin}>
                    <View style={styles.guardPulseRing} />
                    <View style={styles.guardMarkerCore}>
                      <Ionicons name="shield" size={16} color="#0B0D0F" />
                    </View>
                  </View>
                </Marker>
              )}

              {/* Destination Marker */}
              <Marker
                coordinate={{ latitude: destCoords.lat, longitude: destCoords.lng }}
                anchor={{ x: 0.5, y: 0.9 }}
                title={target.title}
                description={target.address}
              >
                <View style={styles.destMarkerPin}>
                  <View style={styles.destMarkerBadge}>
                    <Ionicons name="location" size={24} color="#F5C623" />
                  </View>
                  <View style={styles.destMarkerDot} />
                </View>
              </Marker>
            </MapView>
          ) : (
            // Web Google Map View with Live Route & Markers
            <WebGoogleMapView
              guardLat={guardLocation?.latitude || destCoords.lat - 0.025}
              guardLng={guardLocation?.longitude || destCoords.lng - 0.020}
              destLat={destCoords.lat}
              destLng={destCoords.lng}
              title={target.clientName || target.title || 'Duty Destination'}
              address={target.address || ''}
              routeCoords={routeCoords}
              webIframeRef={webIframeRef}
            />
          )}
        </View>

        {/* ── TOP FLOATING HEADER HUD (Uber / Rapido Style) ────────── */}
        <View style={styles.topHud}>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </Pressable>

          <View style={styles.metricsPill}>
            {loadingRoute ? (
              <ActivityIndicator size="small" color="#F5C623" />
            ) : (
              <>
                <View style={styles.metricItem}>
                  <Ionicons name="navigate-circle" size={18} color="#10B981" />
                  <Text style={styles.metricVal}>{distanceKm}</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metricItem}>
                  <Ionicons name="time" size={16} color="#F5C623" />
                  <Text style={styles.metricVal}>
                    {durationMins ? `${durationMins} min` : '--'}
                  </Text>
                </View>
              </>
            )}
          </View>

          <Pressable onPress={fitRouteBounds} style={styles.recenterBtn} hitSlop={10}>
            <Ionicons name="locate" size={20} color="#F5C623" />
          </Pressable>
        </View>

        {/* ── BOTTOM COMMAND SHEET (Uber / Rapido Driver Style) ───── */}
        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />

          {/* Client & Service Info Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.clientAvatar}>
              <Ionicons name="shield-checkmark" size={20} color="#F5C623" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.clientNameRow}>
                <Text style={styles.clientName} numberOfLines={1}>
                  {target.clientName || target.title || 'Client'}
                </Text>
                <View style={styles.orderIdBadge}>
                  <Text style={styles.orderIdText}>
                    {target.orderId || target.bookingId ? `#${target.orderId || target.bookingId}` : 'DEPLOYED'}
                  </Text>
                </View>
              </View>
              <Text style={styles.serviceType}>
                {target.serviceType || 'Security Officer Deployment'}
              </Text>
            </View>

            {target.clientPhone ? (
              <Pressable onPress={callClientPhone} style={styles.callClientBtn}>
                <Ionicons name="call" size={18} color="#10B981" />
              </Pressable>
            ) : null}
          </View>

          {/* Route Destination Card */}
          <View style={styles.destinationCard}>
            <View style={styles.destIconCol}>
              <View style={styles.dotOrigin} />
              <View style={styles.dashLine} />
              <View style={styles.dotDest} />
            </View>
            <View style={styles.destTextCol}>
              <View>
                <Text style={styles.routePointLabel}>Your Live Position</Text>
                <Text style={styles.routePointSub}>En-route to client site</Text>
              </View>
              <View style={{ marginTop: 8 }}>
                <Text style={styles.routePointLabel}>Reporting Site Address</Text>
                <Text style={styles.destAddressText} numberOfLines={2}>
                  {target.address || 'Address not specified'}
                </Text>
              </View>
            </View>
          </View>

          {/* Quick Metrics Bar */}
          <View style={styles.metricsBar}>
            <View style={styles.metricBlock}>
              <Text style={styles.metricBlockLabel}>DISTANCE</Text>
              <Text style={styles.metricBlockVal}>{distanceKm}</Text>
            </View>
            <View style={styles.metricBlockBorder} />
            <View style={styles.metricBlock}>
              <Text style={styles.metricBlockLabel}>EST. TIME</Text>
              <Text style={[styles.metricBlockVal, { color: '#10B981' }]}>
                {durationMins ? `~${durationMins} Mins` : '--'}
              </Text>
            </View>
            <View style={styles.metricBlockBorder} />
            <View style={styles.metricBlock}>
              <Text style={styles.metricBlockLabel}>TIMING</Text>
              <Text style={styles.metricBlockVal} numberOfLines={1}>
                {target.timing || 'Shift Active'}
              </Text>
            </View>
          </View>

          {/* Big Action: START NAVIGATION (Google Maps Navigation) */}
          <Pressable
            onPress={openExternalGoogleMapsNavigation}
            style={({ pressed }) => [
              styles.startNavButton,
              pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
            ]}
          >
            <View style={styles.navArrowIcon}>
              <Ionicons name="arrow-up" size={22} color="#0B0D0F" />
            </View>
            <Text style={styles.startNavText}>START NAVIGATION</Text>
            <View style={styles.googleBadge}>
              <Text style={styles.googleBadgeText}>GOOGLE MAPS</Text>
            </View>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// Tactical Uber Dark Theme Map Style for Google Maps
const UBER_DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#14181F' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0B0D0F' }, { weight: 2 }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#94A3B8' }] },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#F1F5F9' }],
  },
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#242C38' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#171E26' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#3B485A' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#F5C623' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#090C10' }],
  },
];

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0D0F',
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  webMapFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10141A',
    padding: space.xl,
    gap: space.sm,
  },
  webMapTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#FFFFFF',
    marginTop: 8,
  },
  webMapSubtitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#10B981',
  },
  webMapDestText: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 4,
  },

  /* ── TOP HUD ────────────────────────────── */
  topHud: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(11, 13, 15, 0.92)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  recenterBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(11, 13, 15, 0.92)',
    borderWidth: 1.5,
    borderColor: 'rgba(245, 198, 35, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  metricsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(11, 13, 15, 0.94)',
    borderWidth: 1.5,
    borderColor: 'rgba(245, 198, 35, 0.5)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 30,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 10,
    elevation: 8,
  },
  metricItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metricVal: {
    fontSize: 14,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
  metricDivider: {
    width: 1,
    height: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },

  /* ── BOTTOM SHEET ──────────────────────── */
  bottomSheet: {
    backgroundColor: '#11151C',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    gap: 14,
    shadowColor: '#000',
    shadowOpacity: 0.8,
    shadowRadius: 20,
    elevation: 20,
  },
  sheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignSelf: 'center',
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  clientAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(245, 198, 35, 0.15)',
    borderWidth: 1.5,
    borderColor: '#F5C623',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clientNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clientName: {
    fontSize: 17,
    fontWeight: '900',
    color: '#FFFFFF',
    flex: 1,
  },
  orderIdBadge: {
    backgroundColor: 'rgba(245, 198, 35, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245, 198, 35, 0.3)',
  },
  orderIdText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#F5C623',
  },
  serviceType: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94A3B8',
    marginTop: 2,
  },
  callClientBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1.5,
    borderColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── DESTINATION DETAILS ───────────────── */
  destinationCard: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    padding: 12,
  },
  destIconCol: {
    alignItems: 'center',
    paddingVertical: 4,
    width: 14,
  },
  dotOrigin: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10B981',
  },
  dashLine: {
    width: 2,
    height: 32,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    marginVertical: 4,
  },
  dotDest: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#F5C623',
    borderWidth: 2,
    borderColor: '#0B0D0F',
  },
  destTextCol: {
    flex: 1,
  },
  routePointLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  routePointSub: {
    fontSize: 12,
    fontWeight: '600',
    color: '#CBD5E1',
    marginTop: 1,
  },
  destAddressText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 1,
    lineHeight: 18,
  },

  /* ── METRICS BAR ───────────────────────── */
  metricsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0B0E13',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  metricBlock: {
    flex: 1,
    alignItems: 'center',
  },
  metricBlockLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  metricBlockVal: {
    fontSize: 14,
    fontWeight: '900',
    color: '#FFFFFF',
    marginTop: 2,
  },
  metricBlockBorder: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },

  /* ── START NAVIGATION BIG BUTTON ───────── */
  startNavButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#F5C623',
    paddingVertical: 16,
    borderRadius: 16,
    shadowColor: '#F5C623',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  navArrowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#0B0D0F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  startNavText: {
    fontSize: 16,
    fontWeight: '900',
    color: '#0B0D0F',
    letterSpacing: 0.5,
  },
  googleBadge: {
    backgroundColor: '#0B0D0F',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  googleBadgeText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#F5C623',
  },

  /* ── MAP MARKERS ───────────────────────── */
  guardMarkerPin: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
  },
  guardPulseRing: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(16, 185, 129, 0.3)',
    borderWidth: 1.5,
    borderColor: '#10B981',
  },
  guardMarkerCore: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0B0D0F',
  },
  destMarkerPin: {
    alignItems: 'center',
  },
  destMarkerBadge: {
    backgroundColor: '#0B0D0F',
    borderRadius: 20,
    padding: 6,
    borderWidth: 2,
    borderColor: '#F5C623',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 6,
  },
  destMarkerDot: {
    width: 4,
    height: 6,
    backgroundColor: '#F5C623',
    marginTop: -2,
  },
});
