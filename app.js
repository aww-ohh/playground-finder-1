// app.js — Front-end logic for Playground Finder

// ---- Grab references to HTML elements ----
var geolocateBtn = document.getElementById('geolocate-btn');
var addressForm = document.getElementById('address-form');
var addressInput = document.getElementById('address-input');
var searchSection = document.querySelector('.search-section');
var sortSelect = document.getElementById('sort-select');
var radiusSelect = document.getElementById('radius-select');
var typeFilterDiv = document.getElementById('type-filter');

// ---- localStorage helpers ----
function loadPref(key, allowed, fallback) {
  try {
    var val = localStorage.getItem(key);
    if (val !== null && allowed.indexOf(val) !== -1) return val;
  } catch (e) { /* private browsing or disabled — ignore */ }
  savePref(key, fallback);
  return fallback;
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

// ---- Restore saved preferences ----
var savedSort = loadPref('playgroundFinder.sort', ['distance', 'rating', 'reviews', 'data'], 'distance');
// Always default to 'all' on initial load — type filter is situational, not a preference
var savedType = 'all';
var savedRadius = loadPref('playgroundFinder.radius', ['0.5', '1', '2', '5'], '0.5');

sortSelect.value = savedSort;
radiusSelect.value = savedRadius;
// Set active type button
typeFilterDiv.querySelectorAll('.type-btn').forEach(function (btn) {
  btn.classList.toggle('active', btn.getAttribute('data-type') === savedType);
});

// ---- State ----
var map = null;
var markerGroup = L.layerGroup();
var markersByPlaceId = {};
var currentResults = [];
var lastLat = null;
var lastLng = null;
var requestId = 0; // for ignoring stale responses
var CURRENT_LOCATION_LABEL = 'Current location';
var MAP_AREA_LABEL = 'Map area';
var searchHereBtn = document.getElementById('search-here-btn');

// ---- Helper: show a status message ----
function showMessage(text, type) {
  var msg = document.getElementById('status-message');
  if (!msg) {
    msg = document.createElement('p');
    msg.id = 'status-message';
    searchSection.appendChild(msg);
  }
  msg.textContent = text;
  msg.className = 'status-message ' + type;
}

// ---- Helper: get current UI state ----
function getTypeFilter() {
  var active = typeFilterDiv.querySelector('.type-btn.active');
  return active ? active.getAttribute('data-type') : 'all';
}

function getRadius() {
  return radiusSelect.value;
}

function getSortOrder() {
  return sortSelect.value;
}

// ---- Home location (persisted in localStorage) ----
var HOME_KEY = 'playgroundFinder.home';

function getHome() {
  try {
    var raw = localStorage.getItem(HOME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function setHome(home) {
  try {
    if (home) localStorage.setItem(HOME_KEY, JSON.stringify(home));
    else localStorage.removeItem(HOME_KEY);
  } catch (e) { /* ignore */ }
}

// ---- Favorites (persisted in localStorage as an array of placeIds) ----
// Plus a separate map of full park data for ALL favorites, so the Saved
// tab can show parks across every search you've ever done.
var FAVORITES_KEY = 'playgroundFinder.favorites';
var SAVED_PARKS_KEY = 'playgroundFinder.savedParks';

function getFavorites() {
  try {
    var raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function setFavorites(arr) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(arr)); }
  catch (e) { /* storage full or disabled — ignore */ }
}

function isFavorite(placeId) {
  return getFavorites().indexOf(placeId) !== -1;
}

// Map of placeId → minimal park data for offline/cross-search rendering
function getSavedParksMap() {
  try {
    var raw = localStorage.getItem(SAVED_PARKS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function setSavedParksMap(obj) {
  try { localStorage.setItem(SAVED_PARKS_KEY, JSON.stringify(obj)); }
  catch (e) { /* storage full — ignore */ }
}

// Pull the full saved-park objects in the same order as getFavorites()
function getAllSavedParks() {
  var favs = getFavorites();
  var map = getSavedParksMap();
  return favs.map(function (pid) { return map[pid]; }).filter(Boolean);
}

// Returns true if it's now favorited, false if it was unfavorited
function toggleFavorite(placeId) {
  var favs = getFavorites();
  var map = getSavedParksMap();
  var idx = favs.indexOf(placeId);
  if (idx === -1) {
    favs.push(placeId);
    // Snapshot the park's data so it's accessible later regardless of search
    var park = currentResults.find(function (r) { return r.placeId === placeId; });
    if (park) map[placeId] = sanitizeParkForStorage(park);
  } else {
    favs.splice(idx, 1);
    delete map[placeId];
  }
  setFavorites(favs);
  setSavedParksMap(map);
  return idx === -1;
}

// Strip transient/large fields before saving (reviews are big; signals stale on the cache anyway)
function sanitizeParkForStorage(park) {
  return {
    placeId: park.placeId,
    name: park.name,
    type: park.type,
    lat: park.lat,
    lng: park.lng,
    rating: park.rating,
    reviewCount: park.reviewCount,
    photoUrl: park.photoUrl,           // may expire eventually but useful for a while
    photoAttribution: park.photoAttribution,
    openNow: park.openNow,
    todayHours: park.todayHours,
    signals: park.signals
    // intentionally NOT storing: reviews (big), distance (search-relative)
  };
}

// ---- Visited tracking (separate from favorites) ----
var VISITED_KEY = 'playgroundFinder.visited';

function getVisited() {
  try {
    var raw = localStorage.getItem(VISITED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function setVisited(arr) {
  try { localStorage.setItem(VISITED_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
}

function isVisited(placeId) {
  return getVisited().indexOf(placeId) !== -1;
}

function toggleVisited(placeId) {
  var visited = getVisited();
  var idx = visited.indexOf(placeId);
  if (idx === -1) visited.push(placeId);
  else visited.splice(idx, 1);
  setVisited(visited);
  return idx === -1;
}

// "Hide visited" toggle — persists in localStorage
var HIDE_VISITED_KEY = 'playgroundFinder.hideVisited';
function getHideVisited() {
  try { return localStorage.getItem(HIDE_VISITED_KEY) === '1'; }
  catch (e) { return false; }
}
function setHideVisited(on) {
  try { localStorage.setItem(HIDE_VISITED_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// ---- Personal notes per park (localStorage) ----
var NOTE_PREFIX = 'playgroundFinder.note.';

function getNote(placeId) {
  try { return localStorage.getItem(NOTE_PREFIX + placeId) || ''; }
  catch (e) { return ''; }
}

function setNote(placeId, text) {
  try {
    if (text && text.trim()) localStorage.setItem(NOTE_PREFIX + placeId, text);
    else localStorage.removeItem(NOTE_PREFIX + placeId);
  } catch (e) { /* ignore */ }
}

function hasNote(placeId) {
  return getNote(placeId).length > 0;
}

// ---- Recent searches (last 5, newest first) ----
var RECENTS_KEY = 'playgroundFinder.recentSearches';
var RECENTS_MAX = 5;

function getRecents() {
  try {
    var raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function pushRecent(label, lat, lng) {
  if (!label || label === CURRENT_LOCATION_LABEL || label === MAP_AREA_LABEL) return;
  var recents = getRecents();
  // Remove any existing entry with the same label
  recents = recents.filter(function (r) { return r.label !== label; });
  // Add new entry at the front
  recents.unshift({ label: label, lat: lat, lng: lng, ts: Date.now() });
  if (recents.length > RECENTS_MAX) recents = recents.slice(0, RECENTS_MAX);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch (e) { /* ignore */ }
}

// ---- Helper: filter results by type (or by favorited state) ----
function filterByType(results, typeFilter) {
  if (typeFilter === 'all') return results;
  if (typeFilter === 'favorites') {
    // Cross-search saved parks. Returns ALL favorites regardless of current search.
    var saved = getAllSavedParks();
    // Recompute distance from the most recent search location (or 0 if none)
    if (lastLat !== null && lastLng !== null) {
      saved = saved.map(function (p) {
        var d = distanceBetween(lastLat, lastLng, p.lat, p.lng);
        return Object.assign({}, p, { distance: Math.round(d * 100) / 100 });
      });
    } else {
      saved = saved.map(function (p) { return Object.assign({}, p, { distance: 0 }); });
    }
    return saved;
  }
  return results.filter(function (r) { return r.type === typeFilter; });
}

// ---- Signal filters (multi-select with AND logic) ----
var SIGNAL_FILTERS_KEY = 'playgroundFinder.signalFilters';

function getActiveSignalFilters() {
  try {
    var raw = localStorage.getItem(SIGNAL_FILTERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function setActiveSignalFilters(arr) {
  try { localStorage.setItem(SIGNAL_FILTERS_KEY, JSON.stringify(arr)); }
  catch (e) { /* ignore */ }
}

// AND filter: a park must satisfy EVERY active signal chip to pass.
// "fenced", "shade", "bathrooms" require value === 'yes'.
// "toddler" requires ageSuitability === 'toddler' or 'both'.
// "parking" requires parking === 'lot', 'street', or 'both'.
function filterBySignals(results, activeSignals) {
  if (!activeSignals || activeSignals.length === 0) return results;
  return results.filter(function (r) {
    if (!r.signals) return false;
    return activeSignals.every(function (sig) {
      if (sig === 'fenced')    return r.signals.fenced && r.signals.fenced.value === 'yes';
      if (sig === 'shade')     return r.signals.shade && r.signals.shade.value === 'yes';
      if (sig === 'bathrooms') return r.signals.bathrooms && r.signals.bathrooms.value === 'yes';
      if (sig === 'toddler')   {
        var v = r.signals.ageSuitability && r.signals.ageSuitability.value;
        return v === 'toddler' || v === 'both';
      }
      if (sig === 'parking')   {
        var p = r.signals.parking && r.signals.parking.value;
        return p === 'lot' || p === 'street' || p === 'both';
      }
      return true;
    });
  });
}

// ---- Sort helpers ----
function sortResults(results, sortBy) {
  var sorted = results.slice();
  if (sortBy === 'distance') {
    sorted.sort(function (a, b) { return a.distance - b.distance; });
  } else if (sortBy === 'rating') {
    sorted.sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
  } else if (sortBy === 'reviews') {
    sorted.sort(function (a, b) { return b.reviewCount - a.reviewCount; });
  } else if (sortBy === 'data') {
    // Rank by how many signal dimensions have a real (non-N/A) value.
    // Tie-break by distance so closer parks win when richness is equal.
    sorted.sort(function (a, b) {
      var diff = signalRichness(b.signals) - signalRichness(a.signals);
      if (diff !== 0) return diff;
      return a.distance - b.distance;
    });
  }
  return sorted;
}

// Is this a "perfect park" for a toddler? Fenced + bathrooms + toddler-friendly.
function isPerfectPark(signals) {
  if (!signals) return false;
  if (!(signals.fenced && signals.fenced.value === 'yes')) return false;
  if (!(signals.bathrooms && signals.bathrooms.value === 'yes')) return false;
  var age = signals.ageSuitability && signals.ageSuitability.value;
  if (age !== 'toddler' && age !== 'both') return false;
  return true;
}

// Count how many of the 5 signal dimensions are populated (non-N/A and non-loading)
function signalRichness(signals) {
  if (!signals) return 0;
  var dims = ['fenced', 'shade', 'bathrooms', 'ageSuitability', 'parking'];
  var count = 0;
  dims.forEach(function (d) {
    var v = signals[d] && signals[d].value;
    if (v && v !== 'not_mentioned' && v !== 'loading') count++;
  });
  return count;
}

// ---- Helper: type badge label with emoji ----
function typeBadgeLabel(type) {
  return type === 'playground' ? '\uD83D\uDEDD playground' : '\uD83C\uDF33 park';
}

// Google Maps directions URL — opens turn-by-turn navigation to that park,
// and also shows the destination park's info card on the way.
function googleDirectionsUrl(placeId, lat, lng) {
  // place_id makes the destination unambiguous; lat/lng is a fallback
  return 'https://www.google.com/maps/dir/?api=1'
    + '&destination=' + lat + ',' + lng
    + '&destination_place_id=' + encodeURIComponent(placeId);
}

// ---- Yelp search URL ----
function yelpSearchUrl(name, lat, lng) {
  return 'https://www.yelp.com/search?find_desc=' + encodeURIComponent(name)
    + '&find_loc=' + lat + '%2C' + lng;
}

// ---- Helper: build star icons HTML for a rating ----
function renderStars(rating) {
  var rounded = Math.round(rating * 2) / 2; // round to nearest 0.5
  var full = Math.floor(rounded);
  var half = rounded % 1 !== 0 ? 1 : 0;
  var empty = 5 - full - half;
  var html = '<span class="stars" aria-label="' + rating + ' out of 5 stars">';
  for (var i = 0; i < full; i++) html += '<span class="star full">\u2605</span>';
  if (half) html += '<span class="star half">\u2605</span>';
  for (var j = 0; j < empty; j++) html += '<span class="star empty">\u2605</span>';
  html += '</span>';
  return html;
}

// ---- Helper: compact star icons for popups ----
function renderStarsCompact(rating) {
  var rounded = Math.round(rating * 2) / 2;
  var full = Math.floor(rounded);
  var half = rounded % 1 !== 0 ? 1 : 0;
  var empty = 5 - full - half;
  var html = '<span class="stars stars-compact" aria-label="' + rating + ' out of 5 stars">';
  for (var i = 0; i < full; i++) html += '<span class="star full">\u2605</span>';
  if (half) html += '<span class="star half">\u2605</span>';
  for (var j = 0; j < empty; j++) html += '<span class="star empty">\u2605</span>';
  html += '</span>';
  return html;
}

// ---- Helper: build hero photo HTML for a result card ----
// Returns the photo and attribution wrapped in a container div,
// or an empty string if the result has no photo.
function renderHeroPhoto(result) {
  if (!result.photoUrl) return '';

  var attributionHtml = '';
  if (result.photoAttribution && result.photoAttribution.name) {
    if (result.photoAttribution.url) {
      attributionHtml = '<div class="card-hero-attribution">'
        + 'Photo by <a href="' + result.photoAttribution.url
        + '" target="_blank" rel="noopener noreferrer">'
        + result.photoAttribution.name + '</a>'
        + '</div>';
    } else {
      attributionHtml = '<div class="card-hero-attribution">'
        + 'Photo by ' + result.photoAttribution.name
        + '</div>';
    }
  }

  return '<div class="card-hero">'
    + '<img class="card-hero-image" src="' + result.photoUrl
    + '" alt="Photo of ' + result.name
    + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'">'
    + attributionHtml
    + '</div>';
}

// ---- Helper: build hero photo HTML for a popup ----
// Smaller version of the card hero, or empty string if no photo.
function renderPopupPhoto(result) {
  if (!result.photoUrl) return '';

  return '<div class="popup-hero">'
    + '<img class="popup-hero-image" src="' + result.photoUrl
    + '" alt="Photo of ' + result.name
    + '" onerror="this.parentElement.style.display=\'none\'">'
    + '</div>';
}

// ---- Review snippets ----
function truncateReview(text, maxLen) {
  if (!text) return '';
  text = text.trim();
  if (text.length <= maxLen) return text;
  // Cut on a word boundary close to maxLen
  var cut = text.substring(0, maxLen);
  var lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) cut = cut.substring(0, lastSpace);
  return cut + '…';
}

function escapeReviewHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReviews(result) {
  if (!result.reviews || result.reviews.length === 0) return '';
  var count = result.reviews.length;
  var items = result.reviews.map(function (text) {
    return '<div class="review-snippet">"' + escapeReviewHtml(truncateReview(text, 220)) + '"</div>';
  }).join('');
  return '<div class="reviews-section">'
    + '<button type="button" class="reviews-toggle" aria-expanded="false">'
    + '📝 Read reviews (' + count + ') <span class="reviews-arrow">▶</span>'
    + '</button>'
    + '<div class="reviews-content">' + items + '</div>'
    + '</div>';
}

// ---- Weather (Open-Meteo, no API key) ----
function weatherCodeToEmoji(code) {
  if (code === 0) return ['☀️', 'Clear'];
  if (code === 1 || code === 2) return ['🌤️', 'Mostly clear'];
  if (code === 3) return ['☁️', 'Cloudy'];
  if (code === 45 || code === 48) return ['🌫️', 'Foggy'];
  if (code >= 51 && code <= 57) return ['🌦️', 'Drizzle'];
  if (code >= 61 && code <= 67) return ['🌧️', 'Rain'];
  if (code >= 71 && code <= 77) return ['🌨️', 'Snow'];
  if (code >= 80 && code <= 82) return ['🌧️', 'Showers'];
  if (code >= 85 && code <= 86) return ['🌨️', 'Snow showers'];
  if (code >= 95) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', ''];
}

function fetchWeather(lat, lng, thisRequest) {
  var url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat
    + '&longitude=' + lng
    + '&current=temperature_2m,weather_code'
    + '&temperature_unit=fahrenheit';
  fetch(url)
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      if (thisRequest !== requestId) return; // stale
      var banner = document.getElementById('weather-banner');
      if (!banner) return;
      if (!data || !data.current) {
        banner.classList.add('hidden');
        return;
      }
      var temp = Math.round(data.current.temperature_2m);
      var ec = weatherCodeToEmoji(data.current.weather_code);
      banner.innerHTML = '<span class="weather-emoji">' + ec[0] + '</span>'
        + '<span class="weather-temp">' + temp + '°F</span>'
        + (ec[1] ? '<span class="weather-label">· ' + ec[1] + '</span>' : '');
      banner.classList.remove('hidden');
    })
    .catch(function () { /* silent — weather is a nice-to-have */ });
}

// ---- Personal notes section per card ----
function renderNoteSection(result) {
  var existing = getNote(result.placeId);
  var hasExisting = existing && existing.length > 0;
  var label = hasExisting ? '📝 Your note' : '📝 Add a note';
  return '<div class="note-section' + (hasExisting ? ' has-note' : '') + '">'
    + '<button type="button" class="note-toggle" aria-expanded="' + (hasExisting ? 'true' : 'false') + '">'
    + label + ' <span class="note-arrow">▶</span>'
    + '</button>'
    + '<div class="note-content"' + (hasExisting ? '' : ' style="display:none"') + '>'
    + '<textarea class="note-input" data-place-id="' + result.placeId + '" '
    + 'placeholder="e.g. fence on south side has a gap, swings squeak in the rain..." '
    + 'rows="3">' + escapeReviewHtml(existing) + '</textarea>'
    + '<div class="note-status" data-place-id="' + result.placeId + '"></div>'
    + '</div></div>';
}

// ---- Travel-time estimate (from miles, no API) ----
// Walking: 3 mph (about 20 minutes per mile)
// Driving: 25 mph in-city (about 2.4 minutes per mile)
function renderTravelTime(miles) {
  if (typeof miles !== 'number' || miles <= 0) return '';
  var walkMin = Math.max(1, Math.round(miles * 20));
  var driveMin = Math.max(1, Math.round(miles * 2.4));
  // Only show walk time if it's reasonable (< 45 min). Otherwise it's silly to suggest walking.
  var showWalk = walkMin <= 45;
  var milesText = miles < 0.1 ? '<0.1 mi' : (miles + ' mi');
  if (showWalk) {
    return '🚶 ' + walkMin + ' min · 🚗 ' + driveMin + ' min'
      + ' <span class="distance-mi">· ' + milesText + '</span>';
  }
  return '🚗 ' + driveMin + ' min'
    + ' <span class="distance-mi">· ' + milesText + '</span>';
}

// ---- Hours rendering ----
function renderHours(result) {
  // Nothing if Google didn't give us either field
  if (result.openNow === null && !result.todayHours) return '';
  var statusHtml = '';
  if (result.openNow === true) {
    statusHtml = '<span class="hours-open">Open now</span>';
  } else if (result.openNow === false) {
    statusHtml = '<span class="hours-closed">Closed</span>';
  }
  var todayHtml = result.todayHours
    ? '<span class="hours-today">' + result.todayHours + '</span>'
    : '';
  var sep = (statusHtml && todayHtml) ? '<span class="hours-sep">·</span>' : '';
  return '<span class="result-meta result-hours">🕐 ' + statusHtml + sep + todayHtml + '</span>';
}

// ---- Signal rendering helpers ----

// Maps dimension values to display labels for category dimensions
function ageSuitabilityLabel(value) {
  if (value === 'loading') return '...';
  if (value === 'toddler') return 'Toddler-friendly';
  if (value === 'older') return 'Older kids';
  if (value === 'both') return 'All ages';
  return 'N/A';
}

function parkingLabel(value) {
  if (value === 'loading') return '...';
  if (value === 'lot') return 'Parking lot';
  if (value === 'street') return 'Street parking';
  if (value === 'both') return 'Lot & street';
  return 'N/A';
}

// Builds the value indicator HTML for a boolean dimension (fenced, shade, bathrooms)
function booleanValueHtml(value) {
  if (value === 'yes') return '<span class="signal-yes">\u2705 Yes</span>';
  if (value === 'no') return '<span class="signal-no">\u274C No</span>';
  if (value === 'loading') return '<span class="signal-loading">\u23F3 \u2026</span>';
  return '<span class="signal-na">\u2796 N/A</span>';
}

// Builds the value indicator HTML for a category dimension (age, parking)
function categoryValueHtml(label) {
  if (label === '...') return '<span class="signal-loading">\u23F3 \u2026</span>';
  if (label === 'N/A') return '<span class="signal-na">\u2796 N/A</span>';
  return '<span class="signal-category">' + label + '</span>';
}

// Stand-in signals while we wait for /api/signals to return
function loadingSignals() {
  return {
    fenced: { value: 'loading', summary: null },
    shade: { value: 'loading', summary: null },
    bathrooms: { value: 'loading', summary: null },
    ageSuitability: { value: 'loading', summary: null },
    parking: { value: 'loading', summary: null }
  };
}

// Default (all N/A) signals \u2014 used for parks with no reviews
function defaultSignalsClient() {
  return {
    fenced: { value: 'not_mentioned', summary: null },
    shade: { value: 'not_mentioned', summary: null },
    bathrooms: { value: 'not_mentioned', summary: null },
    ageSuitability: { value: 'not_mentioned', summary: null },
    parking: { value: 'not_mentioned', summary: null }
  };
}

// ---- localStorage cache for Gemini-extracted signals ----
// Keyed by Google placeId. Signals don't change often, so we cache indefinitely.
var SIGNAL_CACHE_PREFIX = 'playgroundFinder.signals.';

function loadCachedSignals(placeId) {
  try {
    var raw = localStorage.getItem(SIGNAL_CACHE_PREFIX + placeId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function saveCachedSignals(placeId, signals) {
  try {
    localStorage.setItem(SIGNAL_CACHE_PREFIX + placeId, JSON.stringify(signals));
  } catch (e) { /* storage full or disabled \u2014 ignore */ }
}

// Replace the signals area of a single card without re-rendering the whole list
function updateCardSignals(placeId, signals) {
  var card = document.querySelector('.result-card[data-place-id="' + placeId + '"]');
  if (!card) return;
  var oldList = card.querySelector('.signals-list');
  if (oldList) {
    var temp = document.createElement('div');
    temp.innerHTML = renderSignals(signals);
    var newList = temp.firstChild;
    if (newList) oldList.replaceWith(newList);
  }
  // Re-evaluate "perfect park" status now that signals have arrived
  card.classList.toggle('is-perfect', isPerfectPark(signals));
}

// Builds one signal row for a card (with expandable summary)
function renderSignalRow(icon, label, valueHtml, summary) {
  var tappable = summary ? ' signal-tappable' : '';
  var arrow = summary ? '<span class="signal-arrow">\u25B6</span>' : '';
  var summaryHtml = summary
    ? '<div class="signal-summary">' + summary + '</div>'
    : '';
  return '<div class="signal-row' + tappable + '">'
    + '<div class="signal-row-header">'
    + '<span class="signal-icon">' + icon + '</span>'
    + '<span class="signal-label">' + label + '</span>'
    + valueHtml
    + arrow
    + '</div>'
    + summaryHtml
    + '</div>';
}

// Builds the full signals list for a card
function renderSignals(signals) {
  if (!signals) return '';

  var html = '<div class="signals-list">';
  html += renderSignalRow('\uD83D\uDD12', 'Fenced', booleanValueHtml(signals.fenced.value), signals.fenced.summary);
  html += renderSignalRow('\uD83C\uDF33', 'Shade', booleanValueHtml(signals.shade.value), signals.shade.summary);
  html += renderSignalRow('\uD83D\uDEBB', 'Bathrooms', booleanValueHtml(signals.bathrooms.value), signals.bathrooms.summary);
  html += renderSignalRow('\uD83D\uDC76', 'Ages', categoryValueHtml(ageSuitabilityLabel(signals.ageSuitability.value)), signals.ageSuitability.summary);
  html += renderSignalRow('\uD83C\uDD7F\uFE0F', 'Parking', categoryValueHtml(parkingLabel(signals.parking.value)), signals.parking.summary);
  html += '</div>';
  return html;
}

// Builds one signal row for a popup (compact, no expand)
function renderPopupSignalRow(icon, valueHtml) {
  return '<span class="popup-signal">'
    + '<span class="popup-signal-icon">' + icon + '</span>'
    + valueHtml
    + '</span>';
}

// Builds the compact signals strip for a popup
function renderPopupSignals(signals) {
  if (!signals) return '';

  var html = '<div class="popup-signals">';
  html += renderPopupSignalRow('\uD83D\uDD12', booleanValueHtml(signals.fenced.value));
  html += renderPopupSignalRow('\uD83C\uDF33', booleanValueHtml(signals.shade.value));
  html += renderPopupSignalRow('\uD83D\uDEBB', booleanValueHtml(signals.bathrooms.value));
  html += renderPopupSignalRow('\uD83D\uDC76', categoryValueHtml(ageSuitabilityLabel(signals.ageSuitability.value)));
  html += renderPopupSignalRow('\uD83C\uDD7F\uFE0F', categoryValueHtml(parkingLabel(signals.parking.value)));
  html += '</div>';
  return html;
}

// ---- Helper: build the HTML content for a map popup ----
function buildPopupContent(r) {
  var popupRating;
  if (r.rating) {
    popupRating = renderStarsCompact(r.rating)
      + ' <span style="font-weight:700;font-size:0.8rem;">' + r.rating + '</span>'
      + ' <span style="font-size:0.75rem;color:#666;">(' + r.reviewCount.toLocaleString() + ' reviews)</span>';
  } else {
    popupRating = '<span style="font-size:0.75rem;color:#666;">No ratings yet</span>';
  }
  var popupTypeClass = r.type === 'playground' ? 'playground' : 'park';
  return '<div class="popup-content">'
    + renderPopupPhoto(r)
    + '<div class="popup-body">'
    + '<strong>' + r.name + '</strong><br>'
    + '<span class="result-type result-type-compact ' + popupTypeClass + '">' + typeBadgeLabel(r.type) + '</span> ' + popupRating + '<br>'
    + renderPopupSignals(r.signals)
    + '<a class="popup-link-google" href="' + googleDirectionsUrl(r.placeId, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">🚗 Directions in Google Maps</a><br>'
    + '<a class="popup-link-yelp" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
    + '</div>'
    + '</div>';
}

// ---- Helper: render an empty state with actionable suggestions ----
function renderEmptyState(currentRadius) {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('five-things-strip');
  // Show the results section (so the empty state lives where cards would), hide toolbar + strip
  resultsSection.classList.remove('hidden');
  resultsToolbar.classList.add('hidden');
  if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');

  // Find the next bigger radius to suggest
  var radii = ['0.5', '1', '2', '5'];
  var idx = radii.indexOf(String(currentRadius));
  var nextRadius = (idx >= 0 && idx < radii.length - 1) ? radii[idx + 1] : null;

  var html = '<div class="empty-state">'
    + '<div class="empty-emoji">🤷</div>'
    + '<div class="empty-title">No parks found here</div>'
    + '<div class="empty-sub">Try one of these:</div>'
    + '<div class="empty-actions">';
  if (nextRadius) {
    html += '<button type="button" class="empty-cta" data-action="widen-radius" data-radius="' + nextRadius + '">'
      + 'Widen to ' + formatRadius(nextRadius) + ' →</button>';
  }
  html += '<button type="button" class="empty-cta" data-action="change-location">Change location ↩</button>';
  html += '</div></div>';
  resultsList.innerHTML = html;
}

// Wire up empty-state button clicks
document.getElementById('results-list').addEventListener('click', function (e) {
  var cta = e.target.closest('.empty-cta');
  if (!cta) return;
  var action = cta.getAttribute('data-action');
  if (action === 'widen-radius') {
    var newRadius = cta.getAttribute('data-radius');
    radiusSelect.value = newRadius;
    savePref('playgroundFinder.radius', newRadius);
    if (lastLat !== null && lastLng !== null) handleCoordinates(lastLat, lastLng);
  } else if (action === 'change-location') {
    addressInput.value = '';
    addressInput.focus();
  }
});

// ---- Helper: show shimmer skeleton cards while results are loading ----
function showLoadingSkeletons() {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('five-things-strip');
  // Hide the educational strip + show the results section while loading
  if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');
  resultsSection.classList.remove('hidden');
  resultsToolbar.classList.add('hidden'); // toolbar appears when real results arrive
  // Render 4 skeleton placeholder cards
  var html = '';
  for (var i = 0; i < 4; i++) {
    html += '<li class="result-card skeleton-card">'
      + '<div class="skeleton skeleton-photo"></div>'
      + '<div class="result-card-body">'
      + '<div class="skeleton skeleton-line skeleton-line-title"></div>'
      + '<div class="skeleton skeleton-line skeleton-line-meta"></div>'
      + '<div class="skeleton skeleton-line skeleton-line-meta"></div>'
      + '<div class="skeleton skeleton-line skeleton-line-row"></div>'
      + '<div class="skeleton skeleton-line skeleton-line-row"></div>'
      + '<div class="skeleton skeleton-line skeleton-line-row"></div>'
      + '</div>'
      + '</li>';
  }
  resultsList.innerHTML = html;
}

// ---- Helper: scroll the results list to a card and flash it ----
function scrollToCard(placeId) {
  var card = document.querySelector('.result-card[data-place-id="' + placeId + '"]');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.remove('card-flash'); // restart animation if already running
  // Force a reflow so the class re-add triggers a fresh animation
  void card.offsetWidth;
  card.classList.add('card-flash');
}

// ---- Helper: show the map and place markers ----
function showMap(lat, lng, results) {
  document.getElementById('map-section').classList.remove('hidden');

  if (!map) {
    map = L.map('map').setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    markerGroup.addTo(map);
    // Show the "Search this area" button whenever the user pans the map
    map.on('dragend', function () {
      searchHereBtn.classList.remove('hidden');
    });
  } else {
    map.flyTo([lat, lng], 13);
  }

  // Hide the "Search this area" button now that we have fresh results centered here
  searchHereBtn.classList.add('hidden');

  markerGroup.clearLayers();
  markersByPlaceId = {};

  // Visitor marker
  var visitorIcon = L.divIcon({
    className: 'visitor-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -18]
  });
  L.marker([lat, lng], { icon: visitorIcon, zIndexOffset: 1000 })
    .bindPopup('You are here')
    .addTo(markerGroup);

  // Park/playground markers
  var bounds = L.latLngBounds([[lat, lng]]);
  results.forEach(function (r) {
    var marker = L.marker([r.lat, r.lng])
      .bindPopup(buildPopupContent(r))
      .addTo(markerGroup);
    markersByPlaceId[r.placeId] = marker;
    // Clicking the marker scrolls the matching card into view and briefly highlights it
    marker.on('click', (function (placeId) {
      return function () { scrollToCard(placeId); };
    })(r.placeId));
    bounds.extend([r.lat, r.lng]);
  });

  if (results.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  setTimeout(function () { map.invalidateSize(); }, 200);
}

// ---- Helper: update marker visibility based on type filter ----
function updateMarkerVisibility(typeFilter, activeSignals, hideVisited) {
  // Build a set of placeIds that pass the current filters
  var visibleIds = {};
  var filtered = filterByType(currentResults, typeFilter);
  filtered = filterBySignals(filtered, activeSignals || []);
  if (hideVisited) {
    filtered = filtered.filter(function (r) { return !isVisited(r.placeId); });
  }
  filtered.forEach(function (r) { visibleIds[r.placeId] = true; });

  Object.keys(markersByPlaceId).forEach(function (placeId) {
    var marker = markersByPlaceId[placeId];
    if (visibleIds[placeId]) {
      if (!markerGroup.hasLayer(marker)) markerGroup.addLayer(marker);
    } else {
      if (markerGroup.hasLayer(marker)) markerGroup.removeLayer(marker);
    }
  });

  // Saved tab special-case: also place markers for saved parks NOT in the current search
  if (typeFilter === 'favorites' && map) {
    addMarkersForSavedParks(filtered);
  }
}

// Add map markers for saved parks that aren't already in markersByPlaceId
function addMarkersForSavedParks(savedFilteredResults) {
  if (!map) return;
  var bounds = L.latLngBounds([]);
  var added = 0;
  savedFilteredResults.forEach(function (r) {
    if (markersByPlaceId[r.placeId]) {
      bounds.extend([r.lat, r.lng]);
      return; // already on map from current search
    }
    var marker = L.marker([r.lat, r.lng])
      .bindPopup(buildPopupContent(r))
      .addTo(markerGroup);
    markersByPlaceId[r.placeId] = marker;
    marker.on('click', (function (placeId) {
      return function () { scrollToCard(placeId); };
    })(r.placeId));
    bounds.extend([r.lat, r.lng]);
    added++;
  });
  // If we added new markers OR if the visible set differs from current search, refit
  if (savedFilteredResults.length > 0) {
    document.getElementById('map-section').classList.remove('hidden');
    try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 }); } catch (e) { /* empty bounds */ }
    setTimeout(function () { map.invalidateSize(); }, 200);
  }
}

// ---- Helper: render the styled results list ----
function renderResults(results) {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('five-things-strip');

  // Remove any existing filter message
  var existingMsg = resultsSection.querySelector('.filter-message');
  if (existingMsg) existingMsg.remove();

  // Special case: Saved tab with no current search but with saved parks → still show
  var typeFilterNow = getTypeFilter();
  var hasSavedToShow = typeFilterNow === 'favorites' && getAllSavedParks().length > 0;

  // Saved tab with NO saved parks at all: friendly empty state
  if (typeFilterNow === 'favorites' && getAllSavedParks().length === 0) {
    resultsSection.classList.remove('hidden');
    resultsToolbar.classList.remove('hidden');
    if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');
    resultsList.innerHTML = '<div class="empty-state">'
      + '<div class="empty-emoji">⭐</div>'
      + '<div class="empty-title">No saved parks yet</div>'
      + '<div class="empty-sub">Tap the ★ on any park to save it here</div>'
      + '</div>';
    return;
  }

  if (currentResults.length === 0 && !hasSavedToShow) {
    resultsSection.classList.add('hidden');
    resultsToolbar.classList.add('hidden');
    if (fiveThingsStrip) fiveThingsStrip.classList.remove('hidden');
    var weatherBanner = document.getElementById('weather-banner');
    if (weatherBanner) weatherBanner.classList.add('hidden');
    resultsList.innerHTML = '';
    return;
  }

  // Saved tab with no live search: ensure UI chrome is visible
  if (currentResults.length === 0 && hasSavedToShow) {
    if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');
  }

  resultsSection.classList.remove('hidden');
  resultsToolbar.classList.remove('hidden');
  if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');
  // Ensure the map is initialized for the Saved tab too (so saved markers render)
  if (typeFilterNow === 'favorites' && !map && hasSavedToShow) {
    var savedParks = getAllSavedParks();
    if (savedParks.length > 0) {
      // Initialize map centered on the first saved park; markers will be added by addMarkersForSavedParks
      var first = savedParks[0];
      document.getElementById('map-section').classList.remove('hidden');
      map = L.map('map').setView([first.lat, first.lng], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      markerGroup.addTo(map);
    }
  }

  if (results.length === 0) {
    // We have results but the filter hid them all
    var typeFilter = getTypeFilter();
    var msgText = typeFilter === 'playground'
      ? 'No playgrounds in your current results.'
      : 'No parks in your current results.';
    var filterMsg = document.createElement('p');
    filterMsg.className = 'filter-message';
    filterMsg.textContent = msgText;
    resultsSection.insertBefore(filterMsg, resultsList);
    resultsList.innerHTML = '';
    return;
  }

  var html = '';
  results.forEach(function (r) {
    var typeClass = r.type === 'playground' ? 'playground' : 'park';
    var ratingHtml;
    if (r.rating) {
      ratingHtml = renderStars(r.rating) + ' <span class="rating-number">' + r.rating + '</span> (' + r.reviewCount.toLocaleString() + ' reviews)';
    } else {
      ratingHtml = 'No ratings yet';
    }

    var favClass = isFavorite(r.placeId) ? ' is-favorite' : '';
    var visitedClass = isVisited(r.placeId) ? ' is-visited' : '';
    var perfectClass = isPerfectPark(r.signals) ? ' is-perfect' : '';
    html += '<li class="result-card' + visitedClass + perfectClass + '" data-place-id="' + r.placeId + '">'
      + '<button class="favorite-btn' + favClass + '" data-place-id="' + r.placeId + '" aria-label="Save to favorites" title="Save to favorites">★</button>'
      + '<button class="visited-btn' + visitedClass + '" data-place-id="' + r.placeId + '" aria-label="Mark as visited" title="Mark as visited">✓</button>'
      + renderHeroPhoto(r)
      + '<div class="result-card-body">'
      + '<div class="result-card-header">'
      + '<span class="result-name">' + r.name + '</span>'
      + '<span class="result-type ' + typeClass + '">' + typeBadgeLabel(r.type) + '</span>'
      + '</div>'
      + '<span class="result-meta result-distance">' + renderTravelTime(r.distance) + '</span>'
      + '<span class="result-meta result-rating">' + ratingHtml + '</span>'
      + renderHours(r)
      + renderSignals(r.signals)
      + renderReviews(r)
      + renderNoteSection(r)
      + '<div class="result-links">'
      + '<a class="result-link result-link-directions" href="' + googleDirectionsUrl(r.placeId, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">\ud83d\ude97 Directions in Google Maps</a>'
      + '<a class="result-link-secondary" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
      + '<button type="button" class="result-link-share" data-place-id="' + r.placeId + '" title="Share this park">\ud83d\udd17 Share</button>'
      + '</div>'
      + '</div>'
      + '</li>';
  });

  resultsList.innerHTML = html;
}

// ---- Master render: filter → sort → render list + update markers ----
function applyFilterAndSort() {
  var typeFilter = getTypeFilter();
  var sortBy = getSortOrder();
  var activeSignals = getActiveSignalFilters();
  var hideVisited = getHideVisited();
  var filtered = filterByType(currentResults, typeFilter);
  filtered = filterBySignals(filtered, activeSignals);
  if (hideVisited) {
    filtered = filtered.filter(function (r) { return !isVisited(r.placeId); });
  }
  var sorted = sortResults(filtered, sortBy);
  renderResults(sorted);
  updateMarkerVisibility(typeFilter, activeSignals, hideVisited);
}

// ---- Helper: called once we have coordinates ----
function handleCoordinates(lat, lng) {
  lastLat = lat;
  lastLng = lng;

  showMessage('Searching for playgrounds and parks\u2026', 'info');
  showLoadingSkeletons();
  refreshHomeButton();

  var radius = getRadius();
  var thisRequest = ++requestId;

  fetch('/api/places?lat=' + lat + '&lng=' + lng + '&radius=' + radius)
    .then(function (response) {
      // Ignore stale responses
      if (thisRequest !== requestId) return;

      if (response.ok) {
        return response.json().then(function (data) {
          if (thisRequest !== requestId) return;
          if (data.results.length === 0) {
            showMessage('No playgrounds or parks found within ' + formatRadius(radius) + ' of this location.', 'info');
            showMap(lat, lng, []);
            currentResults = [];
            renderEmptyState(radius);
            return;
          }

          // Decide initial signals state per park: cached \u2192 use it; no reviews \u2192 defaults; else loading
          var needsSignals = []; // parks that will be sent to /api/signals
          data.results.forEach(function (r) {
            var cached = loadCachedSignals(r.placeId);
            if (cached) {
              r.signals = cached;
            } else if (!r.reviews || r.reviews.length === 0) {
              r.signals = defaultSignalsClient();
            } else {
              r.signals = loadingSignals();
              needsSignals.push({ placeId: r.placeId, name: r.name, reviews: r.reviews });
            }
          });

          showMessage('Found ' + data.results.length + ' playgrounds and parks nearby.', 'success');
          currentResults = data.results;
          showMap(lat, lng, data.results);
          applyFilterAndSort();

          // Phase 2: fetch signals for parks not in cache.
          // Chunk into parallel requests so closest parks get signals first
          // (results are already distance-sorted, so the first chunk = nearest).
          if (needsSignals.length > 0) {
            var SIGNAL_CHUNK_SIZE = 5;
            for (var i = 0; i < needsSignals.length; i += SIGNAL_CHUNK_SIZE) {
              fetchSignals(needsSignals.slice(i, i + SIGNAL_CHUNK_SIZE), thisRequest);
            }
          }

          // Also fetch current weather at the search location (in parallel)
          fetchWeather(lat, lng, thisRequest);
        });
      }
      if (response.status === 400) {
        showMessage('Something is wrong with the request. Please try again.', 'info');
      } else if (response.status === 500) {
        showMessage('The server is not set up correctly. Please try again later.', 'info');
      } else if (response.status === 502) {
        showMessage('We couldn\u2019t get results right now. Please try again in a moment.', 'info');
      } else {
        showMessage('Something went wrong. Please try again.', 'info');
      }
      currentResults = [];
      renderResults([]);
    })
    .catch(function () {
      if (thisRequest !== requestId) return;
      showMessage('Could not reach the server. Please check your connection and try again.', 'info');
      currentResults = [];
      renderResults([]);
    });
}

// ---- Fetch signals from /api/signals and merge into current results ----
function fetchSignals(parks, thisRequest) {
  fetch('/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parks: parks })
  })
    .then(function (response) {
      if (thisRequest !== requestId) return; // stale, ignore
      if (!response.ok) return null;
      return response.json();
    })
    .then(function (data) {
      if (thisRequest !== requestId) return;
      if (!data || !data.signals) {
        // Fall back to defaults for all parks that were loading
        parks.forEach(function (p) {
          updateAndCacheSignals(p.placeId, defaultSignalsClient(), false);
        });
        return;
      }
      // For each park we requested, use the returned signals if present, else default
      parks.forEach(function (p) {
        var sig = data.signals[p.placeId] || defaultSignalsClient();
        // Only cache when we got real signals (don't poison the cache with defaults from Gemini errors)
        var cacheIt = !!data.signals[p.placeId];
        updateAndCacheSignals(p.placeId, sig, cacheIt);
      });
    })
    .catch(function () {
      if (thisRequest !== requestId) return;
      // Network error \u2014 show defaults so loading state doesn't get stuck
      parks.forEach(function (p) {
        updateAndCacheSignals(p.placeId, defaultSignalsClient(), false);
      });
    });
}

// Helper: update currentResults + cache + DOM (card + map popup) for one park's signals
function updateAndCacheSignals(placeId, signals, shouldCache) {
  var record = null;
  for (var i = 0; i < currentResults.length; i++) {
    if (currentResults[i].placeId === placeId) {
      currentResults[i].signals = signals;
      record = currentResults[i];
      break;
    }
  }
  if (shouldCache) saveCachedSignals(placeId, signals);
  updateCardSignals(placeId, signals);
  // Refresh the map popup so loading "…" gets replaced with real values
  if (record) {
    var marker = markersByPlaceId[placeId];
    if (marker) marker.setPopupContent(buildPopupContent(record));
  }
}

// ---- Format radius for display ----
function formatRadius(val) {
  if (val === '0.5') return '\u00bd mile';
  if (val === '1') return '1 mile';
  return val + ' miles';
}

// ---- Event: sort change ----
sortSelect.addEventListener('change', function () {
  savePref('playgroundFinder.sort', sortSelect.value);
  if (currentResults.length === 0) return;
  applyFilterAndSort();
});

// ---- Event: signal filter chip click + hide-visited toggle ----
(function () {
  var signalFilter = document.getElementById('signal-filter');
  if (!signalFilter) return;
  // Restore active state from localStorage
  var active = getActiveSignalFilters();
  signalFilter.querySelectorAll('.signal-chip').forEach(function (chip) {
    var sig = chip.getAttribute('data-signal');
    if (sig && active.indexOf(sig) !== -1) chip.classList.add('active');
  });
  // Restore hide-visited toggle
  var hideVisitedChip = document.getElementById('hide-visited-toggle');
  if (hideVisitedChip && getHideVisited()) hideVisitedChip.classList.add('active');

  signalFilter.addEventListener('click', function (e) {
    var chip = e.target.closest('.signal-chip');
    if (!chip) return;
    // Hide-visited has its own handling
    if (chip.id === 'hide-visited-toggle') {
      var newState = !chip.classList.contains('active');
      chip.classList.toggle('active', newState);
      setHideVisited(newState);
      if (currentResults.length === 0) return;
      applyFilterAndSort();
      return;
    }
    var sig = chip.getAttribute('data-signal');
    if (!sig) return;
    var current = getActiveSignalFilters();
    var idx = current.indexOf(sig);
    if (idx === -1) {
      current.push(sig);
      chip.classList.add('active');
    } else {
      current.splice(idx, 1);
      chip.classList.remove('active');
    }
    setActiveSignalFilters(current);
    if (currentResults.length === 0) return;
    applyFilterAndSort();
  });
})();

// ---- Event: type filter change ----
typeFilterDiv.addEventListener('click', function (e) {
  var btn = e.target.closest('.type-btn');
  if (!btn) return;
  typeFilterDiv.querySelectorAll('.type-btn').forEach(function (b) {
    b.classList.remove('active');
  });
  btn.classList.add('active');
  var type = btn.getAttribute('data-type');
  savePref('playgroundFinder.typeFilter', type);
  // Saved tab can render with no current search (uses cross-search saved data)
  if (currentResults.length === 0 && type !== 'favorites') return;
  applyFilterAndSort();
});

// ---- Event: radius change → new API call ----
radiusSelect.addEventListener('change', function () {
  savePref('playgroundFinder.radius', radiusSelect.value);
  if (lastLat !== null && lastLng !== null) {
    handleCoordinates(lastLat, lastLng);
  }
});

// ---- Card hover → highlight matching marker on the map ----
(function () {
  var resultsList = document.getElementById('results-list');
  resultsList.addEventListener('mouseover', function (e) {
    var card = e.target.closest('.result-card');
    if (!card) return;
    var marker = markersByPlaceId[card.getAttribute('data-place-id')];
    if (marker && marker._icon) marker._icon.classList.add('marker-highlight');
  });
  resultsList.addEventListener('mouseout', function (e) {
    var card = e.target.closest('.result-card');
    if (!card) return;
    var marker = markersByPlaceId[card.getAttribute('data-place-id')];
    if (marker && marker._icon) marker._icon.classList.remove('marker-highlight');
  });
})();

// ---- Event: card click → pan map to marker ----
document.getElementById('results-list').addEventListener('click', function (e) {
  // Favorite button toggle
  var favBtn = e.target.closest('.favorite-btn');
  if (favBtn) {
    e.stopPropagation();
    var pid = favBtn.getAttribute('data-place-id');
    var nowFav = toggleFavorite(pid);
    favBtn.classList.toggle('is-favorite', nowFav);
    // If we're currently viewing the favorites filter, the unfavorited card should disappear
    if (getTypeFilter() === 'favorites' && !nowFav) {
      applyFilterAndSort();
    }
    return;
  }

  // Visited button toggle
  var visitedBtn = e.target.closest('.visited-btn');
  if (visitedBtn) {
    e.stopPropagation();
    var vpid = visitedBtn.getAttribute('data-place-id');
    var nowVisited = toggleVisited(vpid);
    visitedBtn.classList.toggle('is-visited', nowVisited);
    // Also toggle the parent card's class so styling can react
    var card = visitedBtn.closest('.result-card');
    if (card) card.classList.toggle('is-visited', nowVisited);
    return;
  }

  // Handle signal row expand/collapse
  var signalRow = e.target.closest('.signal-tappable');
  if (signalRow) {
    signalRow.classList.toggle('signal-expanded');
    return; // Don't also pan the map
  }

  // Reviews section expand/collapse
  var reviewsToggle = e.target.closest('.reviews-toggle');
  if (reviewsToggle) {
    e.stopPropagation();
    var section = reviewsToggle.closest('.reviews-section');
    if (section) {
      var isOpen = section.classList.toggle('reviews-expanded');
      reviewsToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    return;
  }

  // Per-card share button
  var shareBtn = e.target.closest('.result-link-share');
  if (shareBtn) {
    e.stopPropagation();
    var spid = shareBtn.getAttribute('data-place-id');
    var park = currentResults.find(function (r) { return r.placeId === spid; });
    if (park) shareUrl(buildShareUrlForPark(park), 'Park link');
    return;
  }

  // Note section toggle (show/hide the textarea)
  var noteToggle = e.target.closest('.note-toggle');
  if (noteToggle) {
    e.stopPropagation();
    var nSection = noteToggle.closest('.note-section');
    var content = nSection && nSection.querySelector('.note-content');
    if (content) {
      var open = content.style.display !== 'none';
      content.style.display = open ? 'none' : 'block';
      noteToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      nSection.classList.toggle('note-expanded', !open);
    }
    return;
  }

  var card = e.target.closest('.result-card');
  if (!card) return;
  if (e.target.closest('a')) return; // any link inside a card opens in a new tab
  var placeId = card.getAttribute('data-place-id');
  var marker = markersByPlaceId[placeId];
  if (marker && map) {
    map.panTo(marker.getLatLng());
    marker.openPopup();
  }
});

// ---- "Use My Location" button ----
geolocateBtn.addEventListener('click', function () {
  if (!navigator.geolocation) {
    showMessage(
      'Your browser does not support location services. Please enter an address instead.',
      'info'
    );
    return;
  }

  showMessage('Checking your location\u2026', 'info');

  navigator.geolocation.getCurrentPosition(
    function (position) {
      addressInput.value = CURRENT_LOCATION_LABEL;
      handleCoordinates(position.coords.latitude, position.coords.longitude);
    },
    function () {
      showMessage(
        'We couldn\u2019t get your location. Please enter an address below instead.',
        'info'
      );
    }
  );
});

// ---- Focus the input \u2192 select all so typing replaces the current label ----
addressInput.addEventListener('focus', function () {
  addressInput.select();
  // If input is empty (or just whitespace), show recent searches as a quick-pick
  var current = addressInput.value.trim();
  if (current.length === 0) {
    showRecentsInDropdown();
  }
});

// Show recent searches in the same dropdown used for autocomplete
function showRecentsInDropdown() {
  var recents = getRecents();
  if (recents.length === 0) return;
  var html = '<div class="suggestion-header">Recent searches</div>';
  recents.forEach(function (r) {
    html += '<div class="suggestion-item" role="option"'
      + ' data-lat="' + escapeHtml(r.lat) + '"'
      + ' data-lng="' + escapeHtml(r.lng) + '"'
      + ' data-label="' + escapeHtml(r.label) + '">'
      + '<span class="suggestion-recent-icon">\ud83d\udd50</span> '
      + escapeHtml(r.label)
      + '</div>';
  });
  addressSuggestions.innerHTML = html;
  addressSuggestions.classList.remove('hidden');
}

// ---- Home shortcut button ----
// State machine:
//   - no home, no current search: button hidden
//   - no home, current search exists: "🏠 Save as home" (sets current as home)
//   - home set, currently AT home: "🏠 Replace home" (saves current as new home)
//   - home set, NOT at home: "🏠 Take me home" (loads home search)
function refreshHomeButton() {
  var btn = document.getElementById('home-btn');
  if (!btn) return;
  var home = getHome();
  var hasSearch = lastLat !== null && lastLng !== null;
  if (!home && !hasSearch) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  if (!home) {
    btn.textContent = '🏠 Save as home';
    btn.setAttribute('data-mode', 'save');
    return;
  }
  // Home is set. Are we currently at home (within ~50m)?
  var atHome = hasSearch && distanceBetween(lastLat, lastLng, home.lat, home.lng) < 0.05;
  if (atHome) {
    btn.textContent = '🏠 Replace home';
    btn.setAttribute('data-mode', 'replace');
  } else {
    btn.textContent = '🏠 Take me home';
    btn.setAttribute('data-mode', 'go');
  }
}

function distanceBetween(lat1, lng1, lat2, lng2) {
  // Same as haversine in api/places.js — duplicated client-side, miles
  var R = 3958.8;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

document.getElementById('home-btn').addEventListener('click', function () {
  var btn = this;
  var mode = btn.getAttribute('data-mode');
  if (mode === 'save' || mode === 'replace') {
    if (lastLat === null || lastLng === null) return;
    setHome({ lat: lastLat, lng: lastLng, label: addressInput.value || 'Home' });
    refreshHomeButton();
    showMessage('Saved as your home location.', 'success');
  } else if (mode === 'go') {
    var home = getHome();
    if (!home) return;
    addressInput.value = home.label || 'Home';
    handleCoordinates(home.lat, home.lng);
  }
});

// ---- Note auto-save (debounced) ----
(function () {
  var noteSaveTimers = {};
  document.getElementById('results-list').addEventListener('input', function (e) {
    var ta = e.target.closest('.note-input');
    if (!ta) return;
    var pid = ta.getAttribute('data-place-id');
    var status = document.querySelector('.note-status[data-place-id="' + pid + '"]');
    if (status) status.textContent = 'Saving…';
    clearTimeout(noteSaveTimers[pid]);
    noteSaveTimers[pid] = setTimeout(function () {
      setNote(pid, ta.value);
      // Update toggle label to reflect "has note" state
      var section = ta.closest('.note-section');
      if (section) {
        var hasContent = ta.value && ta.value.trim().length > 0;
        section.classList.toggle('has-note', hasContent);
        var toggle = section.querySelector('.note-toggle');
        if (toggle) {
          toggle.firstChild.textContent = hasContent ? '📝 Your note ' : '📝 Add a note ';
        }
      }
      if (status) {
        status.textContent = 'Saved ✓';
        setTimeout(function () { if (status) status.textContent = ''; }, 1200);
      }
    }, 600);
  });
})();

// ---- Address autocomplete (Nominatim) ----
var addressSuggestions = document.getElementById('address-suggestions');
var suggestionsDebounce = null;
var suggestionsRequestId = 0;

function hideSuggestions() {
  addressSuggestions.classList.add('hidden');
  addressSuggestions.innerHTML = '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fetchSuggestions(query) {
  var thisRequest = ++suggestionsRequestId;
  var url = 'https://nominatim.openstreetmap.org/search'
    + '?q=' + encodeURIComponent(query)
    + '&format=json'
    + '&countrycodes=us,ca'
    + '&limit=5'
    + '&addressdetails=0';
  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (thisRequest !== suggestionsRequestId) return; // stale
      renderSuggestions(data);
    })
    .catch(function () { /* silently swallow \u2014 no need to spam errors for typing */ });
}

function renderSuggestions(items) {
  if (!Array.isArray(items) || items.length === 0) {
    hideSuggestions();
    return;
  }
  var html = '';
  items.forEach(function (item) {
    var label = item.display_name || '';
    html += '<div class="suggestion-item" role="option"'
      + ' data-lat="' + escapeHtml(item.lat) + '"'
      + ' data-lng="' + escapeHtml(item.lon) + '"'
      + ' data-label="' + escapeHtml(label) + '">'
      + escapeHtml(label)
      + '</div>';
  });
  addressSuggestions.innerHTML = html;
  addressSuggestions.classList.remove('hidden');
}

// Input typing \u2192 debounced fetch
addressInput.addEventListener('input', function () {
  var q = addressInput.value.trim();
  if (q.length < 3 || q === CURRENT_LOCATION_LABEL || q === MAP_AREA_LABEL) {
    hideSuggestions();
    return;
  }
  clearTimeout(suggestionsDebounce);
  suggestionsDebounce = setTimeout(function () {
    fetchSuggestions(q);
  }, 300);
});

// Click a suggestion \u2192 fill input, hide dropdown, run search
addressSuggestions.addEventListener('click', function (e) {
  var item = e.target.closest('.suggestion-item');
  if (!item) return;
  var lat = parseFloat(item.getAttribute('data-lat'));
  var lng = parseFloat(item.getAttribute('data-lng'));
  var label = item.getAttribute('data-label');
  if (isNaN(lat) || isNaN(lng)) return;
  addressInput.value = label;
  hideSuggestions();
  pushRecent(label, lat, lng);
  handleCoordinates(lat, lng);
});

// Hide the dropdown when clicking outside the search area
document.addEventListener('click', function (e) {
  if (!e.target.closest('.search-wrap')) {
    hideSuggestions();
  }
});

// Hide when input loses focus (delay so a suggestion click registers first)
addressInput.addEventListener('blur', function () {
  setTimeout(hideSuggestions, 150);
});

// Escape key closes the dropdown
addressInput.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') hideSuggestions();
});

// ---- "Search this area" \u2192 re-run search at the current map center ----
searchHereBtn.addEventListener('click', function () {
  if (!map) return;
  var center = map.getCenter();
  addressInput.value = MAP_AREA_LABEL;
  handleCoordinates(center.lat, center.lng);
});

// ---- Address form submission ----
addressForm.addEventListener('submit', function (e) {
  e.preventDefault();

  var address = addressInput.value.trim();
  if (!address) {
    showMessage('Please type an address, or tap the pin to use your current location.', 'info');
    return;
  }

  // If the input still contains the literal "Current location" label,
  // re-trigger geolocation instead of geocoding the text.
  if (address === CURRENT_LOCATION_LABEL) {
    geolocateBtn.click();
    return;
  }

  // If the input still contains the literal "Map area" label,
  // re-run the search at the current map center.
  if (address === MAP_AREA_LABEL && map) {
    searchHereBtn.click();
    return;
  }

  showMessage('Looking up \u201c' + address + '\u201d\u2026', 'info');

  var url = 'https://nominatim.openstreetmap.org/search'
    + '?q=' + encodeURIComponent(address)
    + '&format=json'
    + '&countrycodes=us,ca'
    + '&limit=1';

  fetch(url, {
    headers: { 'Accept': 'application/json' }
  })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (data.length === 0) {
        showMessage(
          'We couldn\u2019t find that address. Please try a different one.',
          'info'
        );
        return;
      }
      var resolvedLat = parseFloat(data[0].lat);
      var resolvedLng = parseFloat(data[0].lon);
      pushRecent(address, resolvedLat, resolvedLng);
      handleCoordinates(resolvedLat, resolvedLng);
    })
    .catch(function () {
      showMessage(
        'Something went wrong looking up that address. Please try again.',
        'info'
      );
    });
});


// ---- "Show parks near me" landing CTA — same as clicking the pin button ----
(function () {
  var nearMeCta = document.getElementById('near-me-cta');
  if (!nearMeCta) return;
  nearMeCta.addEventListener('click', function () {
    geolocateBtn.click();
    // Hide the CTA after clicking; landing CTA only useful when no search has happened
    nearMeCta.classList.add('hidden');
  });
})();

// ---- Sharing: URL params ----
// Supported shapes:
//   /?lat=42.3&lng=-71.0&radius=1            → load that exact search
//   /?park=PLACE_ID&lat=42.3&lng=-71.0       → search around lat/lng, then highlight that park
//   /?address=Boston+MA                       → geocode & search

function buildShareUrlForSearch(lat, lng, radius) {
  var u = new URL(window.location.origin + window.location.pathname);
  u.searchParams.set('lat', lat.toFixed(5));
  u.searchParams.set('lng', lng.toFixed(5));
  if (radius) u.searchParams.set('radius', radius);
  return u.toString();
}

function buildShareUrlForPark(park) {
  var u = new URL(window.location.origin + window.location.pathname);
  u.searchParams.set('park', park.placeId);
  u.searchParams.set('lat', park.lat.toFixed(5));
  u.searchParams.set('lng', park.lng.toFixed(5));
  return u.toString();
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: hidden textarea
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  return Promise.resolve();
}

function shareUrl(url, label) {
  // Try the native share sheet first (mobile), fall back to copy-to-clipboard
  if (navigator.share) {
    navigator.share({ title: 'Playground Finder', url: url }).catch(function () { /* user cancelled */ });
  } else {
    copyToClipboard(url).then(function () {
      showMessage((label || 'Link') + ' copied to clipboard!', 'success');
    });
  }
}

// On page load, parse the URL and trigger the right action
function handleSharedUrl() {
  var params = new URLSearchParams(window.location.search);
  var lat = parseFloat(params.get('lat'));
  var lng = parseFloat(params.get('lng'));
  var radius = params.get('radius');
  var park = params.get('park');
  var address = params.get('address');

  if (!isNaN(lat) && !isNaN(lng)) {
    if (radius) {
      var allowed = ['0.5', '1', '2', '5'];
      if (allowed.indexOf(radius) !== -1) {
        radiusSelect.value = radius;
        savePref('playgroundFinder.radius', radius);
      }
    }
    addressInput.value = park ? 'Shared park' : 'Shared location';
    handleCoordinates(lat, lng);
    if (park) {
      // Once results render, scroll to the shared park's card
      var attempts = 0;
      var trySelect = function () {
        var card = document.querySelector('.result-card[data-place-id="' + park + '"]');
        if (card) {
          scrollToCard(park);
        } else if (attempts++ < 20) {
          setTimeout(trySelect, 300);
        }
      };
      setTimeout(trySelect, 1500);
    }
    return;
  }

  if (address) {
    addressInput.value = address;
    addressForm.dispatchEvent(new Event('submit'));
  }
}

// ---- "Share search" toolbar button ----
(function () {
  var btn = document.getElementById('share-view-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (lastLat === null || lastLng === null) return;
    shareUrl(buildShareUrlForSearch(lastLat, lastLng, getRadius()), 'Search link');
  });
})();

// ---- Mobile: hide the sticky toolbar when scrolling down, reveal when scrolling up ----
(function () {
  if (window.matchMedia('(min-width: 768px)').matches) return; // desktop: stay sticky always
  var toolbar = document.getElementById('results-toolbar');
  if (!toolbar) return;
  var lastY = window.scrollY;
  var SCROLL_THRESHOLD = 8;
  var TOP_BUFFER = 120; // never hide while user is near the top of the page

  window.addEventListener('scroll', function () {
    var currentY = window.scrollY;
    var diff = currentY - lastY;
    if (Math.abs(diff) < SCROLL_THRESHOLD) return;
    if (diff > 0 && currentY > TOP_BUFFER) {
      toolbar.classList.add('toolbar-hidden');
    } else if (diff < 0) {
      toolbar.classList.remove('toolbar-hidden');
    }
    lastY = currentY;
  }, { passive: true });
})();

// ---- Initial: handle URL share params on page load ----
handleSharedUrl();

// ---- PWA: register the service worker (offline support + add to home screen) ----
if ('serviceWorker' in navigator) {
  // Wait until after the load event so SW registration doesn't fight for the network with first paint
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* registration failed — silently OK */ });
  });
}
