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
var savedSort = loadPref('playgroundFinder.sort', ['distance', 'rating', 'reviews'], 'distance');
var savedType = loadPref('playgroundFinder.typeFilter', ['all', 'playground', 'park', 'favorites'], 'playground');
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

// ---- Favorites (persisted in localStorage as an array of placeIds) ----
var FAVORITES_KEY = 'playgroundFinder.favorites';

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

// Returns true if it's now favorited, false if it was unfavorited
function toggleFavorite(placeId) {
  var favs = getFavorites();
  var idx = favs.indexOf(placeId);
  if (idx === -1) favs.push(placeId);
  else favs.splice(idx, 1);
  setFavorites(favs);
  return idx === -1;
}

// ---- Helper: filter results by type (or by favorited state) ----
function filterByType(results, typeFilter) {
  if (typeFilter === 'all') return results;
  if (typeFilter === 'favorites') {
    var favs = getFavorites();
    return results.filter(function (r) { return favs.indexOf(r.placeId) !== -1; });
  }
  return results.filter(function (r) { return r.type === typeFilter; });
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
  }
  return sorted;
}

// ---- Helper: type badge label with emoji ----
function typeBadgeLabel(type) {
  return type === 'playground' ? '\uD83D\uDEDD playground' : '\uD83C\uDF33 park';
}

// ---- Google Maps URL ----
function googleMapsUrl(placeId) {
  return 'https://www.google.com/maps/place/?q=place_id:' + placeId;
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
  if (!oldList) return;
  var temp = document.createElement('div');
  temp.innerHTML = renderSignals(signals);
  var newList = temp.firstChild;
  if (newList) oldList.replaceWith(newList);
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
    + '<a class="popup-link-google" href="' + googleMapsUrl(r.placeId) + '" target="_blank" rel="noopener noreferrer">View on Google Maps →</a><br>'
    + '<a class="popup-link-yelp" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
    + '</div>'
    + '</div>';
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
function updateMarkerVisibility(typeFilter) {
  Object.keys(markersByPlaceId).forEach(function (placeId) {
    var marker = markersByPlaceId[placeId];
    // Find the result to check its type
    var result = currentResults.find(function (r) { return r.placeId === placeId; });
    if (!result) return;

    if (typeFilter === 'all' || result.type === typeFilter) {
      if (!markerGroup.hasLayer(marker)) markerGroup.addLayer(marker);
    } else {
      if (markerGroup.hasLayer(marker)) markerGroup.removeLayer(marker);
    }
  });
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

  if (currentResults.length === 0) {
    resultsSection.classList.add('hidden');
    resultsToolbar.classList.add('hidden');
    if (fiveThingsStrip) fiveThingsStrip.classList.remove('hidden');
    resultsList.innerHTML = '';
    return;
  }

  resultsSection.classList.remove('hidden');
  resultsToolbar.classList.remove('hidden');
  if (fiveThingsStrip) fiveThingsStrip.classList.add('hidden');

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
    html += '<li class="result-card" data-place-id="' + r.placeId + '">'
      + '<button class="favorite-btn' + favClass + '" data-place-id="' + r.placeId + '" aria-label="Save to favorites" title="Save to favorites">★</button>'
      + renderHeroPhoto(r)
      + '<div class="result-card-body">'
      + '<div class="result-card-header">'
      + '<span class="result-name">' + r.name + '</span>'
      + '<span class="result-type ' + typeClass + '">' + typeBadgeLabel(r.type) + '</span>'
      + '</div>'
      + '<span class="result-meta">' + r.distance + ' mi away</span>'
      + '<span class="result-meta result-rating">' + ratingHtml + '</span>'
      + renderHours(r)
      + renderSignals(r.signals)
      + '<div class="result-links">'
      + '<a class="result-link" href="' + googleMapsUrl(r.placeId) + '" target="_blank" rel="noopener noreferrer">View on Google Maps \u2192</a>'
      + '<a class="result-link-secondary" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
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
  var filtered = filterByType(currentResults, typeFilter);
  var sorted = sortResults(filtered, sortBy);
  renderResults(sorted);
  updateMarkerVisibility(typeFilter);
}

// ---- Helper: called once we have coordinates ----
function handleCoordinates(lat, lng) {
  lastLat = lat;
  lastLng = lng;

  showMessage('Searching for playgrounds and parks\u2026', 'info');

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
            renderResults([]);
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

          // Phase 2: fetch signals for parks not in cache (in the background)
          if (needsSignals.length > 0) {
            fetchSignals(needsSignals, thisRequest);
          }
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

// ---- Event: type filter change ----
typeFilterDiv.addEventListener('click', function (e) {
  var btn = e.target.closest('.type-btn');
  if (!btn) return;
  typeFilterDiv.querySelectorAll('.type-btn').forEach(function (b) {
    b.classList.remove('active');
  });
  btn.classList.add('active');
  savePref('playgroundFinder.typeFilter', btn.getAttribute('data-type'));
  if (currentResults.length === 0) return;
  applyFilterAndSort();
});

// ---- Event: radius change → new API call ----
radiusSelect.addEventListener('change', function () {
  savePref('playgroundFinder.radius', radiusSelect.value);
  if (lastLat !== null && lastLng !== null) {
    handleCoordinates(lastLat, lastLng);
  }
});

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

  // Handle signal row expand/collapse
  var signalRow = e.target.closest('.signal-tappable');
  if (signalRow) {
    signalRow.classList.toggle('signal-expanded');
    return; // Don't also pan the map
  }

  var card = e.target.closest('.result-card');
  if (!card) return;
  if (e.target.closest('.result-link')) return;
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
});

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
      handleCoordinates(parseFloat(data[0].lat), parseFloat(data[0].lon));
    })
    .catch(function () {
      showMessage(
        'Something went wrong looking up that address. Please try again.',
        'info'
      );
    });
});
