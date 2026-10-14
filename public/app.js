const state = { devices: [], selectedId: null, map: null, markers: new Map(), route: null };
const PALETTE = ['#78e6bf', '#f3c969', '#6cb8ff', '#ff806c', '#c792ea', '#ff9fd0', '#9be564', '#ffb86b'];
const colorFor = (id) => PALETTE[(Number(id) - 1 + PALETTE.length * 100) % PALETTE.length];
const $ = (selector) => document.querySelector(selector);

async function loadSession() {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('Authentication session is unavailable.');
  const data = await response.json();
  const user = data.user || {};
  $('#account-name').textContent = `${user.name || user.email || 'Signed in'}${user.role ? ` (${user.role})` : ''}`;
  if (user.role !== 'admin') { function fmtDuration(startIso, endIso) {
  const seconds = Math.max(0, Math.floor(((endIso ? new Date(endIso) : new Date()) - new Date(startIso)) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
async function loadTrips() {
  const response = await fetch('/api/trips');
  if (!response.ok) return;
  const trips = await response.json();
  $('#trips-count').textContent = `${trips.length} trip${trips.length === 1 ? '' : 's'}`;
  $('#trips-body').innerHTML = trips.map((trip) => `<tr><td>${esc(trip.device_name)}</td><td>${new Date(trip.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${trip.ended_at ? new Date(trip.ended_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td><td>${fmtDuration(trip.started_at, trip.ended_at)}</td><td>${Number(trip.distance_km).toFixed(2)} km</td><td>${trip.points}</td><td><span class="status-chip ${trip.status === 'active' ? 'online' : 'completed'}">${esc(trip.status.toUpperCase())}</span></td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">No trips yet. Start a trip from the phone tracker page.</td></tr>';
}
$('#show-add').classList.add('hidden'); $('#add-form').remove(); }
}

function timeAgo(iso) {
  if (!iso) return 'No signal';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function formatTime(iso) { return iso ? new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

function initMap() {
  state.map = L.map('map', { zoomControl: false }).setView([6.5255, 3.3805], 14);
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(state.map);
}
function markerIcon(device) {
  const selected = device.id === state.selectedId ? ' selected' : '';
  return L.divIcon({ className: 'custom-marker', html: `<span class="marker-pin ${device.status}${selected}" style="--pin:${colorFor(device.id)}"><i></i></span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
function updateMarkerIcons() {
  state.devices.forEach((device) => { const marker = state.markers.get(device.id); if (marker) marker.setIcon(markerIcon(device)).setZIndexOffset(device.id === state.selectedId ? 1000 : 0); });
}
function renderMetrics() {
  const online = state.devices.filter((d) => d.status === 'online').length;
  const points = state.devices.filter((d) => d.latestLocation).length;
  $('#metrics').innerHTML = `<div class="metric-card"><span class="eyebrow">Registered trackers</span><strong>${state.devices.length.toString().padStart(2, '0')}</strong><small>Devices in your fleet</small></div><div class="metric-card accent"><span class="eyebrow">Live now</span><strong>${online.toString().padStart(2, '0')}</strong><small>Sending location updates</small></div><div class="metric-card"><span class="eyebrow">With location history</span><strong>${points.toString().padStart(2, '0')}</strong><small>Trackers with recorded points</small></div>`;
}
function renderDevices() {
  $('#device-list').innerHTML = state.devices.map((device) => `<button class="device-row ${device.id === state.selectedId ? 'selected' : ''}" data-device="${device.id}"><span class="device-icon" style="color:${colorFor(device.id)};border-color:${colorFor(device.id)}">⌁</span><span class="device-info"><strong>${esc(device.name)}</strong><small>${esc(device.device_type)} · ${device.latestLocation ? timeAgo(device.latestLocation.recorded_at) : 'Waiting for signal'}</small></span><span class="status-dot ${device.status}"></span></button>`).join('') || '<div class="empty-state">No trackers registered yet.</div>';
  document.querySelectorAll('[data-device]').forEach((button) => button.addEventListener('click', () => selectDevice(Number(button.dataset.device))));
}
function renderMarkers() {
  state.devices.forEach((device) => {
    const location = device.latestLocation;
    if (!location) return;
    const latLng = [location.latitude, location.longitude];
    const popup = `<strong>${esc(device.name)}</strong><br>${device.status.toUpperCase()} · ${Number(location.speed || 0).toFixed(1)} km/h<br><small>${formatTime(location.recorded_at)}</small>`;
    if (!state.markers.has(device.id)) {
      const marker = L.marker(latLng, { icon: markerIcon(device) }).addTo(state.map).bindPopup(popup).bindTooltip(esc(device.name), { permanent: true, direction: 'top', offset: [0, -14], className: 'marker-label' });
      marker.on('click', () => selectDevice(device.id, false));
      state.markers.set(device.id, marker);
    } else {
      state.markers.get(device.id).setLatLng(latLng).setIcon(markerIcon(device)).setPopupContent(popup).setTooltipContent(esc(device.name));
    }
  });
  const coordinates = state.devices.filter((d) => d.latestLocation).map((d) => [d.latestLocation.latitude, d.latestLocation.longitude]);
  if (coordinates.length && !state.selectedId) state.map.fitBounds(coordinates, { padding: [35, 35], maxZoom: 15 });
}
async function loadDevices() {
  const response = await fetch('/api/devices');
  state.devices = await response.json();
  if (!state.selectedId && state.devices[0]) state.selectedId = state.devices[0].id;
  if (state.selectedId && !state.devices.some((d) => d.id === state.selectedId)) state.selectedId = state.devices[0]?.id;
  renderMetrics(); renderDevices(); renderMarkers();
  if (state.selectedId) await selectDevice(state.selectedId, false);
}
async function selectDevice(id, pan = true) {
  state.selectedId = id; renderDevices(); updateMarkerIcons();
  const device = state.devices.find((d) => d.id === id); if (!device) return;
  $('#selected-name').textContent = device.name;
  $('#selected-status').textContent = device.status.toUpperCase(); $('#selected-status').className = `status-chip ${device.status}`;
  const loc = device.latestLocation;
  $('#detail-content').innerHTML = `<div class="telemetry-grid"><div><span>Last seen</span><strong>${timeAgo(loc?.recorded_at)}</strong></div><div><span>Speed</span><strong>${loc ? `${Number(loc.speed || 0).toFixed(1)} <small>km/h</small>` : '—'}</strong></div><div><span>Latitude</span><strong>${loc ? Number(loc.latitude).toFixed(5) : '—'}</strong></div><div><span>Longitude</span><strong>${loc ? Number(loc.longitude).toFixed(5) : '—'}</strong></div></div><div class="detail-row"><span>Device type</span><b>${esc(device.device_type)}</b></div><div class="detail-row"><span>Created</span><b>${formatTime(device.created_at)}</b></div>`;
  const response = await fetch(`/api/devices/${id}/locations?limit=100`); const locations = await response.json();
  $('#history-count').textContent = `${locations.length} points`;
  $('#history-body').innerHTML = locations.slice().reverse().map((point) => `<tr><td>${formatTime(point.recorded_at)}</td><td>${Number(point.latitude).toFixed(5)}</td><td>${Number(point.longitude).toFixed(5)}</td><td>${Number(point.speed || 0).toFixed(1)} km/h</td><td>${point.accuracy ? `${Number(point.accuracy).toFixed(0)} m` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No points recorded yet.</td></tr>';
  if (state.route) state.map.removeLayer(state.route);
  if (locations.length > 1) { state.route = L.polyline(locations.map((p) => [p.latitude, p.longitude]), { color: '#78e6bf', weight: 3, opacity: .85, dashArray: '5 8' }).addTo(state.map); if (pan) state.map.fitBounds(state.route.getBounds(), { padding: [45, 45], maxZoom: 16 }); }
}
$('#show-add').addEventListener('click', () => $('#add-form')?.classList.toggle('hidden'));
$('#add-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const name = $('#device-name').value.trim(); if (!name) return; const response = await fetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, deviceType: $('#device-type').value }) }); if (response.ok) { $('#device-name').value = ''; $('#add-form').classList.add('hidden'); await loadDevices(); } });
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
initMap(); Promise.all([loadSession(), loadDevices()]).catch((error) => { console.error(error); $('#device-list').innerHTML = '<div class="empty-state">Could not load the authenticated dashboard.</div>'; });
loadTrips().catch(console.error);
setInterval(() => { loadDevices().catch(console.error); loadTrips().catch(console.error); }, 10000);
