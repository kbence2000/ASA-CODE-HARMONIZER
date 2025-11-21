export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // csak /harmonize endpointot proxizunk
    if (!url.pathname.startsWith("/harmonize")) {
      return new Response("ASA Harmonizer Worker OK", { status: 200 });
    }

    const endpoint = url.pathname.replace("/harmonize", "/api/harmonize");

    const target = env.BACKEND_URL + endpoint;

    return fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
  }
}
