const state = { devices: [], selectedId: null, map: null, markers: new Map(), route: null };
const $ = (selector) => document.querySelector(selector);

async function loadSession() {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('Authentication session is unavailable.');
  const data = await response.json();
  const user = data.user || {};
  $('#account-name').textContent = `${user.name || user.email || 'Signed in'}${user.role ? ` (${user.role})` : ''}`;
  if (user.role !== 'admin') { $('#show-add').classList.add('hidden'); $('#add-form').remove(); }
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
function markerIcon(status) {
  return L.divIcon({ className: 'custom-marker', html: `<span class="marker-pin ${status}"><i></i></span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
function renderMetrics() {
  const online = state.devices.filter((d) => d.status === 'online').length;
  const points = state.devices.filter((d) => d.latestLocation).length;
  $('#metrics').innerHTML = `<div class="metric-card"><span class="eyebrow">Registered trackers</span><strong>${state.devices.length.toString().padStart(2, '0')}</strong><small>Devices in your fleet</small></div><div class="metric-card accent"><span class="eyebrow">Live now</span><strong>${online.toString().padStart(2, '0')}</strong><small>Sending location updates</small></div><div class="metric-card"><span class="eyebrow">With location history</span><strong>${points.toString().padStart(2, '0')}</strong><small>Trackers with recorded points</small></div>`;
}
function renderDevices() {
  $('#device-list').innerHTML = state.devices.map((device) => `<button class="device-row ${device.id === state.selectedId ? 'selected' : ''}" data-device="${device.id}"><span class="device-icon">⌁</span><span class="device-info"><strong>${esc(device.name)}</strong><small>${esc(device.device_type)} · ${device.latestLocation ? timeAgo(device.latestLocation.recorded_at) : 'Waiting for signal'}</small></span><span class="status-dot ${device.status}"></span></button>`).join('') || '<div class="empty-state">No trackers registered yet.</div>';
  document.querySelectorAll('[data-device]').forEach((button) => button.addEventListener('click', () => selectDevice(Number(button.dataset.device))));
}
function renderMarkers() {
  state.devices.forEach((device) => {
    const location = device.latestLocation;
    if (!location) return;
    const latLng = [location.latitude, location.longitude];
    const popup = `<strong>${esc(device.name)}</strong><br>${device.status.toUpperCase()} · ${Number(location.speed || 0).toFixed(1)} km/h<br><small>${formatTime(location.recorded_at)}</small>`;
    if (!state.markers.has(device.id)) state.markers.set(device.id, L.marker(latLng, { icon: markerIcon(device.status) }).addTo(state.map).bindPopup(popup));
    else state.markers.get(device.id).setLatLng(latLng).setIcon(markerIcon(device.status)).setPopupContent(popup);
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
  state.selectedId = id; renderDevices();
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
setInterval(() => loadDevices().catch(console.error), 10000);
