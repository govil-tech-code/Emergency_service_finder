fetch(`/api/nearby?lat=${userLat}&lon=${userLon}&category=hospital`)
  .then(response => response.json())
  .then(resData => {
    // Check if resData contains the 'data' array from Express response
    const places = resData.data || resData; 

    if (!places || places.length === 0) {
      document.getElementById('results-container').innerHTML = `<p>No emergency services found nearby.</p>`;
      return;
    }

    // Render cards
    let html = '';
    places.forEach(place => {
      html += `
        <div class="card">
          <h3>${place.name}</h3>
          <p>${place.fullAddress || ''}</p>
          <a href="navigation.html?lat=${place.lat}&lon=${place.lon}">Get Directions</a>
        </div>
      `;
    });
    document.getElementById('results-container').innerHTML = html;
  })
  .catch(err => console.error("Error displaying places:", err));