(function () {
  const originalFetch = window.fetch.bind(window);

  let citiesPromise = null;
  let provincesCache = null;
  let regionsCache = null;

  const PDC_K_ZONA = {
    A: 116.09,
    B: 164.47,
    C: 212.84,
    D: 270.88,
    E: 328.93,
    F: 348.28,
  };

  const IBRIDO_K_ZONA = {
    A: 147.57,
    B: 209.06,
    C: 270.54,
    D: 344.33,
    E: 418.11,
    F: 442.71,
  };

  const G_PDC_POINTS = [
    [2.0, 0.6202],
    [3.0, 0.8269],
    [3.5, 0.886],
    [4.0, 0.9303],
    [5.16, 1.0],
    [6.0, 1.0337],
    [7.0, 1.0632],
    [10.0, 1.1163],
  ];

  const G_IBRIDO_POINTS = [
    [2.0, 0.6931],
    [3.0, 0.9241],
    [3.5, 0.9901],
    [3.59, 1.0],
    [4.0, 1.0396],
    [5.0, 1.1089],
    [6.0, 1.1551],
    [10.0, 1.2475],
  ];

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

  function parseNumberLike(input) {
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (input === null || input === undefined) return 0;
    let s = String(input).trim();
    if (!s) return 0;

    s = s.replace(/\s/g, "");
    if (s.includes(",") && s.includes(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",")) {
      s = s.replace(",", ".");
    }
    s = s.replace(/[^0-9.-]/g, "");

    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function interpolate(points, x) {
    const v = parseNumberLike(x);
    if (points.length === 0) return 1;
    if (v <= points[0][0]) return points[0][1];
    if (v >= points[points.length - 1][0]) return points[points.length - 1][1];

    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[i + 1];
      if (v >= x0 && v <= x1) {
        const t = (v - x0) / (x1 - x0);
        return lerp(y0, y1, t);
      }
    }
    return 1;
  }

  function computeIncentiveForTipologia(tipologia, payload) {
    const valueVat = payload?.value_vat?.[tipologia];
    const totale_vat = parseNumberLike(valueVat);

    const tipData = Array.isArray(payload?.dati_tecnici?.[tipologia])
      ? payload.dati_tecnici[tipologia][0] || {}
      : {};

    const zona = String(payload?.property?.address?.immobile?.zona_climatica || "E")
      .trim()
      .toUpperCase();

    let incentivo_max = 0;
    let percentuale = 0;

    if (tipologia === "scaldacqua") {
      percentuale = 0.4;
      const cls = String(tipData?.classe_energetica || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
      const max = cls.startsWith("a+") ? 700 : cls.startsWith("a") ? 500 : 0;
      incentivo_max = max;
    } else if (tipologia === "solare_termico") {
      percentuale = 0.65;
      const energia = parseNumberLike(tipData?.energia_termica);
      const tipo = String(tipData?.tipo_collettori || "").trim().toLowerCase();
      const k = tipo === "piani" ? 0.7 : tipo === "factory_made" ? 0.1945 : 0;
      incentivo_max = energia * k;
    } else if (tipologia === "pompa_calore") {
      percentuale = 0.65;
      const potenza = parseNumberLike(tipData?.potenza_nominale);
      const eff = parseNumberLike(tipData?.efficienza_stagionale) / 100;
      const scop = parseNumberLike(tipData?.scop_sper_cop);
      const kZona = PDC_K_ZONA[zona] || PDC_K_ZONA.E;
      incentivo_max = potenza * eff * kZona * interpolate(G_PDC_POINTS, scop);
    } else if (tipologia === "sistema_ibrido") {
      percentuale = 0.65;
      const potenza = parseNumberLike(tipData?.pdc_potenza);
      const eff = parseNumberLike(tipData?.pdc_efficienza) / 100;
      const scop = parseNumberLike(tipData?.pdc_scop_sper_cop);
      const kZona = IBRIDO_K_ZONA[zona] || IBRIDO_K_ZONA.E;
      incentivo_max = potenza * eff * kZona * interpolate(G_IBRIDO_POINTS, scop);
    } else {
      return {
        totale_vat: round2(totale_vat),
        incentivo_lordo: 0,
        incentivo_netto: 0,
        percent_reale: "0.0",
        warnings: `Tipologia '${tipologia}' non ancora implementata nel backend Arquati.`,
      };
    }

    const limitePercentuale = percentuale * totale_vat;
    const incentivo_lordo = Math.min(incentivo_max, limitePercentuale);
    const incentivo_netto = incentivo_lordo * 0.9878;
    const percent_reale = totale_vat > 0 ? (incentivo_lordo / totale_vat) * 100 : 0;

    return {
      totale_vat: round2(totale_vat),
      incentivo_lordo: round2(incentivo_lordo),
      incentivo_netto: round2(incentivo_netto),
      percent_reale: percent_reale.toFixed(1),
    };
  }

  async function extractRequestBodyText(input, init) {
    if (typeof init?.body === "string") return init.body;
    if (init?.body instanceof URLSearchParams) return init.body.toString();
    if (typeof init?.body === "object" && init?.body !== null) return String(init.body);
    if (typeof input === "object" && input && typeof input.clone === "function") {
      try {
        return await input.clone().text();
      } catch {
        return "";
      }
    }
    return "";
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

    const path = requestUrl.pathname;

    try {
      if (method === "POST" && path.endsWith("/api/public/calculate")) {
        let body = {};
        try {
          const raw = await extractRequestBodyText(input, init);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return jsonResponse({ success: false, error: "JSON non valido" }, 200);
        }

        const tipologie = Array.isArray(body?.intervention?.tipologia)
          ? body.intervention.tipologia
          : [];
        if (tipologie.length === 0) {
          return jsonResponse(
            { success: false, error: "Nessuna tipologia di intervento selezionata." },
            200
          );
        }

        const data = {};
        for (const tip of tipologie) {
          data[tip] = computeIncentiveForTipologia(tip, body);
        }
        return jsonResponse({ success: true, data }, 200);
      }

      if (method !== "GET") return originalFetch(input, init);

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
