(function () {
  const originalFetch = window.fetch.bind(window);

  let citiesPromise = null;
  let provincesCache = null;
  let regionsCache = null;

  function normalizeForSearch(input) {
    return String(input || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[’`]/g, "'")
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function jsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), {
      status: status || 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  async function loadCities() {
    if (!citiesPromise) {
      const dataUrl = new URL("api/public/cities-data.json", window.location.href);
      citiesPromise = originalFetch(dataUrl.toString())
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => (Array.isArray(data) ? data : []))
        .catch(() => []);
    }
    return citiesPromise;
  }

  async function getRegions() {
    if (regionsCache) return regionsCache;
    const cities = await loadCities();
    const byRegion = new Map();
    cities.forEach((c) => {
      const regione = c.regione || "";
      const codiceStato = c.codice_stato || "";
      const key = `${regione}|${codiceStato}`;
      if (!byRegion.has(key)) {
        byRegion.set(key, {
          regione,
          stato: c.stato || "Italia",
          codice_stato: codiceStato || "IT",
        });
      }
    });
    regionsCache = Array.from(byRegion.values());
    return regionsCache;
  }

  async function getProvinces() {
    if (provincesCache) return provincesCache;
    const cities = await loadCities();
    const byProvince = new Map();
    cities.forEach((c) => {
      const code = (c.codice_provincia || "").toUpperCase();
      if (!code) return;
      if (!byProvince.has(code)) {
        byProvince.set(code, {
          provincia: c.provincia || "",
          codice_provincia: code,
          regione: c.regione || "",
          stato: c.stato || "Italia",
          codice_stato: c.codice_stato || "IT",
        });
      }
    });
    provincesCache = Array.from(byProvince.values());
    return provincesCache;
  }

  function sortByComune(a, b) {
    const aa = normalizeForSearch(a.comune);
    const bb = normalizeForSearch(b.comune);
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  }

  function startsContainsFilter(items, q, valueFn) {
    const qn = normalizeForSearch(q);
    const starts = [];
    const contains = [];

    items.forEach((item) => {
      const v = normalizeForSearch(valueFn(item));
      if (!qn) {
        starts.push(item);
      } else if (v.startsWith(qn)) {
        starts.push(item);
      } else if (v.includes(qn)) {
        contains.push(item);
      }
    });

    return [...starts, ...contains].slice(0, 50);
  }

  window.fetch = async function (input, init) {
    let requestUrl;
    try {
      requestUrl =
        typeof input === "string" || input instanceof URL
          ? new URL(input, window.location.href)
          : new URL(input.url, window.location.href);
    } catch {
      return originalFetch(input, init);
    }

    const method = (
      init?.method ||
      (typeof input === "object" && input && input.method) ||
      "GET"
    ).toUpperCase();

    if (method !== "GET") return originalFetch(input, init);

    const path = requestUrl.pathname;

    try {
      if (path.endsWith("/api/public/cities")) {
        const cities = await loadCities();
        const q = requestUrl.searchParams.get("q") || "";
        const code = (requestUrl.searchParams.get("codice_provincia") || "").toUpperCase();

        const filteredBase = cities.filter((c) => !code || (c.codice_provincia || "").toUpperCase() === code);
        const out = startsContainsFilter(filteredBase, q, (c) => c.comune).sort(sortByComune);
        return jsonResponse(out);
      }

      if (path.endsWith("/api/public/regions")) {
        const q = requestUrl.searchParams.get("q") || "";
        const regions = await getRegions();
        const out = startsContainsFilter(regions, q, (r) => r.regione).sort((a, b) =>
          normalizeForSearch(a.regione).localeCompare(normalizeForSearch(b.regione))
        );
        return jsonResponse(out);
      }

      if (path.endsWith("/api/public/provinces")) {
        const q = requestUrl.searchParams.get("q") || "";
        const regione = requestUrl.searchParams.get("regione") || "";
        const provinces = await getProvinces();

        const filteredByRegion = regione
          ? provinces.filter((p) => normalizeForSearch(p.regione) === normalizeForSearch(regione))
          : provinces;

        const out = startsContainsFilter(filteredByRegion, q, (p) => p.provincia).sort((a, b) =>
          normalizeForSearch(a.provincia).localeCompare(normalizeForSearch(b.provincia))
        );

        return jsonResponse(out);
      }

      if (path.endsWith("/api/public/dual-climatic-zones")) {
        return jsonResponse({ hasDualZone: false });
      }
    } catch (e) {
      console.error("GitHub Pages API shim error:", e);
      return jsonResponse([], 200);
    }

    return originalFetch(input, init);
  };
})();
