/* PRIMEWORK — Mapa Mapbox lee del Webflow CMS via DOM data-attrs.
   v0.1 · 2026-04-30 · Sergio Rodez
   Auto-activa en cualquier página con #pw-map y un wrapper #pw-cms-data .pw-prop. */
(function () {
  'use strict';

  const MAP_ID = 'pw-map';
  const DATA_SEL = '#pw-cms-data .pw-prop';
  const PROP_LINK_SEL = 'a[href^="/propiedades/"]';
  const LAYER_PINS = ['pw-pins-bg', 'pw-pins-body', 'pw-pins-dot'];

  const TOKEN = window.PW_MAPBOX_TOKEN || '';
  const STYLE = 'mapbox://styles/mapbox/light-v11';
  const COLOR_AVAILABLE = '#1d0a88';
  const COLOR_UNAVAILABLE = '#1a1a1a';
  const AVAILABLE_OPTION_NAME = 'Disponible';

  function init() {
    if (!document.getElementById(MAP_ID)) return;
    if (typeof mapboxgl === 'undefined') {
      console.warn('[pw-map] mapbox-gl.js not loaded yet, retrying in 200ms');
      return setTimeout(init, 200);
    }
    if (!TOKEN) {
      console.error('[pw-map] window.PW_MAPBOX_TOKEN is missing - set it in the site loader before primework-map.js loads');
      return;
    }

    // Source A: fixed coords on #pw-map (data-pw-lat / data-pw-lng) — for single-pin pages without CMS (e.g. Contacto)
    const mapEl = document.getElementById(MAP_ID);
    const fixedLat = parseFloat(mapEl.dataset.pwLat);
    const fixedLng = parseFloat(mapEl.dataset.pwLng);
    let DATA;
    if (!isNaN(fixedLat) && !isNaN(fixedLng)) {
      DATA = [{
        id: '',
        name: (mapEl.dataset.pwName || 'Primework').trim(),
        slug: '',
        direccion: (mapEl.dataset.pwDireccion || mapEl.dataset.pwName || '').trim(),
        lat: fixedLat,
        lng: fixedLng,
        imagen: '',
        available: true
      }];
      console.log('[pw-map] fixed-coords mode:', DATA[0].name, fixedLat, fixedLng);
    } else {
      // Source B: CMS items inside #pw-cms-data .pw-prop
      const items = Array.from(document.querySelectorAll(DATA_SEL));
      DATA = items.map(function (el) {
        return {
          id: el.dataset.id || '',
          name: (el.dataset.name || '').trim(),
          slug: el.dataset.slug || '',
          direccion: (el.dataset.direccion || el.dataset.name || '').trim(),
          lat: parseFloat(el.dataset.lat),
          lng: parseFloat(el.dataset.lng),
          imagen: el.dataset.imagen || '',
          available: (el.dataset.disponibilidad || '').trim() === AVAILABLE_OPTION_NAME
        };
      }).filter(function (p) { return !isNaN(p.lat) && !isNaN(p.lng); });
    }

    if (!DATA.length) {
      console.warn('[pw-map] no data — set data-pw-lat/data-pw-lng on #pw-map OR populate #pw-cms-data .pw-prop');
      return;
    }

    const FEATURES = DATA.map(function (p, i) {
      return {
        type: 'Feature',
        id: i + 1,
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          cmsId: p.id, slug: p.slug, name: p.name, direccion: p.direccion,
          available: p.available, num: i + 1
        }
      };
    });

    mapboxgl.accessToken = TOKEN;
    const mapEl0 = mapEl;
    const enableScrollZoom = mapEl0 && mapEl0.dataset.pwScrollZoom === 'true';
    const map = new mapboxgl.Map({
      container: MAP_ID,
      style: STYLE,
      center: [-3.6885, 40.43],
      zoom: 13,
      attributionControl: false,
      scrollZoom: enableScrollZoom
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
    if (!enableScrollZoom) console.log('[pw-map] scroll-zoom disabled (set data-pw-scroll-zoom="true" on #pw-map to enable)');

    if (window.ResizeObserver) {
      new ResizeObserver(function () { map.resize(); }).observe(document.getElementById(MAP_ID));
    }

    let hoveredId = null;
    let popup = null;
    let dimAnim = null;
    let currentDim = 1;
    const DIM_TARGET = 0.3;
    const DIM_MS = 280;

    const ready = new Promise(function (resolve) {
      if (map.isStyleLoaded()) return resolve();
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      map.once('load', finish);
      map.once('style.load', finish);
      const t = setInterval(function () {
        if (map.isStyleLoaded()) { clearInterval(t); finish(); }
      }, 200);
    });

    window.pwMap = map; // debug exposure
    window.pwData = DATA;

    const singleMode = mapEl0 && mapEl0.dataset.pwSingle === 'true';
    if (singleMode) console.log('[pw-map] single-pin mode (microsite)');

    ready.then(function () {
      return loadPinIcons(map);
    }).then(function () {
      addPropertyLayers(map, FEATURES);
      const layerIds = map.getStyle().layers.map(function (l) { return l.id; }).filter(function (id) { return id.indexOf('pw-') === 0; });
      console.log('[pw-map] layers created:', layerIds);
      console.log('[pw-map] features in source:', FEATURES.length);
      bindMapEvents(map);
      if (!singleMode) bindDropdownLinks(map, DATA);
      fitToFeatures(map, FEATURES, singleMode);
      // Auto-open popup in single-pin mode (opt-out via data-pw-no-auto-popup="true")
      var noAutoPopup = mapEl0 && mapEl0.dataset.pwNoAutoPopup === 'true';
      if (singleMode && DATA.length && !noAutoPopup) {
        setTimeout(function () {
          showPopup([DATA[0].lng, DATA[0].lat], {
            name: DATA[0].name,
            direccion: DATA[0].direccion,
            available: DATA[0].available
          });
        }, 350);
      }
      console.log('[pw-map] init complete.');
    }).catch(function (e) { console.error('[pw-map] init error:', e); });

    function setDim(value) {
      currentDim = value;
      const expr = ['case', ['boolean', ['feature-state', 'hover'], false], 1, value];
      LAYER_PINS.forEach(function (id) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'icon-opacity', expr);
      });
    }
    function animateDim(target) {
      if (dimAnim) cancelAnimationFrame(dimAnim);
      const from = currentDim, to = target;
      if (Math.abs(from - to) < 0.01) { setDim(to); return; }
      const start = performance.now();
      const tick = function (now) {
        const t = Math.min(1, (now - start) / DIM_MS);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        setDim(from + (to - from) * eased);
        if (t < 1) dimAnim = requestAnimationFrame(tick); else dimAnim = null;
      };
      dimAnim = requestAnimationFrame(tick);
    }

    function setHover(featureId, on) {
      if (featureId === null && on === false) {
        if (hoveredId !== null) {
          map.setFeatureState({ source: 'pw-properties', id: hoveredId }, { hover: false });
          document.querySelectorAll('a.pw-prop-link.is-active').forEach(function (el) { el.classList.remove('is-active'); });
          hoveredId = null;
          animateDim(1);
        }
        return;
      }
      if (on) {
        if (hoveredId !== null && hoveredId !== featureId) {
          map.setFeatureState({ source: 'pw-properties', id: hoveredId }, { hover: false });
        }
        hoveredId = featureId;
        map.setFeatureState({ source: 'pw-properties', id: featureId }, { hover: true });
        document.querySelectorAll('a.pw-prop-link').forEach(function (el) {
          el.classList.toggle('is-active', Number(el.dataset.pwNum) === featureId);
        });
        animateDim(DIM_TARGET);
      } else {
        map.setFeatureState({ source: 'pw-properties', id: featureId }, { hover: false });
        document.querySelectorAll('a.pw-prop-link[data-pw-num="' + featureId + '"]').forEach(function (el) { el.classList.remove('is-active'); });
        if (hoveredId === featureId) hoveredId = null;
        animateDim(1);
      }
    }

    function showPopup(coords, props) {
      if (popup) popup.remove();
      popup = new mapboxgl.Popup({ offset: 22, closeButton: false })
        .setLngLat(coords)
        .setHTML(
          '<div class="pw-pop-name">' + escapeHtml(props.name) + '</div>' +
          '<div class="pw-pop-addr">' + escapeHtml(props.direccion) + '</div>' +
          '<div class="pw-pop-status' + (props.available ? '' : ' un') + '">' +
          (props.available ? 'Disponible' : 'No disponible') + '</div>'
        )
        .addTo(map);
    }

    function bindMapEvents(map) {
      // Bind to all 3 pin layers so hit-area covers full pin (bg + body + dot)
      ['pw-pins-bg', 'pw-pins-body', 'pw-pins-dot'].forEach(function (layerId) {
        map.on('mouseenter', layerId, function (e) {
          map.getCanvas().style.cursor = 'pointer';
          if (e.features && e.features[0]) setHover(e.features[0].id, true);
        });
        map.on('mouseleave', layerId, function () {
          map.getCanvas().style.cursor = '';
          setHover(null, false);
        });
        map.on('click', layerId, function (e) {
          if (!e.features || !e.features[0]) return;
          const f = e.features[0];
          showPopup(f.geometry.coordinates, f.properties);
        });
      });
      console.log('[pw-map] mouse handlers bound to pw-pins-bg/body/dot');
    }

    function bindDropdownLinks(map, DATA) {
      const slugMap = {};
      DATA.forEach(function (p, i) { slugMap[p.slug] = { num: i + 1, prop: p }; });

      const links = document.querySelectorAll(PROP_LINK_SEL);
      let bound = 0;
      links.forEach(function (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/propiedades\/([^\/?#]+)/);
        if (!m) return;
        const entry = slugMap[m[1]];
        if (!entry) return;
        const num = entry.num;
        const p = entry.prop;

        link.classList.add('pw-prop-link');
        link.dataset.pwNum = num;
        link.dataset.pwSlug = m[1];

        link.addEventListener('mouseenter', function () {
          setHover(num, true);
          showPopup([p.lng, p.lat], { name: p.name, direccion: p.direccion, available: p.available });
        });
        link.addEventListener('mouseleave', function () {
          setHover(num, false);
          if (popup) { popup.remove(); popup = null; }
        });
        bound++;
      });
      console.log('[pw-map] bound ' + bound + ' dropdown links to ' + DATA.length + ' pins (with popup-on-hover)');
    }

    function fitToFeatures(map, features, single) {
      if (!features.length) return;
      if (single || features.length === 1) {
        const c = features[0].geometry.coordinates;
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            map.resize();
            map.jumpTo({ center: c, zoom: 16 });
          });
        });
        return;
      }
      const bounds = new mapboxgl.LngLatBounds();
      features.forEach(function (f) { bounds.extend(f.geometry.coordinates); });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          map.resize();
          map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, duration: 800, maxZoom: 15 });
        });
      });
    }
  }

  function loadPinIcons(map) {
    function svgToImage(svg) {
      return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
    const teardrop = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="88" viewBox="-6 -6 40 50"><path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="#fff"/></svg>';
    const dot = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="-4 -4 24 24"><circle cx="8" cy="8" r="8" fill="#fff"/></svg>';
    return Promise.all([svgToImage(teardrop), svgToImage(dot)]).then(function (imgs) {
      if (!map.hasImage('pw-pin')) map.addImage('pw-pin', imgs[0], { pixelRatio: 2, sdf: true });
      if (!map.hasImage('pw-pin-dot')) map.addImage('pw-pin-dot', imgs[1], { pixelRatio: 2, sdf: true });
    });
  }

  function addPropertyLayers(map, FEATURES) {
    const mapEl = document.getElementById(MAP_ID);
    const uniformColor = mapEl && mapEl.dataset.pwUniformColor === 'true';
    const bodyColor = uniformColor
      ? '#1d0a88'
      : ['case', ['get', 'available'], '#1d0a88', '#1a1a1a'];
    if (uniformColor) console.log('[pw-map] uniform-color mode (all pins blue)');

    map.addSource('pw-properties', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: FEATURES }
    });
    map.addLayer({
      id: 'pw-pins-bg', type: 'symbol', source: 'pw-properties',
      layout: { 'icon-image': 'pw-pin', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 1.0 },
      paint: { 'icon-color': '#ffffff', 'icon-opacity': 1 }
    });
    map.addLayer({
      id: 'pw-pins-body', type: 'symbol', source: 'pw-properties',
      layout: { 'icon-image': 'pw-pin', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 0.85 },
      paint: {
        'icon-color': bodyColor,
        'icon-opacity': 1
      }
    });
    map.addLayer({
      id: 'pw-pins-dot', type: 'symbol', source: 'pw-properties',
      layout: { 'icon-image': 'pw-pin-dot', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 0.45, 'icon-offset': [0, -40] },
      paint: { 'icon-color': '#ffffff', 'icon-opacity': 1 }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function deferInit() {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(init, { timeout: 2500 });
    } else {
      setTimeout(init, 1500);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
