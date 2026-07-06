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
// Set active type button (search across all .type-btn buttons including the standalone Saved)
document.querySelectorAll('.type-btn').forEach(function (btn) {
  btn.classList.toggle('active', btn.getAttribute('data-type') === savedType);
});

// ---- State ----
var map = null;
var markerGroup = null;          // initialized after Leaflet finishes lazy-loading
var markersByPlaceId = {};
var leafletLoadPromise = null;    // memoized Promise so we only load Leaflet once
var currentResults = [];
var lastLat = null;
var lastLng = null;
// Origin for the "Directions" link. When the user searched by typed address,
// autocomplete pick, saved home, "Search this area" map-center, or a shared
// link, this is set to {lat, lng} so directions start from where they're
// *planning* to be, not their live GPS. When they used "Show parks near me"
// (geolocation), this is null so Google Maps falls back to live "Your location".
var searchOrigin = null;
var requestId = 0; // for ignoring stale responses
// Timestamp of the last photo-carousel swipe. Some touch browsers fire a
// synthetic click right after a swipe; the card-click handler checks this to
// avoid panning the map when the user only meant to flip a photo.
var lastCarouselSwipeAt = 0;
var CURRENT_LOCATION_LABEL = 'Current location';
var MAP_AREA_LABEL = 'Map area';
var searchHereBtn = document.getElementById('search-here-btn');

// ---- Helper: escape user/API content for safe insertion into HTML strings ----
// Used everywhere DOM is built via innerHTML with strings that originate from
// Google Places (park names, reviews) or from URL params/localStorage (shared parks).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Helper: show a status message ----
// U8: success toasts ("Found 12 parks", "Link copied!") auto-dismiss after a
// few seconds — they've done their job and just become clutter. Info and error
// messages stick around until replaced, since the user may need to act on them.
var messageDismissTimer = null;
function showMessage(text, type) {
  var msg = document.getElementById('status-message');
  if (!msg) {
    msg = document.createElement('p');
    msg.id = 'status-message';
    searchSection.appendChild(msg);
  }
  msg.textContent = text;
  msg.className = 'status-message ' + type;
  // Cancel any pending auto-dismiss so a new message doesn't vanish early
  if (messageDismissTimer) {
    clearTimeout(messageDismissTimer);
    messageDismissTimer = null;
  }
  if (type === 'success') {
    messageDismissTimer = setTimeout(function () {
      msg.textContent = '';
      msg.classList.add('hidden');
    }, 4000);
  } else {
    msg.classList.remove('hidden');
  }
}

// ---- Helper: get current UI state ----
function getTypeFilter() {
  // Search across all .type-btn buttons (the type pill + the standalone Saved button)
  var active = document.querySelector('.type-btn.active');
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

// ---- "Hide visited" toggle (V3 Feature 1) ----
// When on, parks the user has already marked ✓ visited disappear from the
// results list AND the map. Persisted across reloads so parents who want a
// "new parks only" view get it by default once they set it.
var HIDE_VISITED_KEY = 'playgroundFinder.hideVisited';
function getHideVisited() {
  try { return localStorage.getItem(HIDE_VISITED_KEY) === 'true'; }
  catch (e) { return false; }
}
function setHideVisited(bool) {
  try { localStorage.setItem(HIDE_VISITED_KEY, bool ? 'true' : 'false'); }
  catch (e) { /* ignore */ }
}

// ---- "Drive time" filter (V3 Feature 2) ----
// Uses straight-line distance × 1.5 (city-grid fudge) / 25 mph (suburban avg)
// to estimate minutes. Approximate but no API call required.
var MAX_DRIVE_KEY = 'playgroundFinder.maxDriveMinutes';
function getMaxDriveMinutes() {
  try {
    var raw = localStorage.getItem(MAX_DRIVE_KEY);
    if (!raw) return null;
    var n = Number(raw);
    return isNaN(n) || n <= 0 ? null : n;
  } catch (e) { return null; }
}
function setMaxDriveMinutes(val) {
  try {
    if (val == null || val === '') localStorage.removeItem(MAX_DRIVE_KEY);
    else localStorage.setItem(MAX_DRIVE_KEY, String(val));
  } catch (e) { /* ignore */ }
}
// Estimate drive-time minutes from origin (lastLat,lastLng) to a park.
function estimateDriveMinutes(park) {
  if (lastLat == null || lastLng == null) return null;
  var meters = haversineMeters(lastLat, lastLng, park.lat, park.lng);
  return (meters * 0.000621371 * 1.5 / 25) * 60;
}


// ---- Personal notes per park (localStorage) ----
var NOTE_PREFIX = 'playgroundFinder.note.';

function getNote(placeId) {
  try { return localStorage.getItem(NOTE_PREFIX + placeId) || ''; }
  catch (e) { return ''; }
}

// FIX E3: cap notes at 2000 chars so a runaway paste can't blow up
// localStorage. Returns true on success, false on failure (storage full /
// disabled) so the UI can surface a visible "couldn't save" status instead
// of silently failing.
function setNote(placeId, text) {
  try {
    if (text && text.length > 2000) text = text.slice(0, 2000);
    if (text && text.trim()) localStorage.setItem(NOTE_PREFIX + placeId, text);
    else localStorage.removeItem(NOTE_PREFIX + placeId);
    return true;
  } catch (e) { return false; }
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

// U4: these use sessionStorage (NOT localStorage) on purpose. Chips you tapped
// last month silently filtering a fresh search is an ambush — "why are there
// only 2 parks?!" — so signal chips reset on every new visit. sessionStorage
// still keeps them alive across same-tab navigation (e.g. following a link
// and coming back). Hide-visited and drive-time stay in localStorage because
// those are deliberate standing preferences, not quick one-off filters.
function getActiveSignalFilters() {
  try {
    var raw = sessionStorage.getItem(SIGNAL_FILTERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function setActiveSignalFilters(arr) {
  try { sessionStorage.setItem(SIGNAL_FILTERS_KEY, JSON.stringify(arr)); }
  catch (e) { /* ignore */ }
}

// V9 F2: the "👶 Toddler-ready" preset chip turns on fenced + bathrooms +
// toddler in one tap. This list is the single source of truth for which
// three signals the preset means — the click handler and the sync helper
// below both read from it, so they can never disagree.
var TODDLER_PRESET_SIGNALS = ['fenced', 'bathrooms', 'toddler'];

// V9 F2: keep the preset chip's highlight honest — it lights up ONLY while
// all three of its signals are active, no matter how they got that way
// (tapping the preset, tapping chips one by one, or clearing filters).
// Called from every path that changes signal-chip state.
function syncPresetChip() {
  var preset = document.querySelector('#signal-filter .preset-chip');
  if (!preset) return;
  var active = getActiveSignalFilters();
  var allOn = TODDLER_PRESET_SIGNALS.every(function (sig) {
    return active.indexOf(sig) !== -1;
  });
  preset.classList.toggle('active', allOn);
}

// AND filter: a park must satisfy EVERY active signal chip to pass.
// "fenced", "shade", "bathrooms", "tennis" require value === 'yes'.
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
      if (sig === 'tennis')    return r.signals.tennisCourts && r.signals.tennisCourts.value === 'yes';
      // V6 F1: "Open now" comes straight from Google's hours data on the
      // result itself (not from the signals object). null = unknown → hide,
      // because the user explicitly asked for parks that are open.
      if (sig === 'open')      return r.openNow === true;
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

// Count how many of the 7 signal dimensions are populated (non-N/A and non-loading)
function signalRichness(signals) {
  if (!signals) return 0;
  var dims = ['fenced', 'shade', 'bathrooms', 'ageSuitability', 'parking', 'tennisCourts', 'changingTable'];
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

// Google Maps directions URL — opens turn-by-turn navigation to that park.
//
// IMPORTANT: pass the park's NAME (not lat/lng) as `destination`, with
// `destination_place_id` as a disambiguator. The iOS Google Maps app
// otherwise renders raw coordinates as an unnamed "Dropped Pin" and ignores
// the place_id. Same idea for origin: when we have the address the user
// typed, pass that text so Google Maps shows e.g. "Brookline, MA" instead
// of "Dropped Pin". Falls back to coords if we only have coords.
function googleDirectionsUrl(placeId, name, lat, lng) {
  var url = 'https://www.google.com/maps/dir/?api=1'
    + '&destination=' + encodeURIComponent(name || (lat + ',' + lng))
    + '&destination_place_id=' + encodeURIComponent(placeId);
  if (searchOrigin) {
    if (searchOrigin.label) {
      url += '&origin=' + encodeURIComponent(searchOrigin.label);
    } else {
      url += '&origin=' + searchOrigin.lat + ',' + searchOrigin.lng;
    }
  }
  return url;
}

// ---- Yelp search URL ----
function yelpSearchUrl(name, lat, lng) {
  // Filter by Yelp's "parks" category so we don't surface random restaurants/cafes
  // that share the park's name. Parameter `cflt=parks` constrains results.
  return 'https://www.yelp.com/search'
    + '?find_desc=' + encodeURIComponent(name)
    + '&find_loc=' + lat + ',' + lng
    + '&cflt=parks';
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
        + 'Photo by <a href="' + escapeHtml(result.photoAttribution.url)
        + '" target="_blank" rel="noopener noreferrer">'
        + escapeHtml(result.photoAttribution.name) + '</a>'
        + '</div>';
    } else {
      attributionHtml = '<div class="card-hero-attribution">'
        + 'Photo by ' + escapeHtml(result.photoAttribution.name)
        + '</div>';
    }
  }

  // V7 F8: if this park has extra photos available (we only have their free
  // "names" so far — the actual images cost money to fetch), show a small
  // "📷 +N" badge. Tapping it loads the extras and turns the hero into a
  // mini carousel. Shared-link parks have no extraPhotoNames, so the
  // Array.isArray check quietly skips the badge for them.
  var badgeHtml = '';
  if (Array.isArray(result.extraPhotoNames) && result.extraPhotoNames.length > 0) {
    badgeHtml = '<button type="button" class="photo-more-badge" '
      + 'data-place-id="' + escapeHtml(result.placeId) + '" '
      + 'aria-label="See more photos">📷 +' + result.extraPhotoNames.length + '</button>';
  }

  // FIX D1: no inline onerror (CSP blocks it anyway). Instead the .card-hero-image
  // container has a fixed 16/9 aspect-ratio + cream background, so if the photo
  // 404s the layout doesn't shift — you just see a clean cream box.
  return '<div class="card-hero">'
    + '<img class="card-hero-image" src="' + escapeHtml(result.photoUrl)
    + '" alt="Photo of ' + escapeHtml(result.name)
    + '" loading="lazy">'
    + badgeHtml
    + attributionHtml
    + '</div>';
}

// ---- Helper: switch a card's hero photo into carousel mode ----
// Called once the extra photo URLs are loaded (park._extraPhotoUrls).
// Adds ‹ › arrow buttons and a row of dots over the photo; flipping through
// slides just swaps the img src, so it's instant and costs nothing.
// Note: applyFilterAndSort re-renders cards from scratch, which resets a card
// back to the plain hero + badge — but _extraPhotoUrls stays on the result
// object, so re-opening the carousel is instant and doesn't re-bill us.
function enterCarouselMode(card, park) {
  var hero = card.querySelector('.card-hero');
  var img = hero && hero.querySelector('.card-hero-image');
  if (!hero || !img || !Array.isArray(park._extraPhotoUrls)) return;
  if (hero.querySelector('.photo-nav')) return; // already in carousel mode

  // The "+N" badge has done its job — remove it.
  var badge = hero.querySelector('.photo-more-badge');
  if (badge) badge.remove();

  // Start on slide 0 (the photo the card was already showing).
  hero.setAttribute('data-photo-index', '0');
  img.src = park._extraPhotoUrls[0];

  // One dot per slide; the current slide's dot gets .active.
  var dotsHtml = '';
  for (var i = 0; i < park._extraPhotoUrls.length; i++) {
    dotsHtml += '<span' + (i === 0 ? ' class="active"' : '') + '>•</span>';
  }
  hero.insertAdjacentHTML('beforeend',
    '<button type="button" class="photo-nav photo-nav-prev" data-dir="-1" aria-label="Previous photo">‹</button>'
    + '<button type="button" class="photo-nav photo-nav-next" data-dir="1" aria-label="Next photo">›</button>'
    + '<div class="photo-dots">' + dotsHtml + '</div>');
}

// ---- Helper: advance a card's carousel by a direction (+1 next, -1 prev) ----
// Shared by the ‹ › arrow buttons (desktop) and the swipe gesture (touch), so
// the two input methods can never drift out of sync. Wraps around at both ends.
function moveCarousel(hero, park, dir) {
  if (!hero || !park || !Array.isArray(park._extraPhotoUrls)) return;
  var count = park._extraPhotoUrls.length;
  if (count < 2) return;
  var idx = parseInt(hero.getAttribute('data-photo-index'), 10) || 0;
  idx = (idx + dir + count) % count; // wraps around at both ends
  hero.setAttribute('data-photo-index', String(idx));
  var img = hero.querySelector('.card-hero-image');
  if (img) img.src = park._extraPhotoUrls[idx];
  // Light up the dot for the slide we're now on.
  var dots = hero.querySelectorAll('.photo-dots span');
  for (var i = 0; i < dots.length; i++) {
    dots[i].classList.toggle('active', i === idx);
  }
}

// ---- Helper: build hero photo HTML for a popup ----
// Smaller version of the card hero, or empty string if no photo.
function renderPopupPhoto(result) {
  if (!result.photoUrl) return '';

  // FIX D1: no inline onerror — CSP would block it anyway. The container's
  // CSS aspect-ratio + cream background gracefully handles a missing image.
  return '<div class="popup-hero">'
    + '<img class="popup-hero-image" src="' + escapeHtml(result.photoUrl)
    + '" alt="Photo of ' + escapeHtml(result.name)
    + '">'
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

// ---- "Ask about this park" (Gemini Q&A over this park's reviews) ----
// Renders a small question box inside the card's Details section, right above
// "Read reviews". Only shows when we actually HAVE enough reviews to ground
// an answer (2+): with fewer, Gemini would mostly answer "the reviews don't
// mention it", which just feels broken. Saved-tab parks have their reviews
// stripped before storage (see sanitizeParkForStorage), so they naturally
// have 0 and never get the box — but we guard here anyway so the rule holds
// no matter where the park object came from.
function renderAskSection(result) {
  if (!Array.isArray(result.reviews) || result.reviews.length < 2) return '';
  // SECURITY: placeId is escapeHtml'd — same rule as everywhere else it
  // lands inside an HTML attribute.
  return '<div class="ask-section" data-place-id="' + escapeHtml(result.placeId) + '">'
    + '<div class="ask-heading">💬 Ask about this park</div>'
    + '<div class="ask-presets">'
    + '<button type="button" class="ask-preset">Baby swings?</button>'
    + '<button type="button" class="ask-preset">Muddy after rain?</button>'
    + '<button type="button" class="ask-preset">Busy on weekends?</button>'
    + '</div>'
    + '<div class="ask-input-row">'
    + '<input type="text" class="ask-input" maxlength="200" placeholder="Ask anything — answers come from real reviews…">'
    + '<button type="button" class="ask-btn">Ask</button>'
    + '</div>'
    + '<div class="ask-answer hidden"></div>'
    + '</div>';
}

function renderReviews(result) {
  if (!result.reviews || result.reviews.length === 0) return '';
  var count = result.reviews.length;
  // V6 F5: reviews are now {text, publishTime} objects from the API, but
  // older saved/shared parks may still carry plain strings — handle both.
  var items = result.reviews.map(function (rv) {
    var text = typeof rv === 'string' ? rv : (rv && rv.text) || '';
    return '<div class="review-snippet">"' + escapeHtml(truncateReview(text, 220)) + '"</div>';
  }).join('');
  return '<div class="reviews-section">'
    + '<button type="button" class="reviews-toggle" aria-expanded="false">'
    + '📝 Read reviews (' + count + ') <span class="reviews-arrow">▶</span>'
    + '</button>'
    + '<div class="reviews-content">' + items + '</div>'
    + '</div>';
}

// ---- OpenStreetMap-verified signals (cached per placeId) ----
// We fetch OSM data once per search area, match each Google park to the closest
// OSM-tagged park within ~60 meters, and override Gemini-extracted signals with
// the OSM-verified ones (marked source: 'osm' so the UI can show them in green).
var OSM_CACHE_PREFIX = 'playgroundFinder.osm.';
var OSM_MATCH_RADIUS_METERS = 60;

function loadCachedOsm(placeId) {
  try {
    var raw = localStorage.getItem(OSM_CACHE_PREFIX + placeId);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  } catch (e) { return undefined; }
}

function saveCachedOsm(placeId, signalsOrEmpty) {
  try { localStorage.setItem(OSM_CACHE_PREFIX + placeId, JSON.stringify(signalsOrEmpty || {})); }
  catch (e) { /* ignore */ }
}

function fetchOsmAndMerge(lat, lng, radius, thisRequest) {
  setOsmStatus(true);
  fetch('/api/osm?lat=' + lat + '&lng=' + lng + '&radius=' + radius)
    .then(function (response) {
      if (thisRequest !== requestId) return;
      if (!response.ok) return null;
      return response.json();
    })
    .then(function (data) {
      if (thisRequest !== requestId) return;
      if (!data || !Array.isArray(data.parks)) return;
      currentResults.forEach(function (gp) {
        var match = findClosestOsmPark(gp.lat, gp.lng, data.parks);
        // V6 F4: copy OSM's amenity flags (splash pad etc.) onto the Google
        // result and refresh just that card's badge row.
        if (match && match.amenities) {
          gp.amenities = match.amenities;
          updateCardAmenities(gp.placeId, gp.amenities);
        }
        if (match && Object.keys(match.signals).length > 0) {
          mergeOsmSignals(gp.placeId, match.signals);
        } else {
          // Cache an empty marker so we don't keep retrying
          saveCachedOsm(gp.placeId, {});
        }
      });
    })
    .catch(function () { /* OSM is supplementary — fail silently */ })
    .then(function () { if (thisRequest === requestId) setOsmStatus(false); });
}

function setOsmStatus(verifying) {
  var el = document.getElementById('osm-status');
  if (!el) return;
  el.classList.toggle('hidden', !verifying);
}

function findClosestOsmPark(lat, lng, osmParks) {
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < osmParks.length; i++) {
    var d = haversineMeters(lat, lng, osmParks[i].lat, osmParks[i].lng);
    if (d < bestDist && d <= OSM_MATCH_RADIUS_METERS) {
      bestDist = d;
      best = osmParks[i];
    }
  }
  return best;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Merge OSM signals into a park's existing signals. OSM wins per dimension —
// EXCEPT over source:'google'. Both are verified, but Google's structured
// answer is first-party data about the exact place, so it outranks OSM's
// nearby-tag inference.
function mergeOsmSignals(placeId, osmSignals) {
  saveCachedOsm(placeId, osmSignals);
  var park = null;
  for (var i = 0; i < currentResults.length; i++) {
    if (currentResults[i].placeId === placeId) {
      park = currentResults[i];
      break;
    }
  }
  if (!park || !park.signals) return;
  var changed = false;
  ['fenced', 'shade', 'bathrooms', 'ageSuitability', 'parking', 'tennisCourts', 'changingTable'].forEach(function (dim) {
    if (park.signals[dim] && park.signals[dim].source === 'google') return;
    if (osmSignals[dim] && osmSignals[dim].value) {
      park.signals[dim] = {
        value: osmSignals[dim].value,
        summary: (park.signals[dim] && park.signals[dim].summary) || null,
        source: 'osm'
      };
      changed = true;
    }
  });
  if (changed) {
    updateCardSignals(placeId, park.signals);
    var marker = markersByPlaceId[placeId];
    if (marker) marker.setPopupContent(buildPopupContent(park));
  }
}

// ---- Weather (Open-Meteo, no API key) ----
function weatherCodeToEmoji(code) {
  if (code === 0) return ['☀️', 'Clear'];
  if (code === 1 || code === 2) return ['🌤️', 'Mostly clear'];
  if (code === 3) return ['☁️', 'Cloudy'];
  if (code === 45 || code === 48) return ['🌁', 'Foggy'];
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
    + '&temperature_unit=fahrenheit'
    // V6 F6: today's hour-by-hour rain chances, in the search location's
    // own timezone, so we can warn "rain ~2 PM" before you leave the house.
    + '&hourly=precipitation_probability&forecast_days=1&timezone=auto';
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
      // V9 F1: compute the rain outlook ONCE and reuse it — the same data
      // feeds both the "rain ~2 PM" text and the suggestion chip decision.
      var outlook = computeRainOutlook(data.hourly);
      banner.innerHTML = '<span class="weather-emoji">' + ec[0] + '</span>'
        + '<span class="weather-temp">' + temp + '°F</span>'
        + (ec[1] ? '<span class="weather-label">· ' + ec[1] + '</span>' : '')
        // V6 F6: one short rain heads-up ("rain ~2 PM" / "clearing by 3 PM" /
        // "rain likely all day"), or nothing if the rest of today looks dry.
        + outlook.html
        // V9 F1: at most ONE tappable suggestion ("hot → shade" beats
        // "rain → open now"), or nothing when the weather gives no reason.
        + buildWeatherSuggestChip(data.current.temperature_2m, outlook.firstRainyTime);
      banner.classList.remove('hidden');
    })
    .catch(function () { /* silent — weather is a nice-to-have */ });
}

// V6 F6: turn Open-Meteo's hourly rain probabilities into one short phrase.
// V9 F1: this is now a thin wrapper — computeRainOutlook below does the real
// work — kept so anything that only wants the text keeps working unchanged.
function buildRainOutlook(hourly) {
  return computeRainOutlook(hourly).html;
}

// V9 F1: the rain-outlook brain. Returns an object with TWO things:
//   html           — the '<span>· 🌧 rain ~2 PM</span>' snippet (or '' if dry)
//   firstRainyTime — a Date for the first rainy hour left today (or null),
//                    which fetchWeather uses to decide whether to offer the
//                    "rain later — show parks open now" suggestion chip.
// Defensive on purpose: if the hourly block is missing or oddly shaped we
// return the empty shape and the banner just shows current conditions.
function computeRainOutlook(hourly) {
  var nothing = { html: '', firstRainyTime: null };
  try {
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.precipitation_probability)) return nothing;
    var RAIN_THRESHOLD = 40; // % chance — below this we don't bother the user
    var now = new Date();
    // Keep only the hours from "now-ish" through the end of today.
    // With timezone=auto the times come back in the SEARCH location's local
    // clock (e.g. "2026-06-11T14:00"); parsing without a zone reads them as
    // device-local time, which is right for the usual "parks near me" case.
    var remaining = [];
    for (var i = 0; i < hourly.time.length; i++) {
      var t = new Date(hourly.time[i]);
      var p = hourly.precipitation_probability[i];
      if (isNaN(t.getTime()) || typeof p !== 'number') continue;
      // Include the in-progress hour (the "2:00" entry still matters at 2:40)
      if (t.getTime() >= now.getTime() - 60 * 60 * 1000) remaining.push({ time: t, prob: p });
    }
    if (remaining.length === 0) return nothing;
    // Find the first rainy hour left today
    var firstRainy = -1;
    for (var j = 0; j < remaining.length; j++) {
      if (remaining[j].prob >= RAIN_THRESHOLD) { firstRainy = j; break; }
    }
    if (firstRainy === -1) return nothing; // dry rest of day — good news needs no extra text
    // From here on, every branch has a real first rainy hour to report.
    var rainTime = remaining[firstRainy].time;
    var allRainy = remaining.every(function (h) { return h.prob >= RAIN_THRESHOLD; });
    if (allRainy) {
      return { html: '<span class="weather-rain">· 🌧 rain likely all day</span>', firstRainyTime: rainTime };
    }
    if (firstRainy === 0) {
      // Rainy now (or within the hour) — tell them when it clears
      for (var k = 0; k < remaining.length; k++) {
        if (remaining[k].prob < RAIN_THRESHOLD) {
          return { html: '<span class="weather-rain">· 🌧 clearing by ' + formatHour12(remaining[k].time) + '</span>', firstRainyTime: rainTime };
        }
      }
      return { html: '<span class="weather-rain">· 🌧 rain likely all day</span>', firstRainyTime: rainTime };
    }
    // Rain arrives later — only worth flagging if it's more than an hour out
    if (rainTime.getTime() - now.getTime() > 60 * 60 * 1000) {
      return { html: '<span class="weather-rain">· 🌧 rain ~' + formatHour12(rainTime) + '</span>', firstRainyTime: rainTime };
    }
    return { html: '<span class="weather-rain">· 🌧 rain soon</span>', firstRainyTime: rainTime };
  } catch (e) {
    return nothing; // any surprise in the data → just skip the outlook
  }
}

// V9 F1: decide whether the weather banner earns ONE suggestion chip.
// Heat beats rain (a 90° day is the bigger deal), and we never suggest a
// filter that's already on. Returns the chip's HTML or '' for no chip.
// IMPORTANT: the chip never changes filters by itself — the user has to tap
// it (see the #weather-banner click listener). This app's rule: no filter
// ever turns itself on invisibly.
function buildWeatherSuggestChip(currentTemp, firstRainyTime) {
  var active = getActiveSignalFilters();
  // Hot day → offer shade (unless the shade chip is already lit).
  if (typeof currentTemp === 'number' && currentTemp >= 85 && active.indexOf('shade') === -1) {
    return '<button type="button" class="weather-suggest-chip" data-suggest-signal="shade">🌳 Hot day — show shaded parks</button>';
  }
  // Rain within ~2 hours → offer "open now" (squeeze the visit in first).
  var TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  if (firstRainyTime && firstRainyTime.getTime() - Date.now() <= TWO_HOURS_MS && active.indexOf('open') === -1) {
    return '<button type="button" class="weather-suggest-chip" data-suggest-signal="open">🕐 Rain later — show parks open now</button>';
  }
  return '';
}

// "14:00" → "2 PM" — small helper for the rain outlook above
function formatHour12(date) {
  var h = date.getHours();
  var suffix = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ' ' + suffix;
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
    // SECURITY: escapeHtml on placeId — defense in depth in case a bad ID
    // ever sneaks past the share-link validation in decodeSharedParks.
    + '<textarea class="note-input" data-place-id="' + escapeHtml(result.placeId) + '" '
    + 'placeholder="e.g. fence on south side has a gap, swings squeak in the rain..." '
    // FIX E3: cap at 2000 chars in the UI to match setNote()'s cap.
    + 'maxlength="2000" rows="3">' + escapeHtml(existing) + '</textarea>'
    + '<div class="note-status" data-place-id="' + escapeHtml(result.placeId) + '"></div>'
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
// `source` is 'osm' or 'google' (verified, green) or 'gemini' (review-extracted, gold) or null
function booleanValueHtml(value, source) {
  if (value === 'yes') {
    var cls = 'signal-yes' + ((source === 'osm' || source === 'google') ? ' signal-verified' : '');
    return '<span class="' + cls + '">\u2705 Yes</span>';
  }
  if (value === 'no') return '<span class="signal-no">\u274C No</span>';
  if (value === 'loading') return '<span class="signal-loading">\u23F3 \u2026</span>';
  return '<span class="signal-na">\u2796 N/A</span>';
}

// Builds the value indicator HTML for a category dimension (age, parking)
function categoryValueHtml(label, source) {
  if (label === '...') return '<span class="signal-loading">\u23F3 \u2026</span>';
  if (label === 'N/A') return '<span class="signal-na">\u2796 N/A</span>';
  var cls = 'signal-category' + ((source === 'osm' || source === 'google') ? ' signal-verified' : '');
  return '<span class="' + cls + '">' + label + '</span>';
}

// Stand-in signals while we wait for /api/signals to return
function loadingSignals() {
  return {
    fenced: { value: 'loading', summary: null, source: null },
    shade: { value: 'loading', summary: null, source: null },
    bathrooms: { value: 'loading', summary: null, source: null },
    ageSuitability: { value: 'loading', summary: null, source: null },
    parking: { value: 'loading', summary: null, source: null },
    tennisCourts: { value: 'loading', summary: null, source: null },
    changingTable: { value: 'loading', summary: null, source: null }
  };
}

// Default (all N/A) signals \u2014 used for parks with no reviews
function defaultSignalsClient() {
  return {
    fenced: { value: 'not_mentioned', summary: null, source: null },
    shade: { value: 'not_mentioned', summary: null, source: null },
    bathrooms: { value: 'not_mentioned', summary: null, source: null },
    ageSuitability: { value: 'not_mentioned', summary: null, source: null },
    parking: { value: 'not_mentioned', summary: null, source: null },
    tennisCourts: { value: 'not_mentioned', summary: null, source: null },
    changingTable: { value: 'not_mentioned', summary: null, source: null }
  };
}

// ---- localStorage cache for Gemini-extracted signals ----
// Keyed by Google placeId. Cached entries now expire after 30 days so parks
// that get re-reviewed or change over time don't show forever-stale info.
var SIGNAL_CACHE_PREFIX = 'playgroundFinder.signals.';
var SIGNAL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadCachedSignals(placeId) {
  try {
    var raw = localStorage.getItem(SIGNAL_CACHE_PREFIX + placeId);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    // New shape: { savedAt, signals }. Old shape: raw signals object (no savedAt).
    // For backward compat, treat old-shape entries as fresh (they'll be rewritten
    // in the new shape next time saveCachedSignals runs).
    if (parsed && typeof parsed.savedAt === 'number' && parsed.signals) {
      if (Date.now() - parsed.savedAt > SIGNAL_CACHE_MAX_AGE_MS) return null; // stale \u2192 fresh fetch
      return parsed.signals;
    }
    return parsed;
  } catch (e) { return null; }
}

function saveCachedSignals(placeId, signals) {
  try {
    // Wrap with savedAt timestamp so we can expire old entries (see loadCachedSignals).
    var wrapped = { savedAt: Date.now(), signals: signals };
    localStorage.setItem(SIGNAL_CACHE_PREFIX + placeId, JSON.stringify(wrapped));
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
  // V8 F1: the COLLAPSED card shows a compact icon strip instead of the full
  // grid above. When signals resolve (Gemini, then OSM/Google), refresh that
  // strip too — otherwise a collapsed card would keep showing the grey
  // "loading" icons forever even after real data arrived.
  var oldStrip = card.querySelector('.signal-strip');
  if (oldStrip) {
    var stripTemp = document.createElement('div');
    stripTemp.innerHTML = renderSignalStrip(signals);
    var newStrip = stripTemp.firstChild;
    if (newStrip) oldStrip.replaceWith(newStrip);
  }
  // Re-evaluate "perfect park" status now that signals have arrived
  card.classList.toggle('is-perfect', isPerfectPark(signals));
}

// Builds one signal row for a card (with expandable summary)
function renderSignalRow(icon, label, valueHtml, summary) {
  var tappable = summary ? ' signal-tappable' : '';
  var arrow = summary ? '<span class="signal-arrow">\u25B6</span>' : '';
  // SECURITY: summary comes from Gemini, which reads attacker-controlled
  // Google review text. Server-side `sanitizeSummary` in api/signals.js
  // strips control chars + angle brackets + caps length, and we ALSO
  // escapeHtml here as defense-in-depth.
  var summaryHtml = summary
    ? '<div class="signal-summary">' + escapeHtml(summary) + '</div>'
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

// Builds the full signals list for a card.
// Defensive against missing dimensions or missing .source on cached pre-OSM data.
function renderSignals(signals) {
  if (!signals) return '';
  function get(dim) {
    return signals[dim] || { value: 'not_mentioned', summary: null, source: null };
  }
  var f = get('fenced'), s = get('shade'), b = get('bathrooms'), a = get('ageSuitability'), p = get('parking'), tc = get('tennisCourts');
  // V10 F3: changing table rides along on the Bathrooms row as a little
  // sub-badge (not its own row) — it only matters when bathrooms exist anyway.
  // get() is defensive, so signal blobs cached before this dimension existed
  // simply read as 'not_mentioned' and show no badge.
  var ct = get('changingTable');
  var bathroomsValueHtml = booleanValueHtml(b.value, b.source);
  if (ct.value === 'yes') {
    // All static strings here (no user data), so no escaping needed.
    bathroomsValueHtml += '<span class="sub-badge" title="'
      + (ct.source === 'osm' || ct.source === 'google'
        ? 'Changing table \u2014 verified by map data'
        : 'Changing table \u2014 mentioned in reviews')
      + '">\uD83E\uDDF7 changing table</span>';
  }
  var html = '<div class="signals-list">';
  html += renderSignalRow('\uD83D\uDD12', 'Fenced', booleanValueHtml(f.value, f.source), f.summary);
  html += renderSignalRow('\uD83C\uDF33', 'Shade', booleanValueHtml(s.value, s.source), s.summary);
  html += renderSignalRow('\uD83D\uDEBB', 'Bathrooms', bathroomsValueHtml, b.summary);
  html += renderSignalRow('\uD83D\uDC76', 'Ages', categoryValueHtml(ageSuitabilityLabel(a.value), a.source), a.summary);
  html += renderSignalRow('\uD83C\uDD7F\uFE0F', 'Parking', categoryValueHtml(parkingLabel(p.value), p.source), p.summary);
  html += renderSignalRow('\uD83C\uDFBE', 'Tennis', booleanValueHtml(tc.value, tc.source), tc.summary);
  html += '</div>';
  return html;
}

// ---- Compact icon "signal strip" for COLLAPSED cards ----
// A collapsed card can't show the full labeled signals grid, so we show a tiny
// row of the 6 signal emojis instead \u2014 bright when the park HAS that thing,
// dimmed when it doesn't. This lets a parent scan "fenced? shade? bathrooms?"
// at a glance without tapping "Details". The full labeled grid (with the AI
// summaries) still lives inside .result-card-detail for when they want more.
function renderSignalStrip(signals) {
  // Defensive: if signals haven't loaded yet (or are missing entirely), we
  // still want to render the strip so the card layout doesn't jump when they
  // arrive \u2014 fall back to a "loading" placeholder for every dimension.
  function get(dim) {
    if (!signals || !signals[dim]) return { value: 'loading', source: null };
    return signals[dim];
  }
  // Decide the visual state for one dimension: 'on' (has it), 'off' (doesn't),
  // or 'loading' (still waiting on the AI / OSM lookup).
  function stateFor(dim, onValues) {
    var s = get(dim);
    if (s.value === 'loading') return 'loading';
    // onValues is the list of values that count as a "yes" for this dimension.
    return onValues.indexOf(s.value) !== -1 ? 'on' : 'off';
  }
  // One emoji chip. We add .is-verified for OSM/Google-sourced "yes" answers so
  // the little \u2713 checkmark tints green (high confidence) vs gold (AI-read from
  // reviews) \u2014 mirroring the color treatment of the full signals grid.
  function chip(dim, emoji, label, humanValue, state) {
    var s = get(dim);
    var verified = (state === 'on' && (s.source === 'osm' || s.source === 'google'))
      ? ' is-verified' : '';
    var cls = 'signal-strip-item is-' + state + verified;
    var title = label + ': ' + humanValue;
    return '<span class="' + cls + '" title="' + escapeHtml(title)
      + '" aria-label="' + escapeHtml(title) + '">' + emoji + '</span>';
  }
  // Human-readable value text for the tooltip / screen-reader label.
  function boolText(dim) {
    var v = get(dim).value;
    if (v === 'yes') return 'Yes';
    if (v === 'no') return 'No';
    if (v === 'loading') return 'checking\u2026';
    return 'not mentioned';
  }
  var fState = stateFor('fenced', ['yes']);
  var sState = stateFor('shade', ['yes']);
  var bState = stateFor('bathrooms', ['yes']);
  var aState = stateFor('ageSuitability', ['toddler', 'both']);
  var pState = stateFor('parking', ['lot', 'street', 'both']);
  var tState = stateFor('tennisCourts', ['yes']);
  return '<div class="signal-strip">'
    + chip('fenced', '\uD83D\uDD12', 'Fenced', boolText('fenced'), fState)
    + chip('shade', '\uD83C\uDF33', 'Shade', boolText('shade'), sState)
    + chip('bathrooms', '\uD83D\uDEBB', 'Bathrooms', boolText('bathrooms'), bState)
    + chip('ageSuitability', '\uD83D\uDC76', 'Toddler', ageSuitabilityLabel(get('ageSuitability').value), aState)
    + chip('parking', '\uD83C\uDD7F\uFE0F', 'Parking', parkingLabel(get('parking').value), pState)
    + chip('tennisCourts', '\uD83C\uDFBE', 'Tennis', boolText('tennisCourts'), tState)
    + '</div>';
}

// ---- Compact "open now" pill for COLLAPSED cards ----
// Only meaningful when Google actually told us the open/closed status. We omit
// it entirely when openNow is null so we don't show a misleading grey pill for
// parks we simply don't have hours for.
function renderOpenNowPill(openNow) {
  if (typeof openNow !== 'boolean') return '';
  if (openNow) {
    return '<span class="opennow-pill is-open">\uD83D\uDFE2 Open now</span>';
  }
  return '<span class="opennow-pill is-closed">\u26AA Closed</span>';
}

// ---- V6 F4: amenity badges (display-only stickers, NOT filters) ----
// `amenities` comes from OpenStreetMap via /api/osm — booleans for
// splash pad / picnic tables / drinking water near the park.
function renderAmenityBadges(amenities) {
  if (!amenities) return '';
  var badges = '';
  if (amenities.splashPad) badges += '<span class="amenity-badge">💦 Splash pad</span>';
  if (amenities.picnicTables) badges += '<span class="amenity-badge">🧺 Picnic tables</span>';
  if (amenities.drinkingWater) badges += '<span class="amenity-badge">🚰 Water fountain</span>';
  if (!badges) return '';
  return '<div class="amenity-badges">' + badges + '</div>';
}

// V6 F4: swap in (or add) the amenity badge row on ONE card without
// re-rendering the whole list — a full re-render would collapse open
// review sections and steal focus from a note the user is typing.
function updateCardAmenities(placeId, amenities) {
  var card = document.querySelector('.result-card[data-place-id="' + placeId + '"]');
  if (!card) return;
  var html = renderAmenityBadges(amenities);
  var existing = card.querySelector('.amenity-badges');
  var temp;
  if (existing) {
    if (html) {
      temp = document.createElement('div');
      temp.innerHTML = html;
      existing.replaceWith(temp.firstChild);
    } else {
      existing.remove();
    }
  } else if (html) {
    // Badges live right after the signals list on the card
    var list = card.querySelector('.signals-list');
    if (list) {
      temp = document.createElement('div');
      temp.innerHTML = html;
      list.insertAdjacentElement('afterend', temp.firstChild);
    }
  }
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
  html += renderPopupSignalRow('\uD83D\uDD12', booleanValueHtml(signals.fenced.value, signals.fenced.source));
  html += renderPopupSignalRow('\uD83C\uDF33', booleanValueHtml(signals.shade.value, signals.shade.source));
  html += renderPopupSignalRow('\uD83D\uDEBB', booleanValueHtml(signals.bathrooms.value, signals.bathrooms.source));
  html += renderPopupSignalRow('\uD83D\uDC76', categoryValueHtml(ageSuitabilityLabel(signals.ageSuitability.value), signals.ageSuitability.source));
  html += renderPopupSignalRow('\uD83C\uDD7F\uFE0F', categoryValueHtml(parkingLabel(signals.parking.value), signals.parking.source));
  // V5: tennis. Defensive read in case an old cached signal blob omits the field.
  if (signals.tennisCourts) {
    html += renderPopupSignalRow('\uD83C\uDFBE', booleanValueHtml(signals.tennisCourts.value, signals.tennisCourts.source));
  }
  html += '</div>';
  return html;
}

// ---- Lazy-load Leaflet CSS + JS on first map use ----
// We don't include Leaflet in index.html anymore, saving ~47KB on the initial page load
// for visitors who never run a search. This loads it once, memoizing the Promise.
function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise(function (resolve, reject) {
    // 1. CSS
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.integrity = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    // 2. JS — wait for it to load before resolving so subsequent code can use L
    var script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';
    script.crossOrigin = 'anonymous';
    script.onload = function () {
      if (!markerGroup) markerGroup = L.layerGroup();
      resolve();
    };
    script.onerror = function () { reject(new Error('Failed to load Leaflet')); };
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
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
    + '<strong>' + escapeHtml(r.name) + '</strong><br>'
    + '<span class="result-type result-type-compact ' + popupTypeClass + '">' + typeBadgeLabel(r.type) + '</span> ' + popupRating + '<br>'
    // V6 F3: small address line (skipped for shared-link parks with no address)
    + (r.address ? '<span class="popup-address">📍 ' + escapeHtml(r.address) + '</span><br>' : '')
    + renderPopupSignals(r.signals)
    + '<a class="popup-link-google" href="' + googleDirectionsUrl(r.placeId, r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">🚗 Directions in Google Maps</a><br>'
    + '<a class="popup-link-yelp" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
    + '</div>'
    + '</div>';
}

// ---- Helper: render an empty state with actionable suggestions ----
function renderEmptyState(currentRadius) {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('things-strip');
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
    // FIX A2: no third arg → searchOrigin preserved so the Directions link still
    // starts from the same typed address even after radius change.
    if (lastLat !== null && lastLng !== null) handleCoordinates(lastLat, lastLng);
  } else if (action === 'change-location') {
    // FIX E2: scroll the input into view + give the user a friendly nudge
    // about what to type. On mobile the search bar can be off-screen.
    addressInput.value = '';
    try { addressInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e2) { /* old browsers */ }
    addressInput.focus();
    showMessage('Type any address, city, or zip, then tap Search.', 'info');
  } else if (action === 'clear-filters') {
    // FIX A3 + A5: one-click recovery from "everything filtered out".
    setActiveSignalFilters([]);
    setHideVisited(false);
    setMaxDriveMinutes(null);
    savePref('playgroundFinder.typeFilter', 'all');
    // Clear the visual active state from chips, type buttons, and dropdowns.
    document.querySelectorAll('.signal-chip.active').forEach(function (c) { c.classList.remove('active'); });
    document.querySelectorAll('.type-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-type') === 'all');
    });
    var hideBtn = document.querySelector('.hide-visited-chip');
    if (hideBtn) { hideBtn.classList.remove('active'); hideBtn.setAttribute('aria-pressed', 'false'); }
    var naptimeSel = document.getElementById('naptime-select');
    if (naptimeSel) naptimeSel.value = '';
    // V9 F2: clearing filters breaks up the toddler-ready trio, so the
    // preset chip must dim too (it's also caught by the .signal-chip.active
    // sweep above, but this keeps the rule in one obvious place).
    syncPresetChip();
    applyFilterAndSort();
  }
});

// FIX A5: show/hide an inline "Clear" button when any filters are active.
// Lives inside the signal-filter-row so it sits next to the chips.
function refreshClearFiltersBtn() {
  var row = document.getElementById('signal-filter');
  if (!row) return;
  var anyActive = getActiveSignalFilters().length > 0
    || getHideVisited()
    || getMaxDriveMinutes() != null;
  var btn = row.querySelector('.clear-filters-btn');
  if (anyActive) {
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'clear-filters-btn';
      btn.textContent = 'Clear';
      btn.setAttribute('aria-label', 'Clear all filters');
      btn.addEventListener('click', function () {
        // Clear every kind of filter (signal chips, hide-visited, drive time)
        // and re-render. Type filter is left alone (it's a view choice, not a filter).
        setActiveSignalFilters([]);
        setHideVisited(false);
        setMaxDriveMinutes(null);
        document.querySelectorAll('.signal-chip.active').forEach(function (c) { c.classList.remove('active'); });
        var hideBtn = document.querySelector('.hide-visited-chip');
        if (hideBtn) { hideBtn.classList.remove('active'); hideBtn.setAttribute('aria-pressed', 'false'); }
        var naptimeSel = document.getElementById('naptime-select');
        if (naptimeSel) naptimeSel.value = '';
        // V9 F2: keep the toddler-ready preset chip's highlight in sync
        // after everything was cleared.
        syncPresetChip();
        applyFilterAndSort();
      });
      row.appendChild(btn);
    }
  } else if (btn) {
    btn.remove();
  }
}

// ---- Helper: show shimmer skeleton cards while results are loading ----
function showLoadingSkeletons() {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('things-strip');
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
  // Lazy-load Leaflet on first call; subsequent calls resolve immediately
  ensureLeaflet().then(function () { showMapInternal(lat, lng, results); });
}

function showMapInternal(lat, lng, results) {
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
    // FIX C1: also show "Search this area" on zoom changes — pinch-zoom is
    // how mobile users explore the map. Delay attaching by 1.5s so the
    // initial fitBounds() call doesn't trigger the button on first render.
    setTimeout(function () {
      if (map) map.on('zoomend', function () { searchHereBtn.classList.remove('hidden'); });
    }, 1500);
  }
  // Note: don't pre-fly to lat/lng here when results exist — fitBounds below positions
  // the map based on the actual markers, and the two animations would fight each other.

  // Hide the "Search this area" button now that we have fresh results centered here
  searchHereBtn.classList.add('hidden');

  // Clear ALL previous markers before adding new ones (prevents stale markers
  // bleeding through on "Search this area" or repeat searches).
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
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  } else {
    // No results — just center on the search location at the default zoom
    map.setView([lat, lng], 13);
  }

  setTimeout(function () { map.invalidateSize(); }, 200);
}

// ---- Helper: update marker visibility based on type filter ----
function updateMarkerVisibility(typeFilter, activeSignals) {
  // Build a set of placeIds that pass the current filters
  var visibleIds = {};
  var filtered = filterByType(currentResults, typeFilter);
  // Mirror applyFilterAndSort: skip signal filters on Saved view (FIX A1).
  // U5: hide-visited and drive-time skip Saved too — saved markers should
  // never silently disappear from the map.
  if (typeFilter !== 'favorites') {
    filtered = filterBySignals(filtered, activeSignals || []);
    // V3 Feature 1: hide visited markers too when the toggle is on.
    if (getHideVisited()) {
      filtered = filtered.filter(function (r) { return !isVisited(r.placeId); });
    }
    // V3 Feature 2: respect drive-time cap for markers.
    var maxMin = getMaxDriveMinutes();
    if (maxMin != null && lastLat != null && lastLng != null) {
      filtered = filtered.filter(function (r) {
        var mins = estimateDriveMinutes(r);
        return mins == null || mins <= maxMin;
      });
    }
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
  // Defer if Leaflet hasn't loaded yet — showMap will fire the load and call us back
  if (!window.L) {
    ensureLeaflet().then(function () { addMarkersForSavedParks(savedFilteredResults); });
    return;
  }
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
// `unfilteredCount` (optional): the total before filters were applied. When
// filtered results are empty but unfiltered are not, we show a "clear filters"
// empty state so the user can recover (FIX A3).
function renderResults(results, unfilteredCount) {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  var resultsToolbar = document.getElementById('results-toolbar');
  var fiveThingsStrip = document.getElementById('things-strip');

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
      // Initialize map centered on the first saved park (lazy-loads Leaflet first)
      var first = savedParks[0];
      document.getElementById('map-section').classList.remove('hidden');
      ensureLeaflet().then(function () {
        if (map) return; // another path may have initialized it
        map = L.map('map').setView([first.lat, first.lng], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        markerGroup.addTo(map);
        // Now that map is ready, run the marker-add path for saved parks
        applyFilterAndSort();
      });
    }
  }

  if (results.length === 0) {
    // FIX A3: when filters have hidden everything, show an actionable empty
    // state with a one-tap "Clear filters" button instead of a silent blank list.
    var hasUnfiltered = unfilteredCount && unfilteredCount > 0;
    if (hasUnfiltered) {
      resultsList.innerHTML = '<div class="empty-state">'
        + '<div class="empty-emoji">🔎</div>'
        + '<div class="empty-title">No parks match these filters.</div>'
        + '<div class="empty-actions">'
        + '<button type="button" class="empty-cta" data-action="clear-filters">Clear filters</button>'
        + '</div></div>';
      return;
    }
    // No unfiltered results either — fall back to the old "no results in this category" line.
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

    // V6 F5: if the NEWEST review is 2+ years old, append a small amber
    // "reviews from YEAR" warning — old reviews may describe a park that's
    // since changed. Recent reviews are the normal case, so we say nothing then.
    if (Array.isArray(r.reviews) && r.reviews.length > 0) {
      var newestYear = null;
      r.reviews.forEach(function (rv) {
        if (!rv || typeof rv !== 'object' || !rv.publishTime) return;
        var y = new Date(rv.publishTime).getFullYear();
        if (!isNaN(y) && (newestYear === null || y > newestYear)) newestYear = y;
      });
      if (newestYear !== null && new Date().getFullYear() - newestYear >= 2) {
        ratingHtml += ' <span class="review-age">reviews from ' + newestYear + '</span>';
      }
    }

    var favClass = isFavorite(r.placeId) ? ' is-favorite' : '';
    var visitedClass = isVisited(r.placeId) ? ' is-visited' : '';
    var perfectClass = isPerfectPark(r.signals) ? ' is-perfect' : '';
    // SECURITY: placeId is escapeHtml'd everywhere it lands in an HTML
    // attribute — shared-link parks carry placeIds from a URL, and escaping
    // here means a malicious one can't break out of the attribute.
    html += '<li class="result-card' + visitedClass + perfectClass + '" data-place-id="' + escapeHtml(r.placeId) + '">'
      + '<button class="favorite-btn' + favClass + '" data-place-id="' + escapeHtml(r.placeId) + '" aria-label="Save to favorites" title="Save to favorites">★</button>'
      + '<button class="visited-btn' + visitedClass + '" data-place-id="' + escapeHtml(r.placeId) + '" aria-label="Mark as visited" title="Mark as visited">✓</button>'
      + renderHeroPhoto(r)
      + '<div class="result-card-body">'
      + '<div class="result-card-header">'
      + '<span class="result-name">' + escapeHtml(r.name) + '</span>'
      + '<span class="result-type ' + typeClass + '">' + typeBadgeLabel(r.type) + '</span>'
      + '</div>'
      + '<span class="result-meta result-distance">' + renderTravelTime(r.distance) + '</span>'
      + '<span class="result-meta result-rating">' + ratingHtml + '</span>'
      // V8 F1: COLLAPSED-VISIBLE status row — a small "open now" pill (only when
      // we actually know the status) plus the compact icon signal strip. This is
      // the at-a-glance scan layer; everything heavier is hidden until "Details".
      + '<div class="card-status-row">'
      + renderOpenNowPill(r.openNow)
      + renderSignalStrip(r.signals)
      + '</div>'
      // V8 F1: the "Details" toggle reveals .result-card-detail below. It's a
      // dedicated button (NOT a whole-card tap) so it never collides with the
      // existing card-tap-to-pan-the-map behavior.
      + '<button type="button" class="card-expand-toggle" aria-expanded="false">Details <span class="expand-caret">⌄</span></button>'
      // V8 F1: everything below is hidden by default (CSS) and only shows once
      // the card gets .is-expanded — this is what keeps collapsed cards short.
      + '<div class="result-card-detail">'
      // V6 F3: street address (shared-link parks don't have one — skip then)
      + (r.address ? '<span class="result-meta result-address">📍 ' + escapeHtml(r.address) + '</span>' : '')
      + renderHours(r)
      + renderSignals(r.signals)
      // V6 F4: sticker-style amenity badges (splash pad / picnic / fountain)
      + renderAmenityBadges(r.amenities)
      // "Ask about this park" Q&A box — sits just above "Read reviews" since
      // its answers come FROM those reviews (empty string when < 2 reviews)
      + renderAskSection(r)
      + renderReviews(r)
      + renderNoteSection(r)
      + '<div class="result-links">'
      + '<a class="result-link result-link-directions" href="' + googleDirectionsUrl(r.placeId, r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">\ud83d\ude97 Directions in Google Maps</a>'
      + '<a class="result-link-secondary" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
      + '<button type="button" class="result-link-share" data-place-id="' + escapeHtml(r.placeId) + '" title="Share this park">\ud83d\udd17 Share</button>'
      + '</div>'      // closes .result-links
      + '</div>'      // V8 F1: closes .result-card-detail (the collapsible region)
      + '</div>'      // closes .result-card-body
      + '</li>';
  });

  // V6 F7: on the Saved tab, remind the user that the share link doubles as
  // a backup of their collection (saved parks live only in this browser's
  // localStorage — a new phone starts from zero without that link).
  if (typeFilterNow === 'favorites' && results.length > 0) {
    html += '<li class="backup-tip">💡 Tip: tap "🔗 Share saved" up top and save that link somewhere — it\'s also your backup if you ever switch phones.</li>';
  }

  // FIX 12: remember which cards the user had expanded BEFORE we wipe the
  // list below — setting innerHTML rebuilds every card collapsed, so without
  // this a filter/sort change would silently snap open cards shut.
  var expandedPlaceIds = [];
  resultsList.querySelectorAll('.result-card.is-expanded').forEach(function (openCard) {
    var pid = openCard.getAttribute('data-place-id');
    if (pid) expandedPlaceIds.push(pid);
  });

  resultsList.innerHTML = html;

  // FIX 10: setting innerHTML above rebuilt every card from scratch, which
  // resets any photo carousel back to the single hero photo + "+N" badge. If
  // the user was mid-browse and just toggled a filter, the carousel would
  // silently collapse. The extra photo URLs are still cached on the result
  // object (park._extraPhotoUrls), so we can re-enter carousel mode for free —
  // no new photo fetch. Cards WITHOUT cached extra photos are skipped (they
  // keep their plain badge), so this never disturbs a normal first render.
  results.forEach(function (park) {
    if (!Array.isArray(park._extraPhotoUrls) || park._extraPhotoUrls.length <= 1) return;
    var card = resultsList.querySelector('.result-card[data-place-id="' + park.placeId + '"]');
    if (!card) return; // card may be filtered out — skip rather than throw
    enterCarouselMode(card, park);
  });

  // FIX 12 (part 2): re-open the cards that were expanded before the rebuild,
  // mirroring the carousel restore just above. Cards that got filtered out
  // simply aren't found — skip rather than throw.
  expandedPlaceIds.forEach(function (pid) {
    var openCard = resultsList.querySelector('.result-card[data-place-id="' + pid + '"]');
    if (!openCard) return;
    openCard.classList.add('is-expanded');
    var openToggle = openCard.querySelector('.card-expand-toggle');
    if (openToggle) openToggle.setAttribute('aria-expanded', 'true');
    var openCaret = openCard.querySelector('.expand-caret');
    if (openCaret) openCaret.textContent = '⌃';
  });
}

// ---- Master render: filter → sort → render list + update markers ----
function applyFilterAndSort() {
  var typeFilter = getTypeFilter();
  var sortBy = getSortOrder();
  var activeSignals = getActiveSignalFilters();
  var filtered = filterByType(currentResults, typeFilter);
  // FIX A1: Saved parks may have come from another search and have stale or
  // missing signals data, so skip the signal-chip filter while viewing Saved —
  // otherwise the user's saved list silently shrinks for no obvious reason.
  if (typeFilter !== 'favorites') {
    filtered = filterBySignals(filtered, activeSignals);
    // U5: hide-visited and drive-time are also skipped on the Saved tab —
    // your own saved collection should never silently shrink. (Saved parks
    // are often ones you've visited, and drive-time depends on a search
    // origin that may be miles from where you saved them.)
    // V3 Feature 1: hide-visited toggle removes already-visited parks.
    if (getHideVisited()) {
      filtered = filtered.filter(function (r) { return !isVisited(r.placeId); });
    }
    // V3 Feature 2: drive-time filter. Only applies if we know the search origin.
    var maxMin = getMaxDriveMinutes();
    if (maxMin != null && lastLat != null && lastLng != null) {
      filtered = filtered.filter(function (r) {
        var mins = estimateDriveMinutes(r);
        return mins == null || mins <= maxMin;
      });
    }
  }
  var sorted = sortResults(filtered, sortBy);
  // FIX A3: also pass the unfiltered count so renderResults can show a
  // "No parks match these filters — clear filters?" empty state instead of
  // a confusingly blank list when the user has filtered everything out.
  renderResults(sorted, currentResults.length);
  updateMarkerVisibility(typeFilter, activeSignals);
  // FIX A5: show/hide the "Clear filters" inline link based on whether any
  // signal chips (or the hide-visited / drive-time filters) are active.
  refreshClearFiltersBtn();
}

// ---- Helper: called once we have coordinates ----
// originMode controls the Directions-link origin:
//   {lat, lng, label?} \u2014 search came from a typed address / autocomplete /
//                        saved home / "Search this area" / shared link.
//                        `label` (when present) is the human-readable address
//                        text we'll feed to Google Maps so it shows e.g.
//                        "Brookline, MA" instead of "Dropped Pin".
//   'gps'              \u2014 search came from device geolocation. Clear so
//                        Google Maps Directions uses live "Your location".
//   undefined          \u2014 radius change / re-trigger. Preserve previous origin.
function handleCoordinates(lat, lng, originMode) {
  // V9 F4: any search starting makes the "resume last search" offer stale — hide it.
  var resumeChip = document.getElementById('resume-chip');
  if (resumeChip) resumeChip.classList.add('hidden');
  // V10 F2: same idea for the first-visit sample chips — once ANY search
  // starts, the "try an example" offer is stale too.
  var sampleChips = document.getElementById('sample-chips');
  if (sampleChips) sampleChips.classList.add('hidden');
  lastLat = lat;
  lastLng = lng;
  if (originMode === 'gps') {
    searchOrigin = null;
  } else if (originMode && typeof originMode === 'object') {
    searchOrigin = originMode;
  }
  // else: preserve

  showMessage('Searching for playgrounds and parks\u2026', 'info');
  showLoadingSkeletons();
  refreshHomeButton();

  var radius = getRadius();
  var thisRequest = ++requestId;

  // U3: tell the server what weekday it is HERE (0=Sunday..6=Saturday).
  // The serverless function runs in UTC, so in the evening its "today" is
  // already tomorrow — without this, "Today's hours" showed the wrong day.
  fetch('/api/places?lat=' + lat + '&lng=' + lng + '&radius=' + radius + '&day=' + new Date().getDay())
    .then(function (response) {
      // Ignore stale responses
      if (thisRequest !== requestId) return;

      if (response.ok) {
        return response.json().then(function (data) {
          if (thisRequest !== requestId) return;
          if (data.results.length === 0) {
            showMessage('No playgrounds or parks found within ' + formatRadius(radius) + ' of this location.', 'info');
            // ADDITION: announce the empty result to screen-reader users via
            // the polite aria-live region (results arrive async, so without
            // this a screen reader gives no feedback that the search finished).
            var liveEmpty = document.getElementById('a11y-status');
            if (liveEmpty) liveEmpty.textContent = 'No playgrounds or parks found here';
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
              // V6 F5: reviews are now {text, publishTime} objects, but
              // /api/signals expects plain text strings — unwrap them here.
              needsSignals.push({
                placeId: r.placeId,
                name: r.name,
                reviews: r.reviews.map(function (rv) {
                  return typeof rv === 'string' ? rv : (rv && rv.text) || '';
                })
              });
            }
            // V6 F2: Google's own structured answers ("has restroom?",
            // "good for children?") are first-party facts, fetched fresh on
            // every search — so they go on top of whatever the signal cache
            // had, and nothing below is allowed to overwrite source:'google'.
            if (r.restroom === true) {
              r.signals.bathrooms = { value: 'yes', source: 'google', summary: null };
            } else if (r.restroom === false) {
              r.signals.bathrooms = { value: 'no', source: 'google', summary: null };
            }
            if (r.goodForChildren === true) {
              // Google says "good for children" — that's not toddler-specific,
              // so 'both' (all ages) is the honest mapping.
              r.signals.ageSuitability = { value: 'both', source: 'google', summary: null };
            }
            // Apply any cached OSM signals immediately (they win over Gemini,
            // but NOT over fresh first-party Google facts applied just above)
            var cachedOsm = loadCachedOsm(r.placeId);
            if (cachedOsm && Object.keys(cachedOsm).length > 0) {
              ['fenced', 'shade', 'bathrooms', 'ageSuitability', 'parking', 'tennisCourts', 'changingTable'].forEach(function (dim) {
                if (r.signals[dim] && r.signals[dim].source === 'google') return;
                if (cachedOsm[dim] && cachedOsm[dim].value) {
                  r.signals[dim] = {
                    value: cachedOsm[dim].value,
                    summary: (r.signals[dim] && r.signals[dim].summary) || null,
                    source: 'osm'
                  };
                }
              });
            }
          });

          showMessage('Found ' + data.results.length + ' playgrounds and parks nearby.', 'success');
          // ADDITION: also announce the count in the polite aria-live region so
          // screen-reader users hear how many results arrived. Done here on a
          // FRESH search only (not on filter re-renders, which would spam the
          // announcement). Defensive — the element may not exist on older HTML.
          var live = document.getElementById('a11y-status');
          if (live) live.textContent = 'Found ' + data.results.length + ' playgrounds and parks nearby';
          currentResults = data.results;
          showMap(lat, lng, data.results);
          applyFilterAndSort();

          // U1: on phones the hero section is taller than the viewport, so
          // after tapping "Show parks near me" the results render off-screen
          // and it looks like nothing happened. Scroll the results toolbar
          // into view — but only on touch devices (desktop already shows
          // results beside the hero, and auto-scrolling there feels jumpy).
          try {
            if (window.matchMedia('(pointer: coarse)').matches) {
              document.getElementById('results-toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          } catch (e) { /* old browsers without matchMedia/scrollIntoView options */ }

          // Phase 2: fetch signals for parks not in cache.
          // Chunk into 2 parallel requests (chunk size 10) — keeps within Gemini's
          // free-tier rate/daily limits while still letting signals stream in.
          if (needsSignals.length > 0) {
            var SIGNAL_CHUNK_SIZE = 10;
            for (var i = 0; i < needsSignals.length; i += SIGNAL_CHUNK_SIZE) {
              fetchSignals(needsSignals.slice(i, i + SIGNAL_CHUNK_SIZE), thisRequest);
            }
          }

          // Phase 2b: fetch OSM-verified signals for the area (parallel)
          fetchOsmAndMerge(lat, lng, radius, thisRequest);

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
      record = currentResults[i];
      break;
    }
  }
  // Cache the raw Gemini signals (not the merged view below) so the cache
  // stays a pure "what the reviews told us" layer — google/osm facts are
  // re-applied fresh on every search anyway.
  if (shouldCache) saveCachedSignals(placeId, signals);
  // PRECEDENCE: 'google' (first-party structured fact) and 'osm' (verified
  // map data) beat Gemini's review-reading guesses. Merge dimension by
  // dimension and skip any dim that's already verified, instead of letting
  // the Gemini response clobber the whole signals object.
  var merged = signals;
  if (record) {
    merged = record.signals || {};
    Object.keys(signals).forEach(function (dim) {
      var existing = merged[dim];
      if (existing && (existing.source === 'google' || existing.source === 'osm')) return;
      merged[dim] = signals[dim];
    });
    record.signals = merged;
  }
  updateCardSignals(placeId, merged);
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

// ---- V3 Feature 2: drive-time select restore + change handler ----
(function () {
  var sel = document.getElementById('naptime-select');
  if (!sel) return;
  // Restore previously-chosen cap from localStorage.
  var saved = getMaxDriveMinutes();
  if (saved != null) sel.value = String(saved);
  sel.addEventListener('change', function () {
    setMaxDriveMinutes(sel.value || null);
    if (currentResults.length === 0 && getTypeFilter() !== 'favorites') return;
    applyFilterAndSort();
  });
})();

// ---- Event: signal filter chip click + hide-visited toggle ----
(function () {
  var signalFilter = document.getElementById('signal-filter');
  if (!signalFilter) return;
  // Restore active state from localStorage for signal chips...
  var active = getActiveSignalFilters();
  signalFilter.querySelectorAll('.signal-chip').forEach(function (chip) {
    var sig = chip.getAttribute('data-signal');
    if (sig && active.indexOf(sig) !== -1) chip.classList.add('active');
  });
  // ...and for the V3 Feature 1 "Hide visited" toggle.
  var hideBtn = signalFilter.querySelector('.hide-visited-chip');
  if (hideBtn && getHideVisited()) {
    hideBtn.classList.add('active');
    hideBtn.setAttribute('aria-pressed', 'true');
  }
  // V9 F2: if the restored chips happen to include all three toddler-preset
  // signals, light the preset chip up too so it matches reality on load.
  syncPresetChip();
  signalFilter.addEventListener('click', function (e) {
    // V3 Feature 1: hide-visited toggle. Handled before signal chips so we
    // can short-circuit (the button is also a .signal-chip for shared styling).
    var hideToggle = e.target.closest('.hide-visited-chip');
    if (hideToggle) {
      var nowOn = !hideToggle.classList.contains('active');
      hideToggle.classList.toggle('active', nowOn);
      hideToggle.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
      setHideVisited(nowOn);
      // Re-render even if there's no current search — applyFilterAndSort
      // will be a no-op in that case but it's cheap.
      if (currentResults.length > 0 || getTypeFilter() === 'favorites') applyFilterAndSort();
      return;
    }
    // V9 F2: the "👶 Toddler-ready" preset. Handled BEFORE plain signal chips
    // because the preset is also styled as a .signal-chip (shared sizing) but
    // has no data-signal of its own — it drives three chips at once.
    var presetChip = e.target.closest('.preset-chip');
    if (presetChip) {
      var presetActive = getActiveSignalFilters();
      var allOn = TODDLER_PRESET_SIGNALS.every(function (s) { return presetActive.indexOf(s) !== -1; });
      if (!allOn) {
        // Turn the whole trio ON. Union, not replace — any OTHER chips the
        // user already tapped (shade, parking...) stay exactly as they were.
        TODDLER_PRESET_SIGNALS.forEach(function (s) {
          if (presetActive.indexOf(s) === -1) presetActive.push(s);
        });
      } else {
        // All three already on → tapping again turns exactly those three OFF
        // (again leaving any other active chips alone).
        presetActive = presetActive.filter(function (s) { return TODDLER_PRESET_SIGNALS.indexOf(s) === -1; });
      }
      setActiveSignalFilters(presetActive);
      // Repaint the three individual chips to match, then let syncPresetChip
      // set the preset's own highlight from the single source of truth.
      TODDLER_PRESET_SIGNALS.forEach(function (s) {
        var c = signalFilter.querySelector('.signal-chip[data-signal="' + s + '"]');
        if (c) c.classList.toggle('active', !allOn);
      });
      syncPresetChip();
      if (currentResults.length === 0) return;
      applyFilterAndSort(); // also refreshes the "Clear" button (see its tail)
      return;
    }
    var chip = e.target.closest('.signal-chip');
    if (!chip) return;
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
    // V9 F2: an individual chip toggle may have completed (or broken up) the
    // toddler-ready trio — keep the preset chip's highlight in sync.
    syncPresetChip();
    if (currentResults.length === 0) return;
    applyFilterAndSort();
  });
})();

// ---- V9 F1: weather suggestion chip click (delegated) ----
// The chip is re-rendered inside #weather-banner on every search, so we
// listen ONCE on the banner itself instead of re-wiring per render. Tapping
// the chip is the explicit "yes, apply that filter" moment — it flips the
// matching signal chip on, re-filters, and then removes itself (job done).
(function () {
  var banner = document.getElementById('weather-banner');
  if (!banner) return;
  banner.addEventListener('click', function (e) {
    var suggestBtn = e.target.closest('.weather-suggest-chip');
    if (!suggestBtn) return;
    // FIX A1 applies here too: signal filters don't run on the Saved tab, so
    // adding one from the weather chip would look like a dead tap. Do nothing.
    if (getTypeFilter() === 'favorites') return;
    var sig = suggestBtn.getAttribute('data-suggest-signal');
    if (!sig) return;
    var active = getActiveSignalFilters();
    if (active.indexOf(sig) === -1) {
      active.push(sig);
      setActiveSignalFilters(active);
    }
    // Light up the matching chip in the filter row so the state is visible
    // in the usual place — no invisible filters, ever.
    var chip = document.querySelector('#signal-filter .signal-chip[data-signal="' + sig + '"]');
    if (chip) chip.classList.add('active');
    applyFilterAndSort();
    if (typeof refreshClearFiltersBtn === 'function') refreshClearFiltersBtn();
    // The suggestion has been taken — remove the chip so it can't be
    // double-tapped and the banner shrinks back to just the weather.
    suggestBtn.remove();
  });
})();

// ---- Event: type filter change ----
// Listen at the parent filter-row so we catch clicks on both the type-filter pill
// AND the standalone Saved button (which sits outside the pill for visual demarcation).
typeFilterDiv.parentElement.addEventListener('click', function (e) {
  var btn = e.target.closest('.type-btn');
  if (!btn) return;
  var type = btn.getAttribute('data-type');
  // Saved button toggles: clicking it again returns you to All
  var leavingFavorites = false;
  if (type === 'favorites' && btn.classList.contains('active')) {
    type = 'all';
    leavingFavorites = true;
    btn = document.querySelector('.type-btn[data-type="all"]');
    if (!btn) return;
  }
  document.querySelectorAll('.type-btn').forEach(function (b) {
    b.classList.remove('active');
  });
  btn.classList.add('active');
  savePref('playgroundFinder.typeFilter', type);
  refreshShareButtonLabel();
  // FIX A1: visually grey-out the signal chip row while viewing Saved, since
  // we don't apply signal filters to saved parks (they may have stale signals).
  var signalRow = document.getElementById('signal-filter');
  if (signalRow) signalRow.classList.toggle('signals-disabled-for-saved', type === 'favorites');
  // U5: drive-time doesn't apply on Saved either (your collection never
  // shrinks), so grey out its dropdown too while viewing Saved.
  var naptimeSelect = document.getElementById('naptime-select');
  if (naptimeSelect) naptimeSelect.disabled = (type === 'favorites');
  // FIX A6: leaving Saved with no current search → tear the UI back down to
  // the landing state instead of leaving stale Saved cards on screen.
  if (leavingFavorites && currentResults.length === 0) {
    var resultsSection = document.getElementById('results-section');
    var resultsList = document.getElementById('results-list');
    var resultsToolbar = document.getElementById('results-toolbar');
    var mapSection = document.getElementById('map-section');
    var fiveThingsStrip = document.getElementById('things-strip');
    if (resultsList) resultsList.innerHTML = '';
    if (resultsSection) resultsSection.classList.add('hidden');
    if (resultsToolbar) resultsToolbar.classList.add('hidden');
    if (mapSection) mapSection.classList.add('hidden');
    if (fiveThingsStrip) fiveThingsStrip.classList.remove('hidden');
    return;
  }
  // Saved tab can render with no current search (uses cross-search saved data)
  if (currentResults.length === 0 && type !== 'favorites') return;
  applyFilterAndSort();
});

// ---- Event: radius change → new API call ----
radiusSelect.addEventListener('change', function () {
  savePref('playgroundFinder.radius', radiusSelect.value);
  if (lastLat !== null && lastLng !== null) {
    // FIX A2: no third arg → searchOrigin preserved so the Directions link still
    // starts from the same typed address even after radius change.
    handleCoordinates(lastLat, lastLng);
  }
});

// ---- Card hover → highlight matching marker on the map ----
// FIX C3: on touch devices, "hover" from a tap stays stuck until the user
// taps elsewhere — Mobile Safari treats the first tap as hover, not click.
// Skip the hover wiring entirely on touch so taps just open the popup.
(function () {
  var isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (isTouch) return;
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

// ---- Event: photo carousel (V7 F8) — "+N" badge and ‹ › arrows ----
// Kept separate from the card-click→pan handler below; that handler has its
// own check to ignore taps on these controls so the map doesn't also pan.
document.getElementById('results-list').addEventListener('click', function (e) {
  // --- "📷 +N" badge tap → load the extra photos, then open the carousel ---
  var badge = e.target.closest('.photo-more-badge');
  if (badge) {
    var pid = badge.getAttribute('data-place-id');
    var park = currentResults.find(function (r) { return r.placeId === pid; });
    var card = badge.closest('.result-card');
    if (!park || !card) return;

    // Already loaded on a previous tap? (e.g. card got re-rendered by a
    // filter change) — skip straight to the carousel, no new fetches.
    if (Array.isArray(park._extraPhotoUrls) && park._extraPhotoUrls.length > 0) {
      enterCarouselMode(card, park);
      return;
    }

    // First tap: resolve the free photo NAMES into real image URLs.
    // This is the only moment the extra photos cost us anything, so the
    // bill scales with taps, not with searches.
    var names = Array.isArray(park.extraPhotoNames) ? park.extraPhotoNames : [];
    badge.textContent = '…';
    badge.disabled = true;
    Promise.all(names.map(function (name) {
      return fetch('/api/photo?name=' + encodeURIComponent(name))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.url ? d.url : null; })
        .catch(function () { return null; });
    })).then(function (urls) {
      var loaded = urls.filter(function (u) { return u; });
      if (loaded.length === 0) {
        // Every extra photo failed to load — show a brief "nope", then
        // restore the badge so the user can try again later.
        badge.textContent = '📷 ✕';
        setTimeout(function () {
          badge.textContent = '📷 +' + names.length;
          badge.disabled = false;
        }, 1500);
        return;
      }
      // Slide 0 is the hero photo the card already shows; extras follow.
      park._extraPhotoUrls = [park.photoUrl].concat(loaded);
      enterCarouselMode(card, park);
    });
    return;
  }

  // --- ‹ › arrow tap → show the previous/next slide (desktop input) ---
  var navBtn = e.target.closest('.photo-nav');
  if (navBtn) {
    var hero = navBtn.closest('.card-hero');
    var navCard = navBtn.closest('.result-card');
    if (!hero || !navCard) return;
    var navPid = navCard.getAttribute('data-place-id');
    var navPark = currentResults.find(function (r) { return r.placeId === navPid; });
    var dir = parseInt(navBtn.getAttribute('data-dir'), 10) || 1;
    moveCarousel(hero, navPark, dir);
    return;
  }
});

// ---- Swipe the photo carousel on touch devices ----
// On phones, swiping a photo left/right is the natural gesture (the ‹ › arrows
// are hidden via CSS on touch). We listen on the results list so it keeps
// working after re-renders. We only act on a clearly HORIZONTAL swipe so we
// never hijack the user's vertical scroll through the list.
(function () {
  var list = document.getElementById('results-list');
  if (!list) return;
  var startX = 0, startY = 0, swipeHero = null;

  list.addEventListener('touchstart', function (e) {
    // Only arm a swipe if the touch started on a carousel-active hero.
    var hero = e.target.closest('.card-hero[data-photo-index]');
    if (!hero) { swipeHero = null; return; }
    var t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    swipeHero = hero;
  }, { passive: true });

  list.addEventListener('touchend', function (e) {
    if (!swipeHero) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) { swipeHero = null; return; }
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    // Horizontal intent: moved far enough sideways, and more sideways than up/down.
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      var card = swipeHero.closest('.result-card');
      var pid = card && card.getAttribute('data-place-id');
      var park = currentResults.find(function (r) { return r.placeId === pid; });
      // Swipe left → next photo; swipe right → previous photo.
      moveCarousel(swipeHero, park, dx < 0 ? 1 : -1);
      // Note the time so the card-click handler can ignore the synthetic click
      // some browsers fire right after a swipe (which would pan the map).
      lastCarouselSwipeAt = Date.now();
    }
    swipeHero = null;
  }, { passive: true });
})();

// ---- V8 F1: "Details" expand/collapse toggle ----
// Cards render COLLAPSED by default (just photo + name + distance/rating +
// the open-now pill + the icon strip). Tapping "Details" reveals the rest
// (address, hours, full signals grid, amenities, reviews, notes, links).
// We stopPropagation so this tap never bubbles to the card-click handler that
// pans the map — the two interactions must stay separate.
document.getElementById('results-list').addEventListener('click', function (e) {
  var toggle = e.target.closest('.card-expand-toggle');
  if (!toggle) return;
  e.stopPropagation();
  var card = toggle.closest('.result-card');
  if (!card) return;
  var nowExpanded = card.classList.toggle('is-expanded');
  toggle.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');
  // Swap the caret glyph (down = "expand me", up = "collapse me") while keeping
  // the word "Details" in place. We only touch the caret span, not the label.
  var caret = toggle.querySelector('.expand-caret');
  if (caret) caret.textContent = nowExpanded ? '⌃' : '⌄';
});

// ---- Event: card click → pan map to marker ----
document.getElementById('results-list').addEventListener('click', function (e) {
  // V7 F8: taps on the photo carousel controls are handled by the listener
  // above — bail out here so they don't ALSO pan the map.
  // V8 F1: the "Details" toggle (and its caret) is handled by its own listener
  // below — bail here too so expanding a card never also pans the map.
  if (e.target.closest('.photo-more-badge')
    || e.target.closest('.photo-nav')
    || e.target.closest('.photo-dots')
    || e.target.closest('.card-expand-toggle')
    // Anything inside the "Ask about this park" box (chips, input, Ask
    // button, the answer itself) is its own interaction — tapping or
    // clicking-to-type in there must never also pan the map.
    || e.target.closest('.ask-section')) {
    return;
  }
  // A swipe just flipped a photo — ignore the synthetic click some touch
  // browsers fire afterward, so the map doesn't pan when the user only swiped.
  if (Date.now() - lastCarouselSwipeAt < 400) return;

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
    // V10 F1: single parks share a rich "playdate card" message (name +
    // known features + directions), not just a bare link. Search/collection
    // shares keep their plain-URL behavior via shareUrl.
    if (park) sharePlaydate(park);
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
    // On TOUCH/mobile devices the Leaflet popup covers nearly the whole map,
    // which is painful on a small screen — the card already shows every piece
    // of info the popup would. So on coarse-pointer devices (phones, tablets,
    // touchscreen laptops) we skip openPopup() and instead briefly pulse the
    // marker for ~2 seconds so the user gets a clear "here it is" signal
    // without occluding the map. Marker tap (handled separately) still opens
    // the popup since the user specifically asked about THAT pin.
    var isCoarsePointer = window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches;
    if (isCoarsePointer) {
      if (marker._icon) {
        marker._icon.classList.add('marker-highlight');
        setTimeout(function () {
          if (marker._icon) marker._icon.classList.remove('marker-highlight');
        }, 2000);
      }
    } else {
      marker.openPopup();
    }
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
      // U9: geolocation worked — NOW it's safe to retire the landing CTA.
      // (On failure it stays visible so the user can simply tap it again.)
      var nearMeCta = document.getElementById('near-me-cta');
      if (nearMeCta) nearMeCta.classList.add('hidden');
      handleCoordinates(position.coords.latitude, position.coords.longitude, 'gps');
    },
    function (err) {
      // Tailor the message to the error so users know what to do next
      var msg;
      if (err && err.code === 1) {
        msg = 'Location permission denied. Type an address below instead.';
      } else if (err && err.code === 3) {
        msg = 'Location lookup timed out. Try typing an address instead.';
      } else {
        msg = 'We couldn\u2019t get your location. Type an address below instead.';
      }
      showMessage(msg, 'info');
      // Move focus to the address input to nudge the user toward the fallback
      addressInput.focus();
      // FIX 9: geolocation failed, but a returning user may still have a saved
      // home — surface the "🏠 Take me home" button so they have a one-tap way
      // back even though this search never started.
      refreshHomeButton();
    },
    { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
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
  recents.forEach(function (r, i) {
    // FIX B1: ids match the keyboard-nav order (header row doesn't get one).
    html += '<div class="suggestion-item" role="option" id="suggestion-' + i + '" aria-selected="false"'
      + ' data-lat="' + escapeHtml(r.lat) + '"'
      + ' data-lng="' + escapeHtml(r.lng) + '"'
      + ' data-label="' + escapeHtml(r.label) + '">'
      + '<span class="suggestion-recent-icon">\ud83d\udd50</span> '
      + escapeHtml(r.label)
      + '</div>';
  });
  addressSuggestions.innerHTML = html;
  addressSuggestions.classList.remove('hidden');
  selectedSuggestionIdx = -1;
  addressInput.removeAttribute('aria-activedescendant');
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
    handleCoordinates(home.lat, home.lng, { lat: home.lat, lng: home.lng, label: home.label });
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
    if (status) {
      status.textContent = 'Saving…';
      // FIX 11: clear any prior failure styling so a retry starts looking clean.
      status.classList.remove('save-failed');
    }
    clearTimeout(noteSaveTimers[pid]);
    noteSaveTimers[pid] = setTimeout(function () {
      // FIX E3: setNote now returns boolean. Surface failures (storage full,
      // private-browsing throwing QuotaExceeded) instead of pretending it saved.
      var ok = setNote(pid, ta.value);
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
        if (ok) {
          // FIX 11: clear the warning styling — a successful save should wipe
          // any earlier "not saved" state so it doesn't linger misleadingly.
          status.classList.remove('save-failed');
          status.textContent = 'Saved ✓';
          setTimeout(function () { if (status) status.textContent = ''; }, 1200);
        } else {
          // FIX 11: make failure unmistakable. The old "Couldn't save (storage
          // full)" looked the same weight as "Saved ✓", so users assumed it
          // saved. Now it gets a warning glyph + a CSS class for emphasis, and
          // we DON'T auto-clear it — the warning stays until the next save.
          status.textContent = '⚠ Not saved — storage full';
          status.classList.add('save-failed');
        }
      }
    }, 600);
  });
})();

// ---- "Ask about this park" — preset chips, free-text input, and the ask flow ----
// Listeners are DELEGATED to #results-list (like the note auto-save above):
// cards get rebuilt via innerHTML on every filter/sort change, which would
// silently wipe any listener attached to a card itself. Delegation is also
// the only option under our CSP, which blocks inline onclick= handlers.
//
// Re-render note: those same rebuilds clear any answer that was showing —
// acceptable for v1, because the localStorage cache below makes re-asking
// the exact same question instant (and free).
(function () {
  var list = document.getElementById('results-list');
  if (!list) return;

  list.addEventListener('click', function (e) {
    // Preset chip tap → copy its question into the input, then ask right away.
    var preset = e.target.closest('.ask-preset');
    if (preset) {
      // stopPropagation so this tap never ALSO reaches the card-tap handler
      // that pans the map (belt: the bail-out list there; suspenders: this).
      e.stopPropagation();
      var presetSection = preset.closest('.ask-section');
      if (!presetSection) return;
      var presetInput = presetSection.querySelector('.ask-input');
      if (presetInput) presetInput.value = preset.textContent;
      runAsk(presetSection);
      return;
    }
    // The Ask button next to the free-text input.
    var askBtn = e.target.closest('.ask-btn');
    if (askBtn) {
      e.stopPropagation();
      var btnSection = askBtn.closest('.ask-section');
      if (btnSection) runAsk(btnSection);
      return;
    }
  });

  // Pressing Enter in the question input = tapping Ask. (Delegated for the
  // same rebuilt-cards reason; we guard on e.key so normal typing is untouched.)
  list.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var input = e.target.closest('.ask-input');
    if (!input) return;
    e.preventDefault(); // Enter shouldn't submit anything else on the page
    var section = input.closest('.ask-section');
    if (section) runAsk(section);
  });

  // Answers are cached per park + question so re-asking is instant and costs
  // nothing. No expiry needed in v1: reviews change slowly, so an answer from
  // last month is almost always still right.
  var ASK_CACHE_PREFIX = 'playgroundFinder.ask.';

  function loadCachedAnswer(placeId, question) {
    try {
      var raw = localStorage.getItem(ASK_CACHE_PREFIX + placeId + '.' + question.toLowerCase());
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed.answer === 'string') ? parsed.answer : null;
    } catch (e) { return null; }
  }

  function saveCachedAnswer(placeId, question, answer) {
    try {
      localStorage.setItem(
        ASK_CACHE_PREFIX + placeId + '.' + question.toLowerCase(),
        JSON.stringify({ answer: answer, ts: Date.now() })
      );
    } catch (e) { /* storage full — the answer still shows, it just won't cache */ }
  }

  // Put text (an answer, the loading line, or an error) into the answer box.
  // SECURITY: everything lands via textContent, never innerHTML — the answer
  // is derived from public Google reviews (anyone can write one), so we treat
  // it as untrusted text even though the server already sanitized it. The
  // little "based on N reviews" line is built with createElement for the same
  // reason (N is just a number, but the habit is what keeps us safe).
  function showAnswer(section, text, isLoading, reviewCount) {
    var box = section.querySelector('.ask-answer');
    if (!box) return;
    box.classList.remove('hidden');
    box.classList.toggle('ask-answer-loading', !!isLoading);
    box.textContent = text;
    if (!isLoading && reviewCount) {
      var grounding = document.createElement('div');
      grounding.className = 'ask-grounding';
      grounding.textContent = 'based on ' + reviewCount + ' reviews';
      box.appendChild(grounding);
    }
  }

  // Grey out the Ask button + preset chips while a question is in flight, so
  // an impatient double-tap can't fire two Gemini calls for one question.
  function setBusy(section, busy) {
    section.querySelectorAll('.ask-btn, .ask-preset').forEach(function (btn) {
      btn.disabled = busy;
    });
  }

  function runAsk(section) {
    var placeId = section.getAttribute('data-place-id');
    var park = currentResults.find(function (r) { return r.placeId === placeId; });
    var input = section.querySelector('.ask-input');
    var question = input ? input.value.trim() : '';
    // Under 3 chars can't be a real question — quietly do nothing rather
    // than scold the user for a stray keypress.
    if (!park || question.length < 3) return;

    // Reviews on currentResults are {text, publishTime} objects (see the
    // /api/places response handling), but older cached or shared shapes may
    // be plain strings — handle both. Send at most 10; the server caps there
    // anyway, so trimming client-side just saves upload bytes.
    var reviewTexts = (park.reviews || []).slice(0, 10).map(function (rv) {
      return (rv && rv.text) ? rv.text : String(rv);
    });

    // Cache first: same park + same question → answer appears instantly.
    var cached = loadCachedAnswer(placeId, question);
    if (cached) {
      showAnswer(section, cached, false, reviewTexts.length);
      return;
    }

    setBusy(section, true);
    showAnswer(section, 'Reading the reviews…', true);

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question,
        parkName: park.name,
        reviews: reviewTexts
      })
    })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        var answer = (data && typeof data.answer === 'string') ? data.answer : null;
        if (answer) {
          showAnswer(section, answer, false, reviewTexts.length);
          saveCachedAnswer(placeId, question, answer);
        } else {
          // Covers Gemini being down, no API key, or a network blip — one
          // calm message, no scary details.
          showAnswer(section, 'Couldn’t get an answer right now — try again in a minute.', false);
        }
      })
      .catch(function () {
        showAnswer(section, 'Couldn’t get an answer right now — try again in a minute.', false);
      })
      .then(function () { setBusy(section, false); });
  }
})();

// ---- Address autocomplete (Nominatim) ----
var addressSuggestions = document.getElementById('address-suggestions');
var suggestionsDebounce = null;
var suggestionsRequestId = 0;
// FIX B1: track currently-highlighted suggestion for keyboard ArrowUp/Down.
var selectedSuggestionIdx = -1;
// FIX B2: flag set while a finger/mouse is pressed on a suggestion, so the
// blur handler doesn't fire hideSuggestions() before the tap registers (iOS).
var suggestionMouseDown = false;

function hideSuggestions() {
  addressSuggestions.classList.add('hidden');
  addressSuggestions.innerHTML = '';
  selectedSuggestionIdx = -1;
  addressInput.removeAttribute('aria-activedescendant');
}

// FIX B1: visually mark which suggestion is currently keyboard-highlighted,
// and update aria-activedescendant on the input for screen readers.
function updateSuggestionHighlight() {
  var items = addressSuggestions.querySelectorAll('.suggestion-item');
  items.forEach(function (el, i) {
    var sel = i === selectedSuggestionIdx;
    el.classList.toggle('selected', sel);
    el.setAttribute('aria-selected', sel ? 'true' : 'false');
  });
  if (selectedSuggestionIdx >= 0 && items[selectedSuggestionIdx]) {
    addressInput.setAttribute('aria-activedescendant', 'suggestion-' + selectedSuggestionIdx);
    // Keep the highlighted item in view if the list is scrollable.
    try { items[selectedSuggestionIdx].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  } else {
    addressInput.removeAttribute('aria-activedescendant');
  }
}

// Build a "viewbox" query-string fragment for Nominatim that BIASES results
// toward the user's known region without excluding the rest of the world.
// We use lastLat/lastLng if we have it (most recent search center), else the
// saved Home location. The box is ~4 degrees in each direction — roughly a
// 280-mile radius — wide enough to comfortably cover a US state or a Brazilian
// metro region. `bounded=0` keeps it a SOFT bias: faraway matches still appear
// in the dropdown, they just rank below nearby ones for ambiguous queries.
// Returns '' (empty string) when we have no anchor location yet, so first-time
// users get unfiltered global results.
function getRegionBias() {
  var anchorLat = (typeof lastLat === 'number') ? lastLat : null;
  var anchorLng = (typeof lastLng === 'number') ? lastLng : null;
  if (anchorLat == null || anchorLng == null) {
    var home = getHome();
    if (home && typeof home.lat === 'number' && typeof home.lng === 'number') {
      anchorLat = home.lat;
      anchorLng = home.lng;
    }
  }
  if (anchorLat == null || anchorLng == null) return '';
  var d = 4; // degrees
  var left   = anchorLng - d;
  var right  = anchorLng + d;
  var top    = anchorLat + d;
  var bottom = anchorLat - d;
  return '&viewbox=' + left + ',' + top + ',' + right + ',' + bottom + '&bounded=0';
}

function fetchSuggestions(query) {
  var thisRequest = ++suggestionsRequestId;
  var url = 'https://nominatim.openstreetmap.org/search'
    + '?q=' + encodeURIComponent(query)
    + '&format=json'
    + getRegionBias()
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
  items.forEach(function (item, i) {
    var label = item.display_name || '';
    // FIX B1: ids + aria-selected let screen readers announce which option is active.
    html += '<div class="suggestion-item" role="option" id="suggestion-' + i + '" aria-selected="false"'
      + ' data-lat="' + escapeHtml(item.lat) + '"'
      + ' data-lng="' + escapeHtml(item.lon) + '"'
      + ' data-label="' + escapeHtml(label) + '">'
      + escapeHtml(label)
      + '</div>';
  });
  addressSuggestions.innerHTML = html;
  addressSuggestions.classList.remove('hidden');
  selectedSuggestionIdx = -1; // reset highlight every time the list re-renders
  addressInput.removeAttribute('aria-activedescendant');
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
  handleCoordinates(lat, lng, { lat: lat, lng: lng, label: label });
});

// Hide the dropdown when clicking outside the search area
document.addEventListener('click', function (e) {
  if (!e.target.closest('.search-wrap')) {
    hideSuggestions();
  }
});

// FIX B2: track when the user is mid-tap on a suggestion so the blur
// handler doesn't hide the list out from under them. mousedown/pointerdown
// fire BEFORE blur, mouseup/pointerup fire AFTER click — the flag stays true
// long enough to bridge the gap on flaky iOS Safari.
addressSuggestions.addEventListener('mousedown', function () { suggestionMouseDown = true; });
addressSuggestions.addEventListener('pointerdown', function () { suggestionMouseDown = true; });
addressSuggestions.addEventListener('mouseup', function () { suggestionMouseDown = false; });
addressSuggestions.addEventListener('pointerup', function () { suggestionMouseDown = false; });

// Hide when input loses focus — but only if the user isn't actively tapping a
// suggestion. The 250ms timeout is a safety net for browsers that don't fire
// the mousedown/pointerdown events reliably.
addressInput.addEventListener('blur', function () {
  setTimeout(function () {
    if (!suggestionMouseDown) hideSuggestions();
  }, 250);
});

// FIX B1: keyboard navigation for suggestions (Arrow keys + Enter + Escape).
addressInput.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { hideSuggestions(); return; }
  var visible = !addressSuggestions.classList.contains('hidden');
  var items = visible ? addressSuggestions.querySelectorAll('.suggestion-item') : [];
  if (e.key === 'ArrowDown') {
    if (items.length === 0) return;
    e.preventDefault();
    selectedSuggestionIdx = (selectedSuggestionIdx + 1) % items.length;
    updateSuggestionHighlight();
  } else if (e.key === 'ArrowUp') {
    if (items.length === 0) return;
    e.preventDefault();
    selectedSuggestionIdx = (selectedSuggestionIdx - 1 + items.length) % items.length;
    updateSuggestionHighlight();
  } else if (e.key === 'Enter') {
    if (selectedSuggestionIdx >= 0 && items[selectedSuggestionIdx]) {
      // Simulate click on the highlighted suggestion (lets the existing handler do its job).
      e.preventDefault();
      items[selectedSuggestionIdx].click();
    }
    // Otherwise let the form submit naturally.
  }
});

// ---- "Search this area" \u2192 re-run search at the current map center ----
searchHereBtn.addEventListener('click', function () {
  if (!map) return;
  var center = map.getCenter();
  addressInput.value = MAP_AREA_LABEL;

  // U6: match the search radius to what the user is actually looking at.
  // If they zoomed out to see the whole city and tap "Search this area",
  // searching a half-mile dot at the center ignores most of their screen.
  // Measure the visible map in meters, take the smaller side, halve it
  // (radius, not diameter), convert to miles...
  try {
    var b = map.getBounds();
    var widthM = map.distance(b.getNorthWest(), b.getNorthEast());
    var heightM = map.distance(b.getNorthWest(), b.getSouthWest());
    var visibleMiles = Math.min(widthM, heightM) / 2 / 1609.344;
    // ...then pick the LARGEST allowed radius that still fits on screen
    // (or the smallest, half a mile, if they're zoomed way in).
    var allowedRadii = ['0.5', '1', '2', '5'];
    var best = '0.5';
    for (var i = 0; i < allowedRadii.length; i++) {
      if (parseFloat(allowedRadii[i]) <= visibleMiles) best = allowedRadii[i];
    }
    radiusSelect.value = best;
    savePref('playgroundFinder.radius', best);
  } catch (e) { /* keep current radius if anything goes sideways */ }

  // No human label here (user clicked a map area, not a named place) — coords only
  handleCoordinates(center.lat, center.lng, { lat: center.lat, lng: center.lng });
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
    + getRegionBias()
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
      handleCoordinates(resolvedLat, resolvedLng, { lat: resolvedLat, lng: resolvedLng, label: address });
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
    // U9: do NOT hide the CTA here. If geolocation fails (permission denied,
    // timeout), hiding it would leave the user with no obvious way to retry.
    // The geolocation SUCCESS callback hides it instead — by then a real
    // search is underway and the landing CTA has done its job.
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

// V10 F1: the human-readable "playdate card" message that rides along with a
// single-park share. Built ONLY from things we actually know — unknown / "no" /
// still-loading signals are skipped entirely, so we never advertise a bathroom
// we're not sure exists. This is plain TEXT for the share sheet / clipboard
// (never dropped into the page as HTML), so raw park fields are safe here.
function buildPlaydateText(park) {
  var lines = ['Meet at ' + park.name + '!'];
  var feats = [];
  // Only brag "open now" when Google positively said so (openNow can be null).
  if (park.openNow === true) feats.push('🟢 open now');
  // Defensive reads: signals may be missing entirely on shared-link parks,
  // and blobs cached before V10 F3 won't have changingTable at all.
  var sig = park.signals || {};
  function val(dim) { return sig[dim] && sig[dim].value; }
  if (val('fenced') === 'yes') feats.push('🔒 fenced');
  if (val('shade') === 'yes') feats.push('🌳 shade');
  if (val('bathrooms') === 'yes') {
    // V10 F3: mention the changing table when we know there is one.
    feats.push(val('changingTable') === 'yes' ? '🚻 bathrooms with changing table' : '🚻 bathrooms');
  }
  var age = val('ageSuitability');
  if (age === 'toddler' || age === 'both') feats.push('👶 toddler-friendly');
  var pk = val('parking');
  if (pk === 'lot' || pk === 'street' || pk === 'both') feats.push('🅿️ parking');
  if (val('tennisCourts') === 'yes') feats.push('🎾 tennis');
  if (feats.length > 0) lines.push(feats.join(' · '));
  lines.push('🚗 Directions: ' + googleDirectionsUrl(park.placeId, park.name, park.lat, park.lng));
  return lines.join('\n');
}

// Encode the user's full saved-parks collection into a URL the recipient can open.
// Each park is reduced to just placeId/name/lat/lng/type to keep the URL short.
function buildShareUrlForSavedParks() {
  var saved = getAllSavedParks();
  if (saved.length === 0) return null;
  var compact = saved.map(function (p) {
    return { i: p.placeId, n: p.name, a: +p.lat.toFixed(5), o: +p.lng.toFixed(5), t: p.type };
  });
  var json = JSON.stringify(compact);
  // base64 with Unicode-safe encoding
  var encoded = btoa(unescape(encodeURIComponent(json)));
  var u = new URL(window.location.origin + window.location.pathname);
  u.searchParams.set('shared', encoded);
  return u.toString();
}

function decodeSharedParks(encoded) {
  try {
    var json = decodeURIComponent(escape(atob(encoded)));
    var compact = JSON.parse(json);
    if (!Array.isArray(compact)) return null;
    // Cap shared collection size to protect against malicious URLs trying to
    // overload localStorage or render thousands of cards.
    if (compact.length > 100) compact = compact.slice(0, 100);
    return compact.map(function (p) {
      return {
        // SECURITY: the placeId ends up inside HTML attributes when cards
        // render (data-place-id="..."), so a crafted share link could sneak
        // in a `">` and break out of the attribute to inject its own HTML.
        // Real Google place IDs only ever contain letters, numbers,
        // underscores and hyphens — anything else gets rejected to '' here,
        // which makes the .filter() below drop the whole entry.
        placeId: typeof p.i === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(p.i) ? p.i : '',
        name: typeof p.n === 'string' ? p.n.substring(0, 200) : '',
        lat: typeof p.a === 'number' ? p.a : 0,
        lng: typeof p.o === 'number' ? p.o : 0,
        type: p.t === 'playground' ? 'playground' : 'park',
        rating: null,
        reviewCount: 0,
        photoUrl: null,
        photoAttribution: null,
        openNow: null,
        todayHours: null,
        reviews: [],
        signals: defaultSignalsClient()
      };
    }).filter(function (p) { return p.placeId && p.name && p.lat && p.lng; });
  } catch (e) { return null; }
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
  // FIX D2: split user-cancelled (AbortError, silent) from real failures
  // (need to fall back to clipboard so the user still gets the link somehow).
  function clipboardFallback() {
    copyToClipboard(url).then(function () {
      showMessage((label || 'Link') + ' copied to clipboard!', 'success');
    }).catch(function () {
      showMessage("Couldn't copy link — long-press the address bar to share.", 'info');
    });
  }
  if (navigator.share) {
    navigator.share({ title: 'Playground Finder', url: url }).catch(function (err) {
      // AbortError = user dismissed the share sheet on purpose; stay silent.
      if (err && err.name === 'AbortError') return;
      clipboardFallback();
    });
  } else {
    clipboardFallback();
  }
}

// V10 F1: single-park share — same shape as shareUrl above, but with the rich
// playdate message as `text`. The app link goes in the share sheet's `url`
// field (NOT inside the text) so platforms don't print the link twice; the
// clipboard fallback joins text + url into one paste-able block instead.
function sharePlaydate(park) {
  var url = buildShareUrlForPark(park);
  var text = buildPlaydateText(park);
  function clipboardFallback() {
    copyToClipboard(text + '\n' + url).then(function () {
      showMessage('Park link copied to clipboard!', 'success');
    }).catch(function () {
      showMessage("Couldn't copy link — long-press the address bar to share.", 'info');
    });
  }
  if (navigator.share) {
    navigator.share({ title: park.name, text: text, url: url }).catch(function (err) {
      // AbortError = user dismissed the share sheet on purpose; stay silent.
      if (err && err.name === 'AbortError') return;
      clipboardFallback();
    });
  } else {
    clipboardFallback();
  }
}

// U10: build the "Someone shared N parks with you!" banner. Built with DOM
// APIs (createElement + addEventListener) instead of innerHTML with inline
// onclick attributes, because our Content-Security-Policy blocks inline
// event handlers. The park names come from a URL someone else crafted, so
// nothing user-controlled is ever inserted as HTML here anyway.
function showSharedImportBanner(sharedParks) {
  var n = sharedParks.length;

  var banner = document.createElement('div');
  banner.className = 'shared-import-banner';

  var text = document.createElement('p');
  text.className = 'shared-import-text';
  text.textContent = '🎁 Someone shared ' + n + ' park' + (n > 1 ? 's' : '') + ' with you!';
  banner.appendChild(text);

  var actions = document.createElement('div');
  actions.className = 'shared-import-actions';

  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'shared-import-btn shared-import-accept';
  addBtn.textContent = '➕ Add to my saved';
  addBtn.addEventListener('click', function () {
    var favs = getFavorites();
    var map = getSavedParksMap();
    var added = 0;
    sharedParks.forEach(function (p) {
      if (favs.indexOf(p.placeId) === -1) {
        favs.push(p.placeId);
        added++;
      }
      // Always update the map (in case the snapshot has fresher info)
      map[p.placeId] = sanitizeParkForStorage(p);
    });
    setFavorites(favs);
    setSavedParksMap(map);
    banner.remove();
    showMessage(added + ' new park' + (added !== 1 ? 's' : '') + ' added to your saved collection.', 'success');
    // Switch to Saved tab to show them
    var savedBtn = document.querySelector('.type-btn[data-type="favorites"]');
    if (savedBtn) savedBtn.click();
  });

  var noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'shared-import-btn shared-import-decline';
  noBtn.textContent = '👀 No thanks';
  noBtn.addEventListener('click', function () {
    banner.remove();
    showMessage('No problem — nothing was saved.', 'info');
  });

  actions.appendChild(addBtn);
  actions.appendChild(noBtn);
  banner.appendChild(actions);

  // Insert at the very top of <main>, above the hero, so it's the first
  // thing the recipient sees when they open the link.
  var main = document.querySelector('main');
  if (main) main.insertBefore(banner, main.firstChild);
}

// On page load, parse the URL and trigger the right action
function handleSharedUrl() {
  var params = new URLSearchParams(window.location.search);
  var lat = parseFloat(params.get('lat'));
  var lng = parseFloat(params.get('lng'));
  var radius = params.get('radius');
  var park = params.get('park');
  var address = params.get('address');
  var shared = params.get('shared');

  // Shared collection: someone sent you their saved parks.
  // U10: this used to be a window.confirm() popup — jarring, system-styled,
  // and it blocks the page before you've even seen the app. Now it's a
  // friendly sticker-style banner at the top of the page that the user can
  // act on (or ignore) in their own time.
  if (shared) {
    var sharedParks = decodeSharedParks(shared);
    if (sharedParks && sharedParks.length > 0) {
      showSharedImportBanner(sharedParks);
      return;
    }
  }

  if (!isNaN(lat) && !isNaN(lng)) {
    if (radius) {
      var allowed = ['0.5', '1', '2', '5'];
      if (allowed.indexOf(radius) !== -1) {
        radiusSelect.value = radius;
        savePref('playgroundFinder.radius', radius);
      }
    }
    addressInput.value = park ? 'Shared park' : 'Shared location';
    // Shared link — no human address text; coords only (will show as a pin)
    handleCoordinates(lat, lng, { lat: lat, lng: lng });
    if (park) {
      // FIX 8: once results render, scroll to the shared park's card. If the
      // card never shows up, the park is most likely just outside the current
      // radius — so instead of dead-ending, we auto-widen the radius one step
      // and search again (0.5 → 1 → 2 → 5 miles). The widenSteps counter plus
      // the '5'-mile ceiling guarantee this can't loop forever.
      var widenRadii = ['0.5', '1', '2', '5'];
      var attempts = 0;
      var trySelect = function () {
        var card = document.querySelector('.result-card[data-place-id="' + park + '"]');
        if (card) {
          scrollToCard(park);
          // WHY: the card can render BEFORE Leaflet finishes loading, so the
          // map's fitBounds happened without this pin in view. Pan the map to
          // the shared pin now (mirrors the card-click handler). All guarded —
          // if the marker isn't on the map yet, fitBounds already centered us.
          var sharedMarker = markersByPlaceId[park];
          if (sharedMarker && map) {
            map.panTo(sharedMarker.getLatLng());
          }
        } else if (attempts++ < 20) {
          setTimeout(trySelect, 300);
        } else {
          // Gave up at this radius. Try one step wider if we're not already at 5 miles.
          var current = radiusSelect.value;
          var idx = widenRadii.indexOf(current);
          if (idx !== -1 && idx < widenRadii.length - 1) {
            var newRadius = widenRadii[idx + 1];
            radiusSelect.value = newRadius;
            savePref('playgroundFinder.radius', newRadius);
            showMessage('Looking a little wider for the shared park…', 'info');
            // Re-run the same shared search at the wider radius, then restart
            // the poll from scratch (reset attempts) so it has a fresh 20 tries.
            handleCoordinates(lat, lng, { lat: lat, lng: lng });
            attempts = 0;
            setTimeout(trySelect, 1500);
          } else {
            // Already at the widest radius and still nothing — truly not found.
            showMessage("We couldn’t find the shared park nearby — it may have been removed from the map.", 'info');
          }
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

// ---- Share button: context-switches between "share search" and "share saved" ----
(function () {
  var btn = document.getElementById('share-view-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var typeFilter = getTypeFilter();
    if (typeFilter === 'favorites') {
      var url = buildShareUrlForSavedParks();
      if (!url) {
        showMessage('No saved parks to share. Tap ★ on a park to save it first.', 'info');
        return;
      }
      shareUrl(url, 'Saved-parks link');
    } else {
      if (lastLat === null || lastLng === null) {
        showMessage('Search a location first to share it.', 'info');
        return;
      }
      shareUrl(buildShareUrlForSearch(lastLat, lastLng, getRadius()), 'Search link');
    }
  });
})();

// Update the share button label to reflect what it'll share
function refreshShareButtonLabel() {
  var btn = document.getElementById('share-view-btn');
  if (!btn) return;
  btn.textContent = getTypeFilter() === 'favorites' ? '🔗 Share saved' : '🔗 Share search';
}

// ---- L4: mobile "⬆️ Filters" pill ----
// On phones the filter toolbar scrolls away with the page (a deliberate
// choice — sticky toolbars eat too much of a small screen). The trade-off:
// once you're 10 cards deep, changing a filter means a long scroll back up.
// This floating pill appears only while the toolbar is off-screen and taps
// you straight back to it. Desktop never shows it (CSS hides it ≥768px).
(function () {
  var pill = document.getElementById('filters-pill');
  var toolbar = document.getElementById('results-toolbar');
  var footer = document.querySelector('.site-footer');
  if (!pill || !toolbar) return;

  // We DELIBERATELY use a direct scroll-position check rather than an
  // IntersectionObserver here. Observers fire asynchronously and the footer's
  // intersection timing differed going down vs. up, which made the pill appear
  // on scroll-up but not scroll-down. A per-scroll geometry check is fully
  // deterministic — same result at a given scroll position regardless of
  // direction. Toggling one class on a passive scroll listener is cheap.
  var PILL_ZONE = 64; // px at the very bottom where the pill floats (bottom:1rem + height)

  function update() {
    // Before any search the toolbar carries class 'hidden' (display:none) — no pill.
    if (toolbar.classList.contains('hidden')) { pill.classList.add('hidden'); return; }
    var tb = toolbar.getBoundingClientRect();
    var toolbarGone = tb.bottom <= 0;            // filter bar has scrolled above the viewport
    var footerEncroaching = false;
    if (footer) {
      var fb = footer.getBoundingClientRect();
      // Hide once the footer rises into the bottom zone where the pill sits,
      // so the pill never covers the About / Source links.
      footerEncroaching = fb.top <= (window.innerHeight - PILL_ZONE);
    }
    pill.classList.toggle('hidden', !(toolbarGone && !footerEncroaching));
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();

  pill.addEventListener('click', function () {
    toolbar.scrollIntoView({ behavior: 'smooth' });
  });
})();

// ---- Initial: handle URL share params on page load + refresh button labels ----
handleSharedUrl();
refreshShareButtonLabel();

// ---- V9 F4: "↩ Back to <last place>" resume chip ----
// A returning visitor usually wants the same search as last time. Offer it
// as ONE tap — but only when nothing else is already in motion: no
// search-triggering URL params (a shared link should win), and no search
// already running. Runs AFTER handleSharedUrl() so a ?lat= link has already
// set lastLat by the time we check it.
(function () {
  var chip = document.getElementById('resume-chip');
  if (!chip) return;
  // (a) Mirror the params handleSharedUrl reacts to — if any is present the
  //     URL is (or may be) driving a search, so the resume offer would fight it.
  var params = new URLSearchParams(window.location.search);
  if (params.get('lat') !== null || params.get('park') !== null
    || params.get('shared') !== null || params.get('address') !== null) return;
  // (b) No search has started yet this page load.
  if (lastLat !== null) return;
  // (c) There's actually something to resume.
  var recents = getRecents();
  if (recents.length === 0) return;
  var recent = recents[0]; // getRecents() is newest-first
  if (!recent || typeof recent.lat !== 'number' || typeof recent.lng !== 'number' || !recent.label) return;
  var label = String(recent.label);
  // Keep the chip short — long addresses get trimmed to ~30 chars.
  var shortLabel = label.length > 30 ? label.slice(0, 30) + '…' : label;
  var text = '↩ Back to ' + shortLabel;
  // pushRecent stores ts: Date.now() — turn it into a coarse "how long ago".
  if (typeof recent.ts === 'number') {
    var age = formatCoarseAge(recent.ts);
    if (age) text += ' · ' + age;
  }
  // textContent (not innerHTML) so the stored label can't inject markup.
  chip.textContent = text;
  chip.classList.remove('hidden');
  chip.addEventListener('click', function () {
    addressInput.value = label;
    chip.classList.add('hidden');
    // Same originMode shape a typed-address search uses, so the Directions
    // links show the human-readable place name as their starting point.
    handleCoordinates(recent.lat, recent.lng, { lat: recent.lat, lng: recent.lng, label: label });
  });
})();

// ---- V10 F2: first-visit sample-search chips ----
// A brand-new visitor has no history and maybe no location handy — three
// tappable example cities put live results one tap away. Same conditions
// family as the resume chip above: nothing else may already be in motion.
// Note this is naturally mutually exclusive with the resume chip — the resume
// chip REQUIRES recents, and these chips require NO recents.
(function () {
  var wrap = document.getElementById('sample-chips');
  if (!wrap) return;
  // Tapping an example behaves exactly like typing that city: fill the box,
  // remember it (so the NEXT visit gets the resume chip instead of these),
  // and search. Delegated listener because CSP blocks inline onclick.
  wrap.addEventListener('click', function (e) {
    var chip = e.target.closest('.sample-chip');
    if (!chip) return;
    var lat = parseFloat(chip.getAttribute('data-lat'));
    var lng = parseFloat(chip.getAttribute('data-lng'));
    var label = chip.getAttribute('data-label');
    if (isNaN(lat) || isNaN(lng) || !label) return;
    addressInput.value = label;
    pushRecent(label, lat, lng);
    wrap.classList.add('hidden');
    handleCoordinates(lat, lng, { lat: lat, lng: lng, label: label });
  });
  // (a) No search-triggering URL params (mirrors handleSharedUrl / resume chip).
  var params = new URLSearchParams(window.location.search);
  if (params.get('lat') !== null || params.get('park') !== null
    || params.get('shared') !== null || params.get('address') !== null) return;
  // (b) No search already running this page load.
  if (lastLat !== null) return;
  // (c) Truly a first-timer: no recent searches AND no saved parks.
  if (getRecents().length > 0) return;
  if (getFavorites().length > 0) return;
  wrap.classList.remove('hidden');
})();

// V9 F4: a deliberately fuzzy "how long ago" — 'yesterday' / '3d ago' /
// '2w ago'. Returns '' for today (saying "today" adds nothing) and for
// anything so old the number stops being useful.
function formatCoarseAge(ts) {
  var days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (isNaN(days) || days <= 0) return '';
  if (days === 1) return 'yesterday';
  if (days < 14) return days + 'd ago';
  if (days < 60) return Math.floor(days / 7) + 'w ago';
  return '';
}
// FIX 9: surface the home button on cold load. refreshHomeButton() only ran
// after a search before, so a returning user with a saved home never saw the
// "🏠 Take me home" button until they searched again. It self-guards (hides
// itself when there's no home AND no current search), so this is safe to call
// here even with an empty page.
refreshHomeButton();

// ---- FIX D3: offline / online toast ----
// Without this, the SW happily serves stale cached results when offline and
// the user has no idea they're seeing yesterday's data.
window.addEventListener('offline', function () {
  showMessage("You're offline — showing last cached results.", 'info');
});
window.addEventListener('online', function () {
  showMessage("Back online!", 'success');
});

// ---- PWA: register the service worker (offline support + add to home screen) ----
if ('serviceWorker' in navigator) {
  // Wait until after the load event so SW registration doesn't fight for the network with first paint
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* registration failed — silently OK */ });
  });
}

// ---- V8 F2: Pull-to-refresh on touch devices ----
// On a phone, the natural way to say "check again" is to pull down from the top
// of the page — the same gesture you'd use in a native app. We watch for a
// downward drag that STARTS at the very top of the page (scrollY <= 0), show a
// little "Release to refresh" sticker once it's pulled far enough, and on
// release we simply re-run the current search.
//
// WHY no preventDefault: we register every listener as { passive: true }. That
// keeps scrolling buttery-smooth (the browser never has to wait to see if we'll
// cancel the scroll) and avoids the console warnings you get from calling
// preventDefault inside a passive listener. The trade-off is we can't block the
// browser's own overscroll bounce, but the gesture still reads fine.
(function () {
  // Build the floating indicator in JS so we don't have to touch index.html.
  // It lives at the top-center of the screen, hidden (translated up) by default,
  // and slides into view as the user pulls.
  var indicator = document.createElement('div');
  indicator.id = 'ptr-indicator';
  indicator.textContent = '↻ Pull to refresh';
  // Hidden from screen readers until it's actually doing something — it's a
  // touch-only visual affordance, not core content.
  indicator.setAttribute('aria-hidden', 'true');
  document.body.appendChild(indicator);

  var THRESHOLD = 70;   // px of pull needed before a release will refresh
  var MAX_PULL = 110;   // cap how far the sticker travels, so it can't fly off
  var startY = 0;       // where the finger first touched (only set when armed)
  var armed = false;    // did the gesture start at the top of the page?
  var ready = false;    // has the pull passed THRESHOLD (so release = refresh)?

  // Slide the sticker to a given pull distance (0 = hidden above the viewport).
  function setPull(dy) {
    // Map the raw pull distance onto how far the sticker shows, capped so it
    // settles near the top edge instead of drifting down the whole screen.
    var shown = Math.min(dy, MAX_PULL);
    // -100% hides it fully above the top; as `shown` grows it eases into view.
    var pct = -100 + (shown / MAX_PULL) * 100;
    indicator.style.transform = 'translateX(-50%) translateY(' + pct + '%)';
    indicator.style.opacity = String(Math.min(shown / THRESHOLD, 1));
  }

  // Animate the sticker back out of view and reset all gesture state.
  function reset() {
    armed = false;
    ready = false;
    indicator.style.transform = '';   // back to the CSS default (hidden)
    indicator.style.opacity = '';
    indicator.textContent = '↻ Pull to refresh';
    indicator.setAttribute('aria-hidden', 'true');
  }

  window.addEventListener('touchstart', function (e) {
    // Only arm if we're already scrolled to the very top — otherwise this is a
    // normal scroll and PTR must stay out of the way.
    if (window.scrollY <= 0 && e.touches && e.touches.length === 1) {
      startY = e.touches[0].clientY;
      armed = true;
      ready = false;
    } else {
      armed = false;
    }
  }, { passive: true });

  window.addEventListener('touchmove', function (e) {
    if (!armed) return;
    // If the user scrolled away from the top mid-gesture, disarm — we don't want
    // PTR firing after a scroll-up that didn't start as a pull.
    if (window.scrollY > 0) { reset(); return; }
    if (!e.touches || !e.touches.length) return;
    var dy = e.touches[0].clientY - startY;
    // Only react to a DOWNWARD pull. (Horizontal carousel swipes live on
    // .card-hero and never reach this code as a vertical pull from the top.)
    if (dy <= 0) { setPull(0); ready = false; return; }
    setPull(dy);
    indicator.setAttribute('aria-hidden', 'false');
    if (dy > THRESHOLD) {
      ready = true;
      indicator.textContent = '↻ Release to refresh';
    } else {
      ready = false;
      indicator.textContent = '↻ Pull to refresh';
    }
  }, { passive: true });

  window.addEventListener('touchend', function () {
    if (armed && ready) {
      // Re-run the CURRENT search. No third arg → searchOrigin is preserved, so
      // the Directions links keep their original origin. handleCoordinates bumps
      // requestId internally, so re-running while one is in flight is safe.
      if (lastLat !== null && lastLng !== null) {
        indicator.textContent = '↻ Refreshing…';
        // A leftover "Someone shared parks with you!" banner would sit on top
        // of the fresh results — clear it before re-searching.
        var staleBanner = document.querySelector('.shared-import-banner');
        if (staleBanner) staleBanner.remove();
        handleCoordinates(lastLat, lastLng);
      }
    }
    reset();
  }, { passive: true });

  // If a touch is cancelled (e.g. an incoming call, or the OS takes over),
  // tidy up so a stale sticker doesn't linger on screen.
  window.addEventListener('touchcancel', reset, { passive: true });
})();
