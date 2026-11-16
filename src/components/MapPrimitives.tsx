import React, { useEffect } from 'react';
import { AdvancedMarker, useAdvancedMarkerRef, useMap } from '@vis.gl/react-google-maps';

export const ALEXANDRIA_CENTER = { lat: 31.2156, lng: 29.9553 };

export function getGoogleMapsApiKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
}

export function hasValidGoogleMapsKey(apiKey: string = getGoogleMapsApiKey()): boolean {
  return Boolean(
    apiKey &&
      apiKey !== 'false' &&
      apiKey !== 'undefined' &&
      !apiKey.includes('MY_GOOGLE_MAPS_API_KEY')
  );
}

export const AdvancedMarkerWithRef: React.FC<{
  position: { lat: number; lng: number };
  zIndex?: number;
  onMarkerClick: (marker: google.maps.marker.AdvancedMarkerElement) => void;
  children: React.ReactNode;
}> = ({ position, zIndex, onMarkerClick, children }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();
  return (
    <AdvancedMarker
      ref={markerRef}
      position={position}
      zIndex={zIndex}
      onClick={() => {
        if (marker) onMarkerClick(marker);
      }}
    >
      {children}
    </AdvancedMarker>
  );
};

export const RouteTrailOverlay: React.FC<{
  points: ReadonlyArray<{ lat: number; lng: number }>;
}> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length < 2 || typeof google === 'undefined' || !google.maps?.Polyline) {
      return;
    }
    const path = [...points]
      .reverse()
      .map((p) => ({ lat: p.lat, lng: p.lng }));
    const polyline = new google.maps.Polyline({
      path,
      geodesic: true,
      strokeColor: '#0B1F3A',
      strokeOpacity: 0.75,
      strokeWeight: 4,
    });
    polyline.setMap(map);
    return () => {
      polyline.setMap(null);
    };
  }, [map, points]);
  return null;
};

export const MapPanController: React.FC<{
  target: { lat: number; lng: number; zoom?: number } | null;
}> = ({ target }) => {
  const map = useMap();
  useEffect(() => {
    if (!map || !target) return;
    map.panTo({ lat: target.lat, lng: target.lng });
    if (target.zoom) {
      map.setZoom(target.zoom);
    }
  }, [map, target]);
  return null;
};
