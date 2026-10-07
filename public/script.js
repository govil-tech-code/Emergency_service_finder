// ================= MAP INITIALIZATION =================
const map = L.map("map").setView([28.6139, 77.2090], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// ================= CONFIG =================
const SEARCH_RADIUS = 5000; // meters
const MAX_RESULTS = 15;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

const CATEGORIES = {
    ambulance:    { label: "Ambulance",     icon: "\u{1F691}", filters: ['["emergency"="ambulance_station"]'] },
    hospital:     { label: "Hospitals",     icon: "\u{1F3E5}", filters: ['["amenity"="hospital"]'] },
    police:       { label: "Police",        icon: "\u{1F46E}", filters: ['["amenity"="police"]'] },
    fire_station: { label: "Fire Stations", icon: "\u{1F525}", filters: ['["amenity"="fire_station"]'] },
    blood_banks:  { label: "Blood Banks",   icon: "\u{1FA78}", filters: ['["amenity"="blood_bank"]', '["healthcare"="blood_donation"]'] },
    pharmacy:     { label: "Pharmacies",    icon: "\u{1FA79}", filters: ['["amenity"="pharmacy"]'] }
};

// ================= STATE =================
let serviceMarkers = [];
let userMarker = null;
let userLat = null;
let userLon = null;
let currentCategory = "hospital";

// ================= DOM ELEMENTS =================
const locationInput = document.getElementById("locationInput");
const findServicesBtn = document.getElementById("findServicesBtn");
const serviceCards = document.querySelectorAll(".service-card");
const listContainer = document.getElementById("nearbyList");
const viewAllBtn = document.getElementById("viewAllBtn");

const LOCATION_BTN_HTML =
    '<i class="fa-solid fa-location-crosshairs"></i> Use My Location';

// ================= HELPERS =================
function escapeHtml(text) {
    return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeCategory(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

// Distance in km (Haversine formula)
function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = function (deg) { return (deg * Math.PI) / 180; };
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildAddress(tags) {
    const parts = [
        [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
        tags["addr:suburb"],
        tags["addr:city"]
    ].filter(Boolean);
    return parts.join(", ");
}

function getPhone(tags) {
    const raw = tags.phone || tags["contact:phone"] || "";
    const first = raw.split(/[;,]/)[0];
    const clean = first.replace(/[^\d+]/g, "");
    return clean.length >= 3 ? clean : "";
}

function directionsUrl(lat, lon) {
    return "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lon;
}

function showMessage(className, text) {
    if (listContainer) {
        listContainer.innerHTML =
            '<p class="' + className + '">' + escapeHtml(text) + "</p>";
    }
}

// ================= USER LOCATION =================
function setUserLocation(lat, lon) {
    userLat = lat;
    userLon = lon;

    map.setView([lat, lon], 14);

    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([lat, lon])
        .addTo(map)
        .bindPopup("<b>\u{1F4CD} You are here</b>")
        .openPopup();
}

findServicesBtn.addEventListener("click", function () {
    if (!navigator.geolocation) {
        alert("Your browser does not support geolocation.");
        return;
    }

    findServicesBtn.innerHTML = "Finding...";

    navigator.geolocation.getCurrentPosition(
        async function (position) {
            setUserLocation(position.coords.latitude, position.coords.longitude);

            if (locationInput) {
                locationInput.value =
                    "Lat: " + userLat.toFixed(4) + ", Lon: " + userLon.toFixed(4);
            }
            findServicesBtn.innerHTML = LOCATION_BTN_HTML;

            await fetchAndRenderNearbyServices(userLat, userLon, currentCategory);
        },
        function (error) {
            console.error("Geolocation Error:", error);
            alert("Please allow location access to find nearby services.");
            findServicesBtn.innerHTML = LOCATION_BTN_HTML;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
});

// ================= TYPED LOCATION (Nominatim) =================
async function searchTypedLocation(query) {
    showMessage("loading-text", "Searching location...");

    try {
        const response = await fetch(
            NOMINATIM_URL + "?format=json&limit=1&q=" + encodeURIComponent(query)
        );
        const results = await response.json();

        if (!results.length) {
            showMessage("no-results", "Location not found. Try a more specific name.");
            return;
        }

        setUserLocation(parseFloat(results[0].lat), parseFloat(results[0].lon));
        await fetchAndRenderNearbyServices(userLat, userLon, currentCategory);
    } catch (error) {
        console.error("Geocoding Error:", error);
        showMessage("error-text", "Could not search that location. Check your internet.");
    }
}

if (locationInput) {
    locationInput.addEventListener("keydown", function (event) {
        if (event.key !== "Enter") return;
        const query = locationInput.value.trim();
        if (query) searchTypedLocation(query);
    });
}

// ================= FETCH FROM OVERPASS =================
function buildOverpassQuery(lat, lon, category) {
    const parts = category.filters
        .map(function (f) {
            return "nwr" + f + "(around:" + SEARCH_RADIUS + "," + lat + "," + lon + ");";
        })
        .join("");
    return "[out:json][timeout:25];(" + parts + ");out center 60;";
}

async function fetchAndRenderNearbyServices(lat, lon, categoryKey) {
    const category = CATEGORIES[categoryKey];
    if (!category) {
        console.error("Unknown category:", categoryKey);
        return;
    }

    showMessage("loading-text", "Finding nearby " + category.label.toLowerCase() + "...");

    serviceMarkers.forEach(function (marker) { map.removeLayer(marker); });
    serviceMarkers = [];

    try {
        const response = await fetch(OVERPASS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "data=" + encodeURIComponent(buildOverpassQuery(lat, lon, category))
        });

        if (!response.ok) throw new Error("Overpass error: " + response.status);

        const result = await response.json();

        const places = (result.elements || [])
            .map(function (el) {
                const placeLat = el.lat != null ? el.lat : (el.center && el.center.lat);
                const placeLon = el.lon != null ? el.lon : (el.center && el.center.lon);
                const tags = el.tags || {};
                if (placeLat == null || placeLon == null) return null;

                return {
                    name: tags.name || tags["name:en"] || (category.label + " (name not listed)"),
                    lat: placeLat,
                    lon: placeLon,
                    address: buildAddress(tags),
                    phone: getPhone(tags),
                    hours: tags.opening_hours || "",
                    distance: getDistanceKm(lat, lon, placeLat, placeLon)
                };
            })
            .filter(Boolean)
            .sort(function (a, b) { return a.distance - b.distance; })
            .slice(0, MAX_RESULTS);

        if (!places.length) {
            showMessage(
                "no-results",
                "No " + category.label.toLowerCase() + " found within " + (SEARCH_RADIUS / 1000) + " km."
            );
            return;
        }

        renderMarkers(places, category);
        updateNearbyList(places, category);
    } catch (error) {
        console.error("Fetch Error:", error);
        showMessage("error-text", "Could not load services. Please try again in a moment.");
    }
}

// ================= MAP MARKERS =================
function renderMarkers(places, category) {
    places.forEach(function (place) {
        const phoneLink = place.phone
            ? '<a href="tel:' + place.phone + '">\u{1F4DE} Call</a> &nbsp;'
            : "";

        const popupHtml =
            '<div style="font-family: sans-serif;">' +
            '<h4 style="margin: 0 0 5px 0;">' + category.icon + " " + escapeHtml(place.name) + "</h4>" +
            '<p style="margin: 0 0 6px 0; font-size: 12px; color: #555;">' +
            escapeHtml(place.address || "Address not listed") + "</p>" +
            phoneLink +
            '<a href="' + directionsUrl(place.lat, place.lon) + '" target="_blank" rel="noopener">' +
            "\u{1F9ED} Get Directions</a>" +
            "</div>";

        const marker = L.marker([place.lat, place.lon]).addTo(map).bindPopup(popupHtml);

        place.marker = marker;
        serviceMarkers.push(marker);
    });
}

// ================= SIDE LIST =================
function updateNearbyList(places, category) {
    if (!listContainer) return;
    listContainer.innerHTML = "";

    places.forEach(function (place) {
        const itemDiv = document.createElement("div");
        itemDiv.className = "nearby-item";

        itemDiv.innerHTML =
            '<div class="item-icon hospital-icon">' + category.icon + "</div>" +
            '<div class="item-info"><strong>' + escapeHtml(place.name) + "</strong>" +
            "<span>" + place.distance.toFixed(1) + " km away</span></div>" +
            '<i class="fa-solid fa-chevron-right arrow"></i>';

        itemDiv.addEventListener("click", function () {
            map.setView([place.lat, place.lon], 16);
            if (place.marker) place.marker.openPopup();
        });

        listContainer.appendChild(itemDiv);
    });
}

// ================= CATEGORY CARD CLICKS =================
serviceCards.forEach(function (card) {
    card.addEventListener("click", function () {
        const key = normalizeCategory(this.getAttribute("data-service"));

        if (!CATEGORIES[key]) {
            console.error("No category configured for data-service:", key);
            return;
        }

        currentCategory = key;

        serviceCards.forEach(function (c) { c.classList.remove("active"); });
        this.classList.add("active");

        if (userLat == null || userLon == null) {
            alert("Please click 'Use My Location' or type your location first.");
            return;
        }

        fetchAndRenderNearbyServices(userLat, userLon, currentCategory);
    });
});

// ================= VIEW ALL BUTTON =================
if (viewAllBtn) {
    viewAllBtn.addEventListener("click", function () {
        window.location.href = "services.html";
    });
}