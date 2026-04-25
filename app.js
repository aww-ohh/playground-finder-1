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
var savedType = loadPref('playgroundFinder.typeFilter', ['all', 'playground', 'park'], 'all');
var savedRadius = loadPref('playgroundFinder.radius', ['0.5', '1', '2', '5'], '2');

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

// ---- Helper: filter results by type ----
function filterByType(results, typeFilter) {
  if (typeFilter === 'all') return results;
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

// ---- Helper: show the map and place markers ----
function showMap(lat, lng, results) {
  document.getElementById('map-section').classList.remove('hidden');

  if (!map) {
    map = L.map('map').setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    markerGroup.addTo(map);
  } else {
    map.flyTo([lat, lng], 13);
  }

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
    var popupRating;
    if (r.rating) {
      popupRating = renderStarsCompact(r.rating)
        + ' <span style="font-weight:700;font-size:0.8rem;">' + r.rating + '</span>'
        + ' <span style="font-size:0.75rem;color:#666;">(' + r.reviewCount.toLocaleString() + ' reviews)</span>';
    } else {
      popupRating = '<span style="font-size:0.75rem;color:#666;">No ratings yet</span>';
    }
    var popupTypeClass = r.type === 'playground' ? 'playground' : 'park';
    var popupContent = '<div class="popup-content">'
      + renderPopupPhoto(r)
      + '<div class="popup-body">'
      + '<strong>' + r.name + '</strong><br>'
      + '<span class="result-type result-type-compact ' + popupTypeClass + '">' + typeBadgeLabel(r.type) + '</span> ' + popupRating + '<br>'
      + '<a class="popup-link-google" href="' + googleMapsUrl(r.placeId) + '" target="_blank" rel="noopener noreferrer">View on Google Maps \u2192</a><br>'
      + '<a class="popup-link-yelp" href="' + yelpSearchUrl(r.name, r.lat, r.lng) + '" target="_blank" rel="noopener noreferrer">Search on Yelp</a>'
      + '</div>'
      + '</div>';
    var marker = L.marker([r.lat, r.lng])
      .bindPopup(popupContent)
      .addTo(markerGroup);
    markersByPlaceId[r.placeId] = marker;
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

  // Remove any existing filter message
  var existingMsg = resultsSection.querySelector('.filter-message');
  if (existingMsg) existingMsg.remove();

  if (currentResults.length === 0) {
    resultsSection.classList.add('hidden');
    resultsList.innerHTML = '';
    return;
  }

  resultsSection.classList.remove('hidden');

  if (results.length === 0) {
    // We have results but the filter hid them all
    var typeFilter = getTypeFilter();
    var msgText = typeFilter === 'playground'
      ? 'No playgrounds in your current results.'
      : 'No parks in your current results.';
    var filterMsg = document.createElement('p');
    filterMsg.className = 'filter-message';
    filterMsg.textContent = msgText;
    resultsSection.querySelector('.results-toolbar').after(filterMsg);
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

    html += '<li class="result-card" data-place-id="' + r.placeId + '">'
      + renderHeroPhoto(r)
      + '<div class="result-card-body">'
      + '<div class="result-card-header">'
      + '<span class="result-name">' + r.name + '</span>'
      + '<span class="result-type ' + typeClass + '">' + typeBadgeLabel(r.type) + '</span>'
      + '</div>'
      + '<span class="result-meta">' + r.distance + ' mi away</span>'
      + '<span class="result-meta result-rating">' + ratingHtml + '</span>'
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
          showMessage('Found ' + data.results.length + ' playgrounds and parks nearby.', 'success');
          currentResults = data.results;
          showMap(lat, lng, data.results);
          applyFilterAndSort();
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

// ---- Address form submission ----
addressForm.addEventListener('submit', function (e) {
  e.preventDefault();

  var address = addressInput.value.trim();
  if (!address) {
    showMessage('Please type an address or city name.', 'info');
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
