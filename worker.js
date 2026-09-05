/**
 * Cloudflare Worker — CORS-Proxy für Nextcloud (WebDAV + öffentliche Links).
 *
 * Zweck: Die Zeiterfassungs-PWA läuft auf GitHub Pages und würde direkt
 * gegen Nextcloud CORS-Fehler bekommen, weil die Managed Nextcloud keine
 * Access-Control-Allow-Origin-Header schickt. Dieser Worker läuft
 * server-seitig (kein Browser, kein CORS-Problem beim Weiterleiten), reicht
 * die Anfrage 1:1 an Nextcloud durch und ergänzt in der Antwort nur die
 * fehlenden CORS-Header.
 *
 * Wichtig: Der Worker speichert NICHTS. Er kennt auch keine Zugangsdaten —
 * der Authorization-Header (falls vorhanden) kommt bei jedem Request vom
 * Browser und wird nur durchgereicht. Die Daten selbst liegen ausschliesslich
 * auf eurer eigenen Nextcloud.
 *
 * ?path= ist der komplette Pfad relativ zur Nextcloud-Domain, z.B.:
 *   - "remote.php/dav/files/jonas%40firma.ch/Buero/Admin/test_zeit/datei.csv"
 *     (persönliche Zeiterfassungsdatei, braucht Authorization-Header)
 *   - "s/AbCdEfGh123/download"
 *     (öffentlicher Freigabelink, z.B. für die zentrale Projektnamen-Datei,
 *     braucht keine Zugangsdaten)
 */

const ALLOWED_ORIGIN = "https://jonashaldemann.github.io";
const NEXTCLOUD_ORIGIN = "https://231121p3noy7vr3b2no.nextcloud.hosting.zone";
// PROPFIND wird für die Belegerfassung gebraucht, um den Ordnerinhalt zu
// lesen (höchste bestehende Belegnummer ermitteln).
const ALLOWED_METHODS = ["GET", "PUT", "MKCOL", "PROPFIND", "OPTIONS"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth",
    "Access-Control-Max-Age": "3600"
  };
}

export default {
  async fetch(request) {
    // Preflight-Anfrage des Browsers
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!ALLOWED_METHODS.includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return new Response("Missing ?path= parameter", { status: 400, headers: corsHeaders() });
    }

    // path kommt bereits als Klartext-Pfad an (URLSearchParams hat die
    // Prozent-Codierung schon aufgelöst), z.B.
    // "remote.php/dav/files/jonas@firma.ch/Buero/Admin/test_zeit/datei.csv"
    const targetUrl = `${NEXTCLOUD_ORIGIN}/${path.replace(/^\/+/, "")}`;

    const forwardHeaders = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) forwardHeaders.set("Authorization", auth);
    // Content-Type 1:1 vom Browser übernehmen statt fest vorzugeben --
    // sonst würden z.B. Foto-/PDF-Uploads bei der Belegerfassung mit
    // falschem Content-Type (text/csv) ankommen.
    const contentType = request.headers.get("Content-Type");
    if (contentType) forwardHeaders.set("Content-Type", contentType);
    // Depth-Header für PROPFIND (Ordnerinhalt lesen) durchreichen.
    const depth = request.headers.get("Depth");
    if (depth) forwardHeaders.set("Depth", depth);
    // Ohne einen "normalen" User-Agent stufen manche Hosting-Firewalls
    // (z.B. bei hosting.de) den Request als Bot/Skript ein und blockieren ihn
    // mit "Suspicious traffic detected" -- deshalb hier ein Browser-UA.
    forwardHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );
    forwardHeaders.set("Accept", "*/*");

    const init = { method: request.method, headers: forwardHeaders };
    if (request.method === "PUT" || request.method === "PROPFIND") {
      init.body = await request.arrayBuffer();
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl, init);
    } catch (err) {
      return new Response("Upstream fetch failed: " + err.message, {
        status: 502,
        headers: corsHeaders()
      });
    }

    const body = await upstream.arrayBuffer();
    const respHeaders = new Headers(corsHeaders());
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) respHeaders.set("Content-Type", contentType);

    return new Response(body, { status: upstream.status, headers: respHeaders });
  }
};
